// Edge Function `prazos-auditoria-datajud` — confere, olhando para trás, se o prazo calculado do
// TRT foi cumprido, usando os movimentos do processo na API PÚBLICA do DataJud (CNJ). GRÁTIS.
//
// POR QUE EXISTE: o prazo trabalhista é calculado (o diário do TRT não publica a data-limite).
// Sem conferência, ninguém sabe se o cálculo acertou nem se o prazo foi cumprido. O DataJud traz
// movimentos com código da TPU: "Petição" (85) juntada depois da intimação é sinal forte de
// cumprimento.
//
// POR QUE É MENSAL: medido em 09/09/2026, o TRT12 envia ao DataJud em lote de ~30 dias. Não dá
// para fechar prazo na hora — só para olhar para trás. A view prazos_a_auditar filtra por 35 dias.
//
// POR QUE NÃO TEM RISCO: DataJud é índice público do CNJ, não a caixa postal do destinatário.
// Consultar NÃO dá ciência e não inicia prazo — diferente do Domicílio Eletrônico, descartado
// por isso (ver db/pje_comunica_20260908.sql).
//
// NUNCA FECHA PRAZO. Só grava o veredito para uma pessoa decidir. Fechar por indireta é pior do
// que deixar aberto.
//
// Gatilho: header x-auditoria-key = AUDITORIA_KEY (reserva: LEGALMAIL_WEBHOOK_KEY), ou ?k=<K>
// para acionamento manual — mesmo padrão da legalmail-reconcile.
// Parâmetros: ?limit=N (padrão 60), ?dry=1 (não grava, só devolve o que faria).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB  = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GUARD = Deno.env.get("AUDITORIA_KEY") || Deno.env.get("LEGALMAIL_WEBHOOK_KEY") || "";
const K = "aud_66d9c2f842";
// Chave pública do DataJud, publicada pelo CNJ. Mesma usada pela datajud-enriquecer.
const KEY = Deno.env.get("DATAJUD_APIKEY") || "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const json = (o: unknown, st = 200) =>
  new Response(JSON.stringify(o, null, 2), { status: st, headers: { "Content-Type": "application/json" } });

// Códigos da TPU que indicam que o escritório protocolou algo.
const COD_PETICAO = new Set(["85", "581"]); // 85 Petição, 581 Juntada

const ESTADUAL: Record<string, string> = {
  "01":"ac","02":"al","03":"ap","04":"am","05":"ba","06":"ce","07":"dft","08":"es","09":"go",
  "10":"ma","11":"mt","12":"ms","13":"mg","14":"pa","15":"pb","16":"pr","17":"pe","18":"pi",
  "19":"rj","20":"rn","21":"rs","22":"ro","23":"rr","24":"sc","25":"se","26":"sp","27":"to",
};
function aliasDataJud(cnj: string): string | null {
  const d = (cnj || "").replace(/\D/g, "");
  if (d.length !== 20) return null;
  const j = d[13], tr = d.slice(14, 16);
  if (j === "5") return `api_publica_trt${parseInt(tr, 10)}`;
  if (j === "4") return `api_publica_trf${parseInt(tr, 10)}`;
  if (j === "8") { const uf = ESTADUAL[tr]; return uf ? `api_publica_tj${uf}` : null; }
  if (j === "6") { const uf = ESTADUAL[tr]; return uf ? `api_publica_tre${uf}` : null; }
  if (j === "7") return "api_publica_stm";
  return null;
}

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

async function datajud(cnj: string) {
  const alias = aliasDataJud(cnj);
  if (!alias) return { erro: "tribunal fora do DataJud" };
  const r = await fetch(`https://api-publica.datajud.cnj.jus.br/${alias}/_search`, {
    method: "POST",
    headers: { Authorization: `APIKey ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { match: { numeroProcesso: cnj.replace(/\D/g, "") } }, size: 1 }),
  });
  if (!r.ok) return { erro: `datajud http ${r.status}` };
  const j = await r.json().catch(() => null);
  return { src: j?.hits?.hits?.[0]?._source ?? null };
}

function avaliar(src: any, disp: string, prazo: string) {
  const mv: any[] = Array.isArray(src?.movimentos) ? src.movimentos : [];
  const dia = (m: any) => String(m?.dataHora || "").slice(0, 10);
  const ultimoMov = mv.reduce((a, m) => (dia(m) > a ? dia(m) : a), "");
  const atualizado = String(src?.dataHoraUltimaAtualizacao || "").slice(0, 10);
  // Marco de frescor: o mais recente entre a carga declarada e o último movimento visto.
  const frescor = atualizado > ultimoMov ? atualizado : ultimoMov;

  const peticoes = mv
    .filter((m) => COD_PETICAO.has(String(m?.codigo)) || /peti[çc][ãa]o/i.test(String(m?.nome || "")))
    .map(dia).filter((d) => d && d >= disp).sort();

  // A ordem importa: sem dados frescos o suficiente, NADA se conclui. Foi a armadilha que o
  // levantamento de 09/09 revelou — "nenhuma petição" pode ser só atraso da fonte, e viraria
  // alarme falso de prazo perdido.
  if (peticoes.length) {
    const p = peticoes[0];
    return p <= prazo
      ? { veredito: "cumprido_no_prazo",  detalhe: `petição juntada em ${p}, prazo era ${prazo}` }
      : { veredito: "cumprido_atrasado", detalhe: `petição juntada em ${p}, DEPOIS do prazo ${prazo}` };
  }
  if (!frescor || frescor < prazo) {
    return { veredito: "sem_dados_ainda", detalhe: `DataJud só tem movimento até ${frescor || "—"}; prazo era ${prazo}. Inconclusivo.` };
  }
  return { veredito: "sem_peticao", detalhe: `DataJud atualizado até ${frescor} e nenhuma petição desde ${disp}. CONFERIR se o prazo foi perdido.` };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const okAuth = (GUARD && req.headers.get("x-auditoria-key") === GUARD) || url.searchParams.get("k") === K;
  if (GUARD && !okAuth) return new Response("unauthorized", { status: 401 });
  const limite = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") || "60", 10) || 60));
  const dry = url.searchParams.get("dry") === "1";

  try {
    const fila = await sb(`prazos_a_auditar?select=prazo_id,cnj,disponibilizacao,data_prazo&limit=${limite}`);
    if (!Array.isArray(fila) || !fila.length) return json({ ok: true, fila: 0, mensagem: "nada com 35+ dias para conferir" });

    const contagem: Record<string, number> = {};
    const detalhes: unknown[] = [];
    for (const p of fila) {
      const { src, erro } = await datajud(p.cnj) as any;
      let r: { veredito: string, detalhe: string };
      if (erro)      r = { veredito: "processo_nao_encontrado", detalhe: erro };
      else if (!src) r = { veredito: "processo_nao_encontrado", detalhe: "não indexado no DataJud" };
      else           r = avaliar(src, String(p.disponibilizacao), String(p.data_prazo));

      contagem[r.veredito] = (contagem[r.veredito] || 0) + 1;
      detalhes.push({ prazo_id: p.prazo_id, cnj: p.cnj, prazo: p.data_prazo, ...r });

      if (!dry) {
        await sb(`prazos?id=eq.${p.prazo_id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            auditoria_em: new Date().toISOString(),
            auditoria_veredito: r.veredito,
            auditoria_detalhe: r.detalhe.slice(0, 400),
          }),
        });
      }
      await new Promise((s) => setTimeout(s, 250)); // gentileza com a API pública
    }
    return json({ ok: true, dry, conferidos: fila.length, contagem, detalhes });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
