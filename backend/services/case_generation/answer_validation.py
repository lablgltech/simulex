"""Валидация ответов анкеты по схеме вопросов."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple


def validate_answers_for_questions(
    questions: List[Dict[str, Any]],
    answers: Dict[str, Any],
) -> Tuple[bool, List[str], Dict[str, Dict[str, Any]]]:
    """
    answers: question_id -> { "selected": [...], "details": str } или сырой dict.
    Возвращает (ok, errors, normalized_answers).
    """
    errors: List[str] = []
    normalized: Dict[str, Dict[str, Any]] = {}

    for q in questions:
        qid = q["id"]
        raw = answers.get(qid)
        if raw is None:
            if q.get("selection_required") or q.get("free_text_required"):
                errors.append(f"Отсутствует ответ: {qid}")
            continue

        if not isinstance(raw, dict):
            errors.append(f"Неверный формат ответа для {qid}")
            continue

        selected = raw.get("selected")
        details = raw.get("details", "")
        if not isinstance(selected, list):
            errors.append(f"{qid}: selected должен быть массивом")
            continue
        if not all(isinstance(x, str) for x in selected):
            errors.append(f"{qid}: selected должен содержать строки")
            continue

        opt_values = {o["value"] for o in (q.get("options") or []) if isinstance(o, dict) and "value" in o}
        for v in selected:
            if v not in opt_values:
                errors.append(f"{qid}: недопустимое значение выбора: {v}")

        if q.get("choice_mode") == "single" and q.get("selection_required"):
            if len(selected) != 1:
                errors.append(f"{qid}: для single требуется ровно один выбранный вариант")

        if q.get("choice_mode") == "multi" and q.get("selection_required"):
            if len(selected) < 1:
                errors.append(f"{qid}: выберите хотя бы один вариант")

        if len(selected) != len(set(selected)):
            errors.append(f"{qid}: дубликаты в selected")

        dstr = details if isinstance(details, str) else str(details or "")
        dstr = dstr.strip()
        if q.get("free_text_required") and not dstr:
            errors.append(f"{qid}: заполните текстовое поле")

        normalized[qid] = {"selected": list(selected), "details": dstr}

    return (len(errors) == 0, errors, normalized)
