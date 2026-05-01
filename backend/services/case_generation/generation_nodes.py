"""Узлы графа генерации кейса (LLM + детерминированная сборка)."""

from __future__ import annotations

import copy
import json
import logging
from typing import Any, Dict, List

from langchain_core.messages import HumanMessage, SystemMessage

from services.case_generation.json_utils import assistant_plain_text_for_json, extract_json_object
from services.case_generation.model_client import get_case_generation_llm
from services.case_generation.prompts import (
    MERGE_TITLES_SYSTEM,
    PLANNER_SYSTEM,
    REPAIR_SYSTEM,
    STAGE_AGENT_SYSTEM,
    SYNTHESIS_SYSTEM,
)
from services.case_generation.template_slice import slice_stage_json, template_stage_ids

logger = logging.getLogger(__name__)


def node_synthesis(state: Dict[str, Any]) -> Dict[str, Any]:
    w = list(state.get("warnings") or [])
    tr = list(state.get("trace") or [])
    profile = state.get("questionnaire_profile") or {}
    profile_text = profile.get("plain_text") or json.dumps(profile, ensure_ascii=False)

    user = json.dumps(
        {
            "questionnaire_profile": profile_text,
            "contract_excerpt": (state.get("contract_template") or "")[:16000],
            "guide_excerpt": (state.get("guide") or "")[:12000],
            "guide_excerpt_meaning": (
                "внутренний документ компании стороны игрока о работе с договорами; не методичка и не инструкция игроку"
            ),
            "creator_intent": state.get("creator_intent") or "",
        },
        ensure_ascii=False,
        indent=2,
    )
    llm = get_case_generation_llm(max_tokens=4096)
    msg = llm.invoke([SystemMessage(content=SYNTHESIS_SYSTEM), HumanMessage(content=user)])
    raw = assistant_plain_text_for_json(msg)
    parsed = extract_json_object(raw) or {}
    if not parsed:
        w.append("synthesis: пустой бриф, используется заглушка")
        parsed = {
            "deal_summary": "",
            "parties": {},
            "subject_matter": "",
            "disputed_clauses": [],
            "risk_themes": [],
            "stage1_brief": "",
            "pedagogical_focus": "",
            "lexic_targets_note": "",
            "title_hint": "Черновик кейса",
            "description_hint": "",
        }
    tr.append("synthesis_brief")
    return {**state, "enriched_brief": parsed, "warnings": w, "trace": tr}


def node_planner(state: Dict[str, Any]) -> Dict[str, Any]:
    w = list(state.get("warnings") or [])
    tr = list(state.get("trace") or [])
    template = state.get("structural_template") or {}
    brief = state.get("enriched_brief") or {}
    hints = []
    for st in template.get("stages") or []:
        hints.append({"stage_id": st.get("id"), "type": st.get("type")})

    user = json.dumps({"enriched_brief": brief, "structural_hints": hints}, ensure_ascii=False, indent=2)
    llm = get_case_generation_llm(max_tokens=2048)
    msg = llm.invoke([SystemMessage(content=PLANNER_SYSTEM), HumanMessage(content=user)])
    parsed = extract_json_object(assistant_plain_text_for_json(msg)) or {}
    tr.append("planner")
    return {**state, "canonical_plan": parsed, "warnings": w, "trace": tr}


def node_stage_factory(stage_id: str):
    def _node(state: Dict[str, Any]) -> Dict[str, Any]:
        w = list(state.get("warnings") or [])
        tr = list(state.get("trace") or [])
        template = state.get("structural_template") or {}
        brief = state.get("enriched_brief") or {}
        plan = state.get("canonical_plan") or {}
        profile = state.get("questionnaire_profile") or {}
        profile_text = profile.get("plain_text") or ""

        slice_json = slice_stage_json(template, stage_id)
        user = json.dumps(
            {
                "stage_id": stage_id,
                "stage_template_json": slice_json,
                "enriched_brief": brief,
                "canonical_plan": plan,
                "questionnaire_profile_text": profile_text[:8000],
                "contract_excerpt": (state.get("contract_template") or "")[:12000],
                "guide_excerpt": (state.get("guide") or "")[:8000],
                "guide_excerpt_meaning": (
                    "гайд компании стороны игрока: внутренняя политика по договорам (не инструкция участнику)"
                ),
            },
            ensure_ascii=False,
            indent=2,
        )
        llm = get_case_generation_llm(max_tokens=8192, temperature=0.3)
        msg = llm.invoke([SystemMessage(content=STAGE_AGENT_SYSTEM), HumanMessage(content=user)])
        stage_obj = extract_json_object(assistant_plain_text_for_json(msg))
        drafts = dict(state.get("stage_drafts") or {})
        if isinstance(stage_obj, dict) and stage_obj.get("id") == stage_id:
            drafts[stage_id] = stage_obj
        else:
            w.append(f"stage {stage_id}: не удалось распарсить JSON, этап из шаблона сохранён")
            for st in template.get("stages") or []:
                if st.get("id") == stage_id:
                    drafts[stage_id] = copy.deepcopy(st)
                    break
        tr.append(f"stage_{stage_id}")
        return {**state, "stage_drafts": drafts, "warnings": w, "trace": tr}

    return _node


