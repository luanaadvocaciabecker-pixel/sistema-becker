// Edge Function `prazos-candidato-protocolo` — sinal "documento posterior à intimação, a
// conferir". Copia versionada; deploy no Supabase.
//
// POR QUE EXISTE: ela confirmou a ideia pendente — peça nossa protocolada DEPOIS da intimação é
// sinal de que o prazo pode já estar coberto, mesmo que o eProc ainda mostre "aberto" (ele só
// fecha o expediente na ciência com renúncia ou na certidão do cartório — ver o cabeçalho de
// `prazos-fechar.ts`). `GET lawsuit/case-files` é grátis e lista os documentos do processo, mas
// tem EXATAMENTE 7 campos (medido em `db/legalmail_case_files.sql`): idmovimentacoes,
// fk_processo, id, hash_documento, titulo, tipo, data_movimentacao. NÃO HÁ campo de autor/parte
// que juntou o documento. Então esta função sabe dizer "algo entrou depois" — nunca "foi nosso
// escritório que protocolou".
//
// *** NÃO ACRESCENTE CHAMADA PAGA AQUI. Só toca case-files (grátis). Confirmar de verdade
// (docket-entry/url, R$0,02/doc) é o botão "Confirmar com IA" na tela, sob clique humano,
// reaproveitando `prazo-peca.ts` — nunca automático, nunca neste cron. ***
//
// POR QUE É FUNÇÃO SEPARADA de `prazos-fechar.ts`, e não um quarto laço lá dentro: dobrar a
// chamada por processo no MESMO laço dobraria a taxa efetiva (~170 req/min, acima dos 120/min
// que já derrubaram o workspace em 09/09) e o tempo do cron das 17:30. Com função separada, os
// três baldes em que ela já confia continuam do tamanho de hoje; este sinal roda depois (cron
// `prazos_candidato_protocolo_1745`, 15 min de folga), com seu próprio orçamento de 429, e um
// bug aqui não arrasta o fecho que já funciona.
//
// O CORTE DE DATA é `publicacoes.data_disponibilizacao` da intimação de ORIGEM do prazo (via
// `legalmail_id`), não `prazos.data` (vencimento) — é a MESMA âncora que `prazo-peca.ts` já usa
// (`ddAviso`) para o preview, não uma segunda noção de "início do prazo". Protocolar DENTRO do
// prazo é justamente o caso que se quer pegar; cortar pelo vencimento perderia os casos bons.
// Confirmado em 11/09/2026: 125 de 125 prazos do universo de hoje resolvem essa data.
//
// FILTRA POR PRAZO, não por processo: um processo com 2 prazos de intimações diferentes pode ter
// um documento posterior à intimação A e anterior à B do mesmo processo — cada prazo compara só
// contra a SUA própria data de intimação.
//
// `titulo`/`tipo` do documento NÃO são usados para adivinhar autoria, em nenhuma versão. Cruzar
// com `polo_cliente` para "adivinhar" se é nossa peça criaria uma SEGUNDA forma de saber quem
// somos nós — exatamente o que a regra dela proíbe ("nosso cliente é sempre o que tem cadastro
// no nosso sistema"), e a mesma classe do erro do processo 6618 (resumo escrito do lado errado).
// Esta função mostra TODOS os documentos posteriores à data, sem filtrar por título; o humano
// decide olhando, e o botão da IA confirma com prova quando vale gastar R$0,02.
//
// Auth: token fixo na query string (`?k=`), mesmo padrão de `prazos-fechar.ts`. Nenhum cron
// chama com JWT; verify_jwt=false.
// Segredos: LEGALMAIL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const K = "candpp_5e91ac3d";
const PASSO_MS = 700; // mesmo passo de prazos-fechar.ts — ~85 req/min, sob o limite de 120/min
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o, null, 1), { status: st, headers: { "Content-Type": "application/json" } });
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

