# Lições — erros que já custaram, e a regra que cada um deixou

Lista corrida, mais recente em cima. Serve para não repetir. Cada entrada tem **o que
aconteceu**, **o que custou**, **a causa** e **a regra**. O detalhe técnico fica no arquivo
apontado em cada item.

Quem for mexer em rotina automática ou em qualquer chamada de API paga: leia as regras em
**negrito** antes.

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

O parâmetro de janela **já existia no nosso código** e não estava sendo usado. E o cron **não
estava versionado em lugar nenhum do repositório** — foi criado direto no banco, sem commit,
sem arquivo, sem revisão.

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
