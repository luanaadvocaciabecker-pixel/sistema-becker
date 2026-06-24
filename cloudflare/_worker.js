const SUPA_URL = 'https://fnuzhypsqvyolqqafrba.supabase.co';
const SUPA_KEY = 'sb_publishable_QVrl-Cxs9FNjC7Pf9aHazQ_aGEk0PiO';
const TIPOS_MOVIMENTACAO_PROCESSUAL = ['DataJud', 'TJSC/eproc', 'Tribunal', 'Diário Oficial', 'JusBrasil', 'Manual'];
const FILTRO_MOVIMENTACAO_PROCESSUAL = `tipo=in.(${TIPOS_MOVIMENTACAO_PROCESSUAL.map(encodeURIComponent).join(',')})`;
const DATAJUD_KEY = 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-becker-robot-token'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: jsonHeaders
  });
}

function cleanCnj(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function todayIso() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDaysIso(dateIso, days) {
  const date = new Date(`${dateIso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const from = new Date(`${fromIso}T12:00:00Z`);
  const to = new Date(`${toIso}T12:00:00Z`);
  return Math.round((to - from) / 86400000);
}

function normalizePrazo(prazo) {
  const processo = Array.isArray(prazo.processos) ? prazo.processos[0] : prazo.processos;
  const cliente = Array.isArray(processo?.clientes) ? processo.clientes[0] : processo?.clientes;
  const data = prazo.data || prazo.data_prazo || null;
  const hoje = todayIso();
  const dias = data ? daysBetween(hoje, data) : null;
  let risco = 'medio';
  if (dias !== null && dias < 0) risco = 'critico';
  else if (dias === 0) risco = 'alto';
  else if (dias !== null && dias <= 2) risco = 'alto';
  else if (!processo?.advogado_responsavel) risco = 'alto';

  return {
    id: prazo.id,
    processo: processo?.numero || null,
    cliente: cliente?.nome || null,
    tribunal: processo?.tribunal || null,
    responsavel: processo?.advogado_responsavel || null,
    descricao: prazo.descricao || null,
    tipo: prazo.tipo || null,
    status: prazo.status || (prazo.cumprido ? 'Cumprido' : 'Pendente'),
    data,
    dias,
    risco
  };
}

async function supabaseFetch(path, env) {
  const key = env.SUPABASE_ANON_KEY || env.SUPA_KEY || SUPA_KEY;
  const url = env.SUPABASE_URL || env.SUPA_URL || SUPA_URL;
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function supabaseWrite(path, env, { method = 'POST', body, prefer = 'return=representation' } = {}) {
  const key = env.SUPABASE_ANON_KEY || env.SUPA_KEY || SUPA_KEY;
  const url = env.SUPABASE_URL || env.SUPA_URL || SUPA_URL;
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      'content-type': 'application/json',
      prefer
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function requireRobotToken(request, env) {
  const configured = env.BECKER_ROBOT_TOKEN;
  if (!configured) return true;
  const provided = request.headers.get('x-becker-robot-token') || '';
  return provided && provided === configured;
}

function isProtocolEvent(evento) {
  const texto = `${evento.descricao || ''} ${evento.tipo || ''}`.toLowerCase();
  return /(protocol|peti[cç][aã]o|manifesta[cç][aã]o|juntad|interposi[cç][aã]o|recurso|agravo|contesta[cç][aã]o|r[eé]plica)/i.test(texto);
}

function isBeckerProtocol(evento) {
  if (evento.protocolo_becker === true || evento.becker === true) return true;
  const ator = `${evento.autor || ''} ${evento.origem || ''} ${evento.usuario || ''} ${evento.advogado || ''}`.toLowerCase();
  return /(becker|cibele|alana|andressa|luana|samaira|oab\/?sc|oab-sc)/i.test(ator);
}

function fontePerfil(nome) {
  const key = String(nome || '').toLowerCase();
  if (/tjsc|eproc|trt12|pje|pdpj|mni|tribunal/.test(key)) {
    return { tipo: 'oficial_autenticada', confianca_base: 95, pode_cumprir_prazo: true };
  }
  if (/datajud|cnj/.test(key)) {
    return { tipo: 'oficial_publica', confianca_base: 85, pode_cumprir_prazo: true };
  }
  if (/diario|dje|di[aá]rio/.test(key)) {
    return { tipo: 'publicacao_oficial', confianca_base: 75, pode_cumprir_prazo: false };
  }
  if (/jusbrasil|escavador|fornecedor|comercial/.test(key)) {
    return { tipo: 'comercial', confianca_base: 60, pode_cumprir_prazo: false };
  }
  return { tipo: 'robo_interno', confianca_base: 70, pode_cumprir_prazo: false };
}

function tribunalDataJud(tribunal) {
  const key = String(tribunal || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key.includes('TRT12')) return 'api_publica_trt12';
  if (key.includes('TRF04') || key.includes('TRF4')) return 'api_publica_trf4';
  if (key.includes('TJPR')) return 'api_publica_tjpr';
  if (key.includes('TJSP')) return 'api_publica_tjsp';
  if (key.includes('TJRS')) return 'api_publica_tjrs';
  if (key.includes('TJSC')) return 'api_publica_tjsc';
  if (key.includes('STJ')) return 'api_publica_stj';
  if (key.includes('TST')) return 'api_publica_tst';
  return 'api_publica_tjsc';
}

function dataMovimento(movimento) {
  const raw = movimento.dataHora || movimento.data || movimento.data_evento || todayIso();
  return String(raw).slice(0, 10);
}

function descricaoMovimento(movimento) {
  return String(movimento.nome || movimento.complemento || movimento.descricao || 'Movimentação DataJud').trim();
}

function detectarSituacaoPorMovimentos(movimentos) {
  const texto = movimentos
    .slice(0, 10)
    .map((m) => descricaoMovimento(m))
    .join(' ')
    .toLowerCase();
  if (/(baixa definitiva|baixad[oa]|arquivad[oa] definitivamente|tr[âa]nsito em julgado.*baixa|remetid[oa] ao arquivo)/i.test(texto)) {
    return 'Arquivado';
  }
  if (/(suspens[aã]o|sobrestad[oa]|suspenso)/i.test(texto)) return 'Suspenso';
  return null;
}

async function consultarDataJudProcesso(processo, env) {
  const endpoint = tribunalDataJud(processo.tribunal);
  const key = env.DATAJUD_API_KEY || DATAJUD_KEY;
  const response = await fetch(`https://api-publica.datajud.cnj.jus.br/${endpoint}/_search`, {
    method: 'POST',
    headers: {
      authorization: `APIKey ${key}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      size: 1,
      query: { match: { numeroProcesso: cleanCnj(processo.numero) } },
      sort: [{ dataHoraUltimaAtualizacao: { order: 'desc' } }]
    })
  });

  if (!response.ok) {
    throw new Error(`DataJud ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  return { endpoint, hit: body?.hits?.hits?.[0]?._source || null };
}

async function handleDataJudAtualizarLote(request, env) {
  const body = await request.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body.limit || 20), 20));
  const offset = Math.max(0, Number(body.offset || 0));

  const processos = await supabaseFetch(
    `processos?select=id,numero,tribunal,situacao&numero=not.is.null&numero=neq.&situacao=eq.Ativo&order=id.asc&limit=${limit}&offset=${offset}`,
    env
  );

  let consultados = 0;
  let encontrados = 0;
  let movimentacoes_importadas = 0;
  let situacoes_atualizadas = 0;
  const erros = [];

  for (const processo of processos) {
    consultados += 1;
    try {
      const { endpoint, hit } = await consultarDataJudProcesso(processo, env);
      if (!hit) continue;
      encontrados += 1;

      const movimentos = (hit.movimentos || [])
        .slice()
        .sort((a, b) => new Date(dataMovimento(b)) - new Date(dataMovimento(a)))
        .slice(0, 10);

      if (movimentos.length) {
        const existentes = await supabaseFetch(
          `movimentacoes?select=data,descricao&processo_id=eq.${processo.id}&tipo=eq.DataJud`,
          env
        );
        const chaves = new Set((existentes || []).map((m) => `${m.data}|${m.descricao}`));
        const novas = movimentos
          .map((movimento) => ({
            processo_id: processo.id,
            data: dataMovimento(movimento),
            descricao: descricaoMovimento(movimento),
            tipo: 'DataJud',
            usuario: endpoint
          }))
          .filter((movimento) => !chaves.has(`${movimento.data}|${movimento.descricao}`));

        if (novas.length) {
          await supabaseWrite('movimentacoes', env, { body: novas });
          movimentacoes_importadas += novas.length;
        }
      }

      const situacao = detectarSituacaoPorMovimentos(movimentos);
      if (situacao && situacao !== processo.situacao) {
        await supabaseWrite(`processos?id=eq.${processo.id}`, env, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: { situacao }
        });
        situacoes_atualizadas += 1;
      }
    } catch (error) {
      erros.push({ processo: processo.numero, erro: error.message });
    }
  }

  return json({
    offset,
    limit,
    consultados,
    encontrados,
    movimentacoes_importadas,
    situacoes_atualizadas,
    erros: erros.length,
    erros_amostra: erros.slice(0, 5),
    terminou: processos.length < limit,
    proximo_offset: offset + processos.length
  });
}

