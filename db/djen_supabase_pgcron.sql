-- DJEN automático dentro do Supabase (São Paulo / IP Brasil) via pg_net + pg_cron.
-- Referência do que está aplicado no banco.
-- (aplicado via migrations: cria_tabela_publicacoes_djen, djen_pipeline_pgnet)
--
-- CORREÇÃO 08/09/2026 — este arquivo dizia "Método ATIVO em produção". NÃO ESTAVA.
-- As funções e a tabela existiam, mas `cron.job` não tinha nenhum job `djen%`: os agendamentos
-- abaixo estavam apenas comentados e nunca foram executados. A coleta rodava só à mão, e a
-- última linha DJEN havia entrado em 05/09. Ao agendar e disparar em 08/09, entraram de uma vez
-- 232 comunicações que estavam paradas. Os jobs agora estão criados e ativos (ver no fim).
--
-- POR QUE TEM DE RODAR DE DENTRO DO SUPABASE: a API Comunica do CNJ é geo-bloqueada por
-- CloudFront ("configured to block access from your country"). O banco está em sa-east-1, então
-- pg_net sai com IP brasileiro e passa. Chamada de fora do Brasil recebe 403.

-- Extensões
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Tabela de rastreio dos pedidos assíncronos
-- CREATE TABLE public.djen_req(request_id bigint PRIMARY KEY, criado timestamptz DEFAULT now(), processado boolean DEFAULT false);

-- Funções: public.djen_fire(p_oab text, p_uf text, p_dias int, p_paginas int)
--          public.djen_process()  -- devolve {"encontrados":N,"gravados_novos":N}
-- (ver migration djen_pipeline_pgnet para o corpo completo)

-- AGENDAMENTOS ATIVOS (criados em 08/09/2026). Horário em UTC; 10:00 UTC = 07:00 BRT.
--   SELECT cron.schedule('djen_fire_diario',    '0 10 * * *',  $$select public.djen_fire('40082','SC',15,6)$$);
--   SELECT cron.schedule('djen_process_diario', '6 10 * * *',  $$select public.djen_process()$$);
-- E, logo depois da coleta, a geração do prazo trabalhista (ver db/trt_gera_prazos.sql):
--   SELECT cron.schedule('trt_prazos_diario',   '20 10 * * *', $$select public.trt_gera_prazos(current_date - 15, current_date, true)$$);
--
-- A janela de 15 dias com 6 páginas é generosa de propósito: a API Comunica é janela móvel, não
-- arquivo — devolve menos do que a base já guarda. Se a coleta falhar por alguns dias, a janela
-- larga recupera o atraso sozinha, e a gravação é idempotente nas duas pontas.

-- Rodar manualmente / conferir:
--   SELECT public.djen_fire('40082','SC',15,6);   -- espere ~15s
--   SELECT public.djen_process();
--   SELECT count(*) FROM public.publicacoes;
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'djen%' OR jobname LIKE 'trt%';
--   SELECT * FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'djen%' OR jobname LIKE 'trt%') ORDER BY start_time DESC LIMIT 10;
