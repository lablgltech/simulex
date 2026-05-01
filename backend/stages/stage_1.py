"""Этап 1: Выявление контекста — механики: документы, инсайты, карта сделки, чат с инициатором"""
from typing import Dict, Any, List, Optional
from stages.base_stage import BaseStage
from stages import STAGE_EXTRA_ROUTERS
from services.action_service import (
    execute_action as platform_execute_action,
    validate_action_prerequisites,
    validate_action_mutex,
)
from services.case_service import get_case
from services.stage1_context_chat import (
    evaluate_insights_coverage,
    evaluate_conclusion_legitimacy_points,
    expertise_x_delta_from_ratio,
    legitimacy_coverage_from_overall,
)
from config import DATA_DIR
from utils.validators import clamp
from routers import stage1_ai

# Роутеры этапа 1 (ИИ: оценка инсайтов, вопросов, ответы на вопросы)
STAGE_EXTRA_ROUTERS["stage-1"] = [stage1_ai.router]


class Stage1(BaseStage):
    """Этап 1: Выявление контекста — документы (простые/средние/сложные), инсайты, карта сделки, вопросы инициатору."""

    def get_stage_info(self) -> Dict[str, Any]:
        time_budget = self.stage_config.get("time_budget") or 100
        max_questions = self.stage_config.get("max_questions") or 2
        return {
            "title": self.stage_config.get("title", "Этап 1: Выявление контекста"),
            "intro": self.stage_config.get("intro", "Сбор исходных данных и определение рисков"),
            "type": "context",
            "points_budget": self.stage_config.get("points_budget", 6),
            "time_budget": time_budget,
            "max_questions": max_questions,
            "custom_mechanics": ["documents", "insights", "map", "chat"],
        }

    def get_actions(self) -> List[Dict[str, Any]]:
        return self.stage_config.get("actions", [])

    def _resolve_action(self, action_id: str) -> Optional[Dict[str, Any]]:
        """Найти действие по id; для s1-ask-question допускаем шаблон (любое действие ask_question)."""
        actions = self.get_actions()
        action = next((a for a in actions if a.get("id") == action_id), None)
        if action:
            return action
        if action_id == "s1-ask-question":
            template = next((a for a in actions if a.get("type") == "ask_question"), None)
            if template:
                return {**template, "id": action_id}
        return None

    def validate_action(self, action_id: str, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        action = self._resolve_action(action_id)
        if not action:
            return False, "Действие не найдено"

        # Проверка оставшегося времени: лимит этапа берём из time_budget в case.json
        time_budget = self.stage_config.get("time_budget") or 100
        resources = session.get("resources", {})
        raw_time = resources.get("time") or 0
        actions_done = session.get("actions_done", [])
        if not any(a.startswith("s1-") for a in actions_done):
            time_remaining = time_budget  # до первого действия — полный бюджет этапа
        else:
            time_remaining = min(raw_time, time_budget)
        costs = action.get("costs", {})
        time_cost = costs.get("time") or costs.get("time_cost_virtual") or 0
        if time_remaining < time_cost:
            return False, "Недостаточно очков времени для этого действия"

        is_valid, error_msg = validate_action_prerequisites(action, session)
        if not is_valid:
            return False, error_msg

        case_id = session.get("case_id", "").replace("case-", "") if session.get("case_id") else None
        case_data = get_case(DATA_DIR, case_id)
        is_valid, error_msg = validate_action_mutex(action, case_data, session)
        if not is_valid:
            return False, error_msg

        return True, None

    def execute_action(self, action_id: str, session: Dict[str, Any], **kwargs) -> Dict[str, Any]:
        action = self._resolve_action(action_id)
        if not action:
            raise ValueError("Действие не найдено")
        # До первого действия этапа 1 подставляем лимит из time_budget (case.json)
        actions_done = session.get("actions_done", [])
        if not any(a.startswith("s1-") for a in actions_done):
            time_budget = self.stage_config.get("time_budget") or 100
            session = dict(session)
            session["resources"] = {**session.get("resources", {}), "time": time_budget}
        # В actions_done пишем переданный action_id (для s1-ask-question — без лимита по числу)
        action_to_execute = {**action, "id": action_id}
        return platform_execute_action(action_to_execute, session)

    def can_complete(self, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        # Завершить этап можно в любой момент (кнопка «Завершить игру» или по окончании времени)
        return True, None

    def on_complete(self, session: Dict[str, Any]) -> Dict[str, Any]:
        """
        Пересчёт LEXIC по результатам этапа 1.
        Основной путь — stage1_lexic_service; при ошибке — логика как в master (E/X/L/C, requested_doc_ids).
        """
        updated = dict(session)
        result = session.get("stage1_result")
        if not result:
            return updated

        initial_lexic = dict(updated.get("lexic", {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50}))
        attributes_config = self.stage_config.get("attributes", [])

        try:
            from services.stage1_lexic_service import compute_stage1_lexic

            lex_opts = self.stage_config.get("lexic")
            new_lexic, breakdown = compute_stage1_lexic(
                result,
                attributes_config,
                initial_lexic=initial_lexic,
                use_ai_for_c=True,
                stage1_lexic_options=lex_opts if isinstance(lex_opts, dict) else None,
            )
            updated["lexic"] = new_lexic
            updated["stage1_lexic_breakdown"] = breakdown
            updated["stage1_expertise"] = {
                "correct_count": (breakdown.get("X") or {}).get("correct_count", 0),
                "total_classified": (breakdown.get("X") or {}).get("total_classified", 0),
                "x_ratio": (breakdown.get("X") or {}).get("x_ratio"),
                "x_delta": (breakdown.get("X") or {}).get("x_delta", 0),
            }
            updated["stage1_legitimacy"] = {
                "overall_coverage": (breakdown.get("L") or {}).get("overall_coverage", 0.0),
                "l_coverage": (breakdown.get("L") or {}).get("l_coverage_component", 0),
                "l_conclusion": (breakdown.get("L") or {}).get("l_conclusion_component", 0),
                "l_delta": (breakdown.get("L") or {}).get("l_delta_total", 0),
            }
            updated["stage1_coverage"] = breakdown.get("coverage_details", {})
            return updated
        except Exception as _e:
            print(f"⚠️ stage_1.on_complete: ошибка stage1_lexic_service, используем fallback: {_e}")

        lexic = dict(initial_lexic)
        questions_for_e = result.get("questions") or []
        good, medium, bad = 0, 0, 0
        for q in questions_for_e:
            quality = q.get("quality", "bad")
            quality_hint = q.get("quality_hint")
            if quality == "good" and quality_hint == "off_topic":
                bad += 1
            elif quality == "good":
                good += 1
            elif quality == "medium":
                medium += 1
            else:
                bad += 1
        from services.stage1_lexic_service import E_QUESTION_NORM_DENOMINATOR_DEFAULT

        d = float(E_QUESTION_NORM_DENOMINATOR_DEFAULT)
        raw = (2 * good + medium - bad) / d
        e_delta = round(10 * max(0.0, min(1.0, raw)))
        lexic["E"] = clamp(50 + (e_delta - 5) * 10, 0, 100)

        insights_by_attr = result.get("insights_by_attribute") or {}
        requested_doc_ids = [
            str(d.get("id"))
            for d in (session.get("stage1_requested_documents") or [])
            if isinstance(d, dict) and d.get("id")
        ]
        try:
            coverage = evaluate_insights_coverage(insights_by_attr, attributes_config, requested_doc_ids)
        except Exception:
            coverage = {"attr_coverage": {}, "overall_coverage": 0.0, "correct_count": 0, "total_classified": 0}

        correct = int(coverage.get("correct_count") or 0)
        total_classified = int(coverage.get("total_classified") or 0)
        x_ratio: Optional[float] = None
        x_delta = 0
        if total_classified > 0:
            x_ratio = correct / max(total_classified, 1)
            x_delta = expertise_x_delta_from_ratio(x_ratio)
            lexic["X"] = clamp(lexic["X"] + x_delta, 0, 100)

        overall_coverage = float(coverage.get("overall_coverage") or 0.0)
        l_coverage = legitimacy_coverage_from_overall(overall_coverage)
        conclusion_text = (result.get("conclusion_text") or "").strip() or None
        try:
            l_conclusion = evaluate_conclusion_legitimacy_points(conclusion_text, attributes_config)
        except Exception:
            l_conclusion = 0
        l_delta = max(-10, min(15, l_coverage + l_conclusion))
        lexic["L"] = clamp(lexic["L"] + l_delta, 0, 100)

        updated["stage1_expertise"] = {
            "correct_count": correct,
            "total_classified": total_classified,
            "x_ratio": x_ratio,
            "x_delta": x_delta,
        }
        updated["stage1_legitimacy"] = {
            "overall_coverage": overall_coverage,
            "l_coverage": l_coverage,
            "l_conclusion": l_conclusion,
            "l_delta": l_delta,
        }
        updated["stage1_coverage"] = coverage.get("attr_coverage", {})

        questions = result.get("questions") or []
        for q in questions:
            quality = q.get("quality", "bad")
            quality_hint = q.get("quality_hint")
            ideal = q.get("ideal_insight_received", False)
            if quality_hint == "off_topic":
                continue
            if quality == "good" and ideal:
                lexic["C"] = clamp(lexic["C"] + 5, 0, 100)
            elif quality == "good":
                lexic["C"] = clamp(lexic["C"] + 2, 0, 100)
            elif quality == "medium":
                lexic["C"] = clamp(lexic["C"] + 1, 0, 100)

        updated["lexic"] = lexic
        return updated

    def get_custom_data(self) -> Dict[str, Any]:
        """Данные для UI: документы, атрибуты, легенда."""
        documents = self.stage_config.get("documents", [])
        attributes = self.stage_config.get("attributes", [])
        # Для фронта атрибуты с эталонными инсайтами, но без выбранных игроком
        attributes_for_ui = [
            {
                "id": a.get("id"),
                "title": a.get("title"),
                "reference_insights": a.get("reference_insights", []),
                "document_requirements": a.get("document_requirements", None),
                "insights": [],
            }
            for a in attributes
        ]
        return {
            "documents": documents,
            "attributes": attributes_for_ui,
            "legend": self.stage_config.get("legend", ""),
            "time_budget": self.stage_config.get("time_budget") or 100,
            "max_questions": self.stage_config.get("max_questions") or 2,
        }