async function handleDataJudConsultar(request, env) {
  const body = await request.json().catch(() => ({}));
  const processo = {
    id: body.processo_id || null,
    numero: body.numero || body.processo || '',
    tribunal: body.tribunal || ''
  };
  if (!cleanCnj(processo.numero)) {
    return json({ erro: 'Informe um número CNJ válido.' }, 400);
  }
  const { endpoint, hit } = await consultarDataJudProcesso(processo, env);
  return json({ endpoint, processo: processo.numero, encontrado: Boolean(hit), hit });
}

function eventKey(evento) {
  return [
    cleanCnj(evento.processo || evento.numero || evento.cnj || ''),
    String(evento.data || evento.data_evento || '').slice(0, 10),
    String(evento.descricao || evento.movimento || evento.nome || '').trim().toLowerCase()
  ].join('|');
}

function normalizarEventoFonte(item, fontePadrao) {
  const fonte = item.fonte || fontePadrao || 'fonte_desconhecida';
  return {
    fonte,
    perfil: fontePerfil(fonte),
    processo: item.processo || item.numero || item.cnj || null,
    data: (item.data || item.data_evento || todayIso()).slice(0, 10),
    descricao: item.descricao || item.movimento || item.nome || 'Movimentação importada',
    tipo: item.tipo || fonte,
    evento: item.evento || item.id || null,
    autor: item.autor || item.usuario || item.advogado || null,
    protocolo_becker: item.protocolo_becker === true || item.becker === true,
    bruto: item
  };
}

