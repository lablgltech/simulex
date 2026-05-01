"""
FastAPI бекенд для Симулекс - Юридический Кейс-Симулятор
Главный файл приложения
"""
import os
import sys
from pathlib import Path

# На Windows консоль по умолчанию cp1252 — при выводе эмодзи/Unicode возникает
# UnicodeEncodeError и он попадает в ответ API. Принудительно включаем UTF-8.
if sys.platform == "win32":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass

# Загружаем переменные из backend/.env до любых импортов (reload перезапускает)
_env_path = Path(__file__).resolve().parent / ".env"
def _parse_env_value(raw: str) -> str:
    """Значение из строки KEY=... ; убираем хвост « # комментарий» как в типичном .env."""
    _v = raw.strip().strip('"').strip("'").strip()
    if " #" in _v:
        _v = _v.split(" #", 1)[0].rstrip()
    return _v


if _env_path.exists():
    try:
        with _env_path.open("r", encoding="utf-8-sig") as _f:
            for _line in _f:
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    _key = _k.strip()
                    _val = _parse_env_value(_v)
                    if _key and _val:
                        os.environ[_key] = _val
    except OSError:
        pass

# Лог при старте
_dsn = os.environ.get("POSTGRES_DSN", "")
_oak = os.environ.get("OPENAI_API_KEY", "")
_or_key = os.environ.get("OPENROUTER_API_KEY", "")
print(f"DB: POSTGRES_DSN loaded" if (_dsn and "@" in _dsn) else "DB: WARNING POSTGRES_DSN not set")
if _or_key and _or_key.strip():
    print("AI: OPENROUTER_API_KEY loaded (Qwen и др.)")
elif _oak and _oak.startswith("sk-"):
    print("AI: OPENAI_API_KEY loaded")
else:
    print("AI: WARNING задайте OPENROUTER_API_KEY (для Qwen) или OPENAI_API_KEY в .env")

from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
import json
import logging
import traceback

from __version__ import __version__ as APP_VERSION
from config import PORT, DATA_DIR, reseed_cases_on_startup, DEBUG
from api_errors import unhandled_exception_payload

from dev_mirror_log import MIRROR_PATH, append_mirror, touch_startup_banner

_DEBUG_PATH = Path(__file__).resolve().parent / "errno22_debug.txt"


class _SafeStreamHandler(logging.StreamHandler):
    """Обработчик, который не падает с OSError 22 при записи в stderr на Windows."""

    def emit(self, record):
        try:
            super().emit(record)
        except OSError as e:
            if getattr(e, "errno", None) not in (22, 10022):
                raise


# На Windows заменяем стандартный StreamHandler на безопасный (избегаем Errno 22 при записи в stderr)
if sys.platform == "win32":
    _root = logging.getLogger()
    for h in list(_root.handlers):
        if isinstance(h, logging.StreamHandler) and h.stream in (sys.stdout, sys.stderr):
            _root.removeHandler(h)
    _root.addHandler(_SafeStreamHandler(sys.stderr))

# По умолчанию у root — WARNING: logger.info() из services.* в консоль не попадает.
# CHAT_LOGS_IN_TERMINAL / NEGOTIATION_PLAIN_LOGS и прочие INFO-логи переговоров требуют как минимум INFO.
_log_level_name = (os.environ.get("LOG_LEVEL") or "INFO").strip().upper()
logging.getLogger().setLevel(getattr(logging, _log_level_name, logging.INFO))


def _plain_neg_logs_enabled() -> bool:
    for _k in ("CHAT_LOGS_IN_TERMINAL", "NEGOTIATION_PLAIN_LOGS", "READABLE_CHAT_LOGS"):
        _v = (os.environ.get(_k) or "").strip().lower()
        if _v in ("1", "true", "yes", "on", "да"):
            return True
    return False


def _apply_negotiation_console_logging() -> None:
    """Повторно выставить уровни после uvicorn/logging — чтобы INFO из services.* не терялись."""
    _name = (os.environ.get("LOG_LEVEL") or "INFO").strip().upper()
    _lvl = getattr(logging, _name, logging.INFO)
    logging.getLogger().setLevel(_lvl)
    for _ln in (
        "services",
        "services.chat_service",
        "services.negotiation_v2_runtime",
        "routers.chat",
    ):
        _lg = logging.getLogger(_ln)
        _lg.setLevel(logging.NOTSET)
        _lg.propagate = True


