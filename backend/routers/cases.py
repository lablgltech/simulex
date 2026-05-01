"""Роутер для работы с кейсами"""
import logging
import re
from pathlib import Path
from typing import Optional, Tuple

from email.utils import formatdate

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from api_errors import client_500_detail_from_exception
from config import DATA_DIR

logger = logging.getLogger(__name__)
from services.case_service import get_all_cases, get_case, case_http_etag
from utils.file_loader import load_reference_docs

router = APIRouter(prefix="/api", tags=["cases"])


def _resolved_case_cover_file(case_code: str) -> Optional[Path]:
    """Файл data/cases/<code>/cover.png с защитой от path traversal."""
    if not re.match(r"^case-[a-zA-Z0-9_-]+$", case_code or ""):
        return None
    root = (DATA_DIR / "cases").resolve()
    path = (DATA_DIR / "cases" / case_code / "cover.png").resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None


# Обложки редко меняются; ETag по mtime+size даёт мгновенный 304 после смены файла.
_COVER_CACHE_CONTROL = "public, max-age=604800, stale-while-revalidate=2592000"


def _case_cover_etag_and_lm(path: Path) -> Tuple[str, str]:
    st = path.stat()
    mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000))
    etag = f'"{mtime_ns}-{st.st_size}"'
    lm = formatdate(timeval=st.st_mtime, usegmt=True)
    return etag, lm


@router.get("/cases/{case_code}/cover")
async def get_case_cover(case_code: str, request: Request):
    """Обложка кейса: файл data/cases/<case_code>/cover.png."""
    path = _resolved_case_cover_file(case_code)
    if not path:
        raise HTTPException(status_code=404, detail="Обложка не найдена")
    etag, last_modified = _case_cover_etag_and_lm(path)
    base_headers = {
        "Cache-Control": _COVER_CACHE_CONTROL,
        "ETag": etag,
        "Last-Modified": last_modified,
    }
    inm = (request.headers.get("if-none-match") or "").strip()
    if inm and inm != "*" and etag in {x.strip() for x in inm.split(",")}:
        return Response(status_code=304, headers=base_headers)
    return FileResponse(path, media_type="image/png", headers=base_headers)


@router.get("/cases")
async def get_cases_endpoint():
    """Получить список всех опубликованных кейсов"""
    try:
        return get_all_cases(DATA_DIR)
    except Exception as e:
        logger.exception("GET /api/cases failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.get("/case")
async def get_case_endpoint(
    request: Request,
    case_id: Optional[str] = None,
    id: Optional[str] = None,
):
    """Получить конкретный кейс (ETag по case_content_synced_at)."""
    try:
        # Поддерживаем оба варианта: case_id и id (для совместимости)
        actual_case_id = case_id or id
        logger.debug(
            "GET /api/case case_id=%s id=%s resolved=%s", case_id, id, actual_case_id
        )
        etag = case_http_etag(actual_case_id)
        inm = (request.headers.get("if-none-match") or "").strip()
        if inm:
            # W/"..." или список значений
            tokens = [x.strip() for x in inm.split(",") if x.strip()]
            normalized = []
            for t in tokens:
                t2 = t[2:].strip() if t.startswith("W/") else t
                normalized.append(t2.strip())
            if etag in normalized or etag.strip('"') in normalized:
                return Response(
                    status_code=304,
                    headers={
                        "ETag": etag,
                        "Cache-Control": "private, max-age=120",
                    },
                )
        payload = get_case(DATA_DIR, actual_case_id)
        return JSONResponse(
            content=payload,
            headers={"ETag": etag, "Cache-Control": "private, max-age=120"},
        )
    except Exception as e:
        logger.exception("GET /api/case failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.get("/case/docs")
async def get_case_docs_endpoint(case_id: str):
    """
    Получить справочные документы кейса для модального окна «Документы».

    Сейчас реализовано для кейса с полным циклом (case-001) и кейсов,
    в которых скопирована папка reference_docs.
    """
    try:
        data = load_reference_docs(DATA_DIR, case_id)
        return data
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("GET /api/case/docs failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e