function consolidarEventos(eventos) {
  const grupos = new Map();
  for (const evento of eventos) {
    const key = eventKey(evento);
    const atual = grupos.get(key) || {
      ...evento,
      fontes: [],
      confirmado_por: [],
      confianca: 0,
      divergente: false
    };
    atual.fontes.push(evento.fonte);
    atual.confirmado_por = [...new Set(atual.fontes)];
    atual.confianca = Math.min(
      99,
      Math.max(atual.confianca, evento.perfil.confianca_base) + Math.max(0, atual.confirmado_por.length - 1) * 8
    );
    atual.pode_cumprir_prazo = atual.confirmado_por.some((fonte) => fontePerfil(fonte).pode_cumprir_prazo);
    grupos.set(key, atual);
  }
  return [...grupos.values()].sort((a, b) => b.confianca - a.confianca);
}

async function findProcessoByNumero(numero, env) {
  const numeroBusca = encodeURIComponent(numero);
  let processos = await supabaseFetch(
    `processos?select=id,numero,tribunal,advogado_responsavel,situacao,clientes(nome,cpf_cnpj)&numero=eq.${numeroBusca}&limit=1`,
    env
  );

  if (!processos.length) {
    const numeroLimpo = cleanCnj(numero);
    const candidatos = await supabaseFetch(
      'processos?select=id,numero,tribunal,advogado_responsavel,situacao,clientes(nome,cpf_cnpj)&numero=not.is.null',
      env
    );
    processos = candidatos.filter((p) => cleanCnj(p.numero) === numeroLimpo).slice(0, 1);
  }

  return processos[0] || null;
}

async function fetchPrazosAbertosDoProcesso(processoId, env) {
  return supabaseFetch(
    `prazos?select=id,processo_id,descricao,tipo,status,cumprido,data,data_prazo&processo_id=eq.${processoId}&cumprido=eq.false&order=data.asc`,
    env
  );
}

async function fetchPrazosAbertos(env) {
  const prazos = await supabaseFetch(
    'prazos?select=id,processo_id,descricao,tipo,status,cumprido,data,data_prazo,processos(id,numero,tribunal,advogado_responsavel,situacao,clientes(nome,cpf_cnpj))&cumprido=eq.false&order=data.asc&limit=500',
    env
  );
  return prazos.map(normalizePrazo);
}

async function fetchProcessosPrincipais(env) {
  return supabaseFetch(
    'processos?select=id,numero,tribunal,advogado_responsavel,situacao,updated_at,clientes(nome,cpf_cnpj)&numero=not.is.null&limit=1000',
    env
  );
}

async function fetchMovimentacoes(env, limit = 2500) {
  return supabaseFetch(
    `movimentacoes?select=id,processo_id,data,descricao,tipo,processos(numero,tribunal,advogado_responsavel,clientes(nome))&${FILTRO_MOVIMENTACAO_PROCESSUAL}&order=data.desc&limit=${limit}`,
    env
  );
}

