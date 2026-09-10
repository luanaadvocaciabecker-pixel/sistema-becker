// Edge Function `legalmail-reconcile` — cria/atualiza prazo a partir do GET /api/v1/notices.
//
// ESTE É O ÚNICO CAMINHO QUE CRIA PRAZO PARA TRIBUNAL NÃO-TRABALHISTA.
// Medido em 01/08–10/09: a "Intimação por sistema" do eProc (a que traz a "Data final" oficial)
// aparece em 757 linhas de `publicacoes`, e em 0 delas via DJEN. O DJEN do CNJ NUNCA traz
// "Data final" (0 de 1.199 linhas). Sem esta função, TJSC/TJSP/TJPR/TRF-4/STJ não geram prazo
// nenhum — só o TRT/TST, pelo caminho calculado do `trt_gera_prazos`.
//
// ---------------------------------------------------------------------------
// CUSTO — leia antes de mexer. Ver db/legalmail_custo_api.sql e LICOES.md.
// ---------------------------------------------------------------------------
// GET /api/v1/notices custa R$ 0,05 POR REQUISIÇÃO (página de até 50), com isenção de só 5 min.
// A versão anterior desta função tinha o filtro de captura CRAVADO EM null para o status
// "pendente":
//     ["pendente", null, MAX_PAGES_PENDENTE]
// O cron horário já chamava `?janela=1&dias=3`, mas o `since` só valia para cumprido/excedido.
// Resultado: toda hora puxava as 3.302 pendentes inteiras = 67 páginas = R$ 3,35/hora ≈
// R$ 80/dia. Foram R$ 461,40 em 9.362 requisições antes de alguém ver.
//
// Por isso, agora:
//   * A JANELA É O PADRÃO. Sem parâmetro nenhum, filtra por data_captura_inicio = hoje-3.
//     Puxar tudo exige `?tudo=1` explícito, e a resposta grita o custo.
//   * TETO_PAGINAS por rodada. Um laço com defeito não pode custar mais que R$ 1,50.
//   * Aborta no primeiro 429, honrando Retry-After (3 x 429 em 10 min = bloqueio progressivo
//     do workspace inteiro — eu já causei isso uma vez).
//   * A resposta traz `paginas_cobradas` e `custo_estimado_brl`: a auditoria fica no próprio log
//     de `net._http_response`, sem precisar do painel deles.
//   * Rodada incompleta devolve `completo:false` e NÃO devolve contagem tranquilizadora.
//
// A janela é segura: dos 12 prazos criados por este caminho desde 05/09, os 12 nasceram NO MESMO
// DIA em que a publicação entrou — 0 casos de "Data final" preenchida depois, que era o medo que
// justificava o `null`.
//
// CUSTO MEDIDO (10/09, chamada real com ?dias=1&debug=1): `total: 94` na janela, 2 páginas,
// R$ 0,10. Ou seja ~47 notices capturadas por dia — bem mais que as 25–45 que entram em
// `publicacoes`, porque o Legal Mail captura para processos que não temos vinculados. Então:
//     dias=1 -> ~2 páginas -> R$ 0,10/dia      dias=3 -> ~4 páginas -> R$ 0,20/dia
//     dias=7 -> ~13 páginas -> R$ 0,65/dia
// O cron roda com `?dias=3`: R$ 0,20/dia ≈ R$ 6/mês, e aguenta duas rodadas falhas seguidas sem
// abrir buraco. Contra os R$ 80/dia de antes.
//
// cumprido/excedido saem por padrão: em 112 execuções deram `cumpridos: 0` sempre, porque o
// "cumprido" do Legal Mail quer dizer "vinculada a petição protocolada POR ELES" e o escritório
// protocola no eProc. Quem fecha prazo hoje é o `prazos_fechar_1730`, de graça, pelo
// GET /api/v1/pleading/notices-to-comply. `?fechados=1` religa, se um dia fizer falta.
//
// Gatilho: cron manda header x-reconcile-key = LEGALMAIL_WEBHOOK_KEY. Também aceita ?k=<token>
// para acionamento manual.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const GUARD = Deno.env.get("LEGALMAIL_WEBHOOK_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const K = "recon_5c1d8a3f";
const PAGE = 50;
const CUSTO_PAGINA = 0.05;   // R$ por requisição ao /notices (tabela oficial deles)
const TETO_PAGINAS = 30;     // teto da rodada INTEIRA = R$ 1,50. Trava de segurança, não meta.
const PASSO_MS = 400;        // 120 req/min em janela deslizante; 400ms deixa folga larga
const DIAS_PADRAO = 3;   // ~4 páginas = R$ 0,20/dia. Ver CUSTO MEDIDO no cabeçalho.
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reconcile(notices: unknown[]) {
  const r = await fetch(`${SB}/rest/v1/rpc/lm_reconcile`, {
    method: "POST", headers: sbH, body: JSON.stringify({ notices }),
  });
  return r.ok ? await r.json() : { erro: `rpc ${r.status} ${await r.text()}` };
}

// Estado de custo da rodada inteira, compartilhado pelos status: o teto é global, não por status.
type Rodada = { paginas: number; abortou: string | null };

