// Edge Function `sistema-chat` — chat de consulta sobre o SISTEMA INTEIRO, respondido pela IA.
//
// O `processo-chat` responde sobre UM processo; o `becker-ia/assistente` responde direito em
// geral e não enxerga o banco. Faltava o meio: "quais prazos da Luana vencem esta semana?",
// "o cliente Fulano tem parcela atrasada?", "quantos processos ativos no TJSC?".
//
// COMO FUNCIONA. Gemini com function calling: a IA não recebe o banco inteiro, ela PEDE o que
// precisa através das ferramentas abaixo (todas SÓ LEITURA, com filtro e teto de linhas), e a
// função executa com service role. Teto de 6 rodadas de ferramenta por pergunta.
//
// O QUE ELA NÃO FAZ. Não grava, não apaga, não chama API paga (Legal Mail/DataJud) — ver
// LICOES.md. O único custo é o Gemini (flash-lite): poucos milhares de tokens por pergunta.
//
// LINKS. A resposta cita registros como [[processo:ID|número]] e [[cliente:ID|nome]]; a tela
// transforma isso em link que abre a ficha.
//
// Auth: verify_jwt=true (só usuário logado). Lê o banco com service role.
// Segredos: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (+ GEMINI_MODEL).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY = Deno.env.get("GEMINI_API_KEY") || "";
const GMODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";
const MAX_RODADAS = 6;

const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, st = 200) =>
  new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

async function sb(path: string, extra: Record<string, string> = {}): Promise<{ rows: any[]; total: number | null }> {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { ...sbH, ...extra } });
  const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (!r.ok) throw new Error(`consulta ${path.split("?")[0]} falhou (${r.status}): ${String(t).slice(0, 160)}`);
  const cr = r.headers.get("content-range"); // "0-19/345"
  const total = cr && cr.includes("/") ? Number(cr.split("/")[1]) : null;
  return { rows: Array.isArray(j) ? j : [], total: Number.isFinite(total) ? total : null };
}
const contar = { Prefer: "count=exact" };

function usuarioAutenticado(req: Request): boolean {
  try {
    const tk = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    return JSON.parse(atob(tk.split(".")[1] || ""))?.role === "authenticated";
  } catch { return false; }
}

// ── Termo de busca: MESMA regra do `_termoBusca()` da tela (LICOES.md, regras 22 e 23) ──────────
// maiúscula, sem acento, sem a sintaxe do or=(...), todas as palavras em qualquer ordem.
function termo(v: unknown) {
  const t = String(v || "").normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toUpperCase().replace(/[,()*%.:"']/g, " ").replace(/\s+/g, " ").trim();
  const d = t.replace(/\D/g, "");
  return { t, d: d.length >= 3 ? d : "", palavras: t.split(" ").filter((w) => w.length >= 2).slice(0, 5) };
}
const enc = encodeURIComponent;
const ilikeTodas = (col: string, ws: string[]) =>
  ws.length > 1 ? `and(${ws.map((w) => `${col}.ilike.*${w}*`).join(",")})` : `${col}.ilike.*${ws[0]}*`;

async function idsClientesPorNome(v: string): Promise<number[]> {
  const { palavras, t } = termo(v);
  const ws = palavras.length ? palavras : [t];
  if (!ws[0]) return [];
  const q = ws.map((w) => `busca=ilike.${enc(`*${w}*`)}`).join("&");
  const { rows } = await sb(`clientes?select=id&${q}&limit=300`);
  return rows.map((r) => r.id).filter(Number.isFinite);
}
// or=(...) que acha processo pelo número/assunto/parte E pelo nome do cliente
async function condProcesso(v: string, col = "busca"): Promise<string | null> {
  const { t, d, palavras } = termo(v);
  if (!t) return null;
  const cond = [ilikeTodas(col, palavras.length ? palavras : [t])];
  if (d) cond.push(`${col}.ilike.*${d}*`);
  const ids = await idsClientesPorNome(v);
  if (ids.length) cond.push(`cliente_id.in.(${ids.join(",")})`);
  return `or=(${enc(cond.join(","))})`;
}

const hojeSP = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const dataOk = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : null;
const lim = (n: unknown, pad = 20, max = 50) => Math.max(1, Math.min(max, Number(n) || pad));

// Corta textos longos para não inflar o contexto (e o custo).
function enxugar(o: any, max = 400): any {
  if (typeof o === "string") return o.length > max ? o.slice(0, max) + "…" : o;
  if (Array.isArray(o)) return o.map((x) => enxugar(x, max));
  if (o && typeof o === "object") {
    const r: any = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === "" || k === "busca" || /gemini|_uri$|token|senha|foto/i.test(k)) continue;
      r[k] = enxugar(v, max);
    }
    return r;
  }
  return o;
}

