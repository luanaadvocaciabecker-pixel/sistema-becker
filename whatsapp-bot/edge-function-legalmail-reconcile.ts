// Edge Function `legalmail-reconcile` — sincroniza "de hoje pra frente".
// Puxa /notices só da janela recente (padrão: últimos 7 dias por data de captura),
// limit<=50 com paginação. ?debug=1 mostra diagnóstico. ?dias=N muda a janela.
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
const MAX_PAGES = 20;
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

async function reconcile(notices: unknown[]) {
  const r = await fetch(`${SB}/rest/v1/rpc/lm_reconcile`, {
    method: "POST", headers: sbH, body: JSON.stringify({ notices }),
  });
  return r.ok ? await r.json() : { erro: `rpc ${r.status} ${await r.text()}` };
}

async function pull(status: string, since: string, debug: Record<string, unknown>[] | null): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const u = `${BASE}/api/v1/notices?api_key=${encodeURIComponent(API)}`
            + `&prazo_status=${encodeURIComponent(status)}&limit=${PAGE}&offset=${p*PAGE}`
            + `&data_captura_inicio=${since}&ordenar_por=id&ordem=desc`;
    const r = await fetch(u, { headers: { "Accept": "application/json" } });
    const txt = await r.text();
    let j: any = {}; try { j = JSON.parse(txt); } catch { /* */ }
    const arr = Array.isArray(j?.notices) ? j.notices : (Array.isArray(j) ? j : []);
    if (debug && p === 0) debug.push({ status, http: r.status, total: j?.total ?? null, amostra: txt.slice(0,160) });
    out.push(...arr);
    if (arr.length < PAGE) break;
  }
  return out;
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

  const all: unknown[] = [];
  for (const st of ["pendente", "cumprido", "excedido"]) {
    try { all.push(...await pull(st, since, debug)); } catch (e) { if (debug) debug.push({ status: st, erro: String(e) }); }
  }
  const res = await reconcile(all);
  return new Response(JSON.stringify({ janela_dias: dias, desde: since, puxados: all.length, ...res, ...(debug ? { debug } : {}) }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
