# Lições — erros que já custaram, e a regra que cada um deixou

Lista corrida, mais recente em cima. Serve para não repetir. Cada entrada tem **o que
aconteceu**, **o que custou**, **a causa** e **a regra**. O detalhe técnico fica no arquivo
apontado em cada item.

Quem for mexer em rotina automática ou em qualquer chamada de API paga: leia as regras em
**negrito** antes.

---

## 10/09/2026 — tema claro colado por cima do escuro, e a busca que prometia o que não fazia

**O que aconteceu.** Ela mandou print da busca do topo: *"não tá dando para ver as escritas e na
parte de processo quando eu procuro pelo nome da pessoa não aparece"*. Dois defeitos sem relação
entre si, no mesmo lugar da tela.

**Custo.** Nenhum em dinheiro, e é o pior tipo de defeito: **ela não confia mais na busca**. Quem
digita um nome, não acha, e conclui que o processo não está cadastrado — quando está.

**Causa 1 — cascata.** O sistema nasceu escuro e o tema claro entrou **por sobreposição**, com
`body{...}` redefinindo as variáveis mais adiante no arquivo. Quem tinha fundo escuro cravado em
hex precisou de uma linha de correção. Ela existe, e **três lugares ficaram fora da lista**: o
campo do topo escurecia **ao receber foco** (ela não via o que digitava), o painel de resultados
ficava a ~1,1:1 de contraste, e a lista de opção de **todo** `select` do sistema abria escura com
texto escuro. Existia até um neutralizador de estilo escuro — mas **escopado em `#conteudo`**, e
a barra do topo fica fora dele.

**Causa 2 — a busca.** Quatro defeitos somados, todos medidos antes de mexer:

| | digitado | achava | devia achar |
|---|---|---|---|
| não filtrava pelo cliente, apesar do campo dizer "Buscar número, **cliente**, assunto" | `miraci` | 0 | 2 |
| acento: `ilike` é literal | `sebastiao` (clientes) | 0 | 3 |
| vírgula é separador no `or=(...)` do PostgREST e corrompia a consulta | `OLIVEIRA, FLAVIO` | erro silencioso | — |
| frase exata não casa nome fora de ordem | `SILVA JOSE` (clientes) | 0 | 6 |

**REGRAS:**
19. **Placeholder é promessa: o que o campo diz que busca, tem de buscar.** "Buscar número,
    cliente, assunto" com o cliente de fora é a tela mentindo para quem usa. Ao mexer num
    filtro, ler o texto do campo e conferir item por item.
20. **Tema por sobreposição precisa de lista fechada, não de memória.** A correção do tema claro
    é uma lista de seletores escrita à mão — o que não entrar nela fica quebrado e ninguém vê.
    Ao acrescentar componente com fundo em hex, entrar na lista no mesmo commit. E cuidado com
    neutralizador escopado (`#conteudo`): topo e rodapé ficam fora.
21. **`:hover`/`:focus` também são estado visual.** Os três lugares quebrados incluíam um
    `:focus` — a tela parecia certa parada e quebrava ao ser usada. Conferir o estado ativo.
22. **Termo digitado nunca vai cru para dentro de `or=(...)`.** Vírgula e parêntese são sintaxe
    ali. Normalizar num lugar só (`_termoBusca()`), usado por todas as buscas.
23. **Busca de nome próprio é "todas as palavras, em qualquer ordem".** Frase exata deu 0 em
    todos os casos de duas palavras que eu testei. Ninguém digita o nome na ordem do cadastro.
24. **Verdade repetida em três lugares divergiu em três lugares.** O mapa de quem-é-quem existia
    no JS *e* em duas tabelas escritas à mão na tela; a Alana aparecia num e-mail que não existe
    e a Samaira não existia em lugar nenhum. Agora as tabelas são renderizadas do mapa. Fonte
    única, ou não é fonte.

Detalhe: `db/busca_sem_acento.sql`

---

## 10/09/2026 — desliguei o gasto e desliguei, sem ver, a entrada de prazo de 5 tribunais

**O que aconteceu.** Para estancar os R$ 461 acima, desliguei os dois crons do Legal Mail em
09/09 às 18:20. No dia seguinte a Luana perguntou *"os prazos de hoje e de amanhã de todos os
tribunais já estão no sistema?"* e a medição mostrou que **nenhum prazo novo de tribunal
não-trabalhista havia nascido desde o desligamento**: entraram 60 publicações no dia, 0 com
"Data final", e os 3 prazos criados eram todos do caminho calculado do TRT.

**Custo.** 18 prazos (vencimentos de 16/09 a 01/10, incluindo sentenças) ficaram fora do sistema
por ~16 horas. Não perdeu prazo porque nenhum era de hoje ou amanhã — **foi sorte, não desenho.**

**Causa.** Só existem dois caminhos que criam prazo, e eu conhecia os dois sem ter cruzado o
escopo deles:

| caminho | exige | cobre |
|---|---|---|
| `lm_upsert_prazo_por_texto` | texto com "Data final" | qualquer tribunal |
| `trt_gera_prazos` | `tribunal ~ '^(TRT|TST)'` | só trabalhista |

