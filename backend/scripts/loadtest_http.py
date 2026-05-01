#!/usr/bin/env python3
"""
HTTP-нагрузочный тест API Simulex (httpx + asyncio).

Не запускайте против продакшена без явного согласования. Начинайте с малых
--concurrency и --duration.

Авторизация для сценария dashboard (только переменные окружения, не argv):

  LOADTEST_JWT           — готовый JWT (Bearer).
  LOADTEST_USERNAME      — вместе с LOADTEST_PASSWORD: POST /api/auth/login.
  LOADTEST_PASSWORD
  LOADTEST_ADMIN_API_KEY — заголовок X-Admin-Key (если на сервере задан ADMIN_API_KEY).

Пример (локально, публичные эндпоинты):

  cd backend && ./venv/bin/python scripts/loadtest_http.py \\
    --base-url http://127.0.0.1:5000 --scenario public --duration 10 --concurrency 5

Пример (дашборд, логин из env):

  LOADTEST_USERNAME=admin LOADTEST_PASSWORD='***' \\
    ./venv/bin/python scripts/loadtest_http.py \\
    --base-url http://127.0.0.1:5000 --scenario dashboard --duration 15 --concurrency 2

Сценарий gameplay (модель «пользователь зашёл и сделал первый шаг в кейсе»):

  LOADTEST_USERNAME=user1 LOADTEST_PASSWORD='***' \\
    ./venv/bin/python scripts/loadtest_http.py \\
    --base-url http://127.0.0.1:5000 --scenario gameplay --duration 30 --concurrency 5 \\
    --case-id case-001 --first-action s1-open-doc-1

Сценарий gameplay_llm — то же + один вызов LLM (оценка вопроса этапа 1):

  --scenario gameplay_llm

Цикл gameplay_llm: session/start → action/execute → POST /api/stage1/question/evaluate → GET session.
Тянет реальные запросы к провайдеру ИИ; на проде учитывайте квоты и стоимость.

Параллельные задачи (--concurrency) = число одновременных «виртуальных игроков».
Нужен JWT или логин (не X-Admin-Key): /api/session/* требует Bearer от пользователя.

Авто-регистрация (роль user, группа vkr по промо-коду API):

  ./venv/bin/python scripts/loadtest_http.py \\
    --base-url https://example.com --scenario gameplay_llm --auto-register 8 \\
    --concurrency 8 --duration 20

Промо-код: env LOADTEST_PROMO_CODE (по умолчанию как у сервера, чаще всего «ВКР2026»).
Если на сервере отключён /register-vkr, используйте обычные LOADTEST_USERNAME / LOADTEST_PASSWORD.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import httpx


def _percentile(sorted_vals: List[float], p: float) -> float:
    """Линейная интерполяция перцентиля p в [0, 100]."""
    if not sorted_vals:
        return float("nan")
    xs = sorted_vals
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    w = k - lo
    return xs[lo] * (1.0 - w) + xs[hi] * w


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="HTTP load test for Simulex API.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument(
        "--base-url",
        required=True,
        help="Базовый URL без завершающего слэша, например http://127.0.0.1:5000",
    )
    ap.add_argument(
        "--scenario",
        choices=("public", "dashboard", "gameplay", "gameplay_llm"),
        default="public",
        help="public / dashboard / gameplay / gameplay_llm (как gameplay + stage1 question/evaluate = LLM)",
    )
    ap.add_argument(
        "--duration",
        type=float,
        default=30.0,
        help="Длительность нагрузки в секундах",
    )
    ap.add_argument(
        "--concurrency",
        type=int,
        default=10,
        help="Число параллельных asyncio-задач",
    )
    ap.add_argument(
        "--case-code",
        default="case-001",
        help="Для dashboard: query case_code",
    )
    ap.add_argument(
        "--case-id",
        default="case-001",
        help="Для gameplay: case_id в POST /api/session/start",
    )
    ap.add_argument(
        "--first-action",
        default="s1-open-doc-1",
        help="Для gameplay: id первого действия этапа 1 (по умолчанию открытие документа, без LLM)",
    )
    ap.add_argument(
        "--auto-register",
        type=int,
        default=0,
        metavar="N",
        help="Создать N учёток через POST /api/auth/register-vkr (только для gameplay). "
        "Воркер i логинится как user[i %% N]. Нужен открытый промо на сервере.",
    )
    return ap.parse_args()


_DEFAULT_VKR_PROMO = "ВКР2026"

# Минимальный запрос к LLM этапа 1 (POST /api/stage1/question/evaluate), без привязки к сессии в теле.
_STAGE1_QUESTION_EVAL_BODY: Dict[str, Any] = {
    "question_text": (
        "Прошу пояснить, в каком объёме планируется лицензирование ПО и как это связано с целями сделки?"
    ),
    "attribute_id": "attr-1",
    "attribute_title": "Цель сделки",
    "reference_insights": [
        "Создание централизованного учёта и контроля для группы компаний.",
        "Лицензирование ПО 1С для нужд заказчика.",
    ],
}


async def _register_vkr_users(
    client: httpx.AsyncClient,
    base: str,
    count: int,
    promo: str,
) -> List[Tuple[str, str]]:
    """POST /api/auth/register-vkr — возвращает [(username, password), ...]."""
    out: List[Tuple[str, str]] = []
    url = f"{base}/api/auth/register-vkr"
    for i in range(count):
        r = await client.post(url, json={"promo_code": promo})
        if r.status_code != 200:
            raise RuntimeError(
                f"register-vkr failed at user {i+1}/{count}: HTTP {r.status_code} {r.text[:300]}"
            )
        data = r.json()
        u = (data.get("username") or "").strip()
        p = data.get("password")
        if not u or not p:
            raise RuntimeError(f"register-vkr: unexpected response keys: {list(data.keys())}")
        out.append((u, str(p)))
    return out


def _resolve_auth_headers_mode() -> Tuple[str, Dict[str, str]]:
    """Возвращает (mode, extra_headers). mode: jwt | basic | admin_key | ''"""
    jwt = (os.environ.get("LOADTEST_JWT") or "").strip()
    if jwt:
        return "jwt", {"Authorization": f"Bearer {jwt}"}
    user = (os.environ.get("LOADTEST_USERNAME") or "").strip()
    pwd = os.environ.get("LOADTEST_PASSWORD")
    if user and pwd is not None and str(pwd) != "":
        return "basic", {}
    key = (os.environ.get("LOADTEST_ADMIN_API_KEY") or "").strip()
    if key:
        return "admin_key", {"X-Admin-Key": key}
    return "", {}


async def _login(client: httpx.AsyncClient, base: str, username: str, password: str) -> str:
    r = await client.post(
        f"{base}/api/auth/login",
        json={"username": username, "password": password},
    )
    r.raise_for_status()
    data = r.json()
    token = data.get("access_token")
    if not token:
        raise RuntimeError("login response missing access_token")
    return str(token)


async def _ensure_auth_headers(
    client: httpx.AsyncClient,
    base: str,
    mode: str,
    extra: Dict[str, str],
) -> Dict[str, str]:
    if mode == "jwt":
        return dict(extra)
    if mode == "admin_key":
        return dict(extra)
    if mode == "basic":
        user = (os.environ.get("LOADTEST_USERNAME") or "").strip()
        pwd = os.environ.get("LOADTEST_PASSWORD")
        if pwd is None:
            raise RuntimeError("LOADTEST_PASSWORD not set")
        token = await _login(client, base, user, str(pwd))
        return {"Authorization": f"Bearer {token}"}
    return {}


async def _one_post_json(
    client: httpx.AsyncClient,
    url: str,
    headers: Dict[str, str],
    json_body: Any,
    latencies: List[float],
    errors: List[Tuple[str, int, str]],
) -> Optional[Any]:
    t0 = time.perf_counter()
    try:
        r = await client.post(url, headers=headers, json=json_body)
        dt = time.perf_counter() - t0
        latencies.append(dt)
        if r.status_code < 200 or r.status_code >= 300:
            errors.append((url, r.status_code, (r.text or "")[:200]))
            return None
        return r.json()
    except Exception as e:
        latencies.append(time.perf_counter() - t0)
        errors.append((url, -1, f"{type(e).__name__}: {e}"))
        return None


async def _one_get(
    client: httpx.AsyncClient,
    url: str,
    headers: Dict[str, str],
    latencies: List[float],
    errors: List[Tuple[str, int, str]],
) -> None:
    t0 = time.perf_counter()
    try:
        r = await client.get(url, headers=headers)
        dt = time.perf_counter() - t0
        latencies.append(dt)
        if r.status_code < 200 or r.status_code >= 300:
            body = (r.text or "")[:200]
            errors.append((url, r.status_code, body))
    except Exception as e:
        dt = time.perf_counter() - t0
        latencies.append(dt)
        errors.append((url, -1, f"{type(e).__name__}: {e}"))


async def iteration_public(
    client: httpx.AsyncClient,
    base: str,
    headers: Dict[str, str],
    latencies: List[float],
    errors: List[Tuple[str, int, str]],
) -> None:
    await _one_get(client, f"{base}/api/test", headers, latencies, errors)
    await _one_get(client, f"{base}/api/health", headers, latencies, errors)
    case_id = "case-001"
    try:
        t0 = time.perf_counter()
        r = await client.get(f"{base}/api/cases", headers=headers)
        dt = time.perf_counter() - t0
        latencies.append(dt)
        if r.status_code < 200 or r.status_code >= 300:
            errors.append((f"{base}/api/cases", r.status_code, (r.text or "")[:200]))
        elif r.status_code == 200:
            data = r.json()
            if isinstance(data, list) and data:
                first = data[0]
                case_id = str(first.get("code") or first.get("id") or case_id)
    except Exception as e:
        latencies.append(time.perf_counter() - t0)
        errors.append((f"{base}/api/cases", -1, f"{type(e).__name__}: {e}"))

    await _one_get(
        client,
        f"{base}/api/case?id={quote(case_id, safe='')}",
        headers,
        latencies,
        errors,
    )


async def iteration_dashboard(
    client: httpx.AsyncClient,
    base: str,
    headers: Dict[str, str],
    case_code: str,
    latencies: List[float],
    errors: List[Tuple[str, int, str]],
) -> None:
    q = quote(case_code, safe="")
    paths = [
        f"/api/dashboard/overview?case_code={q}",
        f"/api/dashboard/participants?case_code={q}",
        f"/api/dashboard/behavior?case_code={q}",
        f"/api/dashboard/priorities?case_code={q}",
    ]
    for p in paths:
        await _one_get(client, f"{base}{p}", headers, latencies, errors)


async def _gameplay_start_and_first_action(
    client: httpx.AsyncClient,
    base: str,
    headers: Dict[str, str],
    case_id: str,
    first_action: str,
    latencies: List[float],
    errors: List[Tuple[str, int, str]],
) -> Optional[Dict[str, Any]]:
    """Старт сессии + одно действие этапа 1. Возвращает актуальный payload сессии или None."""
    session = await _one_post_json(
        client,
        f"{base}/api/session/start",
        headers,
        {"case_id": case_id},
        latencies,
        errors,
    )
    if not isinstance(session, dict) or not session.get("id"):
        return None
    exec_out = await _one_post_json(
        client,
        f"{base}/api/action/execute",
        headers,
        {"action_id": first_action, "session": session},
        latencies,
        errors,
    )
    if isinstance(exec_out, dict) and isinstance(exec_out.get("session"), dict):
        return exec_out["session"]
    return session


async def iteration_gameplay(
    client: httpx.AsyncClient,
    base: str,
    headers: Dict[str, str],
    case_id: str,
    first_action: str,
    latencies: List[float],
    errors: List[Tuple[str, int, str]],
) -> None:
    """
    Один «заход»: новая игровая сессия, одно действие этапа 1, чтение сессии из API.
    Имитирует минимальный прогресс без чата/LLM.
    """
    session = await _gameplay_start_and_first_action(
        client, base, headers, case_id, first_action, latencies, errors
    )
    if not session:
        return
    sid = str(session.get("id") or "")
    if not sid:
        return
    await _one_get(client, f"{base}/api/session/{quote(sid, safe='')}", headers, latencies, errors)


async def iteration_gameplay_llm(
    client: httpx.AsyncClient,
    base: str,
    headers: Dict[str, str],
    case_id: str,
    first_action: str,
    latencies: List[float],
    errors: List[Tuple[str, int, str]],
) -> None:
    """
    Как gameplay, плюс POST /api/stage1/question/evaluate — один реальный вызов LLM на цикл.
    """
    session = await _gameplay_start_and_first_action(
        client, base, headers, case_id, first_action, latencies, errors
    )
    if not session:
        return
    sid = str(session.get("id") or "")
    if not sid:
        return
    await _one_post_json(
        client,
        f"{base}/api/stage1/question/evaluate",
        headers,
        dict(_STAGE1_QUESTION_EVAL_BODY),
        latencies,
        errors,
    )
    await _one_get(client, f"{base}/api/session/{quote(sid, safe='')}", headers, latencies, errors)


async def worker(
    base: str,
    scenario: str,
    case_code: str,
    case_id: str,
    first_action: str,
    auth_mode: str,
    auth_extra: Dict[str, str],
    deadline: float,
    worker_id: int,
    user_pool: Optional[List[Tuple[str, str]]],
) -> Tuple[List[float], List[Tuple[str, int, str]], int]:
    latencies: List[float] = []
    errors: List[Tuple[str, int, str]] = []
    iterations = 0
    limits = httpx.Limits(max_keepalive_connections=20, max_connections=50)
    timeout = 300.0 if scenario == "gameplay_llm" else 120.0
    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        headers: Dict[str, str] = {}
        if user_pool:
            u, p = user_pool[worker_id % len(user_pool)]
            token = await _login(client, base, u, p)
            headers = {"Authorization": f"Bearer {token}"}
        elif scenario in ("dashboard", "gameplay", "gameplay_llm"):
            headers = await _ensure_auth_headers(client, base, auth_mode, auth_extra)

        while time.monotonic() < deadline:
            if scenario == "public":
                await iteration_public(client, base, headers, latencies, errors)
            elif scenario == "dashboard":
                await iteration_dashboard(client, base, headers, case_code, latencies, errors)
            elif scenario == "gameplay_llm":
                await iteration_gameplay_llm(
                    client, base, headers, case_id, first_action, latencies, errors
                )
            else:
                await iteration_gameplay(
                    client, base, headers, case_id, first_action, latencies, errors
                )
            iterations += 1
    return latencies, errors, iterations


async def run_load(
    base: str,
    scenario: str,
    duration: float,
    concurrency: int,
    case_code: str,
    case_id: str,
    first_action: str,
    auth_mode: str,
    auth_extra: Dict[str, str],
    user_pool: Optional[List[Tuple[str, str]]],
) -> None:
    t_wall0 = time.perf_counter()
    deadline = time.monotonic() + duration
    tasks = [
        asyncio.create_task(
            worker(
                base,
                scenario,
                case_code,
                case_id,
                first_action,
                auth_mode,
                auth_extra,
                deadline,
                worker_id=i,
                user_pool=user_pool,
            )
        )
        for i in range(concurrency)
    ]
    results = await asyncio.gather(*tasks)
    elapsed = time.perf_counter() - t_wall0
    all_lat: List[float] = []
    all_err: List[Tuple[str, int, str]] = []
    total_iters = 0
    for lat, err, it in results:
        all_lat.extend(lat)
        all_err.extend(err)
        total_iters += it

    all_lat.sort()
    n = len(all_lat)
    rps = n / elapsed if elapsed > 0 else 0.0
    ips = total_iters / elapsed if elapsed > 0 else 0.0
    print(f"duration_s={duration:g}  wall_s={elapsed:.3f}  concurrency={concurrency}  scenario={scenario}")
    print(f"requests={n}  iterations_total={total_iters}  errors={len(all_err)}  rps={rps:.2f}")
    if scenario in ("gameplay", "gameplay_llm"):
        loop_desc = (
            "старт + действие + stage1/question/evaluate (LLM) + GET сессии"
            if scenario == "gameplay_llm"
            else "старт + действие + GET сессии"
        )
        print(
            f"gameplay: virtual_players={concurrency}  "
            f"completed_loops_per_s={ips:.2f}  (цикл: {loop_desc})"
        )
    if all_lat:
        print(
            f"latency_s  p50={_percentile(all_lat, 50):.4f}  "
            f"p95={_percentile(all_lat, 95):.4f}  p99={_percentile(all_lat, 99):.4f}  "
            f"max={all_lat[-1]:.4f}"
        )
    if all_err:
        print("sample_errors:")
        for row in all_err[:15]:
            print(f"  {row}")
        if len(all_err) > 15:
            print(f"  ... +{len(all_err) - 15} more")


async def _async_main(args: argparse.Namespace, base: str) -> int:
    user_pool: Optional[List[Tuple[str, str]]] = None
    if args.auto_register > 0:
        promo = (os.environ.get("LOADTEST_PROMO_CODE") or _DEFAULT_VKR_PROMO).strip()
        limits = httpx.Limits(max_keepalive_connections=10, max_connections=10)
        try:
            async with httpx.AsyncClient(timeout=60.0, limits=limits) as reg_client:
                user_pool = await _register_vkr_users(
                    reg_client, base, args.auto_register, promo
                )
        except RuntimeError as e:
            print(f"auto-register: {e}", file=sys.stderr)
            return 2
        print(
            f"auto-register: создано {len(user_pool)} учёток (логины: "
            f"{', '.join(u for u, _ in user_pool[:5])}"
            f"{'…' if len(user_pool) > 5 else ''})",
            file=sys.stderr,
        )

    auth_mode, auth_extra = _resolve_auth_headers_mode()
    if args.scenario == "dashboard":
        if not auth_mode:
            print(
                "dashboard scenario requires auth: set LOADTEST_JWT, or "
                "LOADTEST_USERNAME+LOADTEST_PASSWORD, or LOADTEST_ADMIN_API_KEY",
                file=sys.stderr,
            )
            return 2
    if args.scenario in ("gameplay", "gameplay_llm"):
        if user_pool is None and (not auth_mode or auth_mode == "admin_key"):
            print(
                "gameplay / gameplay_llm: задайте LOADTEST_JWT / LOADTEST_USERNAME+PASSWORD, либо "
                "--auto-register N (промо LOADTEST_PROMO_CODE). X-Admin-Key не подходит.",
                file=sys.stderr,
            )
            return 2

    print(
        "Simulex HTTP load test — не используйте на проде без согласования.\n",
        file=sys.stderr,
    )
    await run_load(
        base,
        args.scenario,
        args.duration,
        args.concurrency,
        args.case_code,
        args.case_id,
        args.first_action,
        auth_mode,
        auth_extra,
        user_pool,
    )
    return 0


def main() -> int:
    args = _parse_args()
    base = args.base_url.rstrip("/")
    if args.concurrency < 1:
        print("concurrency must be >= 1", file=sys.stderr)
        return 2
    if args.duration <= 0:
        print("duration must be > 0", file=sys.stderr)
        return 2
    if args.auto_register > 0 and args.scenario not in ("gameplay", "gameplay_llm"):
        print(
            "--auto-register только с --scenario gameplay или gameplay_llm",
            file=sys.stderr,
        )
        return 2

    return asyncio.run(_async_main(args, base))


if __name__ == "__main__":
    raise SystemExit(main())
