# WhatsApp — robô que responde o status do processo ao cliente

Objetivo: o cliente manda "como está meu processo?" no WhatsApp e o robô responde
sozinho, com segurança (LGPD).

## Arquitetura (2 partes)

1. **Cérebro (PRONTO)** — roda 100% no Supabase, de graça:
   - Funções SQL: `cliente_por_telefone(tel)`, `cliente_por_cpf(cpf)`, `montar_status_cliente(id)`.
   - Edge Function `whatsapp` (deployada): recebe a mensagem, identifica o cliente
     pelo telefone; se não reconhecer, **pede o CPF** antes de liberar qualquer dado;
     monta a resposta com os processos + última movimentação; grava em `whatsapp_log`.
   - URL do webhook: `https://fnuzhypsqvyolqqafrba.supabase.co/functions/v1/whatsapp`
   - Testado: número conhecido → responde; desconhecido → pede CPF; CPF válido → responde.

2. **Linha telefônica (EM CONEXÃO — via Meta Cloud API, oficial)** — conecta o
   número ao WhatsApp e chama o webhook acima a cada mensagem.
   - **Caminho escolhido: Meta Cloud API (oficial da Meta/WhatsApp).** Sem servidor,
     sem risco de banimento, gratuito nas primeiras ~1.000 conversas de serviço/mês.
   - A Edge Function (v6) já entende o formato da Meta:
     - **GET** de verificação: responde `hub.challenge` quando `hub.verify_token` == segredo `WHATSAPP_TOKEN`.
     - **POST** de mensagem: lê `entry[].changes[].value.messages[]` (telefone em `messages[].from`, texto em `messages[].text.body`).
     - **Envio**: `POST https://graph.facebook.com/v21.0/{META_PHONE_ID}/messages` com `Authorization: Bearer {META_TOKEN}`.
   - Segredos a setar na Edge Function (Supabase → Edge Functions → whatsapp → Secrets):
     - `META_TOKEN` = token de acesso do WhatsApp (permanente, do System User).
     - `META_PHONE_ID` = Phone number ID do número no painel da Meta.
     - `WHATSAPP_TOKEN` = uma senha inventada por você; é o "Verify token" que você digita no painel da Meta ao configurar o webhook. (Ex.: `becker-whats-2026`.)
   - Enquanto `META_TOKEN`/`META_PHONE_ID` não existirem, o cérebro só devolve o texto
     (não envia) — modo teste.

   ### Passo a passo Meta (resumo)
   1. https://developers.facebook.com → **My Apps** → **Create App** → tipo **Business**.
   2. No app, adicione o produto **WhatsApp** → **Set up**.
   3. Em "API Setup" aparece um **número de teste** grátis, um **token temporário** (24h)
      e o **Phone number ID**. Dá pra testar hoje com isso.
   4. Adicione o **seu WhatsApp** em "To" → clique **Send message** pra liberar o teste.
   5. Configuração > **Webhooks**: Callback URL = a URL do webhook acima;
      Verify token = o valor de `WHATSAPP_TOKEN`. Clique **Verify and save**.
   6. **Subscribe** ao campo **messages**.
   7. Para produção (não expirar em 24h): crie um **System User** com token permanente
      e, depois, registre o **número definitivo** do escritório (ou um número novo dedicado).

   O backup **Evolution** (não-oficial) continua suportado no código (`EVOLUTION_URL`,
   `EVOLUTION_KEY`, `EVOLUTION_INSTANCE`), mas o caminho ativo é a Meta.

## Segurança / LGPD
- O robô só entrega dados de processo para número reconhecido OU após CPF confirmado.
- Número desconhecido sem CPF recebe apenas o pedido de identificação.

## Melhorias futuras
- Preencher telefone dos clientes (hoje ~420 de 1466 têm telefone) para reconhecer mais gente pelo número.
- Resposta em linguagem natural com IA (opcional).
- Estado de conversa (lembrar que já pediu o CPF) — hoje é sem estado (funciona, mas cada mensagem é avaliada isolada).

## Atualização — detalhe do processo (v3)
O robô agora responde em 2 níveis:
- **Resumo** (padrão): última movimentação de cada processo do cliente.
- **Detalhe completo**: quando o cliente pede "histórico/detalhe/andamentos" ou envia o
  número do processo. Retorna dados (classe, assunto, vara, comarca, tribunal) + últimos
  12 andamentos + prazos em aberto. Funções SQL: `processos_do_cliente`, `montar_detalhe_processo`.
- Trava LGPD mantida: só abre processo do próprio cliente identificado.

## Atualização — camada de IA que "conversa" (v4)
A Edge Function agora tem uma camada opcional de IA (Claude Haiku) que reescreve o
dossiê cru em linguagem simples e acolhedora ("Oi Fulano, seu processo teve X e agora Y").
- Liga com a env `ANTHROPIC_API_KEY` (e opcional `ANTHROPIC_MODEL`, padrão claude-haiku-4-5).
- Regras no system prompt: usar SOMENTE os dados fornecidos (não inventa), traduzir juridiquês,
  sem conselho jurídico, curto. Qualquer erro/sem chave → cai no texto "lista" (grátis).

## Atualização — tom formal-humano (v5)
System prompt da IA reescrito para soar como o escritório falando com o cliente:
formal, natural e cordial, "Prezado(a) [nome]... Atenciosamente, Equipe Becker Advogados",
sem cara de IA/robô, sem emojis, mantendo a relação advogado-cliente. Guardas mantidas
(usar só os dados; sem conselho/opinião jurídica). Modelo padrão: claude-haiku-4-5.

## Atualização — conexão Meta Cloud API (v6)
A Edge Function agora aceita o webhook OFICIAL da Meta (além do modo teste e do Evolution),
detectando o formato automaticamente:
- **GET** de verificação do webhook (`hub.mode`/`hub.verify_token`/`hub.challenge`) →
  devolve o challenge quando o verify_token == `WHATSAPP_TOKEN`.
- **POST** da Meta (`entry[].changes[].value.messages[]`) → identifica cliente e responde.
- **Envio** via Graph API (`graph.facebook.com/{META_PHONE_ID}/messages`, Bearer `META_TOKEN`).
- Novos segredos: `META_TOKEN`, `META_PHONE_ID` (e opcional `META_GRAPH_VER`, padrão v21.0).
- A guarda `x-webhook-token` continua valendo só para teste/Evolution; a Meta é validada no GET.
