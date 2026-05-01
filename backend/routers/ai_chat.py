"""Роутер ИИ-чата для этапа 3 (упрощённая интеграция).

Используется только для оценки обоснований игрока по пунктам договора.
"""

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api_errors import client_500_detail_from_exception
from routers.auth import get_current_user
from services.ai_chat_service import evaluate_justification_with_ai


router = APIRouter(prefix="/api/ai", tags=["ai"])


class JustificationRequest(BaseModel):
    clause_text: str
    justification: str


@router.post("/evaluate-justification")
async def evaluate_justification(
    req: JustificationRequest, _current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Оценить обоснование игрока по пункту договора с помощью OpenAI.
    """
    try:
        result = evaluate_justification_with_ai(
            clause_text=req.clause_text,
            justification=req.justification,
        )
        return result
    except RuntimeError as e:
        # Ошибки конфигурации / сети — 500
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e

