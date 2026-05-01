#!/usr/bin/env python3
"""
HTTP-бенчмарк латентности ответов ИИ-контрагента (этап 3).
Запуск: из корня репозитория, бэкенд на 127.0.0.1:5000.

  cd backend && python ../scripts/benchmark_negotiation_latency.py

Логин/пароль по умолчанию: super / super (см. create_superuser.py).
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, List, Tuple
from urllib.parse import quote

try:
    import requests
except ImportError:
    print("Нужен пакет requests: pip install requests", file=sys.stderr)
    sys.exit(1)

BASE = os.environ.get("SIMULEX_API", "http://127.0.0.1:5000").rstrip("/")
LOGIN_USER = os.environ.get("SIMULEX_LOGIN", "super")
LOGIN_PASS = os.environ.get("SIMULEX_PASSWORD", "super")
CASE_ID = os.environ.get("SIMULEX_CASE", "case-stage-3")


def log(msg: str) -> None:
    print(msg, flush=True)


def post(path: str, json_body: Dict[str, Any] | None, headers: Dict[str, str] | None = None) -> Tuple[int, Dict[str, Any] | List[Any] | str]:
    url = f"{BASE}{path}"
    r = requests.post(url, json=json_body, headers=headers or {}, timeout=300)
    try:
        data = r.json()
    except Exception:
        data = {"_raw": r.text[:2000]}
    return r.status_code, data


def get(path: str, headers: Dict[str, str] | None = None) -> Tuple[int, Any]:
    url = f"{BASE}{path}"
    r = requests.get(url, headers=headers or {}, timeout=120)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text[:2000]


def timed_post(
    label: str,
    path: str,
    json_body: Dict[str, Any],
    headers: Dict[str, str],
) -> Tuple[float, int, Any]:
    t0 = time.perf_counter()
    status, data = post(path, json_body, headers)
    elapsed = time.perf_counter() - t0
    log(f"  [{elapsed:6.2f}s] HTTP {status} | {label}")
    if status >= 400:
        log(f"       detail: {data}")
    return elapsed, status, data


def main() -> int:
    log("=== Simulex negotiation latency benchmark ===")
    log(f"API: {BASE} | case: {CASE_ID} | user: {LOGIN_USER}")
    log("")

    # 1) Login
    t0 = time.perf_counter()
    st, login_data = post(
        "/api/auth/login",
        {"username": LOGIN_USER, "password": LOGIN_PASS},
    )
    login_elapsed = time.perf_counter() - t0
    if st != 200:
        log(f"FAIL login HTTP {st} after {login_elapsed:.2f}s: {login_data}")
        return 1
    token = login_data.get("access_token", "")
    auth = {"Authorization": f"Bearer {token}"}
    log(f"[{login_elapsed:6.2f}s] login OK")
    log("")

    # 2) Game session (этап 3)
    st, sess = post(
        "/api/session/start",
        {"case_id": CASE_ID, "start_stage": 3},
        auth,
    )
    if st != 200:
        log(f"FAIL session/start {st}: {sess}")
        return 1
    log(f"session id={sess.get('id')} case_id={sess.get('case_id')}")
    log("")

    # 3) Negotiation session
    st, neg = post(
        "/api/session/negotiation/start",
        {
            "session": sess,
            "contract_code": "dogovor_PO",
            "reset_contract_to_initial": True,
        },
        auth,
    )
    if st != 200:
        log(f"FAIL negotiation/start {st}: {neg}")
        return 1
    nid = neg["negotiation_session_id"]
    log(f"negotiation_session_id={nid}")
    log("")

    # 4) AI mode on
    st, _ = post(f"/api/chat/session/{nid}/ai-mode", {"enabled": True}, auth)
    if st != 200:
        log(f"FAIL ai-mode {st}")
        return 1
    log("AI mode: enabled")
    log("")

    # 5) Clauses — первый доступный пункт
    st, doc = get(f"/api/document/session/{nid}/clauses", auth)
    if st != 200:
        log(f"FAIL clauses {st}: {doc}")
        return 1
    clauses = doc.get("clauses") or []
    clause_id = None
    for c in clauses:
        sid = c.get("status")
        # AVAILABLE=0 SELECTED=1 типично
        if sid in (0, 1, "0", "1", None):
            clause_id = str(c.get("id") or c.get("number") or "")
            if clause_id:
                break
    if not clause_id and clauses:
        clause_id = str(clauses[0].get("id") or clauses[0].get("number") or "")
    if not clause_id:
        log("FAIL: no clause id")
        return 1
    log(f"Using clause_id={clause_id!r}")
    log("")

    # 6) Activate chat (change)
    elapsed, status, act = timed_post(
        "activate_chat(change)",
        f"/api/chat/session/{nid}/clause/{quote(str(clause_id), safe='')}/activate",
        {"action": "change"},
        auth,
    )
    if status != 200:
        return 1

    # Подобрать индексы из options, если есть
    opts = (act.get("options") or {}) if isinstance(act, dict) else {}
    formulations = opts.get("formulations") or []
    reasons = opts.get("reasons") or []
    ci, ri = 0, 0
    if isinstance(formulations, list) and formulations:
        ci = 0
    if isinstance(reasons, list) and reasons:
        ri = 0

    scenarios: List[Tuple[str, Dict[str, Any]]] = [
        (
            "A: change+indices only (empty fields; server resolves like UI)",
            {
                "action": "change",
                "choiceIndex": ci,
                "reasonIndex": ri,
                "formulationText": "",
                "explanationText": "",
            },
        ),
        (
            "B: short vague explanation (often playbook / no full LLM)",
            {
                "action": "change",
                "formulationText": "",
                "explanationText": "Давайте как-нибудь смягчим формулировку, мне не нравится.",
            },
        ),
        (
            "C: procedural question (usually full LLM path)",
            {
                "action": "change",
                "formulationText": "",
                "explanationText": "Объясните, пожалуйста, какие риски для нас если оставить пункт без изменений?",
            },
        ),
        (
            "D: formulation + explanation (typical substantive turn)",
            {
                "action": "change",
                "formulationText": "Стороны согласуют срок оплаты в течение 10 рабочих дней с даты подписания акта.",
                "explanationText": (
                    "Предлагаю зафиксировать разумный срок оплаты, чтобы снизить кассовый разрыв у заказчика "
                    "и сохранить баланс интересов сторон."
                ),
            },
        ),
    ]

    log("--- Timed /message calls (AI counterpart) ---")
    results: List[Tuple[str, float, int]] = []
    safe_cid = quote(str(clause_id), safe="")
    for label, body in scenarios:
        elapsed, status, _data = timed_post(
            label,
            f"/api/chat/session/{nid}/clause/{safe_cid}/message",
            body,
            auth,
        )
        results.append((label, elapsed, status))
        if status >= 400:
            log("       stopping after error")
            break
        time.sleep(0.3)

    log("")
    log("=== Summary ===")
    ok = [r for r in results if r[2] == 200]
    if ok:
        times = [r[1] for r in ok]
        log(f"Successful requests: {len(ok)}/{len(results)}")
        log(f"Latency min/median/max: {min(times):.2f}s / {sorted(times)[len(times)//2]:.2f}s / {max(times):.2f}s")
    else:
        log("No successful timed requests.")
    log("")
    log("Notes:")
    log("  - Time = localhost RTT + FastAPI + chat_service guardrails + OpenAI (1 or 2 calls if NEGOTIATION_LLM_TWO_STEP).")
    log("  - A/B often skip full LLM (depth/playbook); C/D hit evaluate_player_message_with_llm (slow).")
    log("  - Set NEGOTIATION_LLM_TWO_STEP=0 in backend/.env to drop the 2nd LLM call per turn.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
