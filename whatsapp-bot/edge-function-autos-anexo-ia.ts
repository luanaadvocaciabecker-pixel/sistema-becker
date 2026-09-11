// Edge Function `autos-anexo-ia` — a IA lê a ÍNTEGRA ANEXADA À MÃO no processo.
//
// POR QUE EXISTE: a Luana anexou a íntegra (6,2 MB) e perguntou, com razão, por que ainda
// pagaria o download dos autos. O `autos-ia` sabia ler PDF do storage, mas só o do download
// pago — a íntegra anexada ficava como arquivo morto na lista de documentos.
//
// POR QUE É UMA FUNÇÃO SEPARADA, e não uma ação dentro do autos-ia:
// o autos-ia é o código que GASTA (R$ 0,02 por documento no download do Legal Mail). Mexer nele
// para acrescentar um recurso grátis é risco desnecessário. Esta função NÃO TEM nenhuma chamada
// ao Legal Mail — nem case-files, nem download/request. É estruturalmente incapaz de gerar
// cobrança. NÃO acrescente uma aqui: se precisar do caminho pago, ele já existe no autos-ia.
//
// Custo: só a chamada do Gemini. Exige login (lê documento de cliente e gasta token de IA).
// Segredos: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (+ GEMINI_MODEL).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";
const BUCKET = "documentos-clientes";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

function usuarioAutenticado(req: Request): boolean {
  try {
    const tk = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    return JSON.parse(atob(tk.split(".")[1] || ""))?.role === "authenticated";
  } catch { return false; }
}
function emailChamador(req: Request): string | null {
  try {
    const tk = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    return JSON.parse(atob(tk.split(".")[1] || ""))?.email || null;
  } catch { return null; }
}
async function sb(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}
// Assina com o service role em vez de usar a URL pública. O bucket documentos-clientes está
// público hoje, o que é um problema à parte — assinando, este recurso continua funcionando
// quando ele for fechado.
async function urlAssinada(path: string): Promise<string | null> {
  const r = await fetch(`${SB}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST", headers: sbH, body: JSON.stringify({ expiresIn: 3600 }),
  });
  const j = await r.json().catch(() => null);
  return j?.signedURL ? `${SB}/storage/v1${j.signedURL}` : null;
}

// Sobe o PDF pela File API do Gemini — é o que aguenta arquivo grande (a íntegra tem 6,2 MB;
// mandar inline em base64 estouraria o limite do corpo da requisição).
async function subirPdf(bytes: Uint8Array): Promise<string | null> {
  const ini = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GKEY)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": "application/pdf", "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "integra.pdf" } }),
  });
  const up = ini.headers.get("x-goog-upload-url");
  if (!up) return null;
  const fin = await fetch(up, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Length": String(bytes.length) },
    body: bytes,
  });
  const j = await fin.json().catch(() => ({} as any));
  let uri = j?.file?.uri, name = j?.file?.name, state = j?.file?.state;
  // O arquivo grande fica em PROCESSING por alguns segundos; sem esperar, o generateContent falha.
  for (let i = 0; i < 30 && state && state !== "ACTIVE"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(GKEY)}`);
    const sj = await s.json().catch(() => ({} as any)); state = sj?.state; uri = sj?.uri || uri;
  }
  return state === "ACTIVE" ? uri : null;
}

