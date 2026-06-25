"""Coleta publicações do DJEN via PJe API e envia para o Becker Monitor."""
import os
import json
import hashlib
import requests
from datetime import date, timedelta

# ── config ────────────────────────────────────────────────────────────────────

SUPABASE_URL   = os.environ.get("SUPABASE_URL", "https://bpzuktssvdosxlxbaeyl.supabase.co")
MONITOR_SECRET = os.environ.get("MONITOR_SECRET", "")
DATA_ALVO      = os.environ.get("DATA_ALVO") or date.today().isoformat()

IMPORTAR_URL = f"{SUPABASE_URL}/functions/v1/becker-monitor/djen/importar"

PJE_URLS = [
    # Tentativa 1 — parâmetros novos
    "https://comunicaapi.pje.jus.br/api/v1/comunicacao?meio=D&numeroOab=40082&ufOab=SC"
    "&dataDisponibilizacaoInicio={data}&dataDisponibilizacaoFim={data}&size=100",
    # Tentativa 2 — parâmetros legados
    "https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroOAB=40082&siglaOAB=SC"
    "&dataDisponibilizacaoInicio={data}&dataDisponibilizacaoFim={data}&size=100",
]

HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; BeckerMonitor/1.0)",
}

# ── helpers ───────────────────────────────────────────────────────────────────

def buscar_publicacoes(data: str) -> list:
    for url_template in PJE_URLS:
        url = url_template.format(data=data)
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            print(f"PJe status: {r.status_code} — {url[:80]}")
            if r.status_code != 200:
                continue
            payload = r.json()
            if isinstance(payload, list) and payload:
                return payload
            for key in ("content", "data", "items", "comunicacoes", "resultado"):
                if isinstance(payload, dict) and isinstance(payload.get(key), list) and payload[key]:
                    return payload[key]
        except Exception as e:
            print(f"Erro ao acessar PJe: {e}")
    return []


def extrair_campos(pub: dict) -> dict:
    numero  = pub.get("numeroProcesso") or pub.get("nrProcesso") or ""
    tribunal = pub.get("siglaTribunal") or pub.get("nomeTribunal") or pub.get("tribunal") or ""
    conteudo = pub.get("conteudo") or pub.get("texto") or ""
    return {
        "numero_processo": numero,
        "tribunal": tribunal,
        "conteudo": conteudo,
        "cliente": pub.get("nomeParteAtiva") or pub.get("parte") or "Não identificado",
        "prioridade": "MEDIA",
        "prazo_tipo": "Verificar manualmente",
        "prazo_dias_uteis": None,
        "prazo_fatal": None,
        "o_que_fazer": "Analisar publicação manualmente",
        "risco": "Verificar prazo antes de agir",
        "resumo": conteudo[:300] if conteudo else "Sem conteúdo disponível",
    }


def enviar_para_supabase(data: str, publicacoes: list) -> dict:
    headers = {"Content-Type": "application/json"}
    if MONITOR_SECRET:
        headers["x-monitor-secret"] = MONITOR_SECRET

    payload = {"data_publicacao": data, "publicacoes": publicacoes}
    r = requests.post(IMPORTAR_URL, headers=headers, json=payload, timeout=30)
    print(f"Supabase status: {r.status_code}")
    print(r.text[:500])
    return r.json() if r.ok else {"error": r.text}


# ── main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"Data alvo: {DATA_ALVO}")

    raw = buscar_publicacoes(DATA_ALVO)
    print(f"Publicações encontradas: {len(raw)}")

    if not raw:
        print("Nenhuma publicação. Encerrando.")
        exit(0)

    publicacoes = [extrair_campos(p) for p in raw if p.get("numeroProcesso") or p.get("nrProcesso")]
    print(f"Publicações válidas: {len(publicacoes)}")

    resultado = enviar_para_supabase(DATA_ALVO, publicacoes)
    print(f"Resultado: {resultado}")
