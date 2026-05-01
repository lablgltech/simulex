"""Вызов QuestionnaireAgent (LLM) для следующего пакета вопросов."""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from langchain_core.messages import HumanMessage, SystemMessage

from services.case_generation.json_utils import (
    assistant_plain_text_for_json,
    describe_assistant_message_for_log,
    extract_json_for_questionnaire,
)
from services.case_generation.model_client import get_questionnaire_llm
from services.case_generation.questionnaire_models import QuestionnaireResponseModel
from services.case_generation.prompts import QUESTIONNAIRE_SYSTEM
from services.case_generation.session_store import (
    MAX_QUESTIONS_PER_ROUND,
    MAX_QUESTIONNAIRE_ROUNDS,
    CaseGenSession,
)
from services.case_generation.template_slice import load_structural_template, structural_summary_for_prompt

logger = logging.getLogger(__name__)

_MAX_DOC_CHARS = 14000

_SKIP_PROMPT_GUESS_KEYS = frozenset(
    {
        "id",
        "key",
        "question_id",
        "choice_mode",
        "value",
        "help",
        "free_text_prompt",
        "free_text_required",
        "selection_required",
        "options",
        "choices",
        "variants",
        "answers",
    }
)


def _guess_prompt_from_question_dict(d: Dict[str, Any]) -> Optional[str]:
    """Если модель дала чужие ключи — берём самую длинную осмысленную строку в объекте вопроса."""
    best = ""
    for k, v in d.items():
        if k in _SKIP_PROMPT_GUESS_KEYS:
            continue
        if isinstance(v, str):
            s = v.strip()
            if len(s) >= 12 and len(s) > len(best):
                best = s
    return best or None


def _diagnostics_enabled() -> bool:
    return os.getenv("CASE_GEN_DIAGNOSTICS", "").strip().lower() in ("1", "true", "yes")


def _structured_enabled() -> bool:
    """По умолчанию вкл.: анкета через Pydantic / tool calling."""
    v = os.getenv("CASE_GEN_QUESTIONNAIRE_STRUCTURED", "1").strip().lower()
    return v not in ("0", "false", "no")


def _structured_output_methods() -> List[str]:
    """Порядок попыток LangChain with_structured_output."""
                                                                                                            
    primary = (os.getenv("CASE_GEN_QUESTIONNAIRE_STRUCTURED_METHOD") or "function_calling").strip().lower()
    allowed = ("function_calling", "json_schema", "json_mode")
    order: List[str] = []
    if primary in allowed:
        order.append(primary)
    for m in allowed:
        if m not in order:
            order.append(m)
    return order


