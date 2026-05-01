"""
Сервис для работы с этапами
Использует фабрику этапов для создания экземпляров
"""
import copy
from typing import Dict, Any, List, Tuple, Optional
from pathlib import Path
from services.case_service import get_case
from stages.stage_factory import create_stage
from stages.stage_4 import sync_stage4_contract_from_stage3
from utils.crisis import check_crisis
from services.session_context import log_session_action
from services.normalization_service import (
    save_stage_snapshot,
    save_normalized_to_game_session,
    compute_full_normalized_profile,
    get_stage_snapshots,
)
from services.lexic_participation_service import (
    eval_stage_lexic_eligibility,
    append_lexic_skip_record,
    strip_stage_lexic_artifacts,
    clear_stage_lexic_skip_flags,
    snapshot_lexic,
)
from services.lexic_progress_ceiling_service import apply_lexic_progress_ceiling
from services.lexic_guardrails_service import apply_lexic_post_ceiling_guardrails


def get_stage_actions(stage: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Получить все действия этапа (поддержка форматов с phases и без)
    
    Args:
        stage: Данные этапа
    
    Returns:
        Список действий
    """
    all_actions = []
    
    if stage.get("actions") and isinstance(stage["actions"], list):
        all_actions = stage["actions"]
    elif stage.get("phases") and isinstance(stage["phases"], list):
        for phase in stage["phases"]:
            if phase.get("actions") and isinstance(phase["actions"], list):
                all_actions.extend(phase["actions"])
    
    return all_actions


def validate_stage_completion(stage: Dict[str, Any], session: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Проверить, можно ли завершить этап
    
    Args:
        stage: Данные этапа
        session: Данные сессии
    
    Returns:
        (успех, сообщение об ошибке)
    """
    all_actions = get_stage_actions(stage)
    required = [a for a in all_actions if a.get("is_required")]
    
    for req_action in required:
        if req_action.get("id") not in session.get("actions_done", []):
            return False, f'Требуется выполнить: "{req_action.get("title")}"'
    
    return True, None


def complete_stage(
    data_dir: Path,
    stage_id: str,
    session: Dict[str, Any]
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """
    Завершить этап и подготовить переход к следующему
    
    Использует фабрику этапов для создания экземпляра и вызова его методов
    
    Args:
        data_dir: Путь к директории с данными
        stage_id: ID этапа
        session: Данные сессии
    
    Returns:
        (обновленная сессия, кризис-действия, next_stage_email_merge | None)
    """
    case_id = session.get("case_id", "").replace("case-", "") if session.get("case_id") else None
    case_data = get_case(data_dir, case_id)
    
                         
    stage = None
    stage_order = None
    for s in case_data.get("stages", []):
        if not isinstance(s, dict):
            continue
        order_val = s.get("order") or s.get("order_index")
        stage_num = stage_id.replace("stage-", "")
        if s.get("id") == stage_id or (stage_num.isdigit() and order_val == int(stage_num)):
            stage = s
            stage_order = order_val if order_val is not None else (int(stage_num) if stage_num.isdigit() else 1)
            break
    
    if not stage:
        raise ValueError("Этап не найден")
    
                                           
    try:
        stage_instance = create_stage(stage_id, stage_order, case_data)
    except ValueError:
                                                                  
        is_valid, error_msg = validate_stage_completion(stage, session)
        if not is_valid:
            raise ValueError(error_msg)
        stage_instance = None
    
                                     
    if stage_instance:
        is_valid, error_msg = stage_instance.can_complete(session)
        if not is_valid:
            raise ValueError(error_msg)
    else:
        is_valid, error_msg = validate_stage_completion(stage, session)
        if not is_valid:
            raise ValueError(error_msg)
    
    crisis_injects = []
    updated_session = dict(session)

                                 
    lexic_before = snapshot_lexic(session)
    apply_lexic_for_stage, lexic_skip_reason = eval_stage_lexic_eligibility(stage_id, session)

                                    
    if stage.get("crisis_check") and not session.get("crisis_injected"):
        crisis_injects = check_crisis(case_data, session["lexic"])
        if crisis_injects:
            print(f"🔴 Кризис активирован! Инжектировано {len(crisis_injects)} действий")
            updated_session["crisis_actions"] = crisis_injects
            updated_session["crisis_injected"] = True

                                                   
    if stage_instance:
        updated_session = stage_instance.on_complete(updated_session)
                                                                                                                  
    if stage_id == "stage-3":
        sync_stage4_contract_from_stage3(data_dir, updated_session.get("case_id"), updated_session)

    if not apply_lexic_for_stage:
        updated_session["lexic"] = dict(lexic_before)
        updated_session = strip_stage_lexic_artifacts(updated_session, stage_id)
        updated_session = append_lexic_skip_record(updated_session, stage_id, lexic_skip_reason)
        updated_session["lexic_last_skip_reason"] = lexic_skip_reason
    else:
        updated_session = clear_stage_lexic_skip_flags(updated_session, stage_id)

                                                                                                              
    session_external_id = updated_session.get("id")
    if apply_lexic_for_stage and session_external_id:
        try:
            lx = updated_session.get("lexic") or {}
            capped = apply_lexic_progress_ceiling(
                dict(lx) if isinstance(lx, dict) else {},
                case_data=case_data,
                session_external_id=str(session_external_id),
                include_completed_stage_code=stage_id,
            )
            updated_session["lexic"] = apply_lexic_post_ceiling_guardrails(
                capped,
                session=updated_session,
                case_data=case_data,
                apply_lexic_for_stage=True,
            )
        except Exception as _ce:
            print(f"⚠️ stage_service: lexic_progress_ceiling: {_ce}")

                                                                                                
    lexic_after = snapshot_lexic(updated_session)
    if session_external_id:
        try:
            merged_snapshots: Optional[List[Dict[str, Any]]] = None
            if apply_lexic_for_stage:
                pre_snaps = get_stage_snapshots(str(session_external_id))
                new_row = save_stage_snapshot(
                    session_external_id=str(session_external_id),
                    stage_code=stage_id,
                    stage_order=stage_order,
                    lexic_before=lexic_before,
                    lexic_after=lexic_after,
                    case_data=case_data,
                )
                if new_row:
                    code = new_row.get("stage_code")
                    merged_snapshots = sorted(
                        [s for s in pre_snaps if s.get("stage_code") != code] + [new_row],
                        key=lambda s: (s.get("stage_order") is None, s.get("stage_order") or 0),
                    )
                                                           
            norm_profile = compute_full_normalized_profile(
                str(session_external_id),
                raw_lexic=lexic_after,
                preloaded_snapshots=merged_snapshots,
            )
            save_normalized_to_game_session(str(session_external_id), norm_profile)
            updated_session["lexic_normalized"] = norm_profile
        except Exception as _e:
            print(f"⚠️ stage_service: ошибка нормализации LEXIC: {_e}")

    completed_stage = stage_order
    next_stage_index = completed_stage
    
                                     
    final_session = _apply_stage_transition(
        case_data,
        updated_session,
        completed_stage,
        next_stage_index
    )
    
    print(f"✅ Этап {completed_stage} завершен")
    log_session_action(
        final_session.get("id"),
        case_code=final_session.get("case_id"),
        stage_code=stage_id,
        action_type="stage_complete",
        payload={
            "stage_order": completed_stage,
            "crisis_injected": bool(crisis_injects),
            "lexic_skipped": not apply_lexic_for_stage,
            "lexic_skip_reason": lexic_skip_reason if not apply_lexic_for_stage else None,
        },
    )
    next_stage_email_merge: Optional[Dict[str, Any]] = None
    stages_list = case_data.get("stages", []) or []
    cs_disp = final_session.get("current_stage")
    if isinstance(cs_disp, int) and cs_disp >= 1:
        idx = cs_disp - 1
        if 0 <= idx < len(stages_list):
            st = stages_list[idx]
            if isinstance(st, dict):
                emails = st.get("emails")
                if emails:
                    next_stage_email_merge = {
                        "stage_number": cs_disp,
                        "emails": copy.deepcopy(emails),
                    }
    return final_session, crisis_injects, next_stage_email_merge


def _apply_stage_transition(
    case_data: Dict[str, Any],
    session: Dict[str, Any],
    completed_stage: int,
    next_stage_index: int
) -> Dict[str, Any]:
    """Применить переход между этапами. Если завершён последний этап — current_stage = len(stages)+1 (фронт показывает «Кейс завершён»)."""
    stages_list = case_data.get("stages", [])
    num_stages = len(stages_list)
    if next_stage_index >= num_stages:
        next_stage_display = num_stages + 1
    else:
        next_stage_display = next_stage_index + 1
    final_session = {
        **session,
        "current_stage": next_stage_display,
        "case_id": session.get("case_id")
    }
    
    current_time = (final_session.get("resources") or {}).get("time", 0)

    if session.get("stage_transitions"):
        transition_key = f"{completed_stage}->{next_stage_index + 1}"
        transition = session["stage_transitions"].get(transition_key)
        
        if transition:
            if not transition.get("preserve_resources"):
                next_stage = case_data.get("stages", [])[next_stage_index] if next_stage_index < len(case_data.get("stages", [])) else None
                if next_stage and not isinstance(next_stage, dict):
                    next_stage = None
                if next_stage:
                    next_points_budget = (
                        next_stage.get("points_budget") or
                        next_stage.get("resources", {}).get("points_budget") or
                        6
                    )
                    final_session["resources"] = {
                        "points": next_points_budget + transition.get("bonus_points", 0),
                        "time": current_time,
                    }
        else:
                               
            next_stage = case_data.get("stages", [])[next_stage_index] if next_stage_index < len(case_data.get("stages", [])) else None
            if next_stage and not isinstance(next_stage, dict):
                next_stage = None
            if next_stage:
                next_points_budget = (
                    next_stage.get("points_budget") or
                    next_stage.get("resources", {}).get("points_budget") or
                    6
                )
                final_session["resources"] = {
                    "points": next_points_budget,
                    "time": current_time,
                }
    else:
                                        
        next_stage = case_data.get("stages", [])[next_stage_index] if next_stage_index < len(case_data.get("stages", [])) else None
        if next_stage and not isinstance(next_stage, dict):
            next_stage = None
        if next_stage:
            next_points_budget = (
                next_stage.get("points_budget") or
                next_stage.get("resources", {}).get("points_budget") or
                6
            )
            final_session["resources"] = {
                "points": next_points_budget,
                "time": current_time,
            }
    
    return final_session