// "Hoje" em Joinville: o cron roda 20:45 UTC, que ainda é o mesmo dia no BRT.
function hojeBR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Maiúsculo sem acento, para casar título em qualquer grafia (o case-files devolve os dois
// estilos: "DISPONIBILIZADO NO DJEN" e "Disponibilizado no DJEN - no dia...").
function semAcentoMaiusculo(s: string | null | undefined): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

// Moldes que são BUROCRACIA DO PRÓPRIO TRIBUNAL sobre a MESMA intimação que abriu o prazo —
// nunca uma peça de parte nenhuma. NÃO é heurística de autoria (não tenta saber se é nosso ou
// da parte contrária, nunca cruza com polo_cliente): é reconhecer o que claramente NÃO É
// documento de parte. Mesma técnica (exclusão por molde de texto) do "aviso de distribuição" em
// trt_gera_prazos. MEDIDO em 11/09/2026, antes deste filtro: 103 de 125 prazos (82%) viravam
// "candidato" — 134 de 196 documentos eram só o tribunal registrando a própria publicação/
// intimação/certidão de novo (ex.: "PUBLICADO NO DJEN", "CONFIRMADA A INTIMAÇÃO ELETRÔNICA",
// "DECORRIDO PRAZO"). Sem este filtro o sinal vira ruído — o balde não seria "a conferir",
// seria "quase tudo".
const MOLDES_NAO_PECA: RegExp[] = [
  /^DISPONIBILIZADO NO DJ/, /^PUBLICADO NO DJ/,
  /^CONFIRMADA A INTIMA[CÇ][AÃ]O/, /^EXPEDID[AO].{0,4}CERTIFICADA A (INTIMA|COMUNICA)/,
  /^CI[EÊ]NCIA COM REN[UÚ]NCIA AO PRAZO/, /^DECORRIDO PRAZO/,
  /^ATO ORDINAT[OÓ]RIO PRATICADO/, /^ATOORD\d/,
  /^AUDI[EÊ]NCIA DE CONCILIA[CÇ][AÃ]O.{0,30}CANCELADA/,
  /^ATOS DA CONTADORIA/, /^CUSTAS SATISFEITAS/,
  /^JUNTADA.{0,20}GUIA GERADA/, /^JUNTADA DE CERTID[AÃ]O.{0,20}FINALIZADO/,
  /^REMETIDOS OS AUTOS A CONTADORIA/, /^TRANSITADO EM JULGADO/,
  /^RELAT[OÓ]RIO DE PESQUISA DE ENDERE[CÇ]O/, /^REL\.?\s?PESQ\.?\s?ENDERE[CÇ]O/,
  /^CERTID[AÃ]O\s*\(CERTID[AÃ]O DE PUBLICA[CÇ][AÃ]O/, /^TRANS_REC_SISBA/,
  /^CARTA\d/, /^EXPEDI[CÇ][AÃ]O DE CARTA/,
];
function ehBurocraciaDoTribunal(titulo: string | null | undefined): boolean {
  if (!titulo) return false; // sem título, não dá pra classificar — melhor mostrar que esconder
  const t = semAcentoMaiusculo(titulo);
  return MOLDES_NAO_PECA.some((re) => re.test(t));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("k") !== K) return json({ erro: "nao autorizado" }, 401);
  if (!API) return json({ erro: "sem LEGALMAIL_API_KEY" }, 500);
  const commit = url.searchParams.get("commit") !== "0";
  const t0 = Date.now();

  try {
    // Mesmo universo de prazos-fechar.ts: abertos, com legalmail_id, processo com lm_idprocessos.
    const SEL = "id,data,legalmail_id,processos!inner(id,numero,tribunal,lm_idprocessos)";
    const prazos = await sb(`prazos?cumprido=eq.false&legalmail_id=not.is.null&select=${SEL}&processos.lm_idprocessos=not.is.null&limit=3000`);
    const lista: any[] = Array.isArray(prazos) ? prazos : [];

    // Data de disponibilização de cada intimação de origem — uma consulta só, à nossa API
    // (não ao Legal Mail, sem limite de taxa aqui).
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
    const candidatos: any[] = [];
    const semReferencia: any[] = [];
    let primeiro = true;

    for (const [idp, doProc] of porProc) {
      if (!primeiro) await dorme(PASSO_MS);
      primeiro = false;
      let docs: any[] = [];
      try {
        const r = await fetch(`${BASE}/api/v1/lawsuit/case-files?api_key=${encodeURIComponent(API)}&idprocessos=${encodeURIComponent(idp)}`, { headers: { Accept: "application/json" } });
        status_vistos[String(r.status)] = (status_vistos[String(r.status)] || 0) + 1;
        if (r.status === 429) {
          // ABORTA na primeira, não insiste — mesma regra de prazos-fechar.ts.
          retry_after = Number(r.headers.get("Retry-After") || 0) || null;
          abortou_em = idp; http_erro++;
          break;
        }
        if (!r.ok) { http_erro++; continue; }
        http_ok++;
        const j = await r.json().catch(() => null);
        docs = Array.isArray(j) ? j : [];
      } catch { http_erro++; status_vistos["excecao"] = (status_vistos["excecao"] || 0) + 1; continue; }

      for (const z of doProc) {
        const dd = ddPorLm.get(String(z.legalmail_id));
        if (!dd) {
          semReferencia.push({ prazo: z.id, processo: z.processos?.numero, motivo: "sem data_disponibilizacao para comparar" });
          continue;
        }
        // Candidato: documento com data POSTERIOR à intimação DESTE prazo especificamente —
        // não ao processo inteiro (um processo pode ter prazos de intimações diferentes).
        const cands = docs
          .filter((d: any) => d?.idmovimentacoes && d?.data_movimentacao && String(d.data_movimentacao) > dd
                              && !ehBurocraciaDoTribunal(d.titulo))
          .map((d: any) => ({ idmovimentacoes: d.idmovimentacoes, titulo: d.titulo ?? null, tipo: d.tipo ?? null, data_movimentacao: d.data_movimentacao }))
          .sort((a: any, b: any) => String(a.data_movimentacao).localeCompare(String(b.data_movimentacao)));
        if (cands.length) {
          candidatos.push({
            prazo: z.id, processo: z.processos?.numero, tribunal: z.processos?.tribunal || "?",
            legalmail_id: z.legalmail_id, data_prazo: z.data, data_intimacao_usada: dd, candidatos: cands,
          });
        }
      }
    }

    const completo = http_erro === 0 && !abortou_em && http_ok === porProc.size;

    if (commit && completo) {
      // Grava o candidato na própria linha do prazo — mesmo padrão de peca_idmov/peca_url/
      // ia_orientacao: a tela precisa saber na hora de abrir o modal, sem escanear log.
      const comCandidato = new Set<number>();
      for (const c of candidatos) {
        comCandidato.add(c.prazo);
        await sb(`prazos?id=eq.${c.prazo}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ candidato_pos_intimacao: { data_intimacao_usada: c.data_intimacao_usada, candidatos: c.candidatos } }),
        }).catch(() => {});
      }
      // Quem foi verificado nesta rodada COMPLETA e não tem candidato: null explícito, para não
      // ficar stale com um candidato de dias atrás que já não existe mais.
      const semCandidato: number[] = [];
      for (const [, doProc] of porProc) {
        for (const z of doProc) {
          if (!comCandidato.has(z.id) && ddPorLm.get(String(z.legalmail_id))) semCandidato.push(z.id);
        }
      }
      if (semCandidato.length) {
        await sb(`prazos?id=in.(${semCandidato.join(",")})`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ candidato_pos_intimacao: null }),
        }).catch(() => {});
      }
    }

    const resumo: Record<string, unknown> = {
      rodou_em: new Date().toISOString(), hoje: hojeBR(),
      segundos: +((Date.now() - t0) / 1000).toFixed(1),
      custo: "R$ 0,00 (case-files é grátis)",
      COMPLETO: completo,
      processos_alvo: porProc.size, http_ok, http_erro, status_vistos,
      abortou_por_429_no_processo: abortou_em, retry_after_segundos: retry_after,
      prazos_vistos: lista.length,
      SEM_REFERENCIA: semReferencia.length,
      sem_referencia: semReferencia.slice(0, 40),
    };

    if (completo) {
      // O balde só diz o que o dado sabe — nunca "peça nossa", "protocolado" ou "cumprido"
      // (LICOES regra 28: o rótulo não pode afirmar mais que a medição).
      resumo.DOCUMENTO_POSTERIOR_A_CONFERIR = candidatos.length;
      resumo.documento_posterior_a_conferir = candidatos.slice(0, 200);
      resumo.leia_se = "Existe documento nos autos com data posterior à intimação que abriu "
        + "este prazo. NÃO significa que é nossa peça nem que o prazo está coberto — só que "
        + "algo entrou depois. Confirmar de verdade custa R$0,02 (botão na tela).";
    } else {
      resumo.DOCUMENTO_POSTERIOR_A_CONFERIR = null;
      resumo.aviso = `RODADA INCOMPLETA (${http_ok}/${porProc.size} processos consultados). `
        + (abortou_em ? `Abortada por HTTP 429 (limite de taxa)${retry_after ? `, Retry-After ${retry_after}s` : ""}. ` : "")
        + `Nada foi gravado nesta rodada.`;
    }

    if (commit) {
      await sb(`prazo_fechamento_log`, {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          origem: "case-files-candidato",
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
