// Edge Function `autos-ia` — Puxar autos (íntegra) + resumo por IA, SOB DEMANDA e com custo controlado.
//
// O download de autos do Legal Mail custa R$ 0,02 por DOCUMENTO. Por isso o fluxo é:
//   1) preview  (GRÁTIS): GET lawsuit/case-files -> conta os documentos -> mostra "N docs (~R$ N×0,02)".
//   2) request  (PAGO)  : só depois da confirmação humana -> POST case-files/download/request.
//                         Protegido pela nossa linha em `processo_autos` para nunca cobrar 2x o mesmo processo.
//   3) status   (GRÁTIS): poll do job. Ao COMPLETED, baixa o PDF, sobe no bucket privado `autos`,
//                         manda pro Gemini ler o ÚLTIMO ato e grava ia_resumo/ia_json.
//                         A parte pesada roda em background (EdgeRuntime.waitUntil) pra não estourar o timeout.
//   4) get      (GRÁTIS): devolve o estado atual + URL assinada do PDF (para a tela mostrar sem reprocessar).
//
// Auth: verify_jwt=true (só usuário logado dispara gasto). Escreve no banco/Storage com service role.
// Segredos: LEGALMAIL_API_KEY, GEMINI_API_KEY (+ GEMINI_MODEL), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const CUSTO_DOC = 0.02; // R$ por documento
const BUCKET = "autos";

const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, st = 200) =>
  new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${String(t).slice(0, 200)}`);
  return j;
}

// decodifica o JWT do chamador. A anon/publishable key NÃO é um JWT de usuário,
// então cai no catch. Usuário logado tem role='authenticated'.
function claimsDoToken(req: Request): any | null {
  try {
    const tk = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    return JSON.parse(atob(tk.split(".")[1] || ""));
  } catch { return null; }
}
function callerEmail(req: Request): string {
  const c = claimsDoToken(req);
  return c?.email || c?.sub || "usuario";
}
// só um usuário logado (role=authenticated) pode disparar ação que gasta dinheiro
function usuarioAutenticado(req: Request): boolean {
  return claimsDoToken(req)?.role === "authenticated";
}

async function idprocessosDoProcesso(processoId: number): Promise<{ idp: number | null, numero: string }> {
  const rows = await sb(`processos?id=eq.${processoId}&select=lm_idprocessos,numero`);
  const r = Array.isArray(rows) ? rows[0] : null;
  return { idp: r?.lm_idprocessos ?? null, numero: r?.numero || "" };
}

async function contarDocs(idp: number): Promise<number> {
  const u = `${BASE}/api/v1/lawsuit/case-files?api_key=${encodeURIComponent(API)}&idprocessos=${idp}`;
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j.length : 0;
}

async function linhaAutos(processoId: number): Promise<any | null> {
  const rows = await sb(`processo_autos?processo_id=eq.${processoId}&select=*&order=criado_em.desc&limit=1`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function urlAssinada(path: string): Promise<string | null> {
  if (!path) return null;
  const r = await fetch(`${SB}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST", headers: sbH, body: JSON.stringify({ expiresIn: 3600 }),
  });
  const j = await r.json().catch(() => null);
  return j?.signedURL ? `${SB}/storage/v1${j.signedURL}` : null;
}

// ─── Gemini: lê o PDF (Files API) e classifica o último ato ────────────────────
async function uploadPdf(bytes: Uint8Array): Promise<string | null> {
  const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GKEY)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": "application/pdf", "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "autos" } }),
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

const PROMPT = [
  "Estes são os autos completos de um processo judicial brasileiro (documentos em ordem do mais recente para o mais antigo).",
  "Analise o ÚLTIMO ato decisório (despacho/decisão/sentença/acórdão) e o que ele exige do escritório de advocacia.",
  "Responda SOMENTE em JSON:",
  '{"providencia":"custas|documentos|geral","prazo_dias":<inteiro ou null>,"data_final":"DD/MM/AAAA ou null",',
  '"ultimo_ato":"título curto do último ato","resumo":"3-4 frases: em que pé está o processo e o que o escritório precisa fazer agora"}',
  "'custas' = precisa recolher custas/preparo/porte/GRU/taxa. 'documentos' = precisa juntar/apresentar documento/procuração/comprovante. 'geral' = qualquer outra.",
  "Se o ato não fixa prazo para o escritório, use prazo_dias e data_final null. Escreva o resumo em português claro, sem juridiquês desnecessário.",
].join(" ");

