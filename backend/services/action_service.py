"""
Сервис для работы с действиями
Предоставляет базовую функциональность, которую этапы могут использовать
или переопределять для своих кастомных действий
"""
from typing import Dict, Any, Optional, Tuple
from utils.validators import clamp

def find_action(case_data: Dict[str, Any], action_id: str, session: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Найти действие в кейсе или кризис-действиях"""
    for stage in case_data.get("stages", []):
        if stage.get("actions") and isinstance(stage["actions"], list):
            found = next((a for a in stage["actions"] if a.get("id") == action_id), None)
            if found: return found
        if stage.get("phases") and isinstance(stage["phases"], list):
            for phase in stage["phases"]:
                if phase.get("actions") and isinstance(phase["actions"], list):
                    found = next((a for a in phase["actions"] if a.get("id") == action_id), None)
                    if found: return found
    if session.get("crisis_actions"):
        return next((a for a in session["crisis_actions"] if a.get("id") == action_id), None)
    return None

def validate_action_prerequisites(action: Dict[str, Any], session: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """Проверить prerequisites действия.

    Поддержка двух форматов в JSON кейса:
    - список id: ["s2-a1"] — каждый id должен быть в actions_done;
    - список объектов: [{"type": "action_done", "action_id": "..."}, ...].
    """
    prereqs = action.get("prerequisites")
    if not prereqs or not isinstance(prereqs, list):
        return True, None
    done = session.get("actions_done", [])
    for prereq in prereqs:
        if isinstance(prereq, str):
            if prereq not in done:
                return False, "Предусловие не выполнено"
            continue
        if isinstance(prereq, dict) and prereq.get("type") == "action_done":
            if prereq.get("action_id") not in done:
                return False, "Предусловие не выполнено"
    return True, None

def validate_action_mutex(action: Dict[str, Any], case_data: Dict[str, Any], session: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """Проверить mutex-группу действия"""
    action_mutex_group = action.get("mutex_group") or action.get("mutex_group_id")
    if not action_mutex_group: return True, None
    for done_action_id in session.get("actions_done", []):
        done_action = _find_action_in_case(case_data, done_action_id)
        if done_action:
            done_mutex_group = done_action.get("mutex_group") or done_action.get("mutex_group_id")
            if done_mutex_group == action_mutex_group:
                return False, "Это действие взаимоисключаемо с уже выполненным"
    return True, None

def execute_action(action: Dict[str, Any], session: Dict[str, Any]) -> Dict[str, Any]:
    """Выполнить действие и обновить сессию"""
    lexic_impact = action.get("lexic_impact", {})
    print(f"🎯 Выполнение действия {action.get('id')}: lexic_impact={lexic_impact}")
    print(f"   Текущий LEXIC: {session.get('lexic')}")
    
    new_lexic = {
        "L": clamp(session["lexic"]["L"] + lexic_impact.get("L", 0), 0, 100),
        "E": clamp(session["lexic"]["E"] + lexic_impact.get("E", 0), 0, 100),
        "X": clamp(session["lexic"]["X"] + lexic_impact.get("X", 0), 0, 100),
        "I": clamp(session["lexic"]["I"] + lexic_impact.get("I", 0), 0, 100),
        "C": clamp(session["lexic"]["C"] + lexic_impact.get("C", 0), 0, 100)
    }
    print(f"   Новый LEXIC: {new_lexic}")
    costs = action.get("costs", {})
    points_cost = costs.get("points_cost") or costs.get("points", 0)
    time_cost = costs.get("time_cost_virtual") or costs.get("time", 0)
    new_resources = {
        "points": session["resources"]["points"] - points_cost,
        "time": session["resources"]["time"] - time_cost
    }
    penalized_lexic = dict(new_lexic)
    if new_resources["points"] < 0:
        overspend = max(0, -new_resources["points"])
        k = 2
        penalty = min(20, overspend * k)
        penalized_lexic["E"] = clamp(penalized_lexic["E"] - penalty, 0, 100)
        print(f"⚠️ Штраф E: {penalty} (переход очков в минус)")
    updated_session = {
        **session,
        "lexic": penalized_lexic,
        "resources": new_resources,
        "actions_done": session.get("actions_done", []) + [action.get("id")],
        "case_id": session.get("case_id")
    }
    return updated_session

def _find_action_in_case(case_data: Dict[str, Any], action_id: str) -> Optional[Dict[str, Any]]:
    """Найти действие в кейсе"""
    for stage in case_data.get("stages", []):
        if stage.get("actions") and isinstance(stage["actions"], list):
            found = next((a for a in stage["actions"] if a.get("id") == action_id), None)
            if found: return found
        if stage.get("phases") and isinstance(stage["phases"], list):
            for phase in stage["phases"]:
                if phase.get("actions") and isinstance(phase["actions"], list):
                    found = next((a for a in phase["actions"] if a.get("id") == action_id), None)
                    if found: return found
    return None
