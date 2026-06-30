"""Dispara o pipeline DJEN (busca PJe + análise IA + grava banco)."""
import os
import sys
import requests
from datetime import date

SUPABASE_URL    = os.environ.get("SUPABASE_URL", "https://bpzuktssvdosxlxbaeyl.supabase.co")
MONITOR_SECRET  = os.environ.get("MONITOR_SECRET", "")
DATA_ALVO       = os.environ.get("DATA_ALVO") or date.today().isoformat()

PIPELINE_URL = f"{SUPABASE_URL}/functions/v1/djen-pipeline"

if __name__ == "__main__":
    print(f"Data alvo: {DATA_ALVO}")
    print(f"Chamando: {PIPELINE_URL}")

    headers = {"Content-Type": "application/json"}
    if MONITOR_SECRET:
        # djen-pipeline aceita x-monitor-secret ou x-pipeline-secret
        headers["x-pipeline-secret"] = MONITOR_SECRET
        headers["x-monitor-secret"]  = MONITOR_SECRET

    try:
        r = requests.get(
            PIPELINE_URL,
            headers=headers,
            params={"data": DATA_ALVO},
            timeout=120,  # pipeline pode demorar (analise IA por publicacao)
        )
        print(f"Status: {r.status_code}")
        print(r.text[:1000])
        if not r.ok:
            sys.exit(1)
    except Exception as e:
        print(f"Erro: {e}")
        sys.exit(1)