// ── Ferramentas (todas só leitura) ────────────────────────────────────────────────────────────
const S = "string", N = "integer", B = "boolean";
const p = (type: string, description: string) => ({ type, description });
const FERRAMENTAS = [
  { name: "resumo_geral", description: "Números gerais do escritório agora: clientes, processos, prazos em aberto/vencidos/da semana, audiências próximas, tarefas pendentes, alvarás a receber.", parameters: { type: "object", properties: {} } },
  { name: "buscar_clientes", description: "Busca clientes por nome, CPF/CNPJ, e-mail ou telefone (sem acento, palavras em qualquer ordem).", parameters: { type: "object", properties: { termo: p(S, "texto a buscar"), limite: p(N, "máx. 30") }, required: ["termo"] } },
  { name: "detalhe_cliente", description: "Ficha completa de um cliente: cadastro, processos judiciais e administrativos, honorários com parcelas e últimos atendimentos.", parameters: { type: "object", properties: { cliente_id: p(N, "id do cliente") }, required: ["cliente_id"] } },
  { name: "buscar_processos", description: "Lista processos judiciais. Filtros opcionais combináveis. 'termo' casa número CNJ, assunto, classe, parte contrária, comarca e NOME DO CLIENTE.", parameters: { type: "object", properties: {
      termo: p(S, "texto livre"), responsavel: p(S, "nome (ou parte) do advogado responsável"), tribunal: p(S, "ex.: TJSC, TRT12"),
      situacao: p(S, "ex.: Ativo, Arquivado, Suspenso"), cliente_id: p(N, "id do cliente"), limite: p(N, "máx. 50") } } },
  { name: "detalhe_processo", description: "Tudo de um processo: cadastro, polo do cliente, resumo dos autos por IA, últimas movimentações, prazos em aberto, audiências, publicações recentes. Aceita id ou número CNJ.", parameters: { type: "object", properties: { processo_id: p(N, "id"), numero: p(S, "número CNJ (com ou sem pontuação)") } } },
  { name: "listar_prazos", description: "Prazos processuais por período. Padrão: em aberto, de hoje a 7 dias. Para vencidos use ate=ontem e sem 'de'.", parameters: { type: "object", properties: {
      de: p(S, "AAAA-MM-DD"), ate: p(S, "AAAA-MM-DD"), responsavel: p(S, "advogado responsável do processo"), cumpridos: p(B, "true = só cumpridos; padrão só em aberto"),
      processo_id: p(N, "id"), tipo: p(S, "ex.: Audiência, Prazo"), limite: p(N, "máx. 50") } } },
  { name: "listar_audiencias", description: "Audiências por período (padrão: de hoje a 30 dias).", parameters: { type: "object", properties: { de: p(S, "AAAA-MM-DD"), ate: p(S, "AAAA-MM-DD"), processo_id: p(N, "id"), limite: p(N, "máx. 50") } } },
  { name: "listar_tarefas", description: "Tarefas internas. Padrão: não concluídas.", parameters: { type: "object", properties: { responsavel: p(S, "nome"), status: p(S, "status exato; 'todas' para incluir concluídas"), atrasadas: p(B, "só com prazo já vencido"), limite: p(N, "máx. 50") } } },
  { name: "listar_alvaras", description: "Alvarás. Padrão: todos que não estão finalizados.", parameters: { type: "object", properties: { etapa: p(S, "ex.: A Receber, Financeiro Notificado, Recebido, Finalizado"), limite: p(N, "máx. 50") } } },
  { name: "financeiro_honorarios", description: "Honorários contratados e parcelas. Pode filtrar por cliente e mostrar só parcelas vencidas não pagas.", parameters: { type: "object", properties: { cliente_id: p(N, "id do cliente"), so_vencidas: p(B, "só parcelas vencidas e não pagas"), limite: p(N, "máx. 50") } } },
  { name: "listar_publicacoes", description: "Publicações/intimações recebidas (DJEN, Legal Mail) por período de disponibilização. Padrão: últimos 3 dias.", parameters: { type: "object", properties: { de: p(S, "AAAA-MM-DD"), ate: p(S, "AAAA-MM-DD"), processo_id: p(N, "id"), limite: p(N, "máx. 30") } } },
  { name: "listar_movimentacoes", description: "Movimentações processuais recentes (padrão: últimos 7 dias), de todos os processos ou de um.", parameters: { type: "object", properties: { de: p(S, "AAAA-MM-DD"), processo_id: p(N, "id"), limite: p(N, "máx. 50") } } },
  { name: "listar_atendimentos", description: "Atendimentos a clientes por período (padrão: últimos 30 dias) ou de um cliente.", parameters: { type: "object", properties: { de: p(S, "AAAA-MM-DD"), cliente_id: p(N, "id"), limite: p(N, "máx. 30") } } },
  { name: "buscar_administrativos", description: "Processos administrativos (INSS, órgãos) por protocolo, órgão, assunto ou nome do cliente.", parameters: { type: "object", properties: { termo: p(S, "texto"), limite: p(N, "máx. 30") }, required: ["termo"] } },
];

