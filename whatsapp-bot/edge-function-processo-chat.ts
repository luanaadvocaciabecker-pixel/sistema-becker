// Edge Function `processo-chat` — chat de perguntas sobre UM processo, respondido pela IA.
//
// O QUE ELA LÊ (em ordem de valor):
//   1. o POLO do nosso cliente (processos.polo_cliente) — de que lado estamos;
//   2. a ÍNTEGRA dos autos em PDF, quando existe, mandada inteira para a File API do Gemini;
//   3. o TEXTO DA INTIMAÇÃO de cada prazo em aberto (publicacoes.texto via prazos.legalmail_id);
//   4. dados cadastrais, resumo por IA (quando houver), movimentações.
//
// POR QUE ASSIM. A versão anterior mandava só o resumo de 200 palavras e o boilerplate
// "CLIENTE · TJSC — Prazo (15 dias)", e ainda tinha no prompt uma ordem FIXA de "sugira abrir a
// íntegra dos autos (PDF)". Resultado: a Luana levou duas vezes a sugestão de abrir o PDF que ela
// mesma tinha acabado de anexar, e a resposta "o contexto não especifica qual é o ato" — que era
// verdade, o contexto realmente não especificava. As três coisas que faltavam já estavam no banco.
//
// NÃO baixa autos do Legal Mail (não gasta R$ 0,02/documento). O único custo é o Gemini.
// MEDIDO no processo 6618 (242 páginas, 9,1 MB): 129.457 tokens de ENTRADA por pergunta, ~R$ 0,07
// no gemini-flash-lite. Eu havia estimado 258 tokens/página (~R$ 0,03) e é mais do que o dobro —
// os autos têm imagem, não só texto. Baixar esses mesmos autos pelo Legal Mail custaria R$ 4,84.
// O cache do fileUri economiza TEMPO (27,5s -> 6s), não tokens: a entrada é recontada sempre.
// Auth: verify_jwt=true (só usuário logado). Lê o banco com service role.
// Segredos: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (+ GEMINI_MODEL).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";

// Acima disto não manda o PDF: o limite do Gemini é 1.000 páginas, e autos gigantes atrasariam
// toda pergunta. Quando bate a trava, a resposta DIZ que não leu — silêncio aqui viraria um
// "não consta" mentiroso.
const MAX_MB = 40;

const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, st = 200) =>
  new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

