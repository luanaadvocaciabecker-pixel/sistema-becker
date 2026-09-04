// Edge Function `whatsapp` — recebe o webhook do WhatsApp, identifica o cliente e responde o
// status do processo com trava de LGPD + camada de IA (Gemini, tom formal-humano).
// Formatos de entrada: Meta Cloud API, Evolution API, WATI, e teste manual {test,from,text}.
// Segredos: GEMINI_API_KEY (+ GEMINI_MODEL, padrão gemini-flash-lite-latest), WHATSAPP_TOKEN,
//   e (opcionais, por canal) META_TOKEN/META_PHONE_ID, WATI_URL/WATI_TOKEN, EVOLUTION_*.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WTOKEN = Deno.env.get("WHATSAPP_TOKEN") || "";
const META_TOKEN = Deno.env.get("META_TOKEN") || "";
const META_PHONE_ID = Deno.env.get("META_PHONE_ID") || "";
const META_VER = Deno.env.get("META_GRAPH_VER") || "v21.0";
const EVO_URL = Deno.env.get("EVOLUTION_URL") || "";
const EVO_KEY = Deno.env.get("EVOLUTION_KEY") || "";
const EVO_INST = Deno.env.get("EVOLUTION_INSTANCE") || "";
const WATI_URL = Deno.env.get("WATI_URL") || "";
const WATI_TOKEN = Deno.env.get("WATI_TOKEN") || "";
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

async function rpc(fn: string, args: unknown) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: sbH, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`rpc ${fn} ${r.status} ${await r.text()}`);
  return r.json();
}
async function logar(row: Record<string, unknown>) {
  await fetch(`${SB}/rest/v1/whatsapp_log`, { method: "POST", headers: { ...sbH, Prefer: "return=minimal" }, body: JSON.stringify(row) }).catch(() => {});
}

