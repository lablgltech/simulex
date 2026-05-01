"""Сборка questionnaire_profile из истории вопросов и ответов."""

from __future__ import annotations

import copy
from typing import Any, Dict, List

from services.case_generation.session_store import CaseGenSession


def build_questionnaire_profile(session: CaseGenSession) -> Dict[str, Any]:
    """Плоский профиль для synthesis и этапов."""
    items: List[Dict[str, Any]] = []

    for pack in session.questions_history:
        questions = pack.get("questions") or []
        for q in questions:
            if not isinstance(q, dict) or "id" not in q:
                continue
            qid = q["id"]
            ans = session.answers.get(qid)
            if not ans:
                continue
            selected_vals = ans.get("selected") or []
            labels: List[str] = []
            for opt in q.get("options") or []:
                if isinstance(opt, dict) and opt.get("value") in selected_vals:
                    labels.append(str(opt.get("label") or opt.get("value")))
            items.append(
                {
                    "id": qid,
                    "prompt": q.get("prompt"),
                    "selected_values": selected_vals,
                    "selected_labels": labels,
                    "details": ans.get("details") or "",
                }
            )

    return {
        "items": items,
        "rounds_completed": session.questionnaire_round,
        "plain_text": _profile_as_text(items),
    }


def _profile_as_text(items: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for it in items:
        lines.append(f"Вопрос: {it.get('prompt')}")
        lines.append(f"  Выбор: {', '.join(it.get('selected_labels') or [])}")
        if it.get("details"):
            lines.append(f"  Уточнение: {it['details']}")
        lines.append("")
    return "\n".join(lines).strip()


def snapshot_questions_pack(session: CaseGenSession) -> Dict[str, Any]:
    """Сохранить текущий пакет вопросов в историю (копия)."""
    return {
        "round": session.questionnaire_round,
        "questions": copy.deepcopy(session.current_questions),
    }