async function sb(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
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

// ── De que LADO nós estamos ───────────────────────────────────────────────────────────────────
// Mesmo bloco do autos-ia e do autos-anexo-ia, de propósito. Ver o comentário de lá: o resumo do
// processo 6618 saiu com a estratégia do EXEQUENTE quando o nosso cliente é o EXECUTADO, porque
// nenhum prompt dizia o lado.
function blocoPolo(cliente: string | null, polo: string | null, papeis: string | null): string {
  const nome = cliente || "o cliente do escritório";
  if (!polo) {
    return [
      `QUEM NÓS REPRESENTAMOS: ${nome}. O POLO PROCESSUAL DELE NÃO ESTÁ IDENTIFICADO no sistema.`,
      "NÃO afirme de que lado estamos. Se a pergunta depender disso, diga que o polo não está identificado.",
    ].join(" ");
  }
  const extra = papeis && papeis !== polo ? ` (papéis já vistos neste processo: ${papeis})` : "";
  return [
    `QUEM NÓS REPRESENTAMOS: ${nome} — polo processual: ${polo}${extra}.`,
    "Responda SEMPRE do ponto de vista DESTE lado.",
    "Decisão contrária a ele é DERROTA NOSSA: o próximo passo é o recurso ou a medida cabível, com o prazo a conferir — NUNCA 'aguardar a preclusão'.",
    "Pedido da parte adversa NÃO é pedido nosso; levantamento ou alvará em favor dela NÃO é providência nossa.",
    "Se os autos contradisserem este polo, DIGA ISSO na resposta — não escolha um lado em silêncio.",
  ].join(" ");
}

// ── A íntegra: achar, assinar, subir (com cache) ──────────────────────────────────────────────
type Integra = { tabela: "documentos" | "processo_autos"; id: number; nome: string;
                 bucket: string; path: string; quando: number; paginas: number | null;
                 uri: string | null; expira: string | null };

// Escolhe a íntegra MAIS RECENTE entre a anexada à mão (documentos-clientes) e a do download
// pago (bucket autos) — se houver as duas, vale a mais nova, porque é a que tem a peça de hoje.
async function acharIntegra(processoId: number): Promise<Integra | null> {
  const cand: Integra[] = [];

  const docs = await sb(`documentos?processo_id=eq.${processoId}&select=id,nome,url,created_at,gemini_uri,gemini_expira,paginas&order=created_at.desc&limit=20`).catch(() => []);
  for (const d of (Array.isArray(docs) ? docs : [])) {
    if (!/\.pdf$/i.test(String(d?.nome || ""))) continue;
    const m = String(d.url || "").match(/\/documentos-clientes\/(.+)$/);
    if (!m) continue; // só arquivo do NOSSO storage — a função não vira buscador de url de terceiro
    cand.push({ tabela: "documentos", id: d.id, nome: String(d.nome), bucket: "documentos-clientes",
      path: decodeURIComponent(m[1]), quando: Date.parse(d.created_at || "") || 0,
      paginas: d.paginas ?? null, uri: d.gemini_uri || null, expira: d.gemini_expira || null });
    break; // já vem ordenado por created_at desc
  }

  const autos = await sb(`processo_autos?processo_id=eq.${processoId}&pdf_path=not.is.null&select=id,pdf_path,atualizado_em,criado_em,gemini_uri,gemini_expira,paginas&order=atualizado_em.desc&limit=1`).catch(() => []);
  const a = Array.isArray(autos) && autos.length ? autos[0] : null;
  if (a?.pdf_path) {
    cand.push({ tabela: "processo_autos", id: a.id, nome: "autos baixados do Legal Mail",
      bucket: "autos", path: String(a.pdf_path),
      quando: Date.parse(a.atualizado_em || a.criado_em || "") || 0,
      paginas: a.paginas ?? null, uri: a.gemini_uri || null, expira: a.gemini_expira || null });
  }

  if (!cand.length) return null;
  cand.sort((x, y) => y.quando - x.quando);
  return cand[0];
}

async function urlAssinada(bucket: string, path: string): Promise<string | null> {
  const r = await fetch(`${SB}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST", headers: sbH, body: JSON.stringify({ expiresIn: 3600 }),
  });
  const j = await r.json().catch(() => null);
  return j?.signedURL ? `${SB}/storage/v1${j.signedURL}` : null;
}

// Contagem de páginas direto nos bytes. Serve para mostrar na tela o tamanho do que a IA leu e
// para estimar o custo. Se o PDF for atípico e a conta falhar, devolve null e ninguém quebra.
function contarPaginas(bytes: Uint8Array): number | null {
  try {
    const txt = new TextDecoder("latin1").decode(bytes);
    const porTipo = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (porTipo > 0) return porTipo;
    const c = txt.match(/\/Count\s+(\d+)/);
    return c ? parseInt(c[1], 10) : null;
  } catch { return null; }
}

// Mesmo subirPdf do autos-anexo-ia, já provado no arquivo de 6,4 MB: protocolo resumável e
// espera do estado PROCESSING → ACTIVE (sem esperar, o generateContent falha).
async function subirPdf(bytes: Uint8Array): Promise<{ uri: string | null; nome: string | null }> {
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
  if (!up) return { uri: null, nome: null };
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
  return state === "ACTIVE" ? { uri, nome: name } : { uri: null, nome: null };
}

// Devolve o fileUri pronto para usar. Reaproveita o do banco quando ainda faltam >2h para
// vencer; caso contrário baixa, sobe e grava. A margem de 2h evita o URI vencer no meio da
// pergunta.
async function uriDaIntegra(it: Integra): Promise<{ uri: string | null; paginas: number | null; err?: string }> {
  const folga = it.expira ? (new Date(it.expira).getTime() - Date.now()) : -1;
  if (it.uri && folga > 2 * 3600 * 1000) return { uri: it.uri, paginas: it.paginas };

  const assinada = await urlAssinada(it.bucket, it.path);
  if (!assinada) return { uri: null, paginas: it.paginas, err: "falha ao acessar a íntegra" };
  const pr = await fetch(assinada);
  if (!pr.ok) return { uri: null, paginas: it.paginas, err: `pdf http ${pr.status}` };
  const bytes = new Uint8Array(await pr.arrayBuffer());
  const mb = bytes.length / 1048576;
  if (mb > MAX_MB) return { uri: null, paginas: it.paginas, err: `íntegra de ${mb.toFixed(0)} MB acima da trava de ${MAX_MB} MB` };

  const paginas = contarPaginas(bytes) ?? it.paginas;
  const { uri } = await subirPdf(bytes);
  if (!uri) return { uri: null, paginas, err: "upload para o Gemini falhou" };
  try {
    await sb(`${it.tabela}?id=eq.${it.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ gemini_uri: uri, gemini_expira: new Date(Date.now() + 46 * 3600 * 1000).toISOString(), paginas }),
    });
  } catch { /* cache é otimização; se não gravar, a próxima pergunta sobe de novo */ }
  return { uri, paginas };
}

