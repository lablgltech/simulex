"""
Дополнения для этапа 4 (кризис), совместимые с текущей платформой.

Этап 4 управляется UI (Stage4View): контент инициализируется через /api/stage4/init,
второй кризис — через /api/stage4/second-crisis. Завершение этапа вызывается
кнопкой «Далее» в конце сценария (onComplete). В конфиге кейса (case-stage-4) у stage-4
может не быть обязательных действий — проверка завершения делегируется этому модулю.
"""
from __future__ import annotations

from typing import Dict, Any, List, Optional, Tuple


def can_complete_stage4(session: Dict[str, Any], stage_config: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Проверка возможности завершить этап 4.

    Если в конфиге есть обязательные действия — проверяем, что они выполнены.
    Если обязательных нет (сценарий управляется UI: письмо Дока, таймлайн, кризис) —
    этап можно завершить по кнопке в конце.
    """
    actions = stage_config.get("actions") or []
    required = [a for a in actions if a.get("is_required")]
    if not required:
        return True, None
    done = set(session.get("actions_done") or [])
    for r in required:
        if r.get("id") not in done:
            return False, f'Требуется выполнить: "{r.get("title", r.get("id"))}"'
    return True, None


def get_stage4_actions(stage_config: Dict[str, Any], session: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Список действий этапа 4: из конфига плюс кризисные из сессии (если есть).
    """
    actions = list(stage_config.get("actions") or [])
    if session.get("crisis_actions"):
        actions.extend(session["crisis_actions"])
    return actions


def merge_stage4_state_into_session(session: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Сохранить в сессию состояние этапа 4 (исход, выборы по договору и т.д.) для отчёта.
    Вызывать при завершении этапа, если фронт присылает эти данные.
    """
    out = dict(session)
    stage_state = out.get("stage_4_state") or {}
    if payload.get("outcome_key") is not None:
        stage_state["outcome_key"] = payload["outcome_key"]
    if payload.get("contract_selections") is not None:
        stage_state["contract_selections"] = payload["contract_selections"]
    if payload.get("first_outcome_key") is not None:
        stage_state["first_outcome_key"] = payload["first_outcome_key"]
    if stage_state:
        out["stage_4_state"] = stage_state
    return out