// De que LADO nós estamos. Sem isto, o modelo adota o protagonista dos documentos: no processo
// 6618 ele escreveu a estratégia do EXEQUENTE quando o nosso cliente é o EXECUTADO, e mandou
// "aguardar a preclusão" de uma decisão contra nós cujo prazo vencia naquele dia. Não era
// alucinação — era ausência de instrução. O polo vem de processos.polo_cliente, deduzido do
// texto da própria intimação (becker_deriva_polo).
function blocoPolo(cliente: string | null, polo: string | null, papeis: string | null): string {
  const nome = cliente || "o cliente do escritório";
  if (!polo) {
    return [
      `QUEM NÓS REPRESENTAMOS: ${nome}. O POLO PROCESSUAL DELE NÃO ESTÁ IDENTIFICADO no sistema.`,
      "NÃO afirme de que lado estamos e NÃO escreva estratégia como se soubesse.",
      "Diga no primeiro item de pontos_atencao que o polo não está identificado e precisa ser conferido nos autos.",
    ].join(" ");
  }
  const extra = papeis && papeis !== polo ? ` (papéis já vistos neste processo: ${papeis})` : "";
  return [
    `QUEM NÓS REPRESENTAMOS: ${nome} — polo processual: ${polo}${extra}.`,
    "Escreva SEMPRE do ponto de vista DESTE lado.",
    "Decisão contrária a ele é DERROTA NOSSA: nesse caso o próximo passo é o recurso ou a medida cabível, com o prazo a conferir — NUNCA 'aguardar a preclusão'.",
    "Pedido formulado pela parte adversa NÃO é pedido nosso; levantamento ou alvará em favor dela NÃO é providência nossa.",
    "Se os autos contradisserem este polo, DIGA ISSO no primeiro item de pontos_atencao — não escolha um lado em silêncio.",
  ].join(" ");
}

// Converte 'YYYY-MM-DD' (formato do banco) para 'DD/MM/AAAA'. MESMO BLOCO do autos-ia, de propósito.
function dataBR(d: string | null | undefined): string | null {
  if (!d) return null;
  const [a, m, dd] = String(d).split("-");
  return dd && m && a ? `${dd}/${m}/${a}` : null;
}

// Os PRAZOS deste processo que o sistema JÁ TEM — vêm do tribunal (Legal Mail) ou do cálculo do
// DJEN, não da leitura do PDF inteiro. MESMO BLOCO do autos-ia, de propósito.
async function blocoPrazos(processoId: number): Promise<string> {
  try {
    const r = await sb(`prazos?processo_id=eq.${processoId}&select=data,cumprido,descricao&order=data.desc&limit=8`);
    const lst: any[] = Array.isArray(r) ? r : [];
    if (!lst.length) return "PRAZOS JÁ CADASTRADOS NO SISTEMA: nenhum para este processo.";
    const linhas = lst.map((p) => `- ${dataBR(p.data)} · ${p.cumprido ? "cumprido" : "EM ABERTO"} · ${p.descricao || ""}`).join("\n");
    return [
      "PRAZOS JÁ CADASTRADOS NO SISTEMA (datas conferidas com o tribunal — prefira estes valores a qualquer cálculo seu sobre o texto):",
      linhas,
      "Se o texto dos autos sugerir prazo ou data diferente do que está aqui, diga isso em pontos_atencao — não escolha um valor em silêncio.",
    ].join("\n");
  } catch {
    return "PRAZOS JÁ CADASTRADOS NO SISTEMA: não foi possível consultar agora.";
  }
}

// Corrige data_final/prazo_dias com o prazo que o sistema JÁ TEM. MESMO BLOCO do autos-ia, de
// propósito — achado em 10/09/2026 (ver o comentário lá): 2 de 7 resumos gravados saíram com
// data_final:null para processo que já tinha prazo aberto com data OFICIAL do tribunal no banco.
// NUNCA inventa prazo: só age quando existe um prazo aberto de verdade no sistema.
async function corrigeComPrazoDoSistema(obj: any, processoId: number): Promise<any> {
  if (!obj) return obj;
  try {
    const r = await sb(`prazos?processo_id=eq.${processoId}&cumprido=eq.false&select=data,descricao&order=data.asc&limit=1`);
    const p = Array.isArray(r) && r[0] ? r[0] : null;
    if (!p) return obj; // sem prazo aberto no sistema: mantém o que a IA leu
    const dataSistema = dataBR(p.data);
    const diasMatch = String(p.descricao || "").match(/\((\d+)\s*dias?\)/) || String(p.descricao || "").match(/\+(\d+)\s*dias\s*úteis/);
    const diasSistema = diasMatch ? parseInt(diasMatch[1], 10) : null;
    const dataIA = obj.data_final && obj.data_final !== "null" ? obj.data_final : null;
    const divergiu = dataIA && dataIA !== dataSistema;
    obj.data_final = dataSistema;
    if (diasSistema != null) obj.prazo_dias = diasSistema;
    if (divergiu) {
      obj.pontos_atencao = Array.isArray(obj.pontos_atencao) ? obj.pontos_atencao : [];
      obj.pontos_atencao.unshift(
        `⚠️ A leitura do PDF sugeriu data final ${dataIA}, mas o sistema tem ${dataSistema} confirmado com o tribunal (prazo já cadastrado) — usando o do sistema. Confira.`
      );
    }
    return obj;
  } catch { return obj; } // consulta falhou: nunca quebra o fluxo por causa da correção
}

