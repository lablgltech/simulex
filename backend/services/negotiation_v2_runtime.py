"""Движок переговоров этапа 3 (v2): правила и заглушка оценки хода игрока."""

from __future__ import annotations

import difflib
import json
import logging
import os
import random
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from services.ai_payload import MINIMAL_SYSTEM_MESSAGE, compact_user_payload

from services.ai_counterpart_rules import (
    explanation_text_isolated_for_scoring,
    has_explanation_markers as rules_has_explanation_markers,
    is_real_explanation,
    territory_clear_geography_staff_explanation_ok,
    negotiation_clause_is_acts_profile,
    pick_formulation_candidate_for_defective_screening,
    player_proposes_remove_clause,
    player_text_indicates_clause_exclusion_intent,
    removal_explanation_qualifies_for_accept,
    bot_message_accepts_clause_exclusion,
    player_asks_for_coaching_or_hint,
    bot_message_volunteers_exclusion_or_revision_playbook,
    bot_response_coaches_ideal_solution,
    bot_reply_coaches_via_rhetorical_question,
    bot_message_leaks_related_contract_snippet,
    pick_no_coaching_reply,
    strip_revision_meta_from_clause_draft,
    bot_message_leaks_territory_ideal_enumeration,
    bot_message_leaks_clause_ideal_enumeration,
    pick_territory_question_no_enumeration_reply,
    pick_generic_no_cheatsheet_objection_message,
    strip_negotiation_bot_vocative_from_reply,
    _text_looks_like_standalone_clause_wording,
    thin_termination_explanation_acceptable,
)
from services.bot_logic import find_best_matching_ideal_option

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"


def _neg_v2_plain_logs() -> bool:
    for _k in ("CHAT_LOGS_IN_TERMINAL", "NEGOTIATION_PLAIN_LOGS", "READABLE_CHAT_LOGS"):
        _v = os.getenv(_k, "").strip().lower()
        if _v in ("1", "true", "yes", "on", "да"):
            return True
    return False


def _neg_v2_info(msg: str, *args: Any) -> None:
    if _neg_v2_plain_logs():
        logger.debug(msg, *args)
    else:
        logger.info(msg, *args)



def normalize_text_for_strict_formulation_whitelist(text: str) -> str:
    """
    UI часто присылает « … » с пробелами внутри кавычек — re.fullmatch на всю строку иначе падает.
    Убираем внешние кавычки и схлопываем пробелы (для accepted_formulations_strict).
    """
    _strip_q = " \t«»„“\"'‹›"
    s = (text or "").strip().lower().replace("ё", "е")
    s = re.sub(r"\s+", " ", s).strip(_strip_q)
    s = re.sub(r"\s+", " ", s).strip(_strip_q)
    return s


def _collect_clause_canonical_strings_for_typos(clause_data: dict | None) -> list[str]:
    """Эталонные формулировки из кейса (для опечаток и дословной подстановки в договор)."""
    out: list[str] = []
    seen: set[str] = set()
    cd = clause_data or {}
    for key in ("ideal_option", "correct_example"):
        v = cd.get(key)
        if isinstance(v, str) and v.strip():
            t = v.strip()
            k = " ".join(t.lower().split())
            if k not in seen:
                seen.add(k)
                out.append(t)
    for item in cd.get("ideal_options") or []:
        s = (item.get("text", item) if isinstance(item, dict) else str(item)).strip()
        if s:
            k = " ".join(s.lower().split())
            if k not in seen:
                seen.add(k)
                out.append(s)
    for ex in cd.get("correct_examples") or []:
        if isinstance(ex, str) and ex.strip():
            t = ex.strip()
            k = " ".join(t.lower().split())
            if k not in seen:
                seen.add(k)
                out.append(t)
    return out


def _non_territory_strict_near_canonical(blob: str, clause_data: dict) -> bool:
    """Черновик близок к одной из канонических строк пункта (не territory-профиль)."""
    t = (blob or "").strip()
    if len(t) < 8:
        return False
    candidates = _collect_clause_canonical_strings_for_typos(clause_data)
    if not candidates:
        return False
    try:
        from services.similarity_service import normalized_levenshtein_ratio
    except Exception:
        return False
    ca = " ".join(t.lower().replace("ё", "е").split())
    best = -1.0
    second = -1.0
    for c in candidates:
        cb = " ".join(c.lower().replace("ё", "е").split())
        if len(cb) < 5:
            continue
        r = normalized_levenshtein_ratio(ca, cb)
        if r > best:
            second, best = best, r
        elif r > second:
            second = r
    if best < 0.84:
        return False
    if second >= 0.80 and (best - second) < 0.03:
        return False
    return True


def player_formulation_is_literal_canonical_for_contract(
    formulation_text: str,
    clause_data: dict | None,
) -> bool:
    """
    Новая редакция совпадает с эталоном из кейса (regex fullmatch или нормализованное равенство).
    Тогда в договор подставляем текст игрока как есть (без подмены на другой вариант эталона).
    """
    ft = (formulation_text or "").strip()
    if len(ft) < 2:
        return False
    cd = clause_data or {}
    patterns = cd.get("accepted_formulations_strict")
    if isinstance(patterns, list) and patterns and strict_whitelist_text_fullmatch(cd, ft):
        return True
    fn = normalize_text_for_strict_formulation_whitelist(ft)
    if not fn:
        return False
    for s in _collect_clause_canonical_strings_for_typos(cd):
        if normalize_text_for_strict_formulation_whitelist(s) == fn:
            return True
    return False


def strict_whitelist_text_fullmatch(clause_data: dict, text: str) -> bool:
    """accepted_formulations_strict: вся строка должна fullmatch одному regex."""
    patterns = clause_data.get("accepted_formulations_strict")
    if not isinstance(patterns, list) or not patterns:
        return True
    check = normalize_text_for_strict_formulation_whitelist(text)
    if not check:
        return False
    for raw in patterns:
        if not isinstance(raw, str):
            continue
        p = raw.strip()
        if not p:
            continue
        try:
            if re.fullmatch(p, check, flags=re.IGNORECASE | re.UNICODE):
                return True
        except re.error as exc:
            logger.warning(
                "[NegV2] accepted_formulations_strict invalid regex: %s (%s)",
                p[:120],
                exc,
            )
    return False


def strict_whitelist_accepts_player_turn(
    clause_data: dict,
    *,
    formulation_text: str = "",
    explanation_text: str = "",
    anchor_text: str = "",
) -> bool:
    """
    Проверка accepted_formulations_strict (re.fullmatch).

    Для negotiation_profile=territory (п. 1.4.1 и аналоги) белый список в приоритете:
    отдельно проверяется поле «Новая редакция» и (если в пояснении есть география пункта)
    текст пояснения — чтобы не принять «По всему миру» в форме и «На территории России и Ноута»
    только в пояснении, и чтобы не обходили fuzzy/LLM через якорь только из формулировки.

    Для остальных пунктов с strict — одна строка: формулировка, иначе anchor_text (как раньше).
    """
    patterns = clause_data.get("accepted_formulations_strict")
    if not isinstance(patterns, list) or not patterns:
        return True
    prof = (clause_data.get("negotiation_profile") or "").strip()
    form = (formulation_text or "").strip()
    expl = (explanation_text or "").strip()
    anchor = (anchor_text or "").strip()
    if prof == "territory":
        from services.ai_counterpart_rules import (
            _territory_formulation_aligns_with_ideal_options,
            _territory_formulation_mentions_territorial_scope,
            _territory_raw_contains_disallowed_country_marker,
        )

                                                                                                       
                                                                                  
        _merged = f"{form} {expl} {anchor}".strip()
        if _territory_raw_contains_disallowed_country_marker(_merged, clause_data):
            return False

        def _territory_field_passes_strict(blob: str) -> bool:
            if strict_whitelist_text_fullmatch(clause_data, blob):
                return True
            return _territory_formulation_aligns_with_ideal_options(blob, clause_data)

        if len(form) >= 5:
            if not _territory_field_passes_strict(form):
                return False
        if len(expl) >= 5:
            expl_low = expl.lower().replace("ё", "е")
            if _territory_formulation_mentions_territorial_scope(expl_low):
                                                                                                      
                if len(form) >= 5 and _territory_field_passes_strict(form):
                    pass
                elif not _territory_field_passes_strict(expl):
                    return False
        if len(form) < 5 and len(expl) < 5 and anchor:
            al = anchor.lower().replace("ё", "е")
            if _territory_formulation_mentions_territorial_scope(al):
                if not _territory_field_passes_strict(anchor):
                    return False
        return True
    blob = form if form else (expl or anchor)
    if not blob:
        return False
    if strict_whitelist_text_fullmatch(clause_data, blob):
        return True
    return _non_territory_strict_near_canonical(blob, clause_data)


def apply_final_strict_formulation_whitelist(
    result: dict,
    clause_data: dict,
    formulation_text: str,
    explanation_text: str,
    *,
    is_exclusion_request: bool,
    allow_exclusion: bool,
) -> None:
    if not result.get("agrees"):
        return
    if is_exclusion_request and allow_exclusion:
        return
    patterns = clause_data.get("accepted_formulations_strict")
    if not isinstance(patterns, list) or not patterns:
        return
    form = (formulation_text or "").strip()
    expl = (explanation_text or "").strip()
    combined = f"{form} {expl}".strip()
    if strict_whitelist_accepts_player_turn(
        clause_data,
        formulation_text=formulation_text,
        explanation_text=explanation_text,
        anchor_text=combined or (formulation_text or explanation_text or "").strip(),
    ):
        return
    check_src = form if form else combined
    _neg_v2_info(
        "[NegV2] Strict whitelist BLOCKED agrees=True (fullmatch): '%s'",
        check_src[:100],
    )
    result["agrees"] = False
    result["action"] = "objection"
    try:
        sc = float(result.get("score", 50))
    except (TypeError, ValueError):
        sc = 50.0
    result["score"] = min(sc, 45.0)
    result["reason"] = "strict_formulation_whitelist"
    result["message"] = (
        "Такую территорию согласовать не можем — это создаёт для нас дополнительные "
        "лицензионные риски. Предложите другой вариант."
    )
    result["_used_template"] = True



def _v2_negotiation_contract_field_defaults() -> Dict[str, Any]:
    return {"clause_excluded": False, "accepted_formulation": None}


def _normalize_to_nearest_etalon_if_very_close(
    text: str,
    clause_data: dict,
    *,
    max_distance: float = 0.20,
) -> Optional[str]:
    """
    Если текст игрока очень близок к одному из эталонов (1 - ratio <= max_distance),
    вернуть грамотную строку эталона (исправление опечаток вроде «всего мир»).
    """
    c = (text or "").strip().lower().replace("ё", "е")
    if len(c) < 5:
        return None
    etalons: list[str] = []
    for key in ("ideal_options", "correct_examples", "etalon_phrases"):
        vals = clause_data.get(key) or []
        if isinstance(vals, list):
            for item in vals:
                s = (item.get("text", item) if isinstance(item, dict) else str(item)).strip()
                if s and len(s) >= 4:
                    etalons.append(s)
    for key in ("ideal_option", "correct_example"):
        v = clause_data.get(key)
        if isinstance(v, str) and v.strip():
            etalons.append(v.strip())
    if not etalons:
        return None
    best_dist = 1.0
    best: Optional[str] = None
    for et in etalons:
        el = et.lower().strip().replace("ё", "е")
        ratio = difflib.SequenceMatcher(None, c, el).ratio()
        d = 1.0 - ratio
        if d < best_dist:
            best_dist = d
            best = et
    if best is not None and best_dist <= max_distance:
        return best
    return None


def _best_match_ok_for_contract_substitution(best: str, clause_data: dict) -> bool:
    """
    Короткие строки из etalon_phrases («противоречит п. 1.1.1») — подсказки для оценки, не текст договора.
    В договор подставляем только полные каноны из ideal_options / correct_examples / ideal_option.
    """
    b_norm = " ".join((best or "").strip().lower().split())
    if len(b_norm) < 5:
        return False
    canonical: list[str] = []
    io = clause_data.get("ideal_option")
    if isinstance(io, str) and io.strip():
        canonical.append(" ".join(io.strip().lower().split()))
    for opt in clause_data.get("ideal_options") or []:
        if isinstance(opt, str) and opt.strip():
            canonical.append(" ".join(opt.strip().lower().split()))
    for ex in clause_data.get("correct_examples") or []:
        if isinstance(ex, str) and ex.strip():
            canonical.append(" ".join(ex.strip().lower().split()))
    ce = clause_data.get("correct_example")
    if isinstance(ce, str) and ce.strip():
        canonical.append(" ".join(ce.strip().lower().split()))
    for c in canonical:
        if not c:
            continue
        if b_norm == c:
            return True
                                                                                                  
        if len(b_norm) >= 44 and (b_norm in c or c in b_norm):
            return True
    return False


