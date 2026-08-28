// Edge Function `legalmail-webhook` — recebe os eventos (push) do Legal Mail.
// Cópia versionada; o deploy é feito no Supabase.
//
// Fluxo:
//   1) Legal Mail faz POST JSON com o cabeçalho `X-LegalMail-Key` (quando há chave).
//   2) Validamos a chave contra o segredo LEGALMAIL_WEBHOOK_KEY.
//   3) Respondemos 200 em < 3s (exigência do Legal Mail) e mapeamos em segundo plano
//      via RPC `lm_ingest` (grava o cru em legalmail_eventos + publicacoes/prazos, idempotente).
//
// Segredos (Supabase -> Edge Functions -> legalmail-webhook -> Secrets):
//   LEGALMAIL_WEBHOOK_KEY  = a "chave de autenticação" que você define no painel de Webhooks.
//   (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem no ambiente.)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WH_KEY = Deno.env.get("LEGALMAIL_WEBHOOK_KEY") || "";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

async function ingest(body: unknown) {
  const r = await fetch(`${SB}/rest/v1/rpc/lm_ingest`, {
    method: "POST", headers: sbH, body: JSON.stringify({ body }),
  });
  if (!r.ok) {
    // Falhou o mapeamento: registra o cru pra reprocessar depois (nunca perde evento).
    await fetch(`${SB}/rest/v1/legalmail_eventos`, {
      method: "POST", headers: { ...sbH, Prefer: "return=minimal" },
      body: JSON.stringify({ tipo: "erro_ingest", payload: body, erro: `rpc ${r.status} ${await r.text()}` }),
    }).catch(() => {});
  }
}

Deno.serve(async (req: Request) => {
  // Verificação simples por GET (se o painel testar a URL).
  if (req.method === "GET") {
    return new Response("legalmail-webhook ok", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Autenticação: cabeçalho X-LegalMail-Key deve bater com o segredo (se configurado).
  if (WH_KEY) {
    const got = req.headers.get("x-legalmail-key") || req.headers.get("X-LegalMail-Key") || "";
    if (got !== WH_KEY) return new Response("unauthorized", { status: 401 });
  }

  let body: unknown = null;
  try { body = await req.json(); } catch { body = null; }
  if (body == null) return new Response("bad request", { status: 400 });

  // Responde já; mapeia em segundo plano pra respeitar o limite de 3s do Legal Mail.
  // @ts-ignore EdgeRuntime existe no runtime do Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(ingest(body));
  } else {
    await ingest(body);
  }
  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
