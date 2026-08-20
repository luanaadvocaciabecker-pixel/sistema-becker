# Robô DataJud — atualização automática de movimentações

Consulta a **API Pública do DataJud (CNJ)** para cada processo cadastrado e grava as
movimentações novas na tabela `movimentacoes` do Supabase. Roda no **Oracle Free Tier**
(IP não bloqueado pelos tribunais), 1x por dia via `cron`.

- **Oficial e grátis** — não precisa de login nem certificado.
- Cobre TJSC, TRT12, TRF4, TJPR e todos os demais tribunais (o alias é deduzido do CNJ).
- **Não** traz a íntegra dos autos (isso continua sendo anexo manual na tela do processo).

## O que você precisa ter em mãos

1. **Chave service_role do Supabase**
   Painel Supabase → Project Settings → API → `service_role` (secret).
   ⚠️ Essa chave ignora as permissões (RLS). Ela fica **só no servidor**, nunca no site nem no Git.

2. **Chave pública do DataJud**
   Copie de: https://datajud-wiki.cnj.jus.br/api-publica/acesso
   (é a mesma chave para todos — pública).

## Instalação no Oracle (Ubuntu/Oracle Linux)

```bash
# 1) Instalar Node 18+ (se ainda não tiver)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -   # Ubuntu/Debian
sudo apt-get install -y nodejs                                       # Ubuntu/Debian
node -v   # precisa ser >= 18

# 2) Copiar os arquivos para o servidor (ex.: /opt/robo-datajud)
sudo mkdir -p /opt/robo-datajud && cd /opt/robo-datajud
# suba o atualiza_datajud.mjs e o .env.example para essa pasta (scp/git)

# 3) Criar o .env com as chaves
cp .env.example .env
nano .env          # cole SUPABASE_SERVICE_KEY e DATAJUD_APIKEY

# 4) Teste manual
set -a; source .env; set +a
node atualiza_datajud.mjs
# deve imprimir: consultados=... novos_andamentos=...
```

## Agendar 1x por dia (cron, 06:00)

```bash
crontab -e
# adicione a linha (ajuste o caminho se necessário):
0 6 * * * cd /opt/robo-datajud && set -a && . ./.env && set +a && /usr/bin/node atualiza_datajud.mjs >> /opt/robo-datajud/robo.log 2>&1
```

Os andamentos novos aparecem sozinhos na tela do processo (seção "Últimas movimentações")
e no site, sem ninguém digitar.

## Segurança

- O `.env` (com as chaves) **não** deve ir para o GitHub. Já está no `.gitignore`.
- Se a chave service_role vazar, gere outra no painel do Supabase e atualize o `.env`.

## Limites e cuidados

- O DataJud tem limite de requisições; o robô já espera ~0,3s entre processos (~3/s).
- Alguns tribunais podem não retornar todos os processos antigos — é limitação da base do CNJ.
- Fase C (baixar a íntegra automaticamente logando no tribunal) **não** está aqui: exige
  certificado/login e é frágil; fica para depois.
