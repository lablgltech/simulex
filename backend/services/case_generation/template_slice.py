"""Срезы структурного шаблона кейса для промптов."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict, List

from config import DATA_DIR
from services.case_service import get_case


def load_structural_template(template_case_id: str) -> Dict[str, Any]:
    data_dir = Path(DATA_DIR)
    case = get_case(data_dir, template_case_id)
    if not case or not case.get("stages"):
        raise ValueError(f"Кейс-шаблон не найден или пуст: {template_case_id}")
    return case


def structural_summary_for_prompt(template: Dict[str, Any]) -> str:
    lines: List[str] = []
    for s in template.get("stages") or []:
        lines.append(f"- {s.get('id')}: type={s.get('type')}, title={s.get('title')}")
    return "\n".join(lines) if lines else "(нет этапов)"


def slice_stage_json(template: Dict[str, Any], stage_id: str, max_chars: int = 28000) -> str:
    stages = template.get("stages") or []
    for st in stages:
        if st.get("id") == stage_id:
            slim = _slim_stage_for_prompt(copy.deepcopy(st))
            raw = json.dumps(slim, ensure_ascii=False, indent=2)
            if len(raw) > max_chars:
                return raw[:max_chars] + "\n... [truncated]"
            return raw
    return "{}"


def _slim_stage_for_prompt(stage: Any) -> Any:
    """Укоротить длинные строки в образце, оставив структуру."""
    if isinstance(stage, dict):
        out: Dict[str, Any] = {}
        for k, v in stage.items():
            if k == "legend" and isinstance(v, str) and len(v) > 800:
                out[k] = v[:800] + "…"
            else:
                out[k] = _slim_stage_for_prompt(v)
        return out
    if isinstance(stage, list):
        return [_slim_stage_for_prompt(x) for x in stage[:120]]
    if isinstance(stage, str) and len(stage) > 1200:
        return stage[:1200] + "…"
    return stage


def template_stage_ids(template: Dict[str, Any]) -> List[str]:
    return [s.get("id") for s in (template.get("stages") or []) if s.get("id")]