function processoResumo(processo, extra = {}) {
  const cliente = Array.isArray(processo.clientes) ? processo.clientes[0] : processo.clientes;
  return {
    id: processo.id,
    processo: processo.numero,
    cliente: cliente?.nome || null,
    cpf_cnpj: cliente?.cpf_cnpj || null,
    tribunal: processo.tribunal || null,
    responsavel: processo.advogado_responsavel || null,
    situacao: processo.situacao || null,
    ...extra
  };
}

async function handlePrazosPendentes(request, env) {
  const url = new URL(request.url);
  const limite = Number(url.searchParams.get('limit') || 100);
  const prazos = await fetchPrazosAbertos(env);
  return json({
    data_referencia: todayIso(),
    total: prazos.length,
    criticos: prazos.filter((p) => p.risco === 'critico').length,
    altos: prazos.filter((p) => p.risco === 'alto').length,
    prazos: prazos.slice(0, limite)
  });
}

async function handleProcessosParados(request, env) {
  const url = new URL(request.url);
  const dias = Number(url.searchParams.get('dias') || 30);
  const hoje = todayIso();
  const processos = await fetchProcessosPrincipais(env);
  const movimentacoes = await fetchMovimentacoes(env);
  const ultimaPorProcesso = new Map();

  for (const mov of movimentacoes) {
    if (!mov.processo_id || ultimaPorProcesso.has(mov.processo_id)) continue;
    ultimaPorProcesso.set(mov.processo_id, mov);
  }

  const parados = processos
    .map((p) => {
      const ultima = ultimaPorProcesso.get(p.id);
      const dataBase = ultima?.data || (p.updated_at ? p.updated_at.slice(0, 10) : null);
      const dias_sem_movimentacao = dataBase ? daysBetween(dataBase, hoje) : null;
      return processoResumo(p, {
        ultima_movimentacao_data: dataBase,
        ultima_movimentacao: ultima?.descricao || null,
        dias_sem_movimentacao,
        risco: !p.advogado_responsavel ? 'alto' : dias_sem_movimentacao >= 90 ? 'alto' : 'medio'
      });
    })
    .filter((p) => p.dias_sem_movimentacao === null || p.dias_sem_movimentacao >= dias)
    .sort((a, b) => (b.dias_sem_movimentacao ?? 9999) - (a.dias_sem_movimentacao ?? 9999));

  return json({
    data_referencia: hoje,
    criterio_dias: dias,
    total: parados.length,
    processos: parados.slice(0, Number(url.searchParams.get('limit') || 100))
  });
}

async function handleConferencia(request, env) {
  const prazos = await fetchPrazosAbertos(env);
  const movimentacoes = await fetchMovimentacoes(env, 500);
  const hoje = todayIso();
  const seteDiasAtras = addDaysIso(hoje, -7);
  const termos = /(intima|cita|despacho|senten|prazo|manifest|procura|emenda|protocolo|juntad)/i;

  const itens = [];
  for (const prazo of prazos) {
    if (!prazo.processo) {
      itens.push({ ...prazo, categoria: 'prazo_sem_processo', motivo: 'Prazo aberto sem processo vinculado.', prioridade: 'alta' });
    } else if (!prazo.responsavel) {
      itens.push({ ...prazo, categoria: 'prazo_sem_responsavel', motivo: 'Prazo aberto sem responsável principal.', prioridade: 'alta' });
    } else if (prazo.status && /confer/i.test(prazo.status)) {
      itens.push({ ...prazo, categoria: 'prazo_em_conferencia', motivo: 'Prazo marcado para conferência.', prioridade: 'media' });
    }
  }

  for (const mov of movimentacoes) {
    if (!mov.data || mov.data < seteDiasAtras || !termos.test(mov.descricao || '')) continue;
    const processo = Array.isArray(mov.processos) ? mov.processos[0] : mov.processos;
    const cliente = Array.isArray(processo?.clientes) ? processo.clientes[0] : processo?.clientes;
    itens.push({
      categoria: 'movimentacao_sensivel',
      motivo: 'Movimentação recente com termo sensível. Conferir se gera prazo, tarefa ou baixa.',
      prioridade: /intima|prazo|senten/i.test(mov.descricao || '') ? 'alta' : 'media',
      processo: processo?.numero || null,
      cliente: cliente?.nome || null,
      tribunal: processo?.tribunal || null,
      responsavel: processo?.advogado_responsavel || null,
      data: mov.data,
      descricao: mov.descricao || null,
      origem: mov.tipo || null
    });
  }

  return json({
    data_referencia: hoje,
    total: itens.length,
    alta_prioridade: itens.filter((i) => i.prioridade === 'alta').length,
    itens: itens.slice(0, 100)
  });
}

