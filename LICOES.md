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

---

## 10/09/2026 — "todo ato vira prazo" precisa de lista de exceções, e ela cresce

`trt_gera_prazos` transforma todo ato trabalhista sem "Data final" em prazo estimado de 5 dias
úteis. A lista de exceções tinha dois itens (pauta de julgamento, ata de sessão). Faltava um
terceiro, e ele é o mais comum de todos.

**Aviso de distribuição** — *"Processo 0000007-12.2025.5.12.0016 distribuído para 3ª Turma -
Gabinete da Ministra Margareth Rodrigues Costa na data 05/09/2026. Para maiores informações,
clique no link…"* — é o ato inteiro. Não manda fazer nada. Medido: **174 dos 1.195 atos
trabalhistas** são isso (130 TRT + 44 TST), o maior tem **304 caracteres**, e **nenhum dos 174**
contém qualquer palavra de ordem — nem "prazo", nem "intime", nem verbo imperativo. Já haviam
virado **14 prazos falsos**, 6 ainda em aberto, na fila "A conferir".

Prazo falso na fila é a doença dos 554 `cumprido` falsos ao contrário: lá prazo real sumia com
cara de feito, aqui prazo inexistente ocupa a fila. Nos dois casos a fila deixa de merecer
confiança — e fila em que não se confia deixa de ser lida.

**`tipo` não serve de discriminador.** Dos 49 avisos de distribuição do TST, só 3 chegam como
`'Lista de distribuição'`; os outros 46 chegam como `'DJEN/PJe'`, igual a um despacho. `tipo` é
o rótulo da FONTE de coleta, nunca do ato — o mesmo achado que já valia para a dedup.

**A exclusão é ancorada e com teto de tamanho**, para poder errar para o lado seguro: só casa
quando o ato COMEÇA com a linha de distribuição E tem menos de 600 caracteres. Se um dia o
tribunal juntar uma ordem depois da distribuição, o ato volta a gerar prazo em vez de sumir
calado.

**REGRA:**
25. **Regra do tipo "todo X vira Y" só se sustenta com lista de exceções mantida.** Cada molde
    novo de aviso sem ordem tem de entrar nela, ou a fila enche de item falso. E toda exceção
    nasce com contra-guarda (aqui, o teto de tamanho) para não virar omissão silenciosa.

---

## 10/09/2026 — cruzar prazo com publicação: a chave depende do CAMINHO que criou o prazo

Eu afirmei "o TST nunca gerou prazo nenhum". Estava errado. Cruzei por `prazos.legalmail_id`,
que é **nulo** no caminho calculado — só o caminho do Legal Mail o preenche. A chave do caminho
calculado é `prazos.ato_chave` (`cnj|data|ato_id`). Cruzando certo, o TST gerou 3.

| caminho | quem cria | chave para cruzar |
|---|---|---|
| Legal Mail (exige "Data final") | `lm_upsert_prazo_por_texto` | `legalmail_id` |
| DJEN calculado (TRT/TST) | `trt_gera_prazos` | `ato_chave` |

**REGRA:**
26. **Antes de concluir "não existe nenhum", conferir que a chave do JOIN existe naquele
    caminho.** Zero por chave errada é indistinguível de zero de verdade — e soa igual de
    convincente.

---

## 10/09/2026 — o mesmo ato chega com DOIS tribunais diferentes

O prazo 5713 dizia "· TRT-12" e o ato é do TST. As 4 cópias cruas do mesmo ato vêm rotuladas
`TRT-12` (1) e `TST` (3). A view `publicacoes_atos` escolhe a cópia de texto mais longo, então
hoje devolve TST — mas quando o prazo nasceu, a cópia do TST ainda não tinha chegado e a
canônica era a do TRT-12. Medido: **60 de 1.231** grupos (cnj, data) trabalhistas têm cópias com
família de tribunal divergente.

Consequência prática: **o tribunal gravado na descrição de um prazo é o rótulo da cópia canônica
no momento da criação, e ele muda depois.** Eu ia carimbar "· ato do TST" na descrição a partir
desse valor; seria carimbar uma coisa que vira outra.

**REGRA:**
27. **Não gravar em campo permanente um valor derivado de "a cópia canônica de agora".** Ou se
    grava a origem (o id da linha), ou se recalcula na leitura.

---

## 10/09/2026 — o rótulo acusou a equipe de não ter feito o que ela tinha feito

Ela conferiu os tribunais um a um no fim do dia e não achou nenhum prazo em aberto — "fechamos,
cumprimos". O fecho das 17:30 acusava **3 fatais sem cumprir**. Os dois estavam certos.

O eProc **não fecha o expediente quando a petição é protocolada.** Ele fecha na *ciência com
renúncia ao prazo* ou na certidão do cartório: **9 vezes em 3.264 intimações (0,3%)**. Os três
acusados estavam `Status:ABERTO`, Data final hoje 23:59:59 — cumpridos pelo escritório e abertos
no tribunal ao mesmo tempo. Reconsultei duas horas depois: continuavam abertos. Não era atraso.

O defeito não estava na medição, estava na **palavra**: `FATAIS_SEM_CUMPRIR` afirma culpa a
partir de um dado que só sabe dizer "o expediente segue aberto". Renomeado para
`AINDA_ABERTO_NO_TRIBUNAL`, com um campo `leia_se` na própria resposta explicando o limite.

**REGRA:**
28. **O nome do campo é uma afirmação, e responde pelo que afirma.** Se o dado sabe dizer
    "o tribunal não fechou", o campo não pode se chamar "sem cumprir". Rótulo que afirma mais
    que a medição manda procurar problema onde o trabalho já foi feito — e queima a confiança
    na lista inteira.

---

## 10/09/2026 — "Prazo fechado" queria dizer "ainda não abriu" em 99% dos casos

Eu construí o fechamento automático em cima de `Status do prazo: Prazo fechado` do Legal Mail,
tratando isso como prova de cumprimento. Medido nas 1.970 intimações que trazem essa frase:

| | intimações | tem Data final |
|---|---|---|
| `Status:AGUARD. ABERTURA` — **não abriu** | **1.959** | 0 |
| `Status:FECHADO (nn - CIÊNCIA, COM RENÚNCIA AO PRAZO)` | 9 | 9 |
| formato antigo, sem campo `Status` | 2 | 2 |

O Legal Mail achata três estados do eProc em duas palavras: "fechado" cobre tanto *encerrado*
quanto *ainda não começou*. E a mesma intimação aparece nas duas formas, em `legalmail_id`
diferentes, conforme é recapturada antes e depois de o prazo abrir.

Não houve estrago — intimação em "aguardando abertura" não tem Data final, então nunca gerou
prazo e não havia linha para fechar (0 de 1.959). **Foi sorte, não desenho.**

**REGRA:**
29. **Antes de tratar um valor de terceiro como prova, contar em quantos sentidos ele é usado
    nos dados reais.** Um enum de duas palavras cobrindo três estados é o caso comum, não a
    exceção — e o sentido que interessa costuma ser o raro (aqui, 0,3%).
30. **"Não deu problema" não é o mesmo que "está certo".** A regra errada não fechou nada só
    porque faltava Data final naquelas linhas; qualquer mudança de formato do fornecedor teria
    transformado o acerto acidental em prazo perdido.
