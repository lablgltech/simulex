"""
Полная логика бота для переговоров этапа 3.

Simple-режим (NEGOTIATION_ALLOW_SIMPLE_MODE + mode simple в истории): ответы через get_bot_response.
В ИИ-режиме переговоры по пункту обрабатывает chat_service → negotiation_v2_runtime (v2).

Отвечает за:
- выбор формулировок и статусов ("простой" режим бота);
- поведение в ИИ-режиме: возражения, оценка оправданий, решение о согласии.

Логика согласована с ai_negotiation_system_prompt.md, ai_case_PO_counterparty_prompt.md (роль LLM) и ai_case_PO_scoring_rubric.md (рубрика/post_llm):

ШКАЛА ОЦЕНКИ (внутренняя, 0-10 баллов, нормализованная в 0-100):
- 8–10 баллов (score >= 80): отличная позиция → согласие ИИ
- 4–7 баллов (40 <= score < 80): допустимо → переговоры продолжаются
- 0–3 балла (score < 40): ошибка → ИИ может завершить диалог в пользу контрагента

СТАТУСЫ ПУНКТА:
- Status 0 (SELECTED): правка на согласовании
- Status 1 (ACCEPTED_BOT): оставлено без изменений (поражение игрока)
- Status 2 (CHANGED): согласовано с правками (победа игрока)
- Status 3 (NOT_AGREED_ESCALATION): не согласовано, требуется эскалация

ОГРАНИЧЕНИЯ:
- Не более 4 реплик ИИ по пункту (MAX_AI_OBJECTIONS)
- State B: первая реплика оценивается по эталону; при полной позиции (редакция + содержательное пояснение),
  оба близки к эталону по кейсу, — согласие и успешное завершение переговоров для игрока (в т.ч. без лишнего раунда возражений).
- State C: каждая следующая реплика оценивается ИИ (без случайности)

ПРАВИЛО ДЛЯ ВСЕХ ПУНКТОВ (action=change):
ИИ соглашается только при наличии ОБОИХ: (1) редакция пункта, близкая к эталону, (2) пояснение.
Если чего-то нет — ИИ просит недостающее и не закрывает переговоры.
Исключение: согласие игрока с предложением контрагента («устраивает», «согласен») — принимаем без доп. пояснения.

Вызовы OpenAI вынесены в `services.ai_chat_service`.
"""

from __future__ import annotations

import difflib
import re
import time
from typing import Dict, Any, Tuple

from services.document_service import ClauseStatus
from services.ai_counterpart_rules import (
    strip_explanation_tail_from_contract_formulation,
    strip_revision_meta_from_clause_draft,
)

                                                                                                          
                                             
                                                           
                                                
                                                                             
THRESHOLD_AGREEMENT = 80.0                                 
THRESHOLD_ERROR = 40.0                                                                   
MAX_AI_OBJECTIONS = 4                                        

                                                                                                
NEGOTIATION_CHANGE_INTENT_MARKERS = (
    "поменяем",
    "поменять",
    "изменим",
    "изменить",
    "меняем пункт",
    "менять пункт",
    "поменяем пункт",
    "сменим",
    "переформулиру",
    "другую редакцию",
    "новую редакцию",
    "новая редакция",
    "другая редакция",
    "отредактиру",
    "внести правки",
    "внести изменения",
    "внесем изменения",
    "внесём изменения",
    "давайте внесем",
    "давайте внесём",
    "нужна правка",
    "не устраивает",
)


def player_seeks_clause_revision(text: str | None) -> bool:
    """True, если по тексту видно, что игрок хочет правку пункта, а не оставить текст контрагента."""
    if not text or not str(text).strip():
        return False
    low = str(text).strip().lower()
    return any(m in low for m in NEGOTIATION_CHANGE_INTENT_MARKERS)


from services.ai_chat_service import (
    generate_lawyer_name_and_company,
    generate_objection_with_ai,
    generate_acceptance_message_with_ai,
    evaluate_justification_convincing,
    evaluate_first_proposal,
)
from services.ai_counterpart_rules import pick_request_explanation_only_fallback
from services.negotiation_models import (
    PlayerOffer,
    OfferEvaluation,
    ClauseOutcome,
    OutcomeType,
    DecisionReason,
    normalize_player_offer,
    evaluate_offer_deterministically,
    determine_clause_outcome,
)

                                                                                    
_similarity_service = None

def _get_similarity_service():
    """Ленивая загрузка сервиса cosine similarity."""
    global _similarity_service
    if _similarity_service is None:
        try:
            from services import similarity_service
            _similarity_service = similarity_service
        except ImportError:
            _similarity_service = False                                 
    return _similarity_service if _similarity_service else None


def _compute_bot_preferred_text(clause_data: dict) -> str:
    """Определяем формулировку, которую предпочитает бот.
    Приоритет: botSuggested → replacementText → optimalSolution / ideal_option → changeOptions.
    Поддержка нового формата: ideal_option, ideal_options, correct_example.
    """
    for key in ("botSuggested", "botSuggestedText"):
        if clause_data.get(key):
            return clause_data.get(key)
    for key in ("replacementText", "replacement"):
        if clause_data.get(key):
            return clause_data.get(key)
    if clause_data.get("optimalSolution"):
        return clause_data.get("optimalSolution")
    if clause_data.get("ideal_option"):
        return clause_data.get("ideal_option")
    opts = clause_data.get("ideal_options") or []
    if isinstance(opts, list) and opts:
        first = opts[0]
        return first.get("text", first) if isinstance(first, dict) else first
    opts = clause_data.get("changeOptions") or []
    if isinstance(opts, list) and opts:
        first = opts[0]
        if isinstance(first, list) and first:
            first_item = first[0]
        else:
            first_item = first
        return first_item.get("text", first_item) if isinstance(first_item, dict) else first_item
    return ""


def _compute_fallback_player_option(clause_data: dict) -> str:
    """Запасной вариант текста игрока, если не удалось сохранить выбранную формулировку."""
    if clause_data.get("optimalSolution"):
        return clause_data.get("optimalSolution")
    if clause_data.get("ideal_option"):
        return clause_data.get("ideal_option")
    for key, default in (("ideal_options", []), ("correct_examples", []), ("changeOptions", [])):
        opts = clause_data.get(key) or default
        if isinstance(opts, list) and opts:
            first = opts[0]
            if isinstance(first, dict):
                return first.get("text", str(first))
            return str(first)
    return ""


def handle_reject_action(clause_data: dict, player_choice: dict) -> dict:
    """Обработка действия "Принять позицию бота" (исторически action=reject).
    Логика: принимаем редакцию контрагента → ACCEPTED_BOT + replacementText = botPreferred.
    """
    bot_preferred = _compute_bot_preferred_text(clause_data)
    if not bot_preferred:
        bot_preferred = (
            "здесь должна быть замена на формулировку бота, "
            "но что-то пошло не так, проверьте настройки сценария"
        )

    return {
        "agrees": True,
        "message": f'Принимаем мою редакцию: "{bot_preferred}".',
        "nextStatus": ClauseStatus["ACCEPTED_BOT"],
        "replacementText": bot_preferred,
        "points": 0,
    }


def handle_change_action(clause_data: dict, player_choice: dict) -> dict:
    """Обработка действия "Изменить"."""
    change_option_index = player_choice.get("changeOptionIndex")
    change_reason_index = player_choice.get("changeReasonIndex")
                                                           
    if isinstance(change_option_index, str) and change_option_index.isdigit():
        change_option_index = int(change_option_index)
    if isinstance(change_reason_index, str) and change_reason_index.isdigit():
        change_reason_index = int(change_reason_index)

                                                                                                            
    opts = get_clause_options(clause_data, "change")
    reasons = opts.get("reasons", clause_data.get("changeReasons", []))
    formulations = opts.get("formulations", clause_data.get("changeOptions", []))

    if change_reason_index is not None and isinstance(reasons, list) and change_reason_index < len(reasons):
        reason_data = reasons[change_reason_index]
    elif reasons:
        reason_data = reasons[0]
    else:
        reason_data = "Не указано"
    selected_reason = reason_data.get("text", reason_data) if isinstance(reason_data, dict) else reason_data

    selected_option = ""
    if change_option_index is not None and isinstance(formulations, list) and formulations:
        block = formulations[change_reason_index] if (
            change_reason_index is not None
            and change_reason_index < len(formulations)
            and isinstance(formulations[change_reason_index], list)
        ) else formulations[0]
        if isinstance(block, list) and change_option_index < len(block):
            formulation_data = block[change_option_index]
            selected_option = formulation_data.get("text", formulation_data) if isinstance(formulation_data, dict) else formulation_data
        elif not isinstance(block, list) and change_option_index < len(formulations):
            formulation_data = formulations[change_option_index]
            selected_option = formulation_data.get("text", formulation_data) if isinstance(formulation_data, dict) else formulation_data
    if not selected_option:
        selected_option = clause_data.get("optimalSolution") or clause_data.get("ideal_option") or _compute_fallback_player_option(clause_data)

    if not selected_option:
        selected_option = (
            "здесь должна быть замена на формулировку игрока, "
            "но что-то пошло не так, проверьте настройки сценария"
        )

    return {
        "agrees": True,
        "message": (
            f'Согласен с вашим предложением: "{selected_option}". '
            f'Причина: "{selected_reason}". Принимаю эту формулировку.'
        ),
        "nextStatus": ClauseStatus["CHANGED"],
        "replacementText": selected_option,
        "points": 0,
    }