async function buildRisco(env) {
  const hoje = todayIso();
  const amanha = addDaysIso(hoje, 1);
  const em7 = addDaysIso(hoje, 7);
  const prazos = await fetchPrazosAbertos(env);
  const processos = await fetchProcessosPrincipais(env);

  const pendentes = prazos.filter((p) => p.data && p.data < hoje);
  const hojePrazos = prazos.filter((p) => p.data === hoje);
  const amanhaPrazos = prazos.filter((p) => p.data === amanha);
  const proximos7 = prazos.filter((p) => p.data && p.data >= hoje && p.data <= em7);
  const semResponsavel = processos.filter((p) => !p.advogado_responsavel);
  const porResponsavel = {};

  for (const prazo of prazos) {
    const key = prazo.responsavel || 'Sem responsável';
    porResponsavel[key] = (porResponsavel[key] || 0) + 1;
  }

  return {
    data_referencia: hoje,
    resumo: {
      prazos_abertos: prazos.length,
      prazos_vencidos: pendentes.length,
      prazos_hoje: hojePrazos.length,
      prazos_amanha: amanhaPrazos.length,
      prazos_7_dias: proximos7.length,
      processos_sem_responsavel: semResponsavel.length
    },
    por_responsavel: porResponsavel,
    alertas: [
      ...pendentes.map((p) => ({ categoria: 'prazo_vencido', prioridade: 'critica', ...p })),
      ...hojePrazos.map((p) => ({ categoria: 'prazo_hoje', prioridade: 'alta', ...p })),
      ...semResponsavel.slice(0, 20).map((p) => ({ categoria: 'processo_sem_responsavel', prioridade: 'alta', ...processoResumo(p) }))
    ].slice(0, 100)
  };
}

async function handleRiscoHoje(request, env) {
  return json(await buildRisco(env));
}

async function handlePainelManha(request, env) {
  const risco = await buildRisco(env);
  const conferencia = await handleConferencia(request, env).then((r) => r.json());
  const movimentacoes = await fetchMovimentacoes(env, 200);
  const hoje = todayIso();
  const movsHoje = movimentacoes.filter((m) => m.data === hoje);

  return json({
    tipo: 'painel_manha',
    data_referencia: hoje,
    novas_movimentacoes: movsHoje.length,
    prazos_hoje: risco.resumo.prazos_hoje,
    prazos_amanha: risco.resumo.prazos_amanha,
    prazos_vencidos: risco.resumo.prazos_vencidos,
    conferencia_pendente: conferencia.total,
    processos_sem_responsavel: risco.resumo.processos_sem_responsavel,
    prioridades: risco.alertas.slice(0, 15)
  });
}

async function handlePainelNoite(request, env) {
  const risco = await buildRisco(env);
  const conferencia = await handleConferencia(request, env).then((r) => r.json());
  const prazos = await fetchPrazosAbertos(env);
  const hoje = todayIso();

  return json({
    tipo: 'painel_noite',
    data_referencia: hoje,
    prazos_abertos: prazos.length,
    prazos_pendentes_criticos: risco.resumo.prazos_vencidos + risco.resumo.prazos_hoje,
    conferencia_pendente: conferencia.total,
    alerta_whatsapp: risco.resumo.prazos_vencidos + risco.resumo.prazos_hoje + conferencia.alta_prioridade > 0,
    por_responsavel: risco.por_responsavel,
    itens_para_alerta: [
      ...risco.alertas.filter((a) => a.prioridade === 'critica' || a.prioridade === 'alta'),
      ...conferencia.itens.filter((i) => i.prioridade === 'alta')
    ].slice(0, 30)
  });
}

async function registrarMovimentacao(processo, evento, fonte, env, dryRun) {
  const data = (evento.data || evento.data_evento || todayIso()).slice(0, 10);
  const descricao = evento.descricao || evento.movimento || evento.nome || 'Movimentação importada do tribunal';
  const tipo = evento.tipo || fonte || 'Tribunal';
  const existentes = await supabaseFetch(
    `movimentacoes?select=id,processo_id,data,descricao,tipo&processo_id=eq.${processo.id}&data=eq.${encodeURIComponent(data)}&descricao=eq.${encodeURIComponent(descricao)}&limit=1`,
    env
  );

  if (existentes.length) {
    return { movimentacao: existentes[0], duplicada: true };
  }

  const payload = {
    processo_id: processo.id,
    data,
    descricao,
    tipo,
    usuario: evento.autor || evento.usuario || fonte || 'Robô tribunal'
  };

  if (dryRun) {
    return { movimentacao: { id: null, ...payload }, duplicada: false, dry_run: true };
  }

  const inseridas = await supabaseWrite('movimentacoes', env, { body: [payload] });
  return { movimentacao: inseridas[0], duplicada: false };
}

