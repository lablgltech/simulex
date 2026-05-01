"""
Опциональный прокси к OpenAI API.
Включается только если задана переменная OPENAI_PROXY_TOKEN (на проде для разработчиков).
Маршрут: POST /openai/v1/... → проксирование на api.openai.com.
"""
import os
import logging
from fastapi import APIRouter, Request, Header, HTTPException
from fastapi.responses import Response
import httpx

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/openai", tags=["openai-proxy"])

OPENAI_BASE = "https://api.openai.com"


def _proxy_token() -> str | None:
    return (os.getenv("OPENAI_PROXY_TOKEN") or "").strip() or None


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy_openai(
    request: Request,
    path: str,
    x_internal_token: str | None = Header(None, alias="X-Internal-Token"),
):
    """Проксирует запросы на api.openai.com. При заданном OPENAI_PROXY_TOKEN проверяет заголовок X-Internal-Token."""
    token = _proxy_token()
    if token and x_internal_token != token:
        raise HTTPException(status_code=403, detail="Invalid or missing X-Internal-Token")
    url = f"{OPENAI_BASE}/v1/{path}"
    headers = {}
    for name in ("authorization", "content-type", "openai-organization"):
        if request.headers.get(name):
            headers[name] = request.headers[name]
    body = await request.body()
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.request(
            request.method,
            url,
            headers=headers,
            content=body,
        )
    return Response(
        content=r.content,
        status_code=r.status_code,
        headers={k: v for k, v in r.headers.items() if k.lower() not in ("transfer-encoding", "connection")},
    )
