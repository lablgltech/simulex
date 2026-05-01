"""Фасад: старт сессии, ответы анкеты, запуск графа генерации."""

from __future__ import annotations

import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from services.case_generation.answer_validation import validate_answers_for_questions
from services.case_generation.document_ingest import extract_plain_text
from services.case_generation.graph import run_generation_graph
from services.case_generation.questionnaire import run_questionnaire_turn
from services.case_generation.questionnaire_profile import build_questionnaire_profile, snapshot_questions_pack
from services.case_generation.session_store import (
    create_session,
    require_session,
)
from services.case_generation.template_slice import load_structural_template

logger = logging.getLogger(__name__)


def _questionnaire_api_extras(qres: Dict[str, Any]) -> Dict[str, Any]:
    extra: Dict[str, Any] = {}
    if qres.get("questionnaire_debug") is not None:
        extra["questionnaire_debug"] = qres["questionnaire_debug"]
    ps = qres.get("questionnaire_parse_stage")
    if ps:
        extra["questionnaire_parse_stage"] = ps
    return extra


def _ingest_field(
    file_bytes: Optional[bytes],
    filename: Optional[str],
    text_fallback: Optional[str],
    field_name: str,
) -> Tuple[str, List[str]]:
    warnings: List[str] = []
    if file_bytes and filename:
        t, w = extract_plain_text(file_bytes, filename)
        warnings.extend(w)
        if not t.strip():
            raise ValueError(f"Пустой текст после извлечения ({field_name})")
        return t, warnings
    text = (text_fallback or "").strip()
    if not text:
        raise ValueError(f"Не задан {field_name}: приложите файл или вставьте текст")
    return text, warnings


def start_case_gen_session(
    *,
    user_id: int,
    template_case_id: str,
    creator_intent: str,
    contract_file: Optional[Tuple[bytes, str]] = None,
    contract_template: Optional[str] = None,
    guide_file: Optional[Tuple[bytes, str]] = None,
    guide: Optional[str] = None,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    intent = (creator_intent or "").strip()
    if not intent:
        raise ValueError("Запрос создателя (creator_intent) обязателен")
    tid = (template_case_id or "").strip()
    if not tid:
        raise ValueError("template_case_id обязателен")

    try:
        load_structural_template(tid)
    except Exception as e:
        raise ValueError(f"Кейс-шаблон не найден: {tid}: {e}") from e

    c_bytes, c_name = (contract_file if contract_file else (None, None))
    g_bytes, g_name = (guide_file if guide_file else (None, None))
    contract_text, w1 = _ingest_field(c_bytes, c_name, contract_template, "договор")
    guide_text, w2 = _ingest_field(g_bytes, g_name, guide, "гайд компании (политика по договорам)")
    ingest_warnings = w1 + w2

    session = create_session(
        user_id=user_id,
        contract_template=contract_text,
        guide=guide_text,
        creator_intent=intent,
        template_case_id=tid,
        ingest_warnings=ingest_warnings,
        options=options or {},
    )

    qres = run_questionnaire_turn(session)
    if qres.get("stuck"):
        pass

    if session.questionnaire_complete:
        session.questionnaire_profile = build_questionnaire_profile(session)

    return {
        "session_id": session.session_id,
        "ingest_warnings": ingest_warnings,
        "status": session.status,
        "questionnaire_complete": session.questionnaire_complete,
        "questions": session.current_questions,
        "round": session.questionnaire_round,
        "warnings": qres.get("warnings") or [],
        "rationale_short": qres.get("rationale_short"),
        "stuck": qres.get("stuck", False),
        **_questionnaire_api_extras(qres),
    }


def submit_case_gen_answers(
    *,
    user_id: int,
    session_id: str,
    answers: Dict[str, Any],
) -> Dict[str, Any]:
    session = require_session(session_id, user_id)
    if session.questionnaire_complete:
        raise ValueError("Анкета уже завершена")
    if session.status == "questionnaire_stuck":
        raise ValueError("Сессия застряла, начните новую")
    if not session.current_questions:
        raise ValueError("Нет активных вопросов для ответа")

    ok, errors, normalized = validate_answers_for_questions(session.current_questions, answers)
    if not ok:
        raise ValueError("validation_failed: " + "; ".join(errors))

    session.questions_history.append(snapshot_questions_pack(session))
    for qid, val in normalized.items():
        session.answers[qid] = val
    session.questionnaire_round += 1

    qres = run_questionnaire_turn(session)

    if session.questionnaire_complete:
        session.questionnaire_profile = build_questionnaire_profile(session)

    return {
        "session_id": session.session_id,
        "questionnaire_complete": session.questionnaire_complete,
        "questions": session.current_questions,
        "round": session.questionnaire_round,
        "warnings": qres.get("warnings") or [],
        "rationale_short": qres.get("rationale_short"),
        "stuck": qres.get("stuck", False),
        "status": session.status,
        **_questionnaire_api_extras(qres),
    }


def run_case_gen_generation(*, user_id: int, session_id: str) -> Dict[str, Any]:
    session = require_session(session_id, user_id)
    if not session.questionnaire_complete:
        raise ValueError("Сначала завершите анкету")
    if session.status not in ("ready_to_generate", "done", "failed"):
        session.status = "ready_to_generate"

    profile = session.questionnaire_profile or build_questionnaire_profile(session)
    session.questionnaire_profile = profile

    try:
        template = load_structural_template(session.template_case_id)
    except Exception as e:
        raise ValueError(str(e)) from e

    struct_copy = copy.deepcopy(template)
    opts = session.options or {}
    max_repairs = int(opts.get("max_repairs", 3))

    initial: Dict[str, Any] = {
        "structural_template": struct_copy,
        "contract_template": session.contract_template,
        "guide": session.guide,
        "creator_intent": session.creator_intent,
        "questionnaire_profile": profile,
        "warnings": list(session.ingest_warnings),
        "trace": [],
        "stage_drafts": {},
        "repair_round": 0,
        "max_repairs": max_repairs,
    }

    session.status = "generating"
    try:
        final = run_generation_graph(initial)
    except Exception as e:
        logger.exception("generation graph")
        session.status = "failed"
        session.last_error = str(e)
        raise

    draft = final.get("merged_case") or {}
    session.status = "done"

    val_errs = final.get("validation_errors") or []
    gen_warnings = list(final.get("warnings") or [])
    if val_errs:
        gen_warnings.append("Остались ошибки валидации: " + "; ".join(val_errs[:10]))

    return {
        "draft": draft,
        "warnings": gen_warnings,
        "ingest_warnings": session.ingest_warnings,
        "trace": final.get("trace") or [],
        "validation_errors": val_errs,
        "questionnaire_profile_summary": profile.get("plain_text", "")[:4000],
    }
