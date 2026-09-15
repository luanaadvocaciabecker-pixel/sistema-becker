-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- processo_coatuacao_externa.sql — tag de "advogado em co-atuação externa" em processos
-- Sessão de 15/09/2026, aplicado ao vivo via apply_migration (mesmo fluxo de sempre).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- CONTEXTO
-- Ela pediu: "tem como colocar tag, e a audiencia que ta a cibele e a o umberto, ai colcoar
-- tag com o nome do umberto" — depois esclareceu que não era sobre um caso específico (a
-- audiência que motivou a pergunta já tinha sido redesignada), e sim sobre uma CAPACIDADE em
-- geral: marcar visivelmente quando um processo tem um advogado de FORA do escritório atuando
-- em conjunto (o caso real por trás: Umberto Carlos Becker, pai da Cibele, advogado de outro
-- escritório — diferente dos processos "não nossos" dele, já tratados à parte na tabela
-- `processos_nao_nossos`; aqui é o caso OPOSTO, de co-atuação, não de exclusão).

-- ACHADO LATERAL (não corrigido nesta migração — registrado pra sinalizar depois)
-- `site/index.html` já referencia um campo parecido, "Advogado auxiliar"
-- (`advogado_auxiliar`), em `formProcesso`, na ficha do processo e no card da lista — só que a
-- coluna NÃO EXISTE no banco (confirmado com um SELECT direto: "column advogado_auxiliar does
-- not exist"). É meio-construído: grava/mostra na tela, mas UPDATE/INSERT com esse campo
-- preenchido vai falhar (hoje passa despercebido porque o código só inclui o campo no payload
-- se ele vier preenchido). O mesmo vale para `secretaria_responsavel`. Mesmo que a coluna
-- existisse, `advogado_auxiliar` é alimentado por um <select> fechado só com os 5
-- advogados/equipe INTERNA da Becker (advsOpts/respNomes/USUARIOS_BECKER) — não serve pra um
-- nome de fora como o Umberto. Por isso este campo novo é distinto e livre.

alter table public.processos add column if not exists advogado_coatuacao_externa text;

comment on column public.processos.advogado_coatuacao_externa is
  'Nome de um advogado de OUTRO escritório atuando em co-atuação neste processo específico '
  '(ex.: Umberto Carlos Becker). Texto livre, sem relação com a lista interna de responsáveis '
  '(USUARIOS_BECKER) — não confundir com advogado_responsavel.';

-- Sem mudança de RLS/GRANT: coluna aditiva numa tabela (`processos`) que já tem grant completo
-- pra `authenticated` — a mesma lição registrada em db/assessoria.sql sobre grants continua
-- valendo, só que aqui não há tabela nova, então não há nada a conferir.
