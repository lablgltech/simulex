"""
Сброс прогресса текущего этапа в JSON-сессии (без смены current_stage).
Для этапа 3 дополнительно сбрасывается negotiation_session в БД.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from services.case_service import get_case
from services.game_session_service import save_game_session
from services.session_context import log_session_action
from services.negotiation_session_service import (
    get_or_create_stage_and_negotiation_session,
    reset_negotiation_contract_to_initial,
)
from services.stage_service import get_stage_actions

from utils.validators import clamp


def _revert_lexic_for_restarted_stage(session: Dict[str, Any], out: Dict[str, Any], stage_id: str) -> None:
    """
    Вычесть из out['lexic'] дельты, которые были начислены за текущий (сбрасываемый) этап.
    Исходные поля отчёта читаем из session (копия до pop-ов из out — у session ключи сохраняются).
    """
    if stage_id == "stage-1":
        return

    lx = dict(out.get("lexic") or {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50})
    touched = False

    if stage_id == "stage-2":
        rep = session.get("stage2_report") or {}
        summ = rep.get("summary") or {}
        ld = summ.get("lexic_deltas_stage2") or {}
        for p in ("L", "E", "X", "I", "C"):
            d = int(ld.get(p, 0) or 0)
            if d:
                lx[p] = clamp(int(lx.get(p, 50)) - d, 0, 100)
                touched = True
    elif stage_id == "stage-3":
        bd = session.get("stage3_lexic_breakdown") or {}
        deltas = bd.get("deltas") or {}
        penalties = bd.get("semantic_penalties") or {}
        for p in ("L", "E", "X", "I", "C"):
            step = int(round(float(deltas.get(p, 0) or 0)))
            step += int(round(float((penalties or {}).get(p, 0) or 0)))
            if step:
                lx[p] = clamp(int(lx.get(p, 50)) - step, 0, 100)
                touched = True
    elif stage_id == "stage-4":
        try:
            from services.stage4_lexic_service import STAGE4_LEXIC_LX_DELTA_SCALE
        except Exception:
            STAGE4_LEXIC_LX_DELTA_SCALE = 0.68
        bd = session.get("stage4_lexic_breakdown") or {}
        deltas = bd.get("deltas") or {}
        for p in ("L", "E", "X", "I", "C"):
            raw = float(deltas.get(p, 0) or 0)
            if p in ("L", "X"):
                d = int(round(raw * STAGE4_LEXIC_LX_DELTA_SCALE))
            else:
                d = int(round(raw))
            if d:
                lx[p] = clamp(int(lx.get(p, 50)) - d, 0, 100)
                touched = True

    if touched:
        out["lexic"] = lx
    out.pop("lexic_normalized", None)


def _stage_order_key(stage: Dict[str, Any], fallback: int) -> str:
    o = stage.get("order")
    if o is None:
        o = stage.get("order_index")
    if o is None:
        o = fallback
    return str(o)


def restart_current_stage(data_dir: Path, session: Dict[str, Any]) -> Dict[str, Any]:
    """
    Убрать из сессии следы текущего этапа: действия этапа, поля stageN_*, ресурсы этапа.
    Этап 1: LEXIC = начальное из кейса.
    Этап 3: сброс history_json переговоров.
    """
    out: Dict[str, Any] = dict(session)
    raw_case = str(out.get("case_id") or "").strip()
    case_key = raw_case.replace("case-", "").strip() if raw_case else ""
    if not case_key:
        raise ValueError("В сессии нет case_id")

    case_data = get_case(data_dir, case_key)
    stages: List[Dict[str, Any]] = case_data.get("stages") or []
    cs = int(out.get("current_stage") or 1)
    idx = cs - 1
    if idx < 0 or idx >= len(stages):
        raise ValueError("Некорректный current_stage для кейса")

    stage = stages[idx]
    stage_id = str(stage.get("id") or f"stage-{cs}")
    stage_actions = get_stage_actions(stage)
    stage_action_ids = {a.get("id") for a in stage_actions if a.get("id")}

    done = list(out.get("actions_done") or [])
    out["actions_done"] = [a for a in done if a not in stage_action_ids]

    prefixes_map: Dict[str, Tuple[str, ...]] = {
        "stage-1": ("stage1_",),
        "stage-2": ("stage2_",),
        "stage-3": ("stage3_",),
        "stage-4": ("stage_4_", "stage4_"),
    }
    prefs = prefixes_map.get(stage_id, ())
    for key in list(out.keys()):
        if any(key.startswith(p) for p in prefs):
            out.pop(key, None)

                                                                                                         
    _revert_lexic_for_restarted_stage(session, out, stage_id)

    if stage_id == "stage-3":
        out.pop("crisis_actions", None)
        out["crisis_injected"] = False
        sid = str(out.get("id") or "").strip()
        cc = str(out.get("case_id") or "").strip()
        if sid and cc:
            try:
                _ss, neg_id = get_or_create_stage_and_negotiation_session(
                    sid, cc, "dogovor_PO"
                )
                reset_negotiation_contract_to_initial(neg_id)
            except Exception as e:
                raise RuntimeError(f"Не удалось сбросить переговоры: {e}") from e

    if stage_id == "stage-1":
        lexic_initial = (
            (case_data.get("settings") or {}).get("lexic_initial")
            or case_data.get("lexic_initial")
            or {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50}
        )
        out["lexic"] = dict(lexic_initial)
        out.pop("lexic_normalized", None)

    initial_points = None
    if isinstance(stage.get("resources"), dict):
        initial_points = stage["resources"].get("points_budget")
    if initial_points is None:
        initial_points = stage.get("points_budget")
    if initial_points is None:
        initial_points = (out.get("resources") or {}).get("points")
    if initial_points is None:
        initial_points = 6

    initial_time = None
    if isinstance(stage.get("resources"), dict):
        initial_time = stage["resources"].get("time_budget")
    if initial_time is None:
        initial_time = stage.get("time_budget")

    res = dict(out.get("resources") or {})
    res["points"] = int(initial_points)
    if initial_time is not None and int(initial_time) > 0:
        res["time"] = int(initial_time)
    else:
        res.pop("time", None)
    out["resources"] = res

    sk = _stage_order_key(stage, cs)
    sc = dict(out.get("stage_scores") or {})
    sc.pop(sk, None)
    out["stage_scores"] = sc

    return out


def execute_stage_restart_persist(
    data_dir: Path,
    session_input: Dict[str, Any],
    user_id: Optional[int],
) -> Dict[str, Any]:
    """Сброс этапа + запись в game_session + лог (общая логика для /api/stage/restart и алиаса)."""
    updated = restart_current_stage(data_dir, session_input)
    save_game_session(updated, user_id=user_id)
    cs = int(updated.get("current_stage") or 1)
    log_session_action(
        updated.get("id"),
        case_code=updated.get("case_id"),
        stage_code=f"stage-{cs}",
        action_type="stage_restart",
        payload={"current_stage": cs},
    )
    return updated
