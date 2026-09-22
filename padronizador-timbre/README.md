# Padronizador Becker — Do timbre ao documento

Ferramenta web (roda 100% no navegador, sem servidor) que aplica o **timbre e a
matriz textual do escritório** a uma petição `.docx`, preservando cabeçalho,
rodapé, imagens e estilos da matriz.

## Como funciona
1. **Configurar** — escolhe o modelo (Peça simples ou Peça bipartida).
2. **Identificar** — carrega a **matriz Becker** (timbre) + a **petição**; o app
   lê o `word/document.xml` e classifica cada bloco (endereçamento, identificação,
   título, capítulo, subcapítulo, corpo, citação, figura, legenda, pedidos,
   fechamento, data, assinatura).
3. **Conferir** — lista os blocos com o tipo detectado (editável) e sinaliza os
   ambíguos.
4. **Gerar** — monta o `.docx` final **sobre a matriz** (o timbre do cabeçalho é
   sempre preservado), aplicando a matriz textual por tipo de bloco, e valida.

## Matriz textual aplicada (por tipo de bloco)
| Bloco | Formatação |
|-------|------------|
| Corpo | Calibri 12, justificado, 1ª linha 6 cm, 12 pt antes/depois |
| Título da peça | Calibri 12 negrito, CAIXA ALTA, branco, faixa azul `#002060`, centralizado |
| Capítulo | Calibri 12 negrito, CAIXA ALTA, branco, faixa azul `#002060`, justificado |
| Subcapítulo | Calibri 12 negrito, CAIXA ALTA, preto, esquerda, sem faixa, sem recuo |
| Citação | Calibri 10, justificado, recuo esquerdo 6 cm, 12 pt antes/depois |
| Legenda | Calibri 10, centralizada |
| Pedidos (alíneas a, b, c…) | Calibri 12, justificado, 1ª linha 6 cm |
| Endereçamento | Calibri 12 negrito, CAIXA ALTA, 24 pt depois |
| Fechamento | "Nestes termos," / "Pede deferimento." em linhas consecutivas (0 entre elas) |
| Data / Assinatura | Calibri 12, recuo 6 cm; nome e OAB em negrito |

## Arquivos
- `index.html` — interface (carrega JSZip via CDN).
- `script.js` — toda a lógica (classificação + geração OOXML + validação).
- `style.css` — estilos da interface.

## Observações técnicas
- O **timbre** vive no cabeçalho da matriz (`word/header*.xml`) e é **sempre
  preservado** — a geração constrói o documento por cima da matriz e nunca mexe
  em cabeçalho/rodapé. Uma trava de validação bloqueia o download se algum
  cabeçalho, rodapé ou imagem da matriz se perder.
- A citação é detectada por conteúdo (aspas, "Súmula", "STJ/TJ", "REsp",
  transcrição, ementa), não apenas pelo recuo.
