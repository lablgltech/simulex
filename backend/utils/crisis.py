"""Логика работы с кризисом"""
from typing import Dict, Any, List

def check_crisis(case_data: Dict[str, Any], lexic: Dict[str, int]) -> List[Dict[str, Any]]:
    """Проверить условия кризиса и вернуть инжектируемые действия"""
    crisis = case_data.get("crisis")
    injects = []
    if not crisis or not crisis.get("conditions"):
        return injects
    for condition in crisis["conditions"]:
        param = condition.get("param")
        value = lexic.get(param, 0)
        triggered = False
        op = condition.get("op")
        threshold = condition.get("value")
        if op == "<": triggered = value < threshold
        elif op == ">": triggered = value > threshold
        elif op == "<=": triggered = value <= threshold
        elif op == ">=": triggered = value >= threshold
        if triggered and condition.get("inject"):
            injects.extend(condition["inject"])
    return injects
