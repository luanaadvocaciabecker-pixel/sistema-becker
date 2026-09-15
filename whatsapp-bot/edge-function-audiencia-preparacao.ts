// Edge Function `audiencia-preparacao` — o briefing do olhinho da audiência.
// Cópia versionada; o deploy é feito no Supabase.
//
// POR QUE EXISTE: ela pediu um olhinho na Audiências igual ao de Prazos, mas focado em
// PREPARAÇÃO da audiência (o que levar, como se preparar), não em pontos a favor/contra como
// no prazo-orientacao — confirmado com ela antes de escrever isto.
//
// *** GRÁTIS POR CONSTRUÇÃO: nenhuma chamada ao Legal Mail. Só lê audiencias+processos já
//     guardados no banco. ***
// Custo: só o Gemini, em cima de texto curto, fração de centavo por audiência.
//
// *** A TRAVA: SEM PROCESSO COM ASSUNTO, NÃO GERA PREPARO ESPECÍFICO. ***
// Sem o assunto/contexto do caso, "preparar" viraria genérico ou inventado — devolve
// sem_processo:true e NÃO chama o Gemini, mesmo espírito do sem_teor do prazo-orientacao.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

function usuarioAutenticado(req: Request): boolean {
  try {
    const tk = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    return JSON.parse(atob(tk.split(".")[1] || ""))?.role === "authenticated";
  } catch { return false; }
}
async function sb(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

// MESMO bloco usado em prazo-orientacao/autos-ia/autos-anexo-ia/processo-chat, de propósito.
function blocoPolo(cliente: string | null, polo: string | null, papeis: string | null): string {
  const nome = cliente || "o cliente do escritório";
  if (!polo) {
    return [
      `QUEM NÓS REPRESENTAMOS: ${nome}. O POLO PROCESSUAL DELE NÃO ESTÁ IDENTIFICADO no sistema.`,
      "NÃO afirme de que lado estamos. Se a orientação depender disso, diga que o polo não está identificado.",
    ].join(" ");
  }
  const extra = papeis && papeis !== polo ? ` (papéis já vistos neste processo: ${papeis})` : "";
  return [
    `QUEM NÓS REPRESENTAMOS: ${nome} — polo processual: ${polo}${extra}.`,
    "Prepare SEMPRE do ponto de vista DESTE lado.",
  ].join(" ");
}

const PROMPT = [
  "Você é advogado(a) do escritório Becker Advogados ajudando o colega a se PREPARAR para uma audiência.",
  "Você recebe o tipo de audiência e os dados já cadastrados do processo (assunto, classe, partes). Você NÃO recebe os autos completos nem o histórico de movimentações — não finja conhecer nenhum dos dois.",
  "Responda SOMENTE em JSON, com estas chaves:",
  '{',
  '"o_que_e":"2 a 3 frases explicando o que é este tipo de audiência e o que costuma acontecer nela",',
  '"objetivo":"1 a 2 frases sobre o que esta audiência busca provar ou decidir processualmente, com base no assunto/classe do processo — string vazia se não houver base pra isso",',
  '"o_que_levar":["documentos ou materiais concretos a levar, específicos deste caso quando possível"],',
  '"o_que_preparar":["ações de preparo antes da audiência: o que revisar, o que alinhar com o cliente, testemunhas a preparar"],',
  '"pontos_atencao":["cuidados ou riscos específicos deste caso a observar na condução da audiência"]',
  '}',
  "REGRAS DURAS:",
  "1) Não invente fatos do processo que não foram passados a você. Se não houver base pra um item, devolva a lista VAZIA — lista vazia é resposta legítima e melhor que palpite genérico.",
  "2) Nada de pontos a favor/contra nem de prognóstico de resultado — isso não foi pedido aqui, é só preparação prática.",
  "3) No máximo 4 itens por lista, cada um com no máximo 20 palavras.",
  "4) Português direto, sem juridiquês desnecessário.",
].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "faça login" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const audienciaId = Number(body.audiencia_id || 0);
  const refazer = body.refazer === true;
  if (!audienciaId) return json({ erro: "audiencia_id obrigatorio" }, 400);

  try {
    const as = await sb(`audiencias?id=eq.${audienciaId}&select=id,data,hora,tipo,local,observacoes,ia_preparacao,ia_preparacao_em,processos(id,numero,assunto,classe_processual,vara,comarca,parte_contraria,polo_cliente,polo_papeis,situacao,clientes(nome))`);
    const a = Array.isArray(as) ? as[0] : null;
    if (!a) return json({ erro: "audiencia nao encontrada" }, 404);

    // cache: da segunda abertura em diante não gasta nada
    if (!refazer && a.ia_preparacao) {
      return json({ ok: true, cache: true, em: a.ia_preparacao_em, preparacao: a.ia_preparacao });
    }

    const p = a.processos || null;
    if (!p?.assunto) {
      // SEM PROCESSO/ASSUNTO: não chama o Gemini e não inventa preparo específico.
      return json({
        ok: true, sem_processo: true,
        motivo: p
          ? "Este processo ainda não tem o campo 'assunto' preenchido — sem esse contexto mínimo do caso não dá pra montar uma preparação específica."
          : "Esta audiência não está vinculada a um processo cadastrado — sem os dados do caso não dá pra montar uma preparação específica, só o tipo de audiência em geral.",
      });
    }

    if (!GKEY) return json({ erro: "sem GEMINI_API_KEY" }, 500);

    const polo = blocoPolo(p?.clientes?.nome || null, p?.polo_cliente || null, p?.polo_papeis || null);
    const ctx = [
      `TIPO DE AUDIÊNCIA: ${a.tipo || "—"}`,
      `DATA/HORA: ${a.data || "—"}${a.hora ? " às " + a.hora : ""}`,
      `LOCAL: ${a.local || "—"}`,
      a.observacoes ? `OBSERVAÇÕES JÁ CADASTRADAS: ${a.observacoes}` : "",
      ``,
      `PROCESSO: ${p?.numero || "—"}`,
      `CLASSE: ${p?.classe_processual || "—"}`,
      `ASSUNTO: ${p?.assunto || "—"}`,
      `VARA/COMARCA: ${[p?.vara, p?.comarca].filter(Boolean).join(" · ") || "—"}`,
      `PARTE CONTRÁRIA: ${p?.parte_contraria || "—"}`,
      `SITUAÇÃO DO PROCESSO: ${p?.situacao || "—"}`,
    ].filter(Boolean).join("\n");

    const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${PROMPT}\n\n${polo}\n\n===== DADOS =====\n${ctx}\n===== FIM =====` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1200, responseMimeType: "application/json" },
      }),
    });
    if (!g.ok) return json({ erro: `gemini http ${g.status}` }, 502);
    const gj = await g.json().catch(() => null);
    let txt = (gj?.candidates?.[0]?.content?.parts || []).map((x: any) => x?.text || "").join("").trim();
    const ai = txt.indexOf("{"), bi = txt.lastIndexOf("}");
    if (ai >= 0 && bi > ai) txt = txt.slice(ai, bi + 1);
    let obj: any = null; try { obj = JSON.parse(txt); } catch { /* */ }
    if (!obj) return json({ erro: "json invalido da IA" }, 502);

    obj.limite = "Preparação com base nos dados cadastrados do processo. Confira nos autos antes da audiência.";

    await sb(`audiencias?id=eq.${audienciaId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ia_preparacao: obj, ia_preparacao_em: new Date().toISOString() }),
    });

    return json({ ok: true, cache: false, preparacao: obj });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
