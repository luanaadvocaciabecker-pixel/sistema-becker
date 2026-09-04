// Edge Function `prazos-classificar` — sugere categoria (custas/documentos/geral) para os
// prazos EM ABERTO, a partir da classe processual + resumo do ato. Usa a IA do Google (Gemini).
// NÃO sobrescreve `categoria` (verdade do humano); grava categoria_sugerida/_confianca/_motivo.
//
// LIMITAÇÃO CONHECIDA: o /notices do Legal Mail só traz o "envelope" da intimação
// (tipo do ato, prazo em dias, Data final) — NÃO traz o corpo do despacho, que é onde
// está o "recolher custas" / "juntar documento". Por isso, classificando só pelo envelope,
// a maioria volta "geral/baixa" (correto — não há sinal). Para classificar de verdade,
// é preciso puxar o despacho (Legal Mail case-files) e mandar o TEXTO dele para a IA.
//
// Aciona: ?k=<token> OU header x-reconcile-key. ?limit=N, ?force=1 (reclassifica tudo).
// Segredos: GEMINI_API_KEY (+ GEMINI_MODEL, padrão gemini-2.5-flash), LEGALMAIL_API_KEY, LEGALMAIL_WEBHOOK_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const GUARD = Deno.env.get("LEGALMAIL_WEBHOOK_KEY") || "";
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest"; // gemini-2.5-flash foi descontinuado (404)
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const K = "clsf_7b21ae09";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers||{}) } });
  const t = await r.text(); let j:any=null; try{ j = t? JSON.parse(t): null; }catch{ j=t; }
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${t.slice(0,200)}`);
  return j;
}

async function mapaNotices(): Promise<Map<string,{classe:string,teor:string}>> {
  const m = new Map<string,{classe:string,teor:string}>();
  const PAGE=50;
  for (let p=0; p<200; p++) {
    const u = `${BASE}/api/v1/notices?api_key=${encodeURIComponent(API)}&prazo_status=pendente&limit=${PAGE}&offset=${p*PAGE}&ordenar_por=id&ordem=desc`;
    const r = await fetch(u, { headers:{Accept:"application/json"} });
    const j:any = await r.json().catch(()=>({}));
    const arr = Array.isArray(j?.notices)? j.notices : [];
    for (const n of arr) m.set(String(n.id), { classe: String(n.classe||""), teor: String(n.teor||"") });
    if (arr.length < PAGE) break;
  }
  return m;
}

const SYS = [
  "Você é um triador de prazos jurídicos de um escritório brasileiro.",
  "Para cada item, diga que TIPO DE PROVIDÊNCIA o prazo provavelmente exige, usando SOMENTE a classe processual e o resumo do ato (que é curto e muitas vezes NÃO diz a providência explícita).",
  "Categorias: 'custas' = recolher custas, preparo/porte de recurso, GRU, taxa judiciária, diligência de oficial. 'documentos' = juntar/apresentar documento, procuração, contrato social, comprovante, emenda à inicial. 'geral' = qualquer outra (manifestar, contestar, réplica, ciência, interpor recurso, cumprir sentença sem custas).",
  "Se o texto não deixa claro, responda 'geral' com confianca 'baixa'. Só use confianca 'alta' quando a classe/ato praticamente garantem (ex.: Execução Fiscal -> custas; despacho manda 'recolher custas' -> custas; manda 'juntar documento' -> documentos).",
  "Responda SOMENTE com um JSON array. Cada elemento: {\"i\":<n>,\"categoria\":\"custas|documentos|geral\",\"confianca\":\"alta|media|baixa\",\"motivo\":\"até 8 palavras\"}"
].join(" ");

async function classificarLote(itens:{i:number,classe:string,ato:string}[]): Promise<any[]> {
  if (!GKEY || !itens.length) return [];
  const user = "Itens:\n" + itens.map(x=>`{"i":${x.i},"classe":${JSON.stringify(x.classe||"")},"ato":${JSON.stringify((x.ato||"").slice(0,500))}}`).join("\n");
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GKEY)}`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        system_instruction:{ parts:[{ text: SYS }] },
        contents:[{ role:"user", parts:[{ text: user }] }],
        generationConfig:{ temperature:0, maxOutputTokens:4000, responseMimeType:"application/json" }
      })
    });
    if (!r.ok) return [];
    const j = await r.json();
    let txt = (j?.candidates?.[0]?.content?.parts||[]).map((p:any)=>p?.text||"").join("").trim();
    const a = txt.indexOf("["); const b = txt.lastIndexOf("]");
    if (a>=0 && b>a) txt = txt.slice(a, b+1);
    return JSON.parse(txt);
  } catch { return []; }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const okAuth = url.searchParams.get("k")===K || (GUARD && req.headers.get("x-reconcile-key")===GUARD);
  if (!okAuth) return new Response("unauthorized",{status:401});
  if (!API || !GKEY) return new Response(JSON.stringify({skipped:"faltam segredos (LEGALMAIL/GEMINI)"}),{status:200,headers:{"Content-Type":"application/json"}});
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit")||"200",10)||200));
  const force = url.searchParams.get("force")==="1";
  const hoje = new Date().toISOString().slice(0,10);

  const filtroIA = force ? "" : "&categoria_ia_em=is.null";
  const sel = `prazos?select=id,legalmail_id,descricao,classe&cumprido=eq.false&data=gte.${hoje}`+
              `&legalmail_id=not.is.null&or=(categoria_fonte.is.null,categoria_fonte.neq.humano)${filtroIA}&order=data.asc&limit=${limit}`;
  const prazos:any[] = await sb(sel);
  if (!prazos.length) return new Response(JSON.stringify({total:0,classificados:0}),{headers:{"Content-Type":"application/json"}});

  const mapa = await mapaNotices();
  const itens = prazos.map((p,idx)=>{
    const nt = mapa.get(String(p.legalmail_id));
    return { i: idx, id: p.id, classe: p.classe || nt?.classe || "", ato: nt?.teor || p.descricao || "" };
  });

  const results = new Map<number,any>();
  for (let s=0; s<itens.length; s+=15) {
    const lote = itens.slice(s, s+15).map(x=>({i:x.i, classe:x.classe, ato:x.ato}));
    const out = await classificarLote(lote);
    for (const o of (Array.isArray(out)?out:[])) if (o && typeof o.i==='number') results.set(o.i, o);
  }

  let ok=0;
  for (const it of itens) {
    const o = results.get(it.i);
    const cat = (o?.categoria==='custas'||o?.categoria==='documentos')? o.categoria : 'geral';
    const conf = (o?.confianca==='alta'||o?.confianca==='media'||o?.confianca==='baixa')? o.confianca : 'baixa';
    const mot = String(o?.motivo||'').slice(0,120);
    try {
      await sb(`prazos?id=eq.${it.id}`, { method:"PATCH", headers:{Prefer:"return=minimal"},
        body: JSON.stringify({ categoria_sugerida:cat, categoria_confianca:conf, categoria_motivo:mot, categoria_ia_em:new Date().toISOString(), classe: it.classe || null }) });
      ok++;
    } catch { /* ignora item */ }
  }
  return new Response(JSON.stringify({ modelo:GMODEL, total:prazos.length, classificados:ok }),{headers:{"Content-Type":"application/json"}});
});