// ── Contexto de texto ─────────────────────────────────────────────────────────────────────────
async function contextoProcesso(processoId: number): Promise<{ texto: string; polo: string }> {
  const rows = await sb(`processos?id=eq.${processoId}&select=numero,tribunal,vara,comarca,classe_processual,assunto,parte_contraria,advogado_responsavel,situacao,polo_cliente,polo_papeis,clientes(nome,cpf_cnpj)`);
  const p = Array.isArray(rows) ? rows[0] : null;
  const polo = blocoPolo(p?.clientes?.nome || null, p?.polo_cliente || null, p?.polo_papeis || null);

  const arow = await sb(`processo_autos?processo_id=eq.${processoId}&select=ia_json,ia_resumo&order=criado_em.desc&limit=1`).catch(() => []);
  const autos = Array.isArray(arow) && arow.length ? arow[0] : null;
  const movs = await sb(`movimentacoes?processo_id=eq.${processoId}&select=data,descricao,tipo&order=data.desc&limit=30`).catch(() => []);
  const prazos = await sb(`prazos?processo_id=eq.${processoId}&cumprido=eq.false&select=id,data,descricao,categoria,status,legalmail_id&order=data.asc&limit=20`).catch(() => []);

  const ia = autos?.ia_json || null;
  let bloco = `DADOS DO PROCESSO:\n` + [
    `Número CNJ: ${p?.numero || "—"}`,
    `Cliente: ${p?.clientes?.nome || "—"}`,
    `Polo do nosso cliente: ${p?.polo_cliente || "não identificado"}`,
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
    bloco += `(Este resumo é de segunda mão. Onde a íntegra estiver anexada abaixo, ela manda.)\n`;
  } else if (autos?.ia_resumo) {
    bloco += `\nRESUMO DOS AUTOS:\n${autos.ia_resumo}\n`;
  }

  bloco += `\nMOVIMENTAÇÕES RECENTES (mais novas primeiro):\n${_lista(movs, (m) => `- ${m.data || "s/data"}: ${(m.descricao || "").slice(0, 160)}`)}\n`;

  // PRAZOS + o TEXTO da intimação de cada um. prazos.descricao é boilerplate ("CLIENTE · TJSC —
  // Prazo (15 dias)") e não diz de que ato o prazo é; o texto real está em publicacoes e traz
  // número de evento, prazo e data final. É a mesma fonte que o olhinho do prazo já mostra.
  const lmIds = (Array.isArray(prazos) ? prazos : []).map((z: any) => z.legalmail_id).filter(Boolean);
  let pubs: any[] = [];
  if (lmIds.length) {
    pubs = await sb(`publicacoes?legalmail_id=in.(${lmIds.slice(0, 6).join(",")})&select=legalmail_id,texto,data_disponibilizacao,link`).catch(() => []);
    if (!Array.isArray(pubs)) pubs = [];
  }
  bloco += `\nPRAZOS EM ABERTO:\n`;
  if (!Array.isArray(prazos) || !prazos.length) bloco += "(nenhum)\n";
  for (const z of (Array.isArray(prazos) ? prazos : []).slice(0, 20)) {
    bloco += `- ${z.data || "s/data"}: ${(z.descricao || "").slice(0, 120)}${z.categoria && z.categoria !== "geral" ? ` [${z.categoria}]` : ""}\n`;
    const pb = pubs.find((x: any) => String(x.legalmail_id) === String(z.legalmail_id));
    if (pb?.texto) {
      bloco += `  INTIMAÇÃO DE ORIGEM (disp. ${pb.data_disponibilizacao || "?"}):\n  ${String(pb.texto).slice(0, 700).replace(/\n/g, "\n  ")}\n`;
    }
  }
  return { texto: bloco.slice(0, 24000), polo };
}