def node_merge(state: Dict[str, Any]) -> Dict[str, Any]:
    w = list(state.get("warnings") or [])
    tr = list(state.get("trace") or [])
    template = copy.deepcopy(state.get("structural_template") or {})
    drafts = state.get("stage_drafts") or {}
    brief = state.get("enriched_brief") or {}

    template["id"] = "case-draft"
    template["status"] = "draft"
    if brief.get("title_hint"):
        template["title"] = str(brief["title_hint"])[:500]
    if brief.get("description_hint"):
        template["description"] = str(brief["description_hint"])[:2000]

    new_stages: List[Dict[str, Any]] = []
    for st in template.get("stages") or []:
        sid = st.get("id")
        if sid and sid in drafts:
            new_stages.append(drafts[sid])
        else:
            new_stages.append(copy.deepcopy(st))
    template["stages"] = new_stages

                                                              
    if not template.get("title") or template["title"] == "Черновик кейса":
        try:
            llm = get_case_generation_llm(max_tokens=512, temperature=0.2)
            u = json.dumps({"brief": brief}, ensure_ascii=False)
            msg = llm.invoke([SystemMessage(content=MERGE_TITLES_SYSTEM), HumanMessage(content=u)])
            td = extract_json_object(assistant_plain_text_for_json(msg))
            if isinstance(td, dict):
                if td.get("title"):
                    template["title"] = str(td["title"])[:500]
                if td.get("description"):
                    template["description"] = str(td["description"])[:2000]
        except Exception as e:
            logger.warning("merge titles llm: %s", e)
            w.append("merge: не удалось сгенерировать заголовок через LLM")

    tr.append("merge")
    return {**state, "merged_case": template, "warnings": w, "trace": tr}


def node_validate(state: Dict[str, Any]) -> Dict[str, Any]:
    w = list(state.get("warnings") or [])
    tr = list(state.get("trace") or [])
    case = state.get("merged_case") or {}
    errors: List[str] = []

    if not case.get("title"):
        errors.append("Нет title")
    if not isinstance(case.get("stages"), list):
        errors.append("stages должен быть массивом")
    else:
        for i, s in enumerate(case["stages"]):
            if not isinstance(s, dict):
                errors.append(f"Этап {i}: не объект")
                continue
            if not s.get("id"):
                errors.append(f"Этап {i}: нет id")
            if not s.get("type"):
                errors.append(f"Этап {i}: нет type")
            actions = {a.get("id") for a in (s.get("actions") or []) if isinstance(a, dict)}
            for em in s.get("emails") or []:
                if not isinstance(em, dict):
                    continue
                if em.get("trigger") == "after_action" and em.get("action_id"):
                    if em["action_id"] not in actions:
                        errors.append(f"Письмо ссылается на неизвестное action_id: {em['action_id']}")

    tr.append("validate")
    return {**state, "validation_errors": errors, "warnings": w, "trace": tr}


def node_repair(state: Dict[str, Any]) -> Dict[str, Any]:
    w = list(state.get("warnings") or [])
    tr = list(state.get("trace") or [])
    rr = int(state.get("repair_round") or 0) + 1
    case = state.get("merged_case") or {}
    errs = state.get("validation_errors") or []

    payload = json.dumps({"case": case, "errors": errs}, ensure_ascii=False, indent=2)[:24000]
    llm = get_case_generation_llm(max_tokens=8192, temperature=0.2)
    msg = llm.invoke([SystemMessage(content=REPAIR_SYSTEM), HumanMessage(content=payload)])
    fixed = extract_json_object(assistant_plain_text_for_json(msg))
    if isinstance(fixed, dict) and fixed.get("stages"):
        tr.append(f"repair_{rr}")
        return {**state, "merged_case": fixed, "repair_round": rr, "warnings": w, "trace": tr}
    w.append("repair: модель не вернула валидный кейс")
    tr.append(f"repair_{rr}_failed")
    return {**state, "repair_round": rr, "warnings": w, "trace": tr}


def route_after_validate(state: Dict[str, Any]) -> str:
    errs = state.get("validation_errors") or []
    if not errs:
        return "end"
    if int(state.get("repair_round") or 0) >= int(state.get("max_repairs") or 3):
        return "end"
    return "repair"
