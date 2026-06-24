const SUPA_URL = 'https://fnuzhypsqvyolqqafrba.supabase.co';
const SUPA_KEY = 'sb_publishable_QVrl-Cxs9FNjC7Pf9aHazQ_aGEk0PiO';
const TIPOS_MOVIMENTACAO_PROCESSUAL = ['DataJud', 'TJSC/eproc', 'Tribunal', 'Diário Oficial', 'JusBrasil', 'Manual'];
const FILTRO_MOVIMENTACAO_PROCESSUAL = `tipo=in.(${TIPOS_MOVIMENTACAO_PROCESSUAL.map(encodeURIComponent).join(',')})`;

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization'
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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: jsonHeaders });
}

export async function onRequestGet(context) {
  const numeroParam = decodeURIComponent(context.params.numero || '').trim();

  if (!numeroParam) {
    return json({ erro: 'Informe o numero do processo.' }, 400);
  }

  const numeroLimpo = cleanCnj(numeroParam);
  if (!numeroLimpo) {
    return json({ erro: 'Numero de processo invalido.' }, 400);
  }

  try {
    const numeroBusca = encodeURIComponent(numeroParam);
    let processos = await supabaseFetch(
      `processos?select=id,numero,tribunal,advogado_responsavel,situacao,clientes(nome,cpf_cnpj)&numero=eq.${numeroBusca}&limit=1`,
      context.env
    );

    if (!processos.length) {
      const candidatos = await supabaseFetch(
        'processos?select=id,numero,tribunal,advogado_responsavel,situacao,clientes(nome,cpf_cnpj)&numero=not.is.null',
        context.env
      );
      processos = candidatos.filter((p) => cleanCnj(p.numero) === numeroLimpo).slice(0, 1);
    }

    const processo = processos[0];
    if (!processo) {
      return json({ erro: 'Processo nao encontrado.', processo: numeroParam }, 404);
    }

    const movimentacoes = await supabaseFetch(
      `movimentacoes?select=data,descricao,tipo&processo_id=eq.${processo.id}&${FILTRO_MOVIMENTACAO_PROCESSUAL}&order=data.desc&limit=1`,
      context.env
    );
    const ultima = movimentacoes[0] || null;
    const prazos = await supabaseFetch(
      `prazos?select=data,data_prazo,descricao,tipo,status,cumprido&processo_id=eq.${processo.id}&cumprido=eq.false&order=data.asc&limit=1`,
      context.env
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
  } catch (error) {
    return json({ erro: 'Erro ao consultar processo.', detalhe: error.message }, 500);
  }
}