def _blob_disallowed_as_clause_contract_substitute(blob: str) -> bool:
    """
    Текст не должен подставляться в договор как «новая редакция» пункта:
    короткие реплики, вопросы контрагенту, мета-диалог.
    """
    s = (blob or "").strip()
    if len(s) < 10:
        return True
    low = s.lower().replace("ё", "е")
    if re.search(r"\?\s*$", s) and len(s) <= 320:
        return True
    if re.search(r"\b(?:у\s+вас|какая\s+у\s+вас|а\s+у\s+вас)\b", low) and "?" in s:
        return True
    return False


def _resolve_accepted_formulation_text(
    formulation_text: str,
    explanation_text: str,
    combined: str,
    clause_data: dict,
    proximity: Optional[dict],
) -> Optional[str]:
    """
    Текст для подстановки в договор при agrees=True и не-исключении.

    П. 1.4.1 / 1.4.2: близость из _etalon_proximity → find_best_matching_ideal_option → эталон по ratio.
    Остальные пункты: очищенная формулировка игрока (cleaned), без подмены на канон кейса.
    """
    from services.chat_service import (
        _apply_accepted_replacement_normalization,
        _clause_uses_case_canonical_for_contract,
    )

    form = (formulation_text or "").strip()
    expl = (explanation_text or "").strip()
    comb = (combined or "").strip()

    merged = comb or f"{form} {expl}".strip()
    if player_proposes_remove_clause(merged):
        return None

    raw = form if len(form) >= 8 else ""
    if len(raw) < 8:
        raw = (pick_formulation_candidate_for_defective_screening(form, expl, comb, clause_data) or "").strip()
    if len(raw) < 8 and expl.strip():
        ex = expl.strip()
        if _text_looks_like_standalone_clause_wording(ex, clause_data):
            raw = ex
    if len(raw) < 8 and comb.strip():
        c0 = comb.strip()
        if not _blob_disallowed_as_clause_contract_substitute(c0):
            raw = c0
    if not raw or len(raw) < 8:
        return None
    if _blob_disallowed_as_clause_contract_substitute(raw):
        return None

    cleaned = re.sub(r"^\s*\d+\.\d+(?:\.\d+)?\.?\s*", "", raw, flags=re.IGNORECASE).strip() or raw
    cleaned = (strip_revision_meta_from_clause_draft(cleaned) or "").strip() or cleaned

    prox = proximity or {}
    replacement: Optional[str] = None
    if _clause_uses_case_canonical_for_contract(clause_data):
        if (prox.get("is_near") or prox.get("is_close")) and prox.get("best_match"):
            bm = str(prox["best_match"]).strip()
            if _best_match_ok_for_contract_substitution(bm, clause_data):
                replacement = bm

        if not replacement:
            fb = find_best_matching_ideal_option(cleaned, clause_data)
            fb = (fb or "").strip()
            if fb and fb != cleaned:
                replacement = fb
        if not replacement:
            seq_best = _normalize_to_nearest_etalon_if_very_close(
                cleaned, clause_data, max_distance=0.17
            )
            if seq_best:
                replacement = seq_best
    else:
        replacement = cleaned

                                                                                                                
                                                                                      
    if _clause_uses_case_canonical_for_contract(clause_data) and (replacement or "").strip():
        if not _best_match_ok_for_contract_substitution(str(replacement).strip(), clause_data):
            replacement = None

    if not (replacement or "").strip():
        return None

    out, _ = _apply_accepted_replacement_normalization(replacement.strip(), clause_data)
    return out


def acts_profile_clause_text_has_signing_deadlines(text: str) -> bool:
    """
    П. 4.1 (negotiation_profile=acts): в формулировке/тексте хода должны быть конкретные
    сроки или моменты подписания актов (дни, «не позднее N-го числа», «в течение N дней» и т.п.).
    Одних слов «ежемесячно» / «подписывают акт» без сроков недостаточно.
    """
    if not text or len(text.strip()) < 10:
        return False
    low = text.lower().replace("ё", "е")
    if re.search(r"\d+\s*(?:календарн\w*|рабоч\w*|дн[еёя]\w*)", low):
        return True
    if re.search(r"в\s+течение\s+\d+", low):
        return True
    if re.search(r"\d+\s*[-–—]?\s*го\s+числа", low):
        return True
    if re.search(r"не\s+позднее", low) and re.search(r"\d", low):
        return True
    return False


def _apply_post_llm_contract_outcome_fields(
    result: dict,
    clause_data: dict,
    formulation_text: str,
    explanation_text: str,
    combined: str,
    proximity: dict,
    is_exclusion_request: bool,
    allow_exclusion: bool,
    bot_messages: Optional[dict] = None,
    chat_history: Optional[list] = None,
) -> None:
    """Заполняет clause_excluded и accepted_formulation для chat_service / клиента."""
    for k, v in _v2_negotiation_contract_field_defaults().items():
        result.setdefault(k, v)

    agr = bool(result.get("agrees"))
    act = str(result.get("action") or "").strip().lower()
    if not agr or act != "accept":
        result["clause_excluded"] = False
        result["accepted_formulation"] = None
        return
    if (clause_data.get("negotiation_profile") or "").strip() == "acts":
        _acts_blob = f"{(formulation_text or '').strip()} {(explanation_text or '').strip()}".strip()
        if not _acts_blob:
            _acts_blob = (combined or "").strip()
        if not acts_profile_clause_text_has_signing_deadlines(_acts_blob):
            result["agrees"] = False
            result["action"] = "clarify"
            try:
                _sc_ad = float(result.get("score", 60))
            except (TypeError, ValueError):
                _sc_ad = 60.0
            result["score"] = min(_sc_ad, 58.0)
            bm = bot_messages if isinstance(bot_messages, dict) else {}
            _deadline_msgs = bm.get("request_act_signing_deadlines_4_1")
            if isinstance(_deadline_msgs, list) and _deadline_msgs:
                result["message"] = _pick_random(
                    [s for s in _deadline_msgs if isinstance(s, str) and s.strip()]
                ) or (
                    "В редакции не видно, в какие сроки стороны подписывают акты. "
                    "Уточните, пожалуйста, сроки или крайние даты подписания (например, для акта передачи и для актов по сопровождению)."
                )
            elif isinstance(_deadline_msgs, str) and _deadline_msgs.strip():
                result["message"] = _deadline_msgs.strip()
            else:
                result["message"] = (
                    "В редакции не видно, в какие сроки стороны подписывают акты. "
                    "Уточните, пожалуйста, сроки или крайние даты подписания (например, для акта передачи и для актов по сопровождению)."
                )
            result["_used_template"] = True
            result["reason"] = "acts_missing_signing_deadlines"
            result["clause_excluded"] = False
            result["accepted_formulation"] = None
            return
    if is_exclusion_request and allow_exclusion:
        if removal_explanation_qualifies_for_accept(
            (combined or "").strip(),
            clause_data,
            chat_history or [],
        ):
            result["clause_excluded"] = True
            result["accepted_formulation"] = None
        else:
            result["clause_excluded"] = False
            result["accepted_formulation"] = None
        return
    result["clause_excluded"] = False
    result["accepted_formulation"] = _resolve_accepted_formulation_text(
        formulation_text,
        explanation_text,
        combined,
        clause_data,
        proximity,
    )


_THINK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)

PROFANITY_MARKERS = [
    "блядь", "бля", "сука", "хуй", "хуё", "пизд", "ебать", "ёбан",
    "нахуй", "нахуя", "пошел нахуй", "пошёл нахуй", "иди нахуй",
    "мудак", "дебил", "урод", "тварь", "идиот", "fuck", "shit", "bitch",
]

                                                                                                         
_LIABILITY_CAP_EMOTIONAL_MARKERS = (
    "офигел",
    "офигели",
    "офигеть",
    "охренел",
    "охренели",
    "бесит",
    "беситесь",
    "возмутительн",
    "наглец",
    "наглые",
    "нахамил",
    "издевает",
)


def _pick_liability_cap_neutral_clarify(bot_messages: Optional[dict]) -> str:
    bm = bot_messages if isinstance(bot_messages, dict) else {}
    raw = bm.get("liability_cap_neutral_clarify")
    if isinstance(raw, list) and raw:
        return random.choice([s for s in raw if isinstance(s, str) and s.strip()]).strip()
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return (
        "Эмоции вряд ли помогут нам продвинуться в согласовании текста. Изложите, пожалуйста, "
        "по существу: в чём для Заказчика проблема с текущей редакцией этой нормы и какие доводы "
        "Вы готовы привести — без этого мы не сможем ответить предметно."
    )


def _player_turn_is_emotional_non_substantive_liability_cap(
    player_text: str,
    formulation_text: str,
    explanation_text: str,
) -> bool:
    """Короткая оценочная реплика без правовой позиции по п. 6.3."""
    ft = (formulation_text or "").strip()
    et = (explanation_text or "").strip()
    blob = (player_text or "").strip()
    if len(ft) >= 48 or len(et) >= 72:
        return False
    low = blob.lower().replace("ё", "е")
    if len(low) < 8 or len(low) > 220:
        return False
    if not any(m in low for m in _LIABILITY_CAP_EMOTIONAL_MARKERS):
        return False
    legal = (
        "ответственн",
        "лимит",
        "исключ",
        "убыт",
        "риск",
        "существен",
        "п. 6",
        "п.6",
        "пункт 6",
        "ограничен",
        "12 мес",
        "двенадцат",
        "неприемлем",
        "вин",
        "договор",
    )
    if any(x in low for x in legal):
        return False
    return True


def _liability_cap_offers_limit_negotiation_rhetoric(low: str) -> bool:
    """
    Контрагент предлагает торговать параметрами лимита (сумма/период/база) — для кейса п. 6.3 недопустимо
    (корректный исход игрока — исключение пункта). Не трогаем голые отказы без контрпредложения «поторговаться».
    """
    if not low.strip():
        return False
    liability_ctx = any(
        x in low
        for x in (
            "лимит",
            "предел",
            "ответственн",
            "убытк",
            "риск",
            "финансов",
            "нагрузк",
            "сумм",
            "месяц",
            "период",
            "платеж",
        )
    )
    if not liability_ctx:
        return False
    if any(
        x in low
        for x in (
            "компромисс",
            "компромис",
            "готовы рассмотреть",
            "рассмотрим вариант",
            "иную базу",
            "другую базу",
            "двукратн",
            "расширить период",
            "иной период",
            "другой период",
            "иной срок",
        )
    ):
        return True
    if "не расширя" in low and "период" in low:
        return True
    if "увелич" in low and "лимит" in low:
        if any(x in low for x in ("компромисс", "рассмотреть", "иную базу", "другую базу", "двукратн")):
            return True
    return False


def _liability_cap_bot_message_steers_toward_cap_tweak(message: str) -> bool:
    """
    Ответ намекает «измените лимит/предел» или предлагает торговать параметрами лимита — для кейса п. 6.3
    это ложная дорожка (эталон — исключение пункта). Не трогаем возражения вроде «увеличить лимит не готовы»
    без компромиссного контрпредложения.
    """
    low = (message or "").lower().replace("ё", "е")
    if _liability_cap_offers_limit_negotiation_rhetoric(low):
        return True
    if "предел ответственности" in low or "лимит ответственности" in low:
        if "не устраивает" in low or "не устраивают" in low:
            return True
        if "эмоци" in low:
            return True
        if any(
            p in low
            for p in (
                "предложите вашу редакцию",
                "предложите, пожалуйста, вашу редакцию",
                "пришлите вашу редакцию",
                "направьте вашу редакцию",
            )
        ):
            return True
    if ("не устраивает" in low or "не устраивают" in low) and "предел" in low:
        return True
    if ("не устраивает" in low or "не устраивают" in low) and "лимит" in low and "ответственн" in low:
        return True
    return False


def _scrub_liability_cap_counterparty_reply_leak(
    result: dict,
    clause_data: dict,
    bot_messages: Optional[dict],
) -> None:
    if (clause_data.get("negotiation_profile") or "").strip() != "liability_cap":
        return
    if result.get("agrees"):
        return
    msg = result.get("message")
    if not msg or not _liability_cap_bot_message_steers_toward_cap_tweak(str(msg)):
        return
    _neg_v2_info("[NegV2] liability_cap: scrub reply that steers player toward changing liability cap")
    result["message"] = _pick_liability_cap_neutral_clarify(bot_messages)
    result["_used_template"] = True
    result["reason"] = "liability_cap_no_cap_tweak_hint"

GIBBERISH_RE = re.compile(r"^[^а-яёa-z]{5,}$|^(.)\1{4,}$", re.IGNORECASE)

                                                                              
PRE_GATE_MIN_PLAYER_CHARS = 4

                                                                                                          
_CLOSING_NONFINAL_RE = re.compile(
    r"[?]|"
    r"\b(?:уточните|поясните|пришлите|напишите|скажите|сообщите|опишите|разъясните|ответьте|"
    r"направьте|предложите|подготовьте|укажите|допишите|вышлите|напомните|расскажите|распишите|"
    r"пожалуйста\s+пришлите|не\s+могли\s+бы|могли\s+бы\s+вы|готовы\s+ли|есть\s+ли\s+у\s+вас|"
    r"хотелось\s+бы|можете\s+пояснить|можете\s+уточнить)\b",
    re.IGNORECASE,
)

                                                                                        
                                                                                                   
