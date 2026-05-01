"""
Детерминированная «развёртка» пунктов договора этапа 4 (как Stage4View.js),
с фиксированным RNG от external_id сессии — чтобы буквы A/B/C совпадали с сохранённым мостом.
"""

from __future__ import annotations

import copy
import hashlib
import random
from typing import Any, Dict, List, Optional, Tuple

from services.document_service import ClauseStatus

CONTRACT_ALT_OPTION_LABEL = "Предлагаемая редакция"
STAGE2_PARTNER_PHRASE = "контрагент действует в пределах предоставленных прав"
STAGE2_SUBLICENSE_PHRASE = "право на сублицензирование"

NEG_ACCEPTED_BOT = 5
NEG_CHANGED = 6
                                                                                
CLAUSE_STATUS_EXCLUDED = 9


def _stage3_clause_status_is_success_for_baseline(st: int) -> bool:
    """
    Успешно закрытый пункт переговоров для baseline этапа 4 / первого кризиса.

    Раньше учитывались только ACCEPTED_BOT / CHANGED / EXCLUDED — из‑за этого п. 4.1 (акты) и др.
    при исходе NO_EDITS (без правок) или KEPT_COUNTERPARTY (оставлена редакция контрагента) получали
    negotiation_correct=false и ошибочно триггерили внутренний кризис, хотя этап 3 отработан корректно.
    """
    return st in (
        ClauseStatus["NO_EDITS"],
        ClauseStatus["ACCEPTED_BOT"],
        ClauseStatus["CHANGED"],
        ClauseStatus["KEPT_COUNTERPARTY"],
        ClauseStatus["EXCLUDED"],
    )

STAGE1_AUTH_LETTER_DOC_ID = "auth-letter"


def _session_requested_stage1_authorization_letter(session: Optional[Dict[str, Any]]) -> bool:
    """На этапе 1 игрок запрашивал авторизационное письмо — пункт «Документы партнёра» на этапе 4 не показываем."""
    if not session:
        return False
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


def session_seed_from_external_id(external_id: str) -> int:
    h = hashlib.sha256(str(external_id or "").encode("utf-8")).hexdigest()
    return int(h[:12], 16) % (2**31)


def stage2_flags_for_stage4(session: Optional[Dict[str, Any]]) -> Dict[str, bool]:
    """Флаги для alternate-текста этапа 4: этап 2 (missing conditions) + authletter из stage1_result.questions (quality_hint=document)."""
    if not session:
        return {}
    prev = session.get("stage_4_stage2_flags")
    prev = prev if isinstance(prev, dict) else {}
    derived: Dict[str, bool] = {}
    sel = session.get("stage2_missing_conditions_selected")
    if isinstance(sel, list):
        for s in sel:
            t = str(s or "").strip()
            if t == STAGE2_PARTNER_PHRASE:
                derived["partner_within_rights"] = True
            if t == STAGE2_SUBLICENSE_PHRASE:
                derived["sublicensing"] = True
    questions = (session.get("stage1_result") or {}).get("questions") or []
    auth_requested = any(
        str(q.get("quality_hint") or "").strip().lower() == "document"
        for q in questions
        if isinstance(q, dict)
    )
    if auth_requested:
        derived["authletter"] = True
    return {**prev, **derived}


def effective_original_text_for_stage4(clause: Dict[str, Any], flags: Dict[str, bool]) -> str:
    cid = clause.get("clause_id")
    alt = (clause.get("original_text_alternate") or "").strip()
    if alt and cid == "clause-term-customization" and flags.get("sublicensing"):
        return alt
    if alt and cid == "clause-documents" and (
        flags.get("partner_within_rights") or flags.get("authletter")
    ):
        return alt
    return (clause.get("original_text") or "").strip()


def negotiation_text_implies_exclusion(agreed_text: str, markers: Optional[List[str]]) -> bool:
    if not agreed_text or not markers:
        return False
    low = " ".join(str(agreed_text).lower().split())
    for m in markers:
        frag = str(m or "").lower().strip()
        if frag and frag in low:
            return True
    return False


