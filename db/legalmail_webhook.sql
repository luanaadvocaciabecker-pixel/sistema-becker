-- Integração Legal Mail — recebedor de webhook (intimações/movimentações -> sistema).
-- Aplicado no Supabase via migrations legalmail_webhook_base + legalmail_ingest_v2_formato_real.
-- A Edge Function que chama isto está em whatsapp-bot/edge-function-legalmail-webhook.ts
--
-- Formato real do webhook do Legal Mail (descoberto nos eventos de teste do painel):
--   Intimação/movimentação:
--     { "params":[ { "numero_processo","tribunal","responsavel",
--                    "origem":{"tipo_busca":"intimacao|movimentacao"},
--                    "documento":[ {"id","link","text","title","movement_date","intimation_date "} ] } ],
--       "clientkey":"<chave do webhook>" }
--     (obs: a fonte às vezes manda a chave "intimation_date " com espaço no fim)
--   Status: { "evento":"monitoramento_tribunal_status|certificado_status|peticao_status",
--             "dados":{...}, "clientkey":"..." }
-- A clientkey é removida do payload antes de gravar (não persistir segredo).

-- 1) Log cru + idempotência ---------------------------------------------------
create table if not exists public.legalmail_eventos (
  id bigint generated always as identity primary key,
  tipo text,
  legalmail_id bigint,
  numero_processo text,
  payload jsonb not null,
  recebido_em timestamptz not null default now(),
  processado boolean not null default false,
  resultado text,
  erro text
);
create index if not exists idx_lm_eventos_legalmail_id on public.legalmail_eventos(legalmail_id);
create index if not exists idx_lm_eventos_recebido on public.legalmail_eventos(recebido_em desc);

alter table public.publicacoes   add column if not exists legalmail_id bigint;
alter table public.movimentacoes add column if not exists legalmail_id bigint;
alter table public.prazos        add column if not exists legalmail_id bigint;
create unique index if not exists uq_publicacoes_legalmail   on public.publicacoes(legalmail_id)   where legalmail_id is not null;
create unique index if not exists uq_movimentacoes_legalmail on public.movimentacoes(legalmail_id) where legalmail_id is not null;
create unique index if not exists uq_prazos_legalmail        on public.prazos(legalmail_id)        where legalmail_id is not null;
revoke all on public.legalmail_eventos from anon, authenticated;

-- 2) Parser de data tolerante -------------------------------------------------
create or replace function public.lm_date(t text) returns date language plpgsql immutable as $$
begin
  if t is null or btrim(t)='' then return null; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}' then return left(t,10)::date; end if;
  if t ~ '^\d{2}/\d{2}/\d{4}'  then return to_date(t,'DD/MM/YYYY'); end if;
  begin return t::date; exception when others then return null; end;
end $$;

