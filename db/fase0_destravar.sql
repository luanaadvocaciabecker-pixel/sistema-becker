-- ============================================================================
-- Becker Jurídico — Fase 0 (Destravar)
-- Projeto Supabase: "Becker Advogados" (fnuzhypsqvyolqqafrba)
-- Aplicado em: 2026-08-19
--
-- Contexto: o app enviava a chave pública (papel anon) em todas as chamadas de
-- dados. Com RLS ligado e SEM políticas nem grants, o banco recusava tudo
-- (permission denied / 42501). Estas mudanças liberam o acesso ao USUÁRIO
-- LOGADO (papel authenticated) — o público anônimo continua bloqueado.
-- O app foi ajustado em paralelo para enviar o token do login (ver index.html).
--
-- Não afeta os GPTs: eles usam a service_role (que ignora RLS) em outro projeto.
-- ============================================================================

-- 1) Políticas RLS: usuário logado (staff) tem acesso total; anônimo bloqueado.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clientes','processos','processos_adm','prazos','tarefas','audiencias',
    'alvaras','atendimentos','honorarios','parcelas','financeiro',
    'documentos','movimentacoes','historico','_import_pessoas'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS becker_staff_all ON public.%I;', t);
    EXECUTE format(
      'CREATE POLICY becker_staff_all ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      t
    );
  END LOOP;
END $$;

-- 2) Grants de tabela para o papel authenticated (o RLS acima é a trava fina).
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.clientes, public.processos, public.processos_adm, public.prazos,
  public.tarefas, public.audiencias, public.alvaras, public.atendimentos,
  public.honorarios, public.parcelas, public.financeiro, public.documentos,
  public.movimentacoes, public.historico
TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- 3) Alinhar honorarios/parcelas ao que o app usa (adição não destrutiva).
ALTER TABLE public.honorarios
  ADD COLUMN IF NOT EXISTS valor_total numeric,
  ADD COLUMN IF NOT EXISTS status      text,
  ADD COLUMN IF NOT EXISTS descricao   text,
  ADD COLUMN IF NOT EXISTS observacao  text;
ALTER TABLE public.parcelas
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS numero integer;

-- 4) Storage: usuário logado pode enviar/ler/atualizar/excluir no bucket de docs.
--    (Bucket segue público para leitura por link — endurecer é item da Fase 1/LGPD.)
DROP POLICY IF EXISTS docs_auth_all ON storage.objects;
CREATE POLICY docs_auth_all ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'documentos-clientes')
  WITH CHECK (bucket_id = 'documentos-clientes');
