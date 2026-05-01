"""Роутер документа для этапа 3 (переговоры).

Внешний контракт максимально близок к прототипу v0.5beta:
- GET /api/document/session/{negotiation_session_id}/clauses
"""

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from api_errors import client_500_detail_from_exception
from routers.auth import get_current_user
from services.document_service import get_contract_clauses_for_session
from services.negotiation_access import user_owns_negotiation_session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/document", tags=["document"])


@router.get("/session/{negotiation_session_id}/clauses")
async def get_clauses_endpoint(
    negotiation_session_id: int, current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Получить список пунктов договора для сессии переговоров.
    """
    try:
        if not user_owns_negotiation_session(
            negotiation_session_id, int(current_user["id"])
        ):
            raise HTTPException(status_code=404, detail="Сессия не найдена")
        return get_contract_clauses_for_session(negotiation_session_id)
    except RuntimeError as e:
        logger.exception("document/clauses RuntimeError: %s", e)
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))
    except Exception as e:
        logger.exception("document/clauses error: %s", e)
        raise HTTPException(
            status_code=500,
            detail=client_500_detail_from_exception(e),
        )

