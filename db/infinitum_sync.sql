-- Integração Infinitum — puxa cards de 5 POPs jurídicos (Controladoria, INTIMAÇÕES,
-- Peticionamento, Protocolo/Distribuição, Produção jurídica inicial) e alimenta telas
-- que já existem no Sistema Becker (Processos, Prazos/Publicações, Becker IA).
-- Não é uma tela nova — ver plano/decisão em conversa com a Luana.
-- A Edge Function que chama isto está em whatsapp-bot/edge-function-infinitum-sync.ts
--
-- Os outros 3 POPs da conta (CRM Comercial, Ativação do cliente, Cobrança de
-- Inadimplentes) ficam de fora por enquanto — não existe aba pra eles no sistema.
--
-- Formato do card do Infinitum (GET /cards/{id} ou GET /cards com `values` incluso):
--   { "id":"<uuid>", "title", "pop_id", "phase_id", "status", "position",
--     "assignee_ids":[], "assigned_to", "created_at", "updated_at",
--     "values":[ {"field_id","field_label","value","label"}, ... ] }
-- A Edge Function enriquece cada card com pop_name/phase_name/phase_is_completion
-- antes de mandar pra cá (a API só devolve os ids).
-- Os `field_label` variam por POP (config própria de cada um) — por isso a extração
-- abaixo é por RÓTULO (ilike), não por field_id fixo.

-- 1) Tabela unificada "o que o Infinitum tem sobre este processo" ------------------
create table if not exists public.infinitum_producao_juridica (
  id bigint generated always as identity primary key,
  infinitum_card_id uuid,
  pop_id uuid,
  pop_name text,
  phase_id uuid,
  phase_name text,
  phase_is_completion boolean not null default false,
  numero_processo_raw text,
  processo_id bigint references public.processos(id),
  title text,
  status text,
  card_created_at timestamptz,
  card_updated_at timestamptz,
  campos jsonb not null default '[]'::jsonb, -- array cru [{field_id,field_label,value,label}]
  synced_at timestamptz not null default now(),
  first_synced_at timestamptz not null default now()
);
create unique index if not exists uq_infinitum_producao_card
  on public.infinitum_producao_juridica(infinitum_card_id) where infinitum_card_id is not null;
create index if not exists idx_infinitum_producao_processo on public.infinitum_producao_juridica(processo_id);
create index if not exists idx_infinitum_producao_pop on public.infinitum_producao_juridica(pop_id);

alter table public.infinitum_producao_juridica enable row level security;
create policy infinitum_producao_staff_all on public.infinitum_producao_juridica
  for all to authenticated using (true) with check (true);

-- 2) Colunas novas em publicacoes/prazos (mesmo padrão do legalmail_id) ------------
alter table public.publicacoes add column if not exists infinitum_id uuid;
alter table public.publicacoes add column if not exists fonte text;
create unique index if not exists uq_publicacoes_infinitum
  on public.publicacoes(infinitum_id) where infinitum_id is not null;

alter table public.prazos add column if not exists infinitum_id uuid;
alter table public.prazos add column if not exists fonte text;
create unique index if not exists uq_prazos_infinitum
  on public.prazos(infinitum_id) where infinitum_id is not null;

-- status novo 'estimado_ia': igual 'estimado' (não confirmado por humano), mas veio
-- de uma IA que leu o documento de verdade (Infinitum/Publijus), não do nosso chute
-- de "+15 dias úteis" — merece selo diferente na tela. confirmarPrazo() já trata
-- qualquer status não-confirmado do mesmo jeito, não precisa mudar nada lá.