_EXPL_MIN_LEN = 28
_EXPL_MEANINGFUL_MIN = 2                                    
_EXPL_STOPWORDS = frozenset(
    "что это для нас вас вам ваш как то тут там ещё еще уже или либо если когда "
    "есть быть был была были будет думаю просто очень весь всё все так же только "
    "лишь вот уж очень".split()
)
                                                                                  
_META_FISH_HEAD_TAIL: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("что тут", ("меня", "предлаг", "нужно", "надо", "сдела", "измен")),
    ("что здесь", ("меня", "предлаг", "нужно", "надо")),
    ("что вы предлагаете", ("меня", "измен", "правк", "сдела", "внести")),
    ("что ты предлагаешь", ("меня", "измен", "правк", "сдела")),
    ("что именно", ("меня", "измен", "правк")),
    ("какие изменения", ("предлаг", "внести", "нужн")),
    ("что нужно", ("меня", "измен", "правк")),
    ("что надо", ("меня", "измен", "правк")),
    ("а что ", ("меня", "предлаг", "тут", "здесь")),
)

_FISHING_QUESTION_RE = re.compile(
    r"(?:как\s+бы\s+вы|что\s+бы\s+вы|как\s+вы\s+(?:предлагаете|предложите|считаете\s+нужным))\s+"
    r"(?:изменил|переписал|исправил|улучшил|сформулировал|поправил|предложил)\w*|"
    r"как\s+(?:можно|нужно|стоит|лучше|следует|надо)\s+"
    r"(?:изменить|переписать|исправить|улучшить|сформулировать|поправить|переформулировать)|"
    r"(?:предложите|подскажите|посоветуйте|покажите|озвучьте|дайте)\s+"
    r"(?:свой\s+|ваш\s+)?(?:вариант|редакцию|формулировку|текст)|"
    r"(?:какой|какую)\s+(?:вариант|формулировку|редакцию|текст)\s+"
    r"(?:вы\s+)?(?:предлагаете|предложите|видите|хотите|считаете)|"
    r"(?:что|как)\s+(?:здесь|тут)\s+(?:нужно|надо|стоит|следует)\s+"
    r"(?:изменить|поменять|написать|указать|исправить|переписать)|"
    r"как\s+(?:должен|должна|должно)\s+(?:выглядеть|звучать|быть\s+сформулирован)|"
    r"какой\s+текст\s+(?:должен|правильн)|"
    r"(?:ваш[аеу]?\s+(?:предложени|вариант|позици))",
    re.IGNORECASE,
)

_EXPL_SUBSTANTIVE_PHRASES = (
    "риск", "причина", "потому что", "поскольку", "так как", "в связи с",
    "обоснован", "поясн", "зачем", "необходим", "важно", "иначе ",
    "дублир", "противореч", "существен", "убыт", "ответственн",
    "для нас", "у нас ", "у нашей", "не готов", "требует",
    "п. 1.", "п.1.", "п. 4", "п.4.", "пункт ", "ст. 782", "782",
    "исключить", "удалить", "акт о передаче", "сопровожден",
)


def _player_fishes_for_counterparty_solution(
    combined_text: str, formulation_text: str, explanation_text: str,
) -> bool:
    """
    Реплика — в основном вопрос «что вы предлагаете поменять / что тут менять» без черновика пункта.
    """
    blob = (combined_text or "").strip()
    if len(blob) < 12 or len(blob) > 260:
        return False
    low = blob.lower().replace("ё", "е")
    ft = (formulation_text or "").strip()
    et = (explanation_text or "").strip()
    if len(ft) >= 48:
        return False
    if len(et) >= 110:
        return False
    if player_proposes_remove_clause(blob):
        return False
    if any(
        x in low
        for x in (
            "предлагаем изложить",
            "предлагаю изложить",
            "предлагаем указать",
            "просим изложить",
            "новая редакция:",
        )
    ) and (len(ft) >= 18 or len(et) >= 22):
        return False
    for head, tails in _META_FISH_HEAD_TAIL:
        if head in low and any(t in low for t in tails):
            return True
    if _FISHING_QUESTION_RE.search(low):
        return True
    return False


def _bot_volunteers_counterparty_solution_on_fish(message: str, clause_data: Optional[dict]) -> bool:
    low = (message or "").strip().lower().replace("ё", "е")
    if len(low) < 30:
        return False
    cd = clause_data or {}
    if negotiation_clause_is_acts_profile(cd):
        if any(x in low for x in ("избыточ", "лишн", "согласен", "согласна", "согласны")):
            if any(
                x in low
                for x in (
                    "разовый акт",
                    "один акт",
                    "акт о передаче",
                    "акт передаче",
                    "передаче по",
                    "только акты",
                    "сопровожден",
                    "заменить их",
                )
            ):
                return True
    if any(p in low for p in ("считаю правильным", "правильнее было бы", "логичнее заменить")):
        if any(p in low for p in ("заменить", "вместо текущ", "оставив", "перейти к", "на разов")):
            return True
    if bot_message_volunteers_exclusion_or_revision_playbook(message):
        return True
    return False


def _meta_fishing_counterparty_reply(bot_messages: Optional[dict]) -> str:
    bm = bot_messages or {}
    raw = bm.get("meta_question_fishing")
    if isinstance(raw, list) and raw:
        choices = [x for x in raw if isinstance(x, str) and x.strip()]
        return random.choice(choices) if choices else str(raw[0])
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return (
        "Конкретную «правильную» редакцию по такому вопросу я не формулирую: это позиция Вашей стороны. "
        "Мы исходим из текста пункта в договоре как из нашей модели. Пришлите, пожалуйста, "
        "Ваш вариант формулировки и краткое обоснование — обсудим его по существу."
    )


                                                                             
                
                                                                             

def _system_prompt_candidate_paths(case_code: str) -> List[Path]:
    return [
        DATA_DIR / "cases" / case_code / "stage-3" / "ai_negotiation_system_prompt.md",
        DATA_DIR / "cases" / "case-001" / "stage-3" / "ai_negotiation_system_prompt.md",
    ]


def _resolve_system_prompt_path(case_code: str) -> Optional[Path]:
    for path in _system_prompt_candidate_paths(case_code):
        if path.is_file():
            return path
    return None


@lru_cache(maxsize=4)
def _load_system_prompt(case_code: str) -> str:
    _ = case_code
    return MINIMAL_SYSTEM_MESSAGE


def _get_system_prompt(case_code: str) -> str:
    _ = case_code
    return MINIMAL_SYSTEM_MESSAGE


                                                                             
                      
                                                                             

def _build_related_clauses_context(clause_data: dict) -> List[dict[str, str]]:
    """Выдержки связанных пунктов договора для user-message (из gameData)."""
    raw = clause_data.get("related_contract_snippets") or clause_data.get("related_clauses_for_llm")
    if not raw or not isinstance(raw, list):
        return []
    lines: List[dict[str, str]] = []
    for item in raw:
        if isinstance(item, dict):
            num = (item.get("number") or item.get("id") or "").strip()
            txt = (item.get("text") or "").strip()
            if num and txt:
                lines.append({"number": num, "text": txt})
            elif txt:
                lines.append({"number": "", "text": txt})
        elif isinstance(item, str) and item.strip():
            lines.append({"number": "", "text": item.strip()})
    return lines


def _build_user_message(
    clause_data: dict,
    player_message: str,
    formulation_text: str,
    explanation_text: str,
    chat_history: list,
    turn_number: int,
    counterpart_persona: str,
    dialogue_summary: Optional[str] = None,
    *,
    etalon_proximity: Optional[dict] = None,
    related_clauses_context: Optional[List[dict[str, str]]] = None,
    ai_lessons: Optional[List[str]] = None,
    compact_user_message: bool = True,
) -> str:
    _ = compact_user_message
    clause_number = clause_data.get("number", "?")
    clause_title = clause_data.get("title", "")
    contract_text = clause_data.get("contract_text", "")
    guide_summary = clause_data.get("guide_summary", "")
    counterpart_position = clause_data.get("counterpart_position", "")
    acceptance_criteria = clause_data.get("acceptance_criteria", "")
    hints = clause_data.get("negotiation_hints", [])
    etalon_phrases = clause_data.get("etalon_phrases", [])
    ideal_options = clause_data.get("ideal_options", [])
    correct_examples = clause_data.get("correct_examples", [])
    incorrect_examples = clause_data.get("incorrect_examples", [])
    few_shot = clause_data.get("few_shot_dialogues", [])
    rules = clause_data.get("rules", {})

    history_lines: List[dict[str, Any]] = []
    if chat_history:
        recent = chat_history[-8:]
        for msg in recent:
            owner = str(msg.get("owner", "player"))
            text = (msg.get("text") or "")[:400]
            history_lines.append({"owner": owner, "text": text})

    fs_trim: List[dict[str, Any]] = []
    for fs in few_shot[:3]:
        if isinstance(fs, dict):
            fs_trim.append({"player": fs.get("player", ""), "bot": fs.get("bot", "")})

    payload: dict[str, Any] = {
        "kind": "negotiation_v2_turn",
        "phase": "single_llm_call",
        "output_format": {
            "type": "json",
            "include_player_accepts_counterparty_revision": True,
        },
        "clause": {
            "number": clause_number,
            "title": clause_title,
            "contract_text": contract_text,
            "guide_summary": guide_summary,
            "counterpart_position": counterpart_position or guide_summary,
            "acceptance_criteria": acceptance_criteria,
            "negotiation_hints": list(hints) if isinstance(hints, list) else [],
            "etalon_phrases": list(etalon_phrases) + list(ideal_options),
            "correct_examples": list(correct_examples),
            "incorrect_examples": list(incorrect_examples),
            "negotiation_profile": (clause_data.get("negotiation_profile") or "").strip() or None,
            "rules": dict(rules) if isinstance(rules, dict) else {},
        },
        "dialogue_summary": (dialogue_summary or "").strip() or None,
        "etalon_proximity": etalon_proximity,
        "related_clauses_context": related_clauses_context or [],
        "ai_lessons": list(ai_lessons[:12]) if ai_lessons else [],
        "history_lines": history_lines,
        "turn_number": turn_number,
        "player": {
            "formulation_text": (formulation_text or "").strip() or None,
            "explanation_text": (explanation_text or "").strip() or None,
            "full_message": player_message,
        },
        "counterpart_persona": counterpart_persona,
        "few_shot_dialogues": fs_trim,
    }
    return compact_user_payload(payload)


                                                                             
               
                                                                             

def pre_llm_gate(
    player_text: str,
    formulation_text: str = "",
    explanation_text: str = "",
    bot_messages: Optional[dict] = None,
    clause_data: Optional[dict] = None,
) -> tuple[bool, Optional[dict]]:
    """
    Quick checks before calling LLM.
    Returns (should_skip_llm, override_result_or_None).
    """
    text_lower = (player_text or "").lower().strip()

    if not text_lower or len(text_lower) < PRE_GATE_MIN_PLAYER_CHARS:
        return True, {
            "agrees": False,
            "score": 10,
            "action": "clarify",
            "message": "Уточните, пожалуйста, что Вы имеете в виду.",
            "reason": "empty_message",
            "has_formulation": False,
            "has_explanation": False,
            **_v2_negotiation_contract_field_defaults(),
        }

    for marker in PROFANITY_MARKERS:
        if marker in text_lower:
            return True, {
                "agrees": False,
                "score": 0,
                "action": "reject_close",
                "message": "Это недопустимо, переговоры завершены.",
                "reason": "profanity",
                "has_formulation": False,
                "has_explanation": False,
                **_v2_negotiation_contract_field_defaults(),
            }

    if GIBBERISH_RE.match(text_lower):
        return True, {
            "agrees": False,
            "score": 5,
            "action": "clarify",
            "message": "Уточните, что Вы имеете в виду.",
            "reason": "gibberish",
            "has_formulation": False,
            "has_explanation": False,
            **_v2_negotiation_contract_field_defaults(),
        }

    if _player_fishes_for_counterparty_solution(
        (player_text or "").strip(),
        formulation_text or "",
        explanation_text or "",
    ):
        return True, {
            "agrees": False,
            "score": 38,
            "action": "objection",
            "message": _meta_fishing_counterparty_reply(bot_messages),
            "reason": "meta_question_fishing",
            "has_formulation": False,
            "has_explanation": False,
            **_v2_negotiation_contract_field_defaults(),
        }

    _cd = clause_data or {}
    if (
        (_cd.get("negotiation_profile") or "").strip() == "liability_cap"
        and _player_turn_is_emotional_non_substantive_liability_cap(
            player_text, formulation_text or "", explanation_text or ""
        )
    ):
        return True, {
            "agrees": False,
            "score": 42,
            "action": "clarify",
            "message": _pick_liability_cap_neutral_clarify(bot_messages),
            "reason": "liability_cap_emotional_non_substantive",
            "has_formulation": False,
            "has_explanation": False,
            **_v2_negotiation_contract_field_defaults(),
        }

    return False, None


                                                                             
          
                                                                             