// Puxa e grava página por página (cada página vira uma chamada de RPC pequena e rápida).
async function pullAndReconcile(
  status: string, since: string | null, maxPages: number,
  rodada: Rodada, debug: Record<string, unknown>[] | null,
) {
  let puxados = 0;
  const agg: Record<string, number> = { publicacoes: 0, prazos: 0, cumpridos: 0, excedidos: 0 };
  const erros: string[] = [];
  for (let p = 0; p < maxPages; p++) {
    if (rodada.abortou) break;
    if (rodada.paginas >= TETO_PAGINAS) {
      rodada.abortou = `teto de ${TETO_PAGINAS} páginas (R$ ${(TETO_PAGINAS*CUSTO_PAGINA).toFixed(2)}) atingido em "${status}"`;
      break;
    }
    if (rodada.paginas > 0) await dorme(PASSO_MS);
    const u = `${BASE}/api/v1/notices?api_key=${encodeURIComponent(API)}`
            + `&prazo_status=${encodeURIComponent(status)}&limit=${PAGE}&offset=${p*PAGE}`
            + (since ? `&data_captura_inicio=${since}` : '')
            + `&ordenar_por=id&ordem=desc`;
    const r = await fetch(u, { headers: { "Accept": "application/json" } });
    rodada.paginas++;                       // conta ANTES de olhar o corpo: cobrado é cobrado
    const txt = await r.text();
    if (r.status === 429) {                 // regra 5 do LICOES.md: para no primeiro, não insiste
      rodada.abortou = `429 em "${status}" página ${p} (Retry-After: ${r.headers.get("Retry-After") ?? "?"})`;
      break;
    }
    if (r.status === 402) { rodada.abortou = `402 sem saldo em "${status}"`; break; }
    let j: any = {}; try { j = JSON.parse(txt); } catch { /* corpo não-JSON cai como página vazia */ }
    const arr = Array.isArray(j?.notices) ? j.notices : (Array.isArray(j) ? j : []);
    if (debug && p === 0) debug.push({ status, http: r.status, total: j?.total ?? null, amostra: txt.slice(0,160) });
    if (arr.length) {
      puxados += arr.length;
      const res = await reconcile(arr);
      if (res && !res.erro) {
        agg.publicacoes += res.publicacoes || 0;
        agg.prazos      += res.prazos      || 0;
        agg.cumpridos   += res.cumpridos   || 0;
        agg.excedidos   += res.excedidos   || 0;
      } else {
        erros.push(`pagina ${p}: ${res?.erro}`);
      }
    }
    if (arr.length < PAGE) break;
  }
  return { puxados, agg, erros };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const okAuth = (GUARD && req.headers.get("x-reconcile-key") === GUARD) || url.searchParams.get("k") === K;
  if (GUARD && !okAuth) return new Response("unauthorized", { status: 401 });
  if (!API) {
    return new Response(JSON.stringify({ skipped: "LEGALMAIL_API_KEY não configurada" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  const debug = url.searchParams.get("debug") ? [] as Record<string, unknown>[] : null;
  const dias = Math.max(1, Math.min(60, parseInt(url.searchParams.get("dias") || String(DIAS_PADRAO), 10) || DIAS_PADRAO));
  // JANELA É O PADRÃO. `?tudo=1` tira o filtro de captura, mas o TETO_PAGINAS continua valendo:
  // uma varredura do acervo inteiro (67 páginas) NÃO cabe numa chamada — ela para em 30 e
  // devolve `completo:false`. Isso é de propósito: reconstrução em massa é decisão consciente.
  const semJanela = url.searchParams.get("tudo") === "1";
  const since = semJanela ? null : new Date(Date.now() - dias*86400000).toISOString().slice(0,10);
  const comFechados = url.searchParams.get("fechados") === "1";

  let puxados = 0;
  const agg: Record<string, number> = { publicacoes: 0, prazos: 0, cumpridos: 0, excedidos: 0 };
  const erros: string[] = [];
  const rodada: Rodada = { paginas: 0, abortou: null };
  // "pendente" é o único que CRIA prazo, e agora respeita a janela — era o `null` cravado aqui
  // que gerou os R$ 461. cumprido/excedido só entram sob `?fechados=1` (ver cabeçalho).
  const plano: [string, string|null, number][] = comFechados
    ? [["pendente", since, TETO_PAGINAS], ["cumprido", since, TETO_PAGINAS], ["excedido", since, TETO_PAGINAS]]
    : [["pendente", since, TETO_PAGINAS]];
  for (const [st, s, mp] of plano) {
    if (rodada.abortou) break;
    try {
      const res = await pullAndReconcile(st, s, mp, rodada, debug);
      puxados += res.puxados;
      agg.publicacoes += res.agg.publicacoes; agg.prazos += res.agg.prazos;
      agg.cumpridos += res.agg.cumpridos; agg.excedidos += res.agg.excedidos;
      erros.push(...res.erros);
    } catch (e) { erros.push(`${st}: ${String(e)}`); }
  }

  const completo = !rodada.abortou && erros.length === 0;
  const corpo: Record<string, unknown> = {
    completo,
    janela: since ? `captura >= ${since} (${dias}d)` : "SEM JANELA (?tudo=1) — acervo inteiro",
    paginas_cobradas: rodada.paginas,
    custo_estimado_brl: Number((rodada.paginas * CUSTO_PAGINA).toFixed(2)),
    puxados, ...agg,
  };
  // Rodada incompleta não devolve número tranquilizador: já reportei "0 em aberto" numa rodada
  // que tinha falhado 87/87. Ver LICOES.md.
  if (!completo) {
    corpo.publicacoes = null; corpo.prazos = null;
    corpo.cumpridos = null; corpo.excedidos = null;
    corpo.aviso = `RODADA INCOMPLETA — ${rodada.abortou ?? erros.join("; ")}. Os números foram omitidos de propósito.`;
  }
  if (rodada.abortou) corpo.abortou_em = rodada.abortou;
  if (erros.length) corpo.erros = erros;
  if (debug) corpo.debug = debug;
  return new Response(JSON.stringify(corpo), { status: 200, headers: { "Content-Type": "application/json" } });
});