// Envia pela ordem de prioridade: Meta -> WATI -> Evolution. Senão modo teste (só devolve no HTTP).
async function enviar(numero: string, texto: string): Promise<boolean> {
  if (META_TOKEN && META_PHONE_ID) {
    const r = await fetch(`https://graph.facebook.com/${META_VER}/${META_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${META_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: numero, type: "text", text: { body: texto } }),
    });
    return r.ok;
  }
  if (WATI_URL && WATI_TOKEN) {
    const r = await fetch(`${WATI_URL}/api/v1/sendSessionMessage/${encodeURIComponent(numero)}?messageText=${encodeURIComponent(texto)}`, {
      method: "POST", headers: { Authorization: WATI_TOKEN.startsWith("Bearer")?WATI_TOKEN:`Bearer ${WATI_TOKEN}`, "Content-Type": "application/json" },
    });
    return r.ok;
  }
  if (EVO_URL && EVO_KEY && EVO_INST) {
    const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, {
      method: "POST", headers: { "apikey": EVO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ number: numero, text: texto }),
    });
    return r.ok;
  }
  return false;
}

const SYSTEM_IA = [
  "Você redige, em nome do escritório Becker Advogados, uma mensagem de WhatsApp para o próprio cliente, atualizando-o sobre o processo dele.",
  "Tom: FORMAL, porém natural, cordial e humano — como um advogado atencioso escreveria ao seu cliente, preservando a relação advogado-cliente.",
  "NUNCA soe robótico e NÃO se identifique como IA, robô, 'assistente virtual' ou 'resposta automática'.",
  "Regras invioláveis: use SOMENTE os dados fornecidos — jamais invente fatos, datas, valores, prazos ou resultados; se algum dado não constar, não mencione.",
  "Traduza os termos jurídicos para uma linguagem que o cliente entenda, mantendo a seriedade e a precisão.",
  "Explique de forma acolhedora o que aconteceu recentemente no processo e em que ponto ele está agora.",
  "NÃO dê opinião, conselho, prognóstico ou estratégia jurídica. Se o cliente pedir isso, diga com cordialidade que um advogado do escritório o atenderá pessoalmente.",
  "Estrutura: inicie com 'Prezado(a) [primeiro nome],'; escreva de 3 a 7 linhas; português do Brasil; sem emojis; encerre com 'Atenciosamente,' seguido de 'Equipe Becker Advogados.'"
].join(" ");

async function explicar(nome: string, dossie: string, pergunta: string): Promise<string | null> {
  if (!GKEY) return null;
  const user = `Nome do cliente: ${nome}\nPergunta/mensagem do cliente: "${pergunta}"\n\nDados reais do(s) processo(s) (use apenas isto):\n${dossie}`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_IA }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
    return txt || null;
  } catch { return null; }
}

const PEDIR_CPF = "Olá! Para confirmarmos sua identidade e tratarmos do seu processo com segurança, por favor, informe o seu CPF (somente os números). Agradecemos a compreensão.";
const NAO_ACHOU = "Não localizamos um cadastro com esses dados. Um de nossos atendentes entrará em contato com você em breve. Atenciosamente, Equipe Becker Advogados.";
const DICA = "\n\nPara ver o histórico completo de um processo, responda com o número dele.";

function extrairCpf(texto: string): string {
  const m = texto.match(/\d{3}\D?\d{3}\D?\d{3}\D?\d{2}/);
  if (m) return m[0].replace(/\D/g, "");
  const dig = texto.replace(/\D/g, "");
  return dig.length >= 11 ? dig.slice(0, 14) : "";
}

async function montarResposta(clienteId: number, nome: string, texto: string) {
  const procs = await rpc("processos_do_cliente", { p_id: clienteId });
  const lista = Array.isArray(procs) ? procs : [];
  const runs = texto.match(/\d{6,}/g) || [];
  let escolhido: any = null;
  for (const run of runs) {
    const p = lista.find((pp: any) => String(pp.numero || "").replace(/\D/g, "").includes(run));
    if (p) { escolhido = p; break; }
  }
  const querDetalhe = /detalh|hist[oó]ric|andament|complet|\btudo\b|movimenta|documento/i.test(texto);
  if (!escolhido && querDetalhe) {
    if (lista.length === 1) escolhido = lista[0];
    else if (lista.length > 1) {
      const nums = lista.map((p: any) => "• " + (p.numero || "(sem nº)")).join("\n");
      return { texto: "Você possui " + lista.length + " processos conosco. Sobre qual deseja o histórico completo? Por favor, responda com o número:\n\n" + nums, status: "escolher_processo" };
    }
  }
  let base: string; let status: string;
  if (escolhido) { base = await rpc("montar_detalhe_processo", { p_processo_id: escolhido.id }) as unknown as string; status = "detalhe"; }
  else { base = (await rpc("montar_status_cliente", { p_id: clienteId }) as unknown as string) + (lista.length ? DICA : ""); status = "identificado"; }
  const natural = await explicar(nome, base, texto);
  if (natural) return { texto: natural, status: status + "_ia" };
  return { texto: base, status };
}

async function responder(telefone: string, texto: string) {
  const porTel = await rpc("cliente_por_telefone", { p_tel: telefone });
  if (Array.isArray(porTel) && porTel.length === 1) {
    const r = await montarResposta(porTel[0].id, porTel[0].nome, texto);
    return { ...r, cliente_id: porTel[0].id };
  }
  const cpf = extrairCpf(texto);
  if (cpf) {
    const porCpf = await rpc("cliente_por_cpf", { p_cpf: cpf });
    if (Array.isArray(porCpf) && porCpf.length === 1) {
      const r = await montarResposta(porCpf[0].id, porCpf[0].nome, texto);
      return { ...r, cliente_id: porCpf[0].id };
    }
    return { texto: NAO_ACHOU, cliente_id: null, status: "nao_encontrado" };
  }
  return { texto: PEDIR_CPF, cliente_id: null, status: "pediu_cpf" };
}

// Extrai { telefone, texto } dos formatos: teste, Meta Cloud, WATI, Evolution.
function extrair(body: any): { telefone: string; texto: string } | null {
  if (body?.test) return { telefone: String(body.from || ""), texto: String(body.text || "") };
  const val = body?.entry?.[0]?.changes?.[0]?.value;
  if (val) {
    const m = val.messages?.[0];
    if (!m) return null;
    const telefone = String(m.from || "");
    const texto = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
    if (!telefone) return null;
    return { telefone, texto: String(texto) };
  }
  // WATI: { waId, text } ou { data:{ waId, text } }; ignora mensagens do próprio dono (owner=true)
  const w = body?.waId ? body : (body?.data?.waId ? body.data : null);
  if (w && (w.type ? w.type === "text" : true) && !w.owner) {
    const telefone = String(w.waId || "");
    const texto = String(w.text || w.textData?.text || "");
    if (telefone && texto) return { telefone, texto };
  }
  const d = body?.data;
  if (d) {
    if (d.key?.fromMe) return null;
    const jid = String(d.key?.remoteJid || "");
    if (!jid || jid.endsWith("@g.us")) return null;
    const telefone = jid.split("@")[0];
    const texto = d.message?.conversation || d.message?.extendedTextMessage?.text || d.message?.ephemeralMessage?.message?.extendedTextMessage?.text || "";
    return { telefone, texto: String(texto) };
  }
  return null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && WTOKEN && token === WTOKEN) {
      return new Response(challenge || "", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("forbidden", { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const isMeta = !!body?.entry;
    if (WTOKEN && !isMeta && !body?.test) {
      const t = req.headers.get("x-webhook-token") || url.searchParams.get("token") || "";
      if (t !== WTOKEN) return new Response("unauthorized", { status: 401 });
    }
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
