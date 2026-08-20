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

2. **Linha telefônica (PENDENTE)** — o Evolution API, que conecta o número do
   escritório ao WhatsApp e chama o webhook acima a cada mensagem.
   - Precisa de um servidor acessível (o acesso SSH ao Oracle atual foi perdido;
     criar uma instância nova com chave que a gente controle).
   - Depois de instalado, configurar no Evolution:
     - Webhook URL → a URL acima (com header `x-webhook-token` = segredo `WHATSAPP_TOKEN`).
   - E setar nos segredos da Edge Function: `EVOLUTION_URL`, `EVOLUTION_KEY`,
     `EVOLUTION_INSTANCE`, `WHATSAPP_TOKEN`. Sem eles, o cérebro só devolve o texto
     (não envia) — modo teste.

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
