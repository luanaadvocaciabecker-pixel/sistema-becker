// Edge Function `legalmail-reconcile` — sincroniza "de hoje pra frente".
// "pendente" é puxado por inteiro (sem filtro de data de captura) a cada rodada, pois o Legal
// Mail pode preencher a data-limite dias depois da captura — sem isso, uma intimação capturada
// há mais de `dias` dias nunca seria revisitada e ficaria presa em "ESTIMADO" para sempre mesmo
// com a data real já disponível na API. "cumprido"/"excedido" continuam só na janela recente
// (padrão: últimos 7 dias por data de captura; ?dias=N muda a janela). limit<=50 com paginação.
// O workspace pode ter milhares de "pendente" (backlog histórico) — a RPC lm_reconcile é chamada
// UMA VEZ POR PÁGINA (50 registros) em vez de acumular tudo num array e mandar de uma vez, senão
// o Postgres cancela a chamada por statement timeout e NADA é salvo daquela rodada.
// ?debug=1 mostra diagnóstico.
//
// Estratégia (definida com a Luana):
//   - pendente sem data-limite -> prazo ESTIMADO (disponibilização + 15 dias úteis), marcado "⚠ ESTIMADO (conferir)".
//   - pendente com data-limite -> usa a data real.
//   - cumprido/excedido        -> só atualiza prazo já existente (não cria histórico).
//   - a RPC lm_reconcile NÃO sobrescreve prazo já corrigido/concluído por humano.
//
// Segredos: LEGALMAIL_API_KEY (token do painel), LEGALMAIL_WEBHOOK_KEY (protege o gatilho).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const GUARD = Deno.env.get("LEGALMAIL_WEBHOOK_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const PAGE = 50;
const MAX_PAGES = 200; // cobre até 10.000 registros de backlog; a paginação para sozinha quando acabar
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

async function reconcile(notices: unknown[]) {
  const r = await fetch(`${SB}/rest/v1/rpc/lm_reconcile`, {
    method: "POST", headers: sbH, body: JSON.stringify({ notices }),
  });
  return r.ok ? await r.json() : { erro: `rpc ${r.status} ${await r.text()}` };
}

// Puxa e grava página por página (cada página gera uma chamada de RPC pequena e rápida).
async function pullAndReconcile(status: string, since: string | null, debug: Record<string, unknown>[] | null) {
  let puxados = 0;
  const agg: Record<string, number> = { publicacoes: 0, prazos: 0, cumpridos: 0, excedidos: 0 };
  const erros: string[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const u = `${BASE}/api/v1/notices?api_key=${encodeURIComponent(API)}`
            + `&prazo_status=${encodeURIComponent(status)}&limit=${PAGE}&offset=${p*PAGE}`
            + (since ? `&data_captura_inicio=${since}` : '')
            + `&ordenar_por=id&ordem=desc`;
    const r = await fetch(u, { headers: { "Accept": "application/json" } });
    const txt = await r.text();
    let j: any = {}; try { j = JSON.parse(txt); } catch { /* */ }
    const arr = Array.isArray(j?.notices) ? j.notices : (Array.isArray(j) ? j : []);
    if (debug && p === 0) debug.push({ status, http: r.status, total: j?.total ?? null, amostra: txt.slice(0,160) });
    if (arr.length) {
      puxados += arr.length;
      const res = await reconcile(arr);
      if (res && !res.erro) {
        agg.publicacoes += res.publicacoes || 0;
        agg.prazos      += res.prazos      || 0;
        agg.cumpridos   += res.cumpridos   || 0;
        agg.excedidos   += res.excedidos   || 0;
      } else {
        erros.push(`pagina ${p}: ${res?.erro}`);
      }
    }
    if (arr.length < PAGE) break;
  }
  return { puxados, agg, erros };
}

Deno.serve(async (req: Request) => {
  if (GUARD) {
    const got = req.headers.get("x-reconcile-key") || "";
    if (got !== GUARD) return new Response("unauthorized", { status: 401 });
  }
  if (!API) {
    return new Response(JSON.stringify({ skipped: "LEGALMAIL_API_KEY não configurada" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") ? [] as Record<string, unknown>[] : null;
  const dias = Math.max(1, Math.min(60, parseInt(url.searchParams.get("dias") || "7", 10) || 7));
  const since = new Date(Date.now() - dias*86400000).toISOString().slice(0,10);

  let puxados = 0;
  const agg: Record<string, number> = { publicacoes: 0, prazos: 0, cumpridos: 0, excedidos: 0 };
  const erros: string[] = [];
  // "pendente" sem filtro de captura: precisa reconsultar TODO pendente em aberto (não só os
  // capturados na janela recente), porque a data-limite pode ser preenchida pelo tribunal/Legal Mail
  // dias depois da captura — se filtrássemos por data_captura_inicio, uma intimação capturada há mais
  // de `dias` dias nunca mais seria revisitada e ficaria presa em "ESTIMADO" mesmo com a data real disponível.
  // "cumprido"/"excedido" são transições recentes: a janela de dias é suficiente aqui.
  for (const [st, s] of [["pendente", null], ["cumprido", since], ["excedido", since]] as [string, string|null][]) {
    try {
      const res = await pullAndReconcile(st, s, debug);
      puxados += res.puxados;
      agg.publicacoes += res.agg.publicacoes; agg.prazos += res.agg.prazos;
      agg.cumpridos += res.agg.cumpridos; agg.excedidos += res.agg.excedidos;
      erros.push(...res.erros);
    } catch (e) { erros.push(`${st}: ${String(e)}`); }
  }
  return new Response(JSON.stringify({ janela_dias: dias, desde: since, puxados, ...agg, erros: erros.length ? erros : undefined, ...(debug ? { debug } : {}) }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