function promptChat(leuAutos: boolean, paginas: number | null): string {
  const base = [
    "Você é assistente jurídico do escritório Becker Advogados, respondendo a um(a) advogado(a) SOBRE UM PROCESSO específico.",
    "NUNCA invente fatos, valores, datas, números de processo ou jurisprudência. É melhor dizer 'não consta' do que arriscar.",
    "Português claro e direto, conciso. Pode usar tópicos.",
  ];
  if (leuAutos) {
    base.push(
      `A ÍNTEGRA DOS AUTOS${paginas ? ` (${paginas} páginas)` : ""} ESTÁ ANEXADA a esta conversa: leia nela.`,
      "A resposta tem de sair dos autos, do texto das intimações e do cadastro — nessa ordem de prioridade.",
      "CITE o número do evento (ou a peça) de onde tirou cada afirmação relevante, para a resposta poder ser conferida.",
      "NÃO sugira 'abrir a íntegra dos autos' — ela já está aqui, e você já a leu. Se o ponto realmente não estiver nos autos anexados, diga isso e indique em que evento ou peça procurar.",
    );
  } else {
    base.push(
      "Responda usando SOMENTE o CONTEXTO fornecido (cadastro, resumo dos autos, intimações, movimentações e prazos).",
      "A íntegra dos autos NÃO está anexada. Se a resposta depender do teor de uma peça, diga que não consta no sistema e sugira anexar a íntegra do processo (botão 'Anexar íntegra/documento') para a IA poder ler.",
    );
  }
  return base.join(" ");
}

async function responder(processoId: number, pergunta: string, historico: any[]) {
  if (!GKEY) return { ok: false as const, err: "sem GEMINI_API_KEY" };
  const { texto: ctx, polo } = await contextoProcesso(processoId);

  // A íntegra é opcional: falha aqui não impede a resposta, só a rebaixa — e a resposta diz isso.
  let uri: string | null = null, paginas: number | null = null, aviso: string | null = null, nomeInt: string | null = null;
  const it = await acharIntegra(processoId).catch(() => null);
  if (it) {
    const r = await uriDaIntegra(it).catch((e) => ({ uri: null, paginas: null, err: String(e).slice(0, 120) }));
    uri = r.uri; paginas = r.paginas ?? null; aviso = r.err || null; nomeInt = it.nome;
  }

  const cab = `${promptChat(!!uri, paginas)}\n\n${polo}\n\n===== CONTEXTO DO PROCESSO =====\n${ctx}\n===== FIM DO CONTEXTO =====`;
  const partes: any[] = [];
  if (uri) partes.push({ fileData: { fileUri: uri, mimeType: "application/pdf" } });
  partes.push({ text: cab });

  const contents: any[] = [{ role: "user", parts: partes }];
  for (const h of (Array.isArray(historico) ? historico.slice(-6) : [])) {
    const role = h?.role === "assistant" ? "model" : "user";
    const t = String(h?.texto || h?.text || "").slice(0, 2000);
    if (t) contents.push({ role, parts: [{ text: t }] });
  }
  contents.push({ role: "user", parts: [{ text: `PERGUNTA: ${String(pergunta).slice(0, 2000)}` }] });

  const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: { temperature: 0.2, maxOutputTokens: 1800 } }),
  });
  if (!g.ok) return { ok: false as const, err: `gemini http ${g.status}` };
  const j = await g.json().catch(() => null);
  const txt = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
  if (!txt) return { ok: false as const, err: "sem resposta" };
  return { ok: true as const, resposta: txt, leu_autos: !!uri, paginas, integra: nomeInt, aviso };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "faça login" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const processoId = Number(body.processo_id || 0);
  const pergunta = String(body.pergunta || "").trim();
  if (!processoId) return json({ erro: "processo_id obrigatorio" }, 400);
  if (!pergunta) return json({ erro: "pergunta vazia" }, 400);
  try {
    const r = await responder(processoId, pergunta, body.historico || []);
    if (!r.ok) return json({ erro: r.err || "falha da IA" }, 502);
    return json({ ok: true, resposta: r.resposta, leu_autos: r.leu_autos, paginas: r.paginas, integra: r.integra, aviso: r.aviso });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