def _extract_json(text: str) -> Optional[dict]:
    """Extract JSON from LLM response, handling think tags and markdown."""
    text = _THINK_RE.sub("", text).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass
    m = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    return None


def _llm_json_inconsistent(p: dict, clause_data: dict) -> bool:
    """Противоречия в полях JSON до post_llm_rules (например agrees при низком score)."""
    rules = clause_data.get("rules") or {}
    expl_only = bool(rules.get("explanation_only_sufficient"))
    agrees = bool(p.get("agrees"))
    try:
        score = float(p.get("score", 0))
    except (TypeError, ValueError):
        score = 0.0
    action = (str(p.get("action") or "")).strip().lower()
    hf = bool(p.get("has_formulation"))
    he = bool(p.get("has_explanation"))
    if agrees and score < 60:
        return True
    if action == "accept" and not hf:
        if expl_only and he:
            return False
        return True
    return False


def _fix_llm_json_inconsistency(parsed: dict, clause_data: dict) -> None:
    """Согласовать противоречивые поля JSON без повторного вызова LLM."""
    rules = clause_data.get("rules") or {}
    expl_only = bool(rules.get("explanation_only_sufficient"))
    action = (str(parsed.get("action") or "")).strip().lower()
    hf = bool(parsed.get("has_formulation"))
    he = bool(parsed.get("has_explanation"))
    if action == "accept" and not hf and not (expl_only and he):
        parsed["agrees"] = False
        parsed["action"] = "clarify"
    try:
        score = float(parsed.get("score", 0))
    except (TypeError, ValueError):
        score = 0.0
    if bool(parsed.get("agrees")) and score < 60:
        parsed["score"] = max(score, 65)


def evaluate_player_message(
    clause_data: dict,
    player_message: str,
    formulation_text: str,
    explanation_text: str,
    chat_history: list,
    turn_number: int,
    counterpart_persona: str,
    case_code: str = "case-001",
    dialogue_summary: Optional[str] = None,
    bot_messages: Optional[dict] = None,
    ai_lessons: Optional[List[str]] = None,
) -> dict:
    _ = (
        player_message,
        chat_history,
        turn_number,
        counterpart_persona,
        case_code,
        dialogue_summary,
        bot_messages,
        ai_lessons,
    )
    return _fallback_result(clause_data, formulation_text, explanation_text)


                                                                             
                              
                                                                             

def _compute_etalon_proximity(
    text: str,
    clause_data: dict,
    *,
    formulation_text: str = "",
    explanation_text: str = "",
) -> dict:
    """
    Measure how close player's text is to etalon formulations.

    Returns:
        {
            "distance": float 0.0-1.0  (0 = exact match, 1 = no match),
            "best_match": str | None,
            "is_near": bool,            (distance <= 0.35)
            "is_close": bool,           (distance <= 0.55)
            "is_far": bool,             (distance > 0.55)
            "method": "exact" | "substring" | "word_overlap" | "sequence" | "semantic" | "none",
        }
    """
    _NO_MATCH = {"distance": 1.0, "best_match": None, "is_near": False, "is_close": False, "is_far": True, "method": "none"}
    _profile = (clause_data.get("negotiation_profile") or "").strip()

    if not text or len(text.strip()) < 3:
        return _NO_MATCH

                                                                      
                                                                          
                                                                            
                                                                       
    _strict_patterns = clause_data.get("accepted_formulations_strict")
    if isinstance(_strict_patterns, list) and _strict_patterns:
        if not strict_whitelist_accepts_player_turn(
            clause_data,
            formulation_text=formulation_text,
            explanation_text=explanation_text,
            anchor_text=(text or "").strip(),
        ):
            _neg_v2_info(
                "[NegV2] Whitelist gate REJECT: text does not match any "
                "accepted_formulations_strict pattern for %s",
                clause_data.get("id", "?"),
            )
            return _NO_MATCH

                                                                     
    if _profile == "territory":
        from services.ai_counterpart_rules import (
            _territory_formulation_aligns_with_ideal_options,
            _territory_raw_contains_disallowed_country_marker,
        )
        raw_merged = f"{(formulation_text or '').strip()} {(explanation_text or '').strip()} {(text or '').strip()}"
        raw_merged = re.sub(r"\s+", " ", raw_merged.strip())
        if _territory_raw_contains_disallowed_country_marker(raw_merged, clause_data):
            return _NO_MATCH
                                                                                                                
        raw_align = (text or "").strip()
        if not _territory_formulation_aligns_with_ideal_options(raw_align, clause_data):
            return _NO_MATCH

    candidate = text.strip().lower()

    etalons: list[str] = []
    if _profile == "territory":
        for key in ("ideal_options", "correct_examples"):
            vals = clause_data.get(key) or []
            if isinstance(vals, list):
                for item in vals:
                    s = (item.get("text", item) if isinstance(item, dict) else str(item)).strip()
                    if s:
                        etalons.append(s)
        io = clause_data.get("ideal_option")
        if isinstance(io, str) and io.strip():
            etalons.append(io.strip())
        ce = clause_data.get("correct_example")
        if isinstance(ce, str) and ce.strip():
            etalons.append(ce.strip())
    else:
        for key in ("etalon_phrases", "ideal_options", "correct_examples"):
            vals = clause_data.get(key) or []
            if isinstance(vals, list):
                for item in vals:
                    s = (item.get("text", item) if isinstance(item, dict) else str(item)).strip()
                    if s:
                        etalons.append(s)
        io = clause_data.get("ideal_option")
        if isinstance(io, str) and io.strip():
            etalons.append(io.strip())

    if not etalons:
        return {"distance": 1.0, "best_match": None, "is_near": False, "is_close": False, "is_far": True, "method": "none"}

    best_dist = 1.0
    best_match = None
    best_method = "none"

    for et in etalons:
        et_lower = et.lower().strip()
        if not et_lower:
            continue

        if candidate == et_lower or candidate.replace(".", "").strip() == et_lower.replace(".", "").strip():
            return {"distance": 0.0, "best_match": et, "is_near": True, "is_close": True, "is_far": False, "method": "exact"}

        if et_lower in candidate or candidate in et_lower:
            _len_diff = abs(len(candidate) - len(et_lower))
            if _len_diff <= 15:
                d = 0.1
            else:
                d = min(0.3 + _len_diff / 200, 0.85)
            if d < best_dist:
                best_dist = d
                best_match = et
                best_method = "substring"
            continue

        cand_words = {w for w in re.split(r"[\s,.\-;:]+", candidate) if len(w) >= 3}
        et_words = {w for w in re.split(r"[\s,.\-;:]+", et_lower) if len(w) >= 3}
        if cand_words and et_words:
            overlap = len(cand_words & et_words)
            union = len(cand_words | et_words)
            if union > 0:
                jaccard = overlap / union
                d = 1.0 - jaccard
                if d < best_dist:
                    best_dist = d
                    best_match = et
                    best_method = "word_overlap"

        ratio = difflib.SequenceMatcher(None, candidate, et_lower).ratio()
        d = 1.0 - ratio
        if d < best_dist:
            best_dist = d
            best_match = et
            best_method = "sequence"

    best_dist = round(best_dist, 3)

                                                             
                                                                                       
    if _profile != "territory" and best_dist > 0.55:
        try:
            from services import similarity_service

            if similarity_service.is_enabled():
                sem_near, sem_score, sem_match = similarity_service.is_semantically_near_expected(
                    text.strip(),
                    clause_data,
                    threshold=0.75,
                )
                if sem_near and sem_match is not None:
                    sem_dist = round(1.0 - float(sem_score), 3)
                    if sem_dist < best_dist:
                        best_dist = sem_dist
                        best_match = sem_match
                        best_method = "semantic"
                        _neg_v2_info(
                            "[NegV2] Etalon proximity: semantic rescue dist=%s score=%.3f",
                            best_dist,
                            sem_score,
                        )
        except Exception as exc:
            logger.debug("[NegV2] Semantic etalon proximity skipped: %s", exc)

    return {
        "distance": best_dist,
        "best_match": best_match,
        "is_near": best_dist <= 0.35,
        "is_close": best_dist <= 0.55,
        "is_far": best_dist > 0.55,
        "method": best_method,
    }


def _compute_explanation_reference_proximity(text: str, clause_data: dict) -> dict:
    """
    Близость пояснения игрока к эталонным пояснениям кейса — по той же идее, что _compute_etalon_proximity для редакции.

    Корпус: ``collect_explanation_reference_corpus`` (``explanation_reference_texts`` или fallback в few_shot).
    Лексика: exact / substring / пересечение слов / SequenceMatcher; затем при плохой лексике — max cosine
    по корпусу через ``explanation_reference_score_0_100`` (как «semantic rescue» у формулировки).
    """
    _no = {
        "distance": 1.0,
        "best_match": None,
        "is_near": False,
        "is_close": False,
        "is_far": True,
        "method": "none",
    }
    raw = (text or "").strip()
    if not raw or len(raw) < 5:
        return dict(_no)
    if str((clause_data or {}).get("id") or "").strip() == "1.4.2_term":
        try:
            from services import similarity_service as _sim142

            if _sim142.term_142_explanation_is_exclusive_rights_lexicon_only(raw):
                return {
                    "distance": 0.92,
                    "best_match": None,
                    "is_near": False,
                    "is_close": False,
                    "is_far": True,
                    "method": "142_exclusive_lexicon_only",
                }
        except Exception:                
            pass
    try:
        from services import similarity_service as sim

        refs = sim.collect_explanation_reference_corpus(clause_data)
    except Exception:                
        refs = []
    if not refs:
        return dict(_no)

    candidate = raw.lower().replace("ё", "е")
    best_dist = 1.0
    best_match: str | None = None
    best_method = "none"

    for et in refs:
        et_lower = (et or "").strip().lower().replace("ё", "е")
        if not et_lower:
            continue

        if candidate == et_lower or candidate.replace(".", "").strip() == et_lower.replace(".", "").strip():
            return {
                "distance": 0.0,
                "best_match": et,
                "is_near": True,
                "is_close": True,
                "is_far": False,
                "method": "exact",
            }

        if et_lower in candidate or candidate in et_lower:
            _len_diff = abs(len(candidate) - len(et_lower))
            d = 0.1 if _len_diff <= 15 else min(0.3 + _len_diff / 200, 0.85)
            if d < best_dist:
                best_dist = d
                best_match = et
                best_method = "substring"
            continue

        cand_words = {w for w in re.split(r"[\s,.\-;:]+", candidate) if len(w) >= 3}
        et_words = {w for w in re.split(r"[\s,.\-;:]+", et_lower) if len(w) >= 3}
        if cand_words and et_words:
            union = len(cand_words | et_words)
            if union > 0:
                jaccard = len(cand_words & et_words) / union
                d = 1.0 - jaccard
                if d < best_dist:
                    best_dist = d
                    best_match = et
                    best_method = "word_overlap"

        ratio = difflib.SequenceMatcher(None, candidate, et_lower).ratio()
        d = 1.0 - ratio
        if d < best_dist:
            best_dist = d
            best_match = et
            best_method = "sequence"

    best_dist = round(best_dist, 3)

    if best_dist > 0.55:
        try:
            from services import similarity_service as sim2

            if sim2.is_enabled():
                sc = sim2.explanation_reference_score_0_100(raw, clause_data)
                if sc is not None:
                    sem_dist = round(1.0 - float(sc) / 100.0, 3)
                    if sem_dist < best_dist:
                        best_dist = sem_dist
                        best_match = None
                        best_method = "semantic"
                        _neg_v2_info(
                            "[NegV2] Explanation ref proximity: semantic rescue dist=%.3f score_0_100=%.1f",
                            best_dist,
                            float(sc),
                        )
        except Exception as exc:                
            logger.debug("[NegV2] Explanation ref semantic rescue skipped: %s", exc)

    return {
        "distance": best_dist,
        "best_match": best_match,
        "is_near": best_dist <= 0.35,
        "is_close": best_dist <= 0.55,
        "is_far": best_dist > 0.55,
        "method": best_method,
    }


def _clause_explanation_reference_corpus_nonempty(clause_data: dict | None) -> bool:
    try:
        from services import similarity_service as sim

        return bool(sim.collect_explanation_reference_corpus(clause_data or {}))
    except Exception:                
        return False


def _explicit_explanation_reference_texts_in_rules(clause_data: dict | None) -> bool:
    """В rules заданы эталонные пояснения (не только few_shot fallback в корпусе)."""
    rules = (clause_data or {}).get("rules") or {}
    ert = rules.get("explanation_reference_texts")
    return isinstance(ert, list) and any(isinstance(x, str) and x.strip() for x in ert)


def explanation_acceptance_reference_corpus_gate_enabled(clause_data: dict | None) -> bool:
    """
    Для post_llm: вместо expl_has_markers (подстроки required_explanation_markers) использовать
    is_real_explanation + близость к корпусу explanation_reference (не is_far).

    Включается, если в кейсе есть непустой корпус и:
    - rules.explanation_acceptance_reference_corpus_only is True, или
    - не False и в rules заданы explanation_reference_texts (авто).

    Явный False отключает (остаётся логика по маркерам NegV2).
    """
    rules = (clause_data or {}).get("rules") or {}
    if rules.get("explanation_acceptance_reference_corpus_only") is False:
        return False
    if not _clause_explanation_reference_corpus_nonempty(clause_data):
        return False
    if rules.get("explanation_acceptance_reference_corpus_only") is True:
        return True
    return _explicit_explanation_reference_texts_in_rules(clause_data)


