"""
Роутер для работы с отчетами
"""
import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException

from api_errors import client_500_detail_from_exception
from config import DATA_DIR

logger = logging.getLogger(__name__)
from db import get_connection
from models.schemas import ReportGenerateRequest
from routers.auth import get_current_user
from services.case_service import get_case_titles_by_codes
from services.game_session_service import save_game_session, _session_external_id_for_db
from services.report_service import ensure_case_report_snapshot, generate_report
from services.stage4_bridge_access import user_can_view_stage4_bridge
from services.stage4_bridge_repository import fetch_stage4_bridge

router = APIRouter(prefix="/api", tags=["reports"])


def _normalize_case_code(cc: str) -> str:
    s = str(cc or "").strip()
    if not s:
        return ""
    if not s.startswith("case-"):
        return f"case-{s.replace('case-', '')}"
    return s


def _session_with_frozen_report_from_db(session: Dict[str, Any]) -> Dict[str, Any]:
    """Подмешать из БД зафиксированный ИИ-снимок (report_snapshot), чтобы не дергать LLM повторно."""
    sid = _session_external_id_for_db(session)
    if not sid:
        return session
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT payload_json FROM game_session WHERE external_id = %s",
                    (str(sid),),
                )
                row = cur.fetchone()
    except Exception:
        return session
    if not row or not row[0] or not isinstance(row[0], dict):
        return session
    stored = row[0]
    out = dict(session)
    if stored.get("report_snapshot"):
        out["report_snapshot"] = stored["report_snapshot"]
    # В БД полный payload — при подмешивании снимка отчёта берём нормализацию из БД (клиентский объект часто урезан).
    if stored.get("lexic_normalized"):
        out["lexic_normalized"] = stored["lexic_normalized"]
    return out


def _generate_report_dict(request: ReportGenerateRequest, current_user: Dict[str, Any]) -> Dict[str, Any]:
    session = _session_with_frozen_report_from_db(request.session)
    session_out, cached_report = ensure_case_report_snapshot(DATA_DIR, session)
    uid = int(current_user["id"])
    if cached_report is not None:
        save_game_session(session_out, user_id=uid)
        return cached_report
    return generate_report(DATA_DIR, session_out)


@router.post("/report/generate")
async def generate_report_endpoint(
    request: ReportGenerateRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Сгенерировать отчёт по сессии (требуется JWT)."""
    try:
        return _generate_report_dict(request, current_user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("report/generate failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.get("/report/my-sessions")
async def my_sessions(current_user: Dict[str, Any] = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """
    Список сессий текущего пользователя для личного кабинета (мои отчёты).
    Только завершённые кейсы: current_stage > числа этапов в case_content_json/settings_json кейса.
    Требуется авторизация.
    """
    user_id = current_user["id"]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT gs.external_id, gs.case_code,
                       gs.payload_json->>'current_stage' AS current_stage_txt,
                       gs.payload_json->>'case_id' AS case_id_txt,
                       gs.created_at
                FROM game_session gs
                INNER JOIN "case" c ON c.code = gs.case_code
                WHERE gs.user_id = %s
                  AND gs.case_code IS NOT NULL
                  AND btrim(gs.case_code) <> ''
                  AND COALESCE(
                        CASE WHEN jsonb_typeof(c.case_content_json->'stages') = 'array'
                             THEN jsonb_array_length(c.case_content_json->'stages') END,
                        CASE WHEN jsonb_typeof(c.settings_json->'stages') = 'array'
                             THEN jsonb_array_length(c.settings_json->'stages') END,
                        0
                      ) >= 1
                  AND gs.payload_json->>'current_stage' ~ '^[0-9]+$'
                  AND (gs.payload_json->>'current_stage')::integer > COALESCE(
                        CASE WHEN jsonb_typeof(c.case_content_json->'stages') = 'array'
                             THEN jsonb_array_length(c.case_content_json->'stages') END,
                        CASE WHEN jsonb_typeof(c.settings_json->'stages') = 'array'
                             THEN jsonb_array_length(c.settings_json->'stages') END,
                        0
                      )
                ORDER BY gs.created_at DESC
                LIMIT 100
                """,
                (user_id,),
            )
            rows = cur.fetchall()
    case_codes = [r[1] for r in rows if r[1]]
    title_by_code = get_case_titles_by_codes(DATA_DIR, case_codes)
    result: List[Dict[str, Any]] = []
    for r in rows:
        case_code = r[1]
        raw_title = title_by_code.get(case_code or "", "") if case_code else ""
        cur_st_txt = r[2]
        cur_st: Any = None
        if cur_st_txt is not None and str(cur_st_txt).strip() != "":
            s = str(cur_st_txt).strip()
            cur_st = int(s) if s.isdigit() else cur_st_txt
        cid_raw = r[3]
        cid = str(cid_raw).strip() if cid_raw not in (None, "") else None
        result.append({
            "session_id": r[0],
            "case_code": case_code,
            "case_id": cid,
            "case_title": raw_title or case_code or "Кейс",
            "current_stage": cur_st,
            "created_at": r[4].isoformat() if r[4] else None,
        })
    return result


@router.get("/report/stage4-bridge/{session_external_id}")
async def report_stage4_bridge(
    session_external_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    """
    Данные моста этап 3→4 для отчёта. Доступ: админ / суперюзер или группа «ЛабЛигалТех».
    """
    if not user_can_view_stage4_bridge(current_user):
        raise HTTPException(status_code=403, detail="Недостаточно прав")
    eid = str(session_external_id or "").strip()
    if not eid:
        raise HTTPException(status_code=400, detail="session_external_id обязателен")
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT case_code FROM game_session WHERE external_id = %s LIMIT 1",
                (eid,),
            )
            row = cur.fetchone()
    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    raw_cc = str(row[0]).strip()
    bridge = fetch_stage4_bridge(eid, raw_cc)
    if bridge is None:
        bridge = fetch_stage4_bridge(eid, _normalize_case_code(raw_cc))
    return {
        "session_external_id": eid,
        "case_code": raw_cc,
        "bridge": bridge,
    }
