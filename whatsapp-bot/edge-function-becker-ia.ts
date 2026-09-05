// Edge Function `becker-ia` — funções de IA do menu "Becker IA" via Google Gemini.
// Ações:
//   - resumo_atendimento {texto}         -> JSON {resumo, pontos[], pendencias[], proximos_passos[]}
//   - transcricao        {audio_b64,mime}-> {texto}  (Gemini Files API lê o áudio)
//   - gerar_documento    {tipo, contexto}-> {documento}  (rascunho para REVISÃO humana)
//
// IA barata (Gemini flash-lite). NÃO faz jurisprudência (risco de inventar precedente) — isso
// continua na base verificada externa. Segredos: GEMINI_API_KEY (+ GEMINI_MODEL).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, st = 200) =>
  new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

async function gerar(system: string, user: string, opts: { jsonOut?: boolean, maxTokens?: number } = {}): Promise<string> {
  const gc: any = { temperature: 0.3, maxOutputTokens: opts.maxTokens || 2000 };
  if (opts.jsonOut) gc.responseMimeType = "application/json";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: gc,
    }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
}

// sobe um arquivo binário (áudio) pra Files API e espera ACTIVE
async function uploadFile(bytes: Uint8Array, mime: string, nome: string): Promise<string | null> {
  const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GKEY)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: nome } }),
  });
  const up = start.headers.get("x-goog-upload-url"); if (!up) return null;
  const fin = await fetch(up, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Length": String(bytes.length) },
    body: bytes,
  });
  const j = await fin.json().catch(() => ({} as any));
  let uri = j?.file?.uri, name = j?.file?.name, state = j?.file?.state;
  for (let i = 0; i < 30 && state && state !== "ACTIVE"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(GKEY)}`);
    const sj = await s.json().catch(() => ({} as any)); state = sj?.state; uri = sj?.uri || uri;
  }
  return state === "ACTIVE" ? uri : null;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.includes(",") ? b64.split(",")[1] : b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const SYS_RESUMO = [
  "Você é assistente jurídico de um escritório de advocacia brasileiro.",
  "Recebe o texto bruto de um atendimento ao cliente e produz um resumo objetivo e profissional.",
  "Responda SOMENTE em JSON:",
  '{"resumo":"2-4 frases do que foi tratado","pontos":["fatos/pedidos relevantes"],"pendencias":["documentos ou informações que faltam"],"proximos_passos":["o que o escritório deve fazer"]}',
  "Não invente fatos que não estão no texto. Linguagem clara, sem juridiquês desnecessário.",
].join(" ");

const SYS_ASSIST = [
  "Você é a Becker IA, assistente jurídica do escritório Becker Advogados (Brasil).",
  "Responde perguntas de direito e de organização do escritório de forma prática, direta e em português claro (pode usar tópicos).",
  "NUNCA invente jurisprudência, número de súmula, artigo de lei específico, valor ou prazo legal exato do qual não tenha certeza:",
  "quando não tiver certeza, diga isso com franqueza e recomende conferir na fonte oficial ou usar a aba de Jurisprudência verificada do sistema.",
  "Trate tudo como orientação a ser conferida por um(a) advogado(a) — não como parecer definitivo. Respeite a LGPD: não peça nem exponha dados pessoais sensíveis sem necessidade.",
].join(" ");

const SYS_DOC = [
  "Você é advogado(a) brasileiro(a) redigindo a MINUTA de um documento jurídico.",
  "Use linguagem formal e a estrutura usual do tipo de peça pedido. Onde faltar dado, marque com [PREENCHER: ...].",
  "NÃO invente jurisprudência, números de processo, valores ou datas — se não vier no contexto, deixe [PREENCHER].",
  "Comece o texto com a linha: RASCUNHO — revisar antes de usar.",
].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!GKEY) return json({ erro: "sem GEMINI_API_KEY" }, 500);
  let body: any = {}; try { body = await req.json(); } catch {}
  const action = String(body.action || "");
  try {
    if (action === "resumo_atendimento") {
      const texto = String(body.texto || "").trim();
      if (texto.length < 10) return json({ erro: "cole o texto do atendimento" }, 400);
      const out = await gerar(SYS_RESUMO, "Atendimento:\n" + texto.slice(0, 12000), { jsonOut: true, maxTokens: 1500 });
      let obj: any = null; try { const a = out.indexOf("{"), b = out.lastIndexOf("}"); obj = JSON.parse(out.slice(a, b + 1)); } catch {}
      if (!obj) return json({ erro: "falha ao resumir", bruto: out.slice(0, 500) }, 502);
      return json({ ok: true, ...obj });
    }

    if (action === "gerar_documento") {
      const tipo = String(body.tipo || "documento").trim();
      const contexto = String(body.contexto || "").trim();
      if (contexto.length < 5) return json({ erro: "descreva o caso / dados para o documento" }, 400);
      const user = `Tipo de documento: ${tipo}\n\nContexto/fatos fornecidos pelo escritório:\n${contexto.slice(0, 8000)}`;
      const doc = await gerar(SYS_DOC, user, { maxTokens: 3500 });
      if (!doc) return json({ erro: "falha ao gerar" }, 502);
      return json({ ok: true, documento: doc });
    }

    if (action === "transcricao") {
      const b64 = String(body.audio_b64 || "");
      const mime = String(body.mime || "audio/mpeg");
      if (!b64) return json({ erro: "sem áudio" }, 400);
      const bytes = b64ToBytes(b64);
      const uri = await uploadFile(bytes, mime, "audio");
      if (!uri) return json({ erro: "falha ao enviar áudio para a IA" }, 502);
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { fileData: { fileUri: uri, mimeType: mime } },
            { text: "Transcreva este áudio em português do Brasil, na íntegra e com pontuação. Se houver mais de uma pessoa falando, indique os turnos de fala. Responda só com a transcrição." },
          ] }],
          generationConfig: { temperature: 0, maxOutputTokens: 8000 },
        }),
      });
      if (!r.ok) return json({ erro: `gemini ${r.status}` }, 502);
      const j = await r.json();
      const texto = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
      return json({ ok: true, texto });
    }

    if (action === "assistente") {
      const pergunta = String(body.pergunta || "").trim();
      if (pergunta.length < 2) return json({ erro: "faça uma pergunta" }, 400);
      const hist = Array.isArray(body.historico) ? body.historico.slice(-6) : [];
      const contents: any[] = [];
      for (const h of hist) {
        const role = h?.role === "assistant" ? "model" : "user";
        const t = String(h?.texto || h?.text || "").slice(0, 3000);
        if (t) contents.push({ role, parts: [{ text: t }] });
      }
      contents.push({ role: "user", parts: [{ text: pergunta.slice(0, 4000) }] });
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYS_ASSIST }] },
          contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 1800 },
        }),
      });
      if (!r.ok) return json({ erro: `gemini ${r.status}` }, 502);
      const j = await r.json();
      const resposta = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
      return resposta ? json({ ok: true, resposta }) : json({ erro: "sem resposta" }, 502);
    }

    return json({ erro: "action inválida (assistente|resumo_atendimento|transcricao|gerar_documento)" }, 400);
  } catch (e) {
    return json({ erro: String(e).slice(0, 400) }, 500);
  }
});