async function cumprirPrazoAutomaticamente({ processo, prazo, movimentacao, evento, fonte, env, dryRun }) {
  const dataEvento = movimentacao.data || evento.data || todayIso();
  const motivo = 'Cumprido automaticamente: protocolo da Becker detectado e havia apenas 1 prazo aberto no processo.';
  const auditoria = {
    processo_id: processo.id,
    data: dataEvento.slice(0, 10),
    tipo: 'Auditoria',
    usuario: 'Robô Becker',
    descricao: `${motivo} Prazo ID ${prazo.id}. Evento: ${movimentacao.descricao || evento.descricao || 'sem descrição'}. Fonte: ${fonte || 'tribunal'}.`
  };

  if (dryRun) {
    return {
      prazo_id: prazo.id,
      acao: 'cumpriria_automaticamente',
      motivo,
      auditoria
    };
  }

  await supabaseWrite(`prazos?id=eq.${prazo.id}`, env, {
    method: 'PATCH',
    body: {
      cumprido: true,
      status: 'Cumprido automaticamente'
    },
    prefer: 'return=minimal'
  });
  await supabaseWrite('movimentacoes', env, { body: [auditoria] });

  return {
    prazo_id: prazo.id,
    acao: 'cumprido_automaticamente',
    motivo
  };
}

async function handleTribunalMovimentacoes(request, env) {
  if (!requireRobotToken(request, env)) {
    return json({ erro: 'Token do robô inválido ou ausente.' }, 401);
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ erro: 'JSON inválido.' }, 400);

  const processoNumero = body.processo || body.numero || body.cnj;
  const eventos = Array.isArray(body.eventos) ? body.eventos : (body.evento ? [body.evento] : []);
  const fonte = body.fonte || body.tribunal || 'Tribunal';
  const dryRun = body.dry_run === true;

  if (!processoNumero) return json({ erro: 'Informe o número do processo.' }, 400);
  if (!eventos.length) return json({ erro: 'Informe ao menos um evento.' }, 400);

  const processo = await findProcessoByNumero(processoNumero, env);
  if (!processo) return json({ erro: 'Processo não encontrado no sistema.', processo: processoNumero }, 404);

  const resultados = [];
  for (const evento of eventos) {
    const registro = await registrarMovimentacao(processo, evento, fonte, env, dryRun);
    const prazosAbertos = await fetchPrazosAbertosDoProcesso(processo.id, env);
    let cumprimento = {
      acao: 'nenhuma',
      motivo: 'Evento não cumpre os critérios de fechamento automático.'
    };

    if (isProtocolEvent(evento) && isBeckerProtocol(evento)) {
      if (prazosAbertos.length === 1) {
        cumprimento = await cumprirPrazoAutomaticamente({
          processo,
          prazo: prazosAbertos[0],
          movimentacao: registro.movimentacao,
          evento,
          fonte,
          env,
          dryRun
        });
      } else if (prazosAbertos.length > 1) {
        cumprimento = {
          acao: 'aguardando_conferencia',
          motivo: 'Protocolo da Becker detectado, mas há mais de um prazo aberto no processo.',
          prazos_abertos: prazosAbertos.map((p) => ({ id: p.id, descricao: p.descricao, data: p.data || p.data_prazo }))
        };
      } else {
        cumprimento = {
          acao: 'sem_prazo_aberto',
          motivo: 'Protocolo da Becker detectado, mas não havia prazo aberto no processo.'
        };
      }
    }

    resultados.push({
      evento: evento.evento || evento.id || null,
      data: registro.movimentacao.data,
      descricao: registro.movimentacao.descricao,
      movimentacao_id: registro.movimentacao.id,
      duplicada: registro.duplicada,
      protocolo: isProtocolEvent(evento),
      protocolo_becker: isBeckerProtocol(evento),
      prazos_abertos_antes: prazosAbertos.length,
      cumprimento
    });
  }

  return json({
    dry_run: dryRun,
    processo: processo.numero,
    tribunal: processo.tribunal || fonte,
    resultados
  });
}