def handle_insist_action(clause_data: dict, player_choice: dict) -> dict:
    """Обработка действия "Настоять на своей редакции" — бот всегда соглашается."""
    reason_index = player_choice.get("reasonIndex")
    opts = get_clause_options(clause_data, "insist")
    reasons = opts.get("reasons", clause_data.get("insistReasons") or clause_data.get("rejectionReasons", []))

    if reason_index is not None and isinstance(reasons, list) and reason_index < len(reasons):
        reason_data = reasons[reason_index]
    elif reasons:
        reason_data = reasons[0]
    else:
        reason_data = "Не указано"
    selected_reason = reason_data.get("text", reason_data) if isinstance(reason_data, dict) else reason_data

    return {
        "agrees": True,
        "message": (
            f'Я принимаю вашу позицию: "{selected_reason}". '
            "Оставляем оригинальный вариант без изменений."
        ),
        "nextStatus": ClauseStatus["NO_EDITS"],
        "points": 0,
    }


def get_bot_response(
    action: str,
    clause_data: dict,
    player_choice: dict,
    ai_mode: bool = False,
    objection_count: int = 0,
    justification_text: str | None = None,
    new_clause_text: str | None = None,
    contract_code: str | None = None,
    chat_history: list | None = None,
) -> dict:
    """
    Высокоуровневая точка входа для бота.

    Совместима по сигнатуре с v0.5beta: в простом режиме использует
    handle_*_action, в ИИ-режиме — handle_ai_objection_decision /
    handle_justification_response.
    """
    if not ai_mode:
        if action == "reject":
            return handle_reject_action(clause_data, player_choice)
        if action == "change":
            return handle_change_action(clause_data, player_choice)
        if action == "insist":
            return handle_insist_action(clause_data, player_choice)
        if action == "discuss":
            return {
                "agrees": False,
                "message": "",
                "nextStatus": clause_data.get("status", ClauseStatus["AVAILABLE"]),
                "discussionOptions": ["change", "insist"],
            }
    else:
        if justification_text:
            return handle_justification_response(
                clause_data, player_choice, action, justification_text,
                contract_code=contract_code,
                new_clause_text=new_clause_text,
                chat_history=chat_history,
            )
        return handle_ai_objection_decision(
            clause_data, player_choice, action, objection_count,
            contract_code=contract_code,
            new_clause_text=new_clause_text,
            chat_history=chat_history,
            justification_text=justification_text,
        )

    return {
        "agrees": False,
        "message": "Не понимаю ваше действие. Пожалуйста, выберите действие.",
        "nextStatus": clause_data.get("status", ClauseStatus["AVAILABLE"]),
    }


def _get_proposed_formulation_text(clause_data: dict, player_choice: dict, action: str) -> str:
    """Текст предложения игрока для оценки ИИ по эталону (первая реплика)."""
    if action == "change":
        opts = get_clause_options(clause_data, "change")
        formulations = opts.get("formulations", clause_data.get("changeOptions", []))
        reasons = opts.get("reasons", [])
        change_reason_index = player_choice.get("changeReasonIndex") or player_choice.get("reasonIndex")
        change_option_index = player_choice.get("changeOptionIndex") or player_choice.get("choiceIndex")
        if isinstance(change_option_index, str) and change_option_index.isdigit():
            change_option_index = int(change_option_index)
        if isinstance(change_reason_index, str) and change_reason_index.isdigit():
            change_reason_index = int(change_reason_index)
        selected_option = ""
        if formulations:
            block = formulations[change_reason_index] if (
                change_reason_index is not None and change_reason_index < len(formulations)
                and isinstance(formulations[change_reason_index], list)
            ) else formulations[0]
            if isinstance(block, list) and change_option_index is not None and change_option_index < len(block):
                fd = block[change_option_index]
                selected_option = fd.get("text", fd) if isinstance(fd, dict) else fd
            elif not isinstance(block, list) and change_option_index is not None and change_option_index < len(formulations):
                fd = formulations[change_option_index]
                selected_option = fd.get("text", fd) if isinstance(fd, dict) else fd
                                                                                                                                          
        if not selected_option and (change_option_index is None) and (change_reason_index is None):
            return ""
        return selected_option or clause_data.get("ideal_option") or clause_data.get("contract_text", "")[:200]
    if action == "insist":
        opts = get_clause_options(clause_data, "insist")
        reasons = opts.get("reasons", [])
        reason_index = player_choice.get("reasonIndex")
        if reason_index is not None and isinstance(reasons, list) and reason_index < len(reasons):
            rd = reasons[reason_index]
            return rd.get("text", rd) if isinstance(rd, dict) else rd
        return reasons[0].get("text", reasons[0]) if reasons and isinstance(reasons[0], dict) else (reasons[0] if reasons else "Настаиваем на своей редакции.")
    if action == "reject":
        return "Принять позицию контрагента (оставить редакцию Исполнителя)."
    return ""


def _reasons_list(clause_data: dict, *keys: str) -> list:
    """Собрать список причин из старых или новых полей (rejectionReasons, changeReasons, guide_summary)."""
    for key in keys:
        val = clause_data.get(key)
        if isinstance(val, list) and val:
            return val
    guide = clause_data.get("guide_summary")
    if guide:
        return [{"text": guide}]
    return []


def _formulations_list(clause_data: dict) -> list:
    """Собрать список формулировок: changeOptions или ideal_option / ideal_options / correct_examples."""
    opts = clause_data.get("changeOptions")
    if isinstance(opts, list) and opts:
        return opts
    out = []
    ideal = clause_data.get("ideal_option")
    if ideal:
        out.append(ideal if isinstance(ideal, dict) else {"text": ideal})
    for key in ("ideal_options", "correct_examples"):
        arr = clause_data.get(key) or []
        if isinstance(arr, list):
            for x in arr:
                out.append(x if isinstance(x, dict) else {"text": str(x)})
    return [out] if out else []                                             


def _get_formulation_agreed_from_counterpart(
    clause_data: dict, last_counterpart_text: str
) -> str:
    """
    Если контрагент в последней реплике предложил формулировку из допустимых (ideal_options,
    correct_examples), вернуть её текст для подстановки в договор. Иначе пустая строка.
    Используется, когда игрок согласился с предложением контрагента («устраивает такая редакция»).
    
    Логика:
    1. Ищем совпадение по тексту вариантов из кейса (ideal_options, correct_examples)
    2. Если не найдено — извлекаем текст из кавычек в реплике бота
    """
    if not last_counterpart_text or len(last_counterpart_text.strip()) < 5:
        return ""
    last_lower = last_counterpart_text.lower()
    
                                                     
    opts = list(clause_data.get("ideal_options") or [])
    for key in ("correct_examples", "correct_example", "etalon_phrases"):
        val = clause_data.get(key)
        if isinstance(val, list):
            opts.extend(val)
        elif isinstance(val, str) and val.strip():
            opts.append(val.strip())
    
    for o in opts:
        text = (o.get("text", o) if isinstance(o, dict) else o) or ""
        if not text or len(text) < 3:
            continue
        text_stripped = text.strip()
        text_lower = text_stripped.lower()
                                                                      
        if text_lower in last_lower:
                                                                          
            return _extract_formulation_only(text_stripped)
        words = [w for w in text_lower.replace(",", " ").replace(".", " ").split() if len(w) >= 4]
        if len(words) >= 2 and sum(1 for w in words if w in last_lower) >= 2:
            return _extract_formulation_only(text_stripped)
    
                                                                           
    quoted_text = _extract_quoted_text(last_counterpart_text)
    if quoted_text and len(quoted_text) >= 5:
        return quoted_text
    
    return ""


def _extract_formulation_only(text: str) -> str:
    """Извлекает только формулировку, отсекая пояснение после маркеров типа 'поскольку'."""
    if not text:
        return ""
    markers = [", поскольку", " поскольку", ", потому что", " потому что", ", так как", " так как"]
    lower = text.lower()
    earliest_pos = len(text)
    for marker in markers:
        pos = lower.find(marker)
        if pos > 0 and pos < earliest_pos:
            earliest_pos = pos
    if earliest_pos < len(text):
        return text[:earliest_pos].strip().rstrip(",.")
    return text.strip()