const PROC = "processos(id,numero,advogado_responsavel,clientes(id,nome))";

async function executar(nome: string, a: any): Promise<any> {
  const hoje = hojeSP();
  const somaDias = (n: number) => new Date(Date.parse(hoje) + n * 86400000).toISOString().slice(0, 10);

  switch (nome) {
    case "resumo_geral": {
      const c = async (path: string) => (await sb(`${path}${path.includes("?") ? "&" : "?"}select=id&limit=1`, contar)).total;
      const [cli, prc, adm, pzAb, pzVenc, pzSem, aud, tar, alv] = await Promise.all([
        c("clientes"), c("processos?numero=not.is.null&numero=neq."), c("processos_adm"),
        c("prazos?cumprido=eq.false"), c(`prazos?cumprido=eq.false&data=lt.${hoje}`),
        c(`prazos?cumprido=eq.false&data=gte.${hoje}&data=lte.${somaDias(7)}`),
        c(`audiencias?data=gte.${hoje}&data=lte.${somaDias(30)}`),
        c("tarefas?status=neq.Concluido").catch(() => null),
        c(`alvaras?etapa=in.(${enc('"A Receber","Financeiro Notificado"')})`).catch(() => null),
      ]);
      return { hoje, clientes: cli, processos_judiciais: prc, processos_administrativos: adm, prazos_em_aberto: pzAb,
        prazos_vencidos_nao_cumpridos: pzVenc, prazos_proximos_7_dias: pzSem, audiencias_proximos_30_dias: aud,
        tarefas_nao_concluidas: tar, alvaras_a_receber: alv };
    }
    case "buscar_clientes": {
      const { t, d, palavras } = termo(a.termo);
      if (!t) return { erro: "termo vazio" };
      const cond = [ilikeTodas("busca", palavras.length ? palavras : [t])];
      if (d) cond.push(`busca.ilike.*${d}*`);
      const { rows, total } = await sb(`clientes?select=id,nome,cpf_cnpj,telefone,email&or=(${enc(cond.join(","))})&order=nome&limit=${lim(a.limite, 15, 30)}`, contar);
      return { total, clientes: rows };
    }
    case "detalhe_cliente": {
      const id = Number(a.cliente_id); if (!id) return { erro: "cliente_id obrigatório" };
      const [cl, prs, adm, hon, at] = await Promise.all([
        sb(`clientes?id=eq.${id}&select=*`),
        sb(`processos?cliente_id=eq.${id}&select=id,numero,assunto,tribunal,comarca,situacao,advogado_responsavel,parte_contraria,polo_cliente&order=id.desc&limit=40`),
        sb(`processos_adm?cliente_id=eq.${id}&select=id,numero_protocolo,orgao,assunto,situacao&limit=20`),
        sb(`honorarios?cliente_id=eq.${id}&select=id,descricao,valor_total,status,parcelas(numero,valor,status,vencimento,data_pagamento)&order=created_at.desc&limit=20`).catch(() => ({ rows: [] })),
        sb(`atendimentos?cliente_id=eq.${id}&select=data_atendimento,tipo,descricao&order=data_atendimento.desc&limit=8`).catch(() => ({ rows: [] })),
      ]);
      if (!cl.rows.length) return { erro: "cliente não encontrado" };
      return { cliente: cl.rows[0], processos: prs.rows, administrativos: adm.rows, honorarios: hon.rows, atendimentos_recentes: at.rows };
    }
    case "buscar_processos": {
      const f = ["numero=not.is.null", "numero=neq."];
      if (a.termo) { const c = await condProcesso(a.termo); if (c) f.push(c); }
      if (a.responsavel) f.push(`advogado_responsavel=ilike.${enc(`*${String(a.responsavel).replace(/[*,()]/g, "")}*`)}`);
      if (a.tribunal) f.push(`tribunal=ilike.${enc(`*${String(a.tribunal).replace(/[*,()]/g, "")}*`)}`);
      if (a.situacao) f.push(`situacao=ilike.${enc(`*${String(a.situacao).replace(/[*,()]/g, "")}*`)}`);
      if (Number(a.cliente_id)) f.push(`cliente_id=eq.${Number(a.cliente_id)}`);
      const { rows, total } = await sb(`processos?select=id,numero,assunto,classe_processual,tribunal,comarca,situacao,advogado_responsavel,parte_contraria,clientes(id,nome)&${f.join("&")}&order=id.desc&limit=${lim(a.limite)}`, contar);
      return { total, mostrando: rows.length, processos: rows };
    }
    case "detalhe_processo": {
      let id = Number(a.processo_id) || 0;
      if (!id && a.numero) {
        const dg = String(a.numero).replace(/\D/g, "");
        if (dg.length >= 7) {
          const { rows } = await sb(`processos?busca=ilike.${enc(`*${dg}*`)}&select=id,numero&limit=5`);
          if (rows.length > 1) return { varios: rows, aviso: "mais de um processo casa esse número; peça o id" };
          id = rows[0]?.id || 0;
        }
      }
      if (!id) return { erro: "processo não encontrado" };
      const [pr, au, mv, pz, ad, pb] = await Promise.all([
        sb(`processos?id=eq.${id}&select=*,clientes(id,nome,cpf_cnpj,telefone)`),
        sb(`processo_autos?processo_id=eq.${id}&select=ia_json,ia_resumo&order=criado_em.desc&limit=1`).catch(() => ({ rows: [] })),
        sb(`movimentacoes?processo_id=eq.${id}&select=data,descricao&order=data.desc&limit=15`),
        sb(`prazos?processo_id=eq.${id}&cumprido=eq.false&select=id,data,descricao,tipo,categoria,status&order=data.asc&limit=15`),
        sb(`audiencias?processo_id=eq.${id}&select=data,hora,tipo,local&order=data.desc&limit=10`).catch(() => ({ rows: [] })),
        sb(`publicacoes?processo_id=eq.${id}&select=data_disponibilizacao,tipo,tribunal,texto&order=data_disponibilizacao.desc&limit=3`).catch(() => ({ rows: [] })),
      ]);
      if (!pr.rows.length) return { erro: "processo não encontrado" };
      return { processo: pr.rows[0], resumo_autos_ia: au.rows[0]?.ia_json || au.rows[0]?.ia_resumo || null,
        movimentacoes: mv.rows, prazos_em_aberto: pz.rows, audiencias: ad.rows, publicacoes_recentes: pb.rows };
    }
    case "listar_prazos": {
      const f: string[] = [`cumprido=eq.${a.cumpridos === true}`];
      const de = dataOk(a.de), ate = dataOk(a.ate);
      if (de) f.push(`data=gte.${de}`); else if (!ate) f.push(`data=gte.${hoje}`);
      f.push(`data=lte.${ate || (de ? somaDias(365) : somaDias(7))}`);
      if (Number(a.processo_id)) f.push(`processo_id=eq.${Number(a.processo_id)}`);
      if (a.tipo) f.push(`tipo=ilike.${enc(`*${String(a.tipo).replace(/[*,()]/g, "")}*`)}`);
      let emb = PROC;
      if (a.responsavel) {
        emb = "processos!inner(id,numero,advogado_responsavel,clientes(id,nome))";
        f.push(`processos.advogado_responsavel=ilike.${enc(`*${String(a.responsavel).replace(/[*,()]/g, "")}*`)}`);
      }
      const { rows, total } = await sb(`prazos?select=id,data,descricao,tipo,categoria,status,${emb}&${f.join("&")}&order=data.${a.cumpridos === true ? "desc" : "asc"}&limit=${lim(a.limite, 30)}`, contar);
      return { hoje, total, mostrando: rows.length, prazos: rows };
    }
    case "listar_audiencias": {
      const de = dataOk(a.de) || hoje, ate = dataOk(a.ate) || somaDias(30);
      const f = [`data=gte.${de}`, `data=lte.${ate}`];
      if (Number(a.processo_id)) f.push(`processo_id=eq.${Number(a.processo_id)}`);
      const { rows, total } = await sb(`audiencias?select=id,data,hora,tipo,local,${PROC}&${f.join("&")}&order=data.asc,hora.asc&limit=${lim(a.limite, 30)}`, contar);
      return { hoje, total, audiencias: rows };
    }
    case "listar_tarefas": {
      const f: string[] = [];
      if (a.status && String(a.status).toLowerCase() !== "todas") f.push(`status=eq.${enc(String(a.status))}`);
      else if (!a.status) f.push("status=neq.Concluido");
      if (a.responsavel) f.push(`responsavel=ilike.${enc(`*${String(a.responsavel).replace(/[*,()]/g, "")}*`)}`);
      if (a.atrasadas) f.push(`prazo=lt.${hoje}`);
      const { rows, total } = await sb(`tarefas?select=*,processos(id,numero)&${f.join("&")}&order=prazo.asc.nullslast&limit=${lim(a.limite, 30)}`, contar);
      return { hoje, total, tarefas: rows };
    }
    case "listar_alvaras": {
      const f = a.etapa ? [`etapa=ilike.${enc(`*${String(a.etapa).replace(/[*,()]/g, "")}*`)}`] : ["etapa=neq.Finalizado"];
      const { rows, total } = await sb(`alvaras?select=*,processos(id,numero),clientes(id,nome)&${f.join("&")}&limit=${lim(a.limite, 30)}`, contar);
      const soma = rows.reduce((s, r) => s + (Number(r.valor) || 0), 0);
      return { total, soma_valores_listados: soma, alvaras: rows };
    }
    case "financeiro_honorarios": {
      if (a.so_vencidas) {
        const f = [`vencimento=lt.${hoje}`, "status=neq.Pago"];
        let emb = "honorarios(id,descricao,cliente_id,clientes(id,nome))";
        if (Number(a.cliente_id)) { emb = "honorarios!inner(id,descricao,cliente_id,clientes(id,nome))"; f.push(`honorarios.cliente_id=eq.${Number(a.cliente_id)}`); }
        const { rows, total } = await sb(`parcelas?select=numero,valor,status,vencimento,${emb}&${f.join("&")}&order=vencimento.asc&limit=${lim(a.limite, 40)}`, contar);
        return { hoje, total_parcelas_vencidas: total, soma_listada: rows.reduce((s, r) => s + (Number(r.valor) || 0), 0), parcelas: rows };
      }
      const f = Number(a.cliente_id) ? [`cliente_id=eq.${Number(a.cliente_id)}`] : [];
      const { rows, total } = await sb(`honorarios?select=id,descricao,valor_total,status,created_at,clientes(id,nome),parcelas(numero,valor,status,vencimento,data_pagamento)${f.length ? "&" + f.join("&") : ""}&order=created_at.desc&limit=${lim(a.limite, 20)}`, contar);
      return { hoje, total, honorarios: rows };
    }
    case "listar_publicacoes": {
      const de = dataOk(a.de) || somaDias(-3), ate = dataOk(a.ate) || hoje;
      const f = [`data_disponibilizacao=gte.${de}`, `data_disponibilizacao=lte.${ate}`];
      if (Number(a.processo_id)) f.push(`processo_id=eq.${Number(a.processo_id)}`);
      const { rows, total } = await sb(`publicacoes?select=id,data_disponibilizacao,tribunal,tipo,texto,processos(id,numero,clientes(id,nome))&${f.join("&")}&order=data_disponibilizacao.desc&limit=${lim(a.limite, 20, 30)}`, contar);
      return { total, publicacoes: enxugar(rows, 300) };
    }
    case "listar_movimentacoes": {
      const f = [`data=gte.${dataOk(a.de) || somaDias(-7)}`];
      if (Number(a.processo_id)) f.push(`processo_id=eq.${Number(a.processo_id)}`);
      const { rows, total } = await sb(`movimentacoes?select=data,descricao,tipo,processos(id,numero,clientes(id,nome))&${f.join("&")}&order=data.desc&limit=${lim(a.limite, 30)}`, contar);
      return { total, movimentacoes: rows };
    }
    case "listar_atendimentos": {
      const f = Number(a.cliente_id) ? [`cliente_id=eq.${Number(a.cliente_id)}`] : [`data_atendimento=gte.${dataOk(a.de) || somaDias(-30)}`];
      const { rows, total } = await sb(`atendimentos?select=id,data_atendimento,tipo,descricao,clientes(id,nome)&${f.join("&")}&order=data_atendimento.desc&limit=${lim(a.limite, 20, 30)}`, contar);
      return { total, atendimentos: rows };
    }
    case "buscar_administrativos": {
      const c = await condProcesso(a.termo);
      if (!c) return { erro: "termo vazio" };
      const { rows, total } = await sb(`processos_adm?select=id,numero_protocolo,orgao,assunto,situacao,clientes(id,nome)&${c}&limit=${lim(a.limite, 20, 30)}`, contar);
      return { total, administrativos: rows };
    }
  }
  return { erro: `ferramenta desconhecida: ${nome}` };
}