-- 3) Ingestão -----------------------------------------------------------------
create or replace function public.lm_ingest(body jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  item jsonb; doc jsonb;
  evt text; num text; digits text; pid bigint; nid bigint;
  trib text; texto text; titulo text; link text; ddisp date; tbusca text; resp text;
  n_evt int:=0; n_pub int:=0; n_mov int:=0; n_skip int:=0;
begin
  evt := coalesce(body->>'evento', case when body ? 'params' then 'intimacao' else 'desconhecido' end);

  if body ? 'params' and jsonb_typeof(body->'params')='array' then
    for item in select value from jsonb_array_elements(body->'params') loop
      num    := item->>'numero_processo';
      trib   := item->>'tribunal';
      resp   := item->>'responsavel';
      tbusca := coalesce(item->'origem'->>'tipo_busca','intimacao');
      digits := regexp_replace(coalesce(num,''),'\D','','g');
      pid := null;
      if digits <> '' and digits !~ '^0+$' then
        select p.id into pid from processos p
         where regexp_replace(coalesce(p.numero,''),'\D','','g') = digits limit 1;
      end if;

      if jsonb_typeof(item->'documento')='array' then
        for doc in select value from jsonb_array_elements(item->'documento') loop
          begin nid := nullif(doc->>'id','')::bigint; exception when others then nid := null; end;
          texto  := doc->>'text';
          titulo := doc->>'title';
          link   := nullif(doc->>'link','');
          ddisp  := lm_date(coalesce(nullif(doc->>'intimation_date',''), nullif(doc->>'intimation_date ',''), nullif(doc->>'movement_date','')));

          insert into legalmail_eventos(tipo, legalmail_id, numero_processo, payload)
          values (tbusca, nid, num, item - 'clientkey');
          n_evt := n_evt + 1;

          if nid is null then n_skip := n_skip + 1; continue; end if; -- evento de teste (id vazio)

          if tbusca ~* 'moviment' then
            insert into movimentacoes(legalmail_id, processo_id, data, tipo, descricao)
            values (nid, pid, ddisp, 'Movimentação', coalesce(texto, titulo))
            on conflict (legalmail_id) where legalmail_id is not null do nothing;
            if found then n_mov := n_mov + 1; end if;
          else
            insert into publicacoes(legalmail_id, processo_id, numero_processo, tribunal, tipo,
                                    data_disponibilizacao, texto, link, destinatario, lida, prazo_gerado)
            values (nid, pid, num, trib, 'Intimação', ddisp, coalesce(texto, titulo), link, resp, false, false)
            on conflict (legalmail_id) where legalmail_id is not null do nothing;
            if found then n_pub := n_pub + 1; end if;
          end if;
        end loop;
      else
        insert into legalmail_eventos(tipo, legalmail_id, numero_processo, payload)
        values (tbusca, null, num, item - 'clientkey');
        n_evt := n_evt + 1;
      end if;
    end loop;
  else
    begin nid := nullif(body->'dados'->>'evento_id','')::bigint; exception when others then nid := null; end;
    insert into legalmail_eventos(tipo, legalmail_id, numero_processo, payload)
    values (evt, nid, body->'dados'->'processo'->>'numero_processo', body - 'clientkey');
    n_evt := n_evt + 1;
  end if;

  return jsonb_build_object('eventos',n_evt,'publicacoes',n_pub,'movimentacoes',n_mov,'ignorados',n_skip,'tipo',evt);
end $$;

revoke all on function public.lm_ingest(jsonb) from anon, authenticated;
revoke all on function public.lm_date(text) from anon, authenticated;
grant execute on function public.lm_ingest(jsonb) to service_role;

-- ============================================================================
-- 4) Reconciliação diária (cumprido/excedido) — pull do GET /api/v1/notices
--    Edge Function: whatsapp-bot/edge-function-legalmail-reconcile.ts
-- ============================================================================
create or replace function public.lm_reconcile(notices jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  n jsonb; nid bigint; num text; digits text; pid bigint;
  dlim date; ddisp date; pstatus text; cumpr boolean; texto text; dest text;
  n_pub int:=0; n_prz int:=0; n_cumpr int:=0; n_exc int:=0;
begin
  if notices is not null and jsonb_typeof(notices)<>'array' then
    notices := coalesce(notices->'notices', notices);
  end if;
  if notices is null or jsonb_typeof(notices)<>'array' then
    return jsonb_build_object('erro','sem array de notices');
  end if;
  for n in select value from jsonb_array_elements(notices) loop
    begin nid := (n->>'id')::bigint; exception when others then nid:=null; end;
    if nid is null then continue; end if;
    num := n->>'numero_processo';
    digits := regexp_replace(coalesce(num,''),'\D','','g');
    pid := null;
    if digits<>'' and digits !~ '^0+$' then
      select p.id into pid from processos p
       where regexp_replace(coalesce(p.numero,''),'\D','','g')=digits limit 1;
    end if;
    ddisp   := lm_date(n->>'data_disponibilizacao');
    dlim    := lm_date(n->>'data_limite_manifestacao');
    pstatus := lower(coalesce(n->>'prazo_status',''));
    texto   := n->>'teor';
    dest    := coalesce(n->'destinatario'->>'nome', n->>'destinatario');
    cumpr   := (pstatus='cumprido');
    insert into publicacoes(legalmail_id, processo_id, numero_processo, tribunal, tipo,
                            data_disponibilizacao, texto, destinatario, lida, prazo_gerado)
    values (nid, pid, num, n->>'tribunal', coalesce(n->>'tipo','Intimação'),
            ddisp, texto, dest, false, (dlim is not null))
    on conflict (legalmail_id) where legalmail_id is not null
    do update set processo_id           = coalesce(excluded.processo_id, publicacoes.processo_id),
                  data_disponibilizacao = coalesce(excluded.data_disponibilizacao, publicacoes.data_disponibilizacao),
                  texto                 = coalesce(excluded.texto, publicacoes.texto),
                  tribunal              = coalesce(excluded.tribunal, publicacoes.tribunal),
                  prazo_gerado          = (dlim is not null);
    n_pub := n_pub + 1;
    if dlim is not null then
      insert into prazos(legalmail_id, processo_id, descricao, data_prazo, data, tipo, status, alertar_dias, cumprido)
      values (nid, pid, left(coalesce(n->>'tipo','Intimação')||' — '||coalesce(texto,''),200),
              dlim, dlim, coalesce(n->>'tipo','Intimação'),
              case when pstatus='' then 'pendente' else pstatus end, 3, cumpr)
      on conflict (legalmail_id) where legalmail_id is not null
      do update set data_prazo = excluded.data_prazo, data = excluded.data,
                    status = excluded.status, cumprido = excluded.cumprido,
                    processo_id = coalesce(excluded.processo_id, prazos.processo_id);
      n_prz := n_prz + 1;
      if pstatus='cumprido' then n_cumpr := n_cumpr + 1; end if;
      if pstatus='excedido' then n_exc   := n_exc + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('publicacoes',n_pub,'prazos',n_prz,'cumpridos',n_cumpr,'excedidos',n_exc);
end $$;
revoke all on function public.lm_reconcile(jsonb) from anon, authenticated;
grant execute on function public.lm_reconcile(jsonb) to service_role;

-- Agendamento diário (07:30 BRT = 10:30 UTC). O header x-reconcile-key reusa a
-- LEGALMAIL_WEBHOOK_KEY já configurada. Requer o segredo LEGALMAIL_API_KEY na função.
-- SELECT cron.schedule('legalmail_reconcile_diario','30 10 * * *',
--   $$ select net.http_post(
--        url:='https://<PROJ>.supabase.co/functions/v1/legalmail-reconcile',
--        headers:=jsonb_build_object('Content-Type','application/json','x-reconcile-key','<WEBHOOK_KEY>'),
--        body:='{}'::jsonb, timeout_milliseconds:=120000) $$);

-- ============================================================================
-- 5) v2 da reconciliação (estratégia "de hoje pra frente" + data estimada)
--    Substitui a lm_reconcile acima. Aplicado via migrations:
--    legalmail_reconcile_estimado + guarda contra sobrescrever correção humana.
-- ============================================================================
-- lm_add_business_days(d, n): soma N dias úteis (pula sáb/dom; sem feriados).
-- lm_reconcile(notices):
--   * pendente sem data-limite -> prazo ESTIMADO (disponibilização + 15 dias úteis),
--     status='estimado', descrição prefixada "⚠ ESTIMADO (conferir) —".
--   * pendente com data-limite -> data real, status='pendente'.
--   * cumprido/excedido -> só atualiza prazo existente (não cria passado).
--   * NÃO sobrescreve prazo cujo status saiu de estimado/pendente ou já cumprido
--     (protege correção/conclusão feita por humano).
-- A Edge Function legalmail-reconcile puxa /notices (limit<=50, paginado) só da
-- janela recente (?dias, padrão 7) e chama esta função. Agendada 07:30 BRT.

