"""Роутер для работы с сессиями"""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from api_errors import client_500_detail_from_exception
from config import DATA_DIR

logger = logging.getLogger(__name__)
from models.schemas import SessionStartRequest, NegotiationSessionStartRequest, StageRestartRequest
from routers.auth import get_current_user
from services.game_session_service import get_game_session_for_user
from services.negotiation_access import user_owns_game_session_external, user_owns_negotiation_session
from services.negotiation_session_service import (
    get_or_create_stage_and_negotiation_session,
    reset_negotiation_contract_to_initial,
)
from services.qa_bug_service import user_can_restart_simulator_stage
from services.session_service import create_session
from services.stage_restart_service import execute_stage_restart_persist
from seed_contracts import seed_contract_for_case

router = APIRouter(prefix="/api", tags=["sessions"])


@router.post("/session/negotiation/start")
async def start_negotiation_session(
    request: NegotiationSessionStartRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Запустить (или получить существующую) сессию переговоров для этапа 3.

    Ожидает на входе текущую simulex-сессию (session JSON) и, опционально, contract_code.
    Возвращает идентификаторы stage_session и negotiation_session.
    """
    try:
        simulex_session = request.session
        simulex_session_id = str(simulex_session.get("id"))
        case_code = str(simulex_session.get("case_id"))
        if not simulex_session_id or not case_code:
            raise HTTPException(
                status_code=400,
                detail="В session должны быть заполнены поля 'id' и 'case_id'",
            )
        if not user_owns_game_session_external(
            simulex_session_id, int(current_user["id"])
        ):
            raise HTTPException(status_code=404, detail="Сессия не найдена")

        contract_code = request.contract_code or "dogovor_PO"
        try:
            stage_session_id, negotiation_session_id = get_or_create_stage_and_negotiation_session(
                simulex_session_id=simulex_session_id,
                case_code=case_code,
                contract_code=contract_code,
            )
        except RuntimeError as e:
            if "не найден в таблице contract" in str(e) or "contract" in str(e).lower():
                try:
                    seed_contract_for_case(case_code)
                except Exception as seed_err:
                    logger.exception("seed_contract_for_case failed: %s", seed_err)
                    raise HTTPException(
                        status_code=500,
                        detail=client_500_detail_from_exception(seed_err),
                    ) from e
                stage_session_id, negotiation_session_id = get_or_create_stage_and_negotiation_session(
                    simulex_session_id=simulex_session_id,
                    case_code=case_code,
                    contract_code=contract_code,
                )
            else:
                logger.exception("negotiation start RuntimeError")
                raise HTTPException(
                    status_code=500, detail=client_500_detail_from_exception(e)
                ) from e

        if request.reset_contract_to_initial:
            reset_negotiation_contract_to_initial(negotiation_session_id)

        return {
            "stage_session_id": stage_session_id,
            "negotiation_session_id": negotiation_session_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("POST /session/negotiation/start failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.post("/session/negotiation/{negotiation_session_id}/reset-progress")
async def reset_negotiation_progress_session_route(
    negotiation_session_id: int, current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Сброс подстановок в договоре, статусов пунктов и истории чата (этап 3).
    Дублирует POST /api/chat/session/{id}/reset-progress, но живёт в общем роутере /api/session —
    чтобы кнопка «Перезапустить этап» работала, даже если клиент или прокси не видит /api/chat.
    """
    try:
        if not user_owns_negotiation_session(
            negotiation_session_id, int(current_user["id"])
        ):
            raise HTTPException(status_code=404, detail="Сессия не найдена")
        reset_negotiation_contract_to_initial(negotiation_session_id)
        return {"ok": True}
    except Exception as e:
        logger.exception("reset_negotiation_progress failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.post("/session/restart-stage")
async def restart_game_stage_alias(
    request: StageRestartRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Алиас сброса текущего этапа — то же, что POST /api/stage/restart.
    Нужен, если фронт или прокси отдаёт 404 на /api/stage/restart (как для reset-progress переговоров).
    """
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
        logger.exception("restart-stage RuntimeError")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e
    except Exception as e:
        logger.exception("restart-stage failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.post("/session/start")
async def start_session(
    request: SessionStartRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Запустить сессию (инициализация). Сессия привязывается к текущему пользователю (JWT)."""
    user_id = int(current_user["id"])
    try:
        return create_session(DATA_DIR, request.case_id, request.start_stage, user_id=user_id)
    except Exception as e:
        logger.exception("POST /session/start failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.get("/session/{session_id}")
async def get_session(
    session_id: str,
    current_user=Depends(get_current_user),
):
    """
    Получить сессию по ID для текущего пользователя (для «Мои отчёты»). Требуется авторизация.
    """
    session = get_game_session_for_user(session_id, current_user["id"])
    if not session:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    return session

