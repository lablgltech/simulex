"""Безопасные ответы API: без утечки str(exception) клиенту при DEBUG=false."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Optional

from fastapi import Request

from config import DEBUG

logger = logging.getLogger(__name__)

SAFE_INTERNAL_DETAIL = (
    "Внутренняя ошибка сервера. Повторите попытку позже или обратитесь к администратору."
)
SAFE_GATEWAY_DETAIL = "Сервис ИИ временно недоступен. Повторите попытку позже."


def _request_id(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def unhandled_exception_payload(
    exc: BaseException, request: Optional[Request] = None
) -> Dict[str, Any]:
    """Тело JSON для глобального обработчика 500."""
    rid = _request_id(request)
    eid = str(uuid.uuid4())
    try:
        logger.error(
            "unhandled error_id=%s request_id=%s",
            eid,
            rid,
            exc_info=(type(exc), exc, exc.__traceback__)
            if getattr(exc, "__traceback__", None)
            else True,
        )
    except Exception:
        try:
            logger.exception("unhandled error_id=%s", eid)
        except Exception:
            pass
    if DEBUG:
        body: Dict[str, Any] = {"detail": f"{type(exc).__name__}: {exc}", "error_id": eid}
    else:
        body = {"detail": SAFE_INTERNAL_DETAIL, "error_id": eid}
    if rid:
        body["request_id"] = rid
    return body


def client_500_detail_from_exception(exc: BaseException) -> str:
    """Поле detail для HTTPException(500) из роутера."""
    if DEBUG:
        return f"{type(exc).__name__}: {exc}"
    return SAFE_INTERNAL_DETAIL


def client_502_detail_from_message(msg: str) -> str:
    """Поле detail для 502 (прокси/LLM)."""
    if DEBUG:
        return msg
    return SAFE_GATEWAY_DETAIL