def _explanation_passes_reference_corpus_gate(
    expl_blob: str,
    clause_data: dict,
    expl_ref_proximity: dict,
) -> bool:
    """Пояснение близко к эталонным пояснениям кейса; подстроковые маркеры не используются."""
    raw = (expl_blob or "").strip()
    if len(raw) < 8:
        return False
    if not is_real_explanation(raw, clause_data):
        return False
    er = expl_ref_proximity or {}
    if str(er.get("method") or "") == "none":
        return False
    if bool(er.get("is_far")):
        return False
    return True


def _explanation_accept_ok_for_post_llm(
    expl_semantic_blob: str,
    clause_data: dict,
    expl_ref_proximity: dict,
    expl_has_markers_legacy: bool,
    reference_gate: bool,
) -> bool:
    if reference_gate:
        return _explanation_passes_reference_corpus_gate(
            expl_semantic_blob, clause_data, expl_ref_proximity
        )
    return bool(expl_has_markers_legacy)


def _explanation_has_substantive_cue(lower: str) -> bool:
    return any(p in lower for p in _EXPL_SUBSTANTIVE_PHRASES)


def _explanation_meaningful_word_count(lower: str) -> int:
    """Слова ≥4 символов, без стоп-слов — грубый признак содержательности."""
    words = re.findall(r"[а-яёa-z0-9]{4,}", lower, flags=re.IGNORECASE)
    n = 0
    for w in words:
        wl = w.lower()
        if wl not in _EXPL_STOPWORDS:
            n += 1
    return n


def _has_explanation_markers(text: str, clause_data: dict) -> bool:
    """Check if explanation text has required content markers for this clause."""
    if not text or len(text.strip()) < 5:
        return False
    stripped = text.strip()
    lower = stripped.lower()
    rules = clause_data.get("rules", {})
    markers = rules.get("required_explanation_markers", [])
    meaningful = _explanation_meaningful_word_count(lower)
    substantive = _explanation_has_substantive_cue(lower)

                                                                                             
    if len(lower) < 52 and re.search(
        r"потому\s+что\s+(?:это\s+)?(?:важно|нужно|так\s+надо)\b|(?:важно|нужно)\s+для\s+нас\b|просто\s+так\b",
        lower,
    ):
        if not re.search(
            r"риск|срок|пункт|п\.|акт |лиценз|исключительн|дублир|противореч|договор|обоснован|ответственн|заказчик|исполнител|782|ст\.\s*\d|неопредел",
            lower,
        ):
            return False

    if markers:
        if not rules_has_explanation_markers(stripped, clause_data):
            return False
        return (
            len(lower) >= _EXPL_MIN_LEN
            or substantive
            or meaningful >= _EXPL_MEANINGFUL_MIN
        )
    return (
        (len(lower) >= _EXPL_MIN_LEN and meaningful >= _EXPL_MEANINGFUL_MIN)
        or substantive
        or (len(lower) >= 40 and meaningful >= _EXPL_MEANINGFUL_MIN)
    )


def _closing_reply_needs_definitive_template(text: str) -> bool:
    s = (text or "").strip()
    if not s:
        return True
    return bool(_CLOSING_NONFINAL_RE.search(s))


def _pick_impasse_close_line_v2(bot_messages: dict) -> Optional[str]:
    for key in ("close_counterpart_wins", "move_to_next_clause"):
        raw = bot_messages.get(key)
        if isinstance(raw, list) and raw:
            return random.choice(raw)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def _pick_agreement_close_line_v2(bot_messages: dict) -> Optional[str]:
    ex = bot_messages.get("examples_agreement")
    if isinstance(ex, list) and ex:
        return random.choice(ex)
    aw = bot_messages.get("acceptance_when_agreed")
    if isinstance(aw, str) and aw.strip():
        return aw.strip()
    return None


def _apply_definitive_closing_message_to_result(result: dict, bot_messages: dict) -> None:
    """Последняя реплика при закрытии переговоров: без просьб и вопросов; иначе шаблон из gameData."""
    act = str(result.get("action") or "").strip().lower()
    if not (result.get("agrees") or act == "reject_close"):
        return
    msg = result.get("message") or ""
    if not _closing_reply_needs_definitive_template(msg):
        return
    bm = bot_messages or {}
    if result.get("agrees"):
        picked = _pick_agreement_close_line_v2(bm) or "Согласуем пункт в обсуждаемой редакции."
    else:
        picked = _pick_impasse_close_line_v2(bm) or "По этому пункту оставляем текущую редакцию договора."
    if _closing_reply_needs_definitive_template(picked):
        picked = (
            "Согласуем пункт в обсуждаемой редакции."
            if result.get("agrees")
            else "По этому пункту оставляем текущую редакцию договора."
        )
    result["message"] = picked


def _prior_player_substantive_explanation_for_post_llm(
    chat_history: list | None,
    clause_data: dict,
    *,
    skip_last_player_message: bool = True,
    use_reference_corpus_gate: bool = False,
) -> str:
    """
    Пояснение из предыдущих реплик игрока (без текущего хода).

    Учитываются все предшествующие ходы игрока по пункту (между ними могут быть реплики бота).
    Если обоснование уже проходило проверку маркеров (или эталонного корпуса пояснений при gate),
    не требовать его снова в Rule 0b / 2 и при близкой к эталону редакции можно закрыть переговоры (Rule 0a).
    """
    msgs = [m for m in (chat_history or []) if m.get("owner") == "player"]
    if skip_last_player_message:
        if len(msgs) < 2:
            return ""
        seq = msgs[:-1]
    else:
        seq = msgs
    for m in reversed(seq):
        t = (m.get("text") or m.get("message") or "").strip()
        if len(t) < 8:
            continue
        if use_reference_corpus_gate:
            _er = _compute_explanation_reference_proximity(t, clause_data)
            if _explanation_passes_reference_corpus_gate(t, clause_data, _er):
                return t
        if _has_explanation_markers(t, clause_data):
            return t
    return ""


_INCORRECT_EXAMPLE_STRIP_PREFIXES = (
    "на срок ", "предлагаем ", "предлагаю ", "просим ", "прошу ",
    "закреплять в договоре ", "оставить ",
)
_INCORRECT_EXAMPLE_STRIP_SUFFIXES = (
    " г.", " г", " года",
)


