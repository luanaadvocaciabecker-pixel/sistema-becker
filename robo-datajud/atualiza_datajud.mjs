#!/usr/bin/env node
/**
 * Robô DataJud — Becker Advogados
 * ---------------------------------
 * Lê todos os processos cadastrados no Supabase, consulta a API Pública do
 * DataJud (CNJ) para cada CNJ e grava as movimentações novas na tabela
 * `movimentacoes`. Feito para rodar no servidor Oracle Free Tier (IP não
 * bloqueado pelos tribunais), 1x por dia via cron.
 *
 * Requisitos: Node 18+ (usa fetch nativo). Nenhuma dependência externa.
 *
 * Variáveis de ambiente (definidas no servidor, NUNCA no código):
 *   SUPABASE_URL          ex: https://fnuzhypsqvyolqqafrba.supabase.co
 *   SUPABASE_SERVICE_KEY  a chave service_role do projeto (escreve ignorando RLS)
 *   DATAJUD_APIKEY        a chave pública do DataJud (copiar do wiki do CNJ)
 *
 * Uso:  node atualiza_datajud.mjs
 */

const SB  = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_KEY;
const KEY = process.env.DATAJUD_APIKEY;

if (!SB || !SVC || !KEY) {
  console.error('Faltam variáveis de ambiente: SUPABASE_URL, SUPABASE_SERVICE_KEY, DATAJUD_APIKEY');
  process.exit(1);
}

const sbHeaders = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- mapeia o número CNJ -> endpoint (alias) do DataJud ----
// CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO  (J = segmento, TR = tribunal)
const TJ = {
  '01':'tjac','02':'tjal','03':'tjap','04':'tjam','05':'tjba','06':'tjce',
  '07':'tjdft','08':'tjes','09':'tjgo','10':'tjma','11':'tjmt','12':'tjms',
  '13':'tjmg','14':'tjpa','15':'tjpb','16':'tjpr','17':'tjpe','18':'tjpi',
  '19':'tjrj','20':'tjrn','21':'tjrs','22':'tjro','23':'tjrr','24':'tjsc',
  '25':'tjse','26':'tjsp','27':'tjto'
};
function aliasDataJud(dg) {
  if (dg.length !== 20) return null;
  const seg = dg.charAt(13);
  const tr  = dg.substr(14, 2);
  const trn = parseInt(tr, 10);
  if (seg === '8') return TJ[tr] || null;               // Justiça Estadual
  if (seg === '5') return tr === '00' ? 'tst' : 'trt' + trn; // Justiça do Trabalho
  if (seg === '4') return trn ? 'trf' + trn : null;     // Justiça Federal
  if (seg === '6') return tr === '00' ? 'tse' : 'tre-' + (TJ[tr] ? TJ[tr].slice(2) : tr); // Eleitoral (raro)
  return null; // demais segmentos não suportados por ora
}

// ---- Supabase REST helpers ----
async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbInsert(table, rows) {
  if (!rows.length) return;
  const r = await fetch(`${SB}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`INSERT ${table} -> ${r.status} ${await r.text()}`);
}

// ---- DataJud ----
async function sbPatch(table, filtro, body) {
  const r = await fetch(`${SB}/rest/v1/${table}?${filtro}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`PATCH ${table} -> ${r.status} ${await r.text()}`);
}
async function consultarDataJud(alias, dg) {
  const r = await fetch(`https://api-publica.datajud.cnj.jus.br/api_publica_${alias}/_search`, {
    method: 'POST',
    headers: { Authorization: `APIKey ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { match: { numeroProcesso: dg } }, size: 1 })
  });
  if (!r.ok) throw new Error(`DataJud ${alias} -> ${r.status}`);
  const j = await r.json();
  return j?.hits?.hits?.[0]?._source || null; // devolve o _source inteiro
}
// monta um update só com os campos do processo que estão VAZIOS hoje
function enriquecer(p, src) {
  const vazio = v => v === null || v === undefined || String(v).trim() === '';
  const up = {};
  const classe = src.classe?.nome;
  const assunto = (src.assuntos || []).map(a => a.nome).filter(Boolean).join('; ');
  const orgao = src.orgaoJulgador?.nome;
  const trib = src.tribunal;
  if (classe && vazio(p.classe_processual)) up.classe_processual = classe;
  if (assunto && vazio(p.assunto)) up.assunto = assunto;
  if (orgao && vazio(p.vara)) up.vara = orgao;
  if (trib && vazio(p.tribunal)) up.tribunal = trib;
  return up;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Robô DataJud iniciado`);
  const processos = await sbGet('processos?select=id,numero,classe_processual,assunto,vara,tribunal&processo_pai_id=is.null&limit=5000');
  console.log(`Processos a verificar: ${processos.length}`);

  let novos = 0, ok = 0, semNumero = 0, semAlias = 0, erros = 0, enriquecidos = 0;

  for (const p of processos) {
    const dg = String(p.numero || '').replace(/\D/g, '');
    if (dg.length !== 20) { semNumero++; continue; }
    const alias = aliasDataJud(dg);
    if (!alias) { semAlias++; continue; }

    try {
      const src = await consultarDataJud(alias, dg);
      if (!src) { ok++; await sleep(300); continue; }

      // 1) preencher campos vazios do processo
      const up = enriquecer(p, src);
      if (Object.keys(up).length) { await sbPatch('processos', `id=eq.${p.id}`, up); enriquecidos++; }

      // 2) importar movimentações novas (dedupe por data+descrição)
      const movs = src.movimentos || [];
      if (movs.length) {
        const existentes = await sbGet(`movimentacoes?processo_id=eq.${p.id}&select=data,descricao`);
        const vistos = new Set(existentes.map(m => `${m.data}|${(m.descricao || '').slice(0, 120)}`));
        const inserir = [];
        for (const m of movs) {
          const data = (m.dataHora || '').slice(0, 10) || null;
          const desc = m.nome || (m.complementosTabelados?.map(c => c.nome).join('; ')) || 'Movimentação';
          const chave = `${data}|${desc.slice(0, 120)}`;
          if (data && !vistos.has(chave)) {
            vistos.add(chave);
            inserir.push({ processo_id: p.id, data, tipo: 'DataJud', descricao: desc, usuario: 'Robô DataJud' });
          }
        }
        if (inserir.length) { await sbInsert('movimentacoes', inserir); novos += inserir.length; }
      }
      ok++;
    } catch (e) {
      erros++;
      console.error(`  ! ${p.numero}: ${e.message}`);
    }
    await sleep(300); // ~3 req/s, dentro do limite do DataJud
  }

  console.log(`[${new Date().toISOString()}] Fim. consultados=${ok} novos_andamentos=${novos} processos_enriquecidos=${enriquecidos} sem_numero=${semNumero} sem_alias=${semAlias} erros=${erros}`);
}

main().catch(e => { console.error('FALHA GERAL:', e); process.exit(1); });
