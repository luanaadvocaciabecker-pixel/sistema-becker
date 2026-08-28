// Edge Function `legalmail-reconcile` — roda 1x/dia (via pg_cron) e sincroniza os
// prazos com o Legal Mail: cria/atualiza a data-limite e marca cumprido/excedido.
//
// Consulta GET /api/v1/notices para os 3 status (pendente, cumprido, excedido) e
// passa o resultado para a RPC lm_reconcile.
//
// Segredos (Supabase -> Edge Functions -> legalmail-reconcile -> Secrets):
//   LEGALMAIL_API_KEY     = a api_key do painel "Tokens de acesso" (legalmail ou Infinitum).
//   LEGALMAIL_WEBHOOK_KEY = a mesma chave já usada no webhook (protege este gatilho).
//   (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem.)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const GUARD = Deno.env.get("LEGALMAIL_WEBHOOK_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

async function reconcile(notices: unknown[]) {
  const r = await fetch(`${SB}/rest/v1/rpc/lm_reconcile`, {
    method: "POST", headers: sbH, body: JSON.stringify({ notices }),
  });
  return r.ok ? await r.json() : { erro: `rpc ${r.status} ${await r.text()}` };
}

async function pull(status: string): Promise<unknown[]> {
  // Puxa até 200 intimações por status (mais recentes primeiro).
  const u = `${BASE}/api/v1/notices?api_key=${encodeURIComponent(API)}`
          + `&prazo_status=${encodeURIComponent(status)}&limit=200&ordenar_por=id&ordem=desc`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j?.notices) ? j.notices : (Array.isArray(j) ? j : []);
}

Deno.serve(async (req: Request) => {
  // Protege o gatilho: só roda com a chave (o pg_cron envia no header).
  if (GUARD) {
    const got = req.headers.get("x-reconcile-key") || "";
    if (got !== GUARD) return new Response("unauthorized", { status: 401 });
  }
  if (!API) {
    return new Response(JSON.stringify({ skipped: "LEGALMAIL_API_KEY não configurada" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  const all: unknown[] = [];
  for (const st of ["pendente", "cumprido", "excedido"]) {
    try { all.push(...await pull(st)); } catch { /* ignora status que falhar */ }
  }
  const res = await reconcile(all);
  return new Response(JSON.stringify({ puxados: all.length, ...res }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
