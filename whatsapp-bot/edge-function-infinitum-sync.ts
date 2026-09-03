// Edge Function `infinitum-sync` — puxa cards de 5 POPs jurídicos do Infinitum e
// alimenta telas que já existem no Sistema Becker (não cria tela nova):
//   - Controladoria / INTIMAÇÕES (intimação/publicação)  -> publicacoes/prazos
//     (mesmas tabelas do Legal Mail, com `fonte='infinitum'`)
//   - Peticionamento / Protocolo-Distribuição / Produção jurídica inicial
//     -> infinitum_producao_juridica (painel "Produção Jurídica" na tela do Processo
//     e a aba Becker IA -> Resumo Processual)
// Todos os 5 POPs também gravam em infinitum_producao_juridica (visão unificada).
//
// Regra importante: a RPC que grava no Postgres é chamada UMA VEZ POR PÁGINA (no
// máximo 20 cards), nunca acumulando várias páginas num array só — foi exatamente
// isso que estourou o statement_timeout do Postgres e perdeu dado inteiro numa
// rodada do legalmail-reconcile (ver whatsapp-bot/edge-function-legalmail-reconcile.ts).
//
// Segredos (Supabase -> Edge Functions -> infinitum-sync -> Secrets):
//   INFINITUM_PUBLIC_TOKEN  = o X-Public-Token do painel de integrações do Infinitum.
//   INFINITUM_ORG_ID        = id da organização (Becker Advogados Associados).
//   INFINITUM_BASE          = opcional, default https://public.infinitum.app.br
//   INFINITUM_SYNC_KEY      = chave inventada pra proteger o disparo (header
//                             x-infinitum-sync-key), mesmo papel do LEGALMAIL_WEBHOOK_KEY.
//   (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem no ambiente.)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB    = Deno.env.get("SUPABASE_URL")!;
const SVC   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("INFINITUM_PUBLIC_TOKEN") || "";
const ORG_ID = Deno.env.get("INFINITUM_ORG_ID") || "";
const BASE  = Deno.env.get("INFINITUM_BASE") || "https://public.infinitum.app.br";
const GUARD = Deno.env.get("INFINITUM_SYNC_KEY") || "";

const PAGE = 20;               // limite máximo documentado pelo Infinitum pra /cards
const MAX_PAGES = 25;          // até 500 cards por POP; a paginação para sozinha quando acaba
const DETAIL_CONCURRENCY = 8;

const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const infH = { "X-Public-Token": TOKEN, "Accept": "application/json" };

// POPs relevantes pro jurídico (dos 8 da conta — os outros 3, CRM Comercial/Ativação
// do cliente/Cobrança de Inadimplentes, ficam de fora por não terem aba no sistema).
// São POPs de template do sistema (is_system_default) — não devem mudar de id, mas
// se mudarem/forem renomeados, é só atualizar esta lista, sem precisar redesenhar nada.
const POPS = [
  { id: "f86ec8f2-e029-4bc0-b7c8-bf884f6b57aa", nome: "Controladoria", intimacao: true },
  { id: "48ae87ae-720a-4dc2-906c-80e62e6479a0", nome: "INTIMAÇÕES", intimacao: true },
  { id: "91a7cc61-d7fb-473d-9ebe-267539f036b8", nome: "Peticionamento", intimacao: false },
  { id: "693e447e-79bb-4195-b1f4-4d7c377caf45", nome: "Protocolo/Distribuição", intimacao: false },
  { id: "ee96b6f5-a87c-4e3e-a82e-e88225e1f9c9", nome: "Produção jurídica inicial", intimacao: false },
];

function qs(params: Record<string, string>): string {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

async function infGet(path: string, params: Record<string, string> = {}): Promise<{ ok: boolean; status: number; data: any; raw: string }> {
  const u = `${BASE}${path}${Object.keys(params).length ? "?" + qs(params) : ""}`;
  const r = await fetch(u, { headers: infH });
  const raw = await r.text();
  let j: any = {}; try { j = JSON.parse(raw); } catch { /* */ }
  return { ok: r.ok, status: r.status, data: j?.data, raw };
}

async function rpc(fn: string, body: unknown) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: sbH, body: JSON.stringify(body) });
  return r.ok ? await r.json() : { erro: `rpc ${fn} ${r.status} ${await r.text()}` };
}

