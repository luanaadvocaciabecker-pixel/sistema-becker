# Sistema Becker — Site público da Becker Advogados

> ⚠️ ATENÇÃO — LEIA ANTES DE MEXER EM QUALQUER COISA
>
> Este repositório contém APENAS o site público da Becker Advogados.
> Publicado em: https://advocacia-becker.pages.dev
>
> GPTs, DJEN, pipeline, edge functions e banco de dados NÃO estão aqui.
> Para isso, vá em: https://github.com/luanaadvocaciabecker-pixel/GPTs-becker

---

## O que é este repositório

Contém exclusivamente o código do site institucional publicado no Cloudflare Pages:

**https://advocacia-becker.pages.dev**

---

## Estrutura

```
site/
  index.html                  ← página principal do site
  becker-logo-completo.png
  becker-simbolo.png
  becker-logo-horizontal.png
  identidade visual becker.png

pages-deploy/
  pacote pronto para publicar no Cloudflare Pages
```

---

## O que NÃO pertence aqui

| O que é | Onde fica |
|---|---|
| GPT Bancário/Consumidor | `gpts-becker` |
| Becker Monitor | `gpts-becker` |
| Becker Juris Intelligence | `gpts-becker` |
| DJEN pipeline | `gpts-becker` |
| Edge Functions | Supabase — projeto `Becker Juris Intelligence` |
| Banco de dados | Supabase — projeto `Becker Juris Intelligence` |

---

## Segurança

Nunca incluir neste repositório: chaves de API, tokens, service role do Supabase, credenciais de WhatsApp ou qualquer secret.
