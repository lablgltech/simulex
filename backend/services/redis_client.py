"""Опциональный Redis: кэш контента кейса, инвалидация, distributed lock."""

from __future__ import annotations

import logging
from typing import Any, Optional

from config import redis_url

_log = logging.getLogger(__name__)
_client: Any = None
_client_failed = False


def get_redis():
    """
    Возвращает redis.Redis или None, если REDIS_URL не задан или клиент недоступен.
    """
    global _client, _client_failed
    url = redis_url()
    if not url:
        return None
    if _client_failed:
        return None
    if _client is not None:
        return _client
    try:
        import redis as redis_lib                

        r = redis_lib.from_url(url, decode_responses=True, socket_connect_timeout=1.5)
        r.ping()
        _client = r
        return _client
    except Exception as e:
        _client_failed = True
        _log.warning("Redis недоступен (%s), работаем без кэша", e)
        return None


def reset_redis_client() -> None:
    """Сброс клиента (тесты)."""
    global _client, _client_failed
    _client = None
    _client_failed = False


def redis_case_content_key(case_code: str) -> str:
    return f"simulex:case_content:{case_code}"


def redis_case_content_etag_key(case_code: str) -> str:
    return f"simulex:case_etag:{case_code}"


def redis_delete_case_cache(case_code: str) -> None:
    r = get_redis()
    if not r:
        return
    try:
        r.delete(redis_case_content_key(case_code), redis_case_content_etag_key(case_code))
    except Exception as e:
        _log.debug("redis delete case cache: %s", e)


def redis_delete_many_case_caches(codes: list[str]) -> None:
    r = get_redis()
    if not r or not codes:
        return
    try:
        keys = []
        for c in codes:
            cc = str(c).strip()
            if cc:
                keys.append(redis_case_content_key(cc))
                keys.append(redis_case_content_etag_key(cc))
        if keys:
            r.delete(*keys)
    except Exception as e:
        _log.debug("redis delete many: %s", e)


def redis_try_lock_reseed(lock_ttl_sec: int = 600) -> bool:
    """True, если блокировка получена (SET NX)."""
    r = get_redis()
    if not r:
        return True
    try:
        ok = bool(r.set("simulex:lock:reseed_cases", "1", nx=True, ex=lock_ttl_sec))
        return ok
    except Exception as e:
        _log.debug("redis lock reseed: %s", e)
        return True


def redis_release_reseed_lock() -> None:
    r = get_redis()
    if not r:
        return
    try:
        r.delete("simulex:lock:reseed_cases")
    except Exception:
        pass
