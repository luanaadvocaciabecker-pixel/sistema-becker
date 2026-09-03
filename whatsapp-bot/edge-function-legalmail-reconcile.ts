// Edge Function `legalmail-reconcile` — sincroniza status dos prazos.
//
// pendente : puxado por INTEIRO (sem filtro de captura) — a "Data final" pode ser
//            preenchida dias depois; cria/atualiza o prazo pela data real do tribunal.
// cumprido / excedido : puxados SEM janela de captura, porém limitados às N páginas
//            mais recentes (ordem=id desc). Isso FECHA prazos que foram cumpridos
//            tempos depois da captura (antes ficavam presos em "aberto" à toa).
//            Cada página vira uma chamada de RPC pequena (não estoura statement timeout).
//
// Gatilho: cron manda header x-reconcile-key = LEGALMAIL_WEBHOOK_KEY. Também aceita ?k=<token>
// embutido para acionamento manual. ?dias=N ainda existe (usado só se ?janela=1).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const GUARD = Deno.env.get("LEGALMAIL_WEBHOOK_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const K = "recon_5c1d8a3f";
const PAGE = 50;
const MAX_PAGES_PENDENTE = 200;  // até 10.000 pendentes
const MAX_PAGES_FECHADOS = 60;   // 3.000 cumpridos/excedidos mais recentes (cobre transições recentes)
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

async function reconcile(notices: unknown[]) {
  const r = await fetch(`${SB}/rest/v1/rpc/lm_reconcile`, {
    method: "POST", headers: sbH, body: JSON.stringify({ notices }),
  });
  return r.ok ? await r.json() : { erro: `rpc ${r.status} ${await r.text()}` };
}

// Puxa e grava página por página (cada página gera uma chamada de RPC pequena e rápida).
async function pullAndReconcile(status: string, since: string | null, maxPages: number, debug: Record<string, unknown>[] | null) {
  let puxados = 0;
  const agg: Record<string, number> = { publicacoes: 0, prazos: 0, cumpridos: 0, excedidos: 0 };
  const erros: string[] = [];
  for (let p = 0; p < maxPages; p++) {
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
  const url = new URL(req.url);
  const okAuth = (GUARD && req.headers.get("x-reconcile-key") === GUARD) || url.searchParams.get("k") === K;
  if (GUARD && !okAuth) return new Response("unauthorized", { status: 401 });
  if (!API) {
    return new Response(JSON.stringify({ skipped: "LEGALMAIL_API_KEY não configurada" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  const debug = url.searchParams.get("debug") ? [] as Record<string, unknown>[] : null;
  const dias = Math.max(1, Math.min(60, parseInt(url.searchParams.get("dias") || "7", 10) || 7));
  // Por padrão fechamos SEM janela (since=null). ?janela=1 volta ao comportamento antigo.
  const usarJanela = url.searchParams.get("janela") === "1";
  const since = usarJanela ? new Date(Date.now() - dias*86400000).toISOString().slice(0,10) : null;

  let puxados = 0;
  const agg: Record<string, number> = { publicacoes: 0, prazos: 0, cumpridos: 0, excedidos: 0 };
  const erros: string[] = [];
  const plano: [string, string|null, number][] = [
    ["pendente", null, MAX_PAGES_PENDENTE],
    ["cumprido", since, MAX_PAGES_FECHADOS],
    ["excedido", since, MAX_PAGES_FECHADOS],
  ];
  for (const [st, s, mp] of plano) {
    try {
      const res = await pullAndReconcile(st, s, mp, debug);
      puxados += res.puxados;
      agg.publicacoes += res.agg.publicacoes; agg.prazos += res.agg.prazos;
      agg.cumpridos += res.agg.cumpridos; agg.excedidos += res.agg.excedidos;
      erros.push(...res.erros);
    } catch (e) { erros.push(`${st}: ${String(e)}`); }
  }
  return new Response(JSON.stringify({ sem_janela: !usarJanela, puxados, ...agg, erros: erros.length ? erros : undefined, ...(debug ? { debug } : {}) }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
