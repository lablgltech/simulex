"""Построение и сохранение моста этап 3→4; загрузка договора с merge из БД."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from services.document_service import get_contract_clauses_for_session
from services.negotiation_session_service import get_negotiation_session_by_simulex_session
from services.stage4_bridge_repository import fetch_stage4_bridge, upsert_stage4_bridge
from services.stage4_contract_resolve import (
    build_negotiation_baseline,
    clause_omitted_from_stage4_contract_screen,
    resolve_s3_clause_by_key,
    resolve_stage4_contract_clauses,
    variant_texts_snapshot_for_clause,
)
from services.stage4_text_match import hybrid_match_agreed_to_letter
from utils.file_loader import load_contract_clauses

STAGE1_AUTH_LETTER_DOC_ID = "auth-letter"


def session_requested_stage1_authorization_letter(session: Optional[Dict[str, Any]]) -> bool:
    """На этапе 1 игрок запрашивал авторизационное письмо — пункт «Документы партнёра» на экране договора этапа 4 скрываем."""
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


def filter_stage4_contract_clauses_hide_documents_if_stage1_auth_letter(
    clauses: List[Dict[str, Any]], session: Optional[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    if not clauses or not session_requested_stage1_authorization_letter(session):
        return clauses
    return [c for c in clauses if str(c.get("clause_id") or "") != "clause-documents"]


def _stage4_contract_path(data_dir: Path, case_id: str) -> Path:
    clean = str(case_id or "").replace("case-", "").strip()
    return data_dir / "cases" / f"case-{clean}" / "stage-4" / "contract" / "contract.json"


def _normalize_case_code(case_id: Optional[str]) -> str:
    if not case_id:
        return ""
    s = str(case_id).strip()
    if not s.startswith("case-"):
        s = f"case-{s.replace('case-', '')}"
    return s


def merge_bridge_original_into_contract(
    contract: Optional[Dict[str, Any]], bridge: Optional[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    if not contract:
        return contract
    if not bridge:
        return contract
    ot = bridge.get("original_text_by_clause_id") or {}
    if not ot:
        return contract
    out = copy.deepcopy(contract)
    for cl in out.get("clauses") or []:
        cid = cl.get("clause_id")
        if cid and cid in ot:
            cl["original_text"] = ot[cid]
    return out


def _stage3_clause_by_id(stage3_clauses: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    by_id: Dict[str, Dict[str, Any]] = {}
    for c in stage3_clauses or []:
        i = str(c.get("id") or "").strip()
        if i:
            by_id[i] = c
        num = c.get("number")
        ns = str(num).strip() if num is not None else ""
        if ns and ns not in by_id:
            by_id[ns] = c
    return by_id


def _original_texts_from_stage3(
    template_clauses: List[Dict[str, Any]], by_id: Dict[str, Dict[str, Any]]
) -> Dict[str, str]:
    """
    Исходные формулировки для моста и экрана этапа 4: согласованная на этапе 3 замена (replacementText),
    иначе текст пункта из данных переговоров этапа 3 (в т.ч. п. 1.4.1, 1.4.2, 4.1).
    """
    out: Dict[str, str] = {}
    for c in template_clauses or []:
        cid = c.get("clause_id")
        if not cid:
            continue
        s3_key = str(c.get("stage3_clause_id") or c.get("clause_id") or c.get("id") or "").strip()
        s3 = resolve_s3_clause_by_key(by_id, s3_key) if s3_key else None
        if not s3:
            continue
        orig = (s3.get("replacementText") or s3.get("text") or "").strip()
        if orig:
            out[str(cid)] = orig
    return out


def persist_stage4_bridge_after_stage3(data_dir: Path, session: Dict[str, Any]) -> None:
    """После этапа 3: записать мост в БД. Ошибки БД логируем, не роняем complete_stage."""
    case_id = session.get("case_id") or session.get("case_code")
    sim_id = session.get("session_id") or session.get("id")
    if not case_id or not sim_id:
        return
    path = _stage4_contract_path(data_dir, str(case_id))
    if not path.exists():
        return
    try:
        neg_id, _ = get_negotiation_session_by_simulex_session(str(sim_id))
        if not neg_id:
            return
        stage3_data = get_contract_clauses_for_session(neg_id)
        stage3_clauses = (stage3_data or {}).get("clauses") or []
        by_id = _stage3_clause_by_id(stage3_clauses)
        contract = load_contract_clauses(data_dir, str(case_id))
        if not contract or not contract.get("clauses"):
            return
        template_full = filter_stage4_contract_clauses_hide_documents_if_stage1_auth_letter(
            contract.get("clauses") or [], session
        )
        baseline = build_negotiation_baseline(stage3_clauses, template_full)
        original_by_cid = _original_texts_from_stage3(template_full, by_id)
        template_clauses = [
            c
            for c in template_full
            if not clause_omitted_from_stage4_contract_screen(c, baseline, session)
        ]
        external_id = str(sim_id)
        case_code = _normalize_case_code(str(case_id))

        resolved = resolve_stage4_contract_clauses(
            template_clauses, baseline, session, external_id
        )

        contract_selections: Dict[str, str] = {}
        selection_source: Dict[str, Any] = {}
        option_snapshots: Dict[str, Any] = {}

        for cl in resolved:
            cid = cl.get("clause_id")
            if not cid:
                continue
            cid_s = str(cid)
            snap = variant_texts_snapshot_for_clause(cl)
            option_snapshots[cid_s] = snap

            agreed = ""
            ent = (baseline.get("clauses") or {}).get(cid_s)
            if ent:
                agreed = (ent.get("agreed_text") or "").strip()
            if not agreed:
                agreed = (original_by_cid.get(cid_s) or "").strip()

            if len(snap) < 3:
                contract_selections[cid_s] = "A"
                selection_source[cid_s] = {"source": "default", "reason": "no_variants"}
                continue

            if not agreed:
                contract_selections[cid_s] = "A"
                selection_source[cid_s] = {"source": "default", "reason": "no_agreed"}
                continue

            letter, src, meta = hybrid_match_agreed_to_letter(agreed, snap)
            contract_selections[cid_s] = letter
            entry: Dict[str, Any] = {"source": src}
            entry.update(meta)
            selection_source[cid_s] = entry

        upsert_stage4_bridge(
            game_session_external_id=external_id,
            case_code=case_code,
            original_text_by_clause_id=original_by_cid,
            contract_selections=contract_selections,
            selection_source=selection_source,
            option_texts_snapshot=option_snapshots,
        )
    except Exception as e:
        print(f"⚠️ persist_stage4_bridge_after_stage3: {e}")


def _load_contract_and_bridge_for_stage4_impl(
    data_dir: Path,
    case_id: str,
    simulex_session_id: Optional[str],
    session: Optional[Dict[str, Any]],
) -> Tuple[
    Optional[Dict[str, Any]],
    Dict[str, str],
    List[Dict[str, Any]],
    List[Dict[str, Any]],
]:
    """
    Внутренняя сборка: (contract, selections, resolved, trap_scan_clauses).
    trap_scan — до фильтра omission, после скрытия «документы» при письме этапа 1.
    """
    raw = load_contract_clauses(data_dir, case_id)
    if not raw:
        return None, {}, [], []

    bridge = None
    eid = str(simulex_session_id or "").strip()
    cc = _normalize_case_code(str(case_id))
    if eid and cc:
        bridge = fetch_stage4_bridge(eid, cc)

    merged = merge_bridge_original_into_contract(raw, bridge)
    template_clauses = merged.get("clauses") or [] if merged else []
    template_clauses = filter_stage4_contract_clauses_hide_documents_if_stage1_auth_letter(
        template_clauses, session
    )

    baseline: Dict[str, Any] = {"has_negotiation_data": False, "clauses": {}}
    if eid:
        neg_id, _ = get_negotiation_session_by_simulex_session(eid)
        if neg_id:
            try:
                s3d = get_contract_clauses_for_session(neg_id)
                s3 = (s3d or {}).get("clauses") or []
                baseline = build_negotiation_baseline(s3, template_clauses)
            except Exception:
                pass

    trap_scan_clauses: List[Dict[str, Any]] = list(template_clauses)

    template_clauses = [
        c
        for c in template_clauses
        if not clause_omitted_from_stage4_contract_screen(c, baseline, session)
    ]

    selections: Dict[str, str] = {}
    if bridge and isinstance(bridge.get("contract_selections"), dict):
        selections = {str(k): str(v) for k, v in bridge["contract_selections"].items()}

    if not eid:
        resolved = template_clauses
    else:
        resolved = resolve_stage4_contract_clauses(
            template_clauses, baseline, session or {}, eid
        )

    if not selections:
        fill_src = resolved if resolved else trap_scan_clauses
        for cl in fill_src:
            cid = cl.get("clause_id")
            if cid:
                selections[str(cid)] = "A"

    if session_requested_stage1_authorization_letter(session):
        selections.pop("clause-documents", None)

    return merged, selections, resolved, trap_scan_clauses


def load_contract_and_bridge_for_stage4(
    data_dir: Path,
    case_id: str,
    simulex_session_id: Optional[str],
    session: Optional[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], Dict[str, str], List[Dict[str, Any]]]:
    """
    Шаблон с диска → merge original_text из моста → детерминированный resolve.
    Возвращает (contract_dict, contract_selections, resolved_clauses).
    """
    merged, selections, resolved, _ = _load_contract_and_bridge_for_stage4_impl(
        data_dir, case_id, simulex_session_id, session
    )
    return merged, selections, resolved


def trap_scan_clauses_for_stage4_first_crisis(
    data_dir: Path,
    case_id: str,
    simulex_session_id: str,
    session: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Пункты для логики первого кризиса (до фильтра omission). Роутер init передаёт в селектор
    только resolved — подмена в stages.stage_4 подставляет этот список при наличии sim_sid.
    """
    _, _, _, trap = _load_contract_and_bridge_for_stage4_impl(
        data_dir, case_id, simulex_session_id, session
    )
    return trap


