"""Роутер ИИ-тьютора (Сергей Палыч): чат, история, события."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api_errors import client_500_detail_from_exception
from routers.auth import get_current_user
from services import tutor_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tutor", tags=["tutor"])


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    case_id: Optional[str] = None
    current_stage: Optional[int] = None


class ChatResponse(BaseModel):
    reply: str


class HistoryResponse(BaseModel):
    messages: List[Dict[str, str]]


class EventRequest(BaseModel):
    event_type: str
    payload: Dict[str, Any] = {}
    session_id: Optional[str] = None
    case_id: Optional[str] = None
    current_stage: Optional[int] = None


class EventResponse(BaseModel):
    message: Optional[str] = None


@router.post("/chat", response_model=ChatResponse)
async def tutor_chat(
    req: ChatRequest, _current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Отправить сообщение тьютору и получить ответ. История сохраняется."""
    try:
        reply = tutor_service.chat(
            message=req.message,
            session_id=req.session_id,
            case_id=req.case_id,
            current_stage=req.current_stage,
        )
        return ChatResponse(reply=reply)
    except Exception as e:
        logger.error("Ошибка в tutor_chat: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/history", response_model=HistoryResponse)
async def tutor_history(
    session_id: Optional[str] = None, _user: Dict[str, Any] = Depends(get_current_user)
):
    """Получить историю чата с тьютором для сессии (или до выбора кейса при session_id=null)."""
    messages = tutor_service.get_tutor_history(session_id)
    return HistoryResponse(messages=messages)


@router.post("/event", response_model=EventResponse)
async def tutor_event(
    req: EventRequest, _user: Dict[str, Any] = Depends(get_current_user)
):
    """Уведомить тьютора о событии (например, сообщение в чате этапа). Возвращает опциональную реплику."""
    try:
        message = tutor_service.on_event(
            event_type=req.event_type,
            payload=req.payload,
            session_id=req.session_id,
            case_id=req.case_id,
            current_stage=req.current_stage,
        )
        return EventResponse(message=message)
    except Exception as e:
        logger.error("Ошибка в tutor_event: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))