// Mesmo prompt do autos-ia, de propósito: o resumo tem de sair igual, venha do download pago ou
// da íntegra anexada. Se um dia mudar lá, mudar aqui também.
const PROMPT = [
  "Você é advogado(a) analisando os autos COMPLETOS de um processo judicial brasileiro (documentos do mais recente ao mais antigo).",
  "Produza um resumo executivo ÚTIL para a equipe do escritório. Foque no último ato decisório, mas também recupere a trajetória do processo.",
  "Responda SOMENTE em JSON, com estas chaves:",
  '{',
  '"providencia":"custas|documentos|geral",',
  '"prazo_dias":<inteiro ou null>,',
  '"data_final":"DD/MM/AAAA ou null",',
  '"ultimo_ato":"título curto do último ato",',
  '"resumo":"1-2 frases de visão geral (em que pé está o processo)",',
  '"situacao_atual":"a fase atual do processo em 1 frase",',
  '"historico":["marcos/decisões relevantes do mais recente ao mais antigo, frases curtas"],',
  '"o_que_fazer":["providências concretas que o escritório precisa tomar agora, frases curtas"],',
  '"pontos_atencao":["riscos, prazos, custas, valores ou detalhes que exigem atenção"],',
  '"estrategia":"1-3 frases de recomendação estratégica (teses, recursos cabíveis, próximo passo sugerido) — só se houver base nos autos"',
  '}',
  "'custas' = precisa recolher custas/preparo/porte/GRU/taxa. 'documentos' = precisa juntar/apresentar documento/procuração/comprovante. 'geral' = qualquer outra.",
  "REGRAS: não invente fatos, números de processo, valores, datas ou jurisprudência. Se algo não estiver nos autos, omita o item (não preencha com suposição). Se o ato não fixa prazo para o escritório, use prazo_dias e data_final null. Se houver um bloco 'PRAZOS JÁ CADASTRADOS NO SISTEMA', ele é mais confiável que sua leitura do texto — use os valores dele. Português claro, sem juridiquês desnecessário. Cada lista com no máximo 6 itens.",
].join(" ");

