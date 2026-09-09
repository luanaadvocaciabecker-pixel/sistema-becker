// Edge Function `prazo-peca` — o CAMINHO PAGO do briefing do prazo, R$ 0,02, SÓ SOB CLIQUE.
// Cópia versionada; o deploy é feito no Supabase.
//
// POR QUE EXISTE: em 27 dos 163 prazos abertos o teor do despacho não está no banco — a
// intimação é só o recibo do Legal Mail ("Refer. ao Evento 65"). Sem teor, a `prazo-orientacao`
// se recusa a escrever pontos fortes e fracos, e com razão. Esta função busca a peça.
//
// A ESCOLHA DE ENDPOINT, que é onde está a economia (documentação do Legal Mail):
//   POST case-files/download/request — R$ 0,02 *** POR AUTO DO PROCESSO INTEIRO ***
//                                      (107 autos = R$ 2,14, conferido no extrato)
//   GET  lawsuit/docket-entry/url    — R$ 0,02 *** POR DOCUMENTO ESCOLHIDO ***
// Para uma peça de um processo volumoso, o segundo custa 100x menos. A própria doc diz:
// "Peça avulsa costuma sair muito mais barato que o processo inteiro."
//
// A URL devolvida é pré-assinada e vale 6 DIAS. A doc avisa: "guarde a URL enquanto estiver
// válida: pedir de novo a mesma URL depois da isenção é uma cobrança nova por um link que você
// ainda tinha". Por isso gravamos peca_url/peca_url_expira e REUSAMOS enquanto vale.
//
// DUAS AÇÕES, e só a segunda gasta:
//   preview  GRÁTIS  — GET lawsuit/case-files (grátis) lista os documentos com idmovimentacoes,
//                      titulo e data, e marca qual casa com a data do ato. Nada é cobrado.
//   puxar    R$ 0,02 — exige idmovimentacoes EXPLÍCITO vindo do preview. Nunca escolhe sozinha.
//
// Regras de LICOES.md aplicadas: consulta o saldo (GET /balance, grátis) e recusa abaixo do
// piso; aborta no 429 respeitando Retry-After.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";
const CUSTO = 0.02;
const SALDO_MINIMO = 5.00;   // abaixo disto não gasta: o ciclo vence 17/09 com R$ 65,69
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
async function saldo(): Promise<number | null> {
  try {
    const r = await fetch(`${BASE}/api/v1/balance?api_key=${encodeURIComponent(API)}`, { headers: { Accept: "application/json" } });
    const j = await r.json().catch(() => null);
    return typeof j?.saldo_disponivel === "number" ? j.saldo_disponivel : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "faça login" }, 401);
  if (!API) return json({ erro: "sem LEGALMAIL_API_KEY" }, 500);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const prazoId = Number(body.prazo_id || 0);
  const action = String(body.action || "preview");
  if (!prazoId) return json({ erro: "prazo_id obrigatorio" }, 400);

  try {
    const zs = await sb(`prazos?id=eq.${prazoId}&select=id,data,legalmail_id,peca_idmov,peca_url,peca_url_expira,ia_orientacao,processos(id,numero,lm_idprocessos,polo_cliente,polo_papeis,clientes(nome))`);
    const z = Array.isArray(zs) ? zs[0] : null;
    if (!z) return json({ erro: "prazo nao encontrado" }, 404);
    const idp = z?.processos?.lm_idprocessos;
    if (!idp) return json({ erro: "processo sem vinculo no Legal Mail (lm_idprocessos)" }, 400);

    let ddAviso: string | null = null;
    if (z.legalmail_id) {
      const pb = await sb(`publicacoes?legalmail_id=eq.${z.legalmail_id}&select=data_disponibilizacao&limit=1`).catch(() => []);
      ddAviso = Array.isArray(pb) && pb.length ? pb[0]?.data_disponibilizacao : null;
    }

    // ---------- PREVIEW: GRÁTIS ----------
    if (action === "preview") {
      const r = await fetch(`${BASE}/api/v1/lawsuit/case-files?api_key=${encodeURIComponent(API)}&idprocessos=${encodeURIComponent(String(idp))}`, { headers: { Accept: "application/json" } });
      if (r.status === 429) return json({ erro: "limite de taxa do Legal Mail — tente em alguns minutos", retry_after: r.headers.get("Retry-After") }, 429);
      const arr = await r.json().catch(() => null);
      const docs = Array.isArray(arr) ? arr : [];
      const norm = docs.map((d: any) => ({
        idmovimentacoes: d?.idmovimentacoes ?? null,
        titulo: d?.titulo ?? null,
        tipo: d?.tipo ?? null,
        data: d?.data_movimentacao ?? null,
      })).filter((d) => d.idmovimentacoes);
      const comDist = norm.map((d) => ({
        ...d,
        dias: (ddAviso && d.data) ? Math.round((Date.parse(String(d.data)) - Date.parse(String(ddAviso))) / 86400000) : null,
      }));
      comDist.sort((a, b) => Math.abs(a.dias ?? 9999) - Math.abs(b.dias ?? 9999));
      return json({
        ok: true, custo_por_documento: CUSTO, gratis: true,
        processo: z?.processos?.numero, data_do_aviso: ddAviso,
        total_documentos: comDist.length,
        sugeridos: comDist.slice(0, 8),
        ja_temos_url: !!(z.peca_url && z.peca_url_expira && new Date(z.peca_url_expira) > new Date()),
        aviso: "Esta consulta não custou nada. Puxar um documento custa R$ " + CUSTO.toFixed(2).replace(".", ",") + ".",
      });
    }

    // ---------- PUXAR: R$ 0,02 ----------
    if (action !== "puxar") return json({ erro: "action invalida (preview|puxar)" }, 400);

    const idmov = Number(body.idmovimentacoes || 0);
    if (!idmov) return json({ erro: "idmovimentacoes obrigatorio — venha pelo preview, a funcao nao escolhe sozinha" }, 400);

    let url: string | null = null, reusou = false;
    if (z.peca_url && z.peca_idmov === idmov && z.peca_url_expira && new Date(z.peca_url_expira) > new Date()) {
      url = z.peca_url; reusou = true;
    }

    if (!url) {
      const s = await saldo();
      if (s !== null && s < SALDO_MINIMO)
        return json({ erro: `saldo da API em R$ ${s.toFixed(2)} — abaixo do piso de R$ ${SALDO_MINIMO.toFixed(2)}. Recarregue antes.`, saldo: s }, 402);

      const r = await fetch(`${BASE}/api/v1/lawsuit/docket-entry/url?api_key=${encodeURIComponent(API)}&idmovimentacoes=${idmov}`, { headers: { Accept: "application/json" } });
      if (r.status === 429) return json({ erro: "limite de taxa do Legal Mail", retry_after: r.headers.get("Retry-After") }, 429);
      if (r.status === 402) return json({ erro: "sem saldo na API do Legal Mail" }, 402);
      const j = await r.json().catch(() => null);
      url = j?.s3_url || j?.url || null;
      if (!r.ok || !url) return json({ erro: `falha ao obter a peca (http ${r.status})`, corpo: j }, 502);

      await sb(`prazos?id=eq.${prazoId}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          peca_idmov: idmov, peca_url: url,
          peca_url_expira: new Date(Date.now() + (6 * 24 - 6) * 3600 * 1000).toISOString(),
        }),
      });
    }

    if (!GKEY) return json({ ok: true, url_obtida: true, reusou, aviso: "peca obtida, mas sem GEMINI_API_KEY para ler" });
    const pr = await fetch(url);
    if (!pr.ok) return json({ erro: `nao consegui baixar a peca (http ${pr.status})`, url_valida_ate: z.peca_url_expira }, 502);
    const bytes = new Uint8Array(await pr.arrayBuffer());

    const p0 = z.processos || {};
    const nome = p0?.clientes?.nome || "o cliente do escritório";
    const polo = p0?.polo_cliente
      ? `QUEM NÓS REPRESENTAMOS: ${nome} — polo processual: ${p0.polo_cliente}. Analise SEMPRE do ponto de vista DESTE lado. Decisão contrária a ele é DERROTA NOSSA: o próximo passo é o recurso ou a medida cabível — NUNCA 'aguardar a preclusão' como estratégia nossa.`
      : `QUEM NÓS REPRESENTAMOS: ${nome}. O POLO NÃO ESTÁ IDENTIFICADO — NÃO afirme de que lado estamos.`;
    const PROMPT = [
      "Você é advogado(a) do escritório Becker Advogados preparando o colega que vai cumprir ESTE prazo.",
      "O anexo é UMA PEÇA do processo. Analise SOMENTE ela; você não recebeu os autos completos.",
      'Responda SOMENTE em JSON: {"o_que_decidiu":"2-3 frases","o_que_fazer":[],"pontos_fortes":[],"pontos_fracos":[],"prazo_no_texto":"ou null","evento":"ou null"}',
      "Não invente: sem base na peça, devolva lista VAZIA. Máximo 4 itens por lista, 20 palavras cada.",
    ].join(" ");

    const b64 = btoa(String.fromCharCode(...bytes.slice(0, 4 * 1024 * 1024)));
    const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: b64 } }, { text: `${PROMPT}\n\n${polo}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1600, responseMimeType: "application/json" },
      }),
    });
    if (!g.ok) return json({ ok: true, url_obtida: true, reusou, erro_ia: `gemini http ${g.status}` });
    const gj = await g.json().catch(() => null);
    let txt = (gj?.candidates?.[0]?.content?.parts || []).map((x: any) => x?.text || "").join("").trim();
    const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
    if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
    let obj: any = null; try { obj = JSON.parse(txt); } catch { /* */ }
    if (!obj) return json({ ok: true, url_obtida: true, reusou, erro_ia: "json invalido" });

    obj.limite = "Leitura desta peça, não da tese do processo. Confira nos autos antes de agir.";
    obj.ato = { origem: "peca_paga", idmovimentacoes: idmov, provavel: false };
    await sb(`prazos?id=eq.${prazoId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ia_orientacao: obj, ia_orientacao_em: new Date().toISOString() }),
    });

    return json({ ok: true, cobrado: reusou ? 0 : CUSTO, reusou, por: emailChamador(req), orientacao: obj });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