E o dado que fecha a conta: em 01/08–10/09, a "Intimação por sistema" do eProc (a única que traz
"Data final") aparece **757 vezes, e 0 delas pelo DJEN**. O DJEN do CNJ não traz "Data final" em
nenhuma das 1.199 linhas. Ou seja: o `notices` pago era o **único** alimentador de TJSC (490
processos ativos!), TJSP, TJPR, TRF-4 e STJ, e eu tratei ele como "a rotina que só gastava".

**REGRAS:**
15. **Antes de desligar rotina, listar o que mais ela sustenta.** A pergunta não é "quanto isso
   gasta?", é "**o que para de funcionar se isso parar?**". Desligar é mudança de
   comportamento, não pausa neutra.
16. **Rotina desligada por custo tem de virar item com prazo, não estado permanente.** Ficou
   ~16 h desligada sem substituto porque não havia nada obrigando a voltar.
17. **Resposta de rotina de custo precisa dizer o preço da própria rodada.** O
   `legalmail-reconcile` agora devolve `paginas_cobradas` e `custo_estimado_brl` — o gasto fica
   no log de `net._http_response`, sem depender de alguém abrir o painel do fornecedor.
18. **Janela é o padrão, acervo inteiro é exceção explícita.** Inverti o padrão da função: sem
   parâmetro ela filtra por captura; puxar tudo exige `?tudo=1`, e há teto de páginas por rodada
   (R$ 1,50) para que laço com defeito não vire fatura.

Detalhe: `whatsapp-bot/edge-function-legalmail-reconcile.ts` (cabeçalho) e
`db/legalmail_custo_api.sql`

---

## 09/09/2026 — R$ 461 em 5 dias relendo o que já estava no banco

**O que aconteceu.** O cron `legalmail-reconcile-horario` puxava o acervo inteiro de intimações
do Legal Mail (`GET /api/v1/notices`, 3.302 intimações, ~67 páginas de R$ 0,05) **de hora em
hora**. Rodou 112 vezes.

**Custo.** R$ 461,40 de R$ 484,31 consumidos em 30 dias, num crédito de assinatura de R$ 550
que **expira ao fim do ciclo** e não acumula. Sobrou R$ 65,69 para os 8 dias finais. Pico de
R$ 102/dia.

**O retorno disso: zero.** Toda execução devolvia `cumpridos: 0`. Pagava para reescrever o que
já estava gravado.

**Causa.** A documentação do próprio endpoint diz, com estas palavras:
> *"Consequência prática: **consultar em laço sai caro** — a cada 5 minutos há nova cobrança, e
> nada é entregue que o puxão diário não entregue."*
> *"Serve como alternativa ao webhook (...): uma rotina **diária** consegue puxar tudo o que foi
> capturado no dia filtrando por `data_captura_inicio`."*

