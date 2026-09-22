-- prazos_verifica_partes — detecta prazo gerado para o nosso cliente quando o despacho, na
-- verdade, manda AGIR A PARTE CONTRÁRIA.
--
-- POR QUE EXISTE: nem `trt_gera_prazos` nem `lm_upsert_prazo_por_texto` conferem quem foi
-- intimado — só acham "verbo + prazo" (TRT) ou um cartão de metadado do legalmail que informa o
-- polo do ADVOGADO na caixa, não o alvo da ordem do despacho (rota não-TRT). Caso real que expôs
-- o bug: processo 5078050-32.2023.8.24.0930 (nosso cliente = EXECUTADO) — o despacho manda
-- "intime-se a parte EXEQUENTE para indicar bens...", mas o sistema gerou 3 prazos pro nosso lado.
--
-- COMO FUNCIONA: passada de regex, sem custo de IA, em cima do teor REAL do ato (via
-- `prazo_ato_origem`, não do cartão de recibo do legalmail). Procura um verbo diretivo
-- (intime-se/cientifique-se/dê-se ciência/abra-se vista/manifeste-se) seguido, a até 80
-- caracteres, de um papel processual (autor/réu/exequente/executado/apelante/agravante...).
-- Compara esse papel com `processos.polo_cliente` usando `polo_sinonimos`, que agrupa os papéis
-- por EIXO (conhecimento/execução/embargos/recurso/mandado de segurança) — comparar por eixo, não
-- só autor-x-réu, é o que evita alarme falso entre sinônimos da MESMA parte em fases diferentes
-- (ex.: REQUERENTE≈AUTORA; APELANTE≈RECORRENTE — mesmo lado, rótulo diferente).
--
-- NUNCA muda status/acao/responsavel do prazo — só grava um alerta pra revisão humana, no mesmo
-- espírito de auditoria_veredito/categoria_sugerida (colunas de sinalização, não de decisão).
--
-- Camada 2 (IA): a edge function `prazo-orientacao` (Gemini, sob demanda quando alguém abre o
-- "ver orientação" de um prazo) foi estendida para preencher os MESMOS campos com fonte='ia',
-- pegando os casos indiretos que esse regex não capta (frase composta, referência a parte citada
-- antes etc.). Rodar em cima do teor real também, então concorda ou refina o veredito do regex.

create table if not exists public.polo_sinonimos (
  papel text primary key,
  eixo  text not null,
  lado  text not null check (lado in ('A','B'))
);

insert into public.polo_sinonimos (papel, eixo, lado) values
  ('AUTOR','conhecimento','A'), ('AUTORA','conhecimento','A'),
  ('AUTORES','conhecimento','A'), ('AUTORAS','conhecimento','A'),
  ('REQUERENTE','conhecimento','A'), ('REQUERENTES','conhecimento','A'),
  ('DEMANDANTE','conhecimento','A'), ('DEMANDANTES','conhecimento','A'),
  ('RECLAMANTE','conhecimento','A'), ('RECLAMANTES','conhecimento','A'),

  ('RÉU','conhecimento','B'), ('REU','conhecimento','B'),
  ('RÉUS','conhecimento','B'), ('REUS','conhecimento','B'),
  ('RÉ','conhecimento','B'), ('RÉS','conhecimento','B'),
  ('REQUERIDO','conhecimento','B'), ('REQUERIDA','conhecimento','B'),
  ('REQUERIDOS','conhecimento','B'), ('REQUERIDAS','conhecimento','B'),
  ('DEMANDADO','conhecimento','B'), ('DEMANDADA','conhecimento','B'),
  ('DEMANDADOS','conhecimento','B'), ('DEMANDADAS','conhecimento','B'),
  ('RECLAMADO','conhecimento','B'), ('RECLAMADA','conhecimento','B'),
  ('RECLAMADOS','conhecimento','B'), ('RECLAMADAS','conhecimento','B'),
  ('ACUSADO','conhecimento','B'), ('ACUSADA','conhecimento','B'),
  ('ACUSADOS','conhecimento','B'), ('ACUSADAS','conhecimento','B'),

  ('EXEQUENTE','execucao','A'), ('EXEQUENTES','execucao','A'),
  ('EXECUTADO','execucao','B'), ('EXECUTADA','execucao','B'),
  ('EXECUTADOS','execucao','B'), ('EXECUTADAS','execucao','B'),

  ('EMBARGANTE','embargos','A'), ('EMBARGANTES','embargos','A'),
  ('EMBARGADO','embargos','B'), ('EMBARGADA','embargos','B'),
  ('EMBARGADOS','embargos','B'), ('EMBARGADAS','embargos','B'),

  ('APELANTE','recurso','A'), ('APELANTES','recurso','A'),
  ('AGRAVANTE','recurso','A'), ('AGRAVANTES','recurso','A'),
  ('RECORRENTE','recurso','A'), ('RECORRENTES','recurso','A'),
  ('APELADO','recurso','B'), ('APELADA','recurso','B'),
  ('APELADOS','recurso','B'), ('APELADAS','recurso','B'),
  ('AGRAVADO','recurso','B'), ('AGRAVADA','recurso','B'),
  ('AGRAVADOS','recurso','B'), ('AGRAVADAS','recurso','B'),
  ('RECORRIDO','recurso','B'), ('RECORRIDA','recurso','B'),
  ('RECORRIDOS','recurso','B'), ('RECORRIDAS','recurso','B'),

  ('IMPETRANTE','mandado_seguranca','A'), ('IMPETRANTES','mandado_seguranca','A'),
  ('IMPETRADO','mandado_seguranca','B'), ('IMPETRADA','mandado_seguranca','B'),
  ('IMPETRADOS','mandado_seguranca','B'), ('IMPETRADAS','mandado_seguranca','B')
