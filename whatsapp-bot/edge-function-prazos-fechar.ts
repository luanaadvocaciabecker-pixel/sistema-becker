// Edge Function `prazos-fechar` — o fecho do dia: o que o tribunal confirma aberto, o que ele
// nao respondeu, e o que a rotina nem consegue olhar. Copia versionada; deploy no Supabase.
//
// Roda 1x por dia, as 17:30 BRT (cron `prazos_fechar_1730`, 20:30 UTC).
// FONTE: GET /api/v1/pleading/notices-to-comply — GRATIS na tabela oficial de precos.
// *** NAO ACRESCENTE CHAMADA PAGA AQUI. So toca notices-to-comply e balance. ***
//
// LIMITE DE TAXA — licao paga com bloqueio em 09/09/2026: 120 req/min em janela deslizante, e
// 3 respostas 429 em 10 min caracterizam "polling" e bloqueiam o workspace inteiro. Eu rodei 87
// chamadas tres vezes em cinco minutos e derrubei o acesso. Por isso PASSO de 700ms e ABORTO no
// primeiro 429, respeitando Retry-After.
//
// ---------------------------------------------------------------------------
// O QUE ESTA ROTINA AFIRMA, E O QUE SE RECUSA A AFIRMAR (testado em 10/09/2026)
// ---------------------------------------------------------------------------
// Gabarito de 7 prazos fechados COM prova (`?gabarito=`, custo R$ 0,00):
//   * `intimacoes_prazo_fechado` FUNCIONA — 3 dos 7 vieram declarados FECHADO. O
//     `a_fechar_detectados: 0` das rodadas anteriores tinha causa banal: a consulta busca
//     prazos abertos, e os abertos estavam genuinamente abertos.
//   * AUSENCIA NAO E FECHAMENTO. Dos 9 prazos do dia, 6 nao foram mencionados e 5 sao do TRT,
//     que o eProc do TJSC nao conhece. Fechar por ausencia fecharia esses cinco indevidamente.
//   * E ausencia tambem nao e pendencia: a versao anterior somava os nao-mencionados em
//     "ainda aberto" e reportava como atraso coisa que ninguem sabia se estava aberta.
//
// Por isso a resposta vem em TRES grupos, e cada um diz so o que se sabe:
//   FATAIS_SEM_CUMPRIR        o tribunal DECLAROU aberto, e ja venceu ou vence hoje
//   SEM_RESPOSTA_DO_TRIBUNAL  o tribunal nao falou deste (com o tribunal de cada um)
//   FORA_DA_ROTINA            a rotina nem consegue olhar (ver o comentario do `fdr`)
// Conferido em 10/09: 3 + 6 + 3 = 12, que e o total de prazos abertos do dia. A soma fechar
// e o teste de que ninguem sumiu em silencio.
//
// QUANDO o tribunal fecha: na ciencia/renuncia ou na certidao do cartorio, NAO no instante do
// protocolo. O unico motivo de fechamento que aparece na base e "CIENCIA, COM RENUNCIA AO
// PRAZO" (8 de ~11.000 intimacoes); nenhum diz "peticao protocolada". E cada destinatario tem a
// sua intimacao: no processo 5031202-56 o evento 84 (Cibele) esta FECHADO e o 83 (outro
// advogado, mesmo ato) esta ABERTO. Ver db/legalmail_custo_api.sql.
//
// *** E O MAIS IMPORTANTE: rodada INCOMPLETA nao reporta numero. ***
//   Na rodada bloqueada a funcao disse "0 em aberto" estando cega. Dizer "nenhum prazo
//   pendente" sem ter conseguido olhar manda a equipe para casa.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB   = Deno.env.get("SUPABASE_URL")!;
const SVC  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API  = Deno.env.get("LEGALMAIL_API_KEY") || "";
const BASE = Deno.env.get("LEGALMAIL_BASE") || "https://api.legalmail.com.br";
const K = "fech_7d2a91c4";
const PASSO_MS = 700;          // ~85 req/min, com folga sobre o limite de 120/min
const sbH = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o, null, 1), { status: st, headers: { "Content-Type": "application/json" } });
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`sb ${path} ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

// "Hoje" em Joinville: o cron roda 20:30 UTC, que ainda é o mesmo dia no BRT.
function hojeBR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("k") !== K) return json({ erro: "nao autorizado" }, 401);
  if (!API) return json({ erro: "sem LEGALMAIL_API_KEY" }, 500);
  const commit = url.searchParams.get("commit") !== "0";
  const gabarito = (url.searchParams.get("gabarito") || "").split(",")
    .map((x) => parseInt(x.trim(), 10)).filter(Number.isFinite);
  const t0 = Date.now();
  const hoje = hojeBR();

  try {
    let saldo: number | null = null;
    try {
      const rb = await fetch(`${BASE}/api/v1/balance?api_key=${encodeURIComponent(API)}`, { headers: { Accept: "application/json" } });
      const jb = await rb.json().catch(() => null);
      saldo = typeof jb?.saldo_disponivel === "number" ? jb.saldo_disponivel : null;
    } catch { /* informativo */ }

    const SEL = "id,data,status,cumprido,legalmail_id,processos!inner(id,numero,tribunal,lm_idprocessos)";
    const prazos = await sb(`prazos?cumprido=eq.false&legalmail_id=not.is.null&select=${SEL}&processos.lm_idprocessos=not.is.null&limit=3000`);
    const lista: any[] = Array.isArray(prazos) ? prazos : [];

    // MODO GABARITO (`?gabarito=5441,5688,...`): inclui na varredura prazos que JÁ ESTÃO
    // fechados, que a consulta acima exclui por `cumprido=eq.false`. Serve para provar, com
    // caso de resposta conhecida, o que significa um prazo NÃO APARECER na lista do tribunal.
    // Ele nunca fecha nada: `gab` entra em `soLeitura` e é pulado na hora de gravar.
    const soLeitura = new Set<number>();
    if (gabarito.length) {
      const g = await sb(`prazos?id=in.(${gabarito.join(",")})&select=${SEL}&processos.lm_idprocessos=not.is.null`);
      for (const z of (Array.isArray(g) ? g : [])) {
        if (!lista.some((x) => x.id === z.id)) { lista.push(z); soLeitura.add(z.id); }
      }
    }

    // Os que a rotina nao alcanca: sem `legalmail_id` OU processo sem `lm_idprocessos`.
    // Consulta separada de proposito -- a principal usa `!inner`, que os elimina em silencio.
    // O `lm_idprocessos` TEM de estar no select: sem ele o filtro abaixo nao ve o terceiro caso.
    // Defeito meu, achado conferindo o resultado contra o banco em 10/09: o filtro era
    // `!z.legalmail_id || !z.processos` e deixava passar o prazo 5574 (TJSC, vencendo hoje,
    // processo 6698 cadastrado, com intimacao) porque o processo existe e o prazo tem
    // legalmail_id -- falta so o vinculo no Legal Mail. Ele sumia dos TRES grupos, que e
    // exatamente a omissao silenciosa que este grupo existe para impedir.
    const fdr = await sb(`prazos?cumprido=eq.false&data=lte.${hoje}&select=id,data,legalmail_id,processos(numero,tribunal,lm_idprocessos,advogado_responsavel,clientes(nome))&limit=500`);
    const foraDaRotina = (Array.isArray(fdr) ? fdr : [])
      .filter((z: any) => !z.legalmail_id || !z.processos || !z.processos.lm_idprocessos)
      .map((z: any) => ({ prazo: z.id, data: z.data, processo: z.processos?.numero || "(sem processo)",
                          tribunal: z.processos?.tribunal || "?", cliente: z.processos?.clientes?.nome || "(sem cliente)",
                          responsavel: z.processos?.advogado_responsavel || "(sem responsavel)",
                          motivo: !z.processos ? "prazo sem processo vinculado"
                                : !z.legalmail_id ? "prazo sem intimacao de origem"
                                : "processo sem vinculo no Legal Mail (falta lm_idprocessos)" }));

    const porProc = new Map<string, any[]>();
    for (const z of lista) {
      const idp = String(z?.processos?.lm_idprocessos || "");
      if (!idp) continue;
      if (!porProc.has(idp)) porProc.set(idp, []);
      porProc.get(idp)!.push(z);
    }

    let http_ok = 0, http_erro = 0, abortou_em: string | null = null, retry_after: number | null = null;
    const status_vistos: Record<string, number> = {};
    const aFechar: any[] = [], seguem: any[] = [], semResposta: any[] = [];
    let primeiro = true;

    for (const [idp, doProc] of porProc) {
      if (!primeiro) await dorme(PASSO_MS);
      primeiro = false;
      let j: any = null;
      try {
        const r = await fetch(`${BASE}/api/v1/pleading/notices-to-comply?api_key=${encodeURIComponent(API)}&idprocessos=${encodeURIComponent(idp)}`, { headers: { Accept: "application/json" } });
        status_vistos[String(r.status)] = (status_vistos[String(r.status)] || 0) + 1;
        if (r.status === 429) {
          // ABORTA na primeira. Insistir gera as 3 violações em 10min e bloqueia o workspace.
          retry_after = Number(r.headers.get("Retry-After") || 0) || null;
          abortou_em = idp; http_erro++;
          break;
        }
        if (!r.ok) { http_erro++; continue; }
        http_ok++;
        j = await r.json().catch(() => null);
      } catch { http_erro++; status_vistos["excecao"] = (status_vistos["excecao"] || 0) + 1; continue; }

      const fech = new Set<string>((Array.isArray(j?.intimacoes_prazo_fechado) ? j.intimacoes_prazo_fechado : []).map((x: any) => String(x?.idintimacoes)));
      const abre = new Set<string>((Array.isArray(j?.intimacoes_prazo_aberto)  ? j.intimacoes_prazo_aberto  : []).map((x: any) => String(x?.idintimacoes)));
      for (const z of doProc) {
        const k = String(z.legalmail_id);
        // TRES baldes, e o terceiro NAO e "fechado" nem "pendente":
        //   fechado -> o tribunal DECLAROU fechado. Prova. Pode fechar no sistema.
        //   aberto  -> o tribunal DECLAROU aberto. Pendencia confirmada.
        //   sem_resposta -> o tribunal nao falou deste. NAO da para concluir nada.
        // Testado em 10/09: dos 9 prazos que vencem hoje, 6 caem em sem_resposta e 5 sao do
        // TRT, que o eProc do TJSC nao conhece. Tratar ausencia como fechamento fecharia esses
        // cinco indevidamente. E tratar como pendencia (o que a versao anterior fazia, somando
        // `naoListados` em `aindaAberto`) enche a lista de coisa que ninguem sabe se esta aberta.
        const balde = fech.has(k) ? "fechado" : (abre.has(k) ? "aberto" : "sem_resposta");
        const item = { prazo: z.id, data: z.data, processo: z.processos?.numero,
                       tribunal: z.processos?.tribunal || "?", legalmail_id: z.legalmail_id,
                       ja_fechado_no_sistema: z.cumprido === true, gabarito: soLeitura.has(z.id), balde };
        if (balde === "fechado") aFechar.push(item);
        else if (balde === "aberto") seguem.push(item);
        else semResposta.push(item);
      }
    }

    const completo = http_erro === 0 && !abortou_em && http_ok === porProc.size;

    // Fechar o que o tribunal diz fechado é seguro mesmo em rodada incompleta: é informação
    // positiva e verificada. O que NÃO se pode em rodada incompleta é afirmar pendência.
    let fechados = 0;
    // O gabarito é só leitura: entrou na varredura para revelar o balde, não para ser fechado.
    const paraFechar = aFechar.filter((x) => !x.gabarito);
    if (commit && paraFechar.length) {
      const ids = paraFechar.map((x) => x.prazo);
      const r = await sb(`prazos?id=in.(${ids.join(",")})&cumprido=eq.false`, {
        method: "PATCH", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ cumprido: true, status: "cumprido",
          cumprido_em: new Date().toISOString(), cumprido_por: "notices-to-comply" }),
      });
      fechados = Array.isArray(r) ? r.length : 0;
    }

    // O FECHO DO DIA. Pedido dela: "olhamos hoje se foi todos e nao perdeu nenhum prazo... quero
    // isso sem precisar abrir os tribunais". Entao o recorte e o DIA, e cada grupo diz o que se
    // SABE, sem misturar confirmado com desconhecido.
    const doDia = (arr: any[]) => arr.filter((x) => !x.gabarito && String(x.data) <= hoje);
    const abertosConfirmados = doDia(seguem);
    const desconhecidos      = doDia(semResposta);
    const porTribunal: Record<string, number> = {};
    for (const x of desconhecidos) porTribunal[x.tribunal] = (porTribunal[x.tribunal] || 0) + 1;

    const resumo: Record<string, unknown> = {
      rodou_em: new Date().toISOString(), hoje,
      segundos: +((Date.now() - t0) / 1000).toFixed(1),
      custo: "R$ 0,00 (notices-to-comply e balance sao gratis)",
      saldo_api: saldo,
      COMPLETO: completo,
      processos_alvo: porProc.size, http_ok, http_erro, status_vistos,
      abortou_por_429_no_processo: abortou_em, retry_after_segundos: retry_after,
      prazos_vistos: lista.length,
      fechados_agora: fechados,
      a_fechar_detectados: aFechar.length,
      fechou: aFechar.filter((x) => !x.gabarito).slice(0, 40),
    };

    // Relatório do gabarito: a prova de o que significa "não aparecer na lista do tribunal".
    // Fechado com prova => esperado "nao_listado". Aberto de verdade => esperado "aberto".
    if (gabarito.length) {
      const todos = aFechar.concat(seguem, semResposta).filter((x) => x.gabarito);
      const naoAchados = gabarito.filter((id) => !todos.some((x) => x.prazo === id));
      resumo.GABARITO = todos.map((x) => ({
        prazo: x.prazo, data: x.data, balde: x.balde,
        estado_no_sistema: x.ja_fechado_no_sistema ? "FECHADO com prova" : "aberto",
        esperado: x.ja_fechado_no_sistema ? "nao_listado" : "aberto",
        bate: x.balde === (x.ja_fechado_no_sistema ? "nao_listado" : "aberto"),
      }));
      resumo.GABARITO_ACERTOS = (resumo.GABARITO as any[]).filter((x) => x.bate).length
        + "/" + (resumo.GABARITO as any[]).length;
      if (naoAchados.length) resumo.GABARITO_SEM_PROCESSO_NO_LEGALMAIL = naoAchados;
    }

    if (completo) {
      resumo.seguem_abertos = seguem.length;
      resumo.sem_resposta_total = semResposta.length;
      // 1) o que o tribunal CONFIRMA que segue aberto e ja venceu ou vence hoje. E o numero
      //    que responde "ficou algum fatal sem cumprir?".
      resumo.FATAIS_SEM_CUMPRIR = abertosConfirmados.length;
      resumo.fatais_sem_cumprir = abertosConfirmados.slice(0, 40);
      // 2) o que o tribunal NAO respondeu. Nao e pendencia nem fechamento: e "so o tribunal
      //    sabe". Vem com o tribunal de cada um, porque a maioria e TRT, que este endpoint
      //    nao cobre -- e sem isso a lista parece atraso quando nao e.
      resumo.SEM_RESPOSTA_DO_TRIBUNAL = desconhecidos.length;
      resumo.sem_resposta_por_tribunal = porTribunal;
      resumo.sem_resposta = desconhecidos.slice(0, 40);
      // 3) o que a rotina NEM CONSEGUE OLHAR: prazo sem `legalmail_id` ou processo sem
      //    `lm_idprocessos`. A consulta principal os exclui, e por isso eles desapareciam do
      //    relatorio -- o pior tipo de omissao, porque parece que nao existem. Medido em
      //    10/09: 3 dos 12 prazos do dia. Para esses o tribunal tem de ser aberto a mao.
      resumo.FORA_DA_ROTINA = foraDaRotina.length;
      resumo.fora_da_rotina = foraDaRotina.slice(0, 40);
    } else {
      // rodada cega: NÃO inventa número de pendência
      resumo.FATAIS_SEM_CUMPRIR = null;
      resumo.SEM_RESPOSTA_DO_TRIBUNAL = null;
      resumo.aviso = `RODADA INCOMPLETA (${http_ok}/${porProc.size} processos consultados). `
        + `Nao e possivel afirmar quantos prazos seguem abertos. `
        + (abortou_em ? `Abortada por HTTP 429 (limite de taxa)${retry_after ? `, Retry-After ${retry_after}s` : ""}. ` : "")
        + `Os ${aFechar.length} detectados como fechados sao confiaveis; a lista de pendentes NAO.`;
    }

    if (commit) {
      await sb(`prazo_fechamento_log`, {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          origem: "notices-to-comply",
          processos_consultados: porProc.size, http_ok, http_erro,
          prazos_vistos: lista.length, fechados,
          seguem_abertos: completo ? seguem.length : null,
          nao_listados: completo ? semResposta.length : null,
          vencendo_hoje_abertos: completo ? abertosConfirmados.length : null,
          vencidos_abertos: completo ? desconhecidos.length : null,
          saldo_api: saldo, detalhe: resumo,
          erro: completo ? null : String(resumo.aviso),
        }]),
      }).catch(() => {});
    }
    return json({ ok: true, ...resumo });
  } catch (e) {
    const msg = String(e).slice(0, 400);
    await sb(`prazo_fechamento_log`, { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ origem: "notices-to-comply", erro: msg }]) }).catch(() => {});
    return json({ erro: msg }, 500);
  }
});
