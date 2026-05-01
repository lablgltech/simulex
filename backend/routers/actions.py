"""
Роутер для работы с действиями
Использует систему этапов для валидации и выполнения действий
"""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from api_errors import client_500_detail_from_exception
from config import DATA_DIR
from routers.auth import get_current_user

logger = logging.getLogger(__name__)
from models.schemas import ActionExecuteRequest
from services.case_service import get_case
from services.action_service import find_action, validate_action_prerequisites, validate_action_mutex, execute_action
from services.session_context import log_session_action

router = APIRouter(prefix="/api", tags=["actions"])


@router.post("/action/execute")
async def execute_action_endpoint(
    request: ActionExecuteRequest, current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Выполнить действие
    
    Использует систему этапов для валидации и выполнения действий.
    Каждый этап может иметь свою логику для своих действий.
    """
    try:
        from stages.stage_factory import create_stage
        
        action_id = request.action_id
        session = request.session
        
        print(f"🎯 Запрос на выполнение действия: {action_id}")
        print(f"   Сессия: case_id={session.get('case_id')}, current_stage={session.get('current_stage')}")
        
        raw_case_id = session.get("case_id")
        if not raw_case_id:
            raise HTTPException(status_code=400, detail="case_id не найден в сессии")

        case_data = get_case(DATA_DIR, str(raw_case_id).strip())
        if not case_data:
            raise HTTPException(
                status_code=404, detail=f"Кейс {str(raw_case_id).strip()} не найден"
            )
        
        # Определить, к какому этапу относится действие
        current_stage_index = session.get("current_stage", 1) - 1
        if current_stage_index < 0:
            current_stage_index = 0
        
        print(f"   Индекс этапа: {current_stage_index}, всего этапов: {len(case_data.get('stages', []))}")
        
        current_stage_data = case_data.get("stages", [])[current_stage_index] if current_stage_index < len(case_data.get("stages", [])) else None
        
        if not current_stage_data:
            raise HTTPException(status_code=400, detail=f"Этап с индексом {current_stage_index} не найден")
        
        stage_id = current_stage_data.get("id")
        stage_order = current_stage_data.get("order") or current_stage_data.get("order_index")
        
        print(f"   Этап: {stage_id}, порядок: {stage_order}")
        print(f"   Доступные действия этапа: {[a.get('id') for a in current_stage_data.get('actions', [])]}")
        
        try:
            # Создать экземпляр этапа
            stage_instance = create_stage(stage_id, stage_order, case_data)
            
            # Использовать логику этапа для валидации
            is_valid, error_msg = stage_instance.validate_action(action_id, session)
            if not is_valid:
                print(f"❌ Валидация не прошла: {error_msg}")
                raise HTTPException(status_code=400, detail=error_msg)
            
            # Использовать логику этапа для выполнения
            print(f"📊 LEXIC до выполнения: {session.get('lexic')}")
            updated_session = stage_instance.execute_action(action_id, session)
            print(f"📊 LEXIC после выполнения: {updated_session.get('lexic')}")
            action = next((a for a in stage_instance.get_actions() if a.get("id") == action_id), None)
            
            # Если действие не найдено в этапе, проверяем кризис-действия
            if not action and session.get("crisis_actions"):
                action = next((a for a in session["crisis_actions"] if a.get("id") == action_id), None)
            
            print(f"✓ Действие выполнено через этап {stage_id}: {action.get('title') if action else action_id}")
            log_session_action(
                updated_session.get("id"),
                case_code=updated_session.get("case_id"),
                stage_code=stage_id,
                action_type="action_executed",
                payload={"action_id": action_id, "action_title": (action or {}).get("title")},
            )
            return {"session": updated_session, "action": action or {"id": action_id}}
        except ValueError as e:
            # Этап не найден в реестре, используем базовую логику
            print(f"⚠️ Этап {stage_id} не найден в реестре, используем базовую логику: {e}")
        
        # Базовая логика (fallback)
        action = find_action(case_data, action_id, session)
        if not action:
            print(f"❌ Действие {action_id} не найдено в кейсе")
            raise HTTPException(status_code=404, detail=f"Действие {action_id} не найдено")
        
        is_valid, error_msg = validate_action_prerequisites(action, session)
        if not is_valid:
            print(f"❌ Предусловия не выполнены: {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg)
        
        is_valid, error_msg = validate_action_mutex(action, case_data, session)
        if not is_valid:
            print(f"❌ Mutex проверка не прошла: {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg)
        
        print(f"📊 LEXIC до выполнения (fallback): {session.get('lexic')}")
        updated_session = execute_action(action, session)
        print(f"📊 LEXIC после выполнения (fallback): {updated_session.get('lexic')}")
        
        print(f"✓ Действие выполнено: {action.get('title')}")
        stage_id = current_stage_data.get("id")
        log_session_action(
            updated_session.get("id"),
            case_code=updated_session.get("case_id"),
            stage_code=stage_id,
            action_type="action_executed",
            payload={"action_id": action_id, "action_title": action.get("title")},
        )
        return {"session": updated_session, "action": action}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("execute_action failed")
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e
