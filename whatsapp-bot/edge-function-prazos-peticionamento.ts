// Edge Function `prazos-peticionamento` — sinal "protocolo via Legal Mail encontrado", separado
// de `prazos-candidato-protocolo.ts` por orçamento de TEMPO (não de taxa). Copia versionada;
// deploy no Supabase.
//
// POR QUE EXISTE — 13/09/2026, achado dela: "o Legal Mail deve ter isso em algum lugar" (ela
// lembrava de marcar "fechar o prazo" na hora de peticionar na plataforma deles). Tem mesmo:
// `GET /api/v1/filings` (GRÁTIS, confirmado com saldo antes/depois) lista os protocolos que O
// PRÓPRIO escritório enviou pelo botão de peticionar do Legal Mail, com `status` (Em fila/
// Protocolando/Protocolado/Agendado/Cancelado/Com pendências) e `protocolado_em` — data e HORA
// exatas de quando o tribunal aceitou. Isso é PROVA, não candidato — mas só cobre quem usa o
// botão de peticionar da plataforma deles. Quem protocola direto no site do tribunal (ela já fez
// isso, ex.: processo 4063252-89.2026.8.26.0100) não aparece aqui — nesse caso o campo fica null,
// e não é erro: é escopo do sinal.
//
// Verificado em 13/09/2026 contra 13 processos com prazo vencido: 4 bateram exato (protocolo do
// Legal Mail no mesmo dia do vencimento — ex. LUCAS VIEIRA PIRES, protocolado_em 11/09 09:15,
// prazo vencendo 11/09), 1 mostrou zero protocolos (São Clemente, confirmadamente feito direto
// no tribunal), e para os demais os protocolos existentes eram antigos demais (semanas antes do
// vencimento) para responder a ESTE prazo especificamente.
//
// *** NÃO ACRESCENTE CHAMADA PAGA AQUI. Só toca filings (grátis, confirmado com saldo antes/
// depois). ***
//
// POR QUE É FUNÇÃO SEPARADA de `prazos-candidato-protocolo.ts`, e não um segundo laço lá dentro —
// TENTADO e MEDIDO em 13/09/2026: juntar as duas chamadas (case-files + filings) no mesmo laço,
// com o mesmo PASSO_MS, devolveu HTTP 504 em ~150s. A conta ingênua (97 processos × 2 chamadas ×
// 700ms ≈ 136s) parecia caber, mas o tempo real de rede das 194 chamadas HTTP estourou o teto do
// invocation (o mesmo teto de 150s que os crons já usam em `timeout_milliseconds`). Não é
// problema de limite de taxa (120/min) — é orçamento de TEMPO por invocation. Com função
// separada, cada uma volta a fazer só 1 chamada por processo (~97 × 700ms ≈ 68s, a mesma folga
// que `prazos-candidato-protocolo.ts` já tinha provado), e roda em cron próprio (15 min depois
// do de candidato-protocolo), sem competir pelo mesmo teto de tempo.
//
// O CORTE DE DATA é `publicacoes.data_disponibilizacao` da intimação de ORIGEM do prazo (via
// `legalmail_id`), não `prazos.data` (vencimento) — mesma âncora que `prazo-peca.ts` e
// `prazos-candidato-protocolo.ts` já usam. Protocolar DENTRO do prazo é justamente o caso que se
// quer pegar; cortar pelo vencimento perderia os casos bons.
//
// FILTRA POR PRAZO, não por processo: um processo com 2 prazos de intimações diferentes pode ter
// um protocolo posterior à intimação A e anterior à B do mesmo processo — cada prazo compara só
// contra a SUA própria data de intimação. Entre vários protocolos relevantes, fica o MAIS RECENTE
// — é a resposta mais provável a ESTE aviso específico.
//
// NÃO cruza com `polo_cliente` nem tenta adivinhar autoria — `filings` já é fato (o próprio
// workspace autenticado protocolando), não palpite, então não tem esse risco (diferente do sinal
// de case-files, que só vê "algo entrou depois", nunca "quem").
//
// Auth: token fixo na query string (`?k=`), mesmo padrão de `prazos-fechar.ts` e
// `prazos-candidato-protocolo.ts`. Nenhum cron chama com JWT; verify_jwt=false.
// Segredos: LEGALMAIL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const K = "peticion_3a7fd619";
const PASSO_MS = 700; // mesmo passo de prazos-fechar.ts / prazos-candidato-protocolo.ts
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o, null, 1), { status: st, headers: { "Content-Type": "application/json" } });
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

