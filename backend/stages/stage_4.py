"""Этап 4: Кризис и последствия. Использует stage_4_extras для проверки завершения и списка действий."""
from __future__ import annotations

import inspect
import json
import os
import random
from pathlib import Path
from typing import Any, Dict, List, Optional

from stages.base_stage import BaseStage
from stages.stage_4_extras import can_complete_stage4, get_stage4_actions
from services.action_service import (
    execute_action,
    validate_action_prerequisites,
    validate_action_mutex,
)
from services.case_service import get_case
from utils.file_loader import load_crisis_scenarios
from config import DATA_DIR

# Порядок проверки пунктов этапа 3 по таймлайну до «документов» (1.4.1 → 1.4.2 → 4.1).
# П. 6.3 (liability) проверяется отдельно после crisis-documents — см. select_first_crisis_by_prior_errors.
STAGE3_FIRST_CRISIS_CLAUSE_ORDER = [
    "clause-territory",
    "clause-term-dates",
    "clause-acts",
]

CLAUSE_LIABILITY_TRAP_ID = "clause-liability"

# Соответствие пункту этапа 4 → сценарию кризиса (как в crisis_scenarios.json).
CRISIS_ID_BY_TRAP_CLAUSE = {
    "clause-territory": "crisis-territory-001",
    "clause-term-dates": "crisis-term-001",
    "clause-acts": "crisis-acts-001",
    "clause-liability": "crisis-liability-001",
}

# Маппинг clause_id (contract_clauses.json) → clause_id в переговорах этапа 3 (fallback при отсутствии в baseline)
_TRAP_CLAUSE_TO_NEGOTIATION_CLAUSE = {
    "clause-territory": "1.4.1_territory",
    "clause-term-dates": "1.4.2_term",
    "clause-acts": "4.1_acts",
    "clause-liability": "6.3_liability",
}
CRISIS_ID_DOCUMENTS = "crisis-documents-001"
CRISIS_ID_EXTERNAL = "crisis-external-001"

# Порядок кризисов по таймлайну (второй кризис — следующий после первого в этой шкале).
CRISIS_TIMELINE_ORDER = [
    "crisis-territory-001",  # Ноябрь 2026
    "crisis-term-001",  # Март 2027
    "crisis-acts-001",  # Апрель 2027
    "crisis-documents-001",  # Август 2027
    "crisis-liability-001",  # Октябрь 2027
    "crisis-external-001",  # Декабрь 2027
]

# Второй кризис: срок и акты не должны следовать за документами / ответственностью (ТЗ).
_SECOND_CRISIS_IDS_TERM_ACTS = frozenset({"crisis-term-001", "crisis-acts-001"})
_FIRST_CRISIS_IDS_FORBID_TERM_ACTS_SECOND = frozenset(
    {CRISIS_ID_DOCUMENTS, "crisis-liability-001"}
)

STAGE1_AUTH_LETTER_DOC_ID = "auth-letter"