async function lerComIA(pdfUrl: string): Promise<{ ok: boolean, mb: number, obj: any, err?: string }> {
  const pr = await fetch(pdfUrl);
  if (!pr.ok) return { ok: false, mb: 0, obj: null, err: `pdf http ${pr.status}` };
  const buf = new Uint8Array(await pr.arrayBuffer());
  const mb = +(buf.length / 1048576).toFixed(1);
  const uri = await uploadPdf(buf);
  if (!uri) return { ok: false, mb, obj: null, err: "upload/ACTIVE falhou" };
  const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ fileData: { fileUri: uri, mimeType: "application/pdf" } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 2000, responseMimeType: "application/json" },
    }),
  });
  if (!g.ok) return { ok: false, mb, obj: null, err: `gemini http ${g.status}` };
  const j = await g.json().catch(() => null);
  let txt = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
  const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
  if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
  let obj: any = null; try { obj = JSON.parse(txt); } catch { /* deixa null */ }
  return { ok: !!obj, mb, obj, err: obj ? undefined : "json invalido" };
}

// Baixa o PDF do job concluído, guarda no bucket, roda a IA e grava tudo. (roda em background)
async function processarConcluido(row: any, outputUrl: string) {
  const path = `proc/${row.processo_id}/autos_${Date.now()}.pdf`;
  try {
    // 1) guarda o PDF no bucket privado
    const pr = await fetch(outputUrl);
    if (pr.ok) {
      const bytes = new Uint8Array(await pr.arrayBuffer());
      await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/pdf", "x-upsert": "true" },
        body: bytes,
      });
    }
    // 2) IA lê o último ato
    const ia = await lerComIA(outputUrl);
    // 3) grava resultado
    await sb(`processo_autos?id=eq.${row.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: ia.ok ? "pronto" : "erro_ia",
        pdf_path: path,
        ia_resumo: ia.obj?.resumo || null,
        ia_json: ia.obj || null,
        ia_em: new Date().toISOString(),
        erro: ia.ok ? null : (ia.err || "falha IA"),
        atualizado_em: new Date().toISOString(),
      }),
    });
    // 4) alimenta a sugestão de categoria do prazo aberto (sem sobrescrever decisão humana)
    const cat = ia.obj?.providencia;
    if (ia.ok && (cat === "custas" || cat === "documentos")) {
      try {
        await sb(`prazos?processo_id=eq.${row.processo_id}&cumprido=eq.false&or=(categoria_fonte.is.null,categoria_fonte.neq.humano)`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            categoria_sugerida: cat, categoria_confianca: "alta",
            categoria_motivo: ("autos IA: " + (ia.obj?.ultimo_ato || "")).slice(0, 120),
            categoria_ia_em: new Date().toISOString(),
          }),
        });
      } catch { /* prazo é bônus, ignora erro */ }
    }
  } catch (e) {
    await sb(`processo_autos?id=eq.${row.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "erro_ia", erro: String(e).slice(0, 300), atualizado_em: new Date().toISOString() }),
    }).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!API) return json({ erro: "sem LEGALMAIL_API_KEY" }, 500);
  let body: any = {}; try { body = await req.json(); } catch {}
  const action = String(body.action || "");
  const processoId = Number(body.processo_id || 0);
  if (!processoId) return json({ erro: "processo_id obrigatorio" }, 400);

  try {
    const { idp, numero } = await idprocessosDoProcesso(processoId);
    if (!idp) return json({ erro: "processo sem vínculo no Legal Mail (lm_idprocessos)", numero }, 400);
    const atual = await linhaAutos(processoId);

    if (action === "preview") {
      const n = await contarDocs(idp);
      return json({
        idprocessos: idp, numero, documentos: n, custo: +(n * CUSTO_DOC).toFixed(2),
        ja_baixado: atual?.status === "pronto",
        estado: atual?.status || null,
        resumo: atual?.ia_resumo || null,
      });
    }

    if (action === "request") {
      // ação PAGA: exige usuário logado (a publishable key é pública e não basta)
      if (!usuarioAutenticado(req)) return json({ erro: "faça login para puxar os autos" }, 401);
      // proteção contra cobrar 2x: se já existe job pronto ou em andamento, devolve o existente
      if (atual && (atual.status === "pronto" || atual.status === "processando" || atual.status === "baixando")) {
        return json({ reaproveitado: true, estado: atual.status, job_id: atual.job_id, documentos: atual.n_autos, custo: +((atual.n_autos || 0) * CUSTO_DOC).toFixed(2), resumo: atual.ia_resumo || null });
      }
      const n = await contarDocs(idp);
      const r = await fetch(`${BASE}/api/v1/lawsuit/case-files/download/request?api_key=${encodeURIComponent(API)}`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ idprocessos: idp }),
      });
      const rj = await r.json().catch(() => null);
      const jobId = rj?.job_id || null;
      const nAutos = rj?.autos ?? n;
      if (!r.ok || !jobId) return json({ erro: "falha ao solicitar download", http: r.status, body: rj }, 502);
      // grava/atualiza a linha
      if (atual) {
        await sb(`processo_autos?id=eq.${atual.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ job_id: jobId, status: "processando", n_autos: nAutos, erro: null, lm_idprocessos: idp, solicitado_por: callerEmail(req), atualizado_em: new Date().toISOString() }),
        });
      } else {
        await sb(`processo_autos`, {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ processo_id: processoId, lm_idprocessos: idp, job_id: jobId, status: "processando", n_autos: nAutos, solicitado_por: callerEmail(req) }),
        });
      }
      return json({ ok: true, job_id: jobId, documentos: nAutos, custo: +(nAutos * CUSTO_DOC).toFixed(2), estado: "processando" });
    }

    if (action === "status") {
      if (!atual) return json({ estado: "nenhum" });
      if (atual.status === "pronto") {
        return json({ estado: "pronto", resumo: atual.ia_resumo, ia: atual.ia_json, pdf: await urlAssinada(atual.pdf_path), documentos: atual.n_autos });
      }
      if (atual.status === "baixando") return json({ estado: "processando_ia", documentos: atual.n_autos });
      // consulta o job no Legal Mail (grátis)
      const u = `${BASE}/api/v1/lawsuit/case-files/download/status?api_key=${encodeURIComponent(API)}&idprocessos=${idp}${atual.job_id ? `&job_id=${encodeURIComponent(atual.job_id)}` : ""}`;
      const r = await fetch(u, { headers: { Accept: "application/json" } });
      const rj = await r.json().catch(() => null);
      const jobStatus = String(rj?.job_status || "").toUpperCase();
      const outputUrl = rj?.output_url || "";
      if (jobStatus === "COMPLETED" && outputUrl) {
        // "claim" atômico: só quem conseguir virar processando->baixando processa
        const claim = await sb(`processo_autos?id=eq.${atual.id}&status=eq.processando`, {
          method: "PATCH", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: "baixando", atualizado_em: new Date().toISOString() }),
        });
        if (Array.isArray(claim) && claim.length) {
          // roda pesado em background para não estourar o timeout do request
          (globalThis as any).EdgeRuntime?.waitUntil
            ? (globalThis as any).EdgeRuntime.waitUntil(processarConcluido(atual, outputUrl))
            : processarConcluido(atual, outputUrl);
          return json({ estado: "processando_ia", documentos: atual.n_autos });
        }
        return json({ estado: "processando_ia", documentos: atual.n_autos });
      }
      return json({ estado: "processando", job_status: jobStatus || "PROCESSING", documentos: atual.n_autos });
    }

    if (action === "get") {
      if (!atual) return json({ estado: "nenhum" });
      return json({ estado: atual.status, resumo: atual.ia_resumo, ia: atual.ia_json, documentos: atual.n_autos, pdf: atual.status === "pronto" ? await urlAssinada(atual.pdf_path) : null, erro: atual.erro });
    }

    return json({ erro: "action invalida (preview|request|status|get)" }, 400);
  } catch (e) {
    return json({ erro: String(e).slice(0, 400) }, 500);
  }
});