async function lerComIA(pdfUrl: string, polo: string, processoId: number): Promise<{ ok: boolean, mb: number, obj: any, err?: string }> {
  const pr = await fetch(pdfUrl);
  if (!pr.ok) return { ok: false, mb: 0, obj: null, err: `pdf http ${pr.status}` };
  const buf = new Uint8Array(await pr.arrayBuffer());
  const mb = +(buf.length / 1048576).toFixed(1);
  const uri = await subirPdf(buf);
  if (!uri) return { ok: false, mb, obj: null, err: "upload/ACTIVE falhou" };
  const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ fileData: { fileUri: uri, mimeType: "application/pdf" } }, { text: `${polo}\n\n${await blocoPrazos(processoId)}\n\n${PROMPT}` }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 3200, responseMimeType: "application/json" },
    }),
  });
  if (!g.ok) return { ok: false, mb, obj: null, err: `gemini http ${g.status}` };
  const j = await g.json().catch(() => null);
  let txt = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
  const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
  if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
  let obj: any = null; try { obj = JSON.parse(txt); } catch { /* deixa null */ }
  if (obj) obj = await corrigeComPrazoDoSistema(obj, processoId);
  return { ok: !!obj, mb, obj, err: obj ? undefined : "json invalido" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "faça login" }, 401);
  if (!GKEY) return json({ erro: "sem GEMINI_API_KEY" }, 500);

  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const processoId = Number(body.processo_id || 0);
  if (!processoId) return json({ erro: "informe processo_id" }, 400);
  const action = String(body.action || "resumir");

  try {
    const docId = Number(body.documento_id || 0);
    const docs = await sb(`documentos?processo_id=eq.${processoId}${docId ? `&id=eq.${docId}` : ""}&select=id,nome,url,tamanho,created_at&order=created_at.desc&limit=20`);
    const pdfs = (Array.isArray(docs) ? docs : []).filter((d: any) => /\.pdf$/i.test(String(d?.nome || "")));

    // Só lista, não gasta nada — a tela usa para decidir se oferece o botão grátis.
    if (action === "listar") {
      const linhas = await sb(`processo_autos?processo_id=eq.${processoId}&fonte=eq.anexo&select=documento_id,ia_em,ia_resumo&limit=1`);
      const ja = Array.isArray(linhas) ? linhas[0] : null;
      return json({
        ok: true,
        anexos: pdfs.map((d: any) => ({ id: d.id, nome: d.nome, mb: +(Number(d.tamanho || 0) / 1048576).toFixed(1), em: d.created_at })),
        ja_resumido: ja ? { documento_id: ja.documento_id, em: ja.ia_em, resumo: ja.ia_resumo } : null,
      });
    }

    if (action !== "resumir") return json({ erro: "action invalida (listar|resumir)" }, 400);
    const doc = pdfs[0];
    if (!doc) return json({ erro: "não há PDF anexado neste processo" }, 400);

    // Só aceita arquivo do NOSSO storage. A url é montada pelo uploadDocProcesso e aponta para
    // documentos-clientes; qualquer outra coisa é recusada, para a função não virar um buscador
    // de url arbitrária de terceiro.
    const m = String(doc.url || "").match(/\/documentos-clientes\/(.+)$/);
    if (!m) return json({ erro: "anexo fora do storage do sistema" }, 400);
    const assinada = await urlAssinada(decodeURIComponent(m[1]));
    if (!assinada) return json({ erro: "falha ao acessar o anexo" }, 502);

    const prs = await sb(`processos?id=eq.${processoId}&select=polo_cliente,polo_papeis,clientes(nome)`);
    const pr0 = Array.isArray(prs) ? prs[0] : null;
    const polo = blocoPolo(pr0?.clientes?.nome || null, pr0?.polo_cliente || null, pr0?.polo_papeis || null);

    const ia = await lerComIA(assinada, polo, processoId);
    if (!ia.ok) return json({ erro: ia.err || "falha da IA", mb: ia.mb }, 502);

    // Grava com fonte='anexo' e SEM tocar em n_autos/job_id/pdf_path, que pertencem ao caminho
    // pago. Assim o preview do autos-ia não passa a dizer que os autos foram baixados.
    const reg = {
      processo_id: processoId, fonte: "anexo", documento_id: doc.id, status: "pronto",
      ia_resumo: ia.obj?.resumo || null, ia_json: ia.obj || null,
      ia_em: new Date().toISOString(), atualizado_em: new Date().toISOString(),
      solicitado_por: emailChamador(req), erro: null,
    };
    const linhas = await sb(`processo_autos?processo_id=eq.${processoId}&fonte=eq.anexo&select=id&limit=1`);
    const ja = Array.isArray(linhas) ? linhas[0] : null;
    if (ja?.id) await sb(`processo_autos?id=eq.${ja.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(reg) });
    else await sb(`processo_autos`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ ...reg, criado_em: new Date().toISOString() }]) });

    // Mesmo bônus do caminho pago: sugere a categoria do prazo em aberto, sem sobrescrever
    // categoria já confirmada por humano.
    const cat = ia.obj?.providencia;
    if (cat === "custas" || cat === "documentos") {
      try {
        await sb(`prazos?processo_id=eq.${processoId}&cumprido=eq.false&or=(categoria_fonte.is.null,categoria_fonte.neq.humano)`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ categoria_sugerida: cat, categoria_confianca: "alta", categoria_motivo: ("íntegra anexada, IA: " + (ia.obj?.ultimo_ato || "")).slice(0, 120), categoria_ia_em: new Date().toISOString() }),
        });
      } catch { /* bônus, não quebra o fluxo */ }
    }
    return json({ ok: true, fonte: "anexo", anexo: { id: doc.id, nome: doc.nome, mb: ia.mb }, resumo: ia.obj?.resumo, ia: ia.obj });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
