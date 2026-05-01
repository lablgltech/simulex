"""
Document service для этапа 3 (переговоры).

Переносит ключевые идеи из ex/v0.5beta/modules/document/document_service.py,
но использует PostgreSQL (таблица contract + negotiation_session.history_json)
и файловые gameData/markdown.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional, Set

from db import get_connection
from config import BASE_DIR
from services.ai_counterpart_rules import build_negotiation_vocative_forbidden_names
from services.negotiation_session_service import (
    get_negotiation_history,
    save_negotiation_history,
)


                                                          
                                                                                   
                                       
ClauseStatus: Dict[str, int] = {
    "NOT_EDITABLE": 1,
    "AVAILABLE": 2,
    "SELECTED": 3,
    "NO_EDITS": 4,
    "ACCEPTED_BOT": 5,
    "CHANGED": 6,
    "NOT_AGREED_ESCALATION": 7,
                                                                                                               
    "KEPT_COUNTERPARTY": 8,
                                                                                   
    "EXCLUDED": 9,
}


def _load_contract_row(contract_id: int) -> Dict[str, Any]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, code, description, link_md, link_gamedata_json, game_data_json
                FROM contract
                WHERE id = %s
                """,
                (contract_id,),
            )
            row = cur.fetchone()

    if not row:
        raise RuntimeError(f"contract id={contract_id} не найден")

    return {
        "id": row[0],
        "code": row[1],
        "description": row[2],
        "link_md": row[3],
        "link_gamedata_json": row[4],
        "game_data_json": row[5],
    }


