// Edge Function `processo-chat` — chat de perguntas sobre UM processo, respondido pela IA.
// Usa o contexto já disponível (dados cadastrais + resumo dos autos por IA, se houver +
// movimentações + prazos). NÃO baixa autos (não gasta) e funciona mesmo sem autos puxados.
// Fica ancorado no contexto: se a resposta não estiver ali, diz que "não consta" — não inventa.
// Auth: verify_jwt=true (só usuário logado). Lê o banco com service role.
// Segredos: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (+ GEMINI_MODEL).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";

const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, st = 200) =>
  new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

async function sb(path: string): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbH });
  const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (!r.ok) throw new Error(`sb ${path} ${r.status}`);
  return j;
}

function usuarioAutenticado(req: Request): boolean {
  try {
    const tk = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    return JSON.parse(atob(tk.split(".")[1] || ""))?.role === "authenticated";
  } catch { return false; }
}

function _lista(arr: any[], f: (r: any) => string, max = 30): string {
  if (!Array.isArray(arr) || !arr.length) return "(nenhum)";
  return arr.slice(0, max).map(f).join("\n");
}

async function contextoProcesso(processoId: number): Promise<string> {
  const rows = await sb(`processos?id=eq.${processoId}&select=numero,tribunal,vara,comarca,classe_processual,assunto,parte_contraria,advogado_responsavel,situacao,clientes(nome,cpf_cnpj)`);
  const p = Array.isArray(rows) ? rows[0] : null;
  const arow = await sb(`processo_autos?processo_id=eq.${processoId}&select=ia_json,ia_resumo&order=criado_em.desc&limit=1`).catch(() => []);
  const autos = Array.isArray(arow) && arow.length ? arow[0] : null;
  const movs = await sb(`movimentacoes?processo_id=eq.${processoId}&select=data,descricao,tipo&order=data.desc&limit=30`).catch(() => []);
  const prazos = await sb(`prazos?processo_id=eq.${processoId}&cumprido=eq.false&select=data,descricao,categoria,status&order=data.asc&limit=20`).catch(() => []);
  const ia = autos?.ia_json || null;
  let bloco = `DADOS DO PROCESSO:\n` + [
    `Número CNJ: ${p?.numero || "—"}`,
    `Cliente: ${p?.clientes?.nome || "—"}`,
    `Parte contrária: ${p?.parte_contraria || "—"}`,
    `Classe: ${p?.classe_processual || "—"}`,
    `Assunto: ${p?.assunto || "—"}`,
    `Tribunal/Vara/Comarca: ${[p?.tribunal, p?.vara, p?.comarca].filter(Boolean).join(" · ") || "—"}`,
    `Responsável: ${p?.advogado_responsavel || "—"}`,
    `Situação: ${p?.situacao || "—"}`,
  ].join("\n") + "\n";
  if (ia) {
    bloco += `\nRESUMO DOS AUTOS (gerado por IA a partir da íntegra):\n`;
    if (ia.resumo) bloco += `Visão geral: ${ia.resumo}\n`;
    if (ia.situacao_atual) bloco += `Situação atual: ${ia.situacao_atual}\n`;
    if (ia.ultimo_ato) bloco += `Último ato: ${ia.ultimo_ato}\n`;
    if (Array.isArray(ia.historico) && ia.historico.length) bloco += `Histórico:\n- ${ia.historico.join("\n- ")}\n`;
    if (Array.isArray(ia.o_que_fazer) && ia.o_que_fazer.length) bloco += `O que fazer:\n- ${ia.o_que_fazer.join("\n- ")}\n`;
    if (Array.isArray(ia.pontos_atencao) && ia.pontos_atencao.length) bloco += `Pontos de atenção:\n- ${ia.pontos_atencao.join("\n- ")}\n`;
    if (ia.estrategia) bloco += `Estratégia: ${ia.estrategia}\n`;
  } else if (autos?.ia_resumo) {
    bloco += `\nRESUMO DOS AUTOS:\n${autos.ia_resumo}\n`;
  } else {
    bloco += `\n(Os autos ainda não foram puxados/analisados por IA para este processo.)\n`;
  }
  bloco += `\nMOVIMENTAÇÕES RECENTES (mais novas primeiro):\n${_lista(movs, (m) => `- ${m.data || "s/data"}: ${(m.descricao || "").slice(0, 160)}`)}\n`;
  bloco += `\nPRAZOS EM ABERTO:\n${_lista(prazos, (z) => `- ${z.data || "s/data"}: ${(z.descricao || "").slice(0, 120)}${z.categoria && z.categoria !== "geral" ? ` [${z.categoria}]` : ""}`)}\n`;
  return bloco.slice(0, 14000);
}

const PROMPT_CHAT = [
  "Você é assistente jurídico do escritório Becker Advogados, respondendo perguntas de um(a) advogado(a) SOBRE UM PROCESSO específico.",
  "Responda usando SOMENTE as informações do CONTEXTO fornecido (dados cadastrais, resumo dos autos, movimentações e prazos).",
  "Se a resposta não estiver no contexto, diga com clareza que essa informação não consta no que está registrado no sistema e sugira abrir a íntegra dos autos (PDF) para confirmar.",
  "NUNCA invente fatos, valores, datas, números de processo ou jurisprudência. É melhor dizer 'não consta' do que arriscar.",
  "Português claro e direto. Pode usar tópicos quando ajudar. Seja conciso.",
].join(" ");

async function responder(processoId: number, pergunta: string, historico: any[]): Promise<{ ok: boolean, resposta?: string, err?: string }> {
  if (!GKEY) return { ok: false, err: "sem GEMINI_API_KEY" };
  const ctx = await contextoProcesso(processoId);
  const contents: any[] = [{ role: "user", parts: [{ text: `${PROMPT_CHAT}\n\n===== CONTEXTO DO PROCESSO =====\n${ctx}\n===== FIM DO CONTEXTO =====` }] }];
  for (const h of (Array.isArray(historico) ? historico.slice(-6) : [])) {
    const role = h?.role === "assistant" ? "model" : "user";
    const t = String(h?.texto || h?.text || "").slice(0, 2000);
    if (t) contents.push({ role, parts: [{ text: t }] });
  }
  contents.push({ role: "user", parts: [{ text: `PERGUNTA: ${String(pergunta).slice(0, 2000)}` }] });
  const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: { temperature: 0.2, maxOutputTokens: 1400 } }),
  });
  if (!g.ok) return { ok: false, err: `gemini http ${g.status}` };
  const j = await g.json().catch(() => null);
  const txt = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
  return txt ? { ok: true, resposta: txt } : { ok: false, err: "sem resposta" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "faça login" }, 401);
  let body: any = {}; try { body = await req.json(); } catch {}
  const processoId = Number(body.processo_id || 0);
  const pergunta = String(body.pergunta || "").trim();
  if (!processoId) return json({ erro: "processo_id obrigatorio" }, 400);
  if (!pergunta) return json({ erro: "pergunta vazia" }, 400);
  try {
    const r = await responder(processoId, pergunta, body.historico || []);
    if (!r.ok) return json({ erro: r.err || "falha da IA" }, 502);
    return json({ ok: true, resposta: r.resposta });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