def _invoke_questionnaire_llm(llm: Any, messages: list) -> Any:
    """Опционально json_object (OpenRouter/модели часто ломаются — по умолчанию выкл.)."""
    use_rf = os.getenv("CASE_GEN_QUESTIONNAIRE_JSON_MODE", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if use_rf:
        try:
            return llm.bind(response_format={"type": "json_object"}).invoke(messages)
        except Exception as e:
            logger.warning(
                "questionnaire: response_format json_object недоступен (%s), вызов без режима JSON",
                e,
            )
    return llm.invoke(messages)


def _invoke_questionnaire_llm_smart(
    llm: Any, messages: list
) -> Tuple[str, Any, str]:
    """
    Возвращает (mode, payload, meta).
    mode: structured | chat
    payload: QuestionnaireResponseModel или сырой ответ invoke (AIMessage)
    meta: краткая метка для логов
    """
    if _structured_enabled():
        for method in _structured_output_methods():
            try:
                structured_llm = llm.with_structured_output(
                    QuestionnaireResponseModel,
                    method=method,                          
                )
                out = structured_llm.invoke(messages)
                if isinstance(out, QuestionnaireResponseModel):
                    return "structured", out, f"structured_{method}"
                if isinstance(out, dict):
                    try:
                        m = QuestionnaireResponseModel.model_validate(out)
                        return "structured", m, f"structured_{method}_dict"
                    except Exception:
                        pass
                logger.debug(
                    "questionnaire: structured method=%s вернул тип %s, пробуем следующий",
                    method,
                    type(out).__name__,
                )
            except Exception as e:
                logger.warning(
                    "questionnaire: with_structured_output method=%s не удался (%s), следующий метод или чат",
                    method,
                    e,
                )
                continue
        logger.warning(
            "questionnaire: все методы structured_output исчерпаны — fallback на обычный чат (парсинг JSON)"
        )
    msg = _invoke_questionnaire_llm(llm, messages)
    return "chat", msg, "chat"


def _questionnaire_model_to_payload(m: QuestionnaireResponseModel) -> Dict[str, Any]:
    questions: List[Dict[str, Any]] = []
    for idx, it in enumerate(m.questions):
        prompt = (it.prompt or it.question or it.text or it.title or "").strip()
        if not prompt:
            continue
        opts = []
        for o in it.options:
            if o.value or o.label:
                opts.append({"value": str(o.value or o.label)[:64], "label": str(o.label or o.value)})
        qid = (it.id or "").strip() or f"q_auto_{idx}"
        questions.append(
            {
                "id": qid[:128],
                "prompt": prompt,
                "choice_mode": it.choice_mode or "single",
                "options": opts,
                "free_text_prompt": it.free_text_prompt or "Дополнительные уточнения",
                "free_text_required": bool(it.free_text_required),
                "selection_required": it.selection_required if it.selection_required is not None else True,
                "help": it.help,
            }
        )
    return {
        "questionnaire_complete": bool(m.questionnaire_complete),
        "rationale_short": (m.rationale_short or "").strip(),
        "questions": questions,
    }


def _truncate(s: str, n: int) -> str:
    s = s or ""
    if len(s) <= n:
        return s
    return s[:n] + "\n… [обрезано]"


def run_questionnaire_turn(session: CaseGenSession) -> Dict[str, Any]:
    """
    Вызвать LLM, обновить session.current_questions и флаги complete/stuck.
    Возвращает dict для API: questionnaire_complete, questions, warnings, stuck,
    опционально questionnaire_debug и questionnaire_parse_stage.
    """
    warnings: List[str] = []
    questionnaire_debug: Optional[Dict[str, Any]] = None

    if session.questionnaire_round >= MAX_QUESTIONNAIRE_ROUNDS:
        session.status = "questionnaire_stuck"
        session.last_error = "Превышено число раундов анкеты"
        return {
            "questionnaire_complete": False,
            "questions": [],
            "warnings": warnings + [session.last_error],
            "stuck": True,
        }

    try:
        template = load_structural_template(session.template_case_id)
    except Exception as e:
        logger.exception("template load")
        session.status = "failed"
        session.last_error = str(e)
        raise

    struct_summary = structural_summary_for_prompt(template)
    answers_snapshot = dict(session.answers.items())

    user_payload = {
        "round_index": session.questionnaire_round,
        "max_rounds": MAX_QUESTIONNAIRE_ROUNDS,
        "max_questions_per_round": MAX_QUESTIONS_PER_ROUND,
        "structural_summary": struct_summary,
        "contract_excerpt": _truncate(session.contract_template, _MAX_DOC_CHARS),
        "guide_excerpt": _truncate(session.guide, _MAX_DOC_CHARS),
        "guide_excerpt_meaning": (
            "внутренний документ компании стороны игрока: политика/стандарты работы с договорами; "
            "не методичка тренера и не инструкция участнику симулятора"
        ),
        "creator_intent": session.creator_intent,
        "answers_so_far": answers_snapshot,
    }
    user_text = json.dumps(user_payload, ensure_ascii=False, indent=2)
    user_text += f"\n\nВерни не более {MAX_QUESTIONS_PER_ROUND} вопросов в questions."

    llm = get_questionnaire_llm(max_tokens=4096)
    messages = [
        SystemMessage(content=QUESTIONNAIRE_SYSTEM),
        HumanMessage(content=user_text),
    ]

    def _normalize_question_dict(q: Dict[str, Any], fallback_idx: int = 0) -> Optional[Dict[str, Any]]:
        q = dict(q)
        pid = q.get("id") or q.get("question_id") or q.get("key")
        prompt = (
            q.get("prompt")
            or q.get("question")
            or q.get("text")
            or q.get("title")
            or q.get("body")
            or q.get("question_text")
            or q.get("message")
            or q.get("description")
            or q.get("content")
            or q.get("query")
            or q.get("label")
            or _guess_prompt_from_question_dict(q)
        )
        if not prompt or not str(prompt).strip():
            return None
        if not pid or not str(pid).strip():
            pid = f"q_auto_{fallback_idx}"
        q["id"] = str(pid).strip()[:128]
        q["prompt"] = str(prompt).strip()
        q.setdefault("choice_mode", "single")
        opts = q.get("options") or q.get("choices") or q.get("variants") or q.get("answers")
        if not isinstance(opts, list):
            opts = []
        fixed_opts = []
        for o in opts:
            if isinstance(o, str):
                fixed_opts.append({"value": o[:64], "label": o})
            elif isinstance(o, dict) and (o.get("value") is not None or o.get("label")):
                val = o.get("value")
                if val is None:
                    val = str(o.get("label", ""))[:64]
                fixed_opts.append({"value": str(val), "label": str(o.get("label") or val)})
        q["options"] = fixed_opts
        q.setdefault("free_text_prompt", "Дополнительные уточнения")
        q.setdefault("free_text_required", False)
        q.setdefault("selection_required", True)
        if len(q["options"]) == 0:
            q["options"] = [
                {"value": "yes", "label": "Да, подходит"},
                {"value": "no", "label": "Нет, нужно иначе"},
            ]
        elif len(q["options"]) == 1:
            q["options"].append({"value": "other", "label": "Другое (опишите в тексте)"})
        return q

    def _build_from_parsed(p: Optional[Dict[str, Any]]) -> tuple[bool, List[Dict[str, Any]]]:
        if not p:
            return False, []
        comp = bool(p.get("questionnaire_complete"))
        qs = p.get("questions") or []
        if not isinstance(qs, list):
            qs = []
        if len(qs) > MAX_QUESTIONS_PER_ROUND:
            qs = qs[:MAX_QUESTIONS_PER_ROUND]
        norm: List[Dict[str, Any]] = []
        for idx, q in enumerate(qs):
            if not isinstance(q, dict):
                continue
            nq = _normalize_question_dict(q, fallback_idx=idx)
            if nq:
                norm.append(nq)
        return comp, norm

    def _run_one_round(
        human_text: str,
        *,
        chat_json_only: bool = False,
    ) -> Tuple[Optional[Dict[str, Any]], bool, List[Dict[str, Any]], str, str, Dict[str, Any]]:
        """parsed, complete, norm_questions, parse_stage, last_raw, msg_desc"""
        msgs = [SystemMessage(content=QUESTIONNAIRE_SYSTEM), HumanMessage(content=human_text)]
        msg_desc: Dict[str, Any]
        if chat_json_only:
            meta = "chat_json_object"
            try:
                msg = llm.bind(response_format={"type": "json_object"}).invoke(msgs)
            except Exception as e:
                logger.warning(
                    "questionnaire: повтор с json_object недоступен (%s), обычный чат",
                    e,
                )
                msg = llm.invoke(msgs)
                meta = "chat_plain_retry"
            msg_desc = {"invoke_meta": meta}
            msg_desc.update(describe_assistant_message_for_log(msg))
            raw = assistant_plain_text_for_json(msg)
            msg_desc["raw_len"] = len(raw or "")
            parsed_out, stage = extract_json_for_questionnaire(raw)
            msg_desc["extract_stage"] = stage
            if parsed_out is None:
                snip = (raw or "").replace("\n", " ")[:400]
                logger.warning(
                    "questionnaire: extract_json_for_questionnaire failed stage=%s meta=%s snippet=%r",
                    stage,
                    msg_desc,
                    snip,
                )
            c, n = _build_from_parsed(parsed_out)
            return parsed_out, c, n, stage, raw or "", msg_desc

        mode, payload, meta = _invoke_questionnaire_llm_smart(llm, msgs)
        msg_desc = {"invoke_meta": meta}
        if mode == "structured" and isinstance(payload, QuestionnaireResponseModel):
            pld = _questionnaire_model_to_payload(payload)
            msg_desc["mode"] = "structured"
            c, n = _build_from_parsed(pld)
            raw_snap = json.dumps(pld, ensure_ascii=False)[:2000]
            return pld, c, n, "from_structured", raw_snap, msg_desc

        msg = payload
        msg_desc.update(describe_assistant_message_for_log(msg))
        raw = assistant_plain_text_for_json(msg)
        msg_desc["raw_len"] = len(raw or "")
        parsed_out, stage = extract_json_for_questionnaire(raw)
        msg_desc["extract_stage"] = stage
        if parsed_out is None:
            snip = (raw or "").replace("\n", " ")[:400]
            logger.warning(
                "questionnaire: extract_json_for_questionnaire failed stage=%s meta=%s snippet=%r",
                stage,
                msg_desc,
                snip,
            )
        c, n = _build_from_parsed(parsed_out)
        return parsed_out, c, n, stage, raw or "", msg_desc

    parsed: Optional[Dict[str, Any]] = None
    complete = False
    norm_questions: List[Dict[str, Any]] = []
    last_parse_stage = ""
    last_raw = ""
    rounds_meta: List[Dict[str, Any]] = []

    p1, c1, n1, st1, raw1, d1 = _run_one_round(user_text)
    rounds_meta.append({"attempt": 1, **d1, "parse_stage": st1})
    parsed, complete, norm_questions = p1, c1, n1
    last_parse_stage, last_raw = st1, raw1

    if (not parsed or not norm_questions) and not complete:
        warnings.append("Повторный запрос: нет валидного JSON или список вопросов пуст.")
        retry_user = (
            user_text
            + "\n\nВАЖНО: предыдущий ответ не разобран или вопросы без id/prompt/двух options. "
            "Верни один JSON-объект (корень — объект, не массив): questionnaire_complete (bool), "
            "rationale_short, questions — "
            f"от 2 до {min(5, MAX_QUESTIONS_PER_ROUND)} вопросов; у каждого id, prompt, choice_mode, "
            "options с минимум 2 элементами {{value, label}}."
        )
        p2, c2, n2, st2, raw2, d2 = _run_one_round(retry_user, chat_json_only=True)
        rounds_meta.append({"attempt": 2, **d2, "parse_stage": st2})
        last_parse_stage, last_raw = st2, raw2
        if p2 is not None:
            parsed, complete, norm_questions = p2, c2, n2
            if n2:
                warnings.append("Второй ответ модели принят.")

    if not parsed:
        snippet = (last_raw or "").replace("\n", " ")[:400]
        logger.warning(
            "questionnaire: финальный провал парсинга stage=%s len=%s snippet=%r",
            last_parse_stage,
            len(last_raw or ""),
            snippet,
        )
        warnings.append("Не удалось разобрать JSON анкеты после повторной попытки")
        session.current_questions = []
        out_fail: Dict[str, Any] = {
            "questionnaire_complete": False,
            "questions": [],
            "warnings": warnings,
            "stuck": False,
            "questionnaire_parse_stage": last_parse_stage or "decode_failed",
        }
        if _diagnostics_enabled():
            out_fail["questionnaire_debug"] = {
                "parse_stage": last_parse_stage,
                "raw_len": len(last_raw or ""),
                "raw_snippet": (last_raw or "")[:800],
                "rounds": rounds_meta,
            }
        return out_fail

    session.current_questions = norm_questions

    if complete:
        session.questionnaire_complete = True
        session.status = "ready_to_generate"
        session.current_questions = []
    elif not norm_questions and not complete:
        warnings.append("Модель вернула пустой список вопросов без complete — нажмите «Сбросить» или повторите позже")

    out: Dict[str, Any] = {
        "questionnaire_complete": session.questionnaire_complete,
        "questions": session.current_questions,
        "warnings": warnings,
        "stuck": False,
        "rationale_short": parsed.get("rationale_short"),
        "questionnaire_parse_stage": last_parse_stage or "ok",
    }
    if _diagnostics_enabled():
        questionnaire_debug = {
            "parse_stage": out["questionnaire_parse_stage"],
            "raw_len": len(last_raw or ""),
            "raw_snippet": (last_raw or "")[:800],
            "rounds": rounds_meta,
        }
        out["questionnaire_debug"] = questionnaire_debug
    return out
