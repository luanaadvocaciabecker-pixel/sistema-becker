-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- audiencia_preparacao_checklist.sql — redesenho da lista/modal de Audiências: modalidade +
-- checklist marcável de preparação
-- Sessão de 15/09/2026, aplicado ao vivo via apply_migration (mesmo fluxo de sempre).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- CONTEXTO
-- Depois de publicar o olhinho de preparação em Audiências, ela mandou uma mensagem longa com
-- mockups pedindo pra elevar a tela inteira: a lista "mostra muita informação com pouca
-- hierarquia" e o modal deveria parecer um "painel operacional" (status de preparação, objetivo
-- processual, checklist marcável, pontos críticos), não um texto explicativo gerado. Perguntada
-- sobre 3 pontos em aberto, ela confirmou: (1) checklist só feito/pendente, mas os itens têm
-- que vir "com base nos autos... conforme cada caso" (gerados pela IA a partir do processo
-- real, não fixos); (2) modalidade (Presencial/Videoconferência) é campo novo, ela escolhe, sem
-- inferência automática; (3) o indicador de progresso deve ser "conforme os autos,
-- personalizado pra cada" — não 4 categorias fixas artificiais.

alter table public.audiencias add column if not exists modalidade text;
comment on column public.audiencias.modalidade is
  'Presencial ou Videoconferência, texto livre. Preenchido manualmente no cadastro (não é '
  'inferido do texto do campo local, por pedido explícito dela).';

alter table public.audiencias add column if not exists checklist_preparacao jsonb;
comment on column public.audiencias.checklist_preparacao is
  'Checklist marcável de preparação: {itens:[{texto,categoria,feito}], atualizado_em}. '
  'Separado do cache ia_preparacao de propósito — marcar um item feito não pode ser apagado só '
  'porque a orientação da IA foi "refeita". Mesclado no cliente (site/index.html): item cujo '
  'texto se repete na nova geração mantém o feito; item novo nasce desmarcado; item que a IA '
  'não repetiu mais some da lista.';

-- ACHADO: o "00:00" que aparecia na lista/modal quando o horário "não foi informado" não é bug
-- de exibição de valor nulo — NENHUMA audiência tem hora is null. 18 das 67 têm
-- hora='00:00:00', gravado assim pelo sync (Legal Mail/Projudi manda meia-noite quando não sabe
-- a hora real). Todo `a.hora?...:''` do código tratava isso como "tem hora" porque a string não
-- é vazia. Corrigido com um helper único (_horaAudienciaTexto) aplicado nos 3 lugares que
-- mostravam isso (dashboard, lista de audiências, modal) — não precisou de coluna nova.

-- Backfill ÚNICO, não é lógica permanente: 21 audiências já tinham "videoconferência" no
-- próprio texto do campo `tipo` (sincronizado, texto livre — medido: valores reais incluem
-- "Instrução por videoconferência", "Una por videoconferência" etc., não só as 5 opções do
-- formulário). Aproveitado só pra não deixar essas 21 sem modalidade no dia em que o campo
-- nasceu — daí em diante é sempre escolha manual no formulário.
update public.audiencias set modalidade='Videoconferência'
where tipo ilike '%videoconferência%' and modalidade is null;

-- Sem mudança de RLS/GRANT: colunas aditivas em `audiencias`, que já tem grant completo pra
-- `authenticated`.