**Correção de 10/09 a esta lição:** eu escrevi acima que *"o parâmetro de janela já existia e não
estava sendo usado"*. Fui ler o código e **estava sendo usado** — só não no lugar que gastava. A
lista de coleta era:
```ts
const plano = [
  ["pendente", null, MAX_PAGES_PENDENTE],   // <- null CRAVADO, ignora a janela
  ["cumprido", since, MAX_PAGES_FECHADOS],
  ["excedido", since, MAX_PAGES_FECHADOS],
];
```
O cron chamava `?janela=1&dias=3` e a janela valia para cumprido/excedido; o `pendente` — que é
justamente o volumoso e o único que cria prazo — vinha inteiro. Diagnóstico vago ("não usava a
janela") quase virou conserto no lugar errado: **o defeito estava numa palavra, `null`, na linha
de um dos três status.**

E o cron **não estava versionado em lugar nenhum do repositório** — foi criado direto no banco,
sem commit, sem arquivo, sem revisão.

**REGRAS:**
1. **Cron que chama API paga tem de estar versionado no repositório, com o preço por chamada
   anotado ao lado.** Se não está no `db/`, não existe.
2. **Ler a seção de custo E a de boas práticas da API antes de agendar qualquer coisa.**
3. **Puxar por janela incremental, nunca o acervo inteiro em laço.**
4. **Olhar a fatura.** Sete dias de gasto anormal passaram porque ninguém abriu o painel.

Detalhe: `db/legalmail_custo_api.sql`

---

## 09/09/2026 — bloqueio da API por polling, causado na hora de consertar o item acima

**O que aconteceu.** Ao validar a rotina nova de fechamento de prazo, disparei 87 chamadas
**três vezes em cinco minutos** (261 chamadas). A terceira volta veio 0 de 87.

**Causa.** A spec diz: **120 req/min em janela deslizante de 60s**, e **3 respostas `429` em 10
minutos caracterizam "prática de polling"**, disparando *timeout progressivo* no workspace
inteiro. Eu havia lido a seção de preços e **não** a de limites antes de disparar.

**O agravante, que é pior que o bloqueio:** naquela rodada cega a função respondeu
`VENCENDO_HOJE_AINDA_ABERTOS: 0`. Ela não sabia — tinha falhado em 87 de 87 consultas — e ainda
assim afirmou que não havia prazo pendente. Um zero desses manda a equipe para casa.

**REGRAS:**
5. **Espaçar chamadas** (hoje 700 ms, ~85/min) e **abortar no primeiro `429`** respeitando
   `Retry-After`. Insistir é o que gera as 3 violações e o bloqueio.
6. **Rodada incompleta NÃO reporta número.** Se um único item falhou, a resposta vem
   `COMPLETO: false` e as contagens vêm `null`, com aviso. Melhor não dizer nada do que dizer
   "nenhum prazo pendente" sem ter conseguido olhar.
7. **Endpoint grátis também tem limite.** Grátis ≠ ilimitado.

---

## 09/09/2026 — resumo de autos escrito do lado do adversário

**O que aconteceu.** O resumo por IA dos autos do processo 6618 recomendou *"aguardar a
preclusão"* de uma decisão contra o nosso próprio cliente, cujo prazo de 15 dias vencia naquele
dia, e falou em *"expedir alvará para a conta da exequente"* — sendo que somos o **executado**.
Valia para 4 dos 5 resumos gravados.

**Causa.** Nenhum prompt de IA dizia de que lado o escritório está. Sem isso o modelo adota o
protagonista dos documentos, e em cumprimento de sentença quem conduz o feito é o exequente.
Não era alucinação: era instrução ausente.

**REGRAS:**
8. **Todo prompt que analisa processo declara o polo do cliente** (`blocoPolo()`, idêntica em
   `autos-ia`, `autos-anexo-ia`, `processo-chat`).
9. **Quando o polo não é conhecido, o prompt diz que não sabe e proíbe afirmar o lado.** Omitir
   em silêncio foi exatamente o que causou o erro.

Detalhe: `db/processo_polo_cliente.sql`

---

## 09/09/2026 — 30 cadastros escondidos por uma contagem errada

**O que aconteceu.** O grupo "Processos Administrativos" foi retirado do menu com a nota
`0 cadastros, sem uso`. Havia **30**, sete deles extrajudiciais. Com a outra porta apontando
para um cartaz de "em desenvolvimento", os 30 ficaram inalcançáveis.

**REGRA:**
10. **Não esconder módulo por suposição de estar vazio — contar as linhas antes**, e escrever a
    contagem e a data no comentário.

---

## 09/09/2026 — campo de seleção que apagava o dado ao salvar

**O que aconteceu.** O campo Órgão dos administrativos era um `<select>` com 11 opções fixas, e
**nenhum** dos 6 valores existentes no banco estava nelas. Abrir "Editar" e salvar trocava o
órgão para a primeira opção, calado, em qualquer dos 30.

**REGRA:**
11. **`<select>` de campo já preenchido tem de conter o valor atual**, ou usar `<input list>`.
    Vale para todo campo cuja lista de opções foi escrita à mão.

---

## 08–09/09/2026 — prazo do TRT: as armadilhas do cálculo

- **Feriado esquecido puxa a data PARA TRÁS (inofensivo). Feriado inventado empurra PARA FRENTE
  e PERDE PRAZO.** Errar para o lado seguro.
- **`N` maior que o real perde prazo; menor, antecipa.** Por isso `N = least(5, menor prazo
  dirigido no texto)`.
- **Coluna `tribunal` não é normalizada** (`TRT-12` × `TRT12`, 23 grafias). Filtro sempre por
  regex, nunca por igualdade — já produziu uma conferência errada.
- **md5 do texto não deduplica ato**: cada cópia cita o seu destinatário.

**REGRA:**
12. **Toda rotina que grava prazo nasce com `p_commit=false` e passa por gabarito real antes de
    gravar.**

Detalhe: `db/trt_gera_prazos.sql`, `db/feriados_dias_uteis.sql`, `db/publicacoes_atos.sql`

---

## Recorrente — plpgsql: coluna com nome de parâmetro de saída

`column reference "pub_id" is ambiguous` **não aparece no `CREATE FUNCTION`** — só na primeira
execução. Já aconteceu duas vezes (`trt_gera_prazos.ato_chave`, `becker_deriva_polo.pub_id`).

**REGRA:**
13. **Nomes internos deliberadamente diferentes dos parâmetros de saída**, e **executar a função
    uma vez** depois de criar. Criar sem executar não prova nada.

---

## Recorrente — documentação do repo que afirma o que não é verdade

`db/djen_supabase_pgcron.sql` dizia "Método ATIVO em produção" quando não havia **nenhum** cron
agendado. `db/legalmail_webhook.sql` dizia que `notices-to-comply` "veio vazio" — testado num
processo do TRT e generalizado; nos processos do eProc ele responde 200 com dados em 87 de 87.

**REGRA:**
14. **Afirmação em documentação tem de vir com a medição e a data.** "Funciona" sem número é
    palpite. E resultado de um caso não vira regra geral.
