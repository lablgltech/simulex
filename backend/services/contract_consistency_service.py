"""
Сравнение текста договора: stage-2/contract.json vs stage-3/*.md (как на этапе 3).
Для админки (superuser): отчёт о расхождениях по номерам пунктов.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

                                                                 
CLAUSE_START_RE = re.compile(r"^(\d+\.\d+\.?|\d+\.\d+\.\d+\.?)\s")
SECTION_HEADER_RE = re.compile(r"^\d+\.\s+\S")


def _case_slug(case_id: str) -> str:
    return str(case_id or "").replace("case-", "").strip()


def _norm_ws(s: str) -> str:
    if not s:
        return ""
    t = s.replace("\r\n", "\n").strip()
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def _strip_stage2_headers(text: str) -> str:
    """Убрать ведущие markdown-заголовки разделов ## N. … из текста пункта stage-2."""
    if not text:
        return ""
    t = text.strip()
    while True:
        new = re.sub(r"^##\s*\d+(?:\.\d+)*\.?\s*[^\n]+\s*\n+", "", t, count=1)
        if new == t:
            break
        t = new
    return t.strip()


def _strip_leading_clause_num(first_line: str, num: str) -> str:
    """Снять с первой строки префикс номера пункта (1.4.1.)."""
    nr = num.rstrip(".")
    line = first_line.strip()
    m = re.match(rf"^{re.escape(nr)}\.\s*(.*)$", line)
    if m:
        return m.group(1).strip()
    m2 = re.match(rf"^{re.escape(nr)}\s+(.+)$", line)
    if m2:
        return m2.group(1).strip()
    return line


def _clause_sort_key(num: str) -> Tuple[int, ...]:
    parts = num.split(".")
    out: List[int] = []
    for p in parts:
        if p.isdigit():
            out.append(int(p))
        else:
            return (9999,)
    return tuple(out)


def parse_contract_md_clauses(md_content: str) -> Tuple[Dict[str, str], List[str]]:
    """
    Извлечь из Markdown карту номер_пункта -> нормализованное тело (как на этапе 3).
    Повторяющиеся номера (два «4.2.») объединяются; в warnings — предупреждение.
    """
    warnings: List[str] = []
    buckets: Dict[str, List[str]] = {}
    lines = md_content.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        m = CLAUSE_START_RE.match(stripped)
        if not m:
            i += 1
            continue
        num = m.group(1).rstrip(".")
        block_lines = [line]
        j = i + 1
        while j < len(lines):
            next_line = lines[j]
            next_stripped = next_line.strip()
            if (
                CLAUSE_START_RE.match(next_stripped)
                or next_stripped.startswith("###")
                or SECTION_HEADER_RE.match(next_stripped)
            ):
                break
            block_lines.append(next_line)
            j += 1
        i = j
        block_text = "\n".join(block_lines).strip()
        blines = block_text.split("\n")
        body_first = _strip_leading_clause_num(blines[0], num) if blines else ""
        rest = "\n".join([body_first] + blines[1:]).strip() if blines else ""
        if num in buckets:
            warnings.append(
                f'В Contract_PO.md повторяется номер пункта «{num}»: блоки склеены для сравнения.'
            )
            buckets[num].append(rest)
        else:
            buckets[num] = [rest]
    flat: Dict[str, str] = {}
    for num, parts in buckets.items():
        merged = _norm_ws(" ".join(_norm_ws(p) for p in parts if p))
        flat[num] = merged
    return flat, warnings


def load_stage2_clause_map(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    clauses = data.get("clauses") or []
    out: Dict[str, str] = {}
    for c in clauses:
        cid = str(c.get("id") or "").strip()
        if not cid:
            continue
        raw = c.get("text") or ""
        body = _strip_stage2_headers(str(raw))
        out[cid] = _norm_ws(body)
    return out


def resolve_contract_md_path(case_dir: Path) -> Tuple[Optional[Path], List[str]]:
    """Contract_PO.md или dogovor_PO.md в stage-3."""
    stage3 = case_dir / "stage-3"
    tried: List[str] = []
    for name in ("Contract_PO.md", "dogovor_PO.md"):
        p = stage3 / name
        tried.append(str(p))
        if p.exists():
            return p, tried
    return None, tried


def compare_stage2_vs_stage3_md(data_dir: Path, case_id: str) -> Dict[str, Any]:
    """
    Сравнить stage-2/contract.json и договор Markdown этапа 3.

    Возвращает dict с полями: ok, case_id, paths, warnings, only_in_stage2_contract_json,
    only_in_contract_md, mismatches, compared_clause_count.
    """
    slug = _case_slug(case_id)
    if not slug:
        return {
            "ok": False,
            "error": "Пустой case_id",
            "case_id": case_id,
        }
    case_dir = data_dir / "cases" / f"case-{slug}"
    jpath = case_dir / "stage-2" / "contract.json"
    md_path, tried_md = resolve_contract_md_path(case_dir)

    if not jpath.exists():
        return {
            "ok": False,
            "error": f"Нет файла stage-2/contract.json: {jpath}",
            "case_id": f"case-{slug}",
            "paths": {"stage2_contract_json": str(jpath), "contract_md_attempts": tried_md},
        }
    if md_path is None:
        return {
            "ok": False,
            "error": "Не найден Contract_PO.md или dogovor_PO.md в stage-3/",
            "case_id": f"case-{slug}",
            "paths": {"stage2_contract_json": str(jpath), "contract_md_attempts": tried_md},
        }

    json_map = load_stage2_clause_map(jpath)
    with open(md_path, "r", encoding="utf-8") as f:
        md_raw = f.read()
    md_map, md_warnings = parse_contract_md_clauses(md_raw)

    only_j = sorted(set(json_map) - set(md_map), key=_clause_sort_key)
    only_m = sorted(set(md_map) - set(json_map), key=_clause_sort_key)
    common = set(json_map) & set(md_map)

    mismatches: List[Dict[str, Any]] = []
    for num in sorted(common, key=_clause_sort_key):
        a, b = json_map[num], md_map[num]
        if a != b:
            mismatches.append(
                {
                    "clause_id": num,
                    "stage2_text_normalized": a,
                    "contract_md_text_normalized": b,
                    "hint": _mismatch_hint(a, b),
                }
            )

    ok = not only_j and not only_m and not mismatches

    return {
        "ok": ok,
        "case_id": f"case-{slug}",
        "paths": {
            "stage2_contract_json": str(jpath),
            "contract_md": str(md_path),
        },
        "warnings": md_warnings,
        "only_in_stage2_contract_json": only_j,
        "only_in_contract_md": only_m,
        "mismatches": mismatches,
        "compared_clause_count": len(common),
    }


def _mismatch_hint(a: str, b: str) -> str:
    if len(a) > 80 or len(b) > 80:
        return "Тексты после нормализации пробелов и снятия префикса номера / заголовков ## различаются (см. поля normalized)."
    return f"Этап 2: «{a}» | MD: «{b}»"