def resolve_s3_clause_by_key(
    by_id: Dict[str, Dict[str, Any]], s3key: str
) -> Optional[Dict[str, Any]]:
    """stage3_clause_id в contract.json может быть «4.1_acts», в clauses API — id/number «4.1»."""
    if not s3key:
        return None
    direct = by_id.get(s3key)
    if direct is not None:
        return direct
    u = str(s3key).strip()
    idx = u.find("_")
    if idx <= 0:
        return None
    prefix = u[:idx].strip()
    if not prefix:
        return None
    return by_id.get(prefix)


def build_negotiation_baseline(
    s3_clauses: List[Dict[str, Any]], raw_stage4_clauses: List[Dict[str, Any]]
) -> Dict[str, Any]:
    by_id: Dict[str, Dict[str, Any]] = {}
    for c in s3_clauses or []:
        cid = str(c.get("id") or "").strip()
        if cid:
            by_id[cid] = c
        num = c.get("number")
        num_s = str(num).strip() if num is not None else ""
        if num_s and num_s not in by_id:
            by_id[num_s] = c
    clauses: Dict[str, Any] = {}
    for fc in raw_stage4_clauses or []:
        s3key = str(fc.get("stage3_clause_id") or "").strip()
        s4id = fc.get("clause_id")
        if not s3key or not s4id:
            continue
        s3 = resolve_s3_clause_by_key(by_id, s3key)
        if not s3:
            continue
        repl = (s3.get("replacementText") or "").strip()
        base = (s3.get("text") or s3.get("contract_text") or "").strip()
        agreed = repl or base
        try:
            st = int(s3.get("status"))
        except (TypeError, ValueError):
            st = 0
        if not agreed and st != CLAUSE_STATUS_EXCLUDED:
            continue
        if not agreed and st == CLAUSE_STATUS_EXCLUDED:
            agreed = base or "[исключён]"

        negotiation_correct = _stage3_clause_status_is_success_for_baseline(st)
        markers = fc.get("negotiation_exclusion_markers")
        markers_l = markers if isinstance(markers, list) else []
        if st == CLAUSE_STATUS_EXCLUDED:
            negotiation_exclusion = True
        else:
            negotiation_exclusion = negotiation_correct and negotiation_text_implies_exclusion(agreed, markers_l)
        if negotiation_correct:
            fix_kind = "exclusion" if negotiation_exclusion else "replacement"
        else:
            fix_kind = "incorrect"
        clauses[str(s4id)] = {
            "agreed_text": agreed,
            "negotiation_correct": negotiation_correct,
            "negotiation_exclusion": bool(negotiation_exclusion),
            "negotiation_fix_kind": fix_kind,
        }
    return {"has_negotiation_data": len(clauses) > 0, "clauses": clauses}


def clause_omitted_from_stage4_contract_screen(
    clause: Dict[str, Any],
    baseline: Dict[str, Any],
    session: Optional[Dict[str, Any]] = None,
) -> bool:
    cid = clause.get("clause_id")
    if not cid:
        return False
    if not clause.get("stage4_hide_if_negotiation_exclusion"):
        return False
    clauses = (baseline or {}).get("clauses") or {}
    e = clauses.get(cid)
    return bool(e and e.get("negotiation_correct") and e.get("negotiation_exclusion"))


def _pool_pick(rng: random.Random, arr: List[Any]) -> Optional[Any]:
    if not arr:
        return None
    return arr[rng.randrange(len(arr))]


def _pick_two_distinct_wrongs(rng: random.Random, wrong_pool: List[Dict[str, Any]]) -> Tuple[Dict, Dict]:
    wp = wrong_pool or []
    if len(wp) < 2:
        z = wp[0] if wp else {}
        return z, z
    i = rng.randrange(len(wp))
    j = rng.randrange(len(wp))
    guard = 0
    while j == i and guard < 40:
        j = rng.randrange(len(wp))
        guard += 1
    if j == i:
        j = (i + 1) % len(wp)
    return wp[i], wp[j]