def _extract_quoted_text(text: str) -> str:
    """Извлекает текст из кавычек (« » или " ")."""
    if not text:
        return ""
                                           
    patterns = [
        r'[«"]([^»"]+)[»"]',                                   
        r'"([^"]+)"',                   
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            quoted = match.group(1).strip()
            if len(quoted) >= 5:
                return quoted
    return ""


def _is_clarification_request(text: str) -> bool:
    """Просит ли ответ ИИ ещё раз пояснить позицию."""
    lower = (text or "").strip().lower()
    return any(
        marker in lower
        for marker in ("поясните", "уточните", "подробнее", "обоснуйте", "почему именно", "не получил пояснение")
    )


def _is_correct_justification_by_rules(text: str, clause_data: dict) -> bool:
    """
    Проверяет, содержит ли обоснование правильные маркеры из clause_data["rules"]["correct_justification_markers"].
    Требует и маркеры формулировки из rules, и общие маркеры пояснения.
    """
    rules = (clause_data or {}).get("rules") or {}
    justification_markers = rules.get("correct_justification_markers") or ()
    if not justification_markers:
        return False
    if not text or len(text.strip()) < 10:
        return False
    lower = text.strip().lower()
    explanation_markers = (
        "потому что", "так как", "поскольку", "во избежание", "чтобы",
        "иначе", "в связи с", "неопределен", "риск", "важно", "необходимо",
    )
    has_formulation = any(m in lower for m in justification_markers)
    has_explanation = any(m in lower for m in explanation_markers)
    return has_formulation and has_explanation


                                                                                                   
                                                                              
EXPLANATION_MARKERS = (
    "потому что", "так как", "поскольку", "во избежание", "чтобы не",
    "иначе", "в связи с", "неопределен", "риск", "важно", "необходимо",
    "обоснование", "причина", "поэтому", "обоснован", "коррект", "лучше",
    "для нас важно", "нужно потому", "риск в", "риск в том",
)


def _is_substantive_justification(text: str) -> bool:
    """
    Эвристика: ответ содержит содержательное обоснование (причина, аргумент).
    Требует хотя бы один маркер пояснения — длинный текст без маркеров
    (например, вставка формулировки пункта) не считается пояснением.
    """
    cleaned = (text or "").strip().lower()
    if len(cleaned) < 30:
        return False
    return any(marker in cleaned for marker in EXPLANATION_MARKERS)


def _is_same_as_contract_text(text: str, clause_data: dict) -> bool:
    """True, если текст по смыслу совпадает с исходной формулировкой пункта в договоре."""
    if not text or not clause_data:
        return False
    contract = (clause_data.get("contract_text") or clause_data.get("text") or "").strip()
    if not contract:
        return False
    a = (text or "").strip().lower()
    b = contract.strip().lower()
    if a == b:
        return True
                                                             
    a_norm = " ".join(a.split())
    b_norm = " ".join(b.split())
    return a_norm == b_norm or a_norm in b_norm or b_norm in a_norm


def _strip_intro_phrases(text: str) -> str:
    """Убирает вводные фразы: 'предлагаю изложить в редакции:', 'изложи в редакции:' и т.п."""
    if not text or len(text.strip()) < 5:
        return (text or "").strip()
                                                    
    cleaned = re.sub(
        r"^(?:предлагаю|предлагаем|изложи(?:ть)?|прошу|давайте|нужно|хочу\s+предложить)"
        r"[^:«\"'""]*[:«\"'""]\s*",
        "",
        text.strip(),
        flags=re.IGNORECASE,
    ).strip()
                                    
    cleaned = cleaned.strip("«»\"\"""''")
    return cleaned if len(cleaned) >= 3 else text.strip()


def _get_etalon_refs(clause_data: dict) -> list[str]:
    """Собирает список эталонных формулировок для пункта (в нижнем регистре)."""
    refs = []
    for p in clause_data.get("etalon_phrases") or []:
        if isinstance(p, str) and p.strip():
            refs.append(p.strip().lower())
    ideal_option = clause_data.get("ideal_option")
    if ideal_option and isinstance(ideal_option, str):
        refs.append(ideal_option.strip().lower())
    for opt in clause_data.get("ideal_options") or []:
        if isinstance(opt, str) and opt.strip():
            refs.append(opt.strip().lower())
    for ex in clause_data.get("correct_examples") or []:
        if isinstance(ex, str) and ex.strip():
            refs.append(ex.strip().lower())
    return refs


def _text_matches_etalon(text: str, refs: list[str]) -> bool:
    """Проверяет, содержит ли текст эталонную формулировку."""
                                                         
    lower = text.lower().strip().strip("«»\"\"""''").strip()
    lower_normalized = " ".join(lower.split())
    for ref in refs:
        ref_normalized = " ".join(ref.strip().split())
                                           
        if len(ref_normalized) >= 3 and ref_normalized in lower_normalized:
            return True
                                                                            
        if len(lower_normalized) >= 3 and lower_normalized in ref_normalized:
            return True
                                                             
        if len(ref_normalized) >= 10:
            ref_words = set(w for w in ref_normalized.split() if len(w) >= 3)
            text_words = set(w for w in lower_normalized.split() if len(w) >= 3)
            if ref_words and len(ref_words & text_words) >= len(ref_words) * 0.7:
                return True
    return False


def _pick_canonical_for_short_etalon_phrase(
    lower_normalized: str,
    refs: list[str],
    canonical_for_contract: list[str],
) -> str | None:
    """
    Короткая формулировка игрока (≤22 символов), уже попадающая под эталоны пункта,
    сопоставляется с каноном из ideal_options / correct_examples ослабленным порогом
    (например «весь мир» → «По всему миру.»; Levenshtein один не хватает, нужен max с SequenceMatcher).

    Для всех пунктов договора, не только territory.
    """
    if (
        len(lower_normalized) > 22
        or len(lower_normalized) < 5
        or not canonical_for_contract
        or not refs
    ):
        return None
    if not _text_matches_etalon(lower_normalized, refs):
        return None
    try:
        from services.similarity_service import normalized_levenshtein_ratio
    except Exception:
        normalized_levenshtein_ratio = None
    best_canon: str | None = None
    best_r = -1.0
    for opt in canonical_for_contract:
        on = " ".join(opt.lower().split())
        if len(on) < 5:
            continue
        r_seq = difflib.SequenceMatcher(None, lower_normalized, on).ratio()
        r_lev = (
            normalized_levenshtein_ratio(lower_normalized, on)
            if normalized_levenshtein_ratio
            else 0.0
        )
        r = max(r_seq, r_lev)
        if r > best_r:
            best_r = r
            best_canon = opt
    if best_canon is not None and best_r >= 0.48:
        return best_canon.strip()
    return None


def find_formulation_in_history(chat_history: list, clause_data: dict) -> str:
    """
    Ищет в истории чата ранее предложенную игроком правильную формулировку.
    Возвращает текст формулировки (очищенный) или пустую строку.
    """
    if not chat_history:
        return ""
    refs = _get_etalon_refs(clause_data)
    if not refs:
        return ""
    for msg in reversed(chat_history):
        if msg.get("owner") != "player":
            continue
        text = (msg.get("text") or "").strip()
        if not text:
            continue
        cleaned = _strip_intro_phrases(text)
        if _text_matches_etalon(cleaned, refs):
                                               
            return cleaned
    return ""


                                                                                           
_IDEAL_CONTRACT_GUIDE_TAIL_RE = re.compile(
    r"\s+Ежемесячные акты об использовании ПО в договоре закреплять неправильно\.?\s*$",
    re.IGNORECASE | re.UNICODE,
)


def _strip_guide_tail_from_ideal_contract_text(s: str) -> str:
    if not s or not isinstance(s, str):
        return (s or "").strip()
    return _IDEAL_CONTRACT_GUIDE_TAIL_RE.sub("", s.strip()).strip()


def _etalon_ref_in_player_normalized(ref: str, lower_normalized: str) -> bool:
    """
    Эталон из refs обычно с точкой в конце; после strip_revision_meta у игрока финальная
    пунктуация снята — иначе «…Казахстан» не находит «…Казахстан.» в подстроке.
    """
    if not ref:
        return False
    r = ref.rstrip(".;:!? ")
    ln = lower_normalized.rstrip(".;:!? ")
    return bool(r and r in ln)


def find_best_matching_ideal_option(text: str, clause_data: dict) -> str:
    """
    Находит наиболее подходящую эталонную формулировку для текста игрока.
    Используется для замены текста в договоре (без «предлагаю редакцию» и т.п.).

    Приоритет для всех пунктов и кейсов: убрать служебные слова и пояснение, затем
    подставить канонический текст из ideal_options / correct_examples (без опечаток игрока).

    Не подменяем длинную формулировку игрока на первый ideal_option из‑за короткого ref
    (например «весь мир» внутри «на территории всего мира» и внутри «по всему миру»).
    Короткие фразы (≤22 символов), явно попадающие под эталоны пункта, подбирают канон через
    _pick_canonical_for_short_etalon_phrase (для любого пункта, не только territory).
    Если явного соответствия нет — возвращаем исходный текст (после очистки краёв).
    """
    if not text or not str(text).strip():
        return (text or "").strip() if isinstance(text, str) else ""
    if clause_data and isinstance(clause_data.get("ideal_option"), str):
        _io_clean = _strip_guide_tail_from_ideal_contract_text(clause_data["ideal_option"])
        if _io_clean != clause_data["ideal_option"]:
            clause_data = {**clause_data, "ideal_option": _io_clean}
    raw_in = str(text).strip()
    cleaned = strip_revision_meta_from_clause_draft(_strip_intro_phrases(raw_in))
    cleaned = strip_explanation_tail_from_contract_formulation(cleaned)
    text = (cleaned or "").strip() or raw_in
    cid = str((clause_data or {}).get("id") or "").strip()

                                                                                              
                                                                                         
                                                                                                            
    _cd = clause_data or {}
    _is_territory_profile = _cd.get("negotiation_profile") == "territory" or cid.endswith(
        "_territory"
    )
    if _is_territory_profile:
        from services.ai_counterpart_rules import _territory_formulation_aligns_with_ideal_options

        if not _territory_formulation_aligns_with_ideal_options(text, clause_data):
            return text.strip()

    refs = _get_etalon_refs(clause_data)
    if not refs:
        return text.strip()
    lower = text.lower().strip().strip("«»\"\"""''")
    lower_normalized = " ".join(lower.split())

                                                       
    canonical_for_contract: list[str] = []
    seen_k: set[str] = set()

    def _add_canonical(s: str) -> None:
        s = (s or "").strip()
        if len(s) < 3:
            return
        k = " ".join(s.lower().split())
        if k not in seen_k:
            seen_k.add(k)
            canonical_for_contract.append(s)

    io = clause_data.get("ideal_option")
    if isinstance(io, str):
        _add_canonical(io)
    for opt in clause_data.get("ideal_options") or []:
        if isinstance(opt, str):
            _add_canonical(opt)
    for ex in clause_data.get("correct_examples") or []:
        if isinstance(ex, str):
            _add_canonical(ex)
    ce = clause_data.get("correct_example")
    if isinstance(ce, str):
        _add_canonical(ce)

                                                                                      
    try:
        from services.similarity_service import normalized_levenshtein_ratio

        best_canon: str | None = None
        best_r = -1.0
        for opt in canonical_for_contract:
            on = " ".join(opt.lower().split())
            if len(on) < 5:
                continue
            r = normalized_levenshtein_ratio(lower_normalized, on)
            if r > best_r:
                best_r = r
                best_canon = opt
        if best_canon is not None and best_r >= 0.86:
            return best_canon.strip()
    except Exception:
        pass

                                                                                    
    _short_canon = _pick_canonical_for_short_etalon_phrase(
        lower_normalized, refs, canonical_for_contract
    )
    if _short_canon:
        return _short_canon

                                                                           
    ideal_options = clause_data.get("ideal_options") or []
    if clause_data.get("ideal_option"):
        ideal_options = [clause_data["ideal_option"]] + list(ideal_options)
    
    for opt in ideal_options:
        if not isinstance(opt, str):
            continue
        opt_lower = opt.lower().strip()
        opt_normalized = " ".join(opt_lower.split())
                                            
        for ref in refs:
            if not ref:
                continue
                                                                                                                                   
            ref_key = ref.rstrip(".;:!? ")
            ln_cmp = lower_normalized.rstrip(".;:!? ")
            if len(ln_cmp) > 22 and len(ref_key) < 14:
                continue
            opt_key = opt_normalized.rstrip(".;:!? ")
            if _etalon_ref_in_player_normalized(ref, lower_normalized) and ref_key in opt_key:
                return opt.strip()

    ideal_strings: list[str] = []
    for opt in ideal_options:
        if isinstance(opt, str) and opt.strip():
            ideal_strings.append(opt.strip())
    for ex in clause_data.get("correct_examples") or []:
        if isinstance(ex, str) and ex.strip() and ex.strip() not in ideal_strings:
            ideal_strings.append(ex.strip())
    ce2 = clause_data.get("correct_example")
    if isinstance(ce2, str) and ce2.strip():
        c2 = ce2.strip()
        if c2 not in ideal_strings:
            ideal_strings.append(c2)

                                                                                                         
    if ideal_strings and len(lower_normalized) >= 12:
        best_ratio = 0.0
        best_opt: str | None = None
        for opt in ideal_strings:
            on = " ".join(opt.lower().split())
            ratio = difflib.SequenceMatcher(None, lower_normalized, on).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_opt = opt
        if best_opt and best_ratio >= 0.86:
            on = " ".join(best_opt.lower().split())
            if abs(len(lower_normalized) - len(on)) <= 8:
                return best_opt.strip()

                                                                                                             
                                                                                                             
                                                           
    for ref in refs:
        ref_key = ref.rstrip(".;:!? ")
        if len(ref_key) < 14:
            continue
        if not _etalon_ref_in_player_normalized(ref, lower_normalized):
            continue
        for opt in ideal_strings:
            on = " ".join((opt or "").lower().split())
            if ref_key in on.rstrip(".;:!? "):
                return opt.strip()
        return text.strip()

                                                                                           
                                                                                                      
                                                                                       
    _skip_cosine = cid == "1.4.1_territory"
    sim_svc = _get_similarity_service()
    if sim_svc and sim_svc.is_enabled() and not _skip_cosine:
        if ideal_strings:
            matched, _score = sim_svc.find_best_match(text, ideal_strings, threshold=0.75)
            if matched:
                return matched.strip()

                                                                                           
    return text.strip() if isinstance(text, str) else text


def extract_formulation_and_explanation(
    text: str,
    clause_data: dict,
    chat_history: list | None = None,
) -> tuple[str, str, bool, bool]:
    """
    Извлекает из текста игрока формулировку пункта и пояснение.
    Если формулировка не найдена в текущем сообщении, ищет в истории чата.

    Возвращает (formulation, explanation, has_valid_formulation, has_valid_explanation).

    - formulation: текст формулировки (очищенный от «предлагаю редакцию» и т.п.)
    - explanation: текст пояснения (если есть)
    - has_valid_formulation: формулировка близка к эталону
    - has_valid_explanation: есть содержательное пояснение
    """
    if not text or len(text.strip()) < 3:
                                                   
        history_formulation = find_formulation_in_history(chat_history or [], clause_data) if chat_history else ""
        return history_formulation, "", bool(history_formulation), False

    cleaned = _strip_intro_phrases(text.strip())
    lower = cleaned.lower()

                                 
    has_explanation = any(m in lower for m in EXPLANATION_MARKERS)

                                  
    refs = _get_etalon_refs(clause_data)

    has_formulation = _text_matches_etalon(cleaned, refs) if refs else False
    formulation = cleaned

                                                                                                
    if not has_formulation and has_explanation and chat_history:
        history_formulation = find_formulation_in_history(chat_history, clause_data)
        if history_formulation:
            has_formulation = True
            formulation = history_formulation

    return formulation, cleaned if has_explanation else "", has_formulation, has_explanation


def _looks_like_only_formulation(justification_text: str, clause_data: dict) -> bool:
    """
    True, если сообщение игрока похоже только на предложенную формулировку пункта
    без явного пояснения (нет маркеров из EXPLANATION_MARKERS).
    Во всех пунктах договора в таком случае нужно запросить пояснение.
    """
    if not justification_text or len(justification_text.strip()) < 5:
        return False
                                                                                  
    normalized = _strip_intro_phrases(justification_text)
    lower = (normalized or "").strip().lower()
                                                                 
    if any(m in lower for m in EXPLANATION_MARKERS):
        return False
                                                                                
    refs: list[str] = []
    for key in ("ideal_option", "correct_example"):
        v = clause_data.get(key)
        if isinstance(v, str) and v.strip():
            refs.append(v.strip().lower())
    for key in ("ideal_options", "correct_examples", "etalon_phrases"):
        for x in clause_data.get(key) or []:
            t = (x.get("text", x) if isinstance(x, dict) else str(x)).strip().lower()
            if t and len(t) >= 10:
                refs.append(t)
    if not refs:
        return False
                                                                               
    for ref in refs:
        if len(ref) < 10:
            continue
        if ref in lower or lower in ref:
            return True
        if len(lower) <= 70 and len(set(lower.split()) & set(ref.split())) >= 4:
            return True
    return False


                                                                                                                                 
_CLARIFY_BOT_PREFIX_RE = re.compile(
    r"^(поясните|уточните|пришлите|направьте|скажите|напишите|опишите|нужн[аы]\s|требуется\s|"
    r"без\s+вашей\s+редакции|без\s+вашего\s+текста|чтобы\s+согласовать\s+нужн)",
    re.IGNORECASE | re.UNICODE,
)


def _player_text_negates_counterparty_assent(j_lower: str) -> bool:
    """Грубый отсев: явный отказ / несогласие с позицией контрагента."""
    n = j_lower.replace("ё", "е")
    needles = (
        "не согласен", "не согласна", "не согласны", "несогласен", "несогласна",
        "не принимаю", "не принимаем", "не устраивает", "не подходит", "не годится",
        "не готовы принять", "отклоняем", "отклоняю", "категорически против",
        "не договорились", "разноглас", "настаиваем на своей", "настаиваю на своей",
    )
    return any(x in n for x in needles)


def _bot_is_primarily_clarify_request(bot_text: str) -> bool:
    t = (bot_text or "").strip()
    if not t:
        return True
    low = t.strip().lower()
    if _CLARIFY_BOT_PREFIX_RE.match(low) and len(low) < 140:
        return True
    return False


def _last_bot_allows_short_assent(chat_history: list | None) -> bool:
    """
    Последняя реплика бота — предложение/фиксация редакции ИЛИ достаточно содержательный ответ,
    на который уместен короткий «да» / «хорошо» (любой пункт договора).
    """
    if _last_bot_message_proposed_formulation(chat_history or []):
        return True
    for msg in reversed(chat_history or []):
        if msg.get("owner") != "bot":
            continue
        raw = (msg.get("text") or "").strip()
        if len(raw) < 72:
            return False
        if _bot_is_primarily_clarify_request(raw):
            return False
        return True
    return False


def _player_agreed_with_counterpart(justification_text: str, chat_history: list | None) -> bool:
    """
    Игрок явно согласился с предложением контрагента (оставить редакцию контрагента / ничего не менять).
    
    Случаи:
    1. Явные маркеры согласия: «устраивает», «согласен», «принимаем» и т.п.
    2. Игрок хочет оставить редакцию контрагента: «оставим вашу редакцию», «оставить редакцию контрагента», «ничего не менять» и т.п.
    3. Короткий утвердительный ответ («да», «ок») — если последняя реплика бота предлагает/фиксирует условие или достаточно содержательна.
    4. Устойчивые фразы «согласен с вашей…», «принимаю вашу редакцию» и т.п. (любой пункт).
    """
    if not justification_text:
        return False
    j_lower = (justification_text or "").strip().lower()

                                                                             
                                                                                                    
    if player_seeks_clause_revision(justification_text):
        return False

    if _player_text_negates_counterparty_assent(j_lower):
        return False

                                                                                          
    counterparty_assent_phrases = (
        "согласен с вашей", "согласна с вашей", "согласны с вашей",
        "согласен с вами", "согласна с вами", "согласны с вами",
        "согласен с последн", "согласна с последн", "согласны с последн",
        "принимаю вашу редакцию", "принимаем вашу редакцию",
        "принимаю вашу формулировку", "принимаем вашу формулировку",
        "принимаю предложенную вами", "принимаем предложенную вами",
        "принимаю ваш вариант", "принимаем ваш вариант",
        "нас устраивает ваша", "нас устраивает ваш", "устраивает ваш вариант",
        "ваш вариант устраивает", "ваша редакция устраивает",
        "без возражений по ваш", "возражений нет", "нет возражений",
        "окончательно согласен", "окончательно согласна", "полностью согласен",
        "полностью согласна", "полностью согласны",
        "записываем как у вас", "как вы предложили", "как вы и предложили",
        "фиксируем по-вашему", "оставляем вашу редакцию", "оставляем вашу формулировку",
        "с вашей редакцией согласен", "с вашим текстом согласен",
        "согласен с текстом исполнителя", "согласна с текстом исполнителя",
        "подписываемся под ваш", "акцептуем ваш", "акцептую ваш",
    )
    if any(p in j_lower for p in counterparty_assent_phrases):
        if chat_history and any(m.get("owner") == "bot" for m in chat_history):
            return True

                                                                             
                                                                                             
    explicit_agree_markers = (
        "устраивает", "согласен", "согласна", "принимаем", "принимаю",
        "да, хорошо", "подходит", "хорошо, так и оформим", "так и сделаем",
        "принято", "договорились", "идёт", "пойдёт", "годится", "подойдёт",
    )
                                                                                 
    _ambiguous_agree_markers_in_question = frozenset(
        {
            "подходит",
            "подойдет",
            "подойдёт",
            "идет",
            "идёт",
            "пойдет",
            "пойдёт",
            "годится",
            "устраивает",
        }
    )
    _norm = j_lower.replace("ё", "е")
    _explicit_negations: dict[str, tuple[str, ...]] = {
        "подходит": ("не подходит",),
        "подойдет": ("не подойдет",),
        "пойдет": ("не пойдет",),
        "идет": ("не идет",),
        "годится": ("не годится",),
        "устраивает": ("не устраивает",),
        "согласен": ("не согласен", "несогласен"),
        "согласна": ("не согласна", "несогласна"),
        "принимаем": ("не принимаем",),
        "принимаю": ("не принимаю",),
        "принято": ("не принято",),
        "договорились": ("не договорились",),
    }
    def _agree_marker_matches(m_raw: str, haystack: str) -> bool:
        """Для фраз с пробелом/запятой — подстрока; для одного слова — только целое слово.

        Иначе «идет» ложно находится внутри «придется» и срабатывает guard «фиксируем редакцию».
        """
        m_n = m_raw.replace("ё", "е")
        if " " in m_raw or "," in m_raw:
            return m_n in haystack
        return bool(re.search(r"(?<![\w])" + re.escape(m_n) + r"(?![\w])", haystack))

    for m in explicit_agree_markers:
        if not _agree_marker_matches(m, _norm):
            continue
        m_n = m.replace("ё", "е")
        if "?" in _norm and m_n in _ambiguous_agree_markers_in_question:
            continue
        negs = _explicit_negations.get(m_n, ())
        if negs and any(n.replace("ё", "е") in _norm for n in negs):
            continue
        if m_n in ("согласен", "согласна", "согласны") and (
            " но " in _norm or " однако " in _norm or " если только " in _norm
        ):
            continue
        return True

                                                                                                     
    leave_counterpart_markers = (
        "оставим вашу редакцию", "оставить вашу редакцию", "оставляем вашу редакцию",
        "оставим вашу формулировку", "оставить редакцию контрагента", "редакцию контрагента",
        "вашу редакцию остав", "остав вашу редакцию", "ничего не менять", "ничего не меняем",
        "оставляем как есть", "оставить как есть", "оставим как есть",
        "согласны оставить", "согласен оставить", "хотим оставить вашу", "хочу оставить вашу",
        "оставим как вы", "оставить как вы предложил", "оставляем как вы предложили",
        "принимаем вашу редакцию", "принимаем вашу формулировку", "оставьте вашу редакцию",
        "берем ваш вариант", "берём ваш вариант", "берем вашу редакцию", "берём вашу редакцию",
        "остановимся на вашем", "остановимся на вашей", "остаемся на вашем", "остаёмся на вашем",
    )
    if any(m in j_lower for m in leave_counterpart_markers):
        return True
    if ("остав" in j_lower or "оставим" in j_lower) and ("редакци" in j_lower or "вашу" in j_lower or "контрагент" in j_lower or "как вы" in j_lower):
        return True
    
                                                                                      
                                                                                                    
    short_agree_words = (
        "да", "ок", "окей", "okay", "ok", "хорошо", "ладно", "давай", "давайте",
        "спасибо", "благодарю", "принял", "приняла", "принято", "понятно", "ясно",
    )
                                              
    j_cleaned = re.sub(r'[^\w\s]', '', j_lower).strip()
    j_words = j_cleaned.split()

    if j_words and j_words[0] in ("давай", "давайте") and len(j_words) > 1:
        second = j_words[1] if len(j_words) > 1 else ""
        if second not in ("так", "хорошо", "ладно", "ок", "окей", "да"):
            return False

                                                                                                     
    if len(j_words) <= 5 and j_words and j_words[0] in short_agree_words:
        if chat_history and _last_bot_allows_short_assent(chat_history):
            return True

    return False


def _last_bot_message_proposed_formulation(chat_history: list) -> bool:
    """
    Проверяет, содержит ли последняя реплика бота предложение редакции **или**
    явное закрепление итога («фиксируем…», «пришли к согласию»), на которое игрок
    может ответить коротким «да» / «хорошо».
    """
    if not chat_history:
        return False

                                         
    proposal_markers = (
        "предлагаю", "предлагаем", "можем изложить", "можно изложить",
        "в редакции", "редакция", "формулировка", "вариант:",
        "изложить как", "записать как", "зафиксировать как",
        "согласовать в редакции", "принять редакцию",
    )
                                                                                                         
    settlement_markers = (
        "фиксируем",
        "зафиксируем",
        "зафиксировали",
        "можем зафиксировать",
        "можно зафиксировать",
        "запишем так",
        "записываем так",
        "пришли к согласию",
        "пришли к соглас",
        "дошли до согласия",
        "рад, что мы",
        "рад что мы",
        "остаёмся на",
        "остаемся на",
        "остановимся на",
        "остаётся в редакции",
        "остается в редакции",
        "увенчаем договор",
        "договорились о",
    )

                                   
    for msg in reversed(chat_history):
        if msg.get("owner") == "bot":
            bot_text = (msg.get("text") or "").lower()
            if any(marker in bot_text for marker in proposal_markers):
                return True
            if any(marker in bot_text for marker in settlement_markers):
                return True
                                                                                    
            if "«" in bot_text or "»" in bot_text or '"' in bot_text:
                return True
            break

    return False


def _check_change_requires_both_revision_and_explanation(
    action: str,
    clause_data: dict,
    justification_text: str,
    new_clause_text: str | None,
    proposed_text_for_eval: str,
    substantive_justification: bool,
    near_expected_formulation: bool,
    chat_history: list | None,
) -> tuple[bool, str | None]:
    """
    Для action=change: ИИ соглашается только при наличии редакции (близкой к эталону) И пояснения.
    Возвращает (can_agree, request_message).
    Если can_agree=False, request_message — что попросить у игрока.
    Исключение: игрок согласился с предложением контрагента — принимаем без доп. пояснения.
    """
    if action != "change":
        return (True, None)

    agreed_with_ai = _player_agreed_with_counterpart(justification_text, chat_history)
    if agreed_with_ai:
        return (True, None)

    has_revision = near_expected_formulation or (
        bool((new_clause_text or "").strip())
        and _is_near_expected_formulation((new_clause_text or "").strip(), clause_data)
    )
    if not has_revision and _is_near_expected_formulation((justification_text or "").strip(), clause_data):
        has_revision = True

    has_explanation = substantive_justification

                                                                                                    
                                                                            
    if not has_revision and not has_explanation:
        if _text_contains_formulation_wrapper(justification_text or "") or _is_near_expected_formulation(
            (justification_text or "").strip(), clause_data
        ):
            return (False, "Редакция понятна. Поясните, пожалуйста, почему вы предлагаете именно такую формулировку.")
        return (False, "Чтобы согласовать пункт, предложите конкретную новую редакцию и кратко обоснуйте её.")
    if not has_revision:
        return (False, "Предложите, пожалуйста, конкретную редакцию пункта.")
    if not has_explanation:
        return (False, "Редакция понятна. Поясните, пожалуйста, почему вы предлагаете именно такую формулировку.")
    return (True, None)


def _text_contains_formulation_wrapper(text: str) -> bool:
    """
    True, если в тексте есть обёртка предложенной редакции («в следующей редакции:», «предлагаем изложить в редакции:» и т.п.)
    и после неё есть непустой текст. Используется, чтобы не просить «предложите редакцию и обоснуйте»,
    когда игрок уже указал редакцию — в таком случае просим только пояснение.
    """
    if not text or len(text.strip()) < 15:
        return False
    t = (text or "").strip().lower()
    wrappers = (
        "в следующей редакции:",
        "в редакции:",
        "в редакцию:",
        "предлагаем изложить",
        "предлагаю изложить",
        "изложить в редакции",
        "редакции:",
    )
    for sep in wrappers:
        idx = t.find(sep)
        if idx >= 0:
            rest = t[idx + len(sep) :].lstrip(" «\"'").rstrip("»\"'.,;:!?")
            if len(rest) >= 5:
                return True
    return False


def _extract_core_formulation(text: str) -> str:
    """
    Извлекает ядро формулировки из обёртки вроде «Предлагаю изложить в редакции: "..."».
    Возвращает текст для сравнения с эталоном.
    """
    t = (text or "").strip().lower()
    if len(t) < 3:
        return t
                                                        
    for sep in (
        "редакции:",
        "редакцию:",
        "в редакции:",
        "в следующей редакции:",
        "предлагаю:",
        "предлагаем:",
        "изложить:",
        "в редакции «",
        "в редакции \"",
        "редакции «",
        "редакции \"",
    ):
        idx = t.find(sep)
        if idx >= 0:
            rest = t[idx + len(sep) :].lstrip(" «\"'").rstrip("»\"'.,;:!?")
            if len(rest) >= 8:
                return rest
    return t


def _is_near_expected_formulation(text: str, clause_data: dict, use_similarity: bool = True) -> bool:
    """
    Близок ли текст к эталонной / допустимой формулировке из кейса.
    
    Использует двухуровневую проверку:
    1. Rule-based (подстрока, совпадение слов) — быстро и детерминированно
    2. Cosine similarity (если rule-based не сработал) — для перефразирований
    
    Args:
        text: текст игрока
        clause_data: данные пункта с эталонами
        use_similarity: использовать ли cosine similarity как fallback
    """
    candidate = _extract_core_formulation(text)
    candidate = candidate.strip().lower()
    if len(candidate) < 3:
        return False

    examples: list[str] = []
    for key in ("ideal_option", "correct_example"):
        val = clause_data.get(key)
        if isinstance(val, str) and val.strip():
            examples.append(val.strip())
    for key in ("etalon_phrases", "ideal_options", "correct_examples"):
        vals = clause_data.get(key) or []
        if isinstance(vals, list):
            for item in vals:
                examples.append(item.get("text", item) if isinstance(item, dict) else str(item))

                                      
    for example in examples:
        example_text = (example or "").strip().lower()
        if len(example_text) < 3:
            continue
                                                      
        example_core = _extract_core_formulation(example_text)
        if candidate in example_core or example_core in candidate:
            return True
        if candidate in example_text or example_text in candidate:
            return True
        candidate_words = {w for w in candidate.replace(",", " ").replace(".", " ").split() if len(w) >= 4}
        example_words = {w for w in example_text.replace(",", " ").replace(".", " ").split() if len(w) >= 4}
        if candidate_words and len(candidate_words & example_words) >= 2:
            return True
    
                                                          
    if use_similarity:
        sim_service = _get_similarity_service()
        if sim_service and sim_service.is_enabled():
            is_near, score, _ = sim_service.is_semantically_near_expected(
                text, clause_data, threshold=0.75                            
            )
            if is_near:
                return True
    
    return False


def get_clause_options(clause_data: dict, action: str) -> dict:
    """
    Получение доступных опций для пункта договора в зависимости от действия.
    Поддержка нового формата gameData: guide_summary, ideal_option, correct_examples.
    """
    if action == "reject":
        reasons = _reasons_list(clause_data, "rejectionReasons")
        return {"reasons": reasons, "type": "reject"}
    if action == "change":
        reasons = _reasons_list(clause_data, "changeReasons")
        formulations = _formulations_list(clause_data)
        return {"reasons": reasons, "formulations": formulations, "type": "change"}
    if action == "insist":
        reasons = (
            clause_data.get("insistReasons")
            or clause_data.get("rejectionReasons")
            or _reasons_list(clause_data)
        )
        return {"reasons": reasons, "type": "insist"}
    if action == "discuss":
        return {"discussionOptions": ["change", "insist"], "type": "discussion"}
    return {}


def handle_ai_objection_decision(
    clause_data: dict,
    player_choice: dict,
    action: str,
    objection_count: int,
    contract_code: str | None = None,
    new_clause_text: str | None = None,
    chat_history: list | None = None,
    justification_text: str | None = None,
) -> dict:
    """
    Решение бота о возражении в режиме ИИ (портировано по смыслу из v0.5beta).
    """
    def _effective_player_text(default_text: str = "") -> str:
        """
        Принятая редакция при action=change:
        приоритет у свободного текста игрока из чата, затем fallback.
        """
        if action == "change":
            candidate = (new_clause_text or "").strip()
            if candidate:
                return strip_revision_meta_from_clause_draft(candidate)
        return default_text

    def _accept_with_ai_message(handler_response: dict, accepted_text: str) -> dict:
        """Подменяет жёстко заданный message на ответ ИИ-контрагента."""
        ai_msg = generate_acceptance_message_with_ai(
            action, clause_data, accepted_text, contract_code=contract_code,
        )
        if ai_msg:
            handler_response["message"] = ai_msg
        return handler_response

                                                                  
    if objection_count >= MAX_AI_OBJECTIONS:
        if action == "change":
            resp = handle_change_action(clause_data, player_choice)
            chosen_text = _effective_player_text(str(resp.get("replacementText") or ""))
            if chosen_text:
                resp["replacementText"] = chosen_text
            return _accept_with_ai_message(resp, chosen_text)
        if action == "insist":
            resp = handle_insist_action(clause_data, player_choice)
            return _accept_with_ai_message(resp, resp.get("replacementText", ""))
        if action == "reject":
            resp = handle_reject_action(clause_data, player_choice)
            return _accept_with_ai_message(resp, clause_data.get("text", "")[:200])

                                                                                             
    if objection_count == 0:
        raw_proposed = (new_clause_text or "").strip()
        if raw_proposed and _is_same_as_contract_text(raw_proposed, clause_data):
            raw_proposed = ""
        justification_raw = (
            (player_choice.get("justificationText") if isinstance(player_choice, dict) else None)
            or (justification_text or "")
            or ""
        ).strip()
        core_from_just = _extract_core_formulation(justification_raw) if justification_raw else ""
        proposed = (
            raw_proposed
            or _get_proposed_formulation_text(clause_data, player_choice, action)
            or (core_from_just if len(core_from_just) >= 5 else None)
        )
        item_key = f"{action}_{player_choice.get('reasonIndex', '')}_{player_choice.get('changeOptionIndex', player_choice.get('choiceIndex', ''))}"
        if action == "change":
            near_ref = _is_near_expected_formulation(proposed or "", clause_data) or (
                bool(justification_raw) and _is_near_expected_formulation(justification_raw, clause_data)
            )
            if not proposed or not near_ref:
                                                                                                                           
                if _text_contains_formulation_wrapper(justification_raw) or (justification_raw and _is_near_expected_formulation(justification_raw, clause_data)):
                    return {
                        "agrees": False,
                        "message": "Редакция понятна. Поясните, пожалуйста, почему вы предлагаете именно такую формулировку.",
                        "nextStatus": clause_data.get("status", ClauseStatus["SELECTED"]),
                        "requiresJustification": True,
                        "objection": True,
                        "objectionNumber": 1,
                        "itemKey": item_key,
                    }
                                                                                                   
                return {
                    "agrees": False,
                    "message": "Предложите, пожалуйста, конкретную редакцию пункта и кратко обоснуйте её.",
                    "nextStatus": clause_data.get("status", ClauseStatus["SELECTED"]),
                    "requiresJustification": True,
                    "objection": True,
                    "objectionNumber": 1,
                    "itemKey": item_key,
                }
                                                                                       
                                                                                      
                                             
        first_result = evaluate_first_proposal(
            clause_data, action, proposed, contract_code=contract_code,
            chat_history=chat_history,
        )
                                                                                                                  
        if (
            action == "change"
            and not first_result.get("agrees")
            and not first_result.get("needs_justification")
            and _is_near_expected_formulation(proposed or "", clause_data)
            and _looks_like_only_formulation(proposed or "", clause_data)
        ):
            first_result = {
                "agrees": False,
                "needs_justification": True,
                "message": pick_request_explanation_only_fallback(),
            }
        if action == "change" and first_result.get("needs_justification"):
                                                                                      
            return {
                "agrees": False,
                "message": first_result.get("message") or pick_request_explanation_only_fallback(),
                "nextStatus": clause_data.get("status", ClauseStatus["SELECTED"]),
                "requiresJustification": True,
                "objection": False,
                "objectionNumber": 0,
                "itemKey": item_key,
                "awaitingJustification": True,
            }
        if first_result.get("agrees"):
            if action == "change":
                resp = handle_change_action(clause_data, player_choice)
                chosen_text = _effective_player_text(str(resp.get("replacementText") or ""))
                if chosen_text:
                    resp["replacementText"] = chosen_text
                resp["message"] = first_result.get("message") or resp.get("message")
                return resp
            if action == "insist":
                resp = handle_insist_action(clause_data, player_choice)
                resp["message"] = first_result.get("message") or resp.get("message")
                return resp
            if action == "reject":
                resp = handle_reject_action(clause_data, player_choice)
                resp["message"] = first_result.get("message") or resp.get("message")
                return resp
                                                                      
        item_key = f"{action}_{player_choice.get('reasonIndex', '')}_{player_choice.get('changeOptionIndex', player_choice.get('choiceIndex', ''))}"
        return {
            "agrees": False,
            "message": first_result.get("message", "Требуется дополнительное обоснование."),
            "nextStatus": clause_data.get("status", ClauseStatus["SELECTED"]),
            "requiresJustification": True,
            "objection": True,
            "objectionNumber": 1,
            "itemKey": item_key,
        }

                                                                                              
    proposed = _get_proposed_formulation_text(clause_data, player_choice, action)
                                                                                                     
    player_text_for_check = (new_clause_text or "").strip() or proposed or ""
    later_result = evaluate_first_proposal(
        clause_data, action, proposed, contract_code=contract_code,
        chat_history=chat_history,
    )
                                                                                                                          
    if (
        later_result.get("agrees")
        and action == "change"
        and _is_near_expected_formulation(player_text_for_check, clause_data)
        and _looks_like_only_formulation(player_text_for_check, clause_data)
    ):
        later_result = {
            "agrees": False,
            "message": "Редакция понятна. Поясните, пожалуйста, почему вы предлагаете именно такую формулировку.",
        }
    if later_result.get("agrees"):
        if action == "change":
            resp = handle_change_action(clause_data, player_choice)
            chosen_text = _effective_player_text(str(resp.get("replacementText") or ""))
            if chosen_text:
                resp["replacementText"] = chosen_text
            resp["message"] = later_result.get("message") or resp.get("message")
            return resp
        if action == "insist":
            resp = handle_insist_action(clause_data, player_choice)
            resp["message"] = later_result.get("message") or resp.get("message")
            return resp
        if action == "reject":
            resp = handle_reject_action(clause_data, player_choice)
            resp["message"] = later_result.get("message") or resp.get("message")
            return resp

    ai_objection = None
    max_retries = 3
    for attempt in range(max_retries):
        ai_objection = generate_objection_with_ai(
            clause_data, player_choice, action, objection_count + 1,
            contract_code=contract_code,
            chat_history=chat_history,
        )
        if ai_objection:
            break
        if attempt < max_retries - 1:
            time.sleep(0.5)

    if not ai_objection:
        ai_objection = later_result.get("message", "Требуется дополнительное обоснование.")

    item_key = f"{action}_{player_choice.get('reasonIndex', '')}_{player_choice.get('changeOptionIndex', player_choice.get('choiceIndex', ''))}"
    return {
        "agrees": False,
        "message": ai_objection,
        "nextStatus": clause_data.get("status", ClauseStatus["SELECTED"]),
        "requiresJustification": True,
        "objection": True,
        "objectionNumber": objection_count + 1,
        "itemKey": item_key,
    }

              
    return {
        "agrees": False,
        "message": "Не понимаю выбранное действие.",
        "nextStatus": clause_data.get("status", ClauseStatus["AVAILABLE"]),
    }


def process_player_offer_structured(
    clause_data: dict,
    action: str,
    justification_text: str,
    new_clause_text: str | None = None,
    chat_history: list | None = None,
    contract_code: str | None = None,
    bot_reply_count: int = 0,
    patience: int = 100,
) -> ClauseOutcome:
    """
    Обрабатывает ход игрока через структурированную модель.
    
    Это новая точка входа, которая:
    1. Нормализует входные данные (PlayerOffer)
    2. Оценивает предложение детерминированно (OfferEvaluation)
    3. При необходимости вызывает LLM для генерации текста ответа
    4. Определяет итоговый результат (ClauseOutcome)
    
    Возвращает ClauseOutcome с явным типом результата и текстом ответа.
    """
                                    
    offer = normalize_player_offer(
        raw_text=justification_text or "",
        new_clause_text=new_clause_text or "",
        clause_data=clause_data,
        chat_history=chat_history or [],
        action=action,
    )

                                 
    evaluation = evaluate_offer_deterministically(
        offer=offer,
        clause_data=clause_data,
        bot_reply_count=bot_reply_count,
        max_replies=MAX_AI_OBJECTIONS,
        patience=patience,
    )

                                                                              
    llm_message = ""
    llm_agrees = False
    
                                                 
    if evaluation.decision_reason in (
        DecisionReason.FORMULATION_AND_EXPLANATION_OK,
        DecisionReason.FORMULATION_NOT_ACCEPTABLE,
        DecisionReason.LLM_REJECTION,
    ):
        score, explanation, ai_message = evaluate_justification_convincing(
            justification_text or "",
            "formulation",
            offer.formulation_text or "",
            clause_data,
            contract_code=contract_code,
            new_clause_text=new_clause_text,
            chat_history=chat_history,
        )
        llm_message = ai_message or ""
        llm_agrees = score >= THRESHOLD_AGREEMENT
                                       
        if llm_agrees and not evaluation.llm_agrees:
            evaluation.score = max(evaluation.score, score)
            evaluation.llm_agrees = True

                                         
    outcome = determine_clause_outcome(
        offer=offer,
        evaluation=evaluation,
        clause_data=clause_data,
        bot_reply_count=bot_reply_count,
        patience=patience,
        max_replies=MAX_AI_OBJECTIONS,
        llm_message=llm_message,
        llm_agrees=llm_agrees,
    )

                                                                      
    if offer.accepted_counterparty_offer and chat_history:
        clause_id = clause_data.get("id") or clause_data.get("code")
        for msg in reversed(chat_history):
            if msg.get("owner") == "bot" and (
                msg.get("clauseId") == clause_id or msg.get("clauseId") == str(clause_id)
            ):
                last_bot = (msg.get("text") or "").strip()
                if last_bot:
                    agreed_text = _get_formulation_agreed_from_counterpart(clause_data, last_bot)
                    if agreed_text:
                        from services.chat_service import (
                            _fix_common_accepted_clause_typos,
                            _normalize_kazakhstan_republic_name,
                            _normalize_replacement_caps_and_punctuation,
                            _normalize_territory_rf_kz_contract_text,
                        )

                        _ag = agreed_text.strip()
                        _ag, _ = _fix_common_accepted_clause_typos(_ag)
                        _ag, _ = _normalize_kazakhstan_republic_name(_ag)
                        _ag, _ = _normalize_territory_rf_kz_contract_text(_ag, clause_data)
                        outcome.final_replacement_text = _normalize_replacement_caps_and_punctuation(_ag)
                break

    return outcome


def handle_justification_response(
    clause_data: dict,
    player_choice: dict,
    action: str,
    justification_text: str,
    contract_code: str | None = None,
    new_clause_text: str | None = None,
    chat_history: list | None = None,
) -> dict:
    """
    Обработка ответа бота на оправдание игрока.
    Оценивает убедительность и принимает решение.
    Использует ответ ИИ-контрагента (message), а не шаблонные фразы.
    """
                                            
    item_text = ""
    item_type = "reason"

    if action == "change":
        reason_index = player_choice.get("changeReasonIndex") or player_choice.get("reasonIndex")
        choice_index = player_choice.get("changeOptionIndex") or player_choice.get("choiceIndex")

        reasons = clause_data.get("changeReasons", [])
        if (
            reason_index is not None
            and isinstance(reasons, list)
            and reason_index < len(reasons)
        ):
            reason_data = reasons[reason_index]
            item_text = reason_data["text"] if isinstance(reason_data, dict) else reason_data
            item_type = "reason"

        formulations = clause_data.get("changeOptions", [])
        if isinstance(formulations, list) and choice_index is not None:
            if (
                reason_index is not None
                and reason_index < len(formulations)
                and isinstance(formulations[reason_index], list)
            ):
                reason_formulations = formulations[reason_index]
                if choice_index < len(reason_formulations):
                    formulation_data = reason_formulations[choice_index]
                    formulation_text = (
                        formulation_data["text"]
                        if isinstance(formulation_data, dict)
                        else formulation_data
                    )
                    item_text = formulation_text
                    item_type = "formulation"
    elif action == "insist":
        reason_index = player_choice.get("reasonIndex")
        reasons = clause_data.get("insistReasons") or clause_data.get("rejectionReasons", [])
        if (
            reason_index is not None
            and isinstance(reasons, list)
            and reason_index < len(reasons)
        ):
            reason_data = reasons[reason_index]
            item_text = reason_data["text"] if isinstance(reason_data, dict) else reason_data
            item_type = "reason"

                                                                                                     
                                                                                                      
    raw_new = (new_clause_text or "").strip()
    if raw_new and _is_same_as_contract_text(raw_new, clause_data):
        raw_new = ""
    proposed_text_for_eval = raw_new or _get_proposed_formulation_text(clause_data, player_choice, action)
    if not proposed_text_for_eval and justification_text:
        proposed_text_for_eval = (justification_text or "").strip()
    substantive_justification = _is_substantive_justification(justification_text)
    near_expected_formulation = _is_near_expected_formulation(proposed_text_for_eval, clause_data) or _is_near_expected_formulation(
        (justification_text or "").strip(), clause_data
    )
    if action == "change":
        can_agree, request_msg = _check_change_requires_both_revision_and_explanation(
            action, clause_data, justification_text, new_clause_text,
            proposed_text_for_eval, substantive_justification, near_expected_formulation, chat_history,
        )
        if not can_agree and request_msg:
            return {
                "agrees": False,
                "message": request_msg,
                "nextStatus": clause_data.get("status", ClauseStatus["SELECTED"]),
                "requiresJustification": True,
                "objection": True,
                "objectionNumber": 1,
                "replacementText": None,
                "points": 0,
                "convincingScore": 50,
            }

    score, explanation, ai_message = evaluate_justification_convincing(
        justification_text, item_type, item_text, clause_data,
        contract_code=contract_code,
        new_clause_text=new_clause_text,
        chat_history=chat_history,
    )

    if _is_correct_justification_by_rules(justification_text, clause_data):
        score = max(score, THRESHOLD_AGREEMENT)
        if _is_clarification_request(ai_message):
            ai_message = "Понимаю вашу аргументацию. По этому пункту ваша редакция выглядит обоснованной."

                                                                                             
                                                                               
    if _is_clarification_request(ai_message) and substantive_justification:
        if action == "change" and near_expected_formulation:
            score = max(score, THRESHOLD_AGREEMENT)
            ai_message = "Понимаю вашу аргументацию. Эту редакцию можно зафиксировать."
        else:
            ai_message = (
                "Понимаю вашу позицию, но пока не вижу достаточных оснований менять этот пункт именно в такой редакции."
            )

                                                                                                         
    if score < THRESHOLD_AGREEMENT and ai_message:
        msg_lower = (ai_message or "").strip().lower()
        agreement_markers = (
            "принимаем",
            "согласны",
            "согласен",
            "принимаем предложенную",
            "принимаем вашу редакцию",
            "ок, принимаем",
            "хорошо, принимаем",
            "фиксируем в такой редакции",
        )
        if any(m in msg_lower for m in agreement_markers):
            score = THRESHOLD_AGREEMENT
    bot_preferred = _compute_bot_preferred_text(clause_data)

                                                                                                   
    if score >= THRESHOLD_AGREEMENT and _looks_like_only_formulation(justification_text, clause_data):
        return {
            "agrees": False,
            "message": "Редакция понятна. Поясните, пожалуйста, почему вы предлагаете именно такую формулировку.",
            "nextStatus": clause_data.get("status", ClauseStatus["SELECTED"]),
            "requiresJustification": True,
            "objection": True,
            "objectionNumber": 1,
            "replacementText": None,
            "points": 0,
            "convincingScore": score,
        }

    if score >= THRESHOLD_AGREEMENT:
                                                                   
        if action == "change":
            proposed_text = (new_clause_text or "").strip()
                                                                                                              
            if proposed_text and _is_same_as_contract_text(proposed_text, clause_data):
                proposed_text = ""
            if not proposed_text:
                                                                                                  
                fallback_resp = handle_change_action(clause_data, player_choice)
                proposed_text = str(fallback_resp.get("replacementText") or "").strip()
            if not proposed_text:
                cleaned_just = _strip_intro_phrases((justification_text or "").strip())
                if _is_near_expected_formulation(cleaned_just, clause_data):
                                                                                                
                    proposed_text = cleaned_just
            if not proposed_text and chat_history:
                                                                                                                                         
                clause_id = clause_data.get("id") or clause_data.get("code")
                last_bot_text = None
                for m in reversed(chat_history):
                    if m.get("owner") == "bot" and (m.get("clauseId") == clause_id or m.get("clauseId") == str(clause_id)):
                        last_bot_text = (m.get("text") or "").strip()
                        break
                if last_bot_text:
                    j_lower = (justification_text or "").lower()
                    agree_markers = ("устраивает", "согласен", "согласна", "принимаем", "принимаю", "да, хорошо", "подходит")
                    if any(m in j_lower for m in agree_markers):
                        proposed_text = _get_formulation_agreed_from_counterpart(clause_data, last_bot_text)
            if not proposed_text and chat_history:
                                                                                                                                                     
                cid = clause_data.get("id") or clause_data.get("code")
                for m in reversed(chat_history):
                    if m.get("owner") != "player" or (m.get("clauseId") != cid and m.get("clauseId") != str(cid)):
                        continue
                    prev_text = (m.get("text") or "").strip()
                    if not prev_text or len(prev_text) < 10:
                        continue
                    if _is_near_expected_formulation(prev_text, clause_data):
                        core = _extract_core_formulation(prev_text).strip()
                        proposed_text = core if len(core) >= 10 else prev_text
                        break
                    if _text_contains_formulation_wrapper(prev_text):
                        core = _extract_core_formulation(prev_text).strip()
                        if core and _is_near_expected_formulation(core, clause_data):
                            proposed_text = core if len(core) >= 10 else prev_text
                            break
            if not proposed_text:
                                                                                                         
                return {
                    "agrees": False,
                    "message": ai_message if (ai_message and ai_message.strip()) else "Чтобы согласовать пункт, предложите конкретную новую редакцию и кратко обоснуйте её.",
                    "nextStatus": ClauseStatus["SELECTED"],
                    "replacementText": None,
                    "points": 0,
                    "convincingScore": score,
                }
            response = handle_change_action(clause_data, player_choice)
                                                                                  
                                                                                                                              
            response["replacementText"] = proposed_text if proposed_text else (response.get("replacementText") or "")
            response["message"] = ai_message
            response["convincingScore"] = score
            response["agrees"] = True
            return response
        if action == "insist":
            response = handle_insist_action(clause_data, player_choice)
            response["message"] = ai_message
            response["convincingScore"] = score
            response["agrees"] = True
            return response
        if action == "reject":
            response = handle_reject_action(clause_data, player_choice)
            response["message"] = ai_message
            response["convincingScore"] = score
            response["agrees"] = True
            return response
    else:
                                                                                                     
        if score < THRESHOLD_ERROR:
            return {
                "agrees": False,
                "message": ai_message,
                "nextStatus": ClauseStatus["ACCEPTED_BOT"],
                "replacementText": bot_preferred,
                "points": 0,
                "convincingScore": score,
            }
                                                                             
        return {
            "agrees": False,
            "message": ai_message,
            "nextStatus": ClauseStatus["SELECTED"],
            "replacementText": None,
            "points": 0,
            "convincingScore": score,
        }