if not _plain_neg_logs_enabled():
    print(
        "Переговоры: чтобы в этом окне видеть понятный журнал диалога (без технических пометок), "
        "добавьте в backend/.env CHAT_LOGS_IN_TERMINAL=1 и оставьте LOG_LEVEL=INFO."
    )
else:
    print(
        "Переговоры: журнал в консоли включён. Он появляется здесь же после каждого сообщения "
        "в чате этапа 3 (это окно сервера API, не окно npm start с фронтендом)."
    )

from routers import admin, auth, cases, sessions, actions, stages, reports, tutor, stage4, qa_bugs
from routers import openai_proxy
from routers import dashboard as dashboard_router
from stages import STAGE_EXTRA_ROUTERS
from services.case_service import force_reseed_cases_from_fs

logger = logging.getLogger(__name__)


def _require_production_jwt_secret() -> None:
    """При DEBUG=false в production-режиме запретить дефолтный/пустой JWT_SECRET."""
    if DEBUG:
        return
    s = (os.environ.get("JWT_SECRET") or "").strip()
    if not s or s == "dev-secret-change-in-production":
        print(
            "FATAL: задайте JWT_SECRET в backend/.env (при DEBUG=false нельзя пустой или dev-секрет).",
            file=sys.stderr,
        )
        sys.exit(1)


_require_production_jwt_secret()

_expose_openapi = DEBUG
app = FastAPI(
    title="Симулекс API",
    description="API для юридического кейс-симулятора",
    version=APP_VERSION,
    docs_url="/docs" if _expose_openapi else None,
    redoc_url="/redoc" if _expose_openapi else None,
    openapi_url="/openapi.json" if _expose_openapi else None,
)


def _stderr_print(msg: str) -> None:
    try:
        print(msg, file=sys.stderr, flush=True)
    except OSError:
        pass


@app.get("/api/debug/terminal-log-test")
@app.get("/__simulex_terminal_log_test__")
async def terminal_log_test():
    """
    Диагностика логов.
    - http://localhost:3000/api/debug/terminal-log-test (через прокси CRA)
    - http://127.0.0.1:5000/__simulex_terminal_log_test__ (напрямую в API, минуя :3000)
    """
    _msg = (
        "[DEBUG] terminal-log-test: запрос дошёл до этого uvicorn (браузер → :3000 → прокси → :5000)."
    )
    _stderr_print(_msg)
    append_mirror(_msg)
    return {
        "ok": True,
        "mirror_file": str(Path(__file__).resolve().parent / "dev_stage3_chat_mirror.log"),
        "hint": "Проверьте этот файл и вкладку терминала, где запущен uvicorn.",
        "also_try_direct": "http://127.0.0.1:5000/__simulex_terminal_log_test__",
    }


@app.on_event("startup")
async def _on_startup_negotiation_logging():
    _apply_negotiation_console_logging()
    touch_startup_banner(PORT)
    _plain = _plain_neg_logs_enabled()
    _lines = [
        "",
        "========== СИМУЛЕКС API (логи чата этапа 3) ==========",
        f"PID {os.getpid()} | порт API: {PORT} (это бэкенд; сайт у вас обычно http://localhost:3000)",
        f"Проверка: http://127.0.0.1:{PORT}/api/health",
        f"Проверка логов (напрямую API): http://127.0.0.1:{PORT}/__simulex_terminal_log_test__",
        "Запросы с :3000 идут на /api → прокси на :5000 (см. src/setupProxy.js).",
        "Логи смотрите В ЭТОЙ ВКЛАДКЕ TERMINAL, где запущен uvicorn (не во вкладке npm start).",
        "При отправке в переговорах этапа 3 появятся строки [API] … и [CHAT] …; журнал-рамка — если в backend/.env CHAT_LOGS_IN_TERMINAL=1.",
        "Файл backend/dev_stage3_chat_mirror.log создаётся при старте API; в нём же — [API]/[CHAT] после отправки в чате.",
        "Логи в браузере: http://localhost:3000/simulex-logs или …/api/dev/logs-view",
        f"Журнал «понятным языком» в консоли: {'вкл.' if _plain else 'ВЫКЛ — добавьте CHAT_LOGS_IN_TERMINAL=1 в backend/.env'}",
        "======================================================",
        "",
    ]
    for _ln in _lines:
        _stderr_print(_ln)
        try:
            print(_ln, flush=True)
        except OSError:
            pass

    try:
        from services import similarity_service as _sim

        if _sim.embedding_dependencies_installed():
            _stderr_print(
                "Semantic similarity: sentence-transformers установлен; "
                "веса модели подгрузятся при первом расчёте эталона (холодный старт может занять 1–3 мин)."
            )
        else:
            _stderr_print(
                "Semantic similarity: ВЫКЛ (нет пакета sentence-transformers). "
                "Порог explanation_min_similarity_0_100 к эталону не действует — только маркеры (по умолчанию порог 70). "
                "Установите: pip install -r backend/requirements.txt в venv."
            )
    except Exception as _e:  # noqa: BLE001
        _stderr_print(f"Semantic similarity: не удалось проверить зависимости: {_e}")


