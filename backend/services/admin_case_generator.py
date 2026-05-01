"""
Устаревший одношаговый генератор черновика кейса по образцу с документами KB.

Для нового потока (договор + гайд + анкета + LangGraph) используйте API
POST /api/admin/case-gen/start и связанные эндпоинты.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import DATA_DIR, KB_DIR
from services.ai_chat_service import call_openai
from services.ai_model_config import get_model_for_consumer
from services.case_service import get_case
from services.ai_payload import MINIMAL_SYSTEM_MESSAGE, compact_user_payload


def _describe_stage_structure(stage: Dict[str, Any]) -> str:
    """Краткое описание структуры этапа для промпта."""
    sid = stage.get("id") or ""
    stype = stage.get("type") or ""
    parts = [f"{sid} (type={stype})"]
    if sid == "stage-1":
        parts.append("поля: documents[], attributes[], time_budget, actions (open_document, ask_question)")
    elif sid == "stage-2":
        parts.append("поля: actions; ресурсы в папке stage-2: contract.json, risk_matrix.json, game_config.json")
    elif sid == "stage-3":
        parts.append("поля: actions, resources.contract_md, gameData_json, ai_negotiation_system_prompt_md; в кейсе contract (code, md_path, gamedata_path)")
    elif sid == "stage-4":
        parts.append("поля: actions; в кейсе crisis.check_after, crisis.conditions")
    return " — ".join(parts)


def _build_structure_hint(template: Dict[str, Any]) -> str:
    """Описание структуры кейса по этапам образца."""
    stages = template.get("stages") or []
    lines = ["Структура этапов (сохраняй в черновике):"]
    for s in stages:
        lines.append("  " + _describe_stage_structure(s))
    lines.append("Общие поля кейса: id, title, description, status, version, lexic_initial, intro, outro, stages, contract (если есть), crisis (если есть).")
    return "\n".join(lines)


def _read_kb_file(path: str) -> str:
    """Прочитать содержимое файла из KB по относительному пути."""
    root = Path(KB_DIR).resolve()
    full = (root / path).resolve()
    try:
        full.relative_to(root)
    except ValueError:
        return ""
    if not full.exists():
        return ""
    try:
        return full.read_text(encoding="utf-8")
    except Exception:
        return ""


def _extract_json_from_response(text: str) -> Optional[Dict[str, Any]]:
    """Извлечь JSON из ответа (возможно внутри ```json ... ```)."""
    text = (text or "").strip()
               
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass
                                   
    start = text.find("{")
    if start < 0:
        return None
    end = text.rfind("}") + 1
    if end <= start:
        return None
    try:
        return json.loads(text[start:end])
    except json.JSONDecodeError:
        return None


def _validate_draft(draft: Dict[str, Any]) -> List[str]:
    """Минимальная валидация черновика. Возвращает список предупреждений."""
    warnings = []
    if not draft.get("id"):
        warnings.append("Нет id кейса")
    if not draft.get("title"):
        warnings.append("Нет title")
    if not isinstance(draft.get("stages"), list):
        warnings.append("stages должен быть массивом")
    else:
        for i, s in enumerate(draft["stages"]):
            if not s.get("id"):
                warnings.append(f"Этап {i + 1}: нет id")
            if not s.get("type"):
                warnings.append(f"Этап {i + 1}: нет type")
    return warnings


def generate_case_draft(
    template_case_id: str,
    prompt: str,
    kb_doc_paths: Optional[List[str]] = None,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Сгенерировать черновик кейса по образцу с RAG и опционально выбранными документами KB.

    Возвращает { "draft": {...}, "warnings": [...] } или бросает исключение.
    """
    options = options or {}
    data_dir = Path(DATA_DIR)

                               
    template = get_case(data_dir, template_case_id)
    raw = str(template_case_id or "").strip().replace("case-", "")
    want = "case-001" if raw in ("001", "") else (template_case_id if str(template_case_id or "").startswith("case-") else f"case-{template_case_id}")
    if not template or (template.get("id") or "").strip() != want:
        raise ValueError(f"Кейс-образец не найден: {template_case_id}")

                                            
    extra_parts = []
    for p in kb_doc_paths or []:
        if not p or ".." in p:
            continue
        content = _read_kb_file(p.strip())
        if content:
            extra_parts.append(f"[Документ {p}]\n{content[:8000]}")

    extra_text = "\n\n".join(extra_parts) if extra_parts else ""

                                     
    structure_hint = _build_structure_hint(template)

                                                                                             
    template_summary = {
        "id": template.get("id"),
        "title": template.get("title"),
        "stages": [
            {"id": s.get("id"), "order": s.get("order"), "type": s.get("type"), "title": s.get("title")}
            for s in (template.get("stages") or [])
        ],
        "contract": template.get("contract"),
        "crisis": template.get("crisis"),
    }

    system_prompt = MINIMAL_SYSTEM_MESSAGE

    user_content = compact_user_payload(
        {
            "kind": "admin_generate_case_draft",
            "template_summary": template_summary,
            "kb_excerpts": extra_text[:12000] if extra_text else None,
            "methodologist_prompt": (prompt or "").strip() or None,
            "structure_hint": structure_hint,
        }
    )

    payload = {
        "model": options.get("model") or get_model_for_consumer("stage1"),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": float(options.get("temperature", 0.3)),
        "max_tokens": int(options.get("max_tokens", 4000)),
    }

    content = call_openai(payload)
    draft = _extract_json_from_response(content)
    if not draft:
        raise RuntimeError("Не удалось извлечь JSON из ответа модели")

                                                       
    if not draft.get("id"):
        draft["id"] = "case-draft"
    if not draft.get("title"):
        draft["title"] = "Черновик кейса"
    if "status" not in draft:
        draft["status"] = "draft"
    if "version" not in draft:
        draft["version"] = 1
    if "intro" not in draft:
        draft["intro"] = ""
    if "outro" not in draft:
        draft["outro"] = ""

    warnings = _validate_draft(draft)
    return {"draft": draft, "warnings": warnings}