def _load_game_data(contract_row: Dict[str, Any]) -> Dict[str, Any]:
    """
    Загрузить gameData для договора:
    - сначала пытаемся взять из game_data_json (jsonb),
    - затем — из файла по link_gamedata_json.

    Источник правды — БД; драйвер иногда отдаёт jsonb строкой/bytes — нормализуем в dict.
    """
    game_data = contract_row.get("game_data_json")
    if isinstance(game_data, str):
        try:
            game_data = json.loads(game_data)
        except json.JSONDecodeError:
            game_data = None
    elif isinstance(game_data, (bytes, bytearray)):
        try:
            game_data = json.loads(game_data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            game_data = None
    if isinstance(game_data, dict) and game_data.get("clauses"):
        return game_data

    link = contract_row.get("link_gamedata_json")
    if not link:
        raise RuntimeError("У договора не задан link_gamedata_json и отсутствует game_data_json")

    json_path = (BASE_DIR / link).resolve()
    if not json_path.exists():
        raise RuntimeError(f"Файл gameData не найден: {json_path}")

    with open(json_path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_bot_messages_for_session(negotiation_session_id: int) -> Dict[str, Any]:
    """
    Получить настраиваемые сообщения бота для сессии переговоров.
    Читаются из gameData договора (поле bot_messages). Если нет — возвращается пустой словарь,
    код использует встроенные значения по умолчанию.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT contract_id FROM negotiation_session WHERE id = %s",
                (negotiation_session_id,),
            )
            row = cur.fetchone()
    if not row:
        return {}
    contract_row = _load_contract_row(row[0])
    game_data = _load_game_data(contract_row)
    bm = dict(game_data.get("bot_messages") or {})
    persona = game_data.get("counterpart_persona")
    if isinstance(persona, str) and persona.strip():
        bm["_counterpart_persona"] = persona.strip()
    cust_fio = game_data.get("customer_representative_fio")
    _vfn = build_negotiation_vocative_forbidden_names(
        counterpart_persona=persona.strip() if isinstance(persona, str) and persona.strip() else None,
        customer_representative_fio=cust_fio.strip()
        if isinstance(cust_fio, str) and cust_fio.strip()
        else None,
    )
    if _vfn:
        bm["_negotiation_vocative_forbidden_names"] = _vfn
    return bm


def get_contract_code_for_session(negotiation_session_id: int) -> str:
    """
    Получить код договора (например, dogovor_PO) для negotiation_session.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.code FROM contract c
                JOIN negotiation_session ns ON ns.contract_id = c.id
                WHERE ns.id = %s
                """,
                (negotiation_session_id,),
            )
            row = cur.fetchone()
    if not row:
        raise RuntimeError(f"negotiation_session {negotiation_session_id} не найдена")
    return row[0] or "dogovor_PO"


def _load_full_contract_md(contract_row: Dict[str, Any]) -> str:
    """Загрузить полный текст договора из link_md."""
    link = contract_row.get("link_md")
    if link:
        md_path = (BASE_DIR / link).resolve()
        if md_path.exists():
            with open(md_path, "r", encoding="utf-8") as f:
                return f.read()
                                                                                                       
    gd = contract_row.get("link_gamedata_json")
    if gd:
        parent = (BASE_DIR / gd).resolve().parent
        for name in ("Contract_PO.md", "dogovor_PO.md"):
            alt = parent / name
            if alt.exists():
                with open(alt, "r", encoding="utf-8") as f:
                    return f.read()
    return ""


def get_contract_md_resolution_debug(contract_code: str = "dogovor_PO") -> Dict[str, Any]:
    """
    Диагностика: какой файл .md реально открывает бэкенд для договора и какая строка с 1.1.1 в нём.
    Снимает расхождение «я смотрю case-001 в репо» vs «процесс uvicorn читает другой путь».
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, link_md, link_gamedata_json
                FROM contract
                WHERE code = %s
                """,
                (contract_code,),
            )
            row = cur.fetchone()
    if not row:
        return {"error": f"В таблице contract нет записи с code={contract_code!r}"}
    contract_id, link_md, link_gd = row[0], row[1], row[2]
    contract_row = _load_contract_row(contract_id)

    primary_abs: Optional[str] = None
    primary_exists = False
    if link_md:
        p = (BASE_DIR / link_md).resolve()
        primary_abs = str(p)
        primary_exists = p.is_file()

    fallback_abs: Optional[str] = None
    if link_gd:
        parent = (BASE_DIR / link_gd).resolve().parent
        for name in ("Contract_PO.md", "dogovor_PO.md"):
            alt = parent / name
            if alt.is_file():
                fallback_abs = str(alt.resolve())
                break

    md_text = _load_full_contract_md(contract_row)
    line_111: Optional[str] = None
    for ln in md_text.splitlines():
        st = ln.strip()
        if st.startswith("1.1.1") or st.startswith("1.1.1."):
            line_111 = st
            break

    source = "link_md" if primary_exists else ("fallback_next_to_gamedata" if fallback_abs and md_text else "empty")

    return {
        "base_dir": str(BASE_DIR.resolve()),
        "contract_code": contract_code,
        "db_link_md": link_md,
        "db_link_gamedata_json": link_gd,
        "primary_absolute": primary_abs,
        "primary_exists": primary_exists,
        "fallback_contract_md_absolute": fallback_abs,
        "resolution_source": source,
        "md_bytes": len(md_text.encode("utf-8")),
        "line_1_1_1": line_111,
    }


def _norm_clause_num(s: str) -> str:
    return (s or "").strip().rstrip(".")


def _parse_num_tuple(s: str) -> Tuple[int, ...]:
    n = _norm_clause_num(s)
    if not n:
        return tuple()
    parts = n.split(".")
    out: List[int] = []
    for p in parts:
        if p.isdigit():
            out.append(int(p))
        else:
            return tuple()
    return tuple(out)


def _parent_prefix(num_str: str) -> str:
    t = _parse_num_tuple(num_str)
    if len(t) < 2:
        return ""
    return ".".join(str(x) for x in t[:-1])


def _compose_sibling_display(parent_prefix: str, ordinal: int) -> str:
    if not parent_prefix:
        return str(ordinal)
    return f"{parent_prefix}.{ordinal}"


def _excluded_canonical_numbers(excluded_clause_ids: Set[str], game_data: Dict[str, Any]) -> Set[str]:
    """Номера исключённых пунктов (по id из gameData или явному номеру)."""
    out: Set[str] = set()
    if not excluded_clause_ids:
        return out
    clauses = game_data.get("clauses") or []
    for raw in excluded_clause_ids:
        s = str(raw).strip()
        if not s:
            continue
        matched_num: Optional[str] = None
        for c in clauses:
            cid = str(c.get("id") or "")
            cnum = str(c.get("number") or "")
            if s == cid or s == cnum:
                matched_num = cnum or None
                break
        if matched_num:
            out.add(_norm_clause_num(matched_num))
        elif _parse_num_tuple(s):
            out.add(_norm_clause_num(s))
    return out


def _clause_already_in_api_list(
    clauses: List[Dict[str, Any]], clause_id: str, number: str
) -> bool:
    """Пункт уже есть в clauses (по id или номеру из gameData)."""
    cid = str(clause_id or "").strip()
    num = str(number or "").strip()
    for x in clauses:
        xid = str(x.get("id") or "").strip()
        xnum = str(x.get("number") or "").strip()
        if cid and (xid == cid or xnum == cid):
            return True
        if num and (xid == num or xnum == num):
            return True
    return False


def _append_excluded_clauses_for_progress_tracking(
    clauses: List[Dict[str, Any]],
    game_data: Dict[str, Any],
    clause_status: Dict[str, Any],
    excluded_clause_ids: Set[str],
) -> None:
    """
    Исключённые переговорные пункты не попадают в items (текст договора), но должны оставаться
    в списке clauses для UI: иначе прогресс «N из M» занижается и победа по исключению не считается.
    """
    _excl = {str(x).strip() for x in excluded_clause_ids if x is not None and str(x).strip()}
    for clause in game_data.get("clauses") or []:
        cid = str(clause.get("id") or clause.get("number") or "").strip()
        num = str(clause.get("number") or "").strip()
        if not cid and not num:
            continue
        st_raw = None
        if cid:
            st_raw = clause_status.get(cid)
        if st_raw is None and num:
            st_raw = clause_status.get(num)
        try:
            st = int(st_raw) if st_raw is not None else None
        except (TypeError, ValueError):
            st = None
        in_set = bool(cid and cid in _excl) or bool(num and num in _excl)
        if not in_set and st != ClauseStatus["EXCLUDED"]:
            continue
        if _clause_already_in_api_list(clauses, cid, num):
            continue
        clause_id_val = clause.get("id") or clause.get("number")
        result = dict(clause)
        result["type"] = "clause"
        result["id"] = clause_id_val
        result["number"] = num or cid
        result["status"] = ClauseStatus["EXCLUDED"]
        result["replacementText"] = None
        result["counterpartObjection"] = (
            clause.get("comment")
            or clause.get("counterpartObjection")
            or clause.get("guide_summary")
            or ""
        )
        result["botSuggested"] = clause.get("botSuggested") or clause.get("botSuggestedText") or ""
        result["text"] = clause.get("text") or clause.get("contract_text") or ""
        result["displayNumber"] = result.get("number")
        clauses.append(result)


def _apply_clause_display_renumbering(
    items: List[Dict[str, Any]],
    excluded_clause_ids: Optional[Set[str]],
    game_data: Dict[str, Any],
) -> None:
    """
    После исключения пунктов задаёт displayNumber: следующие пункты в той же группе
    (общий родительский префикс) получают сквозную нумерацию (например 9.3 → 9.2).
    """
    _excl = {str(x) for x in (excluded_clause_ids or set()) if x is not None}
    excluded_nums = _excluded_canonical_numbers(_excl, game_data)

    groups: Dict[str, Set[str]] = {}

    def add_num(n: str) -> None:
        nn = _norm_clause_num(n)
        if not nn or not _parse_num_tuple(nn):
            return
        pp = _parent_prefix(nn)
        groups.setdefault(pp, set()).add(nn)

    for it in items:
        if it.get("type") not in ("clause", "clause_readonly"):
            continue
        n = it.get("number")
        if n:
            add_num(str(n))

    for en in excluded_nums:
        add_num(en)

    display_map: Dict[str, str] = {}
    for pp, nums in groups.items():
        ordered = sorted(nums, key=lambda s: _parse_num_tuple(s))
        surviving = [n for n in ordered if n not in excluded_nums]
        for i, orig in enumerate(surviving):
            display_map[orig] = _compose_sibling_display(pp, i + 1)

    for it in items:
        if it.get("type") not in ("clause", "clause_readonly"):
            continue
        n = it.get("number")
        if not n:
            continue
        nn = _norm_clause_num(str(n))
        it["displayNumber"] = display_map.get(nn, nn)


def _build_full_contract_items(
    md_content: str,
    game_data: Dict[str, Any],
    clause_status: Dict[str, int],
    clause_replacements: Dict[str, str],
    excluded_clause_ids: Optional[set[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Собрать список элементов договора: текстовые блоки (read-only) и интерактивные пункты.
    Все пункты (N.N. или N.N.N.) отображаются в блоках.
    Интерактивны только пункты из gameData.clauses (например, 10.2).
    """
    clauses_data = game_data.get("clauses", [])
    _excl: Set[str] = set(excluded_clause_ids) if excluded_clause_ids else set()
                                                                                                         
    clause_ids = set()
    for c in clauses_data:
        if c.get("number"):
            clause_ids.add(str(c.get("number")))
        if c.get("id"):
            clause_ids.add(str(c.get("id")))

    lines = md_content.split("\n")
    items: List[Dict[str, Any]] = []
    i = 0

                                                                                    
                                                                                                                                       
    clause_start_re = re.compile(r"^(\d+\.\d+\.?|\d+\.\d+\.\d+\.?)(\s|$)")
                                                                                                               
    section_header_re = re.compile(r"^\d+\.\s+\S")

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        m = clause_start_re.match(stripped)
        
        if m:
                                   
            num = m.group(1).rstrip(".")
                                                                            
            block_lines = [line]
            j = i + 1
            while j < len(lines):
                next_line = lines[j]
                next_stripped = next_line.strip()
                                                                                            
                if (
                    clause_start_re.match(next_stripped)
                    or next_stripped.startswith("###")
                    or section_header_re.match(next_stripped)
                ):
                    break
                block_lines.append(next_line)
                j += 1
            i = j
            
            block_text = "\n".join(block_lines).strip()
            
                                                   
            if num in clause_ids:
                clause = next(
                    (c for c in clauses_data if str(c.get("number")) == num or str(c.get("id")) == num),
                    None,
                )
                if clause:
                    key = str(clause.get("id") or clause.get("number"))
                    default_status = clause.get("defaultStatus") or clause.get("status") or ClauseStatus["AVAILABLE"]
                    status = clause_status.get(key) or clause_status.get(num) or default_status
                    try:
                        st = int(status)
                    except (TypeError, ValueError):
                        st = int(default_status) if isinstance(default_status, (int, float)) else ClauseStatus["AVAILABLE"]
                    if st == ClauseStatus["EXCLUDED"] or key in _excl or str(num) in _excl:
                        continue
                    replacement_text = clause_replacements.get(key) or clause_replacements.get(num)
                    result = dict(clause)
                    result["type"] = "clause"
                    result["id"] = clause.get("id") or clause.get("number")
                    result["number"] = num
                    result["status"] = status
                    result["replacementText"] = replacement_text
                    result["counterpartObjection"] = clause.get("comment") or clause.get("counterpartObjection") or clause.get("guide_summary") or ""
                    result["botSuggested"] = clause.get("botSuggested") or clause.get("botSuggestedText") or ""
                    result["text"] = clause.get("text") or clause.get("contract_text") or block_text
                    items.append(result)
                    continue
            
                                                                    
                                                                                          
                                                         
            items.append({
                "type": "clause_readonly",
                "id": f"clause-readonly-{len(items)}-{num}",
                "number": num,
                "text": block_text,
                "status": ClauseStatus["NOT_EDITABLE"]
            })
            continue
            
                                                     
        text_lines = []
        while i < len(lines):
            line = lines[i]
            stripped = line.strip()
            if clause_start_re.match(stripped):
                break
            text_lines.append(line)
            i += 1
        if text_lines:
            text = "\n".join(text_lines).strip()
            if text:
                items.append({"type": "text", "id": f"text-{len(items)}", "text": text, "status": ClauseStatus["NOT_EDITABLE"]})

    out = items if items else [{"type": "text", "id": "text-full", "text": md_content, "status": ClauseStatus["NOT_EDITABLE"]}]
    return out


def get_contract_clauses_for_session(negotiation_session_id: int) -> Dict[str, Any]:
    """
    Получить список пунктов договора для negotiation_session:
    - читает contract_id из negotiation_session;
    - загружает gameData договора;
    - при наличии link_md — загружает полный текст и строит items (текст + интерактивные пункты);
    - иначе — только clauses из gameData;
    - накладывает статусы и replacementText из history_json.
    """
                           
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT contract_id FROM negotiation_session WHERE id = %s",
                (negotiation_session_id,),
            )
            row = cur.fetchone()
    if not row:
        raise RuntimeError(f"negotiation_session {negotiation_session_id} не найдена")
    contract_id = row[0]

                                     
    contract_row = _load_contract_row(contract_id)
    game_data = _load_game_data(contract_row)

                                         
    history = get_negotiation_history(negotiation_session_id)
    clause_status = history.get("clause_status", {})
    clause_replacements = history.get("clause_replacements", {})
    _raw_excl = history.get("excluded_clause_ids") or []
    excluded_clause_ids = {str(x) for x in _raw_excl if x is not None}

    md_content = _load_full_contract_md(contract_row)
    if md_content:
        items = _build_full_contract_items(
            md_content, game_data, clause_status, clause_replacements, excluded_clause_ids
        )
        clauses = [it for it in items if it.get("type") == "clause"]
    else:
        clauses = []
        for clause in game_data.get("clauses", []):
            clause_id = clause.get("id") or clause.get("number")
            key = str(clause_id)
            num = str(clause.get("number") or "")
            default_status = clause.get("defaultStatus") or clause.get("status") or ClauseStatus["AVAILABLE"]
            status = clause_status.get(key) or clause_status.get(num) or default_status
            try:
                st = int(status)
            except (TypeError, ValueError):
                st = int(default_status) if isinstance(default_status, (int, float)) else ClauseStatus["AVAILABLE"]
            if (
                st == ClauseStatus["EXCLUDED"]
                or key in excluded_clause_ids
                or (num and num in excluded_clause_ids)
            ):
                continue
            replacement_text = clause_replacements.get(key) or clause_replacements.get(num)
            result = dict(clause)
            result["type"] = "clause"
            result["id"] = clause_id
            result["status"] = status
            result["replacementText"] = replacement_text
            result["counterpartObjection"] = clause.get("comment") or clause.get("counterpartObjection") or clause.get("guide_summary") or ""
            result["botSuggested"] = clause.get("botSuggested") or clause.get("botSuggestedText") or ""
            result["text"] = clause.get("text") or clause.get("contract_text") or ""
            clauses.append(result)
        items = clauses

    _apply_clause_display_renumbering(items, excluded_clause_ids, game_data)
    _append_excluded_clauses_for_progress_tracking(
        clauses, game_data, clause_status, excluded_clause_ids
    )

    return {
        "contract": {
            "id": contract_row["id"],
            "code": contract_row["code"],
            "description": contract_row["description"],
        },
        "clauses": clauses,
        "items": items,
    }


def update_clause_status_for_session(
    negotiation_session_id: int,
    clause_id: str,
    new_status: int,
    replacement_text: str | None = None,
) -> None:
    """
    Обновить статус пункта договора в history_json negotiation_session.

    Минимальная версия:
    - не проверяет все возможные переходы (VALID_TRANSITIONS),
      но корректно записывает clause_status и clause_replacements.
    """
    history = get_negotiation_history(negotiation_session_id)
    clause_status = history.get("clause_status") or {}
    clause_status[str(clause_id)] = int(new_status)
    history["clause_status"] = clause_status

    if replacement_text:
        repl = history.get("clause_replacements") or {}
        repl[str(clause_id)] = replacement_text
        history["clause_replacements"] = repl

    save_negotiation_history(negotiation_session_id, history)