# CORS — для allow_credentials=True нельзя использовать "*", указываем явные origins
_cors_origins = os.environ.get("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
_cors_list = [o.strip() for o in _cors_origins.split(",") if o.strip()] or ["http://localhost:3000"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.middleware("http")
async def _request_id_middleware(request: Request, call_next):
    import uuid as _uuid

    hdr = (request.headers.get("X-Request-Id") or "").strip()
    request.state.request_id = hdr or str(_uuid.uuid4())
    response = await call_next(request)
    response.headers["X-Request-Id"] = request.state.request_id
    return response


@app.middleware("http")
async def _log_chat_post_to_terminal(request: Request, call_next):
    """Каждый POST /api/chat/ — строка в stderr (видно в терминале Cursor с uvicorn)."""
    _p = request.url.path
    if request.method == "POST" and _p.startswith("/api/chat/"):
        _line = f"[API] POST {_p}"
        _stderr_print(_line)
        append_mirror(_line)
    return await call_next(request)


@app.middleware("http")
async def _debug_errno22_middleware(request: Request, call_next):
    """Перехват исключений для диагностики Errno 22 на Windows."""
    try:
        return await call_next(request)
    except Exception as exc:
        errno22_like = (
            isinstance(exc, OSError) and getattr(exc, "errno", None) in (22, 10022)
        ) or ("Errno 22" in str(exc) or "Invalid argument" in str(exc))
        if errno22_like:
            try:
                with _DEBUG_PATH.open("w", encoding="utf-8") as f:
                    f.write(f"Path: {request.url.path}\n")
                    f.write(f"Exception: {type(exc).__name__}: {exc}\n")
                    if isinstance(exc, OSError):
                        f.write(f"errno={getattr(exc, 'errno', None)} winerror={getattr(exc, 'winerror', None)}\n")
                    f.write("\n")
                    traceback.print_exc(file=f)
            except Exception:
                pass
        raise


# Обработчик исключений для корректной обработки ошибок с CORS заголовками
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Глобальный обработчик исключений, который гарантирует возврат CORS заголовков"""
    if isinstance(exc, HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers={
                "Access-Control-Allow-Origin": request.headers.get("origin", "*"),
                "Access-Control-Allow-Credentials": "true",
            }
        )
    # OSError 22/10022 на Windows: не логируем (запись в stderr может вызвать повторную ошибку)
    errno22 = (
        isinstance(exc, OSError) and getattr(exc, "errno", None) in (22, 10022)
    ) or ("Errno 22" in str(exc) and "Invalid argument" in str(exc))
    if errno22:
        content = {
            "detail": "Внутренняя ошибка при обработке запроса. Попробуйте ещё раз или перезагрузите страницу.",
        }
    else:
        content = unhandled_exception_payload(exc, request)
    return JSONResponse(
        status_code=500,
        content=content,
        headers={
            "Access-Control-Allow-Origin": request.headers.get("origin", "*"),
            "Access-Control-Allow-Credentials": "true",
        }
    )

def _run_startup_case_reseed_if_configured() -> None:
    """
    Синхронизация кейсов при старте (RESEED_CASES_ON_STARTUP).

    При gunicorn с несколькими воркерами **без --preload** каждый воркер при импорте main
    вызывает force_reseed_cases_from_fs → конкурирующие DELETE/INSERT в таблице case и зависание API.

    Защита: (1) в start_prod.sh задан **--preload** (импорт приложения один раз до fork);
    (2) при заданном REDIS_URL — distributed lock: один воркер синхронизирует, остальные ждут снятия lock.
    """
    if not reseed_cases_on_startup():
        return
    try:
        from services.redis_client import get_redis as _get_redis_startup

        r = _get_redis_startup()
    except Exception:
        r = None
    lock_key = "simulex:lock:startup_case_reseed"
    lock_ttl = 900
    wait_max_sec = 180.0
    poll_sec = 0.25

    if r:
        try:
            acquired = bool(r.set(lock_key, "1", nx=True, ex=lock_ttl))
        except Exception as exc:
            print(f"⚠️ startup reseed: Redis SET NX не удался ({exc}); синхронизация без lock")
            force_reseed_cases_from_fs(DATA_DIR)
            return
        if not acquired:
            import time as _time

            deadline = _time.monotonic() + wait_max_sec
            while _time.monotonic() < deadline:
                try:
                    if not r.exists(lock_key):
                        break
                except Exception:
                    break
                _time.sleep(poll_sec)
            return
        try:
            force_reseed_cases_from_fs(DATA_DIR)
        finally:
            try:
                r.delete(lock_key)
            except Exception:
                pass
        return

    force_reseed_cases_from_fs(DATA_DIR)


# Принудительная синхронизация БД с кейсами из папок проекта при старте (см. RESEED_CASES_ON_STARTUP)
_run_startup_case_reseed_if_configured()

# Опциональный прокси к OpenAI (только если на проде задан OPENAI_PROXY_TOKEN)
if (os.environ.get("OPENAI_PROXY_TOKEN") or "").strip():
    app.include_router(openai_proxy.router)
    print("Proxy: OpenAI proxy enabled (/openai)")

# Подключение роутеров платформы
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(cases.router)
app.include_router(sessions.router)
app.include_router(actions.router)
app.include_router(stages.router)
app.include_router(reports.router)
app.include_router(qa_bugs.router)
app.include_router(tutor.router)
app.include_router(stage4.router)
app.include_router(dashboard_router.router)

# Просмотр логов этапа 3 в браузере. Маршруты всегда есть (не 404); при SIMULEX_LOG_VIEWER=0 — заглушка и пустой recent-logs.
from routers.dev_logs_viewer import LOGS_VIEWER_DISABLED_HTML, _LOGS_HTML, recent_logs_payload

_LOG_VIEWER_FULL = (os.getenv("SIMULEX_LOG_VIEWER", "1") or "").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
    "нет",
)


@app.get("/api/dev/logs-view", response_class=HTMLResponse, tags=["dev-logs"])
async def _dev_logs_view_page():
    return HTMLResponse(_LOGS_HTML if _LOG_VIEWER_FULL else LOGS_VIEWER_DISABLED_HTML)


@app.get("/simulex-logs", response_class=HTMLResponse, tags=["dev-logs"])
async def _simulex_logs_page():
    return HTMLResponse(_LOGS_HTML if _LOG_VIEWER_FULL else LOGS_VIEWER_DISABLED_HTML)


@app.get("/api/dev/recent-logs", tags=["dev-logs"])
async def _dev_recent_logs_json(limit: int = Query(400, ge=1, le=5000)):
    if not _LOG_VIEWER_FULL:
        return {
            "lines": [],
            "count": 0,
            "mirror_file": str(MIRROR_PATH),
            "viewer_disabled": True,
            "hint": "Включите SIMULEX_LOG_VIEWER=1 в backend/.env и перезапустите API.",
        }
    return recent_logs_payload(limit)


# Подключение дополнительных роутеров этапов.
# Каждый этап регистрирует свои роутеры в STAGE_EXTRA_ROUTERS
# (см. backend/stages/stage_3.py и STAGE_ARCHITECTURE.md).
for stage_id, routers in STAGE_EXTRA_ROUTERS.items():
    for router in routers:
        app.include_router(router)


@app.get("/api/test")
async def test():
    """Проверка работоспособности сервера"""
    return {
        "status": "ok",
        "message": "Сервер работает!",
        "version": "0.1 MVP"
    }


@app.get("/api/health")
async def health():
    """Лёгкая проверка доступности API (для этапа 3 и прокси)."""
    return {
        "ok": True,
        # Если ключа нет — отвечает не этот main.py (старый процесс / другой сервис на порту).
        "dev_log_viewer_data": _LOG_VIEWER_FULL,
    }


if __name__ == "__main__":
    import uvicorn
    print(f"\n🚀 Запуск сервера Симулекс (v0.1 с полным ТЗ)...")
    print(f"✅ Симулекс запущен на http://localhost:{PORT}")
    print(f"📍 API: http://localhost:{PORT}/api")
    if PORT != 5000:
        print(
            f"⚠️  Для dev фронтенда (localhost:3000) выровняйте порт API: "
            f"src/setupProxy.js → http://localhost:{PORT} или PORT=5000 в backend/.env"
        )
    print(f"📚 Документация: http://localhost:{PORT}/docs\n")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        log_level="info",
        access_log=True,
    )