-- 3) Helper de extração por rótulo -------------------------------------------------
-- Acha o primeiro valor não-vazio cujo field_label bate com `pat` (ilike), opcionalmente
-- excluindo rótulos que batam com `excl` (usado pra separar "Data" de "Data do prazo
-- (Estipulado pela IA)", que também contém "data").
create or replace function public.infinitum_field(campos jsonb, pat text, excl text default null)
returns text language sql immutable as $$
  select nullif(v->>'value','')
  from jsonb_array_elements(coalesce(campos,'[]'::jsonb)) v
  where (v->>'field_label') ilike pat
    and (excl is null or (v->>'field_label') not ilike excl)
  limit 1
$$;
revoke all on function public.infinitum_field(jsonb,text,text) from anon, authenticated;

-- 4) Upsert genérico de card -> infinitum_producao_juridica (todos os 5 POPs) -----
-- Chamada 1x por página pela Edge Function (nunca acumula tudo num array só — foi
-- exatamente isso que estourou statement_timeout e perdeu dado no reconcile do
-- Legal Mail; ver comentário em legalmail_webhook.sql).
create or replace function public.infinitum_upsert_producao(cards jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  item jsonb; cid uuid; num text; digits text; pid bigint;
  n_recebidos int:=0; n_gravados int:=0; n_vinculados int:=0;
begin
  if cards is null or jsonb_typeof(cards) <> 'array' then
    return jsonb_build_object('erro','sem array de cards');
  end if;

  for item in select value from jsonb_array_elements(cards) loop
    n_recebidos := n_recebidos + 1;
    begin cid := (item->>'id')::uuid; exception when others then cid := null; end;
    if cid is null then continue; end if;

    num := coalesce(public.infinitum_field(item->'values','%número do processo%'),
                     public.infinitum_field(item->'values','%numero do processo%'));
    digits := regexp_replace(coalesce(num,''),'\D','','g');
    pid := null;
    if digits <> '' and digits !~ '^0+$' then
      select p.id into pid from public.processos p
       where regexp_replace(coalesce(p.numero,''),'\D','','g') = digits limit 1;
    end if;

    insert into public.infinitum_producao_juridica(
      infinitum_card_id, pop_id, pop_name, phase_id, phase_name, phase_is_completion,
      numero_processo_raw, processo_id, title, status, card_created_at, card_updated_at,
      campos, synced_at
    ) values (
      cid,
      nullif(item->>'pop_id','')::uuid, item->>'pop_name',
      nullif(item->>'phase_id','')::uuid, item->>'phase_name',
      coalesce((item->>'phase_is_completion')::boolean,false),
      num, pid, item->>'title', item->>'status',
      nullif(item->>'created_at','')::timestamptz, nullif(item->>'updated_at','')::timestamptz,
      coalesce(item->'values','[]'::jsonb), now()
    )
    on conflict (infinitum_card_id) where infinitum_card_id is not null
    do update set
      pop_id               = excluded.pop_id,
      pop_name             = coalesce(nullif(excluded.pop_name,''), infinitum_producao_juridica.pop_name),
      phase_id             = excluded.phase_id,
      phase_name           = coalesce(nullif(excluded.phase_name,''), infinitum_producao_juridica.phase_name),
      phase_is_completion  = excluded.phase_is_completion,
      numero_processo_raw  = coalesce(nullif(excluded.numero_processo_raw,''), infinitum_producao_juridica.numero_processo_raw),
      processo_id          = coalesce(excluded.processo_id, infinitum_producao_juridica.processo_id),
      title                = coalesce(nullif(excluded.title,''), infinitum_producao_juridica.title),
      status               = excluded.status,
      card_created_at      = coalesce(excluded.card_created_at, infinitum_producao_juridica.card_created_at),
      card_updated_at      = coalesce(excluded.card_updated_at, infinitum_producao_juridica.card_updated_at),
      campos = case when exists (
                 select 1 from jsonb_array_elements(excluded.campos) e where coalesce(e->>'value','') <> ''
               ) then excluded.campos else infinitum_producao_juridica.campos end,
      synced_at = now();

    n_gravados := n_gravados + 1;
    if pid is not null then n_vinculados := n_vinculados + 1; end if;
  end loop;

  return jsonb_build_object('recebidos', n_recebidos, 'gravados', n_gravados, 'vinculados', n_vinculados);
end $$;
revoke all on function public.infinitum_upsert_producao(jsonb) from anon, authenticated;
grant execute on function public.infinitum_upsert_producao(jsonb) to service_role;

-- 5) Reconciliação pro lado de intimações/publicações (só Controladoria/INTIMAÇÕES) -
-- Publicações do Infinitum sempre entram como registro novo (chave própria
-- `infinitum_id`, não tentamos casar com publicação já existente do Legal Mail).
-- Já o PRAZO derivado tenta evitar duplicar: se o processo já tem um prazo em aberto
-- (não cumprido, não confirmado por humano), atualiza ele em vez de criar um segundo
-- prazo pro mesmo processo — sobe o status pra 'estimado_ia' quando aplicável.
-- ⚠️ Esse casamento é uma heurística (por processo, não por data exata) — ainda não
-- dá pra validar com dado real dos dois lados pro mesmo processo. Reavaliar quando
-- o Infinitum começar a ter card de verdade.
create or replace function public.infinitum_reconcile_intimacoes(cards jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  item jsonb; cid uuid; num text; digits text; pid bigint;
  tribunal text; orgao text; tipo_com text; resumo text; link text;
  ddisp date; dprazo date; prz_id bigint;
  n_pub int:=0; n_prz int:=0; n_vazio int:=0;
begin
  if cards is null or jsonb_typeof(cards) <> 'array' then
    return jsonb_build_object('erro','sem array de cards');
  end if;

  for item in select value from jsonb_array_elements(cards) loop
    begin cid := (item->>'id')::uuid; exception when others then cid := null; end;
    if cid is null then continue; end if;

    num := coalesce(public.infinitum_field(item->'values','%número do processo%'),
                     public.infinitum_field(item->'values','%numero do processo%'));
    digits := regexp_replace(coalesce(num,''),'\D','','g');
    pid := null;
    if digits <> '' and digits !~ '^0+$' then
      select p.id into pid from public.processos p
       where regexp_replace(coalesce(p.numero,''),'\D','','g') = digits limit 1;
    end if;

    tribunal := public.infinitum_field(item->'values','%tribunal%');
    orgao    := coalesce(public.infinitum_field(item->'values','%órgão%'), public.infinitum_field(item->'values','%orgao%'));
    tipo_com := public.infinitum_field(item->'values','%tipo de comunica%');
    resumo   := public.infinitum_field(item->'values','%resumo%');
    link     := public.infinitum_field(item->'values','%link%');
    ddisp    := public.lm_date(public.infinitum_field(item->'values','%data%','%prazo%'));
    dprazo   := public.lm_date(public.infinitum_field(item->'values','%estipulad%'));

    -- Card sem nenhum conteúdo útil ainda (comum: card criado pelo webhook do
    -- Publijus, mas o Infinitum ainda não preencheu os campos) -> pula. Sem isso,
    -- toda rodada do cron recriaria uma publicação em branco pro mesmo card vazio.
    if num is null and tribunal is null and resumo is null and link is null then
      n_vazio := n_vazio + 1;
      continue;
    end if;

    insert into public.publicacoes(infinitum_id, processo_id, numero_processo, tribunal, tipo,
                                   data_disponibilizacao, texto, link, lida, prazo_gerado, fonte)
    values (cid, pid, num,
            coalesce(tribunal,'') || case when orgao is not null then ' - '||orgao else '' end,
            coalesce(tipo_com,'Intimação'), ddisp, resumo, link, false, (dprazo is not null), 'infinitum')
    on conflict (infinitum_id) where infinitum_id is not null
    do update set processo_id           = coalesce(excluded.processo_id, publicacoes.processo_id),
                  tribunal              = coalesce(nullif(excluded.tribunal,''), publicacoes.tribunal),
                  texto                 = coalesce(nullif(excluded.texto,''), publicacoes.texto),
                  link                  = coalesce(nullif(excluded.link,''), publicacoes.link),
                  data_disponibilizacao = coalesce(excluded.data_disponibilizacao, publicacoes.data_disponibilizacao);
    n_pub := n_pub + 1;

    if dprazo is not null and pid is not null then
      prz_id := null;
      select pz.id into prz_id from public.prazos pz
       where pz.processo_id = pid
         and pz.cumprido = false
         and coalesce(pz.status,'') <> 'confirmado'
       order by pz.data desc nulls last
       limit 1;

      if prz_id is not null then
        update public.prazos
           set infinitum_id = cid,
               data = dprazo, data_prazo = dprazo,
               status = case when status = 'estimado' then 'estimado_ia' else status end
         where id = prz_id;
      else
        insert into public.prazos(infinitum_id, processo_id, descricao, data_prazo, data, tipo, status, alertar_dias, cumprido, fonte)
        values (cid, pid, left(coalesce(tipo_com,'Intimação')||' — '||coalesce(resumo,''),200),
                dprazo, dprazo, coalesce(tipo_com,'Intimação'), 'estimado_ia', 3, false, 'infinitum')
        on conflict (infinitum_id) where infinitum_id is not null do nothing;
      end if;
      n_prz := n_prz + 1;
    end if;
  end loop;

  return jsonb_build_object('publicacoes', n_pub, 'prazos', n_prz, 'ignorados_vazios', n_vazio);
end $$;
revoke all on function public.infinitum_reconcile_intimacoes(jsonb) from anon, authenticated;
grant execute on function public.infinitum_reconcile_intimacoes(jsonb) to service_role;

-- 6) Agendamento horário (kanban se move durante o expediente, diferente de prazo
--    jurídico que é conferido 1x/dia). timeout_milliseconds:=300000 já de cara —
--    o reconcile do Legal Mail começou em 120000 e precisou subir depois; não repetir.
-- SELECT cron.schedule('infinitum_sync_horario','15 * * * *',
--   $$ select net.http_post(
--        url:='https://<PROJ>.supabase.co/functions/v1/infinitum-sync',
--        headers:=jsonb_build_object('Content-Type','application/json','x-infinitum-sync-key','<KEY>'),
--        body:='{}'::jsonb, timeout_milliseconds:=300000) $$);
