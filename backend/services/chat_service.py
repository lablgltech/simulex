"""
Chat service для этапа 3.

- хранит историю чата в negotiation_session.history_json;
- использует document_service для статусов пунктов;
- переговоры по пункту — только v2 (`_send_message_v2` / negotiation_v2_runtime);
- для оправданий игрока использует ai_chat_service.evaluate_justification_with_ai.

Терпение бота (patience): та же экономика списания, что на этапе 1 (`stage1_context_chat._calc_new_patience`):
clarify −12, off_topic с нарастанием 25 / 50 / 100, full/partial/document — без списания; потолок `PATIENCE_MAX` (100).
Переговоры по пункту не должны противоречить системному промпту и промпту кейса: при эталонной формулировке
без пояснения бот просит обоснование — ход классифицируется как clarify (умеренное списание), а не off_topic.
"""

from __future__ import annotations

import difflib
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from typing import Dict, Any

from services.document_service import (
    ClauseStatus,
    get_bot_messages_for_session,
    get_contract_clauses_for_session,
    get_contract_code_for_session,
    update_clause_status_for_session,
)
from services.ai_lessons_service import add_global_ai_lesson, get_global_ai_lessons
from services.negotiation_session_service import (
    get_case_code_for_negotiation_session,
    get_negotiation_history,
    save_negotiation_history,
)
import logging

logger = logging.getLogger(__name__)

from dev_mirror_log import append_mirror_block
from services.negotiation_trace import negotiation_trace_add_phase

from services.stage1_context_chat import PATIENCE_MAX, _calc_new_patience

from services.bot_logic import (
    get_clause_options,
    find_best_matching_ideal_option,
    _get_formulation_agreed_from_counterpart as bot_get_formulation_agreed_from_counterpart,
)
from services.case_prompt_service import extract_clean_formulation
from services.negotiation_models import OutcomeType, ClauseOutcome
from services.stage1_context_chat import _contains_sexual_harassment
from services.ai_counterpart_rules import (
    MESSAGE_CLARIFY_DEFECTIVE_FORMULATION,
    _pick_reject_placeholder_junk_message,
    formulation_contains_placeholder_or_filler_junk,
    apply_message_rules,
    sanitize_bot_reply_revision_fields_nonempty,
    sanitize_bot_reply_full_position_objection,
    extract_primary_quoted_clause_candidate,
    formulation_is_incomplete_or_unacceptable,
    pick_formulation_candidate_for_defective_screening,
    strip_clause_answer_cheatsheet_from_reply,
    bot_message_leaks_clause_ideal_enumeration,
    pick_generic_no_cheatsheet_objection_message,
    negotiation_max_player_turns_before_close,
    count_player_turns_in_current_chat_session,
    pick_negotiation_impasse_close_message,
    clause_exclusion_negotiation_allowed,
    reject_clause_removal_reply_message,
    has_explanation_markers,
    is_real_explanation,
    avoid_repeating_same_reply,
    extract_embedded_formulation_from_explanation,
    formulation_acceptable_po_4_1_standard_structure,
    strip_revision_meta_from_clause_draft,
    ensure_acceptance_message_when_agreed,
    formulation_9_2_proposes_change_but_missing_notice_period,
    bot_message_accepts_clause_exclusion,
    bot_message_signals_acceptance_of_player_revision,
    player_text_indicates_clause_exclusion_intent,
    player_current_turn_seeks_clause_revision_not_removal,
    accumulated_player_text_suggests_explicit_clause_removal,
    prefix_bot_close_if_player_sent_revision_draft,
    _player_ever_proposed_remove_clause,
    strip_negotiation_bot_vocative_from_reply,
    strip_negotiation_repeated_collega_vocative,
    sanitize_1_4_2_bot_avoid_explicit_111_reference,
    is_off_topic_message,
    player_interrogative_non_contract_should_close_negotiation,
    is_bare_non_substantive_player_reply,
    player_says_dont_know,
    last_bot_asked_formulation_and_explanation,
    player_turn_lacks_revision_and_explanation,
    player_message_is_non_constructive,
    pick_close_rude_threat_message,
    pick_negotiation_mild_rude_message,
    negotiation_rude_tone_llm_enabled,
    player_message_mild_interpersonal_rude_heuristic,
    player_negotiation_mild_rude_tone_via_llm,
    player_uses_rude_or_threatening_negotiation_tone,
    is_question_about_clause,
    is_followup_clarification_question,
    pick_no_spoiler_question_reply,
    contains_profanity,
    looks_like_gibberish,
    negotiation_any_field_has_clause_linked_question,
    player_message_should_use_llm_dialogue_reply,
    player_message_blocks_automatic_counterpart_keep,
    message_incomplete_after_vague_followup,
    llm_matches_playbook_intent,
    negotiation_playbook_bot_reply,
    player_history_has_revision_proposal,
    territory_formulation_worldwide_with_redundant_extra_territory,
    liability_6_3_risk_acceptance_blob_ok,
    removal_explanation_qualifies_for_accept,
    _territory_formulation_aligns_with_ideal_options,
    _territory_formulation_mentions_territorial_scope,
    _territory_raw_contains_disallowed_country_marker,
    _accumulated_player_text_for_clause,
    negotiation_clause_is_acts_profile,
    negotiation_clause_is_termination_notice_profile,
)

                                                                                                         
_NEGOTIATION_CLOSE_NONFINAL_RE = re.compile(
    r"[?]|"
    r"\b(?:уточните|поясните|пришлите|напишите|скажите|сообщите|опишите|разъясните|ответьте|"
    r"направьте|предложите|подготовьте|укажите|допишите|вышлите|напомните|расскажите|распишите|"
    r"пожалуйста\s+пришлите|не\s+могли\s+бы|могли\s+бы\s+вы|готовы\s+ли|есть\s+ли\s+у\s+вас|"
    r"хотелось\s+бы|можете\s+пояснить|можете\s+уточнить)\b",
    re.IGNORECASE,
)


def _negotiation_close_reply_is_nonfinal(text: str) -> bool:
    s = (text or "").strip()
    if not s:
        return True
    return bool(_NEGOTIATION_CLOSE_NONFINAL_RE.search(s))


def _pick_impasse_close_template(bot_messages: dict) -> str | None:
    for key in ("close_counterpart_wins", "move_to_next_clause"):
        raw = bot_messages.get(key)
        if isinstance(raw, list) and raw:
            return random.choice(raw)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def _pick_agreement_close_template(bot_messages: dict) -> str | None:
    ex = bot_messages.get("examples_agreement")
    if isinstance(ex, list) and ex:
        return random.choice(ex)
    aw = bot_messages.get("acceptance_when_agreed")
    if isinstance(aw, str) and aw.strip():
        return aw.strip()
    return None


def _ensure_final_negotiation_close_message(
    bot_message_text: str,
    *,
    chat_complete: bool,
    agrees: bool,
    bot_messages: dict,
) -> str:
    """
    Если диалог по пункту закрывается, последняя реплика контрагента не должна спрашивать и просить.
    При нарушении — одна подстановка из шаблонов кейса (без дополнительных вызовов LLM).
    """
    if not chat_complete:
        return bot_message_text
    if not _negotiation_close_reply_is_nonfinal(bot_message_text):
        return bot_message_text
    if agrees:
        picked = (
            _pick_agreement_close_template(bot_messages)
            or "Согласуем пункт в обсуждаемой редакции."
        )
    else:
        picked = (
            _pick_impasse_close_template(bot_messages)
            or "По этому пункту оставляем текущую редакцию договора."
        )
    if _negotiation_close_reply_is_nonfinal(picked):
        return (
            "Согласуем пункт в обсуждаемой редакции."
            if agrees
            else "По этому пункту оставляем текущую редакцию договора."
        )
    return picked


def _is_short_etalon_phrase(text: str, clause_data: dict) -> bool:
    """
    True, если текст — короткая эталонная фраза («весь мир», «на территории мира»),
    которую не стоит подставлять в договор как есть (нужна полная формулировка с заглавной и точкой).

    Длинные формулировки игрока (например «На территории всего мира») не подменяем на первый ideal_option —
    смысл должен остаться близок к предложенному тексту.
    """
    if not text or len(text.strip()) > 40:
        return False
                                                                                         
    if len(text.strip()) > 22:
        return False
    lower = text.strip().lower().rstrip(".,;:!?")
    phrases = clause_data.get("etalon_phrases") or []
    if not phrases:
        return False
    for p in phrases:
        if isinstance(p, str) and p.strip():
            if lower == p.strip().lower() or lower in p.strip().lower() or p.strip().lower() in lower:
                return True
    return False


def _normalize_replacement_caps_and_punctuation(text: str) -> str:
    """
    Приводит формулировку к виду для договора: заглавная в начале;
    точка в конце пункта, если игрок/эталон её не поставили.

    Закрывающие кавычки и скобки учитываются: «…текст» → «…текст.»
    """
    if not text or not text.strip():
        return text
    s = text.strip()
    if len(s) <= 1:
        return s.upper()
    if s[0].islower():
        s = s[0].upper() + s[1:]
                                                                                              
    _closers = frozenset(('»', '"', "'", ")", "]"))
    body, suffix = s, ""
    while body and body[-1] in _closers:
        suffix = body[-1] + suffix
        body = body[:-1].rstrip()
    if not body:
        return s
    _terminals = frozenset(".;!?…")
    if body[-1] not in _terminals:
        body = body + "."
    return body + suffix


def _fix_common_accepted_clause_typos(text: str | None) -> tuple[str, bool]:
    """
    Исправляет типичные опечатки в принятой редакции перед вставкой в договор (любой пункт/кейс).
    Только высокоуверенные замены по границам слов (род/падеж после предлогов и т.п.).
    Возвращает (текст, было_ли_изменение).
    """
    if not text or not str(text).strip():
        return (text or "") or "", False
    s = str(text)
    original = s
                                                                                   
    s = re.sub(r"\bот\s+Договор\b", "от Договора", s)
    s = re.sub(r"\bот\s+договор\b", "от договора", s)
                          
    s = re.sub(r"\bпо\s+Договор\b", "по Договору", s)
    s = re.sub(r"\bпо\s+договор\b", "по договору", s)
                     
    s = re.sub(r"\bсогласно\s+Договор\b", "согласно Договору", s)
    s = re.sub(r"\bсогласно\s+договор\b", "согласно договору", s)
    return s, s != original


                                                                                            
MESSAGE_KAZAKHSTAN_REPUBLIC_CLARIFICATION = (
    "Уточнение: в тексте пункта для договора указано официальное наименование "
    "«Республика Казахстан» (в соответствующей грамматической форме)."
)


def _already_has_official_kazakhstan_name(text: str) -> bool:
    """Уже есть связка «Республика* + Казахстан» — не трогаем."""
    if not text:
        return False
    return bool(
        re.search(r"республик[а-яё]{0,4}\s+казахстан\b", text, re.IGNORECASE)
    )


def _normalize_kazakhstan_republic_name(text: str | None) -> tuple[str, bool]:
    """
    Краткая форма «Казахстан» в договорной формулировке заменяется на официальное наименование
    с падежами: Республика Казахстан / Республики Казахстан / Республике Казахстан и т.д.
    Возвращает (новый_текст, было_ли_изменение).
    """
    if not text or not str(text).strip():
        return (text or "") or "", False
    s = str(text).strip()
    if _already_has_official_kazakhstan_name(s):
        return s, False
    if "казахстан" not in s.lower():
        return s, False
    original = s
                                                                                              
    s = re.sub(
        r"(?<![а-яА-ЯёЁ])Казахстана\b",
        "Республики Казахстан",
        s,
        flags=re.IGNORECASE,
    )
    s = re.sub(
        r"(?<![а-яА-ЯёЁ])Казахстане\b",
        "Республике Казахстан",
        s,
        flags=re.IGNORECASE,
    )
    s = re.sub(
        r"(?<![а-яА-ЯёЁ])Казахстаном\b",
        "Республикой Казахстан",
        s,
        flags=re.IGNORECASE,
    )
    s = re.sub(
        r"(?<![а-яА-ЯёЁ])Казахстану\b",
        "Республике Казахстан",
        s,
        flags=re.IGNORECASE,
    )
                                                                                             
    def _nominative_repl(m: re.Match) -> str:
        start = m.start()
        prefix = s[:start].rstrip()
        low = prefix.lower()
        for tail in (
            "республики",
            "республике",
            "республикой",
            "республикам",
            "республиках",
            "республика",
        ):
            if low.endswith(tail):
                return m.group(0)
        return "Республика Казахстан"

    s = re.sub(
        r"(?<![а-яА-ЯёЁ])Казахстан\b",
        _nominative_repl,
        s,
        flags=re.IGNORECASE,
    )
    changed = s != original
    return s, changed


def _fold_territory_clause_compare(text: str) -> str:
    """Сравнение формулировок п. 1.4.1 без пунктуации и пробелов."""
    return re.sub(r"[^0-9a-zа-яё]+", "", (text or "").lower())


def _normalize_territory_rf_kz_contract_text(
    text: str | None, clause_data: dict | None
) -> tuple[str, bool]:
    """
    П. 1.4.1: единая каноническая договорная формулировка для связки РФ + Казахстан
    («на территории …»), чтобы не оставалось ошибок вроде «России и Республика Казахстан».
    Вариант «весь мир» и формулировки без «на территории» не трогаем.
    """
    if not text or not clause_data:
        return (text or "") or "", False
    _cid = str((clause_data.get("id") or "")).strip()
    _is_territory = (clause_data.get("negotiation_profile") or "").strip() == "territory" or _cid.endswith(
        "_territory"
    )
    if not _is_territory:
        return text, False
    s = text.strip()
    if not s:
        return s, False
    low = s.lower()
    if any(
        m in low
        for m in (
            "весь мир",
            "всего мира",
            "по всему миру",
            "на территории всего мира",
            "территория всего мира",
        )
    ):
        return s, False
    if "казахстан" not in low:
        return s, False
    if not re.search(r"\bрф\b|росси", low):
        return s, False
    if not re.search(r"(?:на\s+)?территори", low):
        return s, False

    canonical = "На территории Российской Федерации и Республики Казахстан"
    prefix = ""
    rest = s
    if re.match(r"^\s*только\s+", s, flags=re.IGNORECASE):
        prefix = "Только "
        rest = re.sub(r"^\s*только\s+", "", s, flags=re.IGNORECASE).strip()

    desired = (
        prefix + canonical[0].lower() + canonical[1:]
        if prefix
        else canonical
    )
    if _fold_territory_clause_compare(desired) == _fold_territory_clause_compare(s):
        return s, False
    return desired, True


def _apply_accepted_replacement_normalization(
    text: str | None, clause_data: dict
) -> tuple[str | None, bool]:
    """
    Единая цепочка для текста замены в договоре после согласия (v1 и v2).

    П. 1.4.1 / 1.4.2: канон из кейса (ideal_options), затем капитализация, опечатки,
    официальное наименование Казахстана, канон РФ+КЗ при необходимости.

    Прочие пункты: формулировка игрока — только заглавная, точка в конце, типовые опечатки.
    Возвращает (текст_или_None, меняли_ли_Казахстан_на_Республику_Казахстан).
    """
    if not text or not str(text).strip():
        return None, False
    s = (text or "").strip()
    if _clause_uses_case_canonical_for_contract(clause_data):
        replacement_text = _normalize_replacement_for_contract(text, clause_data) or text
    else:
        replacement_text = s
    replacement_text = _normalize_replacement_caps_and_punctuation((replacement_text or "").strip())
    replacement_text, typo_fixed = _fix_common_accepted_clause_typos((replacement_text or "").strip())
    if typo_fixed:
        replacement_text = _normalize_replacement_caps_and_punctuation((replacement_text or "").strip())
    if not _clause_uses_case_canonical_for_contract(clause_data):
        out = (replacement_text or "").strip()
        return (out or None), False
    replacement_text, kz_republic_fixed = _normalize_kazakhstan_republic_name((replacement_text or "").strip())
    if kz_republic_fixed:
        replacement_text = _normalize_replacement_caps_and_punctuation((replacement_text or "").strip())
    replacement_text, rf_kz_territory_fixed = _normalize_territory_rf_kz_contract_text(
        (replacement_text or "").strip(), clause_data
    )
    if rf_kz_territory_fixed:
        replacement_text = _normalize_replacement_caps_and_punctuation((replacement_text or "").strip())
    out = (replacement_text or "").strip()
    return (out or None), bool(kz_republic_fixed)


def _append_bot_sentence(message: str, addition: str) -> str:
    """Добавить предложение к реплике бота без дублирования."""
    m = (message or "").strip()
    a = (addition or "").strip()
    if not a:
        return m
    if a in m:
        return m
    if not m:
        return a
    if m[-1] in ".!?…":
        return f"{m} {a}"
    return f"{m}. {a}"


                                                                                                                             
_BOT_PROPOSED_REVISION_RE = re.compile(
    r"Редакция\s*[:\s]+[«\"]([^»\"]+)[»\"]",
    re.IGNORECASE,
)