Deno.serve(async (req: Request) => {
  if (GUARD) {
    const got = req.headers.get("x-infinitum-sync-key") || "";
    if (got !== GUARD) return new Response("unauthorized", { status: 401 });
  }
  if (!TOKEN || !ORG_ID) {
    return new Response(JSON.stringify({ skipped: "INFINITUM_PUBLIC_TOKEN/INFINITUM_ORG_ID não configurados" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") ? [] as Record<string, unknown>[] : null;

  let paginas = 0, cartoes = 0, publicacoes = 0, prazos = 0, gravados = 0, vinculados = 0;
  let listHasValues: boolean | null = null;
  const erros: string[] = [];

  for (const pop of POPS) {
    try {
      // fases (uma vez por POP, só pra enriquecer nome/conclusão de cada card)
      const fasesResp = await infGet(`/api/v1/public/pops/${pop.id}/with-phases`);
      const fases = Array.isArray(fasesResp.data?.phases) ? fasesResp.data.phases : [];
      const faseMap = new Map<string, { nome: string; completa: boolean }>();
      for (const f of fases) faseMap.set(f.id, { nome: f.name, completa: !!f.is_completion_phase });

      for (let p = 1; p <= MAX_PAGES; p++) {
        const pageResp = await infGet("/api/v1/public/cards", {
          organization_id: ORG_ID, pop_id: pop.id, page: String(p), limit: String(PAGE),
        });
        const arr: any[] = Array.isArray(pageResp.data) ? pageResp.data : [];
        if (debug && p === 1) {
          debug.push({ pop: pop.nome, http: pageResp.status, total: arr.length, amostra: pageResp.raw.slice(0, 200) });
        }
        if (!arr.length) break;
        paginas++;

        // detecta se a listagem já traz `values` (senão busca detalhe por card)
        if (listHasValues === null) {
          const comConteudo = arr.find((c) => c && c.id);
          if (comConteudo) listHasValues = Object.prototype.hasOwnProperty.call(comConteudo, "values");
        }

        let pageCards = arr;
        if (listHasValues === false) {
          const merged: any[] = new Array(arr.length);
          for (let i = 0; i < arr.length; i += DETAIL_CONCURRENCY) {
            const lote = arr.slice(i, i + DETAIL_CONCURRENCY);
            const detalhes = await Promise.all(lote.map(async (c) => {
              try {
                const d = await infGet(`/api/v1/public/cards/${c.id}`);
                return d.data || c;
              } catch (e) {
                erros.push(`pop ${pop.nome} pagina ${p} card ${c.id}: detalhe falhou (${String(e)})`);
                return { ...c, values: [] };
              }
            }));
            for (let k = 0; k < lote.length; k++) merged[i + k] = detalhes[k];
          }
          pageCards = merged;
        }

        // enriquece com nome do POP/fase antes de gravar
        const enriquecidos = pageCards.map((c) => {
          const fase = faseMap.get(c.phase_id);
          return { ...c, pop_id: pop.id, pop_name: pop.nome, phase_name: fase?.nome, phase_is_completion: fase?.completa || false };
        });

        cartoes += enriquecidos.length;

        const resProd = await rpc("infinitum_upsert_producao", { cards: enriquecidos });
        if (resProd?.erro) erros.push(`pop ${pop.nome} pagina ${p} (producao): ${resProd.erro}`);
        else { gravados += resProd?.gravados || 0; vinculados += resProd?.vinculados || 0; }

        if (pop.intimacao) {
          const resInt = await rpc("infinitum_reconcile_intimacoes", { cards: enriquecidos });
          if (resInt?.erro) erros.push(`pop ${pop.nome} pagina ${p} (intimacoes): ${resInt.erro}`);
          else { publicacoes += resInt?.publicacoes || 0; prazos += resInt?.prazos || 0; }
        }

        if (arr.length < PAGE) break;
      }
    } catch (e) {
      erros.push(`pop ${pop.nome}: ${String(e)}`);
    }
  }

  return new Response(JSON.stringify({
    pops: POPS.length, paginas, cartoes, gravados, vinculados, publicacoes, prazos,
    list_has_values: listHasValues,
    erros: erros.length ? erros : undefined,
    ...(debug ? { debug } : {}),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});
