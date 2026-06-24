# Sistema Becker Advogados

Sistema juridico interno do escritorio Becker Advogados.

## Estrutura

```text
site/
  index.html
  becker-logo-completo.png
  becker-simbolo.png
  becker-logo-horizontal.png
  identidade visual becker.png

cloudflare/
  _worker.js
  functions/

pages-deploy/
  pacote pronto para publicar no Cloudflare Pages

docs/
```

## Publicacao

O site atual esta publicado no Cloudflare Pages:

```text
https://advocacia-becker.pages.dev
```

## Observacao de seguranca

Antes de subir no GitHub, nao incluir chaves secretas, tokens privados, service role do Supabase, token da Cloudflare ou credenciais de WhatsApp/API.

Chave anon/publica do Supabase pode existir no frontend quando as politicas de seguranca do banco estiverem corretas, mas segredos nunca devem ficar no repositorio.
