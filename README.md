# Sistema Becker — Sistema Jurídico de gestão da Becker Advogados

> ⚠️ ATENÇÃO — LEIA ANTES DE MEXER EM QUALQUER COISA
>
> Este repositório contém o **sistema interno de gestão** da Becker Advogados
> (clientes, processos, prazos, audiências, honorários, documentos etc.),
> protegido por login.
> Publicado em: https://advocacia-becker.pages.dev
>
> Os 3 GPTs, o monitoramento DJEN, o pipeline e as edge functions de inteligência
> NÃO estão aqui. Para isso, vá em:
> https://github.com/luanaadvocaciabecker-pixel/GPTs-becker

---

## O que é este repositório

É a aplicação web (single-page, em `site/index.html`) do **Sistema Jurídico
Becker**, publicada no Cloudflare Pages:

**https://advocacia-becker.pages.dev**

Não é uma página institucional — é o sistema de trabalho do escritório, com
acesso por usuário e senha. O front-end conversa diretamente com o Supabase
(REST + Auth + Storage) do projeto **`Becker Advogados`**.

### Módulos disponíveis

- **Clientes** — cadastro, edição, documentos por cliente (com autopreenchimento
  de endereço via ViaCEP)
- **Processos** — judiciais e administrativos, com conversão adm → judicial
- **Prazos, Tarefas, Audiências, Alvarás, Atendimentos**
- **Honorários / financeiro**
- **Documentos** — armazenados no Supabase Storage (`documentos-clientes`)
- **Consulta DataJud** — consulta e atualização em lote via Cloudflare Functions
- **Movimentações, notificações, busca global, perfil e troca de senha**

---

## Backend (Supabase)

| Item | Onde fica |
|---|---|
| Projeto Supabase | **`Becker Advogados`** (`fnuzhypsqvyolqqafrba`) |
| Autenticação | Supabase Auth (login por e-mail/senha) |
| Dados | Tabelas `clientes`, `processos`, `prazos`, `audiencias`, `honorarios`, `documentos`, `atendimentos`, `tarefas`, `alvaras`, `financeiro`, `movimentacoes`, `historico`, `processos_adm` |
| Arquivos | Supabase Storage — bucket `documentos-clientes` |

> Observação: este projeto Supabase é **diferente** do
> `Becker Juris Intelligence` (`bpzuktssvdosxlxbaeyl`), que serve os GPTs e o
> monitoramento DJEN. Não confundir os dois.

---

## Estrutura de pastas

```
site/
  index.html                  ← a aplicação inteira (SPA)
  becker-logo-completo.png
  becker-simbolo.png
  becker-logo-horizontal.png
  identidade visual becker.png

pages-deploy/
  pacote pronto para publicar no Cloudflare Pages (cópia de site/ + worker)
  _worker.js
  functions/processo/[numero].js   ← consulta DataJud por número de processo

cloudflare/
  _worker.js
  functions/processo/[numero].js
```

---

## O que NÃO pertence aqui

| O que é | Onde fica |
|---|---|
| GPT Bancário/Consumidor | `gpts-becker` |
| Becker Monitor | `gpts-becker` |
| Becker Juris Intelligence | `gpts-becker` |
| DJEN pipeline | `gpts-becker` |
| Edge Functions de inteligência | Supabase — projeto `Becker Juris Intelligence` |
| Base de conhecimento / jurisprudência | Supabase — projeto `Becker Juris Intelligence` |

---

## Segurança

Nunca incluir neste repositório: chaves de API, tokens, service role do Supabase,
credenciais ou qualquer secret. O front-end usa apenas a chave pública (anon) do
Supabase, e o acesso aos dados é controlado por Auth + RLS no banco.