def _first_crisis_debug_enabled() -> bool:
    return (os.environ.get("STAGE4_FIRST_CRISIS_DEBUG") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _log_first_crisis(line: str, payload: Optional[Dict[str, Any]] = None) -> None:
    """В консоль сервера (uvicorn): задайте STAGE4_FIRST_CRISIS_DEBUG=1 в backend/.env."""
    if not _first_crisis_debug_enabled():
        return
    if payload is not None:
        line = f"{line} {json.dumps(payload, ensure_ascii=False, default=str)}"
    print(f"[stage4.first_crisis] {line}", flush=True)


def _session_external_id(session: Dict[str, Any]) -> Optional[str]:
    """Тот же приоритет, что у stage4/init: simulex id может быть только в теле запроса, не в session."""
    for k in ("session_id", "id", "sessionId"):
        v = session.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def _baseline_entry_for_stage4_clause(
    baseline: Optional[Dict[str, Any]], clause: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    if not baseline:
        return None
    cid = clause.get("clause_id")
    if not cid:
        return None
    return (baseline.get("clauses") or {}).get(str(cid))


def _negotiation_baseline_for_first_crisis(
    session: Dict[str, Any], contract_clauses: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Тот же baseline, что для UI-исключений пунктов 1.4.2 / 6.3 — чтобы не путать букву моста с ошибкой игрока."""
    sid = _session_external_id(session or {})
    if not sid:
        return None
    try:
        from services.document_service import get_contract_clauses_for_session
        from services.negotiation_session_service import get_negotiation_session_by_simulex_session
        from services.stage4_contract_resolve import build_negotiation_baseline
    except ImportError:
        return None
    neg_id, _ = get_negotiation_session_by_simulex_session(str(sid))
    if not neg_id:
        return None
    s3d = get_contract_clauses_for_session(neg_id)
    s3 = (s3d or {}).get("clauses") or []
    return build_negotiation_baseline(s3, contract_clauses)


def _scenario_by_crisis_id(
    scenarios: List[Dict[str, Any]], crisis_id: str
) -> Optional[Dict[str, Any]]:
    for s in scenarios or []:
        if s.get("crisis_id") == crisis_id:
            return s
    return None


def _pick_trap_crisis_scenario(
    clause: Dict[str, Any],
    clause_trap_id: str,
    scenarios: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Сценарий кризиса по пункту-ловушке: crisis_id из карты или related_crisis_type."""
    want_id = CRISIS_ID_BY_TRAP_CLAUSE.get(str(clause_trap_id))
    picked = _scenario_by_crisis_id(scenarios, want_id) if want_id else None
    if not picked:
        t = (clause.get("risk_profile") or {}).get("related_crisis_type")
        if t:
            picked = next((s for s in scenarios if s.get("crisis_type") == t), None)
    return dict(picked) if picked else None


def _documents_strict_mode_enabled() -> bool:
    """Если данных этапов 1–2 в сессии нет после merge из БД: None / не-list → считать gap.
    Включено по умолчанию. Выключить: STAGE4_DOCUMENTS_STRICT_MODE=0 в backend/.env."""
    val = (os.environ.get("STAGE4_DOCUMENTS_STRICT_MODE") or "").strip().lower()
    if val in ("0", "false", "no", "off"):
        return False
    return True


def _merge_session_from_db_for_stage12(session: Dict[str, Any]) -> Dict[str, Any]:
    """Подмешать в сессию поля этапов 1–2 из game_session (как baseline этапа 3 через simulex id)."""
    out = dict(session or {})
    eid = _session_external_id(out)
    if not eid:
        return out
    try:
        from services.game_session_service import get_game_session

        full = get_game_session(str(eid))
    except Exception:
        return out
    if not isinstance(full, dict):
        return out

    if out.get("stage1_requested_documents") is None and "stage1_requested_documents" in full:
        out["stage1_requested_documents"] = full.get("stage1_requested_documents")
    if not isinstance(out.get("stage2_missing_conditions_selected"), list):
        s2 = full.get("stage2_missing_conditions_selected")
        if isinstance(s2, list):
            out["stage2_missing_conditions_selected"] = s2
    for fk in (
        "stage1_authorization_letter_obtained",
        "stage1_authorization_letter_failed",
        "stage1_authorization_letter_denied",
    ):
        if fk not in out and fk in full:
            out[fk] = full[fk]
    return out


def _stage2_partner_rights_not_marked_missing(session: Dict[str, Any]) -> bool:
    from services.stage4_contract_resolve import STAGE2_PARTNER_PHRASE

    sel = session.get("stage2_missing_conditions_selected")
    if not isinstance(sel, list):
        return _documents_strict_mode_enabled()
    normalized = {str(x or "").strip() for x in sel}
    return STAGE2_PARTNER_PHRASE not in normalized


def _session_requested_authorization_letter_stage1(session: Dict[str, Any]) -> bool:
    """Как Stage4View / stage4_bridge: запрос письма по id или по формулировке в title."""
    docs = session.get("stage1_requested_documents")
    if not isinstance(docs, list):
        return False
    for d in docs:
        if not isinstance(d, dict):
            continue
        if str(d.get("id") or "").strip() == STAGE1_AUTH_LETTER_DOC_ID:
            return True
        t = str(d.get("title") or "").lower()
        if "авторизационн" in t:
            return True
    return False


def _stage1_authorization_letter_gap(session: Dict[str, Any]) -> bool:
    """
    Нет авторизационного письма правообладателя: явно не получил (флаги сессии);
    или в stage1_requested_documents есть список и по нему видно, что письмо не запрашивалось.

    Если поля stage1_requested_documents нет (None) после merge из БД — см. STAGE4_DOCUMENTS_STRICT_MODE:
    при выключенном режиме разрыв не выводим (ложные срабатывания при неполном payload); при включённом — gap.
    """
    if session.get("stage1_authorization_letter_obtained") is True:
        return False
    if session.get("stage1_authorization_letter_failed") is True:
        return True
    if session.get("stage1_authorization_letter_denied") is True:
        return True

    docs = session.get("stage1_requested_documents")
    # Fallback: если поле не заполнено — проверить через stage1_result.questions
    if docs is None:
        _s1r = session.get("stage1_result") or session.get("stage1result") or {}
        if isinstance(_s1r, dict):
            _questions = _s1r.get("questions") or []
            _has_doc = any(
                isinstance(q, dict)
                and str(q.get("quality_hint") or "").strip().lower() == "document"
                for q in _questions
            )
            if _has_doc:
                return False
        return _documents_strict_mode_enabled()
    if not isinstance(docs, list):
        return False
    if len(docs) == 0:
        return True
    if not _session_requested_authorization_letter_stage1(session):
        return True
    return session.get("stage1_authorization_letter_obtained") is False


def _try_first_crisis_for_stage3_clause(
    cid: str,
    by_cid: Dict[str, Dict[str, Any]],
    baseline: Optional[Dict[str, Any]],
    session: Dict[str, Any],
    contract_selections: Dict[str, str],
    scenarios: List[Dict[str, Any]],
    trap_snapshot: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Одна итерация логики «ловушка этапа 3» для clause_id (territory / term-dates / acts / liability)."""
    from services.stage4_contract_resolve import clause_omitted_from_stage4_contract_screen

    cl = by_cid.get(cid)
    if not cl:
        return None
    correct_id = str(cl.get("correct_variant_id") or "C").strip()
    sel = (contract_selections or {}).get(str(cid))
    ent = _baseline_entry_for_stage4_clause(baseline, cl)
    omitted = bool(baseline and clause_omitted_from_stage4_contract_screen(cl, baseline, session))
    trap_snapshot[cid] = {
        "selection_letter": sel,
        "correct_variant_id": correct_id,
        "negotiation_exclusion_counts_as_ok": omitted,
        "stage3_negotiation": None,
    }
    if ent is not None:
        trap_snapshot[cid]["stage3_negotiation"] = {
            "negotiation_correct": ent.get("negotiation_correct"),
            "negotiation_fix_kind": ent.get("negotiation_fix_kind"),
        }
        if ent.get("negotiation_correct"):
            _log_first_crisis(
                f"clause {cid}: skip (этап 3: пункт согласован корректно по переговорам), bridge={sel!r}"
            )
            return None
        picked = _pick_trap_crisis_scenario(cl, cid, scenarios)
        if picked:
            _log_first_crisis(
                "chosen: stage3 некорректное согласование",
                {
                    "crisis_id": picked.get("crisis_id"),
                    "clause_id": cid,
                    "trap_snapshot": trap_snapshot,
                },
            )
            return picked
        _log_first_crisis(f"clause {cid}: negotiation_correct=false, но сценарий не найден", {})
        return None

    if omitted:
        _log_first_crisis(
            f"clause {cid}: skip (исключение п. по переговорам), bridge letter={sel!r} vs template {correct_id!r}"
        )
        return None
    if baseline is not None:
        # DB fallback: baseline не содержит запись для этого пункта —
        # проверить outcome переговоров напрямую через БД
        neg_clause_id = _TRAP_CLAUSE_TO_NEGOTIATION_CLAUSE.get(cid)
        if neg_clause_id:
            sid = _session_external_id(session)
            if sid and _negotiation_clause_resolved_correctly(sid, neg_clause_id):
                _log_first_crisis(
                    f"clause {cid}: skip (DB fallback: пункт согласован корректно в переговорах), bridge={sel!r}"
                )
                return None
        picked = _pick_trap_crisis_scenario(cl, cid, scenarios)
        if picked:
            _log_first_crisis(
                "chosen: stage3 нет записи по пункту в baseline (пропуск / не согласовывали / нет строки)",
                {
                    "crisis_id": picked.get("crisis_id"),
                    "clause_id": cid,
                    "trap_snapshot": trap_snapshot,
                },
            )
            return picked
    else:
        sel_s = str(sel).strip() if sel is not None else ""
        if sel_s and sel_s != correct_id:
            picked = _pick_trap_crisis_scenario(cl, cid, scenarios)
            if picked:
                _log_first_crisis(
                    "chosen: нет baseline переговоров, выбор по договору не совпада с эталоном",
                    {
                        "crisis_id": picked.get("crisis_id"),
                        "clause_id": cid,
                        "trap_snapshot": trap_snapshot,
                    },
                )
                return picked
    _log_first_crisis(
        f"clause {cid}: нет сигнала для кризиса (baseline/session или буква моста как эталон)",
        {"trap_snapshot": trap_snapshot},
    )
    return None


def select_first_crisis_by_prior_errors(
    session: Dict[str, Any],
    scenarios: List[Dict[str, Any]],
    contract_clauses: List[Dict[str, Any]],
    contract_selections: Dict[str, str],
) -> Optional[Dict[str, Any]]:
    """
    Первый кризис по триггерам (порядок по таймлайну договора):

    - crisis-territory-001 — п. 1.4.1 (этап 3);
    - crisis-term-001 — п. 1.4.2 (этап 3);
    - crisis-acts-001 — п. 4.1 (этап 3);
    - crisis-documents-001 — на этапе 2 не выбрано «контрагент действует в пределах предоставленных прав»
      И нет авторизационного письма правообладателя на этапе 1 (не запрошено / явно не получено);
    - crisis-liability-001 — п. 6.3 (этап 3);
    - crisis-external-001 — если внутренние триггеры не сработали.

    Некорректное согласование этапа 3: в baseline negotiation_correct == false для соответствующего пункта.

    Если сессия переговоров этапа 3 найдена (baseline не None), но для пункта-ловушки нет записи в
    clauses — пункт не согласовывали, пропустили (AVAILABLE без текста в baseline), ключ stage3 не
    совпал и т.п. — выбираем внутренний кризис по приоритету, а не внешний.

    Раньше требовалось has_negotiation_data: при полностью пустом словаре clauses после сборки baseline
    (или только «немые» пропуски) условие не выполнялось и ошибочно выбирался внешний кризис.

    Если сессии переговоров нет (baseline is None), для ловушки с известной буквой моста: если она не совпадает
    с correct_variant_id — внутренний кризис; иначе пункт пропускается (без догадок о «пропуске» переговоров).

    Поля этапов 1–2 для documents: при отсутствии в payload подмешиваются из game_session в БД;
    если после merge данных всё ещё нет — STAGE4_DOCUMENTS_STRICT_MODE=1 трактует как gap.
    """
    if not scenarios:
        return None
    from services.stage4_contract_resolve import clause_omitted_from_stage4_contract_screen

    by_cid = {c.get("clause_id"): c for c in (contract_clauses or []) if c.get("clause_id")}
    baseline = _negotiation_baseline_for_first_crisis(session, contract_clauses)
    if _first_crisis_debug_enabled():
        _log_first_crisis(
            "negotiation baseline for exclusion check",
            {
                "loaded": baseline is not None and bool((baseline or {}).get("has_negotiation_data")),
                "session_external_id": _session_external_id(session or {}),
            },
        )

    trap_snapshot: Dict[str, Any] = {}
    for cid in STAGE3_FIRST_CRISIS_CLAUSE_ORDER:
        picked = _try_first_crisis_for_stage3_clause(
            cid, by_cid, baseline, session, contract_selections, scenarios, trap_snapshot
        )
        if picked:
            return picked

    session_docs = _merge_session_from_db_for_stage12(session)
    # Если поле не пришло через merge — восстановить из stage1_result.questions
    if session_docs.get("stage1_requested_documents") is None:
        _s1_result = session_docs.get("stage1_result") or {}
        if isinstance(_s1_result, dict):
            _questions = _s1_result.get("questions") or []
            _docs_from_result = []
            for _q in _questions:
                if not isinstance(_q, dict):
                    continue
                _hint = str(
                    _q.get("quality_hint") or _q.get("qualityhint") or ""
                ).strip().lower()
                _doc_id = str(
                    _q.get("document_attached_id")
                    or _q.get("documentAttachedId")
                    or _q.get("documentattachedid")
                    or ""
                ).strip()
                _title = str(
                    _q.get("document_attached_title")
                    or _q.get("documentAttachedTitle")
                    or _q.get("documentattachedtitle")
                    or ""
                ).strip()
                if _hint == "document" and (_doc_id or _title):
                    _docs_from_result.append({"id": _doc_id, "title": _title})
            if _docs_from_result:
                session_docs["stage1_requested_documents"] = _docs_from_result
    # Также перенести из оригинального session payload если там есть
    for _field in (
        "stage1_requested_documents",
        "stage1_authorization_letter_obtained",
        "stage1_authorization_letter_failed",
        "stage1_authorization_letter_denied",
    ):
        if session and session.get(_field) is not None:
            session_docs[_field] = session[_field]
    if session and session.get("stage2_missing_conditions_selected") is not None:
        session_docs["stage2_missing_conditions_selected"] = session["stage2_missing_conditions_selected"]
    # DEBUG: какие данные этапов 1-2 видит логика documents (тот же dict, что у doc_gap_*)
    _s2_sel = session_docs.get("stage2_missing_conditions_selected")
    _s1_docs = session_docs.get("stage1_requested_documents")
    _s1_obtained = session_docs.get("stage1_authorization_letter_obtained")
    _s1_failed = session_docs.get("stage1_authorization_letter_failed")
    _s1_denied = session_docs.get("stage1_authorization_letter_denied")
    _log_first_crisis(
        f"documents check inputs: "
        f"s2_sel={_s2_sel!r} (type={type(_s2_sel).__name__}), "
        f"s1_docs={_s1_docs!r} (type={type(_s1_docs).__name__}), "
        f"s1_obtained={_s1_obtained!r}, s1_failed={_s1_failed!r}, s1_denied={_s1_denied!r}"
    )
    _log_first_crisis(
        f"session_docs keys containing 'stage1' or 'stage2': "
        f"{[k for k in (session_docs or {}).keys() if 'stage1' in k.lower() or 'stage2' in k.lower()]}"
    )
    doc_gap_s2 = _stage2_partner_rights_not_marked_missing(session_docs)
    doc_gap_s1 = _stage1_authorization_letter_gap(session_docs)
    if doc_gap_s2 and doc_gap_s1:
        picked = _scenario_by_crisis_id(scenarios, CRISIS_ID_DOCUMENTS)
        if not picked:
            picked = next((s for s in scenarios if s.get("crisis_type") == "documents"), None)
        if picked:
            _log_first_crisis(
                "chosen: documents (этап 2 и этап 1)",
                {
                    "stage2_partner_not_marked": doc_gap_s2,
                    "stage1_auth_letter_gap": doc_gap_s1,
                    "trap_snapshot": trap_snapshot,
                },
            )
            return dict(picked)

    # --- liability (п. 6.3) — ПОСЛЕ documents по таймлайну (Октябрь 2027) ---
    liability_cid = CLAUSE_LIABILITY_TRAP_ID
    liability_cl = by_cid.get(liability_cid)
    if liability_cl:
        liability_correct_id = str(liability_cl.get("correct_variant_id") or "C").strip()
        liability_sel = (contract_selections or {}).get(liability_cid)
        liability_ent = _baseline_entry_for_stage4_clause(baseline, liability_cl)
        liability_omitted = bool(
            baseline and clause_omitted_from_stage4_contract_screen(liability_cl, baseline, session)
        )
        _log_first_crisis(
            f"liability check: sel={liability_sel!r}, correct={liability_correct_id!r}, "
            f"omitted={liability_omitted}, baseline_entry={liability_ent is not None}"
        )
        if not liability_omitted:
            if liability_ent is not None:
                if not liability_ent.get("negotiation_correct"):
                    picked = _pick_trap_crisis_scenario(liability_cl, liability_cid, scenarios)
                    if picked:
                        _log_first_crisis(
                            "chosen: liability (stage3 некорректное согласование, после documents)",
                            {"crisis_id": picked.get("crisis_id"), "clause_id": liability_cid, "trap_snapshot": trap_snapshot},
                        )
                        return picked
            elif baseline is not None:
                neg_clause_id = _TRAP_CLAUSE_TO_NEGOTIATION_CLAUSE.get(liability_cid)
                sid = _session_external_id(session)
                if neg_clause_id and sid and _negotiation_clause_resolved_correctly(sid, neg_clause_id):
                    _log_first_crisis(
                        f"clause {liability_cid}: skip (DB fallback: пункт согласован корректно в переговорах), bridge={liability_sel!r}"
                    )
                else:
                    picked = _pick_trap_crisis_scenario(liability_cl, liability_cid, scenarios)
                    if picked:
                        _log_first_crisis(
                            "chosen: liability (нет записи в baseline, после documents)",
                            {"crisis_id": picked.get("crisis_id"), "clause_id": liability_cid, "trap_snapshot": trap_snapshot},
                        )
                        return picked
            else:
                sel_s = str(liability_sel).strip() if liability_sel is not None else ""
                if sel_s and sel_s != liability_correct_id:
                    picked = _pick_trap_crisis_scenario(liability_cl, liability_cid, scenarios)
                    if picked:
                        _log_first_crisis(
                            "chosen: liability (нет baseline, буква не совпадает, после documents)",
                            {"crisis_id": picked.get("crisis_id"), "clause_id": liability_cid, "trap_snapshot": trap_snapshot},
                        )
                        return picked

    ext = _scenario_by_crisis_id(scenarios, CRISIS_ID_EXTERNAL)
    if ext:
        _log_first_crisis(
            "chosen: external (все ловушки этапа 3 согласованы, условие документов не выполнено)",
            {
                "trap_snapshot": trap_snapshot,
                "stage2_missing_len": len(session_docs.get("stage2_missing_conditions_selected") or [])
                if isinstance(session_docs.get("stage2_missing_conditions_selected"), list)
                else None,
                "stage1_docs_ids": [
                    d.get("id")
                    for d in (session_docs.get("stage1_requested_documents") or [])
                    if isinstance(d, dict)
                ],
            },
        )
        return dict(ext)
    for s in scenarios:
        if s.get("crisis_type") == "external":
            _log_first_crisis("chosen: external (fallback по crisis_type)", {"trap_snapshot": trap_snapshot})
            return dict(s)
    _log_first_crisis("fallback: first scenario", {"trap_snapshot": trap_snapshot})
    return dict(scenarios[0]) if scenarios else None


def _extract_session_from_caller_stack() -> Dict[str, Any]:
    """Достаём body.session из стека (stage4_init или stage4_second_crisis), с simulex_session_id в id/session_id."""
    for frame_info in inspect.stack():
        local_vars = frame_info.frame.f_locals
        body = local_vars.get("body")
        if body is not None and hasattr(body, "session"):
            sess = dict(body.session or {})
            sim = getattr(body, "simulex_session_id", None)
            if sim is not None:
                sim_s = str(sim).strip()
                if sim_s:
                    sess.setdefault("id", sim_s)
                    sess.setdefault("session_id", sim_s)
            return sess
    return {}


def _external_scenario_list(scenarios: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    ext = [s for s in scenarios if s.get("crisis_type") == "external"]
    if not ext:
        ext = [s for s in scenarios if str(s.get("crisis_id", "")).startswith("crisis-external")]
    return ext


def _is_external_scenario(s: Dict[str, Any], external_list: List[Dict[str, Any]]) -> bool:
    return s in external_list or s.get("crisis_type") == "external" or str(
        s.get("crisis_id", "")
    ).startswith("crisis-external")


def _filter_second_crisis_documents(
    candidates: List[Dict[str, Any]], raw_session: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Как первый кризис: documents только если gap и по этапу 2, и по этапу 1 (AND)."""
    session_docs = _merge_session_from_db_for_stage12(dict(raw_session or {}))
    # Приоритет полей из оригинального payload над данными из БД
    for _field in (
        "stage2_missing_conditions_selected",
        "stage1_requested_documents",
        "stage1_authorization_letter_obtained",
        "stage1_authorization_letter_failed",
        "stage1_authorization_letter_denied",
    ):
        if raw_session and raw_session.get(_field) is not None:
            session_docs[_field] = raw_session[_field]
    doc_gap_s2 = _stage2_partner_rights_not_marked_missing(session_docs)
    doc_gap_s1 = _stage1_authorization_letter_gap(session_docs)
    if doc_gap_s2 and doc_gap_s1:
        return list(candidates)
    return [
        s
        for s in candidates
        if s.get("crisis_id") != CRISIS_ID_DOCUMENTS and s.get("crisis_type") != "documents"
    ]


# Маппинг crisis_id → clause_id в переговорах этапа 3
_CRISIS_TO_NEGOTIATION_CLAUSE = {
    "crisis-territory-001": "1.4.1_territory",
    "crisis-term-001": "1.4.2_term",
    "crisis-acts-001": "4.1_acts",
    "crisis-liability-001": "6.3_liability",
}


def _negotiation_clause_resolved_correctly(session_external_id: str, negotiation_clause_id: str) -> bool:
    """Проверить через БД переговоров: пункт завершён (status >= 9 или строковые outcome/status)."""
    if not session_external_id or not negotiation_clause_id:
        return False
    try:
        from services.negotiation_session_service import get_negotiation_session_by_simulex_session
        from services.document_service import get_contract_clauses_for_session
    except ImportError:
        return False
    neg_id, _ = get_negotiation_session_by_simulex_session(str(session_external_id))
    if not neg_id:
        return False
    data = get_contract_clauses_for_session(neg_id)
    clauses = (data or {}).get("clauses") or []
    for cl in clauses:
        cid = cl.get("clause_id") or cl.get("id") or ""
        if str(cid).strip() == negotiation_clause_id:
            # status=9 в БД = пункт завершён (clause_excluded / accepted_changed / accepted)
            raw_status = cl.get("status")
            print(
                f"[stage4.second_crisis.neg_check] {negotiation_clause_id}: status={raw_status}, type={type(raw_status).__name__}",
                flush=True,
            )
            # Числовой статус: 9 = завершён корректно
            if isinstance(raw_status, (int, float)) and raw_status >= 9:
                return True
            # Строковый fallback
            s = str(raw_status or "").strip().lower()
            if s in ("9", "clause_excluded", "accepted_changed", "accepted", "excluded", "changed", "completed"):
                return True
            return False
    print(
        f"[stage4.second_crisis.neg_check] {negotiation_clause_id}: NOT FOUND in session {neg_id}",
        flush=True,
    )
    return False


def _filter_second_crisis_by_stage3_negotiation(
    candidates: List[Dict[str, Any]],
    raw_session: Dict[str, Any],
    contract_clauses: list,
) -> List[Dict[str, Any]]:
    """Убрать из кандидатов кризисы по пунктам, которые были корректно согласованы на этапе 3."""
    session = _merge_session_from_db_for_stage12(dict(raw_session or {}))
    # body.simulex_session_id может быть отдельным полем, не в session — нужно вытащить из стека
    if not _session_external_id(session):
        for frame_info in inspect.stack():
            loc = frame_info.frame.f_locals
            b = loc.get("body")
            if b is not None and hasattr(b, "simulex_session_id"):
                sim = getattr(b, "simulex_session_id", None)
                if sim and str(sim).strip():
                    session.setdefault("session_id", str(sim).strip())
                    session.setdefault("id", str(sim).strip())
                    break
    session = _merge_session_from_db_for_stage12(session)
    baseline = _negotiation_baseline_for_first_crisis(session, contract_clauses)
    sid = _session_external_id(session)
    print(
        f"[stage4.second_crisis.filter_negotiation] session_external_id={sid}, baseline_is_none={baseline is None}, candidates={[c.get('crisis_id') for c in candidates]}",
        flush=True,
    )
    if baseline is None:
        return list(candidates)

    from services.stage4_contract_resolve import clause_omitted_from_stage4_contract_screen

    crisis_to_clause = {v: k for k, v in CRISIS_ID_BY_TRAP_CLAUSE.items()}

    print(
        f"[stage4.second_crisis.filter_negotiation] baseline_clauses_keys={list((baseline.get('clauses') or {}).keys())}",
        flush=True,
    )

    result: List[Dict[str, Any]] = []
    for s in candidates:
        cid = s.get("crisis_id")
        clause_id = crisis_to_clause.get(cid)
        if not clause_id:
            # Не привязан к пункту этапа 3 (documents, external) — оставляем
            print(
                f"[stage4.second_crisis.filter_negotiation] DETAIL {cid}: clause_id=None, cl_found=n/a, omitted=n/a, ent=NO_ENT, neg_correct=NO_ENT (not stage3 trap)",
                flush=True,
            )
            result.append(s)
            continue

        cl = next((c for c in (contract_clauses or []) if c.get("clause_id") == clause_id), None)
        if not cl:
            print(
                f"[stage4.second_crisis.filter_negotiation] DETAIL {cid}: clause_id={clause_id}, cl_found=False, omitted=n/a, ent=NO_ENT, neg_correct=NO_ENT",
                flush=True,
            )
            neg_clause_id = _CRISIS_TO_NEGOTIATION_CLAUSE.get(cid)
            if neg_clause_id:
                sid = _session_external_id(session)
                if sid and _negotiation_clause_resolved_correctly(sid, neg_clause_id):
                    print(
                        f"[stage4.second_crisis.filter_negotiation] REMOVING {cid} (negotiation outcome correct via DB fallback)",
                        flush=True,
                    )
                    continue
            result.append(s)
            continue

        omitted = clause_omitted_from_stage4_contract_screen(cl, baseline, session)
        ent = _baseline_entry_for_stage4_clause(baseline, cl)
        neg_correct = ent.get("negotiation_correct") if isinstance(ent, dict) else None
        ent_full = json.dumps(ent, ensure_ascii=False, default=str) if isinstance(ent, dict) else repr(ent)
        print(
            f"[stage4.second_crisis.filter_negotiation] DETAIL {cid}: clause_id={clause_id}, cl_found=True, omitted={omitted}, ent_full={ent_full}, neg_correct={neg_correct!r}",
            flush=True,
        )
        if omitted:
            continue

        if ent is not None and ent.get("negotiation_correct"):
            continue

        neg_clause_id = _CRISIS_TO_NEGOTIATION_CLAUSE.get(cid)
        if neg_clause_id:
            sid = _session_external_id(session)
            if sid and _negotiation_clause_resolved_correctly(sid, neg_clause_id):
                print(
                    f"[stage4.second_crisis.filter_negotiation] REMOVING {cid} (negotiation outcome correct via DB fallback)",
                    flush=True,
                )
                continue

        result.append(s)
    print(
        f"[stage4.second_crisis.filter_negotiation] result={[c.get('crisis_id') for c in result]}",
        flush=True,
    )
    return result


def _filter_second_crisis_timeline_after(
    candidates: List[Dict[str, Any]], first_crisis_id: str
) -> List[Dict[str, Any]]:
    try:
        ix_first = CRISIS_TIMELINE_ORDER.index(first_crisis_id)
    except ValueError:
        return [c for c in candidates if c.get("crisis_id") != first_crisis_id]
    out: List[Dict[str, Any]] = []
    for c in candidates:
        cid = c.get("crisis_id")
        if cid == first_crisis_id:
            continue
        try:
            ix = CRISIS_TIMELINE_ORDER.index(str(cid))
        except ValueError:
            continue
        if ix > ix_first:
            out.append(c)
    return out


def _filter_second_crisis_no_term_acts_after_docs_or_liability(
    candidates: List[Dict[str, Any]], first_crisis_id: str
) -> List[Dict[str, Any]]:
    if str(first_crisis_id or "") not in _FIRST_CRISIS_IDS_FORBID_TERM_ACTS_SECOND:
        return list(candidates)
    return [s for s in candidates if str(s.get("crisis_id") or "") not in _SECOND_CRISIS_IDS_TERM_ACTS]


def _select_second_crisis_deterministic(
    first_crisis_id: str,
    first_outcome: str,
    contract_clauses: list,
    contract_selections: dict,
    scenarios: list,
) -> Optional[Dict[str, Any]]:
    """Подмена для routers.stage4._select_second_crisis: следующий по таймлайну после первого (см. CRISIS_TIMELINE_ORDER)."""
    print(
        f"[stage4.second_crisis] _select_second_crisis_deterministic called: first={first_crisis_id}, outcome={first_outcome}",
        flush=True,
    )
    from routers import stage4 as r4

    if not scenarios:
        result = None
        print(
            f"[stage4.second_crisis] chosen: {result.get('crisis_id') if result else None}",
            flush=True,
        )
        return None

    external = _external_scenario_list(scenarios)

    if (
        first_outcome == "fixed"
        and r4._all_traps_fixed(contract_clauses, contract_selections)
        and external
    ):
        result = random.choice(external)
        print(
            f"[stage4.second_crisis] chosen: {result.get('crisis_id') if result else None}",
            flush=True,
        )
        return result

    if first_outcome == "fixed" and not r4._all_traps_fixed(contract_clauses, contract_selections):
        # Есть ошибки в договоре (выбор ≠ correct_variant_id) — второй кризис только по этим ловушкам,
        # без расширения пула через filter_second_crisis_by_stage3_negotiation.
        by_cid_full = {c.get("clause_id"): c for c in (contract_clauses or []) if c.get("clause_id")}
        unfixed_types = set()
        for clause_id, choice in (contract_selections or {}).items():
            cl = by_cid_full.get(clause_id)
            if not cl or not isinstance(cl.get("risk_profile"), dict):
                continue
            correct = str(cl.get("correct_variant_id") or "C").strip()
            ch = str(choice).strip() if choice is not None else ""
            if ch and ch != correct:
                t = cl["risk_profile"].get("related_crisis_type")
                if t:
                    unfixed_types.add(t)
        print(
            f"[stage4.second_crisis] fixed-with-errors unfixed_types={unfixed_types!r}",
            flush=True,
        )
        if unfixed_types:
            candidates_here = [
                s
                for s in scenarios
                if s.get("crisis_type") in unfixed_types and s.get("crisis_id") != first_crisis_id
            ]
            candidates_here = _filter_second_crisis_timeline_after(candidates_here, first_crisis_id)
            candidates_here = _filter_second_crisis_no_term_acts_after_docs_or_liability(
                candidates_here, first_crisis_id
            )
            if candidates_here:
                result = random.choice(candidates_here)
                print(
                    f"[stage4.second_crisis] chosen: {result.get('crisis_id') if result else None}",
                    flush=True,
                )
                return result
        if external:
            result = random.choice(external)
            print(
                f"[stage4.second_crisis] chosen (fallback external): {result.get('crisis_id') if result else None}",
                flush=True,
            )
            return result

    trap_types = r4._get_trap_crisis_types(contract_clauses)
    clauses_by_id = {c.get("clause_id"): c for c in (contract_clauses or []) if c.get("clause_id")}

    candidates: List[Dict[str, Any]] = []

    if first_outcome == "noChange" and trap_types:
        candidates = [
            s
            for s in scenarios
            if s.get("crisis_type") in trap_types and s.get("crisis_id") != first_crisis_id
        ]
    elif first_outcome == "repeat":
        unfixed_types = set()
        for clause_id, choice in (contract_selections or {}).items():
            cl = clauses_by_id.get(clause_id)
            if not cl or not isinstance(cl.get("risk_profile"), dict):
                continue
            correct_id = cl.get("correct_variant_id", "C")
            if choice and choice != correct_id:
                t = cl["risk_profile"].get("related_crisis_type")
                if t:
                    unfixed_types.add(t)
        if unfixed_types:
            candidates = [
                s
                for s in scenarios
                if s.get("crisis_type") in unfixed_types and s.get("crisis_id") != first_crisis_id
            ]

    if not candidates:
        others = [
            s
            for s in scenarios
            if s.get("crisis_id") != first_crisis_id and s not in external
        ]
        if not others:
            others = [s for s in scenarios if s.get("crisis_id") != first_crisis_id]
        candidates = others

    raw_sess = _extract_session_from_caller_stack()
    candidates = _filter_second_crisis_documents(candidates, raw_sess)
    candidates = _filter_second_crisis_by_stage3_negotiation(candidates, raw_sess, contract_clauses)
    candidates = _filter_second_crisis_timeline_after(candidates, first_crisis_id)
    candidates = _filter_second_crisis_no_term_acts_after_docs_or_liability(candidates, first_crisis_id)

    internals = [s for s in candidates if not _is_external_scenario(s, external)]
    externals_here = [s for s in candidates if _is_external_scenario(s, external)]

    if internals:
        result = random.choice(internals)
        print(
            f"[stage4.second_crisis] chosen: {result.get('crisis_id') if result else None}",
            flush=True,
        )
        return result
    if externals_here:
        result = random.choice(externals_here)
        print(
            f"[stage4.second_crisis] chosen: {result.get('crisis_id') if result else None}",
            flush=True,
        )
        return result
    if external:
        result = random.choice(external)
        print(
            f"[stage4.second_crisis] chosen: {result.get('crisis_id') if result else None}",
            flush=True,
        )
        return result
    result = random.choice(scenarios) if scenarios else None
    print(
        f"[stage4.second_crisis] chosen: {result.get('crisis_id') if result else None}",
        flush=True,
    )
    return result


def _select_crisis_for_init_from_context(
    scenarios: List[Dict[str, Any]],
    contract_clauses: List[Dict[str, Any]],
    contract_selections: Dict[str, str],
) -> Optional[Dict[str, Any]]:
    """Подмена для routers.stage4._select_crisis_by_contract_selections; session из стека вызовов stage4_init."""
    sess = _extract_session_from_caller_stack()
    clauses_for_crisis = contract_clauses
    sim_sid = _session_external_id(sess)
    if sim_sid:
        from services.stage4_bridge_service import trap_scan_clauses_for_stage4_first_crisis

        case_id = (sess.get("case_id") or sess.get("case_code") or "case-stage-4").strip() or "case-stage-4"
        clauses_for_crisis = trap_scan_clauses_for_stage4_first_crisis(
            DATA_DIR, case_id, sim_sid, sess
        )
    return select_first_crisis_by_prior_errors(
        sess, scenarios, clauses_for_crisis, contract_selections
    )


def wire_stage4_first_crisis_selector() -> None:
    import routers.stage4 as r

    if getattr(r, "_stage4_first_crisis_wired", False):
        return
    r._select_crisis_by_contract_selections = _select_crisis_for_init_from_context
    r._stage4_first_crisis_wired = True


def wire_stage4_second_crisis_selector() -> None:
    import routers.stage4 as r

    if getattr(r, "_stage4_second_crisis_wired", False):
        return
    r._select_second_crisis = _select_second_crisis_deterministic
    r._stage4_second_crisis_wired = True
    print("✅ wire_stage4_second_crisis_selector: monkey-patch applied", flush=True)


def sync_stage4_contract_from_stage3(
    data_dir: Path, case_id: str, session: Dict[str, Any]
) -> None:
    """
    При завершении этапа 3: сохранить мост в БД (game_session_stage4_bridge).
    Запись в общий contract.json на диск — только при STAGE4_SYNC_CONTRACT_TO_DISK=1 (отладка).
    """
    if not case_id:
        return
    from services.stage4_bridge_service import sync_stage4_contract_from_stage3_entry

    sync_stage4_contract_from_stage3_entry(data_dir, str(case_id), session)


class Stage4(BaseStage):
    """Этап 4: Кризис и последствия. Контент и сценарий — в routers/stage4.py и Stage4View."""

    def get_stage_info(self) -> Dict[str, Any]:
        return {
            "title": self.stage_config.get("title") or "Этап 4: Кризис и последствия",
            "intro": self.stage_config.get("intro") or "Пройдите кризис",
            "type": "crisis",
            "points_budget": self.stage_config.get("points_budget", 6),
        }

    def get_actions(self) -> List[Dict[str, Any]]:
        # Кризисные действия приходят в session при execute; здесь только из конфига
        return get_stage4_actions(self.stage_config, {})

    def validate_action(self, action_id: str, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        actions = get_stage4_actions(self.stage_config, session)
        action = next((a for a in actions if a.get("id") == action_id), None)
        if not action:
            return False, "Действие не найдено"
        is_valid, error_msg = validate_action_prerequisites(action, session)
        if not is_valid:
            return False, error_msg
        case_id = (session.get("case_id") or "").replace("case-", "") or None
        case_data = get_case(DATA_DIR, case_id)
        is_valid, error_msg = validate_action_mutex(action, case_data, session)
        if not is_valid:
            return False, error_msg
        return True, None

    def execute_action(self, action_id: str, session: Dict[str, Any]) -> Dict[str, Any]:
        actions = get_stage4_actions(self.stage_config, session)
        action = next((a for a in actions if a.get("id") == action_id), None)
        if not action:
            raise ValueError("Действие не найдено")
        return execute_action(action, session)

    def can_complete(self, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        return can_complete_stage4(session, self.stage_config)

    def on_complete(self, session: Dict[str, Any]) -> Dict[str, Any]:
        """Пересчёт LEXIC по результатам этапа 4 с множителями значимости/контекста."""
        try:
            from services.stage4_lexic_service import STAGE4_LEXIC_LX_DELTA_SCALE, compute_stage4_lexic
            from utils.validators import clamp
            stage4_state = session.get("stage_4_state") or {}
            if not stage4_state:
                return session

            # Загружаем данные кризисных сценариев для проверки правильности ответов
            case_id = (session.get("case_id") or "").replace("case-", "").strip() or None
            crisis_scenarios: Dict[str, Any] = {}
            if case_id:
                try:
                    raw_sc = load_crisis_scenarios(DATA_DIR, case_id) or {}
                    scenarios_list = raw_sc.get("crisis_scenarios") or []
                    crisis_scenarios = {
                        str(s.get("crisis_id") or s.get("id") or i): s
                        for i, s in enumerate(scenarios_list)
                        if isinstance(s, dict)
                    }
                except Exception:
                    pass

            result = compute_stage4_lexic(stage4_state, crisis_scenarios)
            deltas = result.get("deltas", {})

            if any(v != 0 for v in deltas.values()):
                lexic = dict(session.get("lexic") or {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50})
                for p in ("L", "E", "X", "I", "C"):
                    raw = float(deltas.get(p, 0) or 0)
                    if p in ("L", "X"):
                        d = int(round(raw * STAGE4_LEXIC_LX_DELTA_SCALE))
                    else:
                        d = int(round(raw))
                    lexic[p] = clamp(int(lexic[p]) + d, 0, 100)

                updated = dict(session)
                updated["lexic"] = lexic
                updated["stage4_lexic_breakdown"] = result
                print(f"📊 Этап 4: применены LEXIC-дельты: {deltas}")
                return updated

        except Exception as _e:
            print(f"⚠️ stage_4.on_complete: ошибка расчёта LEXIC: {_e}")

        return session


# Подключение выбора первого кризиса к /api/stage4/init (импорт stages идёт после routers.stage4 в main).
try:
    wire_stage4_first_crisis_selector()
except Exception as _e:
    print(f"⚠️ wire_stage4_first_crisis_selector: {_e}")
try:
    wire_stage4_second_crisis_selector()
except Exception as _e:
    print(f"⚠️ wire_stage4_second_crisis_selector: {_e}")