def _shuffle_slots(
    rng: random.Random, slots: List[Dict[str, Any]], correct_slot_index: int
) -> Tuple[List[Dict[str, Any]], str]:
    tagged = [(i == correct_slot_index, s) for i, s in enumerate(slots)]
    a = list(tagged)
    for i in range(len(a) - 1, 0, -1):
        j = rng.randint(0, i)
        a[i], a[j] = a[j], a[i]
    letters = ["A", "B", "C"]
    correct_variant_id = "A"
    variants: List[Dict[str, Any]] = []
    for idx, (is_ok, s) in enumerate(a):
        vid = letters[idx]
        if is_ok:
            correct_variant_id = vid
        variants.append({"id": vid, **{k: v for k, v in s.items()}})
    return variants, correct_variant_id


def _strip_pools(x: Dict[str, Any]) -> Dict[str, Any]:
    drop = {
        "unchanged_variant",
        "unchanged_variant_alternate",
        "correct_pool",
        "wrong_pool",
        "variant_mode",
        "original_text_alternate",
    }
    return {k: v for k, v in x.items() if k not in drop}


def apply_static_negotiation_baseline_to_clause(
    clause: Dict[str, Any], negotiation_baseline: Dict[str, Any]
) -> Dict[str, Any]:
    if not clause or not negotiation_baseline.get("has_negotiation_data"):
        return clause
    entry = (negotiation_baseline.get("clauses") or {}).get(clause.get("clause_id"))
    if not entry:
        return clause
    agreed = (entry.get("agreed_text") or "").strip()
    if not agreed:
        return clause
    nxt = {**clause, "original_text": agreed}
    uv = nxt.get("unchanged_variant")
    if isinstance(uv, dict):
        nxt["unchanged_variant"] = {**uv, "text": agreed}
    vars_ = nxt.get("variants")
    if isinstance(vars_, list):
        nxt["variants"] = [
            {**v, "text": agreed} if "Оставить без изменений" in str(v.get("label") or "") else dict(v)
            for v in vars_
        ]
    return nxt


