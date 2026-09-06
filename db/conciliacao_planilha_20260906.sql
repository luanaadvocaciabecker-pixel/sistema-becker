-- Conciliação da planilha "PRAZOS BECKER 2026" (aba ATIVOS ATUAL, 686 linhas)
-- contra a tabela `processos`. Aplicado em 2026-09-06.
--
-- Resultado da conferência dos 644 CNJs distintos da planilha:
--   A) na planilha e sem cadastro ....... 8 -> 0 reais
--        4 números corrompidos pelo Excel em notação científica
--        1 erro de digitação (0000952-33.2024.5.12.0010 -> ...0016)
--        3 protocolos administrativos (não são CNJ)
--   B) responsável divergente ........... 0
--   C) planilha corrente x sistema encerrado ... 39
--   D) batendo 100% ..................... 597
--   E) ativo no sistema, fora da planilha ...... 105 (99 não estão em NENHUMA das 11 abas)

-- ---------------------------------------------------------------------------
-- Tabela auxiliar com o retrato da planilha (adv: L/A/S/M).
-- Populada a partir de PRAZOS BECKER 2026.xlsx, aba ATIVOS ATUAL.
-- ---------------------------------------------------------------------------
create table if not exists planilha_ativos_full(dig text primary key, adv text);
alter table planilha_ativos_full enable row level security;   -- sem policies: invisível ao app

-- ---------------------------------------------------------------------------
-- 1) Arquivar os 2 processos que a aba DISTRATADOS lista e que seguiam ativos
-- ---------------------------------------------------------------------------
update processos set situacao = 'Arquivado'
where regexp_replace(numero,'\D','','g') in (
  '50365937220268240038',   -- METALFORTE ESTRUTURAS METALICAS
  '00147414220238160188'    -- VALERIA MAZEPA MALHEIROS
);

-- ---------------------------------------------------------------------------
-- 2) Reativar os 7 (dos 39 divergentes) com sinal de vida.
--    Critério: publicação recente do Legal Mail e/ou prazo em aberto.
--    `movimentacoes.data` NÃO serve de sinal — vale 2026-06-07 (data da importação)
--    em quase todos os registros.
--    Os outros 32 não foram tocados: sem publicação desde antes de 07/2026 e sem
--    prazo aberto, ou seja, o arquivamento no sistema provavelmente está correto.
-- ---------------------------------------------------------------------------
update processos set situacao = 'Ativo'
where regexp_replace(numero,'\D','','g') in (
  '50391564420238240038',  -- BECKER ADVOGADOS      pub 2026-09-03, 1 prazo aberto
  '51724775020258240930',  -- MARIO SERGIO REIMER JR pub 2026-08-31
  '50455573020218240038',  -- ANDREZA BERTO MORAES   pub 2026-08-20, 2 prazos abertos
  '50391608120238240038',  -- BECKER ADVOGADOS       pub 2026-08-13
  '00015351320245120050',  -- GEOVANA SILVANO        pub 2026-07-17
  '00031661220248160088',  -- MOISES VICENTE         pub 2026-07-02
  '00007203320265120054'   -- WILHAN SCHNAIDER       pub 2027-06-08 (data futura, conferir)
);

-- ---------------------------------------------------------------------------
-- 3) Os 103 processos ativos que não constam da planilha -> sem responsável.
--    Decisão da Luana, mantida depois de eu registrar que não recomendo: o
--    responsável de todos os 103 estava correto e 99 nunca entraram em nenhuma
--    aba da planilha. Por isso o estado anterior fica salvo em backup.
-- ---------------------------------------------------------------------------
drop table if exists backup_resp_20260906;
create table backup_resp_20260906 as
with pl as (select dig from planilha_ativos_full)
select p.id, p.numero, p.advogado_responsavel, p.situacao, now() as salvo_em
from processos p
where p.situacao in ('Ativo','Em andamento')
  and not exists (select 1 from pl where pl.dig = regexp_replace(p.numero,'\D','','g'))
  and regexp_replace(p.numero,'\D','','g') not in ('50365937220268240038','00147414220238160188');
alter table backup_resp_20260906 enable row level security;

update processos set advogado_responsavel = null
where id in (select id from backup_resp_20260906);

-- ---------------------------------------------------------------------------
-- DESFAZER (a etapa 3 é a única destrutiva)
-- ---------------------------------------------------------------------------
-- tudo:
--   update processos p set advogado_responsavel = b.advogado_responsavel
--   from backup_resp_20260906 b where b.id = p.id;
--
-- só a Cibele (os 17 dela caíram na regra apenas porque a planilha não tem
-- coluna dela, não porque o cadastro estivesse errado):
--   update processos p set advogado_responsavel = b.advogado_responsavel
--   from backup_resp_20260906 b
--   where b.id = p.id and b.advogado_responsavel = 'Cibele Becker';

-- ---------------------------------------------------------------------------
-- Carga por advogada — antes x depois
--   antes:  MH 179 · Samaira 174 · Luana 169 · Alana 162 · Cibele 17 · sem resp. 1
--   depois: Luana 162 · MH 158 · Samaira 154 · Alana 130 · Cibele 0 · sem resp. 103
--   total de processos inalterado (758); carga 702 -> 707 (+7 reativados -2 arquivados)
-- ---------------------------------------------------------------------------
