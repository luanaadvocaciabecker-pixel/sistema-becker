// Edge Function `whatsapp` — deployada no Supabase (cópia para versionamento).
// Recebe o webhook do Evolution (ou um teste {test:true,from,text}),
// identifica o cliente e responde o status do processo (com trava de LGPD).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WTOKEN = Deno.env.get("WHATSAPP_TOKEN") || "";
const EVO_URL = Deno.env.get("EVOLUTION_URL") || "";
const EVO_KEY = Deno.env.get("EVOLUTION_KEY") || "";
const EVO_INST = Deno.env.get("EVOLUTION_INSTANCE") || "";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

async function rpc(fn: string, args: unknown) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: sbH, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`rpc ${fn} ${r.status} ${await r.text()}`);
  return r.json();
}
async function logar(row: Record<string, unknown>) {
  await fetch(`${SB}/rest/v1/whatsapp_log`, { method: "POST", headers: { ...sbH, Prefer: "return=minimal" }, body: JSON.stringify(row) }).catch(() => {});
}
async function enviar(numero: string, texto: string) {
  if (!EVO_URL || !EVO_KEY || !EVO_INST) return false;
  const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, {
    method: "POST", headers: { "apikey": EVO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ number: numero, text: texto }),
  });
  return r.ok;
}

const PEDIR_CPF = "Olá! 👋 Sou o assistente virtual da *Becker Advogados*. Para confirmar sua identidade e te passar a situação do seu processo com segurança, me envie o seu *CPF* (somente os números). 🔒";
const NAO_ACHOU = "Não localizei um cadastro com esses dados. Um de nossos atendentes vai te responder em breve. 🙏";

function extrairCpf(texto: string): string {
  const m = texto.match(/\d{3}\D?\d{3}\D?\d{3}\D?\d{2}/);
  if (m) return m[0].replace(/\D/g, "");
  const dig = texto.replace(/\D/g, "");
  return dig.length >= 11 ? dig.slice(0, 14) : "";
}

async function responder(telefone: string, texto: string) {
  const porTel = await rpc("cliente_por_telefone", { p_tel: telefone });
  if (Array.isArray(porTel) && porTel.length === 1) {
    const msg = await rpc("montar_status_cliente", { p_id: porTel[0].id });
    return { texto: msg as unknown as string, cliente_id: porTel[0].id, status: "identificado" };
  }
  const cpf = extrairCpf(texto);
  if (cpf) {
    const porCpf = await rpc("cliente_por_cpf", { p_cpf: cpf });
    if (Array.isArray(porCpf) && porCpf.length === 1) {
      const msg = await rpc("montar_status_cliente", { p_id: porCpf[0].id });
      return { texto: msg as unknown as string, cliente_id: porCpf[0].id, status: "identificado_cpf" };
    }
    return { texto: NAO_ACHOU, cliente_id: null, status: "nao_encontrado" };
  }
  return { texto: PEDIR_CPF, cliente_id: null, status: "pediu_cpf" };
}

function extrair(body: any): { telefone: string; texto: string } | null {
  if (body?.test) return { telefone: String(body.from || ""), texto: String(body.text || "") };
  const d = body?.data;
  if (!d) return null;
  if (d.key?.fromMe) return null;
  const jid = String(d.key?.remoteJid || "");
  if (!jid || jid.endsWith("@g.us")) return null;
  const telefone = jid.split("@")[0];
  const texto = d.message?.conversation || d.message?.extendedTextMessage?.text || d.message?.ephemeralMessage?.message?.extendedTextMessage?.text || "";
  return { telefone, texto: String(texto) };
}

Deno.serve(async (req) => {
  try {
    if (WTOKEN) {
      const t = req.headers.get("x-webhook-token") || new URL(req.url).searchParams.get("token") || "";
      if (t !== WTOKEN) return new Response("unauthorized", { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const ex = extrair(body);
    if (!ex || !ex.telefone) return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { "Content-Type": "application/json" } });
    const r = await responder(ex.telefone, ex.texto);
    const enviado = await enviar(ex.telefone, r.texto);
    await logar({ telefone: ex.telefone, cliente_id: r.cliente_id, mensagem_recebida: ex.texto.slice(0, 2000), resposta_enviada: r.texto.slice(0, 4000), status: r.status });
    return new Response(JSON.stringify({ ok: true, status: r.status, enviado, resposta: r.texto }), { headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, erro: String(e?.message || e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
