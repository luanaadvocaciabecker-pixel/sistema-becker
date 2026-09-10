// Edge Function `prazos-fechar` — verifica no tribunal quais prazos já foram fechados e fecha.
// Cópia versionada; o deploy é feito no Supabase.
//
// Roda 1x por dia, às 17:30 BRT (cron `prazos_fechar_1730`, 20:30 UTC), para responder a
// pergunta da Luana: "os prazos de hoje foram fechados?".
//
// FONTE: GET /api/v1/pleading/notices-to-comply — **GRÁTIS** na tabela oficial de preços.
// Devolve por processo `intimacoes_prazo_fechado` e `intimacoes_prazo_aberto`, e o
// `idintimacoes` casa EXATAMENTE com prazos.legalmail_id (conferido 6 a 6 em 09/09/2026).
//
// POR QUE NÃO USA O /notices (pago): a doc do Legal Mail diz "consultar em laço sai caro — a
// cada 5 minutos há nova cobrança". A rotina antiga fazia isso de hora em hora, sem janela,
// ~67 páginas de R$ 0,05 = ~R$ 90/dia, e devolvia cumpridos:0 em 112 execuções. O zero também
// está explicado na spec: `prazo_status=cumprido` = "vinculada a uma petição protocolada", e o
// escritório protocola no eProc, não pelo Legal Mail. Ver db/legalmail_custo_api.sql.
//
// *** NÃO ACRESCENTE CHAMADA PAGA AQUI. Só toca notices-to-comply e balance, os dois "Grátis". ***
//
// LIMITE DE TAXA — lição paga com bloqueio em 09/09/2026:
//   a spec diz 120 req/min em janela deslizante de 60s, e **3 respostas 429 em 10 minutos
//   caracterizam "prática de polling"**, disparando timeout progressivo no workspace inteiro.
//   Eu rodei 87 chamadas três vezes em cinco minutos e derrubei o acesso: a terceira volta deu
//   0 de 87. Por isso: PASSO de 700ms entre chamadas (~85/min), e ao primeiro 429 a rotina
//   ABORTA respeitando Retry-After — insistir é o que gera as 3 violações e o bloqueio.
//
// *** E O MAIS IMPORTANTE: rodada INCOMPLETA não reporta número. ***
//   Na rodada bloqueada a função disse "VENCENDO_HOJE_AINDA_ABERTOS: 0" estando cega. Dizer
//   "nenhum prazo pendente" sem ter conseguido olhar manda a equipe para casa. Se um único
//   processo falhar, `COMPLETO:false` e as contagens vêm null, com aviso.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const K = "fech_7d2a91c4";
const PASSO_MS = 700;          // ~85 req/min, com folga sobre o limite de 120/min
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o, null, 1), { status: st, headers: { "Content-Type": "application/json" } });
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

