"""Роутер ИИ для этапа 1: оценка заметок брифа, оценка вопросов, ответы на вопросы."""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api_errors import client_500_detail_from_exception
from routers.auth import get_current_user
from services import stage1_context_chat as stage1_context


router = APIRouter(prefix="/api/stage1", tags=["stage1-ai"])


class InsightEvaluateRequest(BaseModel):
    insight_text: str
    attribute_id: Optional[str] = None
    attribute_title: Optional[str] = None
    reference_insights: Optional[List[str]] = None
    document_snippet: Optional[str] = None
    case_id: Optional[str] = None
    requested_document_ids: Optional[List[str]] = None
    # Контекст брифа: все блоки с эталонами и уже собранные заметки по блокам
    all_attributes: Optional[List[Dict[str, Any]]] = None
    existing_insights_by_attribute: Optional[Dict[str, List[str]]] = None


class QuestionEvaluateRequest(BaseModel):
    question_text: str
    attribute_id: Optional[str] = None
    attribute_title: Optional[str] = None
    reference_insights: Optional[List[str]] = None


class DocumentContextItem(BaseModel):
    doc_id: Optional[str] = None
    content_snippet: Optional[str] = None
    content: Optional[str] = None


class ChatHistoryItem(BaseModel):
    attribute_id: Optional[str] = None
    question: Optional[str] = None
    bot_response: Optional[str] = None


class QuestionAnswerRequest(BaseModel):
    question_text: str
    attribute_id: Optional[str] = None
    attribute_title: Optional[str] = None
    reference_insights: Optional[List[str]] = None
    documents_context: Optional[List[DocumentContextItem]] = None
    case_context: Optional[Dict[str, Any]] = None
    case_id: Optional[str] = None  # id кейса (case-001, case-stage-1 и т.д.) — от него грузятся промпт и база знаний
    chat_history: Optional[List[ChatHistoryItem]] = None
    current_patience: Optional[int] = None  # текущее терпение (0–100), None = первый вопрос
    off_topic_count: Optional[int] = None  # сколько уже было ответов с quality_hint=off_topic (для нарастающего списания)
    stage1_requested_documents: Optional[List[Dict[str, Any]]] = None  # уже полученные по запросу документы [{ id, title, content }]


@router.post("/insight/evaluate")
async def evaluate_insight(
    req: InsightEvaluateRequest, _u: Dict[str, Any] = Depends(get_current_user)
):
    """Оценить качество заметки для брифа (текст с карты сделки или из ответа инициатора)."""
    try:
        result = stage1_context.evaluate_insight_quality(
            insight_text=req.insight_text,
            attribute_id=req.attribute_id,
            attribute_title=req.attribute_title,
            reference_insights=req.reference_insights,
            document_snippet=req.document_snippet,
            case_id=req.case_id,
            requested_document_ids=req.requested_document_ids,
            all_attributes=req.all_attributes,
            existing_insights_by_attribute=req.existing_insights_by_attribute,
        )
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.post("/question/evaluate")
async def evaluate_question(
    req: QuestionEvaluateRequest, _u: Dict[str, Any] = Depends(get_current_user)
):
    """Оценить качество вопроса инициатору по выбранному блоку брифа."""
    try:
        result = stage1_context.evaluate_question_quality(
            question_text=req.question_text,
            attribute_id=req.attribute_id,
            attribute_title=req.attribute_title,
            reference_insights=req.reference_insights,
        )
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.post("/question/answer")
async def answer_question(
    req: QuestionAnswerRequest, _u: Dict[str, Any] = Depends(get_current_user)
):
    """Сгенерировать ответ инициатора на вопрос игрока."""
    try:
        docs_ctx = None
        if req.documents_context:
            docs_ctx = [
                {
                    "doc_id": item.doc_id,
                    "content_snippet": item.content_snippet or item.content,
                    "content": item.content or item.content_snippet,
                }
                for item in req.documents_context
            ]
        result = stage1_context.answer_question(
            question_text=req.question_text,
            attribute_id=req.attribute_id,
            attribute_title=req.attribute_title,
            reference_insights=req.reference_insights,
            documents_context=docs_ctx,
            case_context=req.case_context,
            case_id=req.case_id,
            chat_history=[h.dict() for h in req.chat_history] if req.chat_history else None,
            current_patience=req.current_patience,
            off_topic_count=req.off_topic_count,
            stage1_requested_documents=req.stage1_requested_documents,
        )
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e
