#!/usr/bin/env node
/**
 * Robô DJEN (Comunica API / CNJ) — Becker Advogados
 * --------------------------------------------------
 * Busca as publicações/intimações oficiais e grava na tabela `publicacoes`.
 *
 * ⚠️ A API do DJEN é BLOQUEADA por país (só responde de IP do Brasil).
 *    Por isso este robô roda no Oracle Free Tier em região BRASIL (São Paulo),
 *    NÃO no GitHub. É o motivo de usarmos o Oracle.
 *
 * Requisitos: Node 18+ (fetch nativo). Sem dependências.
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  (obrigatórias)
 *   DJEN_OABS   (opcional) lista de OABs do escritório, ex.: "12345/SC,67890/SC"
 *               Se definido, busca por OAB (pega até intimações de processos novos).
 *               Se vazio, busca pelos CNJs já cadastrados.
 *   DJEN_DIAS   (opcional) janela de dias para trás (padrão 15)
 */

const SB  = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_KEY;
const OABS = (process.env.DJEN_OABS || '').split(',').map(s => s.trim()).filter(Boolean);
const DIAS = parseInt(process.env.DJEN_DIAS || '15', 10);

if (!SB || !SVC) { console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }

const sbHeaders = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const API = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';

function ymd(d) { return d.toISOString().slice(0, 10); }
function janela() {
  const fim = new Date();
  const ini = new Date(Date.now() - DIAS * 86400000);
  return { ini: ymd(ini), fim: ymd(fim) };
}

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
// upsert por djen_id (ignora duplicados que já existem)
async function sbUpsert(rows) {
  if (!rows.length) return 0;
  const r = await fetch(`${SB}/rest/v1/publicacoes?on_conflict=djen_id`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`UPSERT publicacoes -> ${r.status} ${await r.text()}`);
  return rows.length;
}

async function consultarDJENpagina(params, pagina) {
  const qs = new URLSearchParams({ ...params, pagina: String(pagina), itensPorPagina: '100' });
  const r = await fetch(`${API}?${qs}`, { headers: { Accept: 'application/json' } });
  if (r.status === 403) throw new Error('403 (bloqueio de país — rode de um IP do Brasil / Oracle SP)');
  if (!r.ok) throw new Error(`DJEN -> ${r.status}`);
  const j = await r.json();
  return j?.items || j?.data || [];
}
// pega TODAS as páginas (para de buscar quando a página vem incompleta)
async function consultarDJEN(params) {
  let todos = [], pagina = 1;
  for (;;) {
    const lote = await consultarDJENpagina(params, pagina);
    todos = todos.concat(lote);
    if (lote.length < 100 || pagina >= 50) break; // fim ou trava de segurança
    pagina++;
    await sleep(300);
  }
  return todos;
}

function normaliza(item, mapaProc) {
  const num = String(item.numero_processo || item.numeroProcesso || '').replace(/\D/g, '');
  const adv = (item.destinatarioadvogados || [])[0]?.advogado;
  return {
    djen_id: String(item.id ?? item.hash ?? `${num}-${item.data_disponibilizacao}`),
    processo_id: mapaProc.get(num) || null,
    numero_processo: item.numero_processo || item.numeroProcesso || null,
    tribunal: item.siglaTribunal || item.tribunal || null,
    tipo: item.tipoComunicacao || item.tipoDocumento || item.nomeClasse || 'Publicação',
    data_disponibilizacao: (item.data_disponibilizacao || item.dataDisponibilizacao || '').slice(0, 10) || null,
    texto: (item.texto || '').slice(0, 8000),
    link: item.link || null,
    oab: adv ? `${adv.numero_oab || ''}/${adv.uf_oab || ''}` : null,
    destinatario: (item.destinatarios || [])[0]?.nome || adv?.nome || null
  };
}

async function main() {
  console.log(`[${new Date().toISOString()}] Robô DJEN iniciado`);
  const { ini, fim } = janela();

  // mapa CNJ(dígitos) -> processo_id para vincular
  const procs = await sbGet('processos?select=id,numero&limit=5000');
  const mapaProc = new Map();
  procs.forEach(p => { const dg = String(p.numero || '').replace(/\D/g, ''); if (dg.length === 20) mapaProc.set(dg, p.id); });

  let total = 0, gravados = 0, erros = 0;
  const alvos = OABS.length
    ? OABS.map(o => { const [n, uf] = o.split('/'); return { numeroOab: (n || '').trim(), ufOab: (uf || '').trim(), dataDisponibilizacaoInicio: ini, dataDisponibilizacaoFim: fim }; })
    : [...mapaProc.keys()].map(dg => ({ numeroProcesso: dg }));

  console.log(`Modo: ${OABS.length ? 'por OAB' : 'por processo'} | alvos: ${alvos.length} | janela: ${ini}..${fim}`);

  for (const params of alvos) {
    try {
      const items = await consultarDJEN(params);
      total += items.length;
      const linhas = items.map(it => normaliza(it, mapaProc)).filter(l => l.djen_id);
      gravados += await sbUpsert(linhas);
    } catch (e) {
      erros++;
      console.error(`  ! ${JSON.stringify(params).slice(0, 60)}: ${e.message}`);
      if (String(e.message).includes('bloqueio de país')) { console.error('ABORTANDO: precisa rodar de IP do Brasil.'); break; }
    }
    await sleep(400);
  }

  console.log(`[${new Date().toISOString()}] Fim DJEN. encontrados=${total} gravados(novos)=${gravados} erros=${erros}`);
}

main().catch(e => { console.error('FALHA GERAL:', e); process.exit(1); });