on conflict (papel) do nothing;

alter table public.prazos
  add column if not exists alerta_parte_status text,
  add column if not exists alerta_parte_motivo text,
  add column if not exists alerta_parte_fonte  text,
  add column if not exists alerta_parte_em     timestamptz;

create or replace function public.prazos_verifica_partes(
  p_limit int default 1000,
  p_commit boolean default true
)
returns table(
  prazo_id bigint, processo_id bigint, numero text, cliente text,
  polo_cliente text, papel_no_ato text, status text, motivo text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_eixo_cliente text;
  v_lado_cliente text;
  v_ato record;
  v_tails text[];
  v_papeis text[];
  v_papel text;
  v_eixo text;
  v_lado text;
  v_tem_contrario boolean;
  v_tem_mesmo boolean;
  v_papel_contrario text;
  v_status text;
  v_motivo text;
begin
  create temp table _res (
    prazo_id bigint, processo_id bigint, numero text, cliente text,
    polo_cliente text, papel_no_ato text, status text, motivo text
  ) on commit drop;

  for r in
    select pz.id as prazo_id, pz.processo_id, pr.numero, pr.polo_cliente,
           c.nome as cliente
    from public.prazos pz
    join public.processos pr on pr.id = pz.processo_id
    left join public.clientes c on c.id = pr.cliente_id
    where coalesce(pz.cumprido,false) = false
      and pz.status not in ('concluido')
    order by pz.id
    limit p_limit
  loop
    v_eixo_cliente := null; v_lado_cliente := null;
    v_status := null; v_motivo := null; v_papel := null;

    if r.polo_cliente is null then
      v_status := 'sem_polo';
      v_motivo := 'processo sem polo_cliente identificado — não dá para comparar';
    else
      select eixo, lado into v_eixo_cliente, v_lado_cliente
      from public.polo_sinonimos where papel = upper(btrim(r.polo_cliente));

      if v_eixo_cliente is null then
        v_status := 'sem_polo';
        v_motivo := format('polo_cliente "%s" não está no dicionário de sinônimos', r.polo_cliente);
      else
        select * into v_ato from public.prazo_ato_origem(r.prazo_id) limit 1;

        if v_ato.teor is null then
          v_status := 'sem_teor';
          v_motivo := 'teor do ato não encontrado no banco (nem próprio, nem vizinho)';
        else
          -- Em duas etapas de propósito: um regex só (verbo + [^.;:]{0,80}? + papel, tudo numa
          -- passada com quantificador preguiçoso) casa "executada" em vez de "exequente" mais
          -- perto do verbo em despachos reais (confirmado no caso 5078050-32/DIEGO DELZIOVO:
          -- "intime-se a parte exequente para..." dava match em "executada", que só aparece
          -- depois) — o motor de regex do Postgres, mesmo com quantificador não-guloso, não
          -- garante achar a alternativa mais próxima quando combinada com [^.;:]{0,N}? antes.
          -- Separando em (1) recorta os até 80 caracteres depois do verbo, sem alternância de
          -- papel na mesma passada, e (2) procura o primeiro papel DENTRO desse recorte isolado,
          -- o resultado bate com o texto real (testado e confirmado).
          select array_agg(m[1]) into v_tails
          from regexp_matches(
            v_ato.teor,
            '(?i)(?:intime|intimem|cientifique|cientifiquem|d(?:ê|e)(?:em)?[- ]se ci(?:ê|e)ncia|abra(?:m)?[- ]se vista|d(?:ê|e)[- ]se vista|conceda(?:m)?[- ]se vista|manifeste|manifestem)([^.;:]{0,80})',
            'g'
          ) m;

          v_papeis := null;
          if v_tails is not null then
            select array_agg(distinct upper(papel)) into v_papeis
            from (
              select (regexp_match(
                       tail,
                       '(?i)\y(AUTOR(?:A|ES|AS)?|REQUERENTES?|DEMANDANTES?|RECLAMANTES?|R[ÉE]US?|RÉS?|REQUERID[OA]S?|DEMANDAD[OA]S?|RECLAMAD[OA]S?|ACUSAD[OA]S?|EXEQUENTES?|EXECUTAD[OA]S?|EMBARGANTES?|EMBARGAD[OA]S?|APELANTES?|APELAD[OA]S?|AGRAVANTES?|AGRAVAD[OA]S?|RECORRENTES?|RECORRID[OA]S?|IMPETRANTES?|IMPETRAD[OA]S?)\y'
                     ))[1] as papel
              from unnest(v_tails) as u(tail)
            ) sub
            where papel is not null;
          end if;

          if v_papeis is null or array_length(v_papeis,1) = 0 then
            v_status := 'sem_papel_identificado';
            v_motivo := 'nenhum verbo diretivo com papel processual reconhecido perto — revisar manualmente (ou aguardar camada de IA)';
          else
            v_tem_contrario := false; v_tem_mesmo := false; v_papel_contrario := null;
            foreach v_papel in array v_papeis loop
              select eixo, lado into v_eixo, v_lado from public.polo_sinonimos where papel = v_papel;
              if v_eixo = v_eixo_cliente then
                if v_lado = v_lado_cliente then
                  v_tem_mesmo := true;
                else
                  v_tem_contrario := true;
                  v_papel_contrario := coalesce(v_papel_contrario, v_papel);
                end if;
              end if;
            end loop;

            if v_tem_contrario and not v_tem_mesmo then
              v_status := 'conferir_parte_contraria';
              v_motivo := format(
                'despacho intima "%s" (parte contrária ao nosso cliente, que é %s) — conferir se o prazo é mesmo nosso',
                v_papel_contrario, r.polo_cliente
              );
            elsif v_tem_contrario and v_tem_mesmo then
              v_status := 'ambas_partes';
              v_motivo := format('despacho intima as duas partes ("%s" e o nosso lado, %s) — conferir o que cabe a cada uma', v_papel_contrario, r.polo_cliente);
            else
              v_status := 'ok';
              v_motivo := format('papel intimado bate com o nosso cliente (%s)', r.polo_cliente);
            end if;
          end if;
        end if;
      end if;
    end if;

    insert into _res values (r.prazo_id, r.processo_id, r.numero, r.cliente, r.polo_cliente, v_papel_contrario, v_status, v_motivo);
  end loop;

  if p_commit then
    update public.prazos pz
       set alerta_parte_status = x.status,
           alerta_parte_motivo = x.motivo,
           alerta_parte_fonte  = 'regex',
           alerta_parte_em     = now()
      from _res x
     where x.prazo_id = pz.id
       and x.status is not null
       -- nunca sobrescreve um veredito já dado pela camada de IA (mais confiável)
       and coalesce(pz.alerta_parte_fonte,'regex') = 'regex';
  end if;

  return query select * from _res order by prazo_id;
end $function$;
