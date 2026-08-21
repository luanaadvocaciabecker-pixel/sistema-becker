# Integração: Sistema de Gestão ← Projeto de Inteligência (DJEN)

## Arquitetura (uma coleta, um consumo)
- **Projeto "Becker Juris Intelligence"** (bpzuktssvdosxlxbaeyl) = MOTOR DE DADOS.
  Coleta DJEN/andamentos há meses (djen-pipeline v55, djen-boletim, digest-diario,
  alerta-prazos, detecta-cumprimento). Tabelas ricas: djen_publicacoes (~5,1k),
  movimentacoes_historico (~58k), djen_analises, radar_cumprimento, etc.
- **Projeto "Becker Advogados"** (fnuzhypsqvyolqqafrba) = SISTEMA DE GESTÃO (o app + WhatsApp).
  CONSOME os dados da Inteligência.

## O que foi feito
1. Backfill: 5.130 publicações da Inteligência → tabela `publicacoes` do sistema
   (casadas ao processo pelo CNJ). Resultado: 5.149 publicações, ~4.313 vinculadas.
2. Sync diário: função `sync_pub_gestao()` no projeto de Inteligência empurra as
   publicações recentes (janela de 4 dias) para o sistema via pg_net.
   Agendado no pg_cron: `sync_pub_gestao_diario` às 10:40 UTC (07:40 BRT).
3. Desligado o robô DJEN duplicado do sistema (crons djen_fire_diario / djen_process_diario),
   já que a fonte agora é a Inteligência.

## Manutenção / atenção
- A função `sync_pub_gestao()` usa a chave **service_role** do sistema de gestão embutida.
  Se essa chave for rotacionada (recomendado, pois foi exposta em chat), ATUALIZAR a chave
  dentro de `sync_pub_gestao()` no projeto de Inteligência, senão o sync para.
- DataJud (andamentos) do sistema continua vindo pelo GitHub Actions diário.
- Próximos aproveitáveis da Inteligência (ainda não espelhados): movimentacoes_historico (58k),
  djen_analises (resumos de IA), radar_cumprimento/oportunidades, feriados_forenses (cálculo de prazo).