def resolve_clause_random_pools(
    clause: Dict[str, Any],
    negotiation_baseline: Dict[str, Any],
    flags: Dict[str, bool],
    rng: random.Random,
) -> Dict[str, Any]:
    c0 = clause
    cp = c0.get("correct_pool") or []
    wp = c0.get("wrong_pool") or []
    if not isinstance(cp, list) or not isinstance(wp, list):
        return c0

    eff = effective_original_text_for_stage4(c0, flags)
    uses_alt = (
        c0.get("clause_id") == "clause-documents"
        and flags.get("partner_within_rights")
        and (c0.get("original_text_alternate") or "").strip()
        and eff == (c0.get("original_text_alternate") or "").strip()
    )
    u_eff = c0.get("unchanged_variant") or {}
    alt_eff = (c0.get("unchanged_variant_alternate") or {}).get("effect") if uses_alt else None
    unchanged_effect = alt_eff if uses_alt and alt_eff else u_eff.get("effect")

    c = {
        **c0,
        "original_text": eff or c0.get("original_text"),
        "unchanged_variant": {**u_eff, "text": eff or u_eff.get("text"), "effect": unchanged_effect},
    }

    by_cid = (
        (negotiation_baseline.get("clauses") or {}) if negotiation_baseline.get("has_negotiation_data") else {}
    )
    entry = by_cid.get(c.get("clause_id"))
    agreed = (entry.get("agreed_text") or "").strip() if entry else ""
    has_baseline = bool(agreed)
    ok = bool(entry and entry.get("negotiation_correct") is True)
    u = c.get("unchanged_variant") or {}

    if not has_baseline:
        uses_sublicense_alt = (
            c0.get("clause_id") == "clause-term-customization"
            and flags.get("sublicensing")
            and (c0.get("original_text_alternate") or "").strip()
        )
        only_unchanged_correct = uses_sublicense_alt or uses_alt
        if only_unchanged_correct and len(wp) >= 2:
            w1, w2 = _pick_two_distinct_wrongs(rng, wp)
            slots = [
                {"label": "Оставить без изменений", "text": u.get("text"), "effect": u.get("effect")},
                {"label": CONTRACT_ALT_OPTION_LABEL, "text": w1.get("text"), "effect": w1.get("effect")},
                {"label": CONTRACT_ALT_OPTION_LABEL, "text": w2.get("text"), "effect": w2.get("effect")},
            ]
            variants, correct_id = _shuffle_slots(rng, slots, 0)
            return _strip_pools({**c, "variants": variants, "correct_variant_id": correct_id})
        if not cp or not wp:
            return c0
        correct = _pool_pick(rng, cp)
        wrong = _pool_pick(rng, wp)
        if not correct or not wrong:
            return c0
        slots = [
            {"label": "Оставить без изменений", "text": u.get("text"), "effect": u.get("effect")},
            {"label": CONTRACT_ALT_OPTION_LABEL, "text": correct.get("text"), "effect": correct.get("effect")},
            {"label": CONTRACT_ALT_OPTION_LABEL, "text": wrong.get("text"), "effect": wrong.get("effect")},
        ]
        variants, correct_id = _shuffle_slots(rng, slots, 1)
        return _strip_pools({**c, "variants": variants, "correct_variant_id": correct_id})

    c = {**c, "original_text": agreed, "unchanged_variant": {**u, "text": agreed}}

    if ok:
        if not wp:
            return c0
        w1, w2 = _pick_two_distinct_wrongs(rng, wp)
        slots = [
            {"label": "Оставить без изменений", "text": agreed, "effect": u.get("effect")},
            {"label": CONTRACT_ALT_OPTION_LABEL, "text": w1.get("text"), "effect": w1.get("effect")},
            {"label": CONTRACT_ALT_OPTION_LABEL, "text": w2.get("text"), "effect": w2.get("effect")},
        ]
        variants, correct_id = _shuffle_slots(rng, slots, 0)
        return _strip_pools({**c, "variants": variants, "correct_variant_id": correct_id})

    if not cp or not wp:
        return c0
    correct = _pool_pick(rng, cp)
    wrong = _pool_pick(rng, wp)
    if not correct or not wrong:
        return c0
    slots = [
        {"label": "Оставить без изменений", "text": agreed, "effect": u.get("effect")},
        {"label": CONTRACT_ALT_OPTION_LABEL, "text": correct.get("text"), "effect": correct.get("effect")},
        {"label": CONTRACT_ALT_OPTION_LABEL, "text": wrong.get("text"), "effect": wrong.get("effect")},
    ]
    variants, correct_id = _shuffle_slots(rng, slots, 1)
    return _strip_pools({**c, "variants": variants, "correct_variant_id": correct_id})


def resolve_stage4_contract_clauses(
    clauses: List[Dict[str, Any]],
    negotiation_baseline: Dict[str, Any],
    session: Optional[Dict[str, Any]],
    simulex_external_id: str,
) -> List[Dict[str, Any]]:
    rng = random.Random(session_seed_from_external_id(simulex_external_id))
    flags = stage2_flags_for_stage4(session or {})
    out: List[Dict[str, Any]] = []
    for cl in clauses or []:
        cl = copy.deepcopy(cl)
        if cl.get("variant_mode") == "random_pools":
            pre = cl
            resolved = resolve_clause_random_pools(pre, negotiation_baseline, flags, rng)
        else:
            pre = apply_static_negotiation_baseline_to_clause(cl, negotiation_baseline)
            resolved = pre
        if isinstance(resolved, dict):
            resolved["stage4_server_resolved"] = True
        out.append(resolved)
    return out


def variant_texts_snapshot_for_clause(clause: Dict[str, Any]) -> Dict[str, str]:
    snap: Dict[str, str] = {}
    for v in clause.get("variants") or []:
        vid = v.get("id")
        if vid in ("A", "B", "C"):
            snap[str(vid)] = (v.get("text") or "").strip()
    return snap