def _normalize_for_incorrect_example_match(s: str) -> str:
    t = (s or "").strip().lower().replace("ё", "е")
    t = re.sub(r"[\u00AB\u201C\u201E«]", "", t)
    t = re.sub(r"[\u00BB\u201D\u201C»]", "", t)
    t = re.sub(r"(^|[\s\u00a0])c(?=\s*\d)", r"\1с", t)
    t = re.sub(r"[.;,!?]+$", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _normalize_for_incorrect_example_fuzzy(s: str) -> str:
    """Aggressive normalization: strip common contractual prefixes/suffixes for fuzzy matching."""
    t = _normalize_for_incorrect_example_match(s)
    for pfx in _INCORRECT_EXAMPLE_STRIP_PREFIXES:
        if t.startswith(pfx):
            t = t[len(pfx):].strip()
    for sfx in _INCORRECT_EXAMPLE_STRIP_SUFFIXES:
        if t.endswith(sfx):
            t = t[:-len(sfx)].strip()
    t = re.sub(r"[.;,!?]+$", "", t).strip()
    return t


def _player_draft_matches_clause_incorrect_examples(
    formulation: str,
    explanation: str,
    combined: str,
    incorrect_examples: list,
) -> bool:
    """
    Совпадение с incorrect_examples из gameData: такой черновик не должен проходить agrees
    (в т.ч. когда explanation_only_sufficient ослабляет Rule 0c).
    Исключения по тексту «удалить/исключить» не смотрим здесь — вызывающий передаёт только not exclusion.
    """
    form_n = _normalize_for_incorrect_example_match(formulation)
    comb_n = _normalize_for_incorrect_example_match(combined)
    expl_n = _normalize_for_incorrect_example_match(explanation)
    form_fuzzy = _normalize_for_incorrect_example_fuzzy(formulation)
    comb_fuzzy = _normalize_for_incorrect_example_fuzzy(combined)
    long_blobs: list[str] = []
    if len(form_n) >= 4:
        long_blobs.append(form_n)
    if len(comb_n) >= 20:
        long_blobs.append(comb_n)
    if not long_blobs and len(expl_n) >= 20:
        long_blobs.append(expl_n)
    fuzzy_blobs: list[str] = []
    if len(form_fuzzy) >= 4:
        fuzzy_blobs.append(form_fuzzy)
    if len(comb_fuzzy) >= 14:
        fuzzy_blobs.append(comb_fuzzy)
    for raw in incorrect_examples:
        bad = (raw if isinstance(raw, str) else str(raw)).strip()
        if len(bad) < 3:
            continue
        bn = _normalize_for_incorrect_example_match(bad)
        bn_fuzzy = _normalize_for_incorrect_example_fuzzy(bad)
        if len(bn) < 3 and len(bn_fuzzy) < 3:
            continue
        if len(bn) >= 14:
            for blob in long_blobs:
                if blob == bn or bn in blob:
                    return True
                if len(blob) >= 14 and blob in bn:
                                                                                                    
                                                                                                             
                    if len(bn) > len(blob) + 12:
                        ratio = len(blob) / max(len(bn), 1)
                        if ratio < 0.55:
                            continue
                    return True
        if len(bn_fuzzy) >= 10:
            for blob in fuzzy_blobs:
                if blob == bn_fuzzy or bn_fuzzy in blob:
                    return True
                if len(blob) >= 10 and blob in bn_fuzzy:
                    if len(bn_fuzzy) > len(blob) + 12:
                        ratio = len(blob) / max(len(bn_fuzzy), 1)
                        if ratio < 0.55:
                            continue
                    return True
        if len(bn) < 14:
            if form_n and (form_n == bn or form_n.startswith(bn + " ") or form_n.startswith(bn + ".") or form_n.startswith(bn + ",")):
                return True
    return False


def player_draft_triggers_incorrect_examples_block(
    clause_data: dict,
    formulation_text: str,
    explanation_text: str,
    chat_history: list | None,
    player_message: str = "",
    *,
    _is_exclusion_request: bool | None = None,
) -> bool:
    """
    Любой пункт с ``incorrect_examples`` в gameData: черновик игрока совпал с negated example
    и ход не является запросом на исключение пункта.

    Используется в ``post_llm_rules`` и в ``chat_service`` (мосты «согласие по тексту бота», Step 5):
    одна семантика для всех пунктов; при вызове из ``post_llm_rules`` передайте
    ``_is_exclusion_request``, чтобы не вызывать определение исключения дважды.
    """
    form = (formulation_text or "").strip()
    expl = (explanation_text or "").strip()
    combined_fields = (form + " " + expl).strip()
    combined = combined_fields if combined_fields else (player_message or "").strip()
    is_ex = _is_exclusion_request
    if is_ex is None:
        is_ex = player_text_indicates_clause_exclusion_intent(
            combined,
            clause_data,
            chat_history or [],
            formulation_text=formulation_text,
            explanation_text=explanation_text,
        )
    if is_ex:
        return False
    ie_list = clause_data.get("incorrect_examples")
    if not isinstance(ie_list, list) or not ie_list:
        return False
    return _player_draft_matches_clause_incorrect_examples(form, expl, combined, ie_list)


                                                                             
                     
                                                                             

def post_llm_rules(
    result: dict,
    clause_data: dict,
    formulation_text: str,
    explanation_text: str,
    turn_number: int,
    chat_history: list,
    bot_messages: dict,
    player_message: str = "",
) -> dict:
    """
    Hard rules that override LLM decision when violated.

    Logic:
    - Compute etalon proximity for the player's formulation
    - If proximity is_near AND explanation passes accept gate => force agrees=True, use template
      (при explanation_acceptance_reference_corpus_only / авто по explanation_reference_texts —
      «проход» по is_real_explanation + корпусу эталонных пояснений, без подстроковых маркеров NegV2).
    - If proximity is_close AND LLM agrees AND explanation present => keep LLM decision
    - If proximity is_far => never agree even if LLM said yes
    - Standard rules: no form+expl, exclusion, first turn
    (Проверка п. 9.2 без срока уведомления и п. 4.1 без сроков подписания актов — дублируется в chat_service после post_llm_rules.)

    В результате при необходимости заполняются поля для договора:
    - ``clause_excluded``: True — удалить пункт (исключение согласовано);
    - ``accepted_formulation``: текст новой редакции для подстановки (или None).
    """
    result["_v2_post_llm_path"] = True
    result["_incorrect_example_block"] = False

    rules = clause_data.get("rules", {})
    allow_exclusion = rules.get("allow_clause_exclusion", False)
    expl_only = rules.get("explanation_only_sufficient", False)
    _expl_ref_gate = explanation_acceptance_reference_corpus_gate_enabled(clause_data)

    form = (formulation_text or "").strip()
    expl = (explanation_text or "").strip()
                                                                                                      
                                                                                                    
                                                                                                                         
    combined = (form + " " + expl).strip() or (player_message or "").strip()
    iso_expl = explanation_text_isolated_for_scoring(form, expl, combined, clause_data)
    fish_blob = ((player_message or "").strip() or combined).strip()
    has_form = bool(form and len(form) >= 5)
    expl_prior = _prior_player_substantive_explanation_for_post_llm(
        chat_history,
        clause_data,
        skip_last_player_message=True,
        use_reference_corpus_gate=_expl_ref_gate,
    )
    expl_for_markers = " ".join(x for x in (expl, expl_prior) if (x or "").strip()).strip()
    expl_semantic_blob = (expl_for_markers or (iso_expl or "").strip()).strip()
    has_expl = bool(expl and len(expl) >= 5) or bool(expl_prior) or (
        bool((iso_expl or "").strip())
        and is_real_explanation((iso_expl or "").strip(), clause_data)
    )

    is_exclusion_request = player_text_indicates_clause_exclusion_intent(
        combined,
        clause_data,
        chat_history,
        formulation_text=formulation_text,
        explanation_text=explanation_text,
    )

    _incorrect_example_block = player_draft_triggers_incorrect_examples_block(
        clause_data,
        formulation_text,
        explanation_text,
        chat_history,
        player_message=player_message,
        _is_exclusion_request=is_exclusion_request,
    )
    if _incorrect_example_block:
        _neg_v2_info(
            "[NegV2] incorrect_examples: черновик совпал с negated example (clause=%s)",
            clause_data.get("id", "?"),
        )
    result["_incorrect_example_block"] = bool(_incorrect_example_block)

    anchor_for_rules = (form or combined).strip()
    pre_prox = result.get("_pre_etalon_proximity")
    pre_anchor = (result.get("_pre_etalon_anchor") or "").strip()
    if pre_prox is not None and pre_anchor == anchor_for_rules:
        proximity = pre_prox
        _neg_v2_info("[NegV2] Etalon proximity: reusing cached from evaluate (anchor match)")
    else:
        proximity = _compute_etalon_proximity(
            anchor_for_rules,
            clause_data,
            formulation_text=formulation_text,
            explanation_text=explanation_text,
        )
    result["_etalon_proximity"] = proximity
    result.pop("_pre_etalon_proximity", None)
    result.pop("_pre_etalon_anchor", None)

                                                                                                              
    _profile_term = (clause_data.get("negotiation_profile") or "").strip() == "termination_notice"
    _has_notice_in_turn = termination_notice_draft_has_notice_period(
        formulation_text, explanation_text, combined, player_message
    )

    _neg_v2_info(
        "[NegV2] Etalon proximity: distance=%.3f near=%s close=%s method=%s match='%s'",
        proximity["distance"], proximity["is_near"], proximity["is_close"],
        proximity["method"], (proximity["best_match"] or "")[:60],
    )

    try:
        from services import similarity_service as _sim_ex

        _expl_score_blob = expl_semantic_blob or ""
        if _expl_score_blob and _sim_ex.is_enabled():
            _ers = _sim_ex.explanation_reference_score_0_100(_expl_score_blob, clause_data)
            if _ers is not None:
                result["explanation_reference_similarity_0_100"] = _ers
                _neg_v2_info("[NegV2] Explanation vs reference corpus: similarity_0_100=%.1f", _ers)
    except Exception:                
        pass

                                                                                                          
    _expl_prox_for_ref = expl_semantic_blob
    expl_ref_proximity = _compute_explanation_reference_proximity(_expl_prox_for_ref, clause_data)
    result["_explanation_reference_proximity"] = expl_ref_proximity
    _neg_v2_info(
        "[NegV2] Explanation ref proximity: distance=%.3f near=%s close=%s far=%s method=%s",
        expl_ref_proximity["distance"],
        expl_ref_proximity["is_near"],
        expl_ref_proximity["is_close"],
        expl_ref_proximity["is_far"],
        expl_ref_proximity["method"],
    )

    expl_has_markers = _has_explanation_markers(expl_semantic_blob, clause_data)
    expl_accept_ok = _explanation_accept_ok_for_post_llm(
        expl_semantic_blob,
        clause_data,
        expl_ref_proximity,
        expl_has_markers,
        _expl_ref_gate,
    )
    if (
        _profile_term
        and _has_notice_in_turn
        and (expl or "").strip()
        and not expl_accept_ok
        and thin_termination_explanation_acceptable((expl or "").strip(), clause_data)
    ):
        expl_accept_ok = True
        expl_has_markers = True
        _neg_v2_info(
            "[NegV2] termination_notice: expl_accept_ok — срок в «Новой редакции», пояснение без N дней допустимо"
        )
    if _expl_ref_gate:
        _neg_v2_info(
            "[NegV2] Explanation accept gate: reference_corpus (markers bypass for post_llm) "
            "markers=%s ref_ok=%s",
            expl_has_markers,
            expl_accept_ok,
        )

                                                                                                               
    if _player_fishes_for_counterparty_solution(fish_blob, form, expl):
        if result.get("agrees") or _bot_volunteers_counterparty_solution_on_fish(
            result.get("message"), clause_data
        ):
            _neg_v2_info("[NegV2] Rule meta-fish: no coaching without player draft")
            result["agrees"] = False
            result["action"] = "objection"
            try:
                sc = float(result.get("score", 50))
            except (TypeError, ValueError):
                sc = 50.0
            result["score"] = min(sc, 47.0)
            result["message"] = _meta_fishing_counterparty_reply(bot_messages)
            result["_used_template"] = True

                                                                         
                                                      
                                                                          
                                                                     
                                            
                                                                         
    if not result.get("_used_template"):
        _coaching_q = player_asks_for_coaching_or_hint(
            fish_blob, form, expl,
        )
        if _coaching_q and (
            bot_response_coaches_ideal_solution(result.get("message"), clause_data)
            or bot_message_volunteers_exclusion_or_revision_playbook(result.get("message"))
            or bot_message_leaks_related_contract_snippet(
                result.get("message"), clause_data, fish_blob
            )
        ):
            _neg_v2_info(
                "[NegV2] Rule anti-coaching: player asks hint, bot leaks ideal — replacing"
            )
            result["agrees"] = False
            result["action"] = "clarify"
            try:
                _sc_ac = float(result.get("score", 50))
            except (TypeError, ValueError):
                _sc_ac = 50.0
            result["score"] = min(_sc_ac, 48.0)
            result["message"] = pick_no_coaching_reply(bot_messages)
            result["_used_template"] = True
            result["reason"] = "anti_coaching"

                                                                         
                                                                            
                                                                      
                                                                 
                                                                         
    if not result.get("_used_template") and not result.get("agrees"):
        if bot_reply_coaches_via_rhetorical_question(result.get("message"), clause_data):
            _neg_v2_info(
                "[NegV2] Rule anti-coaching-rhetorical: bot coaches via rhetorical question — replacing"
            )
            result["message"] = pick_generic_no_cheatsheet_objection_message(bot_messages)
            result["_used_template"] = True

                                                                                                       
    if not result.get("_used_template") and not result.get("agrees"):
        if bot_message_leaks_related_contract_snippet(
            result.get("message"), clause_data, fish_blob
        ):
            _neg_v2_info(
                "[NegV2] Rule anti-leak-related-snippet: bot echoed related-clause excerpt — replacing"
            )
            result["action"] = "clarify"
            try:
                _sc_leak = float(result.get("score", 50))
            except (TypeError, ValueError):
                _sc_leak = 50.0
            result["score"] = min(_sc_leak, 48.0)
            result["message"] = pick_no_coaching_reply(bot_messages)
            result["_used_template"] = True
            result["reason"] = "anti_leak_related_snippet"

                                                                         
                                                                        
                                                                          
                                             
                                                                                      
                                                                                          
                                                                         
    _rule0_blocked = bool(rules.get("require_explicit_formulation_for_accept")) and not has_form

                                                                              
                                                                               
    _r0_strict = clause_data.get("accepted_formulations_strict")
    if isinstance(_r0_strict, list) and _r0_strict and not _rule0_blocked:
        if not strict_whitelist_accepts_player_turn(
            clause_data,
            formulation_text=formulation_text,
            explanation_text=explanation_text,
            anchor_text=fish_blob or combined,
        ):
            _rule0_blocked = True
            _neg_v2_info(
                "[NegV2] Rule 0 blocked: formulation fails whitelist for %s",
                clause_data.get("id", "?"),
            )

                                                                                                                    
    _rule0_profile = (clause_data.get("negotiation_profile") or "").strip()
    if _rule0_profile == "territory" and not _rule0_blocked:
        from services.ai_counterpart_rules import _territory_raw_contains_disallowed_country_marker
        _r0_text = f"{form} {expl} {combined}".strip()
        if _territory_raw_contains_disallowed_country_marker(_r0_text, clause_data):
            _rule0_blocked = True
            _neg_v2_info("[NegV2] Rule 0 blocked: territory text contains disallowed country")
                                                                                                          
    _fe0 = (form or "").strip()
    _ee0 = (expl or "").strip()
    _r0_expl_semantic_ok = True
    if _fe0 and _ee0:
        if not is_real_explanation(_ee0, clause_data):
            if (
                _profile_term
                and _has_notice_in_turn
                and thin_termination_explanation_acceptable(_ee0, clause_data)
            ):
                _r0_expl_semantic_ok = True
                _neg_v2_info(
                    "[NegV2] Rule 0: termination_notice — краткое пояснение ok при сроке в редакции"
                )
            else:
                _r0_expl_semantic_ok = False
                _neg_v2_info("[NegV2] Rule 0 skip: explanation field fails is_real_explanation (no combined rescue)")
    elif expl_semantic_blob:
        if not is_real_explanation(expl_semantic_blob, clause_data):
            _r0_expl_semantic_ok = False
            _neg_v2_info("[NegV2] Rule 0 skip: merged explanation blob fails is_real_explanation")
                                                                                                 
                                                                                                          
    _rule0_etalon_open = bool(proximity.get("is_near")) or (
        _profile_term
        and _has_notice_in_turn
        and (bool(proximity.get("is_close")) or bool(proximity.get("is_near")))
    )
    if (
        _rule0_etalon_open
        and has_form
        and has_expl
        and expl_accept_ok
        and _r0_expl_semantic_ok
        and not is_exclusion_request
        and not _rule0_blocked
        and not _incorrect_example_block
    ):
        if not result["agrees"]:
            _neg_v2_info(
                "[NegV2] Rule 0: near/close(termination+notice) + explanation + accept_gate => FORCE agrees=True (template)"
            )
        result["agrees"] = True
        result["action"] = "accept"
        result["score"] = max(result["score"], 85)
        accept_msg = rules.get("acceptance_message")
        if not accept_msg:
            accept_msgs = bot_messages.get("examples_agreement", [])
            accept_msg = _pick_random(accept_msgs) if accept_msgs else None
        if accept_msg:
            result["message"] = accept_msg
            result["_used_template"] = True
        apply_final_strict_formulation_whitelist(
            result,
            clause_data,
            formulation_text,
            explanation_text,
            is_exclusion_request=is_exclusion_request,
            allow_exclusion=allow_exclusion,
        )
        _apply_post_llm_contract_outcome_fields(
            result,
            clause_data,
            formulation_text,
            explanation_text,
            combined,
            result.get("_etalon_proximity") or proximity,
            is_exclusion_request,
            allow_exclusion,
            bot_messages,
            chat_history,
        )
        _scrub_liability_cap_counterparty_reply_leak(result, clause_data, bot_messages)
        _apply_definitive_closing_message_to_result(result, bot_messages)
        return result

                                                                                                  
                                                                                                   
                                                                        
    _r0a_expl_semantic_ok = True
    _blob0a = expl_semantic_blob
    if _blob0a and not is_real_explanation(_blob0a, clause_data):
        _r0a_expl_semantic_ok = False
        _neg_v2_info("[NegV2] Rule 0a skip: explanation+prior fails is_real_explanation")
    if (
        bool(expl_prior)
        and proximity["is_close"]
        and not proximity["is_near"]
        and has_form
        and has_expl
        and expl_accept_ok
        and _r0a_expl_semantic_ok
        and (not _profile_term or _has_notice_in_turn)
        and not is_exclusion_request
        and not _rule0_blocked
        and not _incorrect_example_block
    ):
        if not result.get("agrees") or str(result.get("action") or "").strip().lower() == "clarify":
            _neg_v2_info(
                "[NegV2] Rule 0a: prior explanation + close formulation => FORCE agrees=True (template)"
            )
        result["agrees"] = True
        result["action"] = "accept"
        try:
            _sc0a = float(result.get("score") or 0)
        except (TypeError, ValueError):
            _sc0a = 0.0
        result["score"] = max(_sc0a, 85.0)
        accept_msg = rules.get("acceptance_message")
        if not accept_msg:
            accept_msgs = bot_messages.get("examples_agreement", [])
            accept_msg = _pick_random(accept_msgs) if accept_msgs else None
        if accept_msg:
            result["message"] = accept_msg
            result["_used_template"] = True
        apply_final_strict_formulation_whitelist(
            result,
            clause_data,
            formulation_text,
            explanation_text,
            is_exclusion_request=is_exclusion_request,
            allow_exclusion=allow_exclusion,
        )
        _apply_post_llm_contract_outcome_fields(
            result,
            clause_data,
            formulation_text,
            explanation_text,
            combined,
            result.get("_etalon_proximity") or proximity,
            is_exclusion_request,
            allow_exclusion,
            bot_messages,
            chat_history,
        )
        _scrub_liability_cap_counterparty_reply_leak(result, clause_data, bot_messages)
        _apply_definitive_closing_message_to_result(result, bot_messages)
        return result

                                                                                                        
                                                                                                                            
    if (
        _profile_term
        and has_form
        and has_expl
        and expl_accept_ok
        and not is_exclusion_request
        and not _has_notice_in_turn
        and not _incorrect_example_block
    ):
        _neg_v2_info(
            "[NegV2] Rule 0t: termination_notice, explanation ok, no notice days in form/expl => "
            "clarify with request_notice_period_9_2 (not generic 'only formulation' template)"
        )
        result["agrees"] = False
        result["action"] = "clarify"
        try:
            _s0t = float(result.get("score", 55))
        except (TypeError, ValueError):
            _s0t = 55.0
        result["score"] = min(max(_s0t, 52), 62)
        n9 = bot_messages.get("request_notice_period_9_2")
        if isinstance(n9, list) and n9:
            result["message"] = _pick_random(n9)
        elif isinstance(n9, str) and n9.strip():
            result["message"] = n9.strip()
        else:
            result["message"] = (
                "В черновике нет конкретного срока уведомления в календарных днях — "
                "укажите, за сколько дней Заказчик уведомляет Исполнителя о прекращении сопровождения."
            )
        result["reason"] = "termination_notice_missing_days_in_draft"
        result["_used_template"] = True
        _apply_post_llm_contract_outcome_fields(
            result,
            clause_data,
            formulation_text,
            explanation_text,
            combined,
            result.get("_etalon_proximity") or proximity,
            is_exclusion_request,
            allow_exclusion,
            bot_messages,
            chat_history,
        )
        _scrub_liability_cap_counterparty_reply_leak(result, clause_data, bot_messages)
        _apply_definitive_closing_message_to_result(result, bot_messages)
        return result

                                                                                      
    if proximity["is_near"] and has_form and not has_expl and not expl_only:
        _neg_v2_info("[NegV2] Rule 0b: near-etalon, no explanation => clarify")
        result["agrees"] = False
        result["action"] = "clarify"
        result["score"] = min(max(result["score"], 55), 65)
        result["message"] = _pick_random(bot_messages.get("request_explanation_only", [
            "Редакция понятна. Поясните, пожалуйста, почему Вы предлагаете именно такую формулировку.",
        ]))
        result["_used_template"] = True
        _apply_post_llm_contract_outcome_fields(
            result,
            clause_data,
            formulation_text,
            explanation_text,
            combined,
            proximity,
            is_exclusion_request,
            allow_exclusion,
            bot_messages,
            chat_history,
        )
        _scrub_liability_cap_counterparty_reply_leak(result, clause_data, bot_messages)
        return result

                                                                         
                                                                
                                                                          
                                                              
                                                                         
    if result["agrees"] and proximity["is_far"] and not is_exclusion_request:
        if _incorrect_example_block or not (expl_only and has_expl and expl_accept_ok):
            _neg_v2_info(
                "[NegV2] Rule 0c: agrees but far from etalon => agrees=False "
                f"(incorrect_example_block={_incorrect_example_block})"
            )
            result["agrees"] = False
            result["action"] = "objection"
            result["score"] = min(result["score"], 50)

                                                                                                             
    _erpx = result.get("_explanation_reference_proximity") or {}
    _terr_expl_skip_far = (
        (str((clause_data.get("negotiation_profile") or "")).strip() == "territory")
        and (expl_accept_ok or expl_has_markers)
        and territory_clear_geography_staff_explanation_ok(
            (expl_semantic_blob or "").lower().replace("ё", "е"),
            clause_data,
        )
    )
    if (
        result.get("agrees")
        and not is_exclusion_request
        and not expl_only
        and has_form
        and has_expl
        and (_expl_prox_for_ref or "").strip()
        and str(_erpx.get("method") or "") != "none"
        and bool(_erpx.get("is_far"))
        and not bool(proximity.get("is_far"))
        and not _terr_expl_skip_far
    ):
        _neg_v2_info(
            "[NegV2] Rule 0c-explain: agrees but explanation far from reference corpus => agrees=False"
        )
        result["agrees"] = False
        result["action"] = "objection"
        try:
            _sc0ce = float(result.get("score", 50))
        except (TypeError, ValueError):
            _sc0ce = 50.0
        result["score"] = min(_sc0ce, 50.0)

                                                                         
                                                             
                                                                         

                                                             
    if result["agrees"] and not has_form and not has_expl and not is_exclusion_request:
        _neg_v2_info("[NegV2] Rule 1: no form+expl => agrees=False")
        result["agrees"] = False
        result["action"] = "clarify"
        result["score"] = min(result["score"], 30)
        if not result["message"] or len(result["message"]) < 5:
            result["message"] = _pick_random(bot_messages.get("clarify_vague_change", [
                "Уточните, пожалуйста, что Вы предлагаете.",
            ]))
            result["_used_template"] = True

                                                                              
    if result["agrees"] and has_form and not has_expl and not expl_only and not is_exclusion_request:
        _neg_v2_info("[NegV2] Rule 2: form without explanation => agrees=False")
        result["agrees"] = False
        result["action"] = "clarify"
        result["score"] = min(result["score"], 60)
        if not result["message"] or len(result["message"]) < 5:
            result["message"] = _pick_random(bot_messages.get("request_explanation_only", [
                "Редакция понятна. Поясните, пожалуйста, почему Вы предлагаете именно такую формулировку.",
            ]))
            result["_used_template"] = True

                                                                                                      
                                                                                                   
    _rule2b_fail = (
        (not expl_has_markers and not is_real_explanation(expl_semantic_blob, clause_data))
        if not _expl_ref_gate
        else (not expl_accept_ok)
    )
    if (
        result["agrees"]
        and has_form
        and (expl and len(expl.strip()) >= 5)
        and not expl_only
        and not is_exclusion_request
        and _rule2b_fail
    ):
        _neg_v2_info("[NegV2] Rule 2b: explanation text present but not substantive => agrees=False")
        result["agrees"] = False
        result["action"] = "clarify"
        result["score"] = min(float(result.get("score") or 60), 58.0)
        if not result.get("_used_template"):
            result["message"] = _pick_random(
                bot_messages.get(
                    "request_explanation_only",
                    [
                        "Редакция понятна. Поясните, пожалуйста, почему Вы предлагаете именно такую формулировку.",
                    ],
                )
            )
            result["_used_template"] = True

                                                              
                                                                                                    
    if (
        is_exclusion_request
        and allow_exclusion
        and (has_expl or has_form)
        and (expl_accept_ok or expl_has_markers)
        and not _incorrect_example_block
        and removal_explanation_qualifies_for_accept(combined, clause_data, chat_history)
    ):
        if not result["agrees"]:
            _neg_v2_info("[NegV2] Rule 3a: exclusion allowed + justified => FORCE agrees=True")
        result["agrees"] = True
        result["action"] = "accept"
        result["score"] = max(result["score"], 80)
        accept_msg = bot_messages.get("accept_removal", "Принимаем Вашу позицию. Исключаем пункт из договора.")
        if isinstance(accept_msg, list):
            accept_msg = _pick_random(accept_msg)
        result["message"] = accept_msg
        result["_used_template"] = True
        _apply_post_llm_contract_outcome_fields(
            result,
            clause_data,
            formulation_text,
            explanation_text,
            combined,
            proximity,
            is_exclusion_request,
            allow_exclusion,
            bot_messages,
            chat_history,
        )
        _scrub_liability_cap_counterparty_reply_leak(result, clause_data, bot_messages)
        _apply_definitive_closing_message_to_result(result, bot_messages)
        return result

                                                       
    if result["agrees"] and is_exclusion_request and not allow_exclusion:
        _neg_v2_info("[NegV2] Rule 3b: exclusion not allowed => agrees=False")
        result["agrees"] = False
        result["action"] = "objection"
        result["score"] = min(result["score"], 40)
        reject_msg = bot_messages.get("reject_clause_removal", "Исключить этот пункт мы не готовы.")
        if isinstance(reject_msg, list):
            reject_msg = _pick_random(reject_msg)
        result["message"] = reject_msg
        result["_used_template"] = True

                                                                                          
    if turn_number <= 1 and result["agrees"]:
        if is_exclusion_request and allow_exclusion and (has_expl or has_form):
            pass
        elif not (has_form and has_expl) and not (expl_only and has_expl):
            _neg_v2_info("[NegV2] Rule 5: first turn without full position => agrees=False")
            result["agrees"] = False
            result["action"] = "clarify"
            result["score"] = min(result["score"], 55)

                                                                                                 
    if (
        rules.get("require_explicit_formulation_for_accept")
        and result["agrees"]
        and not has_form
        and not expl_only
        and not is_exclusion_request
    ):
        _neg_v2_info("[NegV2] Rule 5a: require_explicit_formulation_for_accept, formulation empty => agrees=False")
        result["agrees"] = False
        result["action"] = "clarify"
        result["score"] = min(result["score"], 58)
        result["message"] = _pick_random(
            bot_messages.get(
                "request_full_clause_draft",
                [
                    "Направление понятно. Пришлите, пожалуйста, полный текст пункта в новой редакции — "
                    "как он должен звучать в договоре, одной или двумя фразами.",
                ],
            )
        )
        result["_used_template"] = True

    if result.get("agrees") and not is_exclusion_request and _incorrect_example_block:
        _neg_v2_info("[NegV2] Rule incorrect_examples: согласие снято — черновик из negated examples caseData")
        result["agrees"] = False
        result["action"] = "objection"
        try:
            _sc_ie = float(result.get("score") or 50)
        except (TypeError, ValueError):
            _sc_ie = 50.0
        result["score"] = min(_sc_ie, 48.0)
        if not result.get("_used_template"):
            result["message"] = pick_generic_no_cheatsheet_objection_message(bot_messages)
            result["_used_template"] = True

    apply_final_strict_formulation_whitelist(
        result,
        clause_data,
        formulation_text,
        explanation_text,
        is_exclusion_request=is_exclusion_request,
        allow_exclusion=allow_exclusion,
    )

    _apply_post_llm_contract_outcome_fields(
        result,
        clause_data,
        formulation_text,
        explanation_text,
        combined,
        proximity,
        is_exclusion_request,
        allow_exclusion,
        bot_messages,
        chat_history,
    )

    if (
        result.get("agrees")
        and not result.get("clause_excluded")
        and is_exclusion_request
        and allow_exclusion
        and bot_message_accepts_clause_exclusion(result.get("message"), bot_messages)
    ):
        _neg_v2_info(
            "[NegV2] exclusion-accept wording but no substantive removal justification => clarify"
        )
        result["agrees"] = False
        result["action"] = "clarify"
        try:
            _sc_exb = float(result.get("score") or 50)
        except (TypeError, ValueError):
            _sc_exb = 50.0
        result["score"] = min(_sc_exb, 55.0)
        result["message"] = _pick_random(
            bot_messages.get(
                "request_explanation_only",
                [
                    "Чтобы рассмотреть исключение пункта, опишите правовую или договорную позицию: "
                    "во что упирается требование, ссылку на другой пункт, риск или противоречие.",
                ],
            )
        )
        result["_used_template"] = True

    _neg_v2_info(
        "[NegV2] Post-rules: agrees=%s score=%.0f action=%s template=%s incorrect_block=%s",
        result["agrees"], result["score"], result["action"],
        result.get("_used_template", False),
        _incorrect_example_block,
    )

    _scrub_liability_cap_counterparty_reply_leak(result, clause_data, bot_messages)
    _apply_definitive_closing_message_to_result(result, bot_messages)
    return result


                                                                             
                      
                                                                             

def _bot_reply_near_duplicate(message: str, last_bot_messages: Optional[list]) -> bool:
    if not last_bot_messages or not (message or "").strip():
        return False
    cur = message.strip().lower()
    for prev in last_bot_messages[-2:]:
        prev_text = (prev.get("text") or "").strip().lower()
        if prev_text and len(prev_text) > 20:
            if cur == prev_text or (
                len(cur) > 30 and difflib.SequenceMatcher(None, cur, prev_text).ratio() > 0.85
            ):
                return True
    return False


def _pick_non_duplicate_bot_template(
    bot_messages: Optional[dict],
    prev_bot_lower: str,
    *,
    llm_action: str,
    llm_agrees: bool,
) -> Optional[str]:
    """Иной шаблон из банка gameData, чтобы не повторять предыдущую реплику бота."""
    if not bot_messages or not prev_bot_lower or len(prev_bot_lower) < 15:
        return None
    import random

    keys: List[str]
    if llm_agrees:
        keys = ["examples_agreement"]
    elif (llm_action or "").strip().lower() == "objection":
        keys = ["examples_objection", "examples_request_explanation", "clarify_vague_change"]
    else:
        keys = [
            "examples_request_explanation",
            "clarify_vague_change",
            "examples_objection",
            "alternative_request_formulation",
        ]
    candidates: List[str] = []
    for k in keys:
        raw = bot_messages.get(k)
        if isinstance(raw, str) and raw.strip():
            candidates.append(raw.strip())
        elif isinstance(raw, list):
            for x in raw:
                if isinstance(x, str) and x.strip():
                    candidates.append(x.strip())
    random.shuffle(candidates)
    for c in candidates:
        cl = c.lower()
        if cl == prev_bot_lower:
            continue
        if len(cl) > 25 and difflib.SequenceMatcher(None, cl, prev_bot_lower).ratio() > 0.82:
            continue
        return c
    return None


_HOMEWORK_CLAUSE_HINT_STRIP_RES: tuple[re.Pattern[str], ...] = (
                                                         
    re.compile(
        r"\s*(?:—\s*|,\s*)?(?:Посмотрите|Обратите внимание|Ознакомьтесь|Сверьтесь|Сравните|Загляните|Прочитайте)\s+"
        r"(?:на\s+)?(?:пункт|подпункт|стать(?:ю|ёй)?)\s*[\d.]+[^.!?]*[.!?]",
        re.IGNORECASE,
    ),
    re.compile(
        r"\s*(?:—\s*|,\s*)?(?:Посмотрите|Обратите внимание|Ознакомьтесь|Сверьтесь|Сравните|Загляните|Прочитайте)\s+"
        r"(?:на\s+)?п\.?\s*[\d]+(?:\.[\d]+)*[^.!?]*[.!?]",
        re.IGNORECASE,
    ),
    re.compile(
        r"\s*(?:—\s*)?Нет\s+ли\s+там\s+противоречия[^.!?]*[.!?]",
        re.IGNORECASE,
    ),
    re.compile(
        r"\s*(?:—\s*)?Не\s+противоречит\s+ли\s+это\b[^.!?]*[.!?]",
        re.IGNORECASE,
    ),
    re.compile(
        r"\s*(?:—\s*)?(?:Имеет\s+смысл|Стоит)\s+сверить(?:ся)?\b[^.!?]*[.!?]",
        re.IGNORECASE,
    ),
)


def _strip_homework_clause_hints(text: str) -> str:
    """
    Убирает из реплики контрагента наводящие отсылки «посмотрите на п. …» —
    это не позиция оппонента, а подсказка наставника.
    """
    if not text or len(text.strip()) < 12:
        return text
    had_ref = bool(
        re.search(
            r"(?:посмотрите|обратите внимание|ознакомьтесь|сверьтесь|сравните|загляните|прочитайте)\b",
            text,
            re.IGNORECASE,
        )
        and re.search(r"(?:п\.?\s*[\d]+(?:\.[\d]+)*|пункт\s*[\d.]+)", text, re.IGNORECASE)
    ) or bool(re.search(r"нет\s+ли\s+там\s+противоречия", text, re.IGNORECASE))
    s = text.strip()
    for _ in range(4):
        prev = s
        for pat in _HOMEWORK_CLAUSE_HINT_STRIP_RES:
            s = pat.sub(" ", s)
        s = re.sub(r"\s+", " ", s).strip()
        s = re.sub(r"\s+[—–]\s*$", "", s).strip()
        if s == prev:
            break
    if had_ref and len(s) < 25:
        return (
            "Пока не видим достаточных оснований для изменения позиции по этому пункту; "
            "поясните, пожалуйста, аргументацию подробнее."
        )
    return s if s else text


                                                                                                   
_COUNTERPART_SHORT_TAIL_WORDS_OK = frozenset(
    {
        "срок",
        "сроки",
        "дней",
        "дня",
        "день",
        "год",
        "года",
        "лет",
        "лицо",
        "лица",
        "лиц",
        "право",
        "права",
        "вас",
        "нас",
        "вам",
        "нам",
        "им",
        "них",
        "этот",
        "эта",
        "эти",
        "это",
        "суть",
        "ход",
        "часть",
        "если",
        "либо",
        "того",
        "тему",
        "тема",
        "какой",
        "какая",
        "какие",
        "какое",
        "кому",
        "чего",
        "куда",
        "суток",
        "часа",
        "минут",
    }
)


def _repair_incomplete_counterparty_message_tail(message: str) -> str:
    """Убирает явный обрубок последнего слова или добавляет … если фраза не завершена."""
    t = (message or "").rstrip()
    if not t or t[-1] in ".!?…":
        return t
                                                                                                            
    if len(t) >= 12:
        m = re.search(r"(\s+)([а-яё]{3,5})$", t, re.IGNORECASE)
        if m:
            w = m.group(2).lower().replace("ё", "е")
            if w.isalpha() and w not in _COUNTERPART_SHORT_TAIL_WORDS_OK:
                cut = t[: m.start(1)].rstrip(" ,;:")
                if cut:
                    t = cut
    if t[-1] not in ".!?…":
        return t + "…"
    return t


def _sanitize_max_sentences(
    message_before_truncate: str,
    action: str,
    agrees: bool,
    clause_data: dict,
) -> int:
    """
    Сколько предложений оставить после очистки утечек.

    До 3 предложений — «сложные» ответы контрагента без согласия:
    - objection: правовое/терминологическое возражение, сравнение понятий, риски;
    - clarify: развёрнутое уточнение по существу пункта (не короткий шаблон);
    - пункт с профилем срока уведомления (9.2): часто нужно два хода мысли + вывод.

    Иначе 2 — краткость для accept, reject_close, короткого clarify.
    """
    if agrees:
        return 2
    act = (action or "clarify").strip().lower()
    if act in ("accept", "reject_close"):
        return 2
    if (clause_data.get("negotiation_profile") or "").strip() == "termination_notice":
        return 3
    if act == "objection":
        return 3
    if act == "clarify":
        s = message_before_truncate.strip()
        if len(s) >= 100:
            return 3
        return 2
    return 2


def _sanitize_message(
    message: str,
    clause_data: dict,
    last_bot_messages: Optional[list] = None,
    bot_messages: Optional[dict] = None,
    *,
    llm_action: str = "clarify",
    llm_agrees: bool = False,
) -> str:
    """
    Clean up LLM message:
    1. Remove reasoning/JSON field leaks
    2. Remove etalon leaks (long etalon phrases in text)
    3. Remove hint leaks (imperatives like «попробуйте», «уберите»)
    3b. Strip наводящие отсылки к номерам пунктов («посмотрите на п. …»)
    4. Remove duplicate of previous bot message
    5. Truncate to max 2–3 sentences (см. _sanitize_max_sentences)
    """
    if not message:
        return message

    message = _THINK_RE.sub("", message).strip()
    message = strip_negotiation_bot_vocative_from_reply(message, bot_messages)

                                                         
    _json_field_re = re.compile(
        r"\b(?:agrees|score|action|reason|has_formulation|has_explanation)\s*[:=]\s*[^\s,;.!?]*",
        re.IGNORECASE,
    )
    message = _json_field_re.sub("", message).strip()
    message = re.sub(r"\*\*score\b.*?\*\*", "", message, flags=re.IGNORECASE).strip()
    message = re.sub(r'"message"\s*:', "", message, flags=re.IGNORECASE).strip()
    message = re.sub(r"```json[\s\S]*?```", "", message).strip()
    message = re.sub(r"[{}]", "", message).strip()
    message = re.sub(r"^[\s,;:.]+", "", message).strip()

                     
    etalons = clause_data.get("etalon_phrases", []) + clause_data.get("ideal_options", [])
    msg_lower = message.lower()
    leaked = False
    for et in etalons:
        if len(et) > 12 and et.lower() in msg_lower:
            leaked = True
            break
    if leaked:
        _hint_patterns = [
            r"(?:нужна|нужно|попробуйте|предложите|уберите|добавьте|укажите)\s+(?:редакци|формулировк|в\s+духе)",
            r"в\s+духе\s*[:«\"']",
            r"(?:правильн|эталонн|допустим)\w*\s+(?:редакци|формулировк|вариант)",
        ]
        for pat in _hint_patterns:
            message = re.sub(pat + r"[^.!?]*[.!?]?", "", message, flags=re.IGNORECASE).strip()
        for et in etalons:
            if len(et) > 12:
                message = re.sub(re.escape(et), "", message, flags=re.IGNORECASE).strip()

                                                           
    _hint_imperative_re = re.compile(
        r"(?:попробуйте|уберите|устраните|лучше уберите|предложите вариант,?\s*который|"
        r"добавьте в\s+текст|укажите в\s+(?:формулировке|редакции))[^.!?]*[.!?]?",
        re.IGNORECASE,
    )
    message = _hint_imperative_re.sub("", message).strip()

    _prof = (clause_data.get("negotiation_profile") or "").strip()
    if _prof == "territory" and bot_message_leaks_territory_ideal_enumeration(message):
        message = pick_territory_question_no_enumeration_reply(bot_messages)
    elif bot_message_leaks_clause_ideal_enumeration(message, clause_data):
        message = pick_generic_no_cheatsheet_objection_message(bot_messages)

    message = _strip_homework_clause_hints(message)

                                                                                           
    if bot_reply_coaches_via_rhetorical_question(message, clause_data):
        message = pick_generic_no_cheatsheet_objection_message(bot_messages)

                                                          
    if last_bot_messages:
        for prev in last_bot_messages[-2:]:
            prev_text = (prev.get("text") or "").strip().lower()
            if prev_text and len(prev_text) > 20:
                cur_lower = message.lower().strip()
                if cur_lower == prev_text or (
                    len(cur_lower) > 30
                    and difflib.SequenceMatcher(None, cur_lower, prev_text).ratio() > 0.85
                ):
                    alt = _pick_non_duplicate_bot_template(
                        bot_messages, prev_text, llm_action=llm_action, llm_agrees=llm_agrees
                    )
                    if alt:
                        message = alt
                    else:
                        message = message + " Давайте продвинемся по этому вопросу."
                    break

                                                                    
    max_sents = _sanitize_max_sentences(message, llm_action, llm_agrees, clause_data)
    sentences = re.split(r'(?<=[.!?])\s+', message)
    if len(sentences) > max_sents:
        message = " ".join(sentences[:max_sents])
        if not message.endswith((".", "!", "?")):
            message += "."

                   
    message = re.sub(r"\s{2,}", " ", message).strip()
    message = re.sub(r"^[\s,;:.]+", "", message).strip()
    if message and message[0] == '"' and message[-1] == '"':
        message = message[1:-1].strip()

    message = _repair_incomplete_counterparty_message_tail(message)

    if not message or len(message) < 3:
        message = "Уточните, пожалуйста, Вашу позицию по этому пункту."

    return message


                                                                             
         
                                                                             

def _has_notice_period(text: str) -> bool:
    return bool(re.search(r"\d+\s*(календарн|рабоч|дн[еёя]й)", text.lower()))


def has_notice_period_in_clause_text(text: str) -> bool:
    """
    Проверка для пунктов профиля termination_notice (п. 9.2 и аналоги):
    в переданной строке есть число + «календарн/рабоч/дней».
    Для хода с двумя полями UI используйте ``termination_notice_draft_has_notice_period`` —
    срок уведомления ожидаем в «Новой редакции», а не в пояснении.
    """
    return _has_notice_period(text)


def termination_notice_draft_has_notice_period(
    formulation_text: str,
    explanation_text: str,
    combined: str,
    player_message: str = "",
) -> bool:
    """
    Срок N дней в профиле termination_notice: достаточно в поле «Новая редакция»;
    в пояснении повторять число дней не требуется.
    Если «Новая редакция» пуста, проверяем смонтированный combined / player_message (одно поле).
    """
    form = (formulation_text or "").strip()
    if form:
        return has_notice_period_in_clause_text(form)
    blob = (combined or "").strip() or (player_message or "").strip()
    if not blob:
        return False
    return has_notice_period_in_clause_text(blob)


def _clamp(value, lo, hi):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return (lo + hi) // 2
    return max(lo, min(hi, v))


def _pick_random(items):
    import random
    if isinstance(items, list) and items:
        return random.choice(items)
    if isinstance(items, str):
        return items
    return ""


def _fallback_result(clause_data: dict, formulation: str, explanation: str) -> dict:
    """Безопасный результат при недоступной оценке хода."""
    return {
        "agrees": False,
        "score": 40,
        "action": "clarify",
        "message": "Уточните, пожалуйста, Вашу позицию по этому пункту.",
        "reason": "stub",
        "has_formulation": bool(formulation and len(formulation.strip()) >= 5),
        "has_explanation": bool(explanation and len(explanation.strip()) >= 5),
        **_v2_negotiation_contract_field_defaults(),
        "_player_accepts_counterparty_revision": False,
    }