-- ============================================================================
-- 6) v3 dos prazos — LER a data do tribunal (sem chutar). Aplicado via execute_sql.
-- ============================================================================
-- Descoberta: o TEXTO da intimação traz "Prazo: N dias", "Status do prazo:
-- Prazo aberto/fechado" e, quando ABERTO, "Data final: DD/MM/AAAA" (já com feriados).
--   * Prazo aberto  -> usa a Data final do tribunal (exata) -> prazo 'pendente'.
--   * Prazo fechado -> aguardando abertura: NÃO cria prazo (entra quando abrir).
--   * Sem prazo no texto -> só publicação (inbox), sem prazo.
-- Função public.lm_upsert_prazo_por_texto(nid,pid,texto,ddisp): extrai a Data final
--   e cria/atualiza o prazo; nunca sobrescreve prazo já confirmado/cumprido por humano.
-- lm_ingest (webhook) e lm_reconcile (diária) passam a chamar essa função — fim do
-- chute de "15 dias úteis". Não precisamos de motor de cálculo/feriados: o tribunal
-- já entrega a data pronta.

-- ============================================================================
-- 7) Autos sob demanda + Audiências do diário + mapa idprocessos (aplicado via execute_sql)
-- ============================================================================
-- processos.lm_idprocessos: id do processo no Legal Mail (preenchido de graça via
--   GET /lawsuit/all -> RPC lm_set_idprocessos(pares jsonb)).
-- processo_autos(processo_id, lm_idprocessos, job_id, status, pdf_path, n_autos...):
--   autos baixados SOB DEMANDA. Edge Function legalmail-autos:
--     action sync_ids -> preenche lm_idprocessos (gratis)
--     action request  -> POST /lawsuit/case-files/download/request {idprocessos}
--                        resp: {job_id, autos:N, custo:R$0,02*N}
--     action status   -> GET /lawsuit/case-files/download/status -> {job_status:PROCESSING|COMPLETED, output_url}
-- bucket storage 'autos' (privado) guarda o PDF.
-- lm_upsert_audiencia(nid,pid,texto): extrai "Designo o dia DD/MM/AAAA ... audiencia"
--   (data/hora/tipo) do texto do diario (TRT/DJEN vem so como texto livre) e grava em
--   audiencias (dedupe por processo+data; idempotente por legalmail_id). Chamada por
--   lm_ingest (webhook) e lm_reconcile (diaria).
-- NOTA TRT: intimacoes do TRT chegam via DJEN como TEXTO LIVRE (sem "Data final"),
--   entao NAO viram prazo automatico; /pleading/notices-to-comply veio vazio (so cobre
--   prazos que o Legal Mail gerencia). Prazo do TRT depende de leitura por IA (a fazer).

