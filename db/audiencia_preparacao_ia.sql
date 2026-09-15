-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- audiencia_preparacao_ia.sql — "olhinho" de preparação para Audiências
-- Sessão de 15/09/2026, aplicado ao vivo via apply_migration (mesmo fluxo de sempre).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- CONTEXTO
-- Ela perguntou: "da para colocar um olhinho na aprte da audiencia e tipo dar dicas de pontos
-- favoraveis nossos ? tipo igual tem no prazo ?" — pedindo algo análogo ao olhinho já existente
-- em Prazos (botão 👁️ que abre um briefing gerado por IA, ver `prazos.ia_orientacao`/
-- `ia_orientacao_em` e a edge function `prazo-orientacao`). Perguntada se queria o MESMO
-- formato do Prazo (pontos a favor/contra) ou algo focado em preparação da audiência em si,
-- ela escolheu preparação — o conteúdo aqui NÃO replica "A NOSSO FAVOR"/"CONTRA NÓS", e sim
-- orienta o que levar/preparar pra audiência (ver edge function `audiencia-preparacao`).

alter table public.audiencias add column if not exists ia_preparacao jsonb;
alter table public.audiencias add column if not exists ia_preparacao_em timestamptz;

comment on column public.audiencias.ia_preparacao is
  'Cache do briefing de preparação gerado por IA (edge function audiencia-preparacao): '
  '{o_que_e, o_que_levar[], o_que_preparar[], pontos_atencao[]}. Mesmo padrão de cache de '
  'prazos.ia_orientacao — da 2ª abertura em diante não gasta nada.';
comment on column public.audiencias.ia_preparacao_em is
  'Quando o cache de ia_preparacao foi gerado.';

-- GRÁTIS POR CONSTRUÇÃO, mesmo raciocínio do prazo-orientacao: a edge function só lê dados já
-- guardados (audiencias + processos), nenhuma chamada ao Legal Mail. Sem tabela nova, sem
-- mudança de RLS/GRANT — colunas aditivas em `audiencias`, que já tem grant completo pra
-- `authenticated`.