// "Hoje" em Joinville: o cron roda 20:30 UTC, que ainda é o mesmo dia no BRT.
function hojeBR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("k") !== K) return json({ erro: "nao autorizado" }, 401);
  if (!API) return json({ erro: "sem LEGALMAIL_API_KEY" }, 500);
  const commit = url.searchParams.get("commit") !== "0";
  const gabarito = (url.searchParams.get("gabarito") || "").split(",")
    .map((x) => parseInt(x.trim(), 10)).filter(Number.isFinite);
  const t0 = Date.now();
  const hoje = hojeBR();

  try {
    let saldo: number | null = null;
    try {
      const rb = await fetch(`${BASE}/api/v1/balance?api_key=${encodeURIComponent(API)}`, { headers: { Accept: "application/json" } });
      const jb = await rb.json().catch(() => null);
      saldo = typeof jb?.saldo_disponivel === "number" ? jb.saldo_disponivel : null;
    } catch { /* informativo */ }

    const SEL = "id,data,status,cumprido,legalmail_id,processos!inner(id,numero,lm_idprocessos)";
    const prazos = await sb(`prazos?cumprido=eq.false&legalmail_id=not.is.null&select=${SEL}&processos.lm_idprocessos=not.is.null&limit=3000`);
    const lista: any[] = Array.isArray(prazos) ? prazos : [];

    // MODO GABARITO (`?gabarito=5441,5688,...`): inclui na varredura prazos que JÁ ESTÃO
    // fechados, que a consulta acima exclui por `cumprido=eq.false`. Serve para provar, com
    // caso de resposta conhecida, o que significa um prazo NÃO APARECER na lista do tribunal.
    // Ele nunca fecha nada: `gab` entra em `soLeitura` e é pulado na hora de gravar.
    const soLeitura = new Set<number>();
    if (gabarito.length) {
      const g = await sb(`prazos?id=in.(${gabarito.join(",")})&select=${SEL}&processos.lm_idprocessos=not.is.null`);
      for (const z of (Array.isArray(g) ? g : [])) {
        if (!lista.some((x) => x.id === z.id)) { lista.push(z); soLeitura.add(z.id); }
      }
    }

    const porProc = new Map<string, any[]>();
    for (const z of lista) {
      const idp = String(z?.processos?.lm_idprocessos || "");
      if (!idp) continue;
      if (!porProc.has(idp)) porProc.set(idp, []);
      porProc.get(idp)!.push(z);
    }

    let http_ok = 0, http_erro = 0, abortou_em: string | null = null, retry_after: number | null = null;
    const status_vistos: Record<string, number> = {};
    const aFechar: any[] = [], seguem: any[] = [], naoListados: any[] = [];
    let primeiro = true;

    for (const [idp, doProc] of porProc) {
      if (!primeiro) await dorme(PASSO_MS);
      primeiro = false;
      let j: any = null;
      try {
        const r = await fetch(`${BASE}/api/v1/pleading/notices-to-comply?api_key=${encodeURIComponent(API)}&idprocessos=${encodeURIComponent(idp)}`, { headers: { Accept: "application/json" } });
        status_vistos[String(r.status)] = (status_vistos[String(r.status)] || 0) + 1;
        if (r.status === 429) {
          // ABORTA na primeira. Insistir gera as 3 violações em 10min e bloqueia o workspace.
          retry_after = Number(r.headers.get("Retry-After") || 0) || null;
          abortou_em = idp; http_erro++;
          break;
        }
        if (!r.ok) { http_erro++; continue; }
        http_ok++;
        j = await r.json().catch(() => null);
      } catch { http_erro++; status_vistos["excecao"] = (status_vistos["excecao"] || 0) + 1; continue; }

      const fech = new Set<string>((Array.isArray(j?.intimacoes_prazo_fechado) ? j.intimacoes_prazo_fechado : []).map((x: any) => String(x?.idintimacoes)));
      const abre = new Set<string>((Array.isArray(j?.intimacoes_prazo_aberto)  ? j.intimacoes_prazo_aberto  : []).map((x: any) => String(x?.idintimacoes)));
      for (const z of doProc) {
        const k = String(z.legalmail_id);
        const balde = fech.has(k) ? "fechado" : (abre.has(k) ? "aberto" : "nao_listado");
        const item = { prazo: z.id, data: z.data, processo: z.processos?.numero, legalmail_id: z.legalmail_id,
                       ja_fechado_no_sistema: z.cumprido === true, gabarito: soLeitura.has(z.id), balde };
        if (balde === "fechado") aFechar.push(item);
        else if (balde === "aberto") seguem.push(item);
        else naoListados.push(item);
      }
    }

    const completo = http_erro === 0 && !abortou_em && http_ok === porProc.size;

    // Fechar o que o tribunal diz fechado é seguro mesmo em rodada incompleta: é informação
    // positiva e verificada. O que NÃO se pode em rodada incompleta é afirmar pendência.
    let fechados = 0;
    // O gabarito é só leitura: entrou na varredura para revelar o balde, não para ser fechado.
    const paraFechar = aFechar.filter((x) => !x.gabarito);
    if (commit && paraFechar.length) {
      const ids = paraFechar.map((x) => x.prazo);
      const r = await sb(`prazos?id=in.(${ids.join(",")})&cumprido=eq.false`, {
        method: "PATCH", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ cumprido: true, status: "cumprido",
          cumprido_em: new Date().toISOString(), cumprido_por: "notices-to-comply" }),
      });
      fechados = Array.isArray(r) ? r.length : 0;
    }

    const aindaAberto = seguem.concat(naoListados);
    const vencendoHoje = aindaAberto.filter((x) => String(x.data) === hoje);
    const vencidos     = aindaAberto.filter((x) => String(x.data) < hoje);

    const resumo: Record<string, unknown> = {
      rodou_em: new Date().toISOString(), hoje,
      segundos: +((Date.now() - t0) / 1000).toFixed(1),
      custo: "R$ 0,00 (notices-to-comply e balance sao gratis)",
      saldo_api: saldo,
      COMPLETO: completo,
      processos_alvo: porProc.size, http_ok, http_erro, status_vistos,
      abortou_por_429_no_processo: abortou_em, retry_after_segundos: retry_after,
      prazos_vistos: lista.length,
      fechados_agora: fechados,
      a_fechar_detectados: aFechar.length,
      fechou: aFechar.slice(0, 40),
    };

    // Relatório do gabarito: a prova de o que significa "não aparecer na lista do tribunal".
    // Fechado com prova => esperado "nao_listado". Aberto de verdade => esperado "aberto".
    if (gabarito.length) {
      const todos = aFechar.concat(seguem, naoListados).filter((x) => x.gabarito);
      const naoAchados = gabarito.filter((id) => !todos.some((x) => x.prazo === id));
      resumo.GABARITO = todos.map((x) => ({
        prazo: x.prazo, data: x.data, balde: x.balde,
        estado_no_sistema: x.ja_fechado_no_sistema ? "FECHADO com prova" : "aberto",
        esperado: x.ja_fechado_no_sistema ? "nao_listado" : "aberto",
        bate: x.balde === (x.ja_fechado_no_sistema ? "nao_listado" : "aberto"),
      }));
      resumo.GABARITO_ACERTOS = (resumo.GABARITO as any[]).filter((x) => x.bate).length
        + "/" + (resumo.GABARITO as any[]).length;
      if (naoAchados.length) resumo.GABARITO_SEM_PROCESSO_NO_LEGALMAIL = naoAchados;
    }

    if (completo) {
      resumo.seguem_abertos = seguem.length;
      resumo.nao_listados = naoListados.length;
      resumo.VENCENDO_HOJE_AINDA_ABERTOS = vencendoHoje.length;
      resumo.VENCIDOS_AINDA_ABERTOS = vencidos.length;
      resumo.vencendo_hoje = vencendoHoje.slice(0, 40);
      resumo.vencidos = vencidos.slice(0, 40);
    } else {
      // rodada cega: NÃO inventa número de pendência
      resumo.VENCENDO_HOJE_AINDA_ABERTOS = null;
      resumo.VENCIDOS_AINDA_ABERTOS = null;
      resumo.aviso = `RODADA INCOMPLETA (${http_ok}/${porProc.size} processos consultados). `
        + `Nao e possivel afirmar quantos prazos seguem abertos. `
        + (abortou_em ? `Abortada por HTTP 429 (limite de taxa)${retry_after ? `, Retry-After ${retry_after}s` : ""}. ` : "")
        + `Os ${aFechar.length} detectados como fechados sao confiaveis; a lista de pendentes NAO.`;
    }

    if (commit) {
      await sb(`prazo_fechamento_log`, {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          origem: "notices-to-comply",
          processos_consultados: porProc.size, http_ok, http_erro,
          prazos_vistos: lista.length, fechados,
          seguem_abertos: completo ? seguem.length : null,
          nao_listados: completo ? naoListados.length : null,
          vencendo_hoje_abertos: completo ? vencendoHoje.length : null,
          vencidos_abertos: completo ? vencidos.length : null,
          saldo_api: saldo, detalhe: resumo,
          erro: completo ? null : String(resumo.aviso),
        }]),
      }).catch(() => {});
    }
    return json({ ok: true, ...resumo });
  } catch (e) {
    const msg = String(e).slice(0, 400);
    await sb(`prazo_fechamento_log`, { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ origem: "notices-to-comply", erro: msg }]) }).catch(() => {});
    return json({ erro: msg }, 500);
  }
});