def legacy_write_stage4_contract_json(data_dir: Path, case_id: str, session: Dict[str, Any]) -> None:
    """Прежняя запись contract.json на диск (только STAGE4_SYNC_CONTRACT_TO_DISK=1)."""
    import json

    path = _stage4_contract_path(data_dir, str(case_id))
    if not path.exists():
        return
    contract = load_contract_clauses(data_dir, str(case_id))
    if not contract or not contract.get("clauses"):
        return
    simulex_session_id = session.get("session_id") or session.get("id")
    if not simulex_session_id:
        return
    neg_id, _ = get_negotiation_session_by_simulex_session(str(simulex_session_id))
    if not neg_id:
        return
    try:
        stage3_data = get_contract_clauses_for_session(neg_id)
        stage3_clauses = (stage3_data or {}).get("clauses") or []
        by_id = _stage3_clause_by_id(stage3_clauses)
    except Exception:
        return
    clauses = contract.get("clauses") or []
    for c in clauses:
        s3_key = str(c.get("stage3_clause_id") or c.get("clause_id") or c.get("id") or "").strip()
        s3 = resolve_s3_clause_by_key(by_id, s3_key) if s3_key else None
        if not s3:
            continue
        orig = (s3.get("replacementText") or s3.get("text") or "").strip()
        if orig:
            c["original_text"] = orig
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(contract, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ legacy_write_stage4_contract_json: {e}")


def sync_stage4_contract_from_stage3_entry(data_dir: Path, case_id: str, session: Dict[str, Any]) -> None:
    """Точка входа из stage_service: мост в БД + опционально диск."""
    persist_stage4_bridge_after_stage3(data_dir, session)
    if os.getenv("STAGE4_SYNC_CONTRACT_TO_DISK", "").strip() in ("1", "true", "yes"):
        legacy_write_stage4_contract_json(data_dir, str(case_id), session)