-- =====================================================================
-- 8) Classe processual + sugestão de categoria por IA (set/2026)
-- =====================================================================
-- Colunas novas para o hub de prazos:
--   publicacoes.classe / prazos.classe  -> classe processual vinda do /notices
--   prazos.categoria_sugerida/_confianca/_motivo/_ia_em -> sugestão da IA (Haiku),
--     NÃO sobrescreve `categoria` (verdade humana). categoria_fonte='humano' trava.
alter table public.publicacoes add column if not exists classe text;
alter table public.prazos      add column if not exists classe text;
alter table public.prazos add column if not exists categoria_sugerida  text;
alter table public.prazos add column if not exists categoria_confianca text;
alter table public.prazos add column if not exists categoria_motivo    text;
alter table public.prazos add column if not exists categoria_ia_em      timestamptz;
alter table public.prazos add column if not exists categoria_fonte      text;
-- lm_reconcile passou a gravar publicacoes.classe e prazos.classe (ver função no Supabase).
-- Edge Function `prazos-classificar` lê classe+teor e grava as colunas categoria_sugerida*.

-- =====================================================================
-- 9) Reconciliação eProc: cadastra processos faltantes e liga órfãos (set/2026)
-- =====================================================================
-- Após conferência com a planilha do eProc 1º grau, 13 CNJs com prazos EM ABERTO
-- estavam sem processo cadastrado (prazos órfãos). Criados como 'Ativo' SEM
-- advogado_responsavel (aparecem no chip "Sem responsável" para atribuição) e
-- vinculados os prazos/publicações/audiências por CNJ. Operação idempotente:
-- reexecutar só afeta órfãos que ainda existirem.
-- (Script executado via CTE: cnj_src -> insert processos -> update prazos/publicacoes/audiencias.)

-- =====================================================================
-- 10) Fechamento robusto de prazos (set/2026)
-- =====================================================================
-- legalmail-reconcile v12: cumprido/excedido puxados SEM janela de captura
-- (limitados às 60 páginas mais recentes) — fecha prazos cumpridos tempos
-- depois da captura, que antes ficavam presos em "aberto".
-- IMPORTANTE: o "excedido" do Legal Mail é amplo (marca toda data vencida,
-- ~1.608), NÃO significa "perdido". Por isso NÃO usamos o excedido do LM como
-- "perdido" na tela. O sinal de "perdido/conferir" é o nosso: data < hoje e
-- cumprido=false (bucket "Vencidos" da tela de Prazos).
-- Observado: rodada completa fechou poucos prazos porque a maioria dos "vence
-- hoje" segue como PENDENTE no próprio Legal Mail (atraso de detecção do
-- peticionamento). Fechamento imediato desses depende de: (a) botão "✓ Cumprir"
-- manual (já existe), ou (b) wiring do webhook peticao_status (próximo passo).
