"""
API встроенного QA-трекера (замечания тестировщиков).
"""

from __future__ import annotations

import mimetypes
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from config import DATA_DIR
from routers.auth import get_current_user
from services.qa_analytics_report import fetch_or_generate_report, refresh_report
from services.qa_bug_service import (
    QA_AREAS,
    QA_FINDING_TYPES,
    QA_STATUSES,
    create_bug,
    delete_bug_for_viewer,
    get_bug_for_viewer,
    list_bugs_for_viewer,
    normalize_area,
    normalize_finding_type,
    normalize_severity,
    update_bug_admin,
    user_can_access_qa_tracker,
)

router = APIRouter(prefix="/api/qa", tags=["qa"])

QA_UPLOAD_DIR = Path(DATA_DIR) / "uploads" / "qa"
MAX_QA_FILE_BYTES = 5 * 1024 * 1024
MAX_QA_FILES = 5
ALLOWED_QA_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
SAFE_QA_FILE = re.compile(r"^[a-f0-9]{32}\.(png|jpg|jpeg|webp|gif)$", re.IGNORECASE)


def require_qa_tracker_access(
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    if not user_can_access_qa_tracker(current_user):
        raise HTTPException(
            status_code=403,
            detail="Раздел QA доступен только участникам группы «ЛабЛигалТех»",
        )
    return current_user


def _unlink_saved_qa_files(filenames: List[str]) -> None:
    for n in filenames:
        try:
            p = QA_UPLOAD_DIR / n
            if p.is_file():
                p.unlink()
        except OSError:
            pass


def _as_upload_file_list(files: List[UploadFile]) -> List[UploadFile]:
    """
    Параметр только как List[UploadFile] + File(default_factory=list): иначе Pydantic v2
    с Union/Optional[List] получает один UploadFile и отбрасывает остальные части multipart.
    """
    return [f for f in files if f is not None and getattr(f, "filename", None)]


async def _save_qa_upload_files(files: List[UploadFile]) -> List[str]:
    if len(files) > MAX_QA_FILES:
        raise HTTPException(status_code=400, detail=f"Не более {MAX_QA_FILES} файлов")
    QA_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    saved: List[str] = []
    try:
        for uf in files:
            if not uf.filename:
                continue
            ext = Path(uf.filename).suffix.lower()
            if ext not in ALLOWED_QA_EXT:
                raise HTTPException(
                    status_code=400,
                    detail="Допустимы только изображения: png, jpg, jpeg, webp, gif",
                )
            body = await uf.read()
            if len(body) > MAX_QA_FILE_BYTES:
                raise HTTPException(status_code=400, detail="Каждый файл не больше 5 МБ")
            name = f"{uuid.uuid4().hex}{ext}"
            (QA_UPLOAD_DIR / name).write_bytes(body)
            saved.append(name)
        return saved
    except HTTPException:
        _unlink_saved_qa_files(saved)
        raise


class BugPatchBody(BaseModel):
    status: Optional[str] = None
    admin_note: Optional[str] = None

    @field_validator("status")
    @classmethod
    def v_status(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = v.strip()
        if s not in QA_STATUSES:
            raise ValueError(f"status: {', '.join(sorted(QA_STATUSES))}")
        return s


@router.get("/files/{filename}")
async def qa_get_file(
    filename: str,
    current_user: Dict[str, Any] = Depends(require_qa_tracker_access),
) -> FileResponse:
    if not SAFE_QA_FILE.match(filename):
        raise HTTPException(status_code=404, detail="Не найдено")
    path = QA_UPLOAD_DIR / filename
    try:
        path.resolve().relative_to(QA_UPLOAD_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=404, detail="Не найдено") from None
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Не найдено")
    mt, _ = mimetypes.guess_type(filename)
    return FileResponse(path, media_type=mt or "application/octet-stream")


@router.get("/bugs/meta")
async def bugs_meta(
    current_user: Dict[str, Any] = Depends(require_qa_tracker_access),
) -> Dict[str, Any]:
    return {
        "areas": sorted(QA_AREAS),
        "finding_types": sorted(QA_FINDING_TYPES),
        "severities": ["высокая", "средняя", "низкая"],
        "statuses": sorted(QA_STATUSES),
    }


@router.get("/analytics-report")
async def qa_analytics_report_get(
    current_user: Dict[str, Any] = Depends(require_qa_tracker_access),
) -> Dict[str, Any]:
    """
    Сводный отчёт по замечаниям: при первом запросе строится и сохраняется в БД,
    далее отдаётся из кэша до явного обновления (POST .../refresh).
    """
    try:
        return fetch_or_generate_report(current_user)
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"Не удалось построить отчёт (проверьте миграцию qa_analytics_report): {e}",
        ) from e


@router.post("/analytics-report/refresh")
async def qa_analytics_report_refresh(
    current_user: Dict[str, Any] = Depends(require_qa_tracker_access),
) -> Dict[str, Any]:
    try:
        return refresh_report(current_user)
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"Не удалось обновить отчёт: {e}",
        ) from e


@router.get("/bugs")
async def bugs_list(current_user: Dict[str, Any] = Depends(require_qa_tracker_access)) -> List[Dict[str, Any]]:
    return list_bugs_for_viewer(current_user)


@router.post("/bugs")
async def bugs_create(
    area: str = Form(...),
    finding_type: str = Form(...),
    severity: str = Form(...),
    description: str = Form(...),
    files: List[UploadFile] = File(default_factory=list),
    current_user: Dict[str, Any] = Depends(require_qa_tracker_access),
) -> Dict[str, Any]:
    try:
        area_n = normalize_area(area)
        ft_n = normalize_finding_type(finding_type)
        sev_n = normalize_severity(severity)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    raw_files = _as_upload_file_list(files)
    saved: List[str] = []
    try:
        if raw_files:
            saved = await _save_qa_upload_files(raw_files)
        return create_bug(
            current_user,
            {
                "area": area_n,
                "finding_type": ft_n,
                "severity": sev_n,
                "description": description,
                "attachment_filenames": saved,
            },
        )
    except ValueError as e:
        _unlink_saved_qa_files(saved)
        raise HTTPException(status_code=400, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception:
        _unlink_saved_qa_files(saved)
        raise


@router.patch("/bugs/{bug_id}")
async def bugs_patch(
    bug_id: int,
    body: BugPatchBody,
    current_user: Dict[str, Any] = Depends(require_qa_tracker_access),
) -> Dict[str, Any]:
    if current_user.get("role") not in ("admin", "superuser") and not user_can_access_qa_tracker(current_user):
        raise HTTPException(
            status_code=403,
            detail="Изменять статус могут участники группы «ЛабЛигалТех» или администраторы",
        )
    try:
        updated = update_bug_admin(
            current_user,
            bug_id,
            status=body.status,
            admin_note=body.admin_note,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not updated:
        raise HTTPException(status_code=404, detail="Замечание не найдено или нет доступа")
    return updated


@router.get("/bugs/{bug_id}")
async def bugs_one(
    bug_id: int,
    current_user: Dict[str, Any] = Depends(require_qa_tracker_access),
) -> Dict[str, Any]:
    row = get_bug_for_viewer(current_user, bug_id)
    if not row:
        raise HTTPException(status_code=404, detail="Не найдено")
    return row


@router.delete("/bugs/{bug_id}")
async def bugs_delete(
    bug_id: int,
    current_user: Dict[str, Any] = Depends(require_qa_tracker_access),
) -> Dict[str, bool]:
    if not delete_bug_for_viewer(current_user, bug_id):
        raise HTTPException(status_code=404, detail="Не найдено или нет доступа")
    return {"ok": True}
