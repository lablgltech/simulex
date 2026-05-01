"""Этап 1: заглушки оценок и ответов без внешних моделей."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

PATIENCE_MAX = 100
PATIENCE_DROP_CLARIFY = 12
PATIENCE_DROP_OFF_TOPIC_BASE = 25


def _calc_new_patience(current: int, quality_hint: str, off_topic_count: int = 0) -> int:
    if quality_hint == "clarify":
        return max(0, current - PATIENCE_DROP_CLARIFY)
    if quality_hint == "off_topic":
        drop = PATIENCE_DROP_OFF_TOPIC_BASE * (2 ** min(off_topic_count, 2))
        return max(0, current - drop)
    if quality_hint == "document":
        return current
    return current


def _contains_sexual_harassment(text: str) -> bool:
    s = (text or "").lower().strip()
    if not s:
        return False
    patterns = [
        r"\bдавай\s+займ[её]мся\s+секс",
        r"\bзаня(ть|ться)\s+секс",
        r"\bхочу\s+тебя\b",
        r"\bпересп(ать|им)\b",
        r"\bзасос[её]мся\b",
        r"\bсос[её]мся\b",
        r"\bв\s+губ[ыыу]\b",
        r"\bдавай\s+в\s+губ[ыыу]\b",
        r"\bинтим\b",
        r"\bэротик",
        r"\bпостел",
        r"\bпоцелу",
        r"\bраздень",
        r"\bсексуал",
        r"\bсекс\b",
    ]
    return any(re.search(p, s) for p in patterns)


def _contains_profanity(text: str) -> bool:
    import re as _re

    _CYR = r"[а-яёa-z]"

    def word_match(pattern: str) -> bool:
        return bool(
            _re.search(r"(?<!" + _CYR + r")" + _re.escape(pattern) + r"(?!" + _CYR + r")", text.lower())
        )

    whole_word_patterns = [
        "дурак", "дура", "идиот", "тупой", "тупая", "тупица", "дебил", "кретин",
        "придурок", "урод", "уродка", "мудак", "мудила", "козел", "козёл", "козлина",
        "сука", "сучка",
        "блядь", "блять", "бля",
        "хуй", "хуйн", "хуев", "хуе", "хуё",
        "пизд",
        "ёба", "ёбл", "ёбан", "ёбу",
        "еба", "ебл", "ебан", "ебу",
        "нахуй", "нахер",
        "отвали", "заткнись",
        "чмо", "лох", "лошара", "говно", "дерьмо", "срань", "жопа", "засранец", "говнюк",
        "fuck", "shit", "bitch", "asshole", "bastard", "idiot", "stupid", "moron",
        "dick", "cock", "pussy", "cunt",
    ]
    return any(word_match(p) for p in whole_word_patterns)


def expertise_x_delta_from_ratio(x_ratio: float) -> int:
    try:
        r = float(x_ratio)
    except (TypeError, ValueError):
        r = 0.0
    r = max(0.0, min(1.0, r))
    if r < 0.25:
        return -5
    if r < 0.45:
        return -2
    if r < 0.60:
        return 0
    if r < 0.80:
        return 3
    return 6


def legitimacy_coverage_from_overall(overall_coverage: float) -> int:
    try:
        oc = float(overall_coverage)
    except (TypeError, ValueError):
        oc = 0.0
    oc = max(0.0, min(1.0, oc))
    if oc <= 0:
        return -10
    if oc < 0.3:
        return -5
    if oc < 0.5:
        return 0
    if oc < 0.7:
        return 3
    if oc < 0.9:
        return 6
    return 10


def evaluate_insights_coverage(
    insights_by_attribute: Dict[str, List[str]],
    attributes_config: List[Dict[str, Any]],
    requested_document_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    _ = requested_document_ids
    tc = sum(
        len([t for t in (insights_by_attribute.get(str(a.get("id") or ""), []) or []) if isinstance(t, str) and t.strip()])
        for a in (attributes_config or [])
    )
    return {"attr_coverage": {}, "overall_coverage": 0.0, "correct_count": 0, "total_classified": tc}


def evaluate_conclusion_legitimacy_points(
    conclusion_text: Optional[str],
    attributes_config: List[Dict[str, Any]],
) -> int:
    _ = (conclusion_text, attributes_config)
    return 0


def evaluate_insight_quality(
    insight_text: str,
    attribute_id: Optional[str] = None,
    attribute_title: Optional[str] = None,
    reference_insights: Optional[List[str]] = None,
    document_snippet: Optional[str] = None,
    case_id: Optional[str] = None,
    requested_document_ids: Optional[List[str]] = None,
    all_attributes: Optional[List[Dict[str, Any]]] = None,
    existing_insights_by_attribute: Optional[Dict[str, List[str]]] = None,
) -> Dict[str, Any]:
    _ = (
        insight_text,
        attribute_id,
        attribute_title,
        reference_insights,
        document_snippet,
        case_id,
        requested_document_ids,
        all_attributes,
        existing_insights_by_attribute,
    )
    return {
        "score": 50.0,
        "feedback": "",
        "suggestion": None,
        "guiding_questions": [],
        "misclassified": False,
        "pending_documents": [],
        "noise_note": None,
    }


def evaluate_question_quality(
    question_text: str,
    attribute_id: Optional[str] = None,
    attribute_title: Optional[str] = None,
    reference_insights: Optional[List[str]] = None,
) -> Dict[str, Any]:
    _ = (attribute_id, attribute_title, reference_insights)
    return {"score": 50.0, "feedback": "" if (question_text or "").strip() else "Пустой вопрос."}


def answer_question(
    question_text: str,
    attribute_id: Optional[str] = None,
    attribute_title: Optional[str] = None,
    reference_insights: Optional[List[str]] = None,
    documents_context: Optional[List[Dict[str, str]]] = None,
    case_context: Optional[Dict[str, Any]] = None,
    case_id: Optional[str] = None,
    chat_history: Optional[List[Dict[str, str]]] = None,
    current_patience: Optional[int] = None,
    off_topic_count: Optional[int] = None,
    stage1_requested_documents: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    _ = (
        attribute_id,
        attribute_title,
        reference_insights,
        documents_context,
        case_context,
        case_id,
        chat_history,
        stage1_requested_documents,
    )
    patience_in = PATIENCE_MAX if current_patience is None else int(current_patience)
    _off = int(off_topic_count) if off_topic_count is not None else 0
    if _contains_profanity(question_text):
        return {
            "answer_text": "Всё, разговор окончен. Я не намерен терпеть подобное общение.",
            "quality_hint": "clarify",
            "patience": 0,
            "chat_blocked": True,
        }
    if _contains_sexual_harassment(question_text):
        return {
            "answer_text": "Это недопустимо. Разговор окончен.",
            "quality_hint": "clarify",
            "patience": 0,
            "chat_blocked": True,
        }
    return {
        "answer_text": "Ответ по сценарию временно недоступен.",
        "quality_hint": "clarify",
        "patience": _calc_new_patience(patience_in, "clarify", _off),
    }
