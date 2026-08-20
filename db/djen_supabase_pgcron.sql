-- DJEN automático dentro do Supabase (São Paulo / IP Brasil) via pg_net + pg_cron.
-- Método ATIVO em produção. Referência do que está aplicado no banco.
-- (aplicado via migrations: cria_tabela_publicacoes_djen, djen_pipeline_pgnet)

-- Extensões
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Tabela de rastreio dos pedidos assíncronos
-- CREATE TABLE public.djen_req(request_id bigint PRIMARY KEY, criado timestamptz DEFAULT now(), processado boolean DEFAULT false);

-- Funções: public.djen_fire(oab,uf,dias,paginas)  e  public.djen_process()
-- (ver migration djen_pipeline_pgnet para o corpo completo)

-- Agendamentos (07:00 e 07:06 BRT = 10:00 e 10:06 UTC):
-- SELECT cron.schedule('djen_fire_diario',   '0 10 * * *', $$SELECT public.djen_fire('40082','SC',15,6)$$);
-- SELECT cron.schedule('djen_process_diario','6 10 * * *', $$SELECT public.djen_process()$$);

-- Rodar manualmente / conferir:
--   SELECT public.djen_fire('40082','SC',15,6);   -- espere ~10s
--   SELECT public.djen_process();
--   SELECT count(*) FROM public.publicacoes;
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'djen%';
--   SELECT * FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'djen%') ORDER BY start_time DESC LIMIT 10;
