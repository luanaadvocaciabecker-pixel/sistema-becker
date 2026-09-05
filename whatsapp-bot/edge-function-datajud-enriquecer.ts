// Edge Function `datajud-enriquecer` — preenche classe/assunto (e confere partes) dos processos
// consultando a API PÚBLICA do DataJud (CNJ) — GRÁTIS. Não sobrescreve dado já preenchido.
//
// Ações: {action:"um", processo_id} OU {action:"lote", limit?} (processos com classe/assunto vazios).
// Segredos: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATAJUD_APIKEY (fallback: chave pública do CNJ).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB  = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Chave pública do DataJud (publicada pelo CNJ). Pode ser sobrescrita por env.
const KEY = Deno.env.get("DATAJUD_APIKEY") || "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${String(t).slice(0, 200)}`);
  return j;
}

// TR (estadual) -> UF
const ESTADUAL: Record<string, string> = {
  "01":"ac","02":"al","03":"ap","04":"am","05":"ba","06":"ce","07":"dft","08":"es","09":"go",
  "10":"ma","11":"mt","12":"ms","13":"mg","14":"pa","15":"pb","16":"pr","17":"pe","18":"pi",
  "19":"rj","20":"rn","21":"rs","22":"ro","23":"rr","24":"sc","25":"se","26":"sp","27":"to",
};
// deriva o alias do índice DataJud a partir do CNJ (20 dígitos)
function aliasDataJud(numero: string): string | null {
  const d = (numero || "").replace(/\D/g, "");
  if (d.length !== 20) return null;
  const j = d[13];             // segmento do judiciário
  const tr = d.slice(14, 16);  // tribunal
  if (j === "8") { const uf = ESTADUAL[tr]; return uf ? `api_publica_tj${uf}` : null; }
  if (j === "4") return `api_publica_trf${parseInt(tr, 10)}`;
  if (j === "5") return `api_publica_trt${parseInt(tr, 10)}`;
  if (j === "6") { const uf = ESTADUAL[tr]; return uf ? `api_publica_tre${uf}` : null; }
  if (j === "7") return `api_publica_stm`;
  return null; // STF/STJ/CNJ etc.
}

async function consultarDataJud(numero: string): Promise<any | null> {
  const alias = aliasDataJud(numero);
  if (!alias) return null;
  const dig = numero.replace(/\D/g, "");
  const r = await fetch(`https://api-publica.datajud.cnj.jus.br/${alias}/_search`, {
    method: "POST",
    headers: { Authorization: `APIKey ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { match: { numeroProcesso: dig } }, size: 1 }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const hit = j?.hits?.hits?.[0]?._source;
  return hit || null;
}

function extrair(src: any): { classe: string, assunto: string, orgao: string } {
  const classe = src?.classe?.nome || "";
  const ass = Array.isArray(src?.assuntos) ? src.assuntos.map((a: any) => a?.nome).filter(Boolean) : [];
  const assunto = ass.slice(0, 3).join("; ");
  const orgao = src?.orgaoJulgador?.nome || "";
  return { classe, assunto, orgao };
}

async function enriquecerUm(p: any): Promise<any> {
  const src = await consultarDataJud(p.numero);
  // Marca como verificado (achado ou não) para o lote não reprocessar sempre o mesmo.
  const patch: any = { datajud_checked_at: new Date().toISOString() };
  if (!src) {
    await sb(`processos?id=eq.${p.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    return { numero: p.numero, ok: false, motivo: "não encontrado no DataJud (ou tribunal não suportado)" };
  }
  const { classe, assunto, orgao } = extrair(src);
  if ((!p.classe_processual || !String(p.classe_processual).trim()) && classe) patch.classe_processual = classe;
  if ((!p.assunto || !String(p.assunto).trim()) && assunto) patch.assunto = assunto;
  if ((!p.vara || !String(p.vara).trim()) && orgao) patch.vara = orgao;
  await sb(`processos?id=eq.${p.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  const preenchido: any = { ...patch }; delete preenchido.datajud_checked_at;
  return { numero: p.numero, ok: true, preenchido, classe, assunto };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {}; try { body = await req.json(); } catch {}
  const action = String(body.action || "lote");
  try {
    if (action === "debug") {
      const numero = String(body.numero || "");
      const alias = aliasDataJud(numero);
      const dig = numero.replace(/\D/g, "");
      const r = await fetch(`https://api-publica.datajud.cnj.jus.br/${alias}/_search`, {
        method: "POST", headers: { Authorization: `APIKey ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: { match: { numeroProcesso: dig } }, size: 1 }),
      });
      const t = await r.text();
      return json({ alias, dig, http: r.status, raw: t.slice(0, 900) });
    }
    if (action === "consultar") {
      // Consulta um CNJ no DataJud e devolve o resumo (sem gravar no banco).
      const numero = String(body.numero || "");
      const src = await consultarDataJud(numero);
      if (!src) return json({ encontrado: false });
      const { classe, assunto, orgao } = extrair(src);
      return json({ encontrado: true, classe, assunto, orgao, hit: src });
    }
    if (action === "um") {
      const id = Number(body.processo_id || 0);
      if (!id) return json({ erro: "processo_id obrigatorio" }, 400);
      const rows = await sb(`processos?id=eq.${id}&select=id,numero,classe_processual,assunto,vara`);
      const p = Array.isArray(rows) ? rows[0] : null;
      if (!p) return json({ erro: "processo não encontrado" }, 404);
      return json(await enriquecerUm(p));
    }
    // lote: processos com numero e (classe OU assunto vazio) que ainda NÃO foram consultados no DataJud.
    // Passe {recheck:true} para reconsultar os já verificados (ex.: 2026 que podem ter sido indexados depois).
    const limit = Math.max(1, Math.min(200, parseInt(String(body.limit || "50"), 10) || 50));
    const soFalta = body.recheck ? "" : "&datajud_checked_at=is.null";
    const rows = await sb(`processos?select=id,numero,classe_processual,assunto,vara&numero=not.is.null&numero=neq.&or=(classe_processual.is.null,assunto.is.null)${soFalta}&limit=${limit}`);
    const lista = Array.isArray(rows) ? rows : [];
    const t0 = Date.now();
    let ok = 0, preenchidos = 0, processados = 0; const detalhes: any[] = [];
    for (const p of lista) {
      // Guarda de tempo: a API do DataJud é lenta (~10-15s/consulta). Para antes do limite de 150s.
      if (Date.now() - t0 > 110000) break;
      processados++;
      try {
        const r = await enriquecerUm(p);
        if (r.ok) ok++;
        if (r.preenchido && Object.keys(r.preenchido).length) preenchidos++;
        detalhes.push(r);
      } catch (e) { detalhes.push({ numero: p.numero, ok: false, erro: String(e).slice(0, 120) }); }
      await new Promise((r) => setTimeout(r, 120)); // gentil com a API pública
    }
    const restam = lista.length - processados;
    return json({ candidatos: lista.length, processados, encontrados: ok, preenchidos, restam_neste_lote: restam, detalhes });
  } catch (e) { return json({ erro: String(e).slice(0, 400) }, 500); }
});