function hojeBR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

async function buscarFilings(numeroProcesso: string): Promise<{ http: number, protocols: any[] }> {
  const u = `${BASE}/api/v1/filings?api_key=${encodeURIComponent(API)}&processo=${encodeURIComponent(numeroProcesso)}&limit=50`;
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  if (!r.ok) return { http: r.status, protocols: [] };
  const j = await r.json().catch(() => null);
  return { http: r.status, protocols: Array.isArray(j?.protocols) ? j.protocols : [] };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("k") !== K) return json({ erro: "nao autorizado" }, 401);
  if (!API) return json({ erro: "sem LEGALMAIL_API_KEY" }, 500);
  const commit = url.searchParams.get("commit") !== "0";
  const t0 = Date.now();

  try {
    // Mesmo universo de prazos-candidato-protocolo.ts: abertos, com legalmail_id, processo com
    // lm_idprocessos e número (filings busca por `processo`, texto livre).
    const SEL = "id,data,legalmail_id,processos!inner(id,numero,tribunal,lm_idprocessos)";
    const prazos = await sb(`prazos?cumprido=eq.false&legalmail_id=not.is.null&select=${SEL}&processos.lm_idprocessos=not.is.null&limit=3000`);
    const lista: any[] = Array.isArray(prazos) ? prazos : [];

    const lmIds = [...new Set(lista.map((z) => z.legalmail_id).filter(Boolean))];
    const pubs = lmIds.length
      ? await sb(`publicacoes?legalmail_id=in.(${lmIds.join(",")})&select=legalmail_id,data_disponibilizacao`)
      : [];
    const ddPorLm = new Map<string, string>(
      (Array.isArray(pubs) ? pubs : [])
        .filter((p: any) => p?.data_disponibilizacao)
        .map((p: any) => [String(p.legalmail_id), String(p.data_disponibilizacao)])
    );

    const porProc = new Map<string, any[]>();
    for (const z of lista) {
      const idp = String(z?.processos?.lm_idprocessos || "");
      if (!idp) continue;
      if (!porProc.has(idp)) porProc.set(idp, []);
      porProc.get(idp)!.push(z);
    }

    let http_ok = 0, http_erro = 0, abortou_em: string | null = null, retry_after: number | null = null;
    const status_vistos: Record<string, number> = {};
    const peticionamentos: any[] = [];
    const semReferencia: any[] = [];
    let primeiro = true;

    for (const [idp, doProc] of porProc) {
      if (!primeiro) await dorme(PASSO_MS);
      primeiro = false;
      const numeroProc = doProc[0]?.processos?.numero || "";
      let protocolos: any[] = [];
      if (numeroProc) {
        try {
          const { http, protocols } = await buscarFilings(numeroProc);
          status_vistos[String(http)] = (status_vistos[String(http)] || 0) + 1;
          if (http === 429) {
            // ABORTA na primeira, não insiste — mesma regra de prazos-fechar.ts.
            retry_after = null; abortou_em = idp; http_erro++;
            break;
          }
          if (http < 200 || http >= 300) { http_erro++; continue; }
          http_ok++;
          protocolos = protocols;
        } catch { http_erro++; status_vistos["excecao"] = (status_vistos["excecao"] || 0) + 1; continue; }
      } else {
        http_erro++; continue;
      }

      for (const z of doProc) {
        const dd = ddPorLm.get(String(z.legalmail_id));
        if (!dd) {
          semReferencia.push({ prazo: z.id, processo: z.processos?.numero, motivo: "sem data_disponibilizacao para comparar" });
          continue;
        }
        // Protocolo do Legal Mail enviado DEPOIS da intimação deste prazo. Entre vários, fica o
        // mais recente — é a resposta mais provável a ESTE aviso específico.
        const relevantes = protocolos
          .filter((p: any) => String(p?.enviado_em || "").slice(0, 10) > dd)
          .sort((a: any, b: any) => String(a.enviado_em).localeCompare(String(b.enviado_em)));
        if (relevantes.length) {
          const p = relevantes[relevantes.length - 1];
          peticionamentos.push({
            prazo: z.id, processo: z.processos?.numero, status: p.status,
            peticionado_em: p.protocolado_em || p.enviado_em || null,
            peca: p.tipo_peca || null, mensagem_pendencia: p.mensagem_pendencia || null,
          });
        }
      }
    }

    const completo = http_erro === 0 && !abortou_em && http_ok === porProc.size;

    if (commit && completo) {
      // Grava status + hora + detalhe na própria linha do prazo. Mesmo cuidado de não ficar
      // stale: quem foi verificado e não tem protocolo relevante recebe null explícito nos três
      // campos (nunca deixa um valor de dias atrás pendurado sem mais ser verdade).
      const comPeticionamento = new Set<number>();
      for (const p of peticionamentos) {
        comPeticionamento.add(p.prazo);
        await sb(`prazos?id=eq.${p.prazo}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            peticionamento_status: p.status,
            peticionamento_em: p.peticionado_em,
            peticionamento_detalhe: { peca: p.peca, mensagem_pendencia: p.mensagem_pendencia },
          }),
        }).catch(() => {});
      }
      const semPeticionamento: number[] = [];
      for (const [, doProc] of porProc) {
        for (const z of doProc) {
          if (!comPeticionamento.has(z.id) && ddPorLm.get(String(z.legalmail_id))) semPeticionamento.push(z.id);
        }
      }
      if (semPeticionamento.length) {
        await sb(`prazos?id=in.(${semPeticionamento.join(",")})`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ peticionamento_status: null, peticionamento_em: null, peticionamento_detalhe: null }),
        }).catch(() => {});
      }
    }

    const resumo: Record<string, unknown> = {
      rodou_em: new Date().toISOString(), hoje: hojeBR(),
      segundos: +((Date.now() - t0) / 1000).toFixed(1),
      custo: "R$ 0,00 (filings é grátis)",
      COMPLETO: completo,
      processos_alvo: porProc.size, http_ok, http_erro, status_vistos,
      abortou_por_429_no_processo: abortou_em,
      prazos_vistos: lista.length,
      SEM_REFERENCIA: semReferencia.length,
      sem_referencia: semReferencia.slice(0, 40),
    };

    if (completo) {
      // Este balde SIM é prova (o filings é o próprio workspace autenticado protocolando) — mas
      // só cobre quem usa o botão de protocolar do Legal Mail, não quem protocola direto no site
      // do tribunal.
      resumo.PETICIONAMENTO_ENCONTRADO = peticionamentos.length;
      resumo.peticionamento_encontrado = peticionamentos.slice(0, 200);
    } else {
      resumo.PETICIONAMENTO_ENCONTRADO = null;
      resumo.aviso = `RODADA INCOMPLETA (${http_ok}/${porProc.size} processos consultados). `
        + (abortou_em ? `Abortada por HTTP 429 (limite de taxa). ` : "")
        + `Nada foi gravado nesta rodada.`;
    }

    if (commit) {
      await sb(`prazo_fechamento_log`, {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          origem: "filings-peticionamento",
          processos_consultados: porProc.size, http_ok, http_erro,
          prazos_vistos: lista.length, fechados: 0,
          detalhe: resumo, erro: completo ? null : String(resumo.aviso),
        }]),
      }).catch(() => {});
    }

    return json({ ok: true, ...resumo });
  } catch (e) {
    return json({ erro: String(e).slice(0, 400) }, 500);
  }
});
