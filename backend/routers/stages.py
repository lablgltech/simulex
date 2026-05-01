"""Роутер для работы с этапами"""
import logging

from fastapi import APIRouter, HTTPException, Depends
from typing import Any, Dict

from api_errors import client_500_detail_from_exception
from config import DATA_DIR

logger = logging.getLogger(__name__)
from models.schemas import (
    StageCompleteRequest,
    StageRestartRequest,
    Stage2ValidateRequest,
    Stage2JustificationRequest,
)
from routers.auth import get_current_user
from services.game_session_service import save_game_session
from services.session_context import log_session_action
from services.qa_bug_service import user_can_restart_simulator_stage
from services.stage_restart_service import execute_stage_restart_persist
from services.stage_service import complete_stage
from services.case_service import get_case
from utils.file_loader import load_stage_markdown
from stages.stage_factory import create_stage

router = APIRouter(prefix="/api", tags=["stages"])

@router.post("/stage/complete")
async def complete_stage_endpoint(
    request: StageCompleteRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Завершить этап"""
    try:
        stage_id = request.stage_id
        session = request.session
        final_session, crisis_injects, next_stage_email_merge = complete_stage(
            DATA_DIR, stage_id, session
        )
        uid = int(current_user["id"])
        save_game_session(final_session, user_id=uid)
        return {
            "message": "Этап завершен",
            "session": final_session,
            "crisis_injects": crisis_injects,
            "next_stage_email_merge": next_stage_email_merge,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"❌ Ошибка при завершении этапа: {e}")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/stage/restart")
async def restart_stage_endpoint(
    request: StageRestartRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Сбросить прогресс текущего этапа (действия и состояние этапа в сессии; этап 3 — ещё и переговоры в БД)."""
    if not user_can_restart_simulator_stage(current_user):
        if current_user is None:
            raise HTTPException(
                status_code=401,
                detail="Сессия истекла или запрос без авторизации. Выйдите и войдите снова, затем нажмите «Сброс этапа».",
            )
        raise HTTPException(
            status_code=403,
            detail="Сброс этапа доступен администраторам, суперпользователям и участникам группы ЛабЛигалТех",
        )
    try:
        uid = int(current_user["id"])
        updated = execute_stage_restart_persist(DATA_DIR, dict(request.session), uid)
        return {"message": "Этап сброшен", "session": updated}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))
    except Exception as e:
        print(f"❌ Ошибка при сбросе этапа: {e}")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/stage/markdown")
async def get_stage_markdown(case_id: str, stage_id: str):
    """
    Получить Markdown контент для этапа
    
    Args:
        case_id: ID кейса (например, "case-001" или "001")
        stage_id: ID этапа (например, "stage-1")
    
    Returns:
        Markdown контент этапа
    """
    try:
        md_content = load_stage_markdown(DATA_DIR, case_id, stage_id)
        if md_content is None:
            raise HTTPException(status_code=404, detail=f"MD файл не найден для {case_id}/{stage_id}")
        return {"content": md_content, "case_id": case_id, "stage_id": stage_id}
    except Exception as e:
        print(f"❌ Ошибка при загрузке MD для {case_id}/{stage_id}: {e}")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/stage/data")
async def get_stage_data_endpoint(case_id: str, stage_id: str):
    """Получить данные этапа, включая custom_data (для этапа 2: контракт, матрица рисков и т.д.)."""
    try:
        case_data = get_case(DATA_DIR, case_id)
        stages = case_data.get("stages", [])
        stage_config = next((s for s in stages if s.get("id") == stage_id), None)
        if not stage_config:
            raise HTTPException(status_code=404, detail=f"Этап {stage_id} не найден")
        order = stage_config.get("order") or stage_config.get("order_index") or int(stage_id.replace("stage-", "") or "1")
        stage_instance = create_stage(stage_id, order, case_data)
        data = stage_instance.get_stage_data()
        if hasattr(stage_instance, "get_custom_data"):
            data["custom_data"] = stage_instance.get_custom_data()
        return data
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Ошибка при загрузке данных этапа: {e}")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/stage/2/validate")
async def validate_stage2_risks(
    request: Stage2ValidateRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Валидация классификации рисков этапа 2. Возвращает обновлённую сессию и отчёт."""
    try:
        session = request.session
        clause_risks = request.clause_risks or {}
        clause_tags = getattr(request, "clause_tags", None) or {}
        missing_conditions = getattr(request, "missing_conditions", None) or []
        stage2_seconds_elapsed = getattr(request, "stage2_seconds_elapsed", None)
        case_id = session.get("case_id", "").replace("case-", "") if session.get("case_id") else None
        if not case_id:
            raise HTTPException(status_code=400, detail="case_id не найден в сессии")
        case_data = get_case(DATA_DIR, case_id)
        stage_config = next((s for s in case_data.get("stages", []) if s.get("id") == "stage-2"), None)
        if not stage_config:
            raise HTTPException(status_code=404, detail="Этап stage-2 не найден")
        order = stage_config.get("order") or stage_config.get("order_index") or 2
        stage_instance = create_stage("stage-2", order, case_data)
        if not hasattr(stage_instance, "validate_risks_and_report"):
            raise HTTPException(status_code=400, detail="Этап 2 не поддерживает валидацию рисков")
        updated_session, report = stage_instance.validate_risks_and_report(
            session, clause_risks, clause_tags, missing_conditions, stage2_seconds_elapsed=stage2_seconds_elapsed
        )
        uid = int(current_user["id"])
        save_game_session(updated_session, user_id=uid)
        summ = (report or {}).get("summary") or {}
        log_session_action(
            updated_session.get("id"),
            case_code=updated_session.get("case_id"),
            stage_code="stage-2",
            action_type="stage2_validate",
            payload={
                "found_risks": summ.get("found_risks"),
                "total_risks": summ.get("total_risks"),
                "missed_risks": summ.get("missed_risks"),
                "false_positives": summ.get("false_positives"),
                "total_score": summ.get("total_score"),
            },
        )
        return {"session": updated_session, "report": report}
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Ошибка при валидации этапа 2: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/stage/2/justification")
async def submit_stage2_justification(
    request: Stage2JustificationRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Обоснование по случайному пункту: +20 к C, если по этому пункту все типы верны и все обоснования отмечены."""
    try:
        session = request.session
        clause_id = request.clause_id or ""
        selected_reasons = getattr(request, "selected_reasons", None) or []
        case_id = session.get("case_id", "").replace("case-", "").strip() if session.get("case_id") else None
        if not case_id:
            raise HTTPException(status_code=400, detail="case_id не найден в сессии")
        case_data = get_case(DATA_DIR, case_id)
        stage_config = next((s for s in case_data.get("stages", []) if s.get("id") == "stage-2"), None)
        if not stage_config:
            raise HTTPException(status_code=404, detail="Этап stage-2 не найден")
        order = stage_config.get("order") or stage_config.get("order_index") or 2
        stage_instance = create_stage("stage-2", order, case_data)
        if not hasattr(stage_instance, "submit_justification"):
            raise HTTPException(status_code=400, detail="Этап 2 не поддерживает отправку обоснования")
        updated_session = stage_instance.submit_justification(session, clause_id, selected_reasons)
        uid = int(current_user["id"])
        save_game_session(updated_session, user_id=uid)
        return {"session": updated_session}
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Ошибка при отправке обоснования этапа 2: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))