async function handleFontesStatus(request, env) {
  return json({
    fontes: [
      { nome: 'DataJud/CNJ', tipo: 'oficial_publica', papel: 'capas e movimentações públicas', fechamento_automatico: true },
      { nome: 'TJSC/eproc', tipo: 'oficial_autenticada', papel: 'movimentações, protocolos e situação quando houver conector', fechamento_automatico: true },
      { nome: 'TRT12/PJe', tipo: 'oficial_autenticada', papel: 'movimentações, protocolos e situação quando houver conector', fechamento_automatico: true },
      { nome: 'PDPJ/MNI', tipo: 'oficial_autenticada', papel: 'eventos REST/webhook quando houver acesso autorizado', fechamento_automatico: true },
      { nome: 'Diário Oficial', tipo: 'publicacao_oficial', papel: 'publicações e intimações', fechamento_automatico: false },
      { nome: 'Fornecedor comercial', tipo: 'comercial', papel: 'monitoramento redundante por OAB/CNJ', fechamento_automatico: false },
      { nome: 'Robô interno', tipo: 'robo_interno', papel: 'ponte operacional entre fonte externa e API Becker', fechamento_automatico: false }
    ],
    regra: 'Fonte oficial/autenticada ou DataJud com confiança alta pode fechar prazo único. Fonte comercial ou publicação isolada gera conferência.'
  });
}

async function handleMultifonteMovimentacoes(request, env) {
  if (!requireRobotToken(request, env)) {
    return json({ erro: 'Token do robô inválido ou ausente.' }, 401);
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ erro: 'JSON inválido.' }, 400);

  const processoNumero = body.processo || body.numero || body.cnj;
  const fontePadrao = body.fonte || 'multifonte';
  const dryRun = body.dry_run === true;
  const eventosNormalizados = [];

  if (Array.isArray(body.fontes)) {
    for (const fonte of body.fontes) {
      const nomeFonte = fonte.fonte || fonte.nome || fontePadrao;
      for (const evento of fonte.eventos || []) {
        eventosNormalizados.push(normalizarEventoFonte({ ...evento, processo: evento.processo || processoNumero, fonte: nomeFonte }, nomeFonte));
      }
    }
  }

  for (const evento of body.eventos || []) {
    eventosNormalizados.push(normalizarEventoFonte({ ...evento, processo: evento.processo || processoNumero }, fontePadrao));
  }

  if (!processoNumero && !eventosNormalizados.some((e) => e.processo)) {
    return json({ erro: 'Informe o número do processo.' }, 400);
  }
  if (!eventosNormalizados.length) return json({ erro: 'Informe eventos de ao menos uma fonte.' }, 400);

  const processo = await findProcessoByNumero(processoNumero || eventosNormalizados[0].processo, env);
  if (!processo) return json({ erro: 'Processo não encontrado no sistema.', processo: processoNumero }, 404);

  const consolidados = consolidarEventos(eventosNormalizados);
  const resultados = [];

  for (const evento of consolidados) {
    const eventoParaRegistro = {
      ...evento,
      descricao: evento.descricao,
      tipo: evento.confirmado_por.length > 1 ? `Multi-fonte: ${evento.confirmado_por.join(', ')}` : evento.fonte,
      autor: evento.autor || evento.confirmado_por.join(', '),
      protocolo_becker: evento.protocolo_becker
    };
    const registro = await registrarMovimentacao(processo, eventoParaRegistro, evento.fonte, env, dryRun);
    const prazosAbertos = await fetchPrazosAbertosDoProcesso(processo.id, env);
    const protocolo = isProtocolEvent(evento) && isBeckerProtocol(evento);
    let cumprimento = {
      acao: 'nenhuma',
      motivo: 'Evento consolidado não cumpre critérios de fechamento automático.'
    };

    if (protocolo && evento.pode_cumprir_prazo && evento.confianca >= 85) {
      if (prazosAbertos.length === 1) {
        cumprimento = await cumprirPrazoAutomaticamente({
          processo,
          prazo: prazosAbertos[0],
          movimentacao: registro.movimentacao,
          evento,
          fonte: evento.confirmado_por.join(', '),
          env,
          dryRun
        });
      } else if (prazosAbertos.length > 1) {
        cumprimento = {
          acao: 'aguardando_conferencia',
          motivo: 'Protocolo confiável detectado, mas há mais de um prazo aberto no processo.',
          prazos_abertos: prazosAbertos.map((p) => ({ id: p.id, descricao: p.descricao, data: p.data || p.data_prazo }))
        };
      } else {
        cumprimento = {
          acao: 'sem_prazo_aberto',
          motivo: 'Protocolo confiável detectado, mas não havia prazo aberto no processo.'
        };
      }
    } else if (protocolo) {
      cumprimento = {
        acao: 'aguardando_conferencia',
        motivo: 'Protocolo detectado, mas a fonte/confiança não autoriza fechamento automático.',
        confianca: evento.confianca,
        fontes: evento.confirmado_por
      };
    }

    resultados.push({
      data: evento.data,
      descricao: evento.descricao,
      movimentacao_id: registro.movimentacao.id,
      duplicada: registro.duplicada,
      fontes: evento.confirmado_por,
      confianca: evento.confianca,
      protocolo,
      pode_cumprir_prazo: evento.pode_cumprir_prazo,
      prazos_abertos_antes: prazosAbertos.length,
      cumprimento
    });
  }

  return json({
    dry_run: dryRun,
    processo: processo.numero,
    tribunal: processo.tribunal || null,
    eventos_recebidos: eventosNormalizados.length,
    eventos_consolidados: consolidados.length,
    resultados
  });
}