def _get_last_bot_proposed_clause_revision(clause_history: list | None) -> str:
    """Текст пункта из последнего сообщения бота с маркером «Редакция: …», если есть."""
    if not clause_history:
        return ""
    for m in reversed(clause_history):
        if m.get("owner") != "bot":
            continue
        text = (m.get("text") or m.get("message") or "").strip()
        if not text:
            continue
        mm = _BOT_PROPOSED_REVISION_RE.search(text)
        if mm:
            rev = (mm.group(1) or "").strip()
            if len(rev) >= 3:
                return rev
    return ""


def _normalize_clause_draft_for_compare(s: str) -> str:
    if not s:
        return ""
    a = re.sub(r"[^\w\s]", "", s.lower().replace("ё", "е"))
    return re.sub(r"\s+", " ", a).strip()


def _draft_texts_equivalent_for_negotiation(a: str, b: str) -> bool:
    """
    Совпадение черновика пункта у игрока с черновиком контрагента (допускает пунктуацию/регистр,
    для длинных текстов — небольшое расхождение по difflib).
    """
    if not a or not b:
        return False
    ca = _normalize_clause_draft_for_compare(a)
    cb = _normalize_clause_draft_for_compare(b)
    if not ca or not cb:
        return False
    if ca == cb:
        return True
    if min(len(ca), len(cb)) < 12:
        return False
    return difflib.SequenceMatcher(None, ca, cb).ratio() >= 0.88


def _get_counterpart_last_proposed_formulation_text(
    clause_history: list | None,
    clause_data: dict,
    last_bot_message_text: str,
) -> str:
    """
    Последняя редакция, которую предложил контрагент: явная «Редакция: «…»» или извлечённая из реплики бота.
    """
    explicit = _get_last_bot_proposed_clause_revision(clause_history)
    if explicit and len(explicit.strip()) >= 3:
        return explicit.strip()
    if last_bot_message_text and len(last_bot_message_text.strip()) >= 5:
        extracted = bot_get_formulation_agreed_from_counterpart(clause_data, last_bot_message_text)
        if extracted and len(extracted.strip()) >= 5:
            return extracted.strip()
    return ""


def _pick_player_accepts_counterpart_close_message(bot_messages: dict | None) -> str:
    """Короткое подтверждение при явном согласии игрока с последней редакцией контрагента."""
    if bot_messages:
        for key in ("player_accepts_counterpart_revision", "agreed_counterpart_keep"):
            raw = bot_messages.get(key)
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
            if isinstance(raw, list):
                opts = [x for x in raw if isinstance(x, str) and x.strip()]
                if opts:
                    return random.choice(opts)
    return "Принято: по этому пункту остаёмся при нашей редакции."


def _pick_counterpart_revision_echo_message(bot_messages: dict | None) -> str:
    """Ответ, когда игрок прислал ту же формулировку, что уже была предложена контрагентом."""
    if bot_messages:
        raw = bot_messages.get("player_echoes_counterpart_revision")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        if isinstance(raw, list):
            opts = [x for x in raw if isinstance(x, str) and x.strip()]
            if opts:
                return random.choice(opts)
    return (
        "Вы присылаете ту же формулировку, что мы уже предложили в этой переписке по этому пункту. "
        "С нашей стороны возражений к ней нет — это наша редакция. "
        "Если вам нужно изменить условие или обсудить другое — уточните, пожалуйста."
    )


def _clause_uses_case_canonical_for_contract(clause_data: dict | None) -> bool:
    """
    П. 1.4.1 и 1.4.2: в договор подставляется канон из ideal_options / эталонов кейса.
    Остальные пункты: текст игрока с опечатками, заглавной буквой и точкой в конце.
    """
    if not clause_data:
        return False
    num = str(clause_data.get("number") or "").strip()
    if num in ("1.4.1", "1.4.2"):
        return True
    cid = str(clause_data.get("id") or "").strip()
    return cid.startswith("1.4.1") or cid.startswith("1.4.2")


def _replacement_changed_substantively(before: str, after: str) -> bool:
    """
    True, если текст при подстановке в договор изменился по смыслу (не только пунктуация/регистр).
    Если изменилась только пунктуация или заглавные — не показываем фразу про «нормы русского языка».
    """
    if not before or not after:
        return bool(after and before and after.strip() != before.strip())
    a = re.sub(r"[^\w\s]", "", before.strip().lower())
    b = re.sub(r"[^\w\s]", "", after.strip().lower())
    a = re.sub(r"\s+", " ", a).strip()
    b = re.sub(r"\s+", " ", b).strip()
    return a != b


def _normalize_replacement_for_contract(text: str | None, clause_data: dict) -> str | None:
    """
    Нормализует текст для подстановки в договор: короткие эталонные фразы
    («весь мир», «на территории мира») заменяются на полную формулировку,
    приводится заглавная буква и пунктуация.

    Полное сопоставление с ideal_options — только для п. 1.4.1 и 1.4.2; для остальных
    пунктов см. _apply_accepted_replacement_normalization (текст игрока без подмены на канон).
    """
    if not text or not text.strip():
        return text
    s = text.strip()
    if not _clause_uses_case_canonical_for_contract(clause_data):
        return _normalize_replacement_caps_and_punctuation(s)
                                                                                                                
    resolved = find_best_matching_ideal_option(s, clause_data)
    if resolved and resolved.strip():
        s = resolved.strip()
    if _is_short_etalon_phrase(s, clause_data):
        best = find_best_matching_ideal_option(s, clause_data)
        if best and best.strip():
            return _normalize_replacement_caps_and_punctuation(best.strip())
    return _normalize_replacement_caps_and_punctuation(s)


def _get_clean_replacement_text(
    player_text: str,
    clause_data: dict,
    case_code: str,
    clause_id: str,
) -> str:
    """
    Извлекает чистую формулировку для замены в договоре.
    
    Если игрок написал "На территории всего мира, поскольку наши сотрудники...",
    возвращает только "На территории всего мира" — без пояснения.
    Для п. 1.4.1 / 1.4.2 короткие эталонные фразы подменяются на полную формулировку из кейса.
    Для остальных пунктов — формулировка игрока (после extract_clean_formulation), без подмены на ideal_options.
    
    Приоритет (только для 1.4.1 / 1.4.2 — см. _clause_uses_case_canonical_for_contract):
    1. Эталонная формулировка из промпта (extract_clean_formulation)
    2. Короткая эталонная фраза → ideal_options через find_best_matching_ideal_option
    3. find_best_matching_ideal_option из clause_data
    4. ideal_option из clause_data
    """
    _canon = _clause_uses_case_canonical_for_contract(clause_data)

    if not _canon:
        if not player_text or not str(player_text).strip():
            return ""
        if len(player_text.strip()) < 5:
            return _normalize_replacement_caps_and_punctuation(player_text.strip())
        clean = extract_clean_formulation(player_text, case_code, clause_id)
        if clean and len(clean.strip()) >= 5:
            return _normalize_replacement_caps_and_punctuation(clean.strip())
        return _normalize_replacement_caps_and_punctuation(player_text.strip())

    if not player_text or len(player_text.strip()) < 5:
        raw = (
            clause_data.get("ideal_option")
            or (clause_data.get("ideal_options") or [None])[0]
            or ""
        )
        if isinstance(raw, dict):
            raw = raw.get("text", "") or ""
        return _normalize_replacement_caps_and_punctuation((raw or "").strip() or player_text)

    clean = extract_clean_formulation(player_text, case_code, clause_id)
    if clean and len(clean.strip()) >= 5:
                                                                                                    
        if _is_short_etalon_phrase(clean, clause_data):
            best = find_best_matching_ideal_option(clean, clause_data)
            if best and len(best.strip()) >= 5:
                return _normalize_replacement_caps_and_punctuation(best.strip())
                                                                            
        return _normalize_replacement_caps_and_punctuation(clean.strip())

    best = find_best_matching_ideal_option(player_text, clause_data)
    if best and len(best.strip()) >= 5:
        return _normalize_replacement_caps_and_punctuation(best.strip())

    raw = (
        clause_data.get("ideal_option")
        or (clause_data.get("ideal_options") or [None])[0]
        or ""
    )
    if isinstance(raw, dict):
        raw = raw.get("text", "") or ""
    result = (raw or "").strip() or player_text
    return _normalize_replacement_caps_and_punctuation(result)


def _persist_clause_outcome(
    history: Dict[str, Any],
    clause_id: str,
    clause_data: Dict[str, Any],
    outcome: ClauseOutcome,
) -> None:
    """
    Единая точка записи результата переговоров по пункту.
    
    Обновляет:
    - history["clause_status"][clause_id] — статус пункта
    - history["clause_replacements"][clause_id] — текст замены (если есть)
    - history["clause_replacements"][number] — дублируем по номеру для document_service
    - history["excluded_clause_ids"] — при исключении пункта из договора (не подставлять текст реплики)
    
    Это устраняет проблему "дрейфа": запись состояния теперь в одном месте.
    """
    clause_status_map = history.get("clause_status") or {}
    repl_map = history.get("clause_replacements") or {}
    
    cid = str(clause_id)
    num = clause_data.get("number")
    num_str = str(num) if num is not None else None

    if outcome.clause_excluded:
        excl = list(history.get("excluded_clause_ids") or [])
        for key in (cid, num_str):
            if not key:
                continue
            if key not in excl:
                excl.append(key)
        history["excluded_clause_ids"] = excl
        clause_status_map[cid] = ClauseStatus["EXCLUDED"]
        if num_str and num_str != cid:
            clause_status_map[num_str] = ClauseStatus["EXCLUDED"]
        repl_map.pop(cid, None)
        if num_str:
            repl_map.pop(num_str, None)
        history["clause_status"] = clause_status_map
        history["clause_replacements"] = repl_map
        return
    
                       
    clause_status_map[cid] = outcome.next_status
    if num_str and num_str != cid:
        clause_status_map[num_str] = outcome.next_status
    
                             
    if outcome.final_replacement_text:
        repl_map[cid] = outcome.final_replacement_text
        if num_str and num_str != cid:
            repl_map[num_str] = outcome.final_replacement_text
    else:
                                                  
        repl_map.pop(cid, None)
        if num_str:
            repl_map.pop(num_str, None)
    
    history["clause_status"] = clause_status_map
    history["clause_replacements"] = repl_map


def _build_outcome_from_legacy_response(
    bot_response: Dict[str, Any],
    replacement_text: str | None,
    chat_complete: bool,
) -> ClauseOutcome:
    """
    Преобразует старый формат ответа bot_logic в ClauseOutcome.
    Используется для обратной совместимости во время рефакторинга.
    """
    outcome = ClauseOutcome()
    outcome.next_status = bot_response.get("nextStatus", 1)
    outcome.final_replacement_text = replacement_text
    outcome.bot_message = bot_response.get("message", "")
    outcome.score = bot_response.get("convincingScore", 50.0)
    outcome.chat_complete = chat_complete
    
                                         
    if bot_response.get("agrees"):
        if replacement_text:
            outcome.outcome_type = OutcomeType.ACCEPTED_PLAYER_CHANGE
        else:
            outcome.outcome_type = OutcomeType.KEPT_ORIGINAL
    elif chat_complete:
        outcome.outcome_type = OutcomeType.CLOSED_NO_AGREEMENT
    else:
        outcome.outcome_type = OutcomeType.PENDING
    
    return outcome


def _get_chat_history_for_clause(history: Dict[str, Any], clause_id: str) -> list:
    """История переговоров только по указанному пункту договора.
    Объединяет сообщения по точному ключу и по числовому номеру пункта (1.4.1 и 1.4.1_territory → одна история),
    чтобы не терять реплики, если в разных запросах использовались разные форматы clause_id.
    """
    by_clause = history.get("chat_history_by_clause") or {}
    cid = str(clause_id or "").strip()
    num_match = re.match(r"(\d+\.\d+(?:\.\d+)?)", cid)
    clause_num = num_match.group(1) if num_match else cid
    out = list(by_clause.get(cid, []) or [])
    if clause_num != cid:
        out.extend(by_clause.get(clause_num, []) or [])
    if not out and cid:
        for key in by_clause:
            if key == cid or key.startswith(cid + "_") or (clause_num and key == clause_num):
                out = list(by_clause.get(key, []) or [])
                break
    out.sort(key=lambda m: (m.get("timestamp") or ""))
    return out


def _get_chat_history_for_clause_exact(history: Dict[str, Any], clause_id: str) -> list:
    """История только по точному ключу clause_id (без слияния с другими ключами).
    Используется для подсчёта реплик бота, чтобы счёт совпадал с тем, что видно в окне чата.
    """
    by_clause = history.get("chat_history_by_clause") or {}
    cid = str(clause_id or "").strip()
    out = list(by_clause.get(cid, []) or [])
    out.sort(key=lambda m: (m.get("timestamp") or ""))
    return out


def _player_texts_since_last_bot(clause_history: list | None) -> list[str]:
    """
    Тексты реплик игрока после последней реплики бота в хронологическом порядке.
    Нужен для правил «две реплики подряд»: иначе приветствие до ответа бота склеивается
    с первой содержательной попыткой и ошибочно закрывает переговоры.
    """
    if not clause_history:
        return []
    acc: list[str] = []
    for m in reversed(clause_history):
        owner = m.get("owner")
        if owner == "bot":
            break
        if owner == "player":
            t = (m.get("text") or m.get("message") or "").strip()
            if t:
                acc.append(t)
    acc.reverse()
    return acc


def _append_to_clause_history(history: Dict[str, Any], clause_id: str, message: Dict[str, Any]) -> None:
    """Добавить сообщение в историю по пункту и обновить плоский chat_history для сохранения."""
    by_clause = history.setdefault("chat_history_by_clause", {})
    cid = str(clause_id or "")
    by_clause.setdefault(cid, []).append(message)
                                                            
    history["chat_history"] = [
        msg for c in sorted(by_clause.keys()) for msg in (by_clause[c] or [])
    ]


                                                   
MAX_SESSION_AI_LESSONS_PER_CLAUSE = 12
MAX_AI_LESSON_CHARS = 400


def _append_ai_lesson(history: Dict[str, Any], clause_id: str, lesson: str) -> None:
    """Добавить «урок» для ИИ по пункту: что отвечать правильно/неправильно. Сохраняется в history и подставляется в промпт при следующих репликах."""
    s = (lesson or "").strip()
    if not s:
        return
    if len(s) > MAX_AI_LESSON_CHARS:
        s = s[: MAX_AI_LESSON_CHARS - 1].rstrip() + "…"
    by_clause = history.setdefault("ai_lessons_by_clause", {})
    cid = str(clause_id or "")
    lst = by_clause.setdefault(cid, [])
    if lst and lst[-1] == s:
        return
    lst.append(s)
    overflow = len(lst) - MAX_SESSION_AI_LESSONS_PER_CLAUSE
    if overflow > 0:
        del lst[0:overflow]


def _compact_text_for_summary(text: str, max_len: int = 100) -> str:
    t = " ".join((text or "").split())
    if len(t) <= max_len:
        return t
    return t[: max_len - 1].rstrip() + "…"


def _clause_dialogue_summary_text_from_history(
    clause_history: list,
    *,
    clause_data: Dict[str, Any],
    agrees: bool,
    chat_complete: bool,
) -> str:
    """Компактное резюме для промпта: факты последних реплик и исход последнего хода контрагента."""
    parts: list[str] = []
    cn = str(clause_data.get("number") or clause_data.get("id") or "")
    if cn:
        parts.append(f"Пункт {cn}.")
    msgs = [m for m in (clause_history or []) if m.get("owner") in ("player", "bot")]
    tail = msgs[-6:]
    for m in tail:
        role = "Игрок" if m.get("owner") == "player" else "Контрагент"
        blob = _compact_text_for_summary(str(m.get("text") or ""), 90)
        if blob:
            parts.append(f"{role}: {blob}")
    if msgs:
        last_bot = next((x for x in reversed(msgs) if x.get("owner") == "bot"), None)
        if last_bot is not None:
            if last_bot.get("agrees"):
                parts.append("Последний ответ контрагента: зафиксировано согласие с редакцией.")
            elif chat_complete:
                parts.append("Последний исход: переговоры по пункту закрыты.")
            else:
                parts.append("Последний ответ контрагента: без согласия с редакцией; диалог продолжается.")
    elif agrees:
        parts.append("Согласие по текущему ходу.")
    return " ".join(parts).strip()


