#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PONTE DJEN - Advocacia Becker
=============================
Roda no computador do ESCRITORIO (IP brasileiro comum, nunca bloqueado pelo CNJ).
Consulta as publicacoes da OAB 40.082/SC no DJEN e envia para o sistema na nuvem,
que analisa (cliente, prioridade, prazo fatal) e alimenta o GPT Becker Monitor.

COMO USAR:
  1. Instalar Python (python.org) se nao tiver - marcar "Add to PATH"
  2. pip install requests
  3. python ponte_djen.py          -> busca hoje + dias faltantes dos ultimos 30
  4. (opcional) agendar no Task Scheduler do Windows para rodar 2x ao dia

Nao precisa de senha: usa apenas a API publica do DJEN e a chave publica do sistema.
"""

import datetime as dt
import json
import sys
import time

import requests

OAB_NUMERO = "40082"
OAB_UF = "SC"
DJEN = "https://comunicaapi.pje.jus.br/api/v1/comunicacao"
SISTEMA = "https://bpzuktssvdosxlxbaeyl.supabase.co/functions/v1"
CHAVE = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwenVrdHNzdmRvc3hseGJhZXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4Njc3NjcsImV4cCI6MjA5NzQ0Mzc2N30."
    "8h2pDprZLDBBSQxlEjJ1nYAJtx8mb89I4uVr45bFwd8"
)
HEAD_SISTEMA = {"Authorization": f"Bearer {CHAVE}", "Content-Type": "application/json"}


def buscar_djen(data: str):
    """Busca publicacoes da OAB no DJEN para uma data (YYYY-MM-DD)."""
    params = {
        "numeroOab": OAB_NUMERO,
        "ufOab": OAB_UF,
        "dataDisponibilizacaoInicio": data,
        "dataDisponibilizacaoFim": data,
        "itensPorPagina": 100,
    }
    r = requests.get(DJEN, params=params, timeout=60,
                     headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    body = r.json()
    itens = body if isinstance(body, list) else (
        body.get("content") or body.get("items") or body.get("comunicacoes") or [])
    return itens


def _campo(it: dict, *chaves):
    """Retorna o primeiro valor nao vazio dentre varios nomes possiveis de
    campo (a API do DJEN varia a nomenclatura entre versoes/tribunais)."""
    for chave in chaves:
        v = it.get(chave)
        if v not in (None, ""):
            return v
    return None


def enviar_sistema(data: str, itens) -> dict:
    """Envia as publicacoes para o importador do sistema, com o maximo de
    informacao disponivel na resposta do DJEN (nao so o texto da publicacao)."""
    pubs = []
    for it in itens:
        conteudo = str(it.get("texto") or it.get("conteudo") or "")
        numero = str(_campo(it, "numeroprocessocommascara", "numeroProcesso", "numero_processo") or "")
        tribunal = str(_campo(it, "siglaTribunal", "tribunal") or "")
        data_disp = _campo(it, "data_disponibilizacao", "dataDisponibilizacao")
        forma = _campo(it, "meiocompleto", "meioCompleto", "tipoComunicacao", "meio")
        comarca = _campo(it, "comarca", "nomeComarca")
        orgao = _campo(it, "nomeOrgao", "orgaoJulgador", "nomeOrgaoJulgador")
        pubs.append({
            "numero_processo": numero,
            "tribunal": tribunal,
            "conteudo": conteudo[:8000],
            "data_disponibilizacao": str(data_disp) if data_disp else None,
            "forma_intimacao": str(forma) if forma else None,
            "comarca": str(comarca) if comarca else None,
            "orgao_julgador": str(orgao) if orgao else None,
        })
    r = requests.post(f"{SISTEMA}/becker-monitor/djen/importar", timeout=120,
                      headers=HEAD_SISTEMA,
                      data=json.dumps({"data_publicacao": data, "publicacoes": pubs}))
    r.raise_for_status()
    return r.json()


def analisar_no_sistema(data: str) -> dict:
    """Dispara a analise (cliente/prioridade/prazo) das publicacoes recem-importadas."""
    r = requests.get(f"{SISTEMA}/djen-pipeline", params={"data": data}, timeout=300,
                     headers=HEAD_SISTEMA)
    r.raise_for_status()
    return r.json()


def dias_para_verificar():
    """Hoje + dias uteis dos ultimos 30 dias."""
    hoje = dt.date.today()
    dias = []
    for i in range(0, 31):
        d = hoje - dt.timedelta(days=i)
        if d.weekday() < 5:  # seg-sex
            dias.append(d.isoformat())
    return dias


def main():
    print(f"PONTE DJEN - OAB {OAB_NUMERO}/{OAB_UF}")
    print("=" * 50)
    total_enviadas = 0
    for data in dias_para_verificar():
        try:
            itens = buscar_djen(data)
        except requests.HTTPError as e:
            print(f"{data}: DJEN respondeu erro {e.response.status_code} - pulando")
            continue
        except Exception as e:
            print(f"{data}: falha de rede ({e}) - pulando")
            continue

        if not itens:
            print(f"{data}: 0 publicacoes")
            continue

        try:
            resp = enviar_sistema(data, itens)
            novas = resp.get("importadas", 0)
            print(f"{data}: {len(itens)} publicacoes no DJEN -> {novas} importadas")
            if novas:
                an = analisar_no_sistema(data)
                print(f"        analisadas: {an.get('analisadas', 0)}")
                total_enviadas += novas
        except Exception as e:
            print(f"{data}: erro ao enviar para o sistema: {e}")

        time.sleep(1.5)  # pausa respeitosa entre consultas

    print("=" * 50)
    print(f"Concluido. {total_enviadas} publicacoes novas enviadas ao sistema.")
    if total_enviadas == 0:
        print("(Nada novo: ou o sistema ja tinha tudo, ou nao houve publicacao.)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