function sistema(): string {
  return [
    `Você é o assistente de consulta do Sistema Becker, o sistema interno do escritório Becker Advogados. Hoje é ${hojeSP()} (horário de Brasília).`,
    "Quem pergunta é alguém da equipe do escritório. Responda SEMPRE consultando o banco pelas ferramentas — nunca de memória.",
    "Use quantas ferramentas precisar (ex.: buscar_clientes para achar o id, depois detalhe_cliente). Se a busca não achar, tente variar o termo uma vez antes de dizer que não há registro.",
    "NUNCA invente dado, número de processo, valor, data ou nome. Se não consta no sistema, diga 'não consta no sistema'.",
    "Quando o resultado tiver 'total' maior que o mostrado, diga o total e que está mostrando só uma parte.",
    "Ao citar um processo escreva [[processo:ID|NÚMERO]]; ao citar um cliente, [[cliente:ID|NOME]] — com o id real que veio da ferramenta. Nunca crie esse formato com id inventado.",
    "Datas no formato DD/MM/AAAA. Valores em R$. Português claro, direto e curto; use listas quando houver vários itens.",
    "Você só CONSULTA: não cadastra, não altera, não apaga. Se pedirem isso, diga em que tela do sistema fazer.",
    "Para análise jurídica profunda de um processo, indique o chat dentro do próprio processo (ele lê a íntegra dos autos).",
  ].join(" ");
}

