// Edge Function `prazos-sync` — botão "Sincronizar prazos agora" da tela de Prazos.
// Chama a `legalmail-reconcile` do lado do servidor (com o segredo guardado no env),
// para que o front-end não precise conhecer a chave do cron. Exige usuário logado.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB    = Deno.env.get("SUPABASE_URL")!;
const GUARD = Deno.env.get("LEGALMAIL_WEBHOOK_KEY") || "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

// confirma que o token é de usuário autenticado (não a chave publishable/anon)
function usuarioAutenticado(req: Request): boolean {
  try {
    const h = req.headers.get("Authorization") || "";
    const t = h.replace(/^Bearer\s+/i, "");
    const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p?.role === "authenticated";
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "não autenticado" }, 401);
  try {
    // janela curta (dias) — barato e fecha as transições recentes; pendente é sempre integral.
    const r = await fetch(`${SB}/functions/v1/legalmail-reconcile?janela=1&dias=7`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-reconcile-key": GUARD },
      body: "{}",
    });
    const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
    if (!r.ok) return json({ erro: `reconcile ${r.status}`, detalhe: String(t).slice(0, 200) }, 502);
    return json({ ok: true, ...j });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
