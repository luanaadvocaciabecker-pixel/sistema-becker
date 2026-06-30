"""Coleta publicações do DJEN via PJe API e envia para o Becker Monitor."""
import os
import re
import requests
from datetime import date

SUPABASE_URL   = os.environ.get("SUPABASE_URL", "https://bpzuktssvdosxlxbaeyl.supabase.co")
MONITOR_SECRET = os.environ.get("MONITOR_SECRET", "")
DATA_ALVO      = os.environ.get("DATA_ALVO") or date.today().isoformat()

IMPORTAR_URL = f"{SUPABASE_URL}/functions/v1/becker-monitor/djen/importar"

PJE_URLS = [
    "https://comunicaapi.pje.jus.br/api/v1/comunicacao?meio=D&numeroOab=40082&ufOab=SC"
    "&dataDisponibilizacaoInicio={data}&dataDisponibilizacaoFim={data}&size=100",
    "https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroOAB=40082&siglaOAB=SC"
    "&dataDisponibilizacaoInicio={data}&dataDisponibilizacaoFim={data}&size=100",
]

HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; BeckerMonitor/1.0)",
}

# Padrão CNJ: 0000000-00.0000.0.00.0000
CNJ_RE = re.compile(r"\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}")


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


def extrair_numero_cnj(texto: str) -> str:
    """Tenta extrair o primeiro número CNJ encontrado no texto."""
    m = CNJ_RE.search(texto or "")
    return m.group(0) if m else ""


def extrair_campos(pub: dict) -> dict:
    # Campos diretos do PJe
    numero_campo = (
        pub.get("numeroProcesso")
        or pub.get("nrProcesso")
        or pub.get("numero")
        or pub.get("numProcesso")
        or pub.get("processo")
        or ""
    )
    conteudo = (
        pub.get("conteudo")
        or pub.get("texto")
        or pub.get("teor")
        or pub.get("comunicacao")
        or pub.get("descricao")
        or ""
    )
    tribunal = (
        pub.get("siglaTribunal")
        or pub.get("nomeTribunal")
        or pub.get("tribunal")
        or pub.get("siglaOrgao")
        or pub.get("orgaoJulgador")
        or ""
    )

    # Se o campo já tem formato CNJ usa direto; caso contrário extrai do conteúdo
    if CNJ_RE.match(str(numero_campo)):
        numero = str(numero_campo)
    else:
        numero = extrair_numero_cnj(conteudo) or str(numero_campo or pub.get("id", ""))

    return {
        "numero_processo": numero,
        "tribunal": str(tribunal),
        "conteudo": str(conteudo),
        "cliente": (
            pub.get("nomeParteAtiva")
            or pub.get("parte")
            or pub.get("nomeParte")
            or "Não identificado"
        ),
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


if __name__ == "__main__":
    print(f"Data alvo: {DATA_ALVO}")
    raw = buscar_publicacoes(DATA_ALVO)
    print(f"Publicações encontradas: {len(raw)}")

    if not raw:
        print("Nenhuma publicação. Encerrando.")
        exit(0)

    if raw:
        print(f"Campos disponíveis na 1ª publicação: {list(raw[0].keys())}")

    publicacoes = [extrair_campos(p) for p in raw]
    publicacoes = [p for p in publicacoes if p["numero_processo"] or p["conteudo"]]
    print(f"Publicações válidas: {len(publicacoes)}")

    resultado = enviar_para_supabase(DATA_ALVO, publicacoes)
    print(f"Resultado: {resultado}")