async function gemini(contents: any[]): Promise<any> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${enc(GKEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sistema() }] },
      contents,
      tools: [{ functionDeclarations: FERRAMENTAS }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
    }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status} ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function responder(pergunta: string, historico: any[]) {
  const contents: any[] = [];
  for (const h of (Array.isArray(historico) ? historico.slice(-8) : [])) {
    const t = String(h?.texto || h?.text || "").slice(0, 2500);
    if (t) contents.push({ role: h?.role === "assistant" ? "model" : "user", parts: [{ text: t }] });
  }
  contents.push({ role: "user", parts: [{ text: pergunta.slice(0, 2000) }] });

  const consultas: string[] = [];
  for (let rodada = 0; rodada <= MAX_RODADAS; rodada++) {
    const j = await gemini(contents);
    const cont = j?.candidates?.[0]?.content;
    const partes: any[] = cont?.parts || [];
    const chamadas = partes.filter((x) => x?.functionCall);
    if (!chamadas.length || rodada === MAX_RODADAS) {
      const txt = partes.map((x) => x?.text || "").join("").trim();
      return { resposta: txt || "Não consegui montar a resposta. Tente reformular a pergunta.", consultas };
    }
    contents.push({ role: "model", parts: partes }); // volta inteiro (inclui thoughtSignature, se houver)
    const respostas = await Promise.all(chamadas.map(async (c: any) => {
      const nome = String(c.functionCall.name || ""), args = c.functionCall.args || {};
      consultas.push(nome);
      let out: any;
      try { out = enxugar(await executar(nome, args)); } catch (e) { out = { erro: String(e).slice(0, 300) }; }
      let s = JSON.stringify(out);
      if (s.length > 30000) out = { aviso: "resultado grande demais, cortado; refine o filtro", parcial: s.slice(0, 30000) };
      return { functionResponse: { name: nome, response: { resultado: out } } };
    }));
    contents.push({ role: "user", parts: respostas });
  }
  return { resposta: "Sem resposta.", consultas };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!usuarioAutenticado(req)) return json({ erro: "faça login" }, 401);
  if (!GKEY) return json({ erro: "sem GEMINI_API_KEY" }, 500);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const pergunta = String(body.pergunta || "").trim();
  if (pergunta.length < 2) return json({ erro: "faça uma pergunta" }, 400);
  try {
    const r = await responder(pergunta, body.historico || []);
    return json({ ok: true, ...r });
  } catch (e) { return json({ erro: String(e).slice(0, 300) }, 500); }
});
