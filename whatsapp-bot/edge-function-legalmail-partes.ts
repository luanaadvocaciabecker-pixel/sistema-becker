// Edge Function `legalmail-partes` — puxa as partes (polo ativo/passivo) e dados do
// processo direto do Legal Mail (GRÁTIS, endpoint de detalhe), para pré-preencher a
// Geração de Documentos. Exige usuário logado. Não baixa autos (não gera custo).
// Segredos: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LEGALMAIL_API_KEY, LEGALMAIL_BASE.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

function usuarioAutenticado(req: Request): boolean {
  try {
    const tk = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    return JSON.parse(atob(tk.split(".")[1] || ""))?.role === "authenticated";
  } catch { return false; }
}

async function sb(path: string): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbH });
  const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return null; }
}

// Extrai nomes de partes de um objeto de detalhe do Legal Mail, de forma tolerante a formato.
function extrairPartes(d: any): { ativo: string[], passivo: string[], outros: string[] } {
  const uniq = (a: string[]) => [...new Set(a.map((s) => String(s).trim()).filter(Boolean))];
  const nomesDe = (v: any): string[] => {
    if (!v) return [];
    if (typeof v === "string") return v.split(/;|\n/).map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(v)) return v.flatMap((x) => typeof x === "string" ? [x] : nomesDe(x?.nome ?? x?.name ?? x));
    if (typeof v === "object") return nomesDe(v.nome ?? v.name);
    return [];
  };
  const ativo: string[] = [], passivo: string[] = [], outros: string[] = [];
  for (const [k, v] of Object.entries(d || {})) {
    const kl = k.toLowerCase();
    if (kl.includes("poloativo") || (kl.includes("polo") && kl.includes("ativo")) || kl.includes("requerente") || kl.includes("autor") || kl.includes("exequente")) ativo.push(...nomesDe(v));
    else if (kl.includes("polopassivo") || (kl.includes("polo") && kl.includes("passivo")) || kl.includes("requerido") || kl.includes("reu") || kl.includes("réu") || kl.includes("executado")) passivo.push(...nomesDe(v));
    else if (kl.includes("parte") && !kl.includes("contrari")) outros.push(...nomesDe(v));
  }
  // se houver um array genérico "partes" com polo em cada item
  const partesArr = Array.isArray(d?.partes) ? d.partes : [];
  for (const p of partesArr) {
    const polo = String(p?.polo || p?.tipo_polo || "").toLowerCase();
    const nome = p?.nome || p?.name;
    if (!nome) continue;
    if (polo.includes("ativo")) ativo.push(nome);
    else if (polo.includes("passivo")) passivo.push(nome);
    else outros.push(nome);
  }
  return { ativo: uniq(ativo), passivo: uniq(passivo), outros: uniq(outros) };
}

async function detalhe(idp: number): Promise<{ http: number, raw: any }> {
  const u = `${BASE}/api/v1/lawsuit/detail?api_key=${encodeURIComponent(API)}&idprocessos=${idp}`;
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  const t = await r.text(); let raw: any = null; try { raw = t ? JSON.parse(t) : t; } catch { raw = t; }
  return { http: r.status, raw };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "faça login" }, 401);
  if (!API) return json({ erro: "sem LEGALMAIL_API_KEY" }, 500);
  let body: any = {}; try { body = await req.json(); } catch {}
  const action = String(body.action || "partes");
  try {
    // resolve idprocessos por processo_id OU por numero
    let idp: number | null = Number(body.idprocessos || 0) || null;
    let numero = String(body.numero || "");
    if (!idp) {
      const pid = Number(body.processo_id || 0);
      const filtro = pid ? `id=eq.${pid}` : (numero ? `numero=eq.${encodeURIComponent(numero)}` : "");
      if (!filtro) return json({ erro: "informe processo_id, numero ou idprocessos" }, 400);
      const rows = await sb(`processos?${filtro}&select=id,numero,lm_idprocessos&limit=1`);
      const p = Array.isArray(rows) ? rows[0] : null;
      idp = p?.lm_idprocessos ?? null;
      numero = numero || p?.numero || "";
    }
    if (!idp) return json({ erro: "processo sem vínculo no Legal Mail (lm_idprocessos)", numero });

    const { http, raw } = await detalhe(idp);
    if (action === "debug") return json({ idprocessos: idp, http, raw: typeof raw === "string" ? raw.slice(0, 1500) : raw });
    if (http < 200 || http >= 300) return json({ erro: `legal mail detail http ${http}` }, 502);
    const src = (raw && typeof raw === "object") ? (Array.isArray(raw) ? raw[0] : (raw.lawsuit || raw.processo || raw.data || raw)) : {};
    const partes = extrairPartes(src);
    return json({
      ok: true, idprocessos: idp, numero,
      partes,
      classe: src?.nome_classe || src?.classe || src?.classe_processual || null,
      assunto: src?.processo_tema || src?.assuntos || src?.assunto || null,
      vara: src?.juizo || src?.vara || src?.orgao_julgador || null,
      comarca: src?.comarca || null,
      valor_causa: src?.valor_causa || null,
      tribunal: src?.tribunal || null,
      data_distribuicao: src?.data_distribuicao || null,
    });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
