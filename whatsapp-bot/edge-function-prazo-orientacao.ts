// Edge Function `prazo-orientacao` — o briefing do olhinho do prazo.
// Cópia versionada; o deploy é feito no Supabase.
//
// POR QUE EXISTE: o bloco "O QUE FAZER" dizia "Despacho/Decisão — ler a intimação para saber a
// providência", que é confissão de que o sistema não sabe. E não era falha da regra: de 167
// prazos com texto, só 3 têm verbo imperativo com prazo. Os 134 do Legal Mail são RECIBO da
// intimação ("Refer. ao Evento 65"), não o despacho. O teor está no evento referenciado e o DJEN
// publica esse evento inteiro — estava no banco, em outra linha, e o olhinho nunca procurou.
// Quem acha é a função SQL `prazo_ato_origem(prazo_id)`.
//
// *** GRÁTIS POR CONSTRUÇÃO: nenhuma chamada ao Legal Mail. Não acrescente uma aqui — o caminho
//     pago (R$ 0,02 pela peça) é a função `prazo-peca`, e só roda sob clique. ***
// Custo: só o Gemini, em cima de texto (~4 mil tokens), fração de centavo por prazo.
//
// *** A TRAVA: SEM TEOR, NÃO GERA PONTOS FORTES E FRACOS. ***
// Em 27 dos 163 prazos abertos o teor não está no banco. Inventar força e fraqueza a partir de um
// recibo de 400 caracteres seria repetir, num lugar pior, o erro do resumo que saiu escrito do
// lado do exequente quando o nosso cliente era o executado. Sem teor devolve sem_teor:true e NÃO
// chama o Gemini — não se paga token por resposta garantidamente vazia.
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
async function rpc(fn: string, args: unknown): Promise<any> {
  return await sb(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
}

// MESMO bloco das outras três funções (autos-ia, autos-anexo-ia, processo-chat), de propósito.
function blocoPolo(cliente: string | null, polo: string | null, papeis: string | null): string {
  const nome = cliente || "o cliente do escritório";
  if (!polo) {
    return [
      `QUEM NÓS REPRESENTAMOS: ${nome}. O POLO PROCESSUAL DELE NÃO ESTÁ IDENTIFICADO no sistema.`,
      "NÃO afirme de que lado estamos. Se a análise depender disso, diga que o polo não está identificado.",
    ].join(" ");
  }
  const extra = papeis && papeis !== polo ? ` (papéis já vistos neste processo: ${papeis})` : "";
  return [
    `QUEM NÓS REPRESENTAMOS: ${nome} — polo processual: ${polo}${extra}.`,
    "Analise SEMPRE do ponto de vista DESTE lado.",
    "Decisão contrária a ele é DERROTA NOSSA: o próximo passo é o recurso ou a medida cabível, com o prazo a conferir — NUNCA 'aguardar a preclusão' como se fosse a nossa estratégia.",
    "Pedido da parte adversa NÃO é pedido nosso; levantamento ou alvará em favor dela NÃO é providência nossa.",
    "Se o ato contradisser este polo, DIGA ISSO em vez de escolher um lado em silêncio.",
  ].join(" ");
}

const PROMPT = [
  "Você é advogado(a) do escritório Becker Advogados preparando o colega que vai cumprir ESTE prazo.",
  "Você recebe o TEOR DE UM ÚNICO ATO do processo (despacho, decisão ou ato ordinatório) e o aviso de intimação correspondente.",
  "Analise SOMENTE este ato. Você NÃO recebeu os autos completos nem o histórico do processo — não finja conhecer nenhum dos dois.",
  "Responda SOMENTE em JSON, com estas chaves:",
  '{',
  '"o_que_decidiu":"2 a 3 frases: o que este ato determinou ou decidiu, citando o número do evento quando o texto trouxer",',
  '"o_que_fazer":["providências concretas que o escritório precisa tomar por causa DESTE ato, do nosso lado, em frases curtas e imperativas"],',
  '"pontos_fortes":["o que neste ato está A NOSSO FAVOR: pedido nosso acolhido, prazo concedido, ônus posto na parte adversa, fundamento que nos serve"],',
  '"pontos_fracos":["o que neste ato está CONTRA NÓS: pedido nosso rejeitado, ônus ou exigência sobre nós, risco de preclusão, custo, fundamento que nos prejudica"],',
  '"prazo_no_texto":"o prazo que ESTE ato fixa para nós, como escrito (ex.: 15 dias), ou null",',
  '"evento":"número do evento a que este ato se refere, se o texto citar, ou null"',
  '}',
  "REGRAS DURAS:",
  "1) Não invente. Se o ato não der base para um item, devolva a lista VAZIA — lista vazia é resposta legítima e melhor que palpite.",
  "2) pontos_fortes e pontos_fracos são sobre ESTE ATO, não sobre a tese do processo nem sobre chance de êxito.",
  "3) Ato meramente ordinatório (distribuição, juntada, remessa) costuma não ter forte nem fraco: devolva as duas listas vazias em vez de forçar.",
  "4) No máximo 4 itens por lista, cada um com no máximo 20 palavras.",
  "5) Português direto, sem juridiquês desnecessário e sem repetir o texto do despacho.",
].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "faça login" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const prazoId = Number(body.prazo_id || 0);
  const refazer = body.refazer === true;
  if (!prazoId) return json({ erro: "prazo_id obrigatorio" }, 400);

  try {
    const zs = await sb(`prazos?id=eq.${prazoId}&select=id,data,status,legalmail_id,ia_orientacao,ia_orientacao_em,ia_teor_pub_id,processos(id,numero,polo_cliente,polo_papeis,clientes(nome))`);
    const z = Array.isArray(zs) ? zs[0] : null;
    if (!z) return json({ erro: "prazo nao encontrado" }, 404);

    // cache: da segunda abertura em diante não gasta nada
    if (!refazer && z.ia_orientacao) {
      return json({ ok: true, cache: true, em: z.ia_orientacao_em, teor_pub_id: z.ia_teor_pub_id, orientacao: z.ia_orientacao });
    }

    const atos = await rpc("prazo_ato_origem", { p_prazo_id: prazoId });
    const ato = Array.isArray(atos) && atos.length ? atos[0] : null;

    if (!ato?.teor) {
      // SEM TEOR: não chama o Gemini e não inventa análise.
      return json({
        ok: true, sem_teor: true,
        motivo: "A intimação deste prazo é o aviso do Legal Mail, que só aponta o evento e não traz o teor. O despacho não está no banco.",
        caminhos: [
          { tipo: "gratis", acao: "anexar_integra", texto: "Anexar a íntegra dos autos (grátis)" },
          { tipo: "pago", acao: "prazo-peca", custo: 0.02, texto: "Ler a peça referenciada — R$ 0,02" },
        ],
      });
    }

    if (!GKEY) return json({ erro: "sem GEMINI_API_KEY" }, 500);

    const p = z.processos || {};
    const polo = blocoPolo(p?.clientes?.nome || null, p?.polo_cliente || null, p?.polo_papeis || null);
    const ctx = [
      `PROCESSO: ${p?.numero || "—"}`,
      `DATA-LIMITE DO PRAZO NO NOSSO SISTEMA: ${z.data || "—"}`,
      ``,
      `TEOR DO ATO (${ato.ato_tipo || "ato"}, disponibilizado em ${ato.ato_data}${ato.origem === "vizinho" ? ", vinculado a este prazo por proximidade de data" : ""}):`,
      String(ato.teor).slice(0, 12000),
    ].join("\n");

    const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${PROMPT}\n\n${polo}\n\n===== ATO =====\n${ctx}\n===== FIM =====` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1600, responseMimeType: "application/json" },
      }),
    });
    if (!g.ok) return json({ erro: `gemini http ${g.status}` }, 502);
    const gj = await g.json().catch(() => null);
    let txt = (gj?.candidates?.[0]?.content?.parts || []).map((x: any) => x?.text || "").join("").trim();
    const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
    if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
    let obj: any = null; try { obj = JSON.parse(txt); } catch { /* */ }
    if (!obj) return json({ erro: "json invalido da IA" }, 502);

    // o limite é FIXO, escrito por nós — não é a IA que decide se avisa
    obj.limite = "Leitura deste ato, não da tese do processo. Confira nos autos antes de agir.";
    obj.ato = { pub_id: ato.pub_id, tipo: ato.ato_tipo, data: ato.ato_data,
                dias_do_aviso: ato.dias, origem: ato.origem, provavel: ato.origem === "vizinho" };

    await sb(`prazos?id=eq.${prazoId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ia_orientacao: obj, ia_orientacao_em: new Date().toISOString(), ia_teor_pub_id: ato.pub_id }),
    });

    return json({ ok: true, cache: false, teor_pub_id: ato.pub_id, orientacao: obj,
                  teor: String(ato.teor).slice(0, 4000) });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