def _persist_clause_dialogue_summary(
    history: Dict[str, Any],
    clause_id: str,
    *,
    clause_data: Dict[str, Any],
    agrees: bool,
    chat_complete: bool,
) -> None:
    ch = _get_chat_history_for_clause(history, clause_id)
    text = _clause_dialogue_summary_text_from_history(
        ch, clause_data=clause_data, agrees=agrees, chat_complete=chat_complete
    )
    if not text:
        return
    summaries = history.setdefault("clause_dialogue_summaries", {})
    summaries[str(clause_id)] = {
        "text": text,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _get_clause_dialogue_summary_for_prompt(history: Dict[str, Any], clause_id: str) -> str:
    ent = (history.get("clause_dialogue_summaries") or {}).get(str(clause_id))
    if not ent or not isinstance(ent, dict):
        return ""
    return str(ent.get("text") or "").strip()


def _bot_patience_disabled() -> bool:
    """
    Вызов при обработке сообщения (не константа при импорте модуля), чтобы после загрузки
    backend/.env в main.py переменная DISABLE_BOT_PATIENCE учитывалась корректно.
    """
    return os.environ.get("DISABLE_BOT_PATIENCE", "false").lower() in ("1", "true", "yes")


                                                                                                      
                                                                                        
MIN_BOT_PATIENCE_WHILE_NEGOTIATION_OPEN = 1

                                                                                                                
_STAGE3_PATIENCE_OFF_TOPIC_KEY = "stage3_patience_off_topic_count"


def _stage3_classify_patience_hint(
    *,
    patience_full_position: bool,
    player_question_without_full_position: bool,
    has_formulation: bool,
    has_explanation: bool,
    explanation_substantive: bool,
    score: float,
    player_near_etalon: bool,
    patience_treat_as_partial: bool = False,
) -> str:
    """
    Класс качества хода для списания терпения (как quality_hint этапа 1: full/partial/clarify/off_topic).
    document на переговорах не выделяем — нейтрально как partial (без списания).
    """
    if patience_treat_as_partial:
        return "partial"
    if patience_full_position:
        return "full"
    if player_question_without_full_position:
        return "clarify"
    if player_near_etalon and has_formulation:
        return "partial"
    if has_formulation and not has_explanation:
        return "clarify"
    if has_explanation and not explanation_substantive:
        return "clarify"
    if not has_formulation and not has_explanation:
        return "partial" if float(score) >= 55.0 else "clarify"
    if has_formulation and explanation_substantive:
        return "partial"
    return "clarify"


def _patience_value_after_refusal_or_drop(
    *,
    disable_patience: bool,
    max_patience: int,
    current_patience: int,
    score: float,
    has_formulation: bool,
    has_explanation: bool,
    chat_complete: bool,
    agrees: bool,
    player_near_etalon: bool,
    player_question_without_full_position: bool,
    patience_full_position: bool = False,
    explanation_substantive: bool = False,
    history: Dict[str, Any] | None = None,
    clause_id: str = "",
    patience_treat_as_partial: bool = False,
) -> int:
    """
    Терпение после реплики бота: та же формула, что на этапе 1 (`_calc_new_patience`).

    Настройки:
    - `history["max_patience"]` (по умолчанию PATIENCE_MAX) — старт и потолок.
    - `DISABLE_BOT_PATIENCE=true` — шкала не падает.
    - `history["stage3_patience_off_topic_count"]` — счётчик off_topic по пункту для нарастающего штрафа.

    Поведение:
    - `agrees` — максимум; закрытие без согласия — 0.
    - Иначе классификация хода → clarify (−12), off_topic (−25/−50/−100), full/partial — без изменений.
    - Пока переговоры открыты, не опускаем ниже `MIN_BOT_PATIENCE_WHILE_NEGOTIATION_OPEN`.
    """
    if disable_patience:
        return max_patience
    if agrees:
        return max_patience
    if chat_complete:
        return 0

    hint = _stage3_classify_patience_hint(
        patience_full_position=bool(patience_full_position),
        player_question_without_full_position=bool(player_question_without_full_position),
        has_formulation=bool(has_formulation),
        has_explanation=bool(has_explanation),
        explanation_substantive=bool(explanation_substantive),
        score=float(score),
        player_near_etalon=bool(player_near_etalon),
        patience_treat_as_partial=bool(patience_treat_as_partial),
    )

    cid = str(clause_id or "").strip()
    n_prev = 0
    if history is not None and cid:
        ot = history.setdefault(_STAGE3_PATIENCE_OFF_TOPIC_KEY, {})
        n_prev = int(ot.get(cid, 0) or 0)

    if hint == "off_topic":
        after = _calc_new_patience(int(current_patience), hint, n_prev)
        if history is not None and cid:
            history.setdefault(_STAGE3_PATIENCE_OFF_TOPIC_KEY, {})[cid] = n_prev + 1
    else:
        after = _calc_new_patience(int(current_patience), hint, 0)
        if history is not None and cid and hint in ("full", "partial", "document"):
            history.setdefault(_STAGE3_PATIENCE_OFF_TOPIC_KEY, {})[cid] = 0

    return max(MIN_BOT_PATIENCE_WHILE_NEGOTIATION_OPEN, int(after))


def _patience_after_hard_rejection(
    disable_patience: bool,
    max_patience: int,
) -> int:
    """Оффтоп / жёсткое закрытие без согласия с игроком по сути — терпение 0."""
    return max_patience if disable_patience else 0


def _patience_from_map_for_clause(
    patience_map: Dict[str, Any],
    clause_id: str,
    clause_data: dict | None,
    *,
    default_max: int,
) -> int:
    """
    Терпение из history_json.patience по id пункта, строковому id или номеру пункта
    (фронт и разные ветки бэкенда могли писать разные ключи).
    """
    pm = patience_map if isinstance(patience_map, dict) else {}
    keys: list[str] = []
    cid = str(clause_id).strip() if clause_id is not None else ""
    if cid:
        keys.append(cid)
    if isinstance(clause_data, dict):
        num = clause_data.get("number")
        if num is not None and str(num).strip():
            keys.append(str(num).strip())
    seen: set[str] = set()
    for k in keys:
        if not k or k in seen:
            continue
        seen.add(k)
        if k not in pm:
            continue
        try:
            return int(pm[k])
        except (TypeError, ValueError):
            continue
    try:
        return int(default_max)
    except (TypeError, ValueError):
        return int(PATIENCE_MAX)


INSULT_MARKERS = (
                                   
    "дурак", "идиот", "тупой", "сука", "бляд", "блять", "ебан", "мразь", "урод", "ублюд",
                                          
    "ну блин", " блин", "блин,",
)

                                                                                                 
def _closing_without_agreement_message(bot_messages: dict | None = None) -> str:
    """Завершение по лимиту реплик/терпения: без вопросов и просьб (только фиксация и переход)."""
    default = (
        "По этому пункту сохраняем редакцию из договора. Переходим к обсуждению следующего пункта."
    )
    if not bot_messages or not isinstance(bot_messages, dict):
        return default
    msg = bot_messages.get("close_no_agreement")
    return msg.strip() if isinstance(msg, str) and msg.strip() else default


                                                                                                          
                                        
SHORT_NON_EXPLANATORY_WORDS = frozenset({
    "да", "нет", "ок", "хорошо", "согласен",
})

def _is_short_non_explanatory_reply(text: str) -> bool:
    """True, если ответ — только «да», «нет», «ок», «хорошо», «согласен» (переговоры не закрываем)."""
    if not text:
        return False
    cleaned = text.strip().lower()
    if not cleaned:
        return False
                                                  
    cleaned = cleaned.rstrip(".,;:!?")
    return cleaned in SHORT_NON_EXPLANATORY_WORDS


def _is_asking_for_clarification(text: str) -> bool:
    """Проверяет, просит ли реплика бота уточнение/пояснение (не отказ по существу)."""
    if not text or len(text) < 10:
        return False
    lower = text.lower()
    return any(
        marker in lower
        for marker in ("уточните", "поясните", "что вы имеете в виду", "подробнее", "обоснуйте", "почему именно")
    )


                                                                                                                         
BOT_PROPOSAL_MARKERS = (
    "предлагаю редакцию",
    "предлагаю формулировку",
    "предлагаю такую редакцию",
    "предлагаю изложить",
    "изложить в редакции",
    "моя редакция",
    "вариант формулировки",
)

                                                                                                                                        
ASK_EXPLANATION_AFTER_PROPOSAL = (
    "Поясните, пожалуйста, почему вы предлагаете именно в такой редакции.",
    "Поясните, почему предлагаете именно такую редакцию пункта.",
    "А почему для вас важно именно в такой редакции сформулировать пункт? Можете пояснить?",
    "Не могли бы вы пояснить, почему для вас важна именно такая формулировка?",
)

                                                                                               
ASK_FORMULATION = (
    "Понимаю вашу позицию. Предложите, пожалуйста, конкретную редакцию пункта.",
    "Ваши аргументы понятны. Как именно вы предлагаете сформулировать этот пункт?",
    "Хорошо, принимаю вашу аргументацию. Предложите конкретную формулировку пункта.",
)


def _last_bot_message_was_proposal(history: Dict[str, Any], clause_id: str) -> bool:
    """
    True, если последнее сообщение бота по пункту — предложение своей редакции
    (например «предлагаю редакцию: на территории всего мира»).
    После такой реплики следующий ответ бота должен просить пояснить позицию, а не закрывать переговоры.
    """
    clause_history = _get_chat_history_for_clause(history, clause_id)
    for msg in reversed(clause_history):
        if msg.get("owner") != "bot":
            continue
        text = (msg.get("text") or msg.get("message") or "").strip().lower()
        if not text:
            return False
        return any(m in text for m in BOT_PROPOSAL_MARKERS)
    return False


def _looks_like_short_formulation_without_explanation(text: str, max_len: int = 80) -> bool:
    """
    True, если сообщение игрока похоже на короткую формулировку без пояснения
    (например «весь мир», «на всей территории»), а не на развёрнутое обоснование.
    В таких случаях не закрываем переговоры по лимиту реплик — даём ещё один шанс пояснить.
    """
    if not text or len(text.strip()) > max_len:
        return False
    lower = text.strip().lower()
    explanation_markers = (
        "потому что", "так как", "поскольку", "для нас важно", "важно указать",
        "чтобы", "нужно", "необходимо", "в связи с", "обоснование", "причина",
        "у нас", "у нашей компании", "мы хотим", "мы должны", "требуется",
    )
    return not any(m in lower for m in explanation_markers)


def _recent_bot_messages_for_clause(clause_history: list, limit: int = 4) -> list[str]:
    """Последние реплики бота по пункту (для дедупликации и семантического выбора фраз)."""
    out: list[str] = []
    for m in reversed(clause_history or []):
        if m.get("owner") != "bot":
            continue
        t = (m.get("text") or m.get("message") or "").strip()
        if t:
            out.append(t)
        if len(out) >= limit:
            break
    return out


def _player_offered_near_etalon(player_text: str, clause_data: dict) -> bool:
    """
    Проверяет, предложил ли игрок формулировку, близкую к эталону для данного пункта.
    Использует данные из кейса: etalon_phrases, ideal_option, ideal_options, correct_examples.
    """
    if not player_text or len(player_text.strip()) < 3:
        return False
                                                                                              
                                                          
    _candidates: list[str] = []
    _s = player_text.strip()
    _candidates.append(_s)
    _q = extract_primary_quoted_clause_candidate(_s)
    if _q and _q not in _candidates:
        _candidates.append(_q)
    for _c in _candidates:
        if formulation_is_incomplete_or_unacceptable(_c, clause_data):
            return False
    contract_text = (clause_data.get("contract_text") or "").strip()
    if contract_text:
        for _c in _candidates:
            if _draft_texts_equivalent_for_negotiation(_c, contract_text):
                return False

    _cid_neg = str((clause_data.get("id") or "")).strip()
    _is_territory_clause = (clause_data.get("negotiation_profile") or "").strip() == "territory" or _cid_neg.endswith(
        "_territory"
    )
    if _is_territory_clause:
        for _c in _candidates:
            if _c and _territory_raw_contains_disallowed_country_marker(_c.strip(), clause_data):
                return False
        for _c in _candidates:
            if _c and territory_formulation_worldwide_with_redundant_extra_territory(_c.strip()):
                return False
        for _c in _candidates:
            if _c and _territory_formulation_aligns_with_ideal_options(_c.strip(), clause_data):
                return True
                                                                                                             
                                                                                                                    
        return False

    lower = player_text.lower()

                                                          
    phrases = clause_data.get("etalon_phrases") or clause_data.get("etalon_keywords")
    if isinstance(phrases, list) and phrases:
        if any(
            (p.lower() if isinstance(p, str) else str(p).lower()) in lower
            for p in phrases
        ):
            return True

                                                                                   
    def _norm(s: str) -> str:
        return (s or "").strip().lower().rstrip(".,;:!?")

    refs: list[str] = []
    if clause_data.get("ideal_option"):
        refs.append(_norm(clause_data["ideal_option"]))
    for opt in clause_data.get("ideal_options") or []:
        if isinstance(opt, str) and opt.strip():
            refs.append(_norm(opt))
    for ex in clause_data.get("correct_examples") or []:
        if isinstance(ex, str) and ex.strip():
            refs.append(_norm(ex))
    if clause_data.get("correct_example"):
        refs.append(_norm(clause_data["correct_example"]))

    for ref in refs:
        if len(ref) >= 12 and ref in lower:
            return True
                                                                     
        if len(ref) >= 12 and ref[:40] in lower:
            return True

                                                                                                                    
    player_n = _norm(player_text)
    try:
        from services.similarity_service import normalized_levenshtein_ratio

        pn = " ".join(player_n.split())
        for ref in refs:
            if len(ref) < 12:
                continue
            rn = " ".join(ref.split())
            rlev = normalized_levenshtein_ratio(pn, rn)
            if rlev >= 0.86 and abs(len(pn) - len(rn)) <= 6:
                return True
    except Exception:                
        pass

                                                                                                
    try:
        from services import similarity_service as _sim

        if _sim.is_enabled():
            near, _sc, _m = _sim.is_semantically_near_expected(
                player_text.strip(), clause_data, threshold=0.75
            )
            if near:
                return True
    except Exception:                                             
        pass

    if formulation_acceptable_po_4_1_standard_structure(player_text, clause_data):
        return True

    return False


def _player_submission_justifies_agreement(
    formulation_text: str,
    explanation_text: str,
    combined_text: str,
    llm_formulation: str,
    clause_data: dict,
) -> bool:
    """
    Финальное согласие на правку пункта: либо формулировка близка к эталону кейса,
    либо есть конкретная редакция (≥5 симв., в т.ч. из объединённого текста) и содержательное пояснение.
    """
    blob = (formulation_text or combined_text or "").strip()
    if _player_offered_near_etalon(blob, clause_data):
        return True
    ft = (formulation_text or llm_formulation or "").strip()
    if len(ft) < 5:
        ft = (
            pick_formulation_candidate_for_defective_screening(
                formulation_text,
                explanation_text,
                combined_text,
                clause_data,
            )
            or ""
        ).strip()
    if len(ft) < 5:
        return False
    expl = (explanation_text or "").strip()
    return bool(expl and is_real_explanation(expl, clause_data))


def _6_3_use_ideal_replacement_after_risk_accept(
    formulation_text: str,
    explanation_text: str,
    clause_data: dict,
    combined_text: str | None = None,
) -> bool:
    """
    п. 6.3: при принятии по обоснованию «существенный риск» подставляем эталон кейса,
    если в поле редакции не близкий к эталону текст или вставлен текущий абзац договора.
    """
    if (clause_data.get("negotiation_profile") or "").strip() != "liability_cap" and str(
        clause_data.get("id") or ""
    ) != "6.3_liability":
        return False
    blob = "\n".join(
        x for x in ((explanation_text or "").strip(), (formulation_text or "").strip(), (combined_text or "").strip()) if x
    ).lower()
    if not liability_6_3_risk_acceptance_blob_ok(blob):
        return False
    ft = (formulation_text or "").strip()
    if not ft:
        return False
    if not _player_offered_near_etalon(ft, clause_data):
        return True
    ct = (clause_data.get("contract_text") or "").strip()
    if len(ct) >= 28 and ct.lower() in ft.lower():
        return True
    return False


def _player_sent_short_formulation_followup(text: str, clause_data: dict) -> bool:
    """
    Реплика выглядит как короткое уточнение только текста пункта (без причинности и длинного шаблона),
    обычно после просьбы бота уточнить редакцию.
    """
    t = (text or "").strip()
    if not t or len(t) < 10 or len(t) > 280:
        return False
    low = t.lower()
    if any(
        x in low
        for x in (
            "предлагаем изложить",
            "предлагаю изложить",
            "следующей редакции",
            "редакции:",
            "редакция:",
        )
    ):
        return False
    if has_explanation_markers(t, clause_data):
        return False
    if any(c in low for c in ("поскольку", "так как", "потому что", "в связи с", "ввиду")) and len(t) > 35:
        return False
    if formulation_is_incomplete_or_unacceptable(t, clause_data):
        return False
    return True


def _get_last_formulation_from_clause_history(
    clause_history: list,
    clause_data: dict,
    case_code: str,
    clause_id: str,
    skip_last_player_message: bool = False,
) -> str:
    """
    Возвращает формулировку пункта из предыдущих реплик игрока в истории.
    Используется, когда игрок в текущей реплике написал только пояснение, а редакцию
    указал в предыдущем сообщении (например: 1) «Весь мир», 2) «Потому что у нас сотрудники за рубежом»).
    """
    player_msgs = [m for m in clause_history if m.get("owner") == "player"]
    if not player_msgs:
        return ""
                                                                                                      
                                                                                            
    if skip_last_player_message:
        to_scan = player_msgs[:-1]
    else:
        to_scan = player_msgs
    for m in reversed(to_scan):
        t = (m.get("text") or m.get("message") or "").strip()
        if not t or len(t) < 2:
            continue
        clean = extract_clean_formulation(t, case_code, clause_id)
        if clean and len(clean.strip()) >= 5:
            c = clean.strip()
            if formulation_is_incomplete_or_unacceptable(c, clause_data):
                continue
            if _clause_uses_case_canonical_for_contract(clause_data) and _is_short_etalon_phrase(
                c, clause_data
            ):
                best = find_best_matching_ideal_option(c, clause_data)
                if best and len(str(best).strip()) >= 3:
                    return str(best).strip()
            return _normalize_replacement_caps_and_punctuation(c)
        if _player_offered_near_etalon(t, clause_data):
            c = (extract_clean_formulation(t, case_code, clause_id) or t).strip()
            if len(c) >= 5:
                if formulation_is_incomplete_or_unacceptable(c, clause_data):
                    continue
                if _clause_uses_case_canonical_for_contract(clause_data) and _is_short_etalon_phrase(
                    c, clause_data
                ):
                    best = find_best_matching_ideal_option(c, clause_data)
                    if best and len(str(best).strip()) >= 3:
                        return str(best).strip()
                return _normalize_replacement_caps_and_punctuation(c)
    return ""


def _get_last_explanation_from_clause_history(
    clause_history: list,
    clause_data: dict,
    *,
    formulation_hint: str = "",
    skip_last_player_message: bool = True,
) -> str:
    """
    Пояснение из предыдущих реплик игрока (текущая — только редакция в форме).
    Зеркало _get_last_formulation_from_clause_history.
    """
    player_msgs = [m for m in clause_history if m.get("owner") == "player"]
    if not player_msgs:
        return ""
    to_scan = player_msgs[:-1] if skip_last_player_message else player_msgs
    hint = (formulation_hint or "").strip().lower().rstrip(".")
    for m in reversed(to_scan):
        t = (m.get("text") or m.get("message") or "").strip()
        if not t or len(t) < 8:
            continue
        if hint and t.strip().lower().rstrip(".") == hint:
            continue
                                                                  
        if _player_offered_near_etalon(t, clause_data) and not has_explanation_markers(t, clause_data):
            continue
        if is_real_explanation(t, clause_data):
            return t
        if has_explanation_markers(t, clause_data) and len(t) >= 12:
            return t
    return ""


def _resolve_effective_player_message(
    action: str,
    clause_data: dict,
    justification_text: str,
    new_clause_text: str,
    player_choice: Dict[str, Any],
    chat_history: list | None = None,
    clause_id: str | None = None,
) -> str:
    """
    Возвращает фактический текст последней реплики игрока для логики завершения чата.

    Важно для action=change: на первом ходе фронт может прислать только индексы
    выбранной формулировки без newClauseText, хотя на экране игрок видит текст
    вроде «весь мир». В таком случае восстанавливаем текст по choiceIndex.
    """
    if justification_text:
        return justification_text.strip()
    if new_clause_text:
        return new_clause_text.strip()
    if action in ("reject", "insist"):
        opts = get_clause_options(clause_data, action)
        reasons = opts.get("reasons", [])
        reason_index = player_choice.get("reasonIndex")
        if reason_index is None:
            reason_index = player_choice.get("choiceIndex")
        if isinstance(reason_index, str) and reason_index.isdigit():
            reason_index = int(reason_index)
        if isinstance(reason_index, int) and isinstance(reasons, list) and 0 <= reason_index < len(reasons):
            reason_data = reasons[reason_index]
            return (reason_data.get("text", reason_data) if isinstance(reason_data, dict) else reason_data) or ""

    if action != "change":
                                                                             
        if chat_history and clause_id:
            for m in reversed(chat_history):
                if m.get("owner") == "player" and (m.get("clauseId") == clause_id or m.get("clauseId") == str(clause_id)):
                    t = (m.get("text") or "").strip()
                    if t:
                        return t
        return ""

    opts = get_clause_options(clause_data, "change")
    formulations = opts.get("formulations", clause_data.get("changeOptions", []))
    change_option_index = player_choice.get("changeOptionIndex")
    change_reason_index = player_choice.get("changeReasonIndex")

    if isinstance(change_option_index, str) and change_option_index.isdigit():
        change_option_index = int(change_option_index)
    if isinstance(change_reason_index, str) and change_reason_index.isdigit():
        change_reason_index = int(change_reason_index)

    if change_option_index is None or not isinstance(formulations, list) or not formulations:
                                                                             
        if chat_history and clause_id:
            for m in reversed(chat_history):
                if m.get("owner") == "player" and (m.get("clauseId") == clause_id or m.get("clauseId") == str(clause_id)):
                    t = (m.get("text") or "").strip()
                    if t:
                        return t
        return ""

    block = formulations[change_reason_index] if (
        change_reason_index is not None
        and change_reason_index < len(formulations)
        and isinstance(formulations[change_reason_index], list)
    ) else formulations[0]

    if isinstance(block, list) and change_option_index < len(block):
        formulation_data = block[change_option_index]
        return (formulation_data.get("text", formulation_data) if isinstance(formulation_data, dict) else formulation_data) or ""
    if not isinstance(block, list) and change_option_index < len(formulations):
        formulation_data = formulations[change_option_index]
        return (formulation_data.get("text", formulation_data) if isinstance(formulation_data, dict) else formulation_data) or ""

                                                                         
    if chat_history and clause_id:
        for m in reversed(chat_history):
            if m.get("owner") == "player" and (m.get("clauseId") == clause_id or m.get("clauseId") == str(clause_id)):
                t = (m.get("text") or "").strip()
                if t:
                    return t
    return ""


def _contains_insult(text: str) -> bool:
    """
    Простейшая эвристика: проверяем наличие оскорбительных маркеров в тексте.
    Не пытаемся быть идеальными — цель только обнулить терпение при явных
    выпадках в адрес бота/контрагента.
    """
    lowered = text.lower()
    return any(marker in lowered for marker in INSULT_MARKERS)


def _contains_unprofessional_negotiation_slang(text: str) -> bool:
    """
    Разговорная лексика, недопустимая в деловой переписке по пункту договора.
    Не смешиваем с оскорблениями: здесь — явная реакция и просьба переформулировать,
    без закрытия пункта.
    """
    if not text or not str(text).strip():
        return False
    s = str(text).lower().replace("ё", "е")
                                                     
    if re.search(r"(?<![а-я])жесть(?![а-я])", s):
        return True
    return False


def get_chat_history(negotiation_session_id: int) -> Dict[str, Any]:
    """
    Получить историю чата для negotiation_session.
    """
    return get_negotiation_history(negotiation_session_id)


def is_ai_only_mode() -> bool:
    """
    Проверка, включён ли режим только ИИ (без fallback).
    Определяется переменной окружения AI_ONLY_MODE.
    """
    return os.getenv("AI_ONLY_MODE", "").lower() in ("true", "1", "yes")


def negotiation_simple_mode_allowed() -> bool:
    """
    Разрешить ветку simple / get_bot_response по history.mode=simple.
    В продукте выключено; для стресс-тестов и отладки: NEGOTIATION_ALLOW_SIMPLE_MODE=1.
    """
    return os.getenv("NEGOTIATION_ALLOW_SIMPLE_MODE", "").lower() in ("1", "true", "yes")


def is_ai_mode(negotiation_session_id: int) -> bool:
    """
    Проверка, включён ли ИИ‑режим для данной сессии переговоров.

    Источник правды — history_json.mode / history_json.ai.enabled.
    Если AI_ONLY_MODE=true, всегда возвращает True.
    Без NEGOTIATION_ALLOW_SIMPLE_MODE переговоры всегда идут через LLM (режим ИИ).
    """
    if is_ai_only_mode():
        return True
    if not negotiation_simple_mode_allowed():
        return True
    history = get_negotiation_history(negotiation_session_id)
                                                                                     
    mode = history.get("mode", "ai")
    ai_cfg = history.get("ai") or {}
    if "enabled" in ai_cfg:
        enabled = bool(ai_cfg.get("enabled"))
    else:
        enabled = mode == "ai"
    return mode == "ai" or enabled


def save_chat_history(negotiation_session_id: int, history: Dict[str, Any]) -> None:
    """
    Сохранить историю чата.
    """
    save_negotiation_history(negotiation_session_id, history)


def get_clause_data(negotiation_session_id: int, clause_id: str) -> Dict[str, Any]:
    """
    Получить данные пункта договора по его id или number.
    Поддерживает id вида "clause-1.4.1" (из clause_readonly) — ищет по number.
    """
    data = get_contract_clauses_for_session(negotiation_session_id)
    clause_id_str = str(clause_id).strip()
    num_from_id = clause_id_str.replace("clause-", "", 1) if clause_id_str.startswith("clause-") else None
    clause = next(
        (
            c
            for c in data["clauses"]
            if c.get("id") == clause_id_str
            or str(c.get("number") or "") == clause_id_str
            or (num_from_id and str(c.get("number") or "") == num_from_id)
        ),
        None,
    )
    if not clause:
        available = [str(c.get("number") or c.get("id")) for c in data["clauses"]]
        raise ValueError(f"Пункт договора {clause_id} не найден. Доступны для обсуждения: {', '.join(available)}")
    return clause


def activate_chat(
    negotiation_session_id: int,
    clause_id: str,
    action: str,
) -> Dict[str, Any]:
    """
    Активация чата для пункта договора.
    """
    clause_data = get_clause_data(negotiation_session_id, clause_id)

    if action not in ["reject", "change", "discuss", "insist"]:
        raise ValueError("Неверное действие. Допустимые: reject, change, discuss, insist")

    status = clause_data.get("status")
    if status not in (ClauseStatus["AVAILABLE"], ClauseStatus["SELECTED"]):
                                                                                                                             
        history = get_chat_history(negotiation_session_id)
        lawyer_name = history.get("lawyer_name", "Юрист Иван Кузнецов")
        lawyer_company = history.get("lawyer_company", "из ООО «1С Консалтинг»")
        patience_map = history.get("patience") or {}
        max_patience = int(history.get("max_patience", PATIENCE_MAX))
        current_patience = _patience_from_map_for_clause(
            patience_map, clause_id, clause_data, default_max=max_patience
        )
        options = get_clause_options(clause_data, action)
        return {
            "action": action,
            "clauseId": clause_id,
            "clauseData": clause_data,
            "playerMessage": "",
            "options": options,
            "chatActive": False,
            "lawyerName": lawyer_name,
            "lawyerCompany": lawyer_company,
            "patience": current_patience,
            "maxPatience": max_patience,
            "chatComplete": True,
            "clauseTerminal": True,
        }

                                             
    if status != ClauseStatus["SELECTED"]:
        update_clause_status_for_session(negotiation_session_id, clause_id, ClauseStatus["SELECTED"])
        clause_data["status"] = ClauseStatus["SELECTED"]

    options = get_clause_options(clause_data, action)

                                                                                                
    player_message = ""

    history = get_chat_history(negotiation_session_id)
                                                                                          
                                                                           
    _started_map = dict(history.get("clause_dialogue_started_at") or {})
    _started_map[str(clause_id)] = datetime.now(timezone.utc).isoformat()
    history["clause_dialogue_started_at"] = _started_map
    if player_message:
        _append_to_clause_history(
            history,
            clause_id,
            {
                "text": player_message,
                "owner": "player",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "clauseId": clause_id,
                "action": action,
            },
        )
    save_chat_history(negotiation_session_id, history)

    lawyer_name = history.get("lawyer_name", "Юрист Иван Кузнецов")
    lawyer_company = history.get("lawyer_company", "из ООО «1С Консалтинг»")

    patience_map = history.get("patience") or {}
    max_patience = int(history.get("max_patience", PATIENCE_MAX))
    current_patience = _patience_from_map_for_clause(
        patience_map, clause_id, clause_data, default_max=max_patience
    )

    return {
        "action": action,
        "clauseId": clause_id,
        "clauseData": clause_data,
        "playerMessage": player_message,
        "options": options,
        "chatActive": True,
        "lawyerName": lawyer_name,
        "lawyerCompany": lawyer_company,
        "patience": current_patience,
        "maxPatience": max_patience,
    }


def _finalize_response(
    history: Dict[str, Any],
    clause_id: str,
    clause_data: Dict[str, Any],
    negotiation_session_id: int,
    *,
    bot_message: str,
    agrees: bool,
    score: float,
    next_status: int,
    replacement_text: str | None,
    chat_complete: bool,
    new_patience: int,
    patience_map: Dict[str, Any],
    bot_reply_count: int,
    outcome_type: OutcomeType,
    clause_excluded: bool = False,
    explanation_reference_similarity_0_100: float | None = None,
) -> Dict[str, Any]:
    """Записывает ответ бота, сохраняет состояние, возвращает API-ответ."""
    _append_to_clause_history(history, clause_id, {
        "text": bot_message,
        "owner": "bot",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "clauseId": clause_id,
        "agrees": agrees,
        "convincingScore": score,
    })

    patience_map[str(clause_id)] = new_patience
    _num_pat = (clause_data.get("number") if isinstance(clause_data, dict) else None)
    if _num_pat is not None:
        _ns_pat = str(_num_pat).strip()
        if _ns_pat and _ns_pat != str(clause_id):
            patience_map[_ns_pat] = new_patience
    history["patience"] = patience_map

    if not chat_complete and not agrees:
        awaiting_map = history.get("awaiting_justification") or {}
        awaiting_map[str(clause_id)] = True
        history["awaiting_justification"] = awaiting_map

    if agrees or chat_complete:
        outcome = ClauseOutcome()
        outcome.next_status = int(next_status)
        outcome.clause_excluded = bool(clause_excluded and agrees)
        outcome.final_replacement_text = (
            None if outcome.clause_excluded else (replacement_text if agrees else None)
        )
        outcome.bot_message = bot_message
        outcome.chat_complete = chat_complete
        outcome.outcome_type = outcome_type
        _persist_clause_outcome(history, clause_id, clause_data, outcome)

    _persist_clause_dialogue_summary(
        history,
        clause_id,
        clause_data=clause_data,
        agrees=agrees,
        chat_complete=chat_complete,
    )

    save_chat_history(negotiation_session_id, history)

    _br: Dict[str, Any] = {
        "message": bot_message,
        "agrees": agrees,
        "requiresJustification": not agrees and not chat_complete,
        "objection": not agrees,
        "objectionNumber": bot_reply_count,
        "convincingScore": score,
        "outcomeType": outcome_type.value,
        "patience": new_patience,
        "awaitingJustification": not agrees and not chat_complete,
    }
    if explanation_reference_similarity_0_100 is not None:
        _br["explanationReferenceSimilarity0_100"] = float(explanation_reference_similarity_0_100)

    return {
        "botResponse": _br,
        "clauseStatus": next_status,
        "points": 0,
        "chatComplete": chat_complete,
        "patience": new_patience,
        "replacementText": None if (agrees and clause_excluded) else (replacement_text if agrees else None),
        "clauseExcluded": bool(agrees and clause_excluded),
        "outcomeType": outcome_type.value,
    }


def _normalize_player_explanation_repeat_key(explanation_text: str) -> str | None:
    """Нормализованное пояснение для сравнения повторов (редакция пункта не участвует)."""
    e = (explanation_text or "").strip()
    if len(e) < 8:
        return None
    return " ".join(e.lower().split())


def _repeat_explanation_key_from_stored_player_blob(text: str, clause_data: dict | None) -> str | None:
    """
    Извлечь ключ пояснения из сохранённого combined_text игрока.

    Формат хранения (send_message): при двух полях — ``формулировка\\nпояснение``;
    при пустом пояснении ``.strip()`` даёт одну строку без перевода строки (только редакция) —
    такие сообщения не дают ключа повтора пояснения.
    """
    t = (text or "").strip()
    if len(t) < 8:
        return None
    cd = clause_data or {}
    if "\n" in t:
        expl = t.split("\n", 1)[1].strip()
        if len(expl) < 8:
            return None
        return " ".join(expl.lower().split())
                                                       
    if _player_offered_near_etalon(t, cd) and not has_explanation_markers(t, cd):
        return None
    if is_real_explanation(t, cd):
        return " ".join(t.lower().split())
    if has_explanation_markers(t, cd) and len(t) >= 12:
        return " ".join(t.lower().split())
                                                                          
    if 8 <= len(t) <= 160 and ";" not in t:
        return " ".join(t.lower().split())
    return None


def _player_explanation_repeat_count(
    clause_history: list,
    explanation_text: str,
    clause_data: dict,
) -> int:
    """
    Сколько раз до текущего хода игрок уже присылал то же пояснение (содержательно).

    Поле «Предлагаемая редакция» часто не меняется между ходами — на него правило не распространяется.
    В send_message текущее сообщение уже в clause_history; последняя реплика игрока в подсчёт не входит.
    """
    key = _normalize_player_explanation_repeat_key(explanation_text)
    if not key:
        return 0
    players = [m for m in (clause_history or []) if m.get("owner") == "player"]
    if len(players) < 2:
        return 0
    prior = players[:-1]
    n = 0
    for m in prior:
        blob = m.get("text") or m.get("message") or ""
        mk = _repeat_explanation_key_from_stored_player_blob(str(blob), clause_data)
        if mk == key:
            n += 1
    return n


def _env_truthy_chat_log(val: str) -> bool:
    return val.strip().lower() in ("1", "true", "yes", "on", "да")


def _negotiation_plain_logs_enabled() -> bool:
    """Понятный журнал переговоров в консоли (для любого читателя, не только разработчика)."""
    for key in ("CHAT_LOGS_IN_TERMINAL", "NEGOTIATION_PLAIN_LOGS", "READABLE_CHAT_LOGS"):
        if _env_truthy_chat_log(os.getenv(key, "")):
            return True
    return False


def _plain_clause_label(clause_data: Dict[str, Any], clause_id: str) -> str:
    num = clause_data.get("number")
    if num is None:
        num = clause_id
    title = (clause_data.get("title") or "").strip()
    if title:
        short = title[:72] + ("…" if len(title) > 72 else "")
        return f"{num} «{short}»"
    return str(num)


def _plain_snip(text: str, max_len: int = 140) -> str:
    t = (text or "").strip().replace("\n", " ")
    if len(t) <= max_len:
        return t
    return t[: max_len - 1] + "…"


_PLAIN_ACTION_RU = {
    "accept": "принять вашу позицию",
    "accept_counterpart": "зафиксировать, что игрок принял редакцию контрагента, и закрыть пункт",
    "clarify": "попросить уточнения или пояснения",
    "objection": "оставить возражение / продолжить обсуждение без принятия",
    "reject_close": "закрыть переговоры без согласия с вами",
    "repeat_stalemate": "принудительное закрытие из‑за многократного повтора одного и того же пояснения",
    "repeat_nudge": "мягкое напоминание: нужно другое пояснение или аргументы по существу",
}


def _plain_action_ru(action: str | None) -> str:
    if not action:
        return "—"
    k = str(action).strip().lower()
    return _PLAIN_ACTION_RU.get(k, f"действие «{k}»")


_PRE_LLM_REASON_RU = {
    "empty_message": "пустое или слишком короткое сообщение — контрагент отвечает по шаблону сценария, без обращения к ИИ",
    "profanity": "недопустимая лексика — переговоры по этому пункту прекращаются",
    "gibberish": "сообщение похоже на бессмыслицу — ответ по шаблону сценария, без обращения к ИИ",
    "meta_question_fishing": "наводящий вопрос без вашего черновика пункта — ответ по шаблону, без «подсказки» правильной формулировки",
    "liability_cap_emotional_non_substantive": "оценочная реплика без позиции по п. 6.3 — нейтральный ответ по шаблону сценария, без обращения к ИИ",
}


def _plain_pre_llm_reason_ru(reason: str | None) -> str:
    if not reason:
        return "быстрая проверка до основного ответа контрагента"
    return _PRE_LLM_REASON_RU.get(str(reason), f"причина: {reason}")


_PLAIN_OUTCOME_RU = {
    OutcomeType.PENDING: "переговоры по пункту продолжаются",
    OutcomeType.ACCEPTED_PLAYER_CHANGE: "принята ваша редакция, текст пункта в договоре обновлён",
    OutcomeType.CLAUSE_EXCLUDED: "пункт исключён из договора по соглашению",
    OutcomeType.ACCEPTED_COUNTERPARTY: "вы согласились с позицией контрагента",
    OutcomeType.KEPT_ORIGINAL: "сохранена исходная редакция контрагента (вы с ней согласились)",
    OutcomeType.CLOSED_NO_AGREEMENT: "диалог по пункту закрыт без взаимного согласия",
    OutcomeType.ESCALATED: "спор передан на следующий уровень по правилам сценария",
}


def _plain_outcome_ru(ot: OutcomeType) -> str:
    return _PLAIN_OUTCOME_RU.get(ot, getattr(ot, "value", str(ot)))


_MIRROR_ROUTE_TITLE_RU = {
    "accept_counterpart": "Игрок принял редакцию контрагента (закрытие без вызова модели)",
    "repeat_stalemate": "Третий подряд повтор одного пояснения — автозакрытие переговоров",
    "repeat_nudge": "Второй подряд повтор пояснения — предупреждение из сценария",
    "pre_llm_gate": "Ответ по быстрым правилам до вызова языковой модели",
    "llm_v2_pipeline": "Языковая модель и пост-правила сценария (основной контур)",
}

_LLM_POST_REASON_AUDIT_RU = {
    "strict_formulation_whitelist": "Сработала строгая белая листа формулировок — ответ приведён к шаблону сценария.",
    "acts_missing_signing_deadlines": "Профиль «акты»: в тексте не видно сроков подписания — ответ из шаблона запроса уточнений.",
    "liability_cap_no_cap_tweak_hint": "Профиль 6.3: без конкретного ограничения ответственности — шаблонный ответ сценария.",
    "anti_coaching": "Анти-«коучинг»: запрос подсказки по «эталону» — нейтральная реплика из сценария вместо подсказки.",
    "llm_fallback": "Подставлен запасной ответ (ошибка или пустой ответ модели).",
}


def _llm_post_reason_audit_ru(reason: str | None) -> str | None:
    if not reason:
        return None
    k = str(reason).strip()
    return _LLM_POST_REASON_AUDIT_RU.get(k)


def _latency_explain_rus(
    *,
    route_code: str,
    pipeline_s: float,
    http_wall: float,
    http_calls: int,
    phases: list[tuple[str, float]],
) -> list[str]:
    out: list[str] = []
    non_llm = route_code in (
        "accept_counterpart",
        "repeat_stalemate",
        "repeat_nudge",
        "pre_llm_gate",
    )
    if non_llm:
        out.append(
            "К языковой модели запрос не отправлялся — ответ сформирован локальными правилами и шаблонами, обычно это быстро."
        )
    if http_calls and http_wall >= 2.0:
        out.append(
            f"Основная задержка — ожидание ответа провайдера LLM (OpenRouter или другой API): "
            f"~{http_wall:.2f} с суммарно по {http_calls} HTTP-запросу(ам). "
            "Длительность зависит от выбранной модели, очереди провайдера, сети и размера промпта."
        )
    elif http_calls and http_wall > 0:
        out.append(
            f"Вызов модели занял ~{http_wall:.2f} с ({http_calls} HTTP-запрос) — для онлайн-API это обычно основная часть времени."
        )
    other = max(0.0, pipeline_s - http_wall)
    if not non_llm and other >= 1.5:
        out.append(
            f"Заметная доля времени (~{other:.2f} с) — подготовка промпта, разбор JSON и жёсткие правила после ответа модели "
            "(см. разбивку по фазам выше)."
        )
    if phases and not out:
        out.append("Время распределено по фазам пайплайна — см. строки разбивки.")
    if not out:
        out.append("Задержка в пределах ожидаемого для данного маршрута и нагрузки сервера.")
    return out


def _v2_decision_trace_push(llm_result: dict, message: str) -> None:
    """Короткая строка для журнала / UI-аудита: что сделал код после модели."""
    lst = llm_result.setdefault("_v2_decision_trace", [])
    lst.append((message or "").strip())


def _llm_v2_audit_why_bullets(
    llm_result: dict,
    *,
    plain_auto_close: str | None,
    clause_excluded: bool,
) -> list[str]:
    bullets: list[str] = []
    _trace = [str(x).strip() for x in (llm_result.get("_v2_decision_trace") or []) if str(x).strip()]
    if _trace:
        bullets.append("Цепочка шагов после ответа модели (детерминированная обработка):")
        bullets.extend(f"  {i}. {step}" for i, step in enumerate(_trace, start=1))
    if llm_result.get("_player_accepts_counterparty_revision"):
        bullets.append(
            "По тексту хода: игрок соглашается с последней редакцией контрагента — зафиксировано как принятие их позиции."
        )
    if llm_result.get("_bot_accepted_player_revision_turn"):
        bullets.append(
            "Сработало правило «бот по тексту принял вашу правку» (маркеры принятия в реплике; для territory без "
            "запрещённых маркеров в ходе игрока; Step 5 strict/territory могут быть пропущены) — согласие выровнено."
        )
    if plain_auto_close == "patience":
        bullets.append("Исчерпан запас терпения контрагента — финальное закрытие из шаблонов сценария.")
    elif plain_auto_close == "max_replies":
        bullets.append("Достигнут лимит реплик контрагента в этом раунде — диалог закрыт шаблоном.")
    if llm_result.get("_used_template"):
        rru = _llm_post_reason_audit_ru(str(llm_result.get("reason") or "").strip() or None)
        if rru:
            bullets.append(rru)
        else:
            bullets.append(
                "Текст ответа заменён или скорректирован шаблоном сценария после модели "
                f"(reason={llm_result.get('reason')!r})."
            )
    raw_r = (llm_result.get("reason") or "").strip()
    if raw_r and not llm_result.get("_used_template"):
        bullets.append(f"Модель указала причину в JSON (reason): {raw_r[:220]}")
    action = str(llm_result.get("action") or "").strip().lower()
    bullets.append(
        f"После всех правил: действие «{_plain_action_ru(action)}», оценка {llm_result.get('score')}, "
        f"согласие={bool(llm_result.get('agrees'))}."
    )
    if clause_excluded:
        bullets.append("Пункт исключён из договора по правилам сценария (согласованное исключение).")
    if llm_result.get("_v2_post_llm_path"):
        bullets.append("Применена пост-обработка v2 (post_llm_rules) для согласованности сценария.")
    return bullets or ["Ответ сформирован контуром модели и пост-правил сценария."]


def _mirror_negotiation_reply_audit(
    negotiation_session_id: int,
    clause_id: str,
    *,
    route_code: str,
    why_bullets: list[str],
    pipeline_t0: float,
    bot_message_snip: str = "",
    outcome_summary: str = "",
    action: str | None = None,
    pre_llm_reason: str | None = None,
) -> None:
    from services.negotiation_trace import get_active_negotiation_trace

    title = _MIRROR_ROUTE_TITLE_RU.get(route_code, route_code)
    pipeline_s = max(0.0, time.perf_counter() - pipeline_t0)
    tr = get_active_negotiation_trace()
    http_calls = int(tr.openai_http_calls) if tr else 0
    http_wall = float(tr.openai_http_wall_seconds) if tr else 0.0
    phases = list(tr.phases) if tr and getattr(tr, "phases", None) else []

    lines: list[str] = [
        f"session={negotiation_session_id} clause={clause_id}",
        f"Маршрут: {title} (код {route_code})",
        "",
        "Почему такой ответ бота:",
    ]
    for i, b in enumerate(why_bullets, start=1):
        lines.append(f"  {i}. {b}")
    if pre_llm_reason:
        lines.extend(["", f"Ключ pre-gate: {pre_llm_reason}"])
    if outcome_summary:
        lines.extend(["", f"Итог шага (кратко): {outcome_summary}"])
    if action:
        lines.extend(["", f"Действие контрагента: {_plain_action_ru(action)}"])
    if (bot_message_snip or "").strip():
        lines.extend(["", f"Текст ответа (фрагмент): {_plain_snip(bot_message_snip, 220)}"])
    lines.extend(
        [
            "",
            f"Время обработки хода на сервере: {pipeline_s * 1000:.0f} ms ({pipeline_s:.3f} s)",
        ]
    )
    if http_calls:
        lines.append(
            f"Ожидание HTTP к API модели (чтение тела ответа): ~{http_wall:.2f} s, запросов: {http_calls}"
        )
    else:
        lines.append("HTTP к API модели: не выполнялся.")
    if phases:
        lines.append("Разбивка по фазам:")
        for pname, psec in phases:
            lines.append(f"  - {pname}: {psec * 1000:.0f} ms")
    late = _latency_explain_rus(
        route_code=route_code,
        pipeline_s=pipeline_s,
        http_wall=http_wall,
        http_calls=http_calls,
        phases=phases,
    )
    lines.append("")
    lines.append("Почему такая длительность:")
    lines.extend(f"  - {s}" for s in late)

    append_mirror_block("--- [BOT_REPLY_AUDIT] ---", "\n".join(lines))


def _log_negotiation_plain_v2(
    clause_label: str,
    turn_number: int,
    player_snip: str,
    *,
    summary: str,
    agrees: bool,
    chat_complete: bool,
    action: str | None,
    outcome: OutcomeType,
    current_patience: int,
    new_patience: int,
    max_patience: int,
    bot_reply_count: int,
    bot_reply_snip: str = "",
    clause_excluded_for_contract: bool = False,
    contract_new_text_snip: str | None = None,
    decision_trace: list[str] | None = None,
) -> None:
    if not _negotiation_plain_logs_enabled():
        return
    dialog = "закрыт — по этому пункту новые сообщения в этом раунде не принимаются" if chat_complete else "продолжается"
    agree_txt = "да, контрагент принял вашу позицию по смыслу этого шага" if agrees else "нет"
    bot_s = _plain_snip(bot_reply_snip, 320) if (bot_reply_snip or "").strip() else ""
    lines = [
        "────────────────────────────────────────",
        "ЖУРНАЛ ПЕРЕГОВОРОВ ПО ДОГОВОРУ (этап 3)",
        f"Пункт: {clause_label}",
        f"Ваш ход по счёту: {turn_number}",
        "",
        "Вы написали:",
        f"  «{player_snip}»",
    ]
    if bot_s:
        lines += ["", "Ответ контрагента (юриста другой стороны):", f"  «{bot_s}»"]
    lines += [
        "",
        "Что произошло:",
        f"  {summary}",
    ]
    _dt = [str(x).strip() for x in (decision_trace or []) if str(x).strip()]
    if _dt:
        lines += ["", "Пошагово (почему такой итог правил):"]
        lines.extend(f"  {i}. {t}" for i, t in enumerate(_dt, start=1))
    lines += [
        "",
        f"Согласие контрагента с вашей позицией на этом шаге: {agree_txt}.",
        f"Диалог по этому пункту: {dialog}.",
        f"Итог для пункта: {_plain_outcome_ru(outcome)}.",
    ]
    if clause_excluded_for_contract:
        lines += ["", "Договор: этот пункт будет убран из текста (исключение по соглашению сторон)."]
    elif contract_new_text_snip and agrees and (contract_new_text_snip or "").strip():
        lines += [
            "",
            "Договор: в пункт подставляется согласованная редакция:",
            f"  «{_plain_snip(contract_new_text_snip, 280)}»",
        ]
    lines += [
        "",
        "Настрой контрагента (чем ниже после ответа, тем меньше запаса до жёсткого завершения): "
        f"было {current_patience} → стало {new_patience} (максимум {max_patience}).",
        f"Сколько раз контрагент уже отвечал по этому пункту до этого хода: {bot_reply_count}.",
        f"Тип ответа контрагента: {_plain_action_ru(action)}.",
        "────────────────────────────────────────",
    ]
    _block = "\n".join(lines)
    logger.info(_block)
    try:
        print(_block, file=sys.stderr, flush=True)
    except OSError:
        pass
    append_mirror_block("--- ЖУРНАЛ ПЕРЕГОВОРОВ ---", _block)


def _send_message_v2(
    *,
    history: Dict[str, Any],
    clause_id: str,
    clause_data: Dict[str, Any],
    negotiation_session_id: int,
    combined_text: str,
    formulation_text: str,
    explanation_text: str,
    clause_history: list,
    clause_history_exact: list,
    bot_reply_count: int,
    bot_messages: dict,
    patience_map: Dict[str, Any],
    max_patience: int,
    current_patience: int,
    case_code: str | None,
    ai_lessons: list | None = None,
) -> Dict[str, Any]:
    """
    Negotiation Engine v2: clean pipeline.
    1 LLM call, ~5 hard rules, minimal post-processing.
    """
    from services.negotiation_v2_runtime import (
        pre_llm_gate,
        evaluate_player_message,
        post_llm_rules,
        player_draft_triggers_incorrect_examples_block,
        has_notice_period_in_clause_text,
        termination_notice_draft_has_notice_period,
        acts_profile_clause_text_has_signing_deadlines,
        strict_whitelist_accepts_player_turn,
        _best_match_ok_for_contract_substitution,
        player_formulation_is_literal_canonical_for_contract,
    )

    MIN_BOT_REPLIES_BEFORE_CLOSE = 5
    MAX_REPLIES = 5
    _cid_pat = str(clause_id)
    _plain_on = _negotiation_plain_logs_enabled()
    _v2_tech_log = logger.debug if _plain_on else logger.info

    turn_number = sum(1 for m in clause_history_exact if m.get("owner") == "player")
    _clause_lbl = _plain_clause_label(clause_data, clause_id)
    _player_snip = _plain_snip(combined_text, 140)
    pipeline_t0 = time.perf_counter()

    counterpart_persona = ""
    if isinstance(bot_messages, dict):
        counterpart_persona = (bot_messages.get("_counterpart_persona") or "").strip()

    _v2_tech_log(
        "[NegV2] === START === clause=%s turn=%d player='%s' form='%s' expl='%s'",
        clause_id, turn_number,
        (combined_text or "")[:100],
        (formulation_text or "")[:60],
        (explanation_text or "")[:60],
    )

    _patience_disabled_early = os.getenv("DISABLE_BOT_PATIENCE", "").strip().lower() in ("1", "true", "yes")
    _repeat_n = _player_explanation_repeat_count(
        clause_history, explanation_text, clause_data
    )
    if _repeat_n >= 2:
        _close_msg = (
            "То же пояснение (без новых аргументов) вы присылаете в третий раз подряд — "
            "терпение на исходе. Закрываем переговоры по пункту, оставляем текущую редакцию договора."
        )
        _np_rep5 = 0 if not _patience_disabled_early else max_patience
        _close_msg = _ensure_final_negotiation_close_message(
            _close_msg, chat_complete=True, agrees=False, bot_messages=bot_messages,
        )
        _log_negotiation_plain_v2(
            _clause_lbl, turn_number, _player_snip,
            summary=(
                "То же пояснение без сдвига прислано в третий раз подряд — "
                "переговоры по пункту закрываются, в договоре остаётся редакция контрагента."
            ),
            agrees=False, chat_complete=True, action="repeat_stalemate",
            outcome=OutcomeType.CLOSED_NO_AGREEMENT,
            current_patience=current_patience, new_patience=_np_rep5,
            max_patience=max_patience, bot_reply_count=bot_reply_count,
            bot_reply_snip=_close_msg,
        )
        _mirror_negotiation_reply_audit(
            negotiation_session_id,
            clause_id,
            route_code="repeat_stalemate",
            why_bullets=[
                "Один и тот же смысл пояснения повторён третий раз подряд — сработало правило автоматического закрытия.",
                "Модель не вызывалась — текст из сценария.",
            ],
            pipeline_t0=pipeline_t0,
            bot_message_snip=_close_msg,
            outcome_summary="outcome=closed_no_agreement chat_complete=True",
            action="repeat_stalemate",
        )
        return _finalize_response(
            history, clause_id, clause_data, negotiation_session_id,
            bot_message=_close_msg,
            agrees=False, score=12.0,
            next_status=ClauseStatus["KEPT_COUNTERPARTY"],
            replacement_text=None, chat_complete=True,
            new_patience=_np_rep5,
            patience_map=patience_map, bot_reply_count=bot_reply_count,
            outcome_type=OutcomeType.CLOSED_NO_AGREEMENT,
        )
    if _repeat_n >= 1:
        pr = bot_messages.get("player_repeat_formulation")
        if isinstance(pr, list) and pr:
            _dup_msg = random.choice(pr)
        elif isinstance(pr, str) and pr.strip():
            _dup_msg = pr.strip()
        else:
            _dup_msg = (
                "Вы повторяете то же пояснение второй раз подряд — это последнее предупреждение: "
                "нужны другие аргументы или иное пояснение по существу (поле редакции может оставаться прежним). "
                "При следующем повторе переговоры по пункту будут закрыты."
            )
        _np = (
            max_patience if _patience_disabled_early
            else max(1, _calc_new_patience(current_patience, "clarify", 0))
        )
        _log_negotiation_plain_v2(
            _clause_lbl, turn_number, _player_snip,
            summary=(
                "То же пояснение прислано второй раз подряд — предупреждение: нужны новые аргументы "
                "или иное пояснение; при третьем повторе переговоры закроются. Диалог по пункту пока не закрыт."
            ),
            agrees=False, chat_complete=False, action="repeat_nudge",
            outcome=OutcomeType.PENDING,
            current_patience=current_patience, new_patience=_np,
            max_patience=max_patience, bot_reply_count=bot_reply_count,
            bot_reply_snip=_dup_msg,
        )
        _mirror_negotiation_reply_audit(
            negotiation_session_id,
            clause_id,
            route_code="repeat_nudge",
            why_bullets=[
                "Повтор того же пояснения второй раз подряд — предупреждение из шаблонов до возможного закрытия.",
                "Модель не вызывалась.",
            ],
            pipeline_t0=pipeline_t0,
            bot_message_snip=_dup_msg,
            outcome_summary="outcome=pending chat_complete=False",
            action="repeat_nudge",
        )
        return _finalize_response(
            history, clause_id, clause_data, negotiation_session_id,
            bot_message=_dup_msg,
            agrees=False, score=38.0,
            next_status=ClauseStatus["SELECTED"],
            replacement_text=None, chat_complete=False,
            new_patience=_np,
            patience_map=patience_map, bot_reply_count=bot_reply_count,
            outcome_type=OutcomeType.PENDING,
        )

                           
    t_mark = time.perf_counter()
    negotiation_trace_add_phase("v2_early_rules", t_mark - pipeline_t0)
    t_gate = time.perf_counter()
    skip, override = pre_llm_gate(
        combined_text,
        formulation_text,
        explanation_text,
        bot_messages,
        clause_data=clause_data,
    )
    negotiation_trace_add_phase("pre_llm_gate", time.perf_counter() - t_gate)
    if skip and override:
        _v2_tech_log("[NegV2] Pre-LLM gate triggered: %s", override.get("reason"))
        action = override["action"]
        agrees = override["agrees"]
        score = float(override["score"])
        bot_msg = override["message"]
        chat_complete = action == "reject_close"
        clause_excluded = False

        if chat_complete and agrees:
            next_status = ClauseStatus["ACCEPTED_BOT"]
            outcome_type = OutcomeType.ACCEPTED_COUNTERPARTY
        elif chat_complete:
                                                                                                            
            next_status = ClauseStatus["KEPT_COUNTERPARTY"]
            outcome_type = OutcomeType.CLOSED_NO_AGREEMENT
        else:
            next_status = ClauseStatus["SELECTED"]
            outcome_type = OutcomeType.PENDING

                                                                                                           
        if agrees and chat_complete:
            new_patience = max_patience
        elif chat_complete:
            new_patience = 0 if not _patience_disabled_early else max_patience
        else:
            new_patience = (
                max_patience if _patience_disabled_early
                else max(1, _calc_new_patience(current_patience, "clarify", 0))
            )

        bot_msg = _ensure_final_negotiation_close_message(
            bot_msg, chat_complete=chat_complete, agrees=agrees, bot_messages=bot_messages,
        )
        _log_negotiation_plain_v2(
            _clause_lbl, turn_number, _player_snip,
            summary=(
                f"Обращение к искусственному интеллекту не потребовалось: {_plain_pre_llm_reason_ru(override.get('reason'))}."
            ),
            agrees=agrees, chat_complete=chat_complete, action=action,
            outcome=outcome_type,
            current_patience=current_patience, new_patience=new_patience,
            max_patience=max_patience, bot_reply_count=bot_reply_count,
            bot_reply_snip=bot_msg,
        )
        _pl_reason = str(override.get("reason") or "").strip() or None
        _mirror_negotiation_reply_audit(
            negotiation_session_id,
            clause_id,
            route_code="pre_llm_gate",
            why_bullets=[
                _plain_pre_llm_reason_ru(override.get("reason")),
                f"Выбранное действие контрагента: {_plain_action_ru(action)}.",
            ],
            pipeline_t0=pipeline_t0,
            bot_message_snip=bot_msg,
            outcome_summary=f"outcome={outcome_type.value} chat_complete={chat_complete}",
            action=action,
            pre_llm_reason=_pl_reason,
        )
        return _finalize_response(
            history, clause_id, clause_data, negotiation_session_id,
            bot_message=bot_msg, agrees=agrees, score=score,
            next_status=next_status, replacement_text=None,
            chat_complete=chat_complete, new_patience=new_patience,
            patience_map=patience_map, bot_reply_count=bot_reply_count,
            outcome_type=outcome_type,
        )

                      
    t_sum = time.perf_counter()
    try:
        dialogue_summary = _get_clause_dialogue_summary_for_prompt(history, clause_id)
    except Exception:
        dialogue_summary = None
    negotiation_trace_add_phase("dialogue_summary_build", time.perf_counter() - t_sum)

    t_sum = time.perf_counter()
    llm_result = evaluate_player_message(
        clause_data=clause_data,
        player_message=combined_text,
        formulation_text=formulation_text,
        explanation_text=explanation_text,
        chat_history=clause_history,
        turn_number=turn_number,
        counterpart_persona=counterpart_persona,
        case_code=case_code or "case-001",
        dialogue_summary=dialogue_summary,
        bot_messages=bot_messages,
        ai_lessons=ai_lessons,
    )
    negotiation_trace_add_phase("evaluate_player_message", time.perf_counter() - t_sum)

                                 
    t_sum = time.perf_counter()
    llm_result = post_llm_rules(
        result=llm_result,
        clause_data=clause_data,
        formulation_text=formulation_text,
        explanation_text=explanation_text,
        turn_number=turn_number,
        chat_history=clause_history,
        bot_messages=bot_messages,
        player_message=combined_text,
    )
    negotiation_trace_add_phase("post_llm_rules", time.perf_counter() - t_sum)

    t_det = time.perf_counter()
    llm_result.setdefault("_v2_decision_trace", [])
    _v2_decision_trace_push(
        llm_result,
        "post_llm_rules: "
        f"agrees={bool(llm_result.get('agrees'))} action={str(llm_result.get('action') or '').strip()!r} "
        f"score={llm_result.get('score')} clause_excluded(JSON)={bool(llm_result.get('clause_excluded'))} "
        f"reason={_plain_snip(str(llm_result.get('reason') or ''), 140)!r}",
    )
    _incorrect_example_block = bool(llm_result.get("_incorrect_example_block")) or player_draft_triggers_incorrect_examples_block(
        clause_data,
        formulation_text or "",
        explanation_text or "",
        clause_history,
        player_message=combined_text or "",
    )
    _profile_blocks_verbal_accept_bridge = (
        (clause_data.get("negotiation_profile") or "").strip() == "liability_cap"
        or negotiation_clause_is_acts_profile(clause_data)
        or negotiation_clause_is_termination_notice_profile(clause_data)
    )
    _merged_for_agree = (combined_text or "").strip()
    if not _merged_for_agree:
        _merged_for_agree = (
            f"{(formulation_text or '').strip()} {(explanation_text or '').strip()}"
        ).strip()

    def _player_turn_passes_strict_for_verbal_accept_paths() -> bool:
        """Если в кейсе задан accepted_formulations_strict — вербальное «принимаем» бота не закрывает пункт без того же содержательного допуска, что Step 5."""
        _strict_list = clause_data.get("accepted_formulations_strict")
        if not isinstance(_strict_list, list) or not _strict_list:
            return True
        _blob_s5 = (formulation_text or combined_text or "").strip()
        return bool(
            strict_whitelist_accepts_player_turn(
                clause_data,
                formulation_text=formulation_text or "",
                explanation_text=explanation_text or "",
                anchor_text=(combined_text or _blob_s5 or "").strip(),
            )
        )

                                                                                                               
    if (
        llm_result.get("_player_accepts_counterparty_revision")
        and not llm_result.get("agrees")
        and not _incorrect_example_block
    ):
        try:
            _sc_cp = float(llm_result.get("score") or 0)
        except (TypeError, ValueError):
            _sc_cp = 0.0
        llm_result["agrees"] = True
        llm_result["action"] = "accept"
        llm_result["score"] = max(_sc_cp, 93.0)
        llm_result["clause_excluded"] = False
        llm_result["accepted_formulation"] = None
        _msg_cp = (llm_result.get("message") or "").strip()
        if len(_msg_cp) < 8:
            llm_result["message"] = _pick_player_accepts_counterpart_close_message(bot_messages)
        _v2_decision_trace_push(
            llm_result,
            "Игрок принял редакцию контрагента (player_accepts_counterparty_revision): agrees принудительно true.",
        )

    if (
        not llm_result.get("agrees")
        and _merged_for_agree
        and not llm_result.get("_player_accepts_counterparty_revision")
    ):
        _cur_bot_msg = (llm_result.get("message") or "").strip()
        _lb_player_rev = ""
        for _m in reversed(clause_history_exact or []):
            if _m.get("owner") == "bot":
                _lb_player_rev = (_m.get("text") or "").strip()
                break
        _bot_signals_accept_player = (
            bool(_cur_bot_msg and bot_message_signals_acceptance_of_player_revision(_cur_bot_msg))
            or (
                bool(_lb_player_rev)
                and bot_message_signals_acceptance_of_player_revision(_lb_player_rev)
            )
        )
                                                                                                                       
                                                                                 
                                                                                                               
        _bridge_territory_geo_bad = (
            (clause_data.get("negotiation_profile") or "").strip() == "territory"
            and bool(_merged_for_agree)
            and _territory_raw_contains_disallowed_country_marker(_merged_for_agree, clause_data)
        )
        _bridge_strict_ok = _player_turn_passes_strict_for_verbal_accept_paths()
        if (
            _bot_signals_accept_player
            and not _bridge_territory_geo_bad
            and _bridge_strict_ok
            and not _incorrect_example_block
            and not _profile_blocks_verbal_accept_bridge
        ):
            try:
                _sc_br = float(llm_result.get("score") or 0)
            except (TypeError, ValueError):
                _sc_br = 0.0
            llm_result["agrees"] = True
            llm_result["action"] = "accept"
            llm_result["score"] = max(_sc_br, 92.0)
            llm_result["clause_excluded"] = False
            llm_result["_bot_accepted_player_revision_turn"] = True
            _src = "текущее сообщение модели" if (
                _cur_bot_msg and bot_message_signals_acceptance_of_player_revision(_cur_bot_msg)
            ) else "последняя реплика бота в истории чата"
            _v2_decision_trace_push(
                llm_result,
                f"Мост «принятие по тексту бота»: ВКЛ (источник маркеров: {_src}); territory_geo_block={_bridge_territory_geo_bad}.",
            )
        elif _merged_for_agree and not llm_result.get("_player_accepts_counterparty_revision"):
            if not _bot_signals_accept_player:
                _v2_decision_trace_push(llm_result, "Мост «принятие по тексту бота»: выкл (в тексте нет маркеров принятия редакции игрока).")
            elif _bridge_territory_geo_bad:
                _v2_decision_trace_push(
                    llm_result,
                    "Мост «принятие по тексту бота»: выкл (territory: в ходе игрока есть запрещённые маркеры стран/регионов).",
                )
            elif _bot_signals_accept_player and not _bridge_strict_ok:
                _v2_decision_trace_push(
                    llm_result,
                    "Мост «принятие по тексту бота»: выкл (ход игрока не проходит accepted_formulations_strict / Step 5 whitelist).",
                )
            elif _bot_signals_accept_player and _incorrect_example_block:
                _v2_decision_trace_push(
                    llm_result,
                    "Мост «принятие по тексту бота»: выкл (incorrect_examples: черновик из negated examples — JSON не восстанавливаем).",
                )
            elif _bot_signals_accept_player and _profile_blocks_verbal_accept_bridge:
                _v2_decision_trace_push(
                    llm_result,
                    "Мост «принятие по тексту бота»: выкл (profile=liability_cap — согласие только по JSON/post_llm_rules).",
                )

                                                                                               
    _form_expl_for_profile_guards = f"{(formulation_text or '').strip()} {(explanation_text or '').strip()}".strip()
    if not _form_expl_for_profile_guards:
        _form_expl_for_profile_guards = (combined_text or "").strip()

                                                                                                            
    if (
        llm_result.get("agrees")
        and not llm_result.get("_player_accepts_counterparty_revision")
        and not llm_result.get("_bot_accepted_player_revision_turn")
        and clause_data.get("negotiation_profile") == "termination_notice"
        and not termination_notice_draft_has_notice_period(
            formulation_text, explanation_text, combined_text, combined_text
        )
    ):
        notice_msgs = bot_messages.get("request_notice_period_9_2", [])
        if isinstance(notice_msgs, list) and notice_msgs:
            _n9_msg = random.choice(notice_msgs)
        elif isinstance(notice_msgs, str) and notice_msgs.strip():
            _n9_msg = notice_msgs.strip()
        else:
            _n9_msg = (
                "Укажите в формулировке конкретный срок предварительного уведомления "
                "(в календарных или рабочих днях)."
            )
        llm_result["agrees"] = False
        llm_result["action"] = "clarify"
        try:
            _sc_9 = float(llm_result.get("score", 60))
        except (TypeError, ValueError):
            _sc_9 = 60.0
        llm_result["score"] = min(_sc_9, 60.0)
        llm_result["message"] = _n9_msg
        llm_result["_used_template"] = True
        _v2_decision_trace_push(
            llm_result,
            "Профиль termination_notice: в черновике пункта нет срока уведомления (N дней) — agrees снят, action=clarify (шаблон).",
        )

                                                                                                                 
                                                                                               
    if (
        clause_data.get("negotiation_profile") == "termination_notice"
        and not termination_notice_draft_has_notice_period(
            formulation_text, explanation_text, combined_text, combined_text
        )
        and (formulation_text or "").strip()
        and (explanation_text or "").strip()
        and not llm_result.get("agrees")
    ):
        _m_low = (llm_result.get("message") or "").lower()
        if any(
            p in _m_low
            for p in (
                "только формулировк",
                "только фраз",
                "пока вижу только",
                "не хватает пояснения",
                "не хватает связки",
            )
        ):
            notice_msgs = bot_messages.get("request_notice_period_9_2", [])
            if isinstance(notice_msgs, list) and notice_msgs:
                _n9_fix = random.choice(notice_msgs)
            elif isinstance(notice_msgs, str) and notice_msgs.strip():
                _n9_fix = notice_msgs.strip()
            else:
                _n9_fix = (
                    "В черновике нет конкретного срока уведомления в календарных днях — "
                    "укажите в полном тексте пункта, за сколько дней уведомляется Исполнитель."
                )
            llm_result["action"] = "clarify"
            try:
                _sc_n9f = float(llm_result.get("score", 58))
            except (TypeError, ValueError):
                _sc_n9f = 58.0
            llm_result["score"] = min(_sc_n9f, 60.0)
            llm_result["message"] = _n9_fix
            llm_result["_used_template"] = True
            _v2_decision_trace_push(
                llm_result,
                "Профиль termination_notice: в ходе пояснение есть, но N дней нет — замена вводящего в заблуждение шаблона на request_notice_period_9_2.",
            )

                                                                                                             
    if (
        llm_result.get("agrees")
        and not llm_result.get("_player_accepts_counterparty_revision")
        and not llm_result.get("_bot_accepted_player_revision_turn")
        and clause_data.get("negotiation_profile") == "acts"
        and not acts_profile_clause_text_has_signing_deadlines(_form_expl_for_profile_guards)
    ):
        _acts_msgs = bot_messages.get("request_act_signing_deadlines_4_1", [])
        if isinstance(_acts_msgs, list) and _acts_msgs:
            _acts_msg = random.choice(_acts_msgs)
        elif isinstance(_acts_msgs, str) and _acts_msgs.strip():
            _acts_msg = _acts_msgs.strip()
        else:
            _acts_msg = (
                "В редакции не видно, в какие сроки стороны подписывают акты. "
                "Уточните, пожалуйста, сроки или крайние даты подписания (например, для акта передачи и для актов по сопровождению)."
            )
        llm_result["agrees"] = False
        llm_result["action"] = "clarify"
        try:
            _sc_41 = float(llm_result.get("score", 60))
        except (TypeError, ValueError):
            _sc_41 = 60.0
        llm_result["score"] = min(_sc_41, 58.0)
        llm_result["message"] = _acts_msg
        llm_result["_used_template"] = True
        _v2_decision_trace_push(
            llm_result,
            "Профиль acts: нет сроков/моментов подписания актов — agrees снят, action=clarify (шаблон).",
        )

    llm_result["message"] = strip_negotiation_bot_vocative_from_reply(
        llm_result.get("message"), bot_messages
    )
    llm_result["message"] = strip_negotiation_repeated_collega_vocative(
        llm_result.get("message"),
        clause_history_exact,
    )

    if not llm_result.get("agrees"):
        llm_result["clause_excluded"] = False
        llm_result["accepted_formulation"] = None

    agrees = llm_result["agrees"]
    score = float(llm_result["score"])
    bot_message_text = llm_result["message"]
    action = llm_result["action"]

    if not bot_message_text or len(bot_message_text.strip()) < 3:
        bot_message_text = "Уточните, пожалуйста, Вашу позицию по этому пункту."

                                                                                                                 
    rules = clause_data.get("rules", {})
    allow_exclusion = rules.get("allow_clause_exclusion", False)
    is_exclusion = player_text_indicates_clause_exclusion_intent(
        (combined_text or "").strip(),
        clause_data,
        clause_history_exact,
        formulation_text=formulation_text or "",
        explanation_text=explanation_text or "",
    )
                                                                                                
                                                                                                       
                                                                                                                               
    _removal_justified = (
        removal_explanation_qualifies_for_accept(
            (combined_text or "").strip(),
            clause_data,
            clause_history_exact,
        )
        if (allow_exclusion and is_exclusion)
        else True
    )
    clause_excluded = bool(
        agrees and is_exclusion and allow_exclusion and _removal_justified
    )
    _v2_decision_trace_push(
        llm_result,
        f"Step 4 исключение пункта: is_exclusion={is_exclusion} allow_clause_exclusion={bool(allow_exclusion)} "
        f"→ clause_excluded={clause_excluded} "
        f"(правка_без_удаления={player_current_turn_seeks_clause_revision_not_removal((combined_text or '').strip(), formulation_text=formulation_text or '', explanation_text=explanation_text or '')}).",
    )

                                                                                
                                                                                                     
    if (
        agrees
        and not clause_excluded
        and not is_exclusion
        and not llm_result.get("_player_accepts_counterparty_revision")
        and (clause_data.get("negotiation_profile") or "").strip() == "liability_cap"
        and allow_exclusion
    ):
        _liab_msgs = bot_messages.get("examples_objection", [])
        if isinstance(_liab_msgs, list) and _liab_msgs:
            _liab_msg = random.choice(_liab_msgs)
        else:
            _liab_msg = "Мы не можем принять пункт в такой редакции."
        agrees = False
        action = "objection"
        score = min(score, 50.0)
        llm_result["agrees"] = False
        llm_result["action"] = "objection"
        llm_result["score"] = score
        llm_result["clause_excluded"] = False
        llm_result["accepted_formulation"] = None
        llm_result.pop("_bot_accepted_player_revision_turn", None)
        bot_message_text = _liab_msg
        llm_result["message"] = bot_message_text
        llm_result["_used_template"] = True
        _v2_decision_trace_push(
            llm_result,
            "Профиль liability_cap: предложена правка текста (не исключение пункта) — "
            "единственный корректный исход для игрока — исключить п. 6.3; agrees снят, action=objection.",
        )

                              
                                                                                                           
    replacement_text = None

                                                                                                           
    _step5_strict = clause_data.get("accepted_formulations_strict")
    _step5_blob = (formulation_text or combined_text or "").strip()
    if (
        isinstance(_step5_strict, list) and _step5_strict
        and agrees
        and not clause_excluded
        and _step5_blob
        and not llm_result.get("_player_accepts_counterparty_revision")
        and not llm_result.get("_bot_accepted_player_revision_turn")
        and not strict_whitelist_accepts_player_turn(
            clause_data,
            formulation_text=formulation_text or "",
            explanation_text=explanation_text or "",
            anchor_text=(combined_text or _step5_blob or "").strip(),
        )
    ):
        logger.info("[ChatSvc] Step 5 whitelist block: formulation fails strict patterns for %s", clause_data.get("id"))
        agrees = False
        action = "objection"
        score = min(score, 45.0)
        llm_result["clause_excluded"] = False
        llm_result["accepted_formulation"] = None
        _v2_decision_trace_push(
            llm_result,
            f"Step 5 strict (accepted_formulations_strict): не прошёл whitelist — agrees=false, action=objection (пункт {clause_data.get('id')}).",
        )

    _step5_profile = (clause_data.get("negotiation_profile") or "").strip()
                                                                     
    _step5_territory_blob = (_merged_for_agree or "").strip()
                                                                                                 
                                                                                     
    _ft_step5 = (formulation_text or "").strip()
    _step5_territory_align_src = (
        _ft_step5 if len(_ft_step5) >= 5 else _step5_territory_blob
    )
    _step5_territory_blocked = False
    _step5_territory_trace_detail = ""
    if (
        _step5_profile == "territory"
        and _step5_territory_blob
        and not llm_result.get("_player_accepts_counterparty_revision")
        and not llm_result.get("_bot_accepted_player_revision_turn")
    ):
        if _territory_raw_contains_disallowed_country_marker(_step5_territory_blob, clause_data):
            _step5_territory_blocked = True
            _step5_territory_trace_detail = "запрещённые_маркеры_стран_в_ходе"
        else:
            _bl_low = _step5_territory_blob.lower().replace("ё", "е")
            _al_low = (_step5_territory_align_src or "").lower().replace("ё", "е")
            _mention_bl = _territory_formulation_mentions_territorial_scope(_bl_low)
            _mention_al = bool(_al_low) and _territory_formulation_mentions_territorial_scope(_al_low)
            if _mention_bl or _mention_al:
                                                                                                           
                                                                                                        
                if _mention_al and len(_ft_step5) >= 5:
                    _align_blob = _step5_territory_align_src
                    _align_src_lbl = "поле_новой_редакции"
                else:
                    _align_blob = _step5_territory_blob
                    _align_src_lbl = "объединённый_текст"
                if not _territory_formulation_aligns_with_ideal_options(_align_blob, clause_data):
                    _step5_territory_blocked = True
                    _step5_territory_trace_detail = f"не_сошлось_с_допустимыми_исходами_сверка={_align_src_lbl}"
    if _step5_territory_blocked and agrees:
        agrees = False
        action = "objection"
        score = min(score, 45.0)
        llm_result["clause_excluded"] = False
        llm_result["accepted_formulation"] = None
        _v2_decision_trace_push(
            llm_result,
            f"Step 5 territory: снято согласие — {_step5_territory_trace_detail or 'territory_block'}.",
        )

                                                                                                   
                                                                                                     
    _verbal_geo_bad = (
        (clause_data.get("negotiation_profile") or "").strip() == "territory"
        and bool((_merged_for_agree or "").strip())
        and _territory_raw_contains_disallowed_country_marker(_merged_for_agree, clause_data)
    )
    if (
        not agrees
        and (formulation_text or explanation_text or combined_text or "").strip()
        and not llm_result.get("_player_accepts_counterparty_revision")
        and bot_message_signals_acceptance_of_player_revision(bot_message_text)
        and not _verbal_geo_bad
        and _player_turn_passes_strict_for_verbal_accept_paths()
        and not _incorrect_example_block
        and not _profile_blocks_verbal_accept_bridge
    ):
        try:
            _sc_va = float(llm_result.get("score") or 0)
        except (TypeError, ValueError):
            _sc_va = 0.0
        agrees = True
        action = "accept"
        score = max(_sc_va, 92.0)
        llm_result["agrees"] = True
        llm_result["action"] = "accept"
        llm_result["score"] = score
        llm_result["clause_excluded"] = False
        llm_result["accepted_formulation"] = None
        llm_result["_bot_accepted_player_revision_turn"] = True
        clause_excluded = bool(
            agrees and is_exclusion and allow_exclusion and _removal_justified
        )
        _v2_decision_trace_push(
            llm_result,
            "Восстановление согласия по тексту ответа бота (после Step 5): agrees=true, мост _bot_accepted_player_revision_turn "
            f"(territory_geo_block={_verbal_geo_bad}).",
        )
    elif (
        not agrees
        and (formulation_text or explanation_text or combined_text or "").strip()
        and not llm_result.get("_player_accepts_counterparty_revision")
        and bot_message_signals_acceptance_of_player_revision(bot_message_text)
        and not _verbal_geo_bad
        and not _player_turn_passes_strict_for_verbal_accept_paths()
    ):
        _v2_decision_trace_push(
            llm_result,
            "Восстановление согласия по тексту бота (после Step 5): выкл — ход игрока не проходит accepted_formulations_strict.",
        )
    elif (
        not agrees
        and (formulation_text or explanation_text or combined_text or "").strip()
        and not llm_result.get("_player_accepts_counterparty_revision")
        and bot_message_signals_acceptance_of_player_revision(bot_message_text)
        and not _verbal_geo_bad
        and _player_turn_passes_strict_for_verbal_accept_paths()
        and _incorrect_example_block
    ):
        _v2_decision_trace_push(
            llm_result,
            "Восстановление согласия по тексту бота (после Step 5): выкл (incorrect_examples).",
        )
    elif (
        not agrees
        and (formulation_text or explanation_text or combined_text or "").strip()
        and not llm_result.get("_player_accepts_counterparty_revision")
        and bot_message_signals_acceptance_of_player_revision(bot_message_text)
        and not _verbal_geo_bad
        and _player_turn_passes_strict_for_verbal_accept_paths()
        and _profile_blocks_verbal_accept_bridge
    ):
        _v2_decision_trace_push(
            llm_result,
            "Восстановление согласия по тексту бота (после Step 5): выкл (profile=liability_cap).",
        )

    if agrees and _incorrect_example_block:
        try:
            _sc_ie_belt = float(llm_result.get("score") or 0)
        except (TypeError, ValueError):
            _sc_ie_belt = 0.0
        agrees = False
        action = "objection"
        score = min(_sc_ie_belt, 48.0)
        llm_result["agrees"] = False
        llm_result["action"] = "objection"
        llm_result["score"] = score
        llm_result["clause_excluded"] = False
        llm_result["accepted_formulation"] = None
        llm_result.pop("_bot_accepted_player_revision_turn", None)
        clause_excluded = False
        _v2_decision_trace_push(
            llm_result,
            "Страховка incorrect_examples: agrees снят после Step 5 (черновик из negated examples).",
        )

                                                                                         
                                                                                               
    if (
        not agrees
        and not llm_result.get("_player_accepts_counterparty_revision")
        and bot_message_signals_acceptance_of_player_revision(bot_message_text)
    ):
        _old_msg = (bot_message_text or "").strip()
        _fallback_objection = pick_generic_no_cheatsheet_objection_message(bot_messages)
        if not _fallback_objection:
            _fallback_objection = "Не можем принять такую редакцию в текущем виде. Уточните, пожалуйста, формулировку по условиям пункта."
        bot_message_text = sanitize_bot_reply_full_position_objection(_fallback_objection, bot_messages)
        llm_result["message"] = bot_message_text
        action = "objection"
        llm_result["action"] = action
        _v2_decision_trace_push(
            llm_result,
            "Финальный guard текста ответа: agrees=false и в реплике были маркеры принятия — "
            f"сообщение заменено на возражение (old={_plain_snip(_old_msg, 120)!r}).",
        )

    if agrees and not clause_excluded:
        _acc_form = llm_result.get("accepted_formulation")
        if _acc_form:
            replacement_text = _acc_form
        elif _clause_uses_case_canonical_for_contract(clause_data):
            proximity = llm_result.get("_etalon_proximity", {})
            if (proximity.get("is_near") or proximity.get("is_close")) and proximity.get("best_match"):
                _bm = str(proximity["best_match"]).strip()
                if _best_match_ok_for_contract_substitution(_bm, clause_data):
                    replacement_text = _bm
            if not replacement_text:
                _src_fb = (formulation_text or "").strip()
                if not _src_fb:
                    _comb_fb = (combined_text or "").strip()
                    if _comb_fb and not (re.search(r"\?\s*$", _comb_fb) and len(_comb_fb) <= 320):
                        _src_fb = _comb_fb
                if _src_fb:
                    replacement_text = find_best_matching_ideal_option(_src_fb, clause_data)
            if not replacement_text:
                replacement_text = (formulation_text or "").strip() or None
            if (
                replacement_text
                and not _best_match_ok_for_contract_substitution(str(replacement_text).strip(), clause_data)
            ):
                replacement_text = None
        else:
            replacement_text = (formulation_text or combined_text or "").strip() or None
        if llm_result.get("_player_accepts_counterparty_revision"):
                                                                                                       
                                                                                                  
            replacement_text = None
        elif (
            not _acc_form
            and (formulation_text or "").strip()
            and _clause_uses_case_canonical_for_contract(clause_data)
            and not llm_result.get("_bot_accepted_player_revision_turn")
            and player_formulation_is_literal_canonical_for_contract(
                (formulation_text or "").strip(), clause_data
            )
        ):
                                                                                                                 
            replacement_text = (formulation_text or "").strip()
        if replacement_text:
            replacement_text, _ = _apply_accepted_replacement_normalization(
                replacement_text, clause_data
            )

                                                                                              
                                                                                                         
    if (
        agrees
        and not clause_excluded
        and not llm_result.get("_player_accepts_counterparty_revision")
        and not llm_result.get("_bot_accepted_player_revision_turn")
        and _clause_uses_case_canonical_for_contract(clause_data)
        and not (replacement_text or "").strip()
    ):
        agrees = False
        action = "clarify"
        try:
            _sc_canon_guard = float(llm_result.get("score") or 55)
        except (TypeError, ValueError):
            _sc_canon_guard = 55.0
        score = min(_sc_canon_guard, 58.0)
        llm_result["agrees"] = False
        llm_result["action"] = action
        llm_result["score"] = score
        llm_result["clause_excluded"] = False
        clause_excluded = False
        llm_result["accepted_formulation"] = None
        llm_result.pop("_bot_accepted_player_revision_turn", None)
        if bot_message_signals_acceptance_of_player_revision(bot_message_text):
            _fb_cg = pick_generic_no_cheatsheet_objection_message(bot_messages)
            if not _fb_cg:
                _fb_cg = (
                    "Нужна формулировка пункта, близкая к допустимым вариантам по делу; "
                    "короткий вопрос или общее пояснение не заменяют текст договора."
                )
            bot_message_text = sanitize_bot_reply_full_position_objection(_fb_cg, bot_messages)
            llm_result["message"] = bot_message_text
        _v2_decision_trace_push(
            llm_result,
            "Canonical contract: снято согласие — нет безопасной подстановки в договор "
            "(accepted_formulation/replacement отклонены как не близко к эталону).",
        )

                                   
    chat_complete = False
    _plain_auto_close: str | None = None
    if agrees:
        chat_complete = True
    elif action == "reject_close":
        chat_complete = True

              
    _patience_disabled = os.getenv("DISABLE_BOT_PATIENCE", "").strip().lower() in ("1", "true", "yes")
    if agrees:
        new_patience = max_patience
    elif chat_complete:
        new_patience = 0 if not _patience_disabled else max_patience
    else:
        hint = "clarify" if score >= 40 else "off_topic"
        new_patience = (
            max_patience if _patience_disabled
            else max(1, _calc_new_patience(current_patience, hint, 0))
        )

                                                          
    if not agrees and not chat_complete and bot_reply_count >= MIN_BOT_REPLIES_BEFORE_CLOSE:
        if new_patience <= 0:
            chat_complete = True
            _plain_auto_close = "patience"
            _close_list = bot_messages.get("close_counterpart_wins", [])
            if isinstance(_close_list, list) and _close_list:
                bot_message_text = random.choice(_close_list)
            elif isinstance(_close_list, str):
                bot_message_text = _close_list

                       
    if not agrees and not chat_complete and bot_reply_count >= MAX_REPLIES:
        chat_complete = True
        _plain_auto_close = "max_replies"
        _close_list = bot_messages.get("close_counterpart_wins", [])
        if isinstance(_close_list, list) and _close_list:
            bot_message_text = random.choice(_close_list)
        elif isinstance(_close_list, str):
            bot_message_text = _close_list

    if _plain_auto_close in ("patience", "max_replies") and (bot_message_text or "").strip():
        bot_message_text = prefix_bot_close_if_player_sent_revision_draft(
            bot_message_text,
            formulation_text=formulation_text or "",
            explanation_text=explanation_text or "",
            combined_text=combined_text or "",
        )

                                          
    if agrees:
        if clause_excluded:
            next_status = ClauseStatus["EXCLUDED"]
            outcome_type = OutcomeType.CLAUSE_EXCLUDED
        elif llm_result.get("_player_accepts_counterparty_revision"):
            next_status = ClauseStatus["ACCEPTED_BOT"]
            outcome_type = OutcomeType.ACCEPTED_COUNTERPARTY
        elif replacement_text:
            next_status = ClauseStatus["CHANGED"]
            outcome_type = OutcomeType.ACCEPTED_PLAYER_CHANGE
        else:
            next_status = ClauseStatus["KEPT_COUNTERPARTY"]
            outcome_type = OutcomeType.KEPT_ORIGINAL
    elif chat_complete:
        next_status = ClauseStatus["KEPT_COUNTERPARTY"]
        outcome_type = OutcomeType.CLOSED_NO_AGREEMENT
    else:
        next_status = ClauseStatus["SELECTED"]
        outcome_type = OutcomeType.PENDING

                                                                                             
                                                                                               
    _bot_confirms_exclusion = bot_message_accepts_clause_exclusion(bot_message_text, bot_messages)
    _clause_allows_exclusion = clause_exclusion_negotiation_allowed(clause_data)
    _player_wants_exclusion = player_text_indicates_clause_exclusion_intent(
        (combined_text or "").strip(),
        clause_data,
        clause_history_exact,
        formulation_text=formulation_text or "",
        explanation_text=explanation_text or "",
    )
                                                                                        
                                                                                        
                                                                                 
    if (
        not _player_wants_exclusion
        and _clause_allows_exclusion
        and _bot_confirms_exclusion
        and agrees
        and not player_current_turn_seeks_clause_revision_not_removal(
            (combined_text or "").strip(),
            formulation_text=formulation_text or "",
            explanation_text=explanation_text or "",
        )
    ):
        _acc = _accumulated_player_text_for_clause(clause_history_exact)
        _combined_acc = f"{_acc} {(combined_text or '').strip()}".strip()
        if accumulated_player_text_suggests_explicit_clause_removal(_combined_acc):
            _player_wants_exclusion = True
            _v2_decision_trace_push(
                llm_result,
                "Исключение (уточнение): в накопленных репликах игрока найдены маркеры удаления/исключения, "
                "а бот в этом ходу подтвердил исключение — намерение игрока засчитано как исключение пункта.",
            )

    if (
        _clause_allows_exclusion
        and _player_wants_exclusion
        and _bot_confirms_exclusion
        and removal_explanation_qualifies_for_accept(
            (combined_text or "").strip(),
            clause_data,
            clause_history_exact,
        )
    ):
        agrees = True
        chat_complete = True
        clause_excluded = True
        replacement_text = None
        next_status = ClauseStatus["EXCLUDED"]
        outcome_type = OutcomeType.CLAUSE_EXCLUDED
        new_patience = max_patience
        _v2_decision_trace_push(
            llm_result,
            "Итог: согласованное исключение пункта — текст бота подтверждает исключение, намерение игрока по правилам = удаление/исключение.",
        )

                                                                                                
    if (
        clause_excluded
        and allow_exclusion
        and not removal_explanation_qualifies_for_accept(
            (combined_text or "").strip(),
            clause_data,
            clause_history_exact,
        )
    ):
        try:
            _sc_belt = float(llm_result.get("score") or 50)
        except (TypeError, ValueError):
            _sc_belt = 50.0
        agrees = False
        chat_complete = False
        clause_excluded = False
        action = "clarify"
        score = min(_sc_belt, 55.0)
        llm_result["agrees"] = False
        llm_result["action"] = "clarify"
        llm_result["score"] = score
        llm_result["clause_excluded"] = False
        llm_result["accepted_formulation"] = None
        next_status = ClauseStatus["SELECTED"]
        outcome_type = OutcomeType.PENDING
        new_patience = (
            max_patience
            if os.getenv("DISABLE_BOT_PATIENCE", "").strip().lower() in ("1", "true", "yes")
            else max(1, _calc_new_patience(current_patience, "clarify", 0))
        )
        _rq_rm = bot_messages.get("request_explanation_removal")
        if isinstance(_rq_rm, list) and _rq_rm:
            _rq_pick = [x for x in _rq_rm if isinstance(x, str) and x.strip()]
            bot_message_text = random.choice(_rq_pick) if _rq_pick else ""
        elif isinstance(_rq_rm, str) and _rq_rm.strip():
            bot_message_text = _rq_rm.strip()
        else:
            _rq_def = (
                "Чтобы рассмотреть исключение пункта, опишите правовую или договорную позицию: "
                "во что упирается требование, ссылку на другой пункт, риск или противоречие."
            )
            _rq_ex = bot_messages.get("request_explanation_only")
            if isinstance(_rq_ex, list) and _rq_ex:
                _ex_pick = [x for x in _rq_ex if isinstance(x, str) and x.strip()]
                bot_message_text = random.choice(_ex_pick) if _ex_pick else _rq_def
            elif isinstance(_rq_ex, str) and _rq_ex.strip():
                bot_message_text = _rq_ex.strip()
            else:
                bot_message_text = _rq_def
        llm_result["message"] = bot_message_text
        _v2_decision_trace_push(
            llm_result,
            "Страховка исключения: обоснование не проходит removal_explanation_qualifies_for_accept — "
            "согласие на исключение снято, запрошено пояснение.",
        )

                                                                                                
                                                                                                
                                                                                   
    _skip_dup_close_sanitize = bool(
        llm_result.get("_v2_post_llm_path") and not _plain_auto_close
    )
    if not chat_complete or not _skip_dup_close_sanitize:
        bot_message_text = _ensure_final_negotiation_close_message(
            bot_message_text,
            chat_complete=chat_complete,
            agrees=agrees,
            bot_messages=bot_messages,
        )

    bot_message_text = sanitize_1_4_2_bot_avoid_explicit_111_reference(
        bot_message_text, clause_data
    )
    llm_result["message"] = bot_message_text

    negotiation_trace_add_phase("deterministic_after_llm", time.perf_counter() - t_det)

    _plain_summary_parts = [
        "Ответ контрагента сформирован с помощью искусственного интеллекта, затем проверен по правилам сценария."
    ]
    if _plain_auto_close == "patience":
        _plain_summary_parts.append(
            "Запас терпения контрагента исчерпан — диалог по пункту завершён автоматически."
        )
        _v2_decision_trace_push(
            llm_result,
            "Автозакрытие: исчерпан запас терпения — текст из шаблона close_counterpart_wins.",
        )
    elif _plain_auto_close == "max_replies":
        _plain_summary_parts.append(
            "Контрагент больше не продолжает обсуждение этого пункта в этом раунде — диалог завершён."
        )
        _v2_decision_trace_push(
            llm_result,
            "Автозакрытие: достигнут лимит реплик контрагента — текст из шаблона close_counterpart_wins.",
        )
    elif chat_complete and not agrees and action == "reject_close":
        _plain_summary_parts.append(
            "Контрагент окончательно отказался и закрыл переговоры по этому пункту."
        )
    elif agrees:
        _plain_summary_parts.append(
            "Зафиксировано согласие с вашей позицией (или компромисс в рамках правил этого пункта)."
        )
    if llm_result.get("reason") == "anti_coaching":
        _plain_summary_parts.append(
            "Вы просили подсказку; в черновом ответе прозвучала «эталонная» формулировка — показан нейтральный ответ из сценария."
        )
    _plain_summary_llm = " ".join(_plain_summary_parts)

    _v2_tech_log(
        "[NegV2] === RESULT === clause=%s agrees=%s score=%.0f action=%s complete=%s excluded=%s outcome=%s msg='%s'",
        clause_id, agrees, score, action, chat_complete, clause_excluded,
        outcome_type.value, bot_message_text[:320],
    )
    for _tr_line in llm_result.get("_v2_decision_trace") or []:
        _v2_tech_log("[NegV2] trace | %s", _tr_line)

    _log_negotiation_plain_v2(
        _clause_lbl, turn_number, _player_snip,
        summary=_plain_summary_llm,
        agrees=agrees, chat_complete=chat_complete, action=action,
        outcome=outcome_type,
        current_patience=current_patience, new_patience=new_patience,
        max_patience=max_patience, bot_reply_count=bot_reply_count,
        bot_reply_snip=bot_message_text or "",
        clause_excluded_for_contract=bool(clause_excluded),
        contract_new_text_snip=(
            replacement_text if (agrees and not clause_excluded and replacement_text) else None
        ),
        decision_trace=list(llm_result.get("_v2_decision_trace") or []),
    )

    _mirror_negotiation_reply_audit(
        negotiation_session_id,
        clause_id,
        route_code="llm_v2_pipeline",
        why_bullets=_llm_v2_audit_why_bullets(
            llm_result,
            plain_auto_close=_plain_auto_close,
            clause_excluded=bool(clause_excluded),
        ),
        pipeline_t0=pipeline_t0,
        bot_message_snip=bot_message_text or "",
        outcome_summary=(
            f"outcome={outcome_type.value} chat_complete={chat_complete} "
            f"clause_excluded={bool(clause_excluded)}"
        ),
        action=action,
    )

    if agrees and (
        "принимаем" in (bot_message_text or "").lower()
        or "принимаю" in (bot_message_text or "").lower()
        or "соглас" in (bot_message_text or "").lower()
    ):
        if (formulation_text or "").strip() and (explanation_text or "").strip():
            _lesson = (
                "Игрок уже прислал и редакцию пункта, и пояснение — при согласии не просить снова "
                "«предложите редакцию и пояснение»."
            )
            _append_ai_lesson(history, clause_id, _lesson)
            add_global_ai_lesson(case_code or "case-001", clause_id, _lesson)

    _ers = None
    try:
        _ers = llm_result.get("explanation_reference_similarity_0_100")
        if _ers is not None:
            _ers = float(_ers)
    except (TypeError, ValueError):
        _ers = None

    return _finalize_response(
        history, clause_id, clause_data, negotiation_session_id,
        bot_message=bot_message_text, agrees=agrees, score=score,
        next_status=next_status, replacement_text=replacement_text,
        chat_complete=chat_complete, new_patience=new_patience,
        patience_map=patience_map, bot_reply_count=bot_reply_count,
        outcome_type=outcome_type, clause_excluded=clause_excluded,
        explanation_reference_similarity_0_100=_ers,
    )


def send_message(
    negotiation_session_id: int,
    clause_id: str,
    player_input: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Обработка сообщения игрока в переговорах (Вариант C — упрощённый гибрид).

    Поток:
    1. Извлечение текста из запроса
    2. Загрузка состояния сессии
    3. Запись сообщения игрока в историю
    4. Быстрые проверки (оскорбления, согласие с контрагентом)
    5. Оценка через LLM (AI-режим) или bot_logic (простой режим)
    6. Определение replacement_text
    7. Логика завершения чата (лимит реплик, терпение)
    8. Обновление терпения, сохранение, ответ

    Внутри вызова ведётся телеметрия HTTP (см. negotiation_trace).
    """
    from services.negotiation_trace import negotiation_trace_scope

    with negotiation_trace_scope(str(clause_id)):
        return _send_message_inner(negotiation_session_id, clause_id, player_input)


def _send_message_inner(
    negotiation_session_id: int,
    clause_id: str,
    player_input: Dict[str, Any],
) -> Dict[str, Any]:
    """Реализация send_message (подсчёт openai_http_calls — в обёртке send_message)."""
                                                                                                  
    formulation_text = ""
    explanation_text = ""
    justification_text = ""
    combined_text = ""

                                  
    player_input = player_input if isinstance(player_input, dict) else {}
    formulation_text = (player_input.get("formulationText") or "").strip()
    explanation_text = (player_input.get("explanationText") or "").strip()
                                                                                                                                  
    _ft_low = formulation_text.lower().rstrip(".")
    if _ft_low in (
        "стоимость по договору составляет 1 млн рублей",
        "стоимость по договору составляет 1 млн руб",
        "стоимость по договору составляет 1 млн руб.",
    ):
        formulation_text = ""
                                                                                                         
    formulation_text, explanation_text = extract_embedded_formulation_from_explanation(
        formulation_text, explanation_text
    )
    formulation_text = strip_revision_meta_from_clause_draft(formulation_text)
    justification_text = (player_input.get("justificationText") or "").strip()
    action = player_input.get("action") or "change"
    new_clause_text = (player_input.get("newClauseText") or "").strip()
    choice_index = player_input.get("choiceIndex")
    reason_index = player_input.get("reasonIndex")

    if isinstance(choice_index, str) and choice_index.isdigit():
        choice_index = int(choice_index)
    if isinstance(reason_index, str) and reason_index.isdigit():
        reason_index = int(reason_index)

    if formulation_text or explanation_text:
        combined_text = (
            (formulation_text + "\n" + explanation_text).strip()
            if formulation_text and explanation_text
            else formulation_text or explanation_text
        )
    elif justification_text:
        combined_text = justification_text
    elif new_clause_text:
        combined_text = new_clause_text
    else:
        combined_text = ""

                                   
    history = get_chat_history(negotiation_session_id)
    clause_data = get_clause_data(negotiation_session_id, clause_id)
    ai_mode_enabled = is_ai_mode(negotiation_session_id)
    contract_code = get_contract_code_for_session(negotiation_session_id)
    case_code = get_case_code_for_negotiation_session(negotiation_session_id)
    bot_messages = get_bot_messages_for_session(negotiation_session_id)

    player_choice: Dict[str, Any] = {}
    if action in ("reject", "insist"):
        player_choice["reasonIndex"] = reason_index if reason_index is not None else choice_index
    elif action == "change":
        if reason_index is not None or choice_index is not None:
            player_choice["changeReasonIndex"] = reason_index
            player_choice["changeOptionIndex"] = choice_index

    if not combined_text:
        combined_text = _resolve_effective_player_message(
            action, clause_data, "", "", player_choice,
            chat_history=_get_chat_history_for_clause(history, clause_id),
            clause_id=clause_id,
        ).strip()

                                                                                        
    _cid_key = str(clause_id)
    if combined_text and not (history.get("clause_dialogue_started_at") or {}).get(_cid_key):
        _sm = dict(history.get("clause_dialogue_started_at") or {})
        _sm[_cid_key] = datetime.now(timezone.utc).isoformat()
        history["clause_dialogue_started_at"] = _sm

                                        
    if combined_text:
        _append_to_clause_history(history, clause_id, {
            "text": combined_text,
                    "owner": "player",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "clauseId": clause_id,
                    "action": action,
        })

    clause_history = _get_chat_history_for_clause(history, clause_id)
                                                                                                                  
    clause_history_exact = _get_chat_history_for_clause_exact(history, clause_id)
    bot_reply_count = sum(1 for m in clause_history_exact if m.get("owner") == "bot")
    last_bot_message_text = ""
    for _m in reversed(clause_history):
        if _m.get("owner") == "bot":
            last_bot_message_text = (_m.get("text") or _m.get("message") or "").strip()
            break
    MAX_REPLIES = 4
                                                                                                                                      
    MIN_BOT_REPLIES_BEFORE_CLOSE = 4

                                                                                        
    lessons_by_clause = history.get("ai_lessons_by_clause") or {}
    clause_num = (clause_data.get("number") or clause_id) if isinstance(clause_data.get("number"), str) else clause_id
    session_lessons = list(lessons_by_clause.get(clause_id, []) or []) + list(lessons_by_clause.get(clause_num, []) or [])
    global_lessons = get_global_ai_lessons(case_code, clause_id)
    ai_lessons = session_lessons + global_lessons

    patience_map = history.get("patience") or {}
    max_patience = int(history.get("max_patience", PATIENCE_MAX))
    current_patience = _patience_from_map_for_clause(
        patience_map, clause_id, clause_data, default_max=max_patience
    )

                                                                        
    if ai_mode_enabled:
        return _send_message_v2(
            history=history,
            clause_id=clause_id,
            clause_data=clause_data,
            negotiation_session_id=negotiation_session_id,
            combined_text=combined_text,
            formulation_text=formulation_text,
            explanation_text=explanation_text,
            clause_history=clause_history,
            clause_history_exact=clause_history_exact,
            bot_reply_count=bot_reply_count,
            bot_messages=bot_messages,
            patience_map=patience_map,
            max_patience=max_patience,
            current_patience=current_patience,
            case_code=case_code,
            ai_lessons=ai_lessons,
        )

                                                                           
                                                                                 
    raise NotImplementedError(
        f"Simple-mode (non-AI) negotiation has been removed. "
        f"Enable AI mode for session {negotiation_session_id}."
    )

