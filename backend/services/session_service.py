"""
Сервис для работы с сессиями
"""
import logging
from typing import Dict, Any, Optional
from pathlib import Path
import time
from datetime import datetime

from services.case_service import get_case

_log = logging.getLogger(__name__)
from services.game_session_service import save_game_session
from services.session_context import log_session_action


def create_session(
    data_dir: Path,
    case_id: Optional[str] = None,
    start_stage: Optional[int] = None,
    user_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Создать новую сессию.

    Args:
        data_dir: Путь к директории с данными
        case_id: ID кейса
        start_stage: С какого этапа начать (1-based). Для теста этапа 2 передать 2.

    Returns:
        Данные сессии
    """
    _log.info("create_session case_id=%s start_stage=%s", case_id, start_stage)
    case_data = get_case(data_dir, case_id)
    stages = case_data.get("stages", [])
    stage_count = len(stages)

    initial_stage = 1
    if start_stage is not None and 1 <= start_stage <= stage_count:
        initial_stage = start_stage
        _log.info("Старт с этапа %s (для теста)", initial_stage)

    stage_config = stages[initial_stage - 1] if initial_stage <= stage_count else (stages[0] if stages else {})
                                               
    initial_points = (
        stage_config.get("resources", {}).get("points_budget")
        or stage_config.get("points_budget")
        or 6
    )
                                                                      
    initial_time = (
        stage_config.get("resources", {}).get("time_budget")
        or stage_config.get("time_budget")
        or 100
    )

    lexic_initial = (
        case_data.get("settings", {}).get("lexic_initial")
        or case_data.get("lexic_initial")
        or {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50}
    )

    session = {
        "id": str(int(time.time() * 1000)),
        "case_id": case_data.get("id"),
        "case_version": case_data.get("version", 1),
        "started_at": datetime.now().isoformat(),
        "current_stage": initial_stage,
        "lexic": dict(lexic_initial),
        "resources": {
            "points": initial_points,
            "time": initial_time
        },
        "actions_done": [],
        "stage_scores": {},
        "crisis_injected": False,
        "stage_transitions": case_data.get("settings", {}).get("stage_transitions", {})
    }
    
                                                                                        
    save_game_session(session, user_id=user_id)
                                                            
    try:
        log_session_action(
            session_external_id=session["id"],
            case_code=session.get("case_id"),
            stage_code=f"stage-{initial_stage}",
            action_type="session_start",
            payload={
                "case_id": session.get("case_id"),
                "initial_stage": initial_stage,
            },
        )
    except Exception:
                                                      
        pass
    
    _log.info(
        "Сессия запущена: %s кейс=%s case_id в сессии=%s",
        session["id"],
        case_data.get("id"),
        session["case_id"],
    )
    return session