async function handleProcesso(request, env) {
  const url = new URL(request.url);
  const numeroParam = decodeURIComponent(url.pathname.replace(/^\/processo\//, '')).trim();

  if (!numeroParam) {
    return json({ erro: 'Informe o numero do processo.' }, 400);
  }

  const numeroLimpo = cleanCnj(numeroParam);
  if (!numeroLimpo) {
    return json({ erro: 'Numero de processo invalido.' }, 400);
  }

  const numeroBusca = encodeURIComponent(numeroParam);
  let processos = await supabaseFetch(
    `processos?select=id,numero,tribunal,advogado_responsavel,situacao,clientes(nome,cpf_cnpj)&numero=eq.${numeroBusca}&limit=1`,
    env
  );

  if (!processos.length) {
    const candidatos = await supabaseFetch(
      'processos?select=id,numero,tribunal,advogado_responsavel,situacao,clientes(nome,cpf_cnpj)&numero=not.is.null',
      env
    );
    processos = candidatos.filter((p) => cleanCnj(p.numero) === numeroLimpo).slice(0, 1);
  }

  const processo = processos[0];
  if (!processo) {
    return json({ erro: 'Processo nao encontrado.', processo: numeroParam }, 404);
  }

  const movimentacoes = await supabaseFetch(
    `movimentacoes?select=data,descricao,tipo&processo_id=eq.${processo.id}&${FILTRO_MOVIMENTACAO_PROCESSUAL}&order=data.desc&limit=1`,
    env
  );
  const ultima = movimentacoes[0] || null;
  const prazos = await supabaseFetch(
    `prazos?select=data,data_prazo,descricao,tipo,status,cumprido&processo_id=eq.${processo.id}&cumprido=eq.false&order=data.asc&limit=1`,
    env
  );
  const prazo = prazos[0] || null;
  const cliente = Array.isArray(processo.clientes) ? processo.clientes[0] : processo.clientes;

  return json({
    processo: processo.numero,
    cliente: cliente?.nome || null,
    cpf_cnpj: cliente?.cpf_cnpj || null,
    tribunal: processo.tribunal || null,
    responsavel: processo.advogado_responsavel || null,
    situacao: processo.situacao || null,
    ultima_movimentacao: ultima?.descricao || null,
    data: ultima?.data || null,
    origem: ultima?.tipo || null,
    prazo: prazo ? {
      data: prazo.data || prazo.data_prazo || null,
      descricao: prazo.descricao || null,
      tipo: prazo.tipo || null,
      status: prazo.status || null
    } : null
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: jsonHeaders });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/processo/')) {
      try {
        return await handleProcesso(request, env);
      } catch (error) {
        return json({ erro: 'Erro ao consultar processo.', detalhe: error.message }, 500);
      }
    }

    const rotas = {
      '/prazos/pendentes': handlePrazosPendentes,
      '/processos-parados': handleProcessosParados,
      '/conferencia': handleConferencia,
      '/risco/hoje': handleRiscoHoje,
      '/painel-manha': handlePainelManha,
      '/painel-noite': handlePainelNoite,
      '/fontes/status': handleFontesStatus
    };

    if (request.method === 'GET' && rotas[url.pathname]) {
      try {
        return await rotas[url.pathname](request, env);
      } catch (error) {
        return json({ erro: 'Erro ao consultar risco operacional.', detalhe: error.message }, 500);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/tribunal/movimentacoes') {
      try {
        return await handleTribunalMovimentacoes(request, env);
      } catch (error) {
        return json({ erro: 'Erro ao processar movimentação do tribunal.', detalhe: error.message }, 500);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/multifonte/movimentacoes') {
      try {
        return await handleMultifonteMovimentacoes(request, env);
      } catch (error) {
        return json({ erro: 'Erro ao processar movimentações multi-fonte.', detalhe: error.message }, 500);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/datajud/atualizar-lote') {
      try {
        return await handleDataJudAtualizarLote(request, env);
      } catch (error) {
        return json({ erro: 'Erro ao atualizar processos pelo DataJud.', detalhe: error.message }, 500);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/datajud/consultar') {
      try {
        return await handleDataJudConsultar(request, env);
      } catch (error) {
        return json({ erro: 'Erro ao consultar processo pelo DataJud.', detalhe: error.message }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
