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
