"""
API-эндпоинты для дашборда руководителя и аналитических отчётов.

Маршруты:
  GET /api/dashboard/overview      — KPI верхнего уровня (расширенный); поле ai_briefing_context без второго SELECT
  GET /api/dashboard/participants  — сводная таблица участников с нормализованным LEXIC
  GET /api/dashboard/participant/{session_id}/detail — drill-down по участнику
  GET /api/dashboard/stages-matrix — матрица прогресса по этапам
  GET /api/dashboard/behavior — soft-skills, этап 2, кластеры LEXIC
  GET /api/dashboard/system-gaps — зоны по этапам и рекомендации
  GET /api/dashboard/priorities — приоритеты вмешательства
  GET /api/dashboard/trends — динамика LEXIC по месяцам
  GET /api/dashboard/proxy-roi — прокси ROI (длительность, попытки)
  GET /api/dashboard/correlations — корреляции (при достаточном N)
  GET /api/dashboard/ai-briefing-context — метаданные для ИИ-брифинга (без LLM): крайняя активность сессий
  GET /api/dashboard/ai-briefing — AI-суммаризация по группе (SWOT, alerts, action items)
  GET /api/dashboard/performance-distribution — квартили, гистограмма, box-plot данные
  GET /api/report/participant/{session_id} — полный отчёт участника (нормализованный)
  GET /api/report/admin/group      — аналитический отчёт по группе
"""

from __future__ import annotations

import json
import logging
import math
import re
import statistics
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from config import DATA_DIR
from db import get_connection
from routers.auth import get_current_user
from routers.admin import require_admin
from services.normalization_service import (
    compute_full_normalized_profile,
    classify_participant,
    get_growth_points,
    get_lexic_level,
    LEXIC_PARAMS,
    DEFAULT_STAGE_WEIGHTS,
)
from services.game_session_service import save_game_session
from services.report_service import (
    generate_report,
    ensure_case_report_snapshot,
    _resolve_session_external_id,
    _report_snapshot_is_current,
)
from services.auth_service import participant_user_ids_visible_to_viewer
from services.case_service import get_case, get_case_titles_by_codes
from services.dashboard_behavior_service import (
    aggregate_behavior_insights,
    enrich_session_rows,
    load_behavior_batch,
)
from services.dashboard_insights_service import (
    compute_system_gaps,
    compute_priorities,
    compute_trends,
    compute_proxy_roi,
    compute_correlations,
    industry_reference_from_env,
)

log = logging.getLogger(__name__)


def _to_10_scale(val100: float) -> float:
    """Перевод 0-100 → 0-10 (как в отчёте участника)."""
    v = max(0.0, min(100.0, float(val100 or 0)))
    if v <= 50:
        return round(0.5 + (v / 50) * 3.5, 1)
    return round(4.0 + ((v - 50) / 50) * 6.0, 1)


def _coerce_current_stage_index(val: Any) -> int:
    """current_stage в payload JSON может прийти числом или строкой; иначе сравнение с int даёт TypeError (500)."""
    if val is None:
        return 1
    try:
        n = int(val)
    except (TypeError, ValueError):
        return 1
    return n if n >= 1 else 1


router = APIRouter(prefix="/api", tags=["dashboard"])

# Эталонные значения по умолчанию
DEFAULT_REFERENCE = {p: 75.0 for p in LEXIC_PARAMS}

# Сколько сессий поднимать для дашборда (до дедупликации «лучшая попытка»)
DASHBOARD_SESSION_LIMIT = 5000


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------


def _session_better(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    """True, если сессия a лучше b для той же пары (user, case): завершение > балл > дата."""
    ac = 1 if a.get("status") == "completed" else 0
    bc = 1 if b.get("status") == "completed" else 0
    if ac != bc:
        return ac > bc
    at = a.get("total_score")
    bt = b.get("total_score")
    av = at if at is not None else -1.0
    bv = bt if bt is not None else -1.0
    if av != bv:
        return av > bv
    ua = a.get("updated_at") or ""
    ub = b.get("updated_at") or ""
    return ua > ub


def best_sessions_per_user_case(sessions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Одна строка на пару (user_id, case_code) — лучшая попытка по баллу/завершению."""
    buckets: Dict[tuple, Dict[str, Any]] = {}
    for s in sessions:
        uid = s.get("user_id")
        if uid is None:
            continue
        cc = s.get("case_code") or ""
        key = (uid, cc)
        cur = buckets.get(key)
        if cur is None or _session_better(s, cur):
            buckets[key] = s
    return list(buckets.values())


def _attempt_counts(sessions: List[Dict[str, Any]]) -> Dict[tuple, int]:
    return Counter((s.get("user_id"), s.get("case_code") or "") for s in sessions if s.get("user_id") is not None)


def _kpi_from_rows(best_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """KPI по уже отобранным лучшим сессиям (одна на участника в рамках кейса).
    Расширено: group_std_dev, below_threshold_pct, participant_type_distribution.
    """
    empty_kpi: Dict[str, Any] = {
        "participants": 0,
        "completed": 0,
        "completion_rate": 0.0,
        "avg_score": None,
        "group_profile": {p: None for p in LEXIC_PARAMS},
        "group_std_dev": {p: None for p in LEXIC_PARAMS},
        "below_threshold_pct": {p: None for p in LEXIC_PARAMS},
        "participant_type_distribution": [],
        "risk_count": 0,
        "leader_count": 0,
        "worst_param": None,
        "worst_param_avg": None,
        "top3": [],
        "bottom3": [],
        "score_std_dev": None,
    }
    if not best_rows:
        return empty_kpi

    n = len(best_rows)
    completed = sum(1 for s in best_rows if s["status"] == "completed")
    completion_rate = completed / n if n else 0.0

    group_profile: Dict[str, Optional[float]] = {}
    group_std_dev: Dict[str, Optional[float]] = {}
    below_threshold_pct: Dict[str, Optional[float]] = {}
    threshold = 60.0

    for p in LEXIC_PARAMS:
        vals = [s[p] for s in best_rows if s[p] is not None]
        if vals:
            group_profile[p] = round(sum(vals) / len(vals), 1)
            group_std_dev[p] = round(statistics.pstdev(vals), 1) if len(vals) > 1 else 0.0
            below_threshold_pct[p] = round(sum(1 for v in vals if v < threshold) / len(vals) * 100, 1)
        else:
            group_profile[p] = None
            group_std_dev[p] = None
            below_threshold_pct[p] = None

    scores = [s["total_score"] for s in best_rows if s["total_score"] is not None]
    avg_score = round(sum(scores) / len(scores), 1) if scores else None
    score_std_dev = round(statistics.pstdev(scores), 1) if len(scores) > 1 else 0.0

    worst_param = None
    if any(v is not None for v in group_profile.values()):
        worst_param = min(
            (p for p in LEXIC_PARAMS if group_profile[p] is not None),
            key=lambda p: group_profile[p],
            default=None,
        )

    scored = sorted(
        [s for s in best_rows if s["total_score"] is not None],
        key=lambda s: s["total_score"],
        reverse=True,
    )
    top3 = [
        {
            "name": s["name"],
            "score": s["total_score"],
            "session_id": s["session_id"],
            "user_id": s.get("user_id"),
            "case_code": s.get("case_code"),
        }
        for s in scored[:3]
    ]
    bottom3 = [
        {
            "name": s["name"],
            "score": s["total_score"],
            "session_id": s["session_id"],
            "user_id": s.get("user_id"),
            "case_code": s.get("case_code"),
        }
        for s in scored[-3:][::-1]
    ]

    type_counter: Counter = Counter()
    for s in best_rows:
        lexic = {p: s[p] or 50 for p in LEXIC_PARAMS}
        ptype = classify_participant(lexic)
        type_counter[ptype.get("label", ptype.get("type", "developing"))] += 1
    participant_type_distribution = [
        {"type": k, "count": v} for k, v in type_counter.most_common()
    ]

    return {
        "participants": n,
        "completed": completed,
        "completion_rate": round(completion_rate, 3),
        "avg_score": avg_score,
        "score_std_dev": score_std_dev,
        "group_profile": group_profile,
        "group_std_dev": group_std_dev,
        "below_threshold_pct": below_threshold_pct,
        "participant_type_distribution": participant_type_distribution,
        "risk_count": sum(1 for s in best_rows if s["risk"]),
        "leader_count": sum(1 for s in best_rows if s["leader"]),
        "worst_param": worst_param,
        "worst_param_avg": group_profile.get(worst_param) if worst_param else None,
        "top3": top3,
        "bottom3": bottom3,
    }


def _require_admin_or_self(current_user: Optional[Dict]) -> bool:
    """Проверка прав: admin/superuser или сам пользователь."""
    if not current_user:
        return False
    return current_user.get("role") in ("admin", "superuser")


def _assert_admin_session_allowed(
    current_user: Optional[Dict[str, Any]],
    session_user_id: Optional[int],
) -> None:
    allowed = participant_user_ids_visible_to_viewer(current_user)
    if allowed is None:
        return
    viewer_id = current_user.get("id") if current_user else None
    if (
        session_user_id is not None
        and viewer_id is not None
        and int(session_user_id) == int(viewer_id)
    ):
        # Админ/методист с ролью admin играет под своим аккаунтом — сессии в «Мои отчёты» привязаны к его user_id,
        # но participant_user_ids_for_group возвращает только участников с role=user, без самого админа.
        return
    if not allowed or session_user_id is None or session_user_id not in allowed:
        raise HTTPException(status_code=403, detail="Нет доступа к данным этой сессии")


def _assert_dashboard_user_in_scope(
    filter_user_id: Optional[int],
    current_user: Optional[Dict[str, Any]],
) -> None:
    """filter_user_id должен входить в видимую группу (или фильтр не задан)."""
    if filter_user_id is None:
        return
    allowed = participant_user_ids_visible_to_viewer(current_user)
    if allowed is None:
        return
    if filter_user_id not in allowed:
        raise HTTPException(status_code=403, detail="Нет доступа к данным этого участника")


def _compute_soft_skills_aggregate(session_ids: List[str]) -> Dict[str, Any]:
    """Агрегат soft skills для overview."""
    if not session_ids:
        return {}
    batch = load_behavior_batch(session_ids)
    styles: Counter = Counter()
    arg_levels: List[float] = []
    risk_aversions: List[float] = []
    reflections: List[float] = []

    for sid in session_ids:
        meta = batch.get(sid) or {}
        sk = meta.get("soft_skills") or {}
        if not sk:
            continue
        stl = sk.get("negotiation_style")
        if isinstance(stl, str) and stl.strip():
            styles[stl.strip()] += 1
        for key, bucket in (
            ("argumentation_level", arg_levels),
            ("risk_aversion", risk_aversions),
            ("self_reflection", reflections),
        ):
            v = sk.get(key)
            if isinstance(v, (int, float)):
                bucket.append(float(v))

    return {
        "negotiation_styles": [{"style": k, "count": v} for k, v in styles.most_common()],
        "avg_argumentation": round(sum(arg_levels) / len(arg_levels), 2) if arg_levels else None,
        "avg_risk_aversion": round(sum(risk_aversions) / len(risk_aversions), 2) if risk_aversions else None,
        "avg_self_reflection": round(sum(reflections) / len(reflections), 2) if reflections else None,
        "sample_size": len(session_ids),
    }


def _max_updated_at_from_sessions(sessions: List[Dict[str, Any]]) -> Optional[str]:
    """Максимальный updated_at среди сессий (ISO-строки из БД, лексикографически сравнимы)."""
    best: Optional[str] = None
    for s in sessions:
        u = s.get("updated_at")
        if not u or not isinstance(u, str):
            continue
        if best is None or u > best:
            best = u
    return best


def _dashboard_load_base_sessions(restrict_user_ids: Optional[List[int]]) -> List[Dict[str, Any]]:
    """Одна выборка «плоскости» дашборда: последние N сессий по видимым участникам (без case/user в SQL)."""
    return _get_sessions_with_normalized(
        case_code=None,
        user_id=None,
        restrict_user_ids=restrict_user_ids,
        limit=DASHBOARD_SESSION_LIMIT,
    )


def _filter_sessions_for_ai_briefing_scope(
    sessions: List[Dict[str, Any]],
    case_code: Optional[str],
    user_id: Optional[int],
) -> List[Dict[str, Any]]:
    """Фильтр case_code + user_id поверх общей выборки (как раньше в WHERE для ai-briefing)."""
    out: List[Dict[str, Any]] = []
    for s in sessions:
        if user_id is not None and s.get("user_id") != user_id:
            continue
        if case_code and (s.get("case_code") or "") != case_code:
            continue
        out.append(s)
    return out


def _ai_briefing_context_payload(
    scoped: List[Dict[str, Any]],
    case_code: Optional[str],
    user_id: Optional[int],
) -> Dict[str, Any]:
    return {
        "latest_session_updated_at": _max_updated_at_from_sessions(scoped),
        "sessions_count": len(scoped),
        "case_code": case_code,
        "filter_user_id": user_id,
    }


def _team_members_from_sessions(sessions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen: Dict[int, str] = {}
    for s in sessions:
        uid = s.get("user_id")
        if uid is None:
            continue
        name = s.get("name") or s.get("username") or f"user_{uid}"
        if uid not in seen:
            seen[int(uid)] = name
    return [{"user_id": uid, "name": nm} for uid, nm in sorted(seen.items(), key=lambda x: (x[1].lower(), x[0]))]


def _get_sessions_with_normalized(
    case_code: Optional[str] = None,
    user_id: Optional[int] = None,
    limit: int = 200,
    restrict_user_ids: Optional[List[int]] = None,
) -> List[Dict[str, Any]]:
    """Загрузить сессии с нормализованным LEXIC из БД.
    restrict_user_ids: None — без ограничения; список — только эти user_id (для админа группы).
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            conditions = []
            params: List[Any] = []

            if case_code:
                conditions.append("gs.case_code = %s")
                params.append(case_code)
            if user_id:
                conditions.append("gs.user_id = %s")
                params.append(user_id)
            if restrict_user_ids is not None:
                conditions.append("gs.user_id = ANY(%s)")
                params.append(restrict_user_ids)

            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

            cur.execute(
                f"""
                SELECT
                    gs.external_id,
                    gs.case_code,
                    gs.user_id,
                    gs.created_at,
                    gs.updated_at,
                    gs.payload_json,
                    gs.total_score_normalized,
                    gs.lexic_l_normalized,
                    gs.lexic_e_normalized,
                    gs.lexic_x_normalized,
                    gs.lexic_i_normalized,
                    gs.lexic_c_normalized,
                    u.username,
                    u.email
                FROM game_session gs
                LEFT JOIN "user" u ON u.id = gs.user_id
                {where}
                ORDER BY gs.created_at DESC
                LIMIT %s
                """,
                params + [limit],
            )
            rows = cur.fetchall()

    result = []
    for row in rows:
        (
            external_id, case_code_, user_id_, created_at, updated_at,
            payload, total_score_norm,
            l_norm, e_norm, x_norm, i_norm, c_norm,
            username, email,
        ) = row

        payload = payload or {}
        raw_lexic = payload.get("lexic") or {}
        current_stage = _coerce_current_stage_index(payload.get("current_stage", 1))

        # Нормализованные или сырые (fallback)
        l = l_norm if l_norm is not None else (raw_lexic.get("L"))
        e = e_norm if e_norm is not None else (raw_lexic.get("E"))
        x = x_norm if x_norm is not None else (raw_lexic.get("X"))
        i = i_norm if i_norm is not None else (raw_lexic.get("I"))
        c = c_norm if c_norm is not None else (raw_lexic.get("C"))

        total = total_score_norm
        if total is None and all(v is not None for v in [l, e, x, i, c]):
            total = sum(v for v in [l, e, x, i, c] if v is not None) / 5

        # Индикаторы
        risk = total is not None and (total < 40 or any(
            v is not None and v < 25 for v in [l, e, x, i, c]
        ))
        leader = total is not None and total > 80 and all(
            v is None or v > 60 for v in [l, e, x, i, c]
        )

        result.append({
            "session_id": external_id,
            "case_code": case_code_,
            "user_id": user_id_,
            "name": username or f"user_{user_id_}" if user_id_ else "Неизвестный",
            "username": username,
            "email": email,
            "current_stage": current_stage,
            "status": "completed" if current_stage and current_stage > 4 else "in_progress",
            "created_at": created_at.isoformat() if created_at else None,
            "updated_at": updated_at.isoformat() if updated_at else None,
            "L": round(l, 1) if l is not None else None,
            "E": round(e, 1) if e is not None else None,
            "X": round(x, 1) if x is not None else None,
            "I": round(i, 1) if i is not None else None,
            "C": round(c, 1) if c is not None else None,
            "total_score": round(total, 1) if total is not None else None,
            "risk": risk,
            "leader": leader,
        })

    return result


def _get_stage_snapshots_for_sessions(session_ids: List[str]) -> Dict[str, List[Dict]]:
    """Загрузить снимки LEXIC по этапам для набора сессий."""
    if not session_ids:
        return {}
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT session_external_id, stage_code, stage_order,
                       lexic_before, lexic_after, raw_deltas, normalized_scores, weight
                FROM session_lexic_stage
                WHERE session_external_id = ANY(%s)
                ORDER BY session_external_id, stage_order ASC
                """,
                (session_ids,),
            )
            rows = cur.fetchall()

    by_session: Dict[str, List[Dict]] = {}
    for row in rows:
        sid, stage_code, stage_order, lb, la, rd, ns, w = row
        by_session.setdefault(sid, []).append({
            "stage_code": stage_code,
            "stage_order": stage_order,
            "lexic_before": lb or {},
            "lexic_after": la or {},
            "raw_deltas": rd or {},
            "normalized_scores": ns or {},
            "weight": float(w) if w else 0.25,
        })
    return by_session


# ---------------------------------------------------------------------------
# Эндпоинты
# ---------------------------------------------------------------------------


@router.get("/dashboard/overview")
async def dashboard_overview(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None, description="Сузить метрики до одного участника группы"),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """KPI для дашборда: уникальные участники, попытки, разбивка по кейсам, лучшая попытка на (user, case)."""

    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    all_sessions = _dashboard_load_base_sessions(allowed)
    team_members = _team_members_from_sessions(all_sessions)
    sessions_scope = [s for s in all_sessions if user_id is None or s.get("user_id") == user_id]
    ai_scope = _filter_sessions_for_ai_briefing_scope(all_sessions, case_code, user_id)
    ai_briefing_context = _ai_briefing_context_payload(ai_scope, case_code, user_id)

    unique_users = len({s["user_id"] for s in sessions_scope if s.get("user_id") is not None})
    sessions_total = len(sessions_scope)

    if not sessions_scope:
        return {
            "unique_users": 0,
            "sessions_total": 0,
            "case_codes": [],
            "by_case": {},
            "reference_profile": DEFAULT_REFERENCE,
            "industry_reference_profile": industry_reference_from_env(),
            "active_case": case_code,
            "active_metrics": None,
            "team_members": team_members,
            "filter_user_id": user_id,
            "ai_briefing_context": ai_briefing_context,
            "total": 0,
            "completion_rate": 0.0,
            "avg_score": None,
            "group_profile": None,
            "risk_count": 0,
            "leader_count": 0,
            "worst_param": None,
        }

    codes = sorted({(s.get("case_code") or "") for s in sessions_scope if (s.get("case_code") or "")})
    by_case: Dict[str, Any] = {}
    for cc in codes:
        raw_case = [s for s in sessions_scope if (s.get("case_code") or "") == cc]
        best = best_sessions_per_user_case(raw_case)
        kpi = _kpi_from_rows(best)
        kpi["case_code"] = cc
        kpi["sessions_total"] = len(raw_case)
        kpi["reference_profile"] = DEFAULT_REFERENCE
        by_case[cc] = kpi

    active_metrics = by_case.get(case_code) if case_code else None

    # Сводка «все кейсы»: средний балл как среднее по кейсам (вес = число участников в кейсе)
    weighted_sum = 0.0
    weighted_n = 0
    for _cc, block in by_case.items():
        p = block.get("participants") or 0
        a = block.get("avg_score")
        if a is not None and p:
            weighted_sum += a * p
            weighted_n += p
    cross_avg = round(weighted_sum / weighted_n, 1) if weighted_n else None

    industry_ref = industry_reference_from_env()

    all_best = best_sessions_per_user_case(sessions_scope)
    soft_skills_agg = _compute_soft_skills_aggregate([s["session_id"] for s in all_best])

    case_titles = get_case_titles_by_codes(DATA_DIR, codes) if codes else {}

    return {
        "unique_users": unique_users,
        "sessions_total": sessions_total,
        "case_codes": codes,
        "case_titles": case_titles,
        "by_case": by_case,
        "reference_profile": DEFAULT_REFERENCE,
        "industry_reference_profile": industry_ref,
        "active_case": case_code,
        "active_metrics": active_metrics,
        "cross_case_avg_score": cross_avg,
        "team_members": team_members,
        "filter_user_id": user_id,
        "soft_skills_aggregate": soft_skills_agg,
        # плоские поля для активного кейса или первой доступной метрики
        **(
            {
                "total": active_metrics["participants"],
                "completed": active_metrics["completed"],
                "completion_rate": active_metrics["completion_rate"],
                "avg_score": active_metrics["avg_score"],
                "group_profile": active_metrics["group_profile"],
                "risk_count": active_metrics["risk_count"],
                "leader_count": active_metrics["leader_count"],
                "worst_param": active_metrics["worst_param"],
                "worst_param_avg": active_metrics["worst_param_avg"],
                "top3": active_metrics["top3"],
                "bottom3": active_metrics["bottom3"],
            }
            if active_metrics
            else {
                "total": unique_users,
                "completed": None,
                "completion_rate": None,
                "avg_score": cross_avg,
                "group_profile": None,
                "risk_count": None,
                "leader_count": None,
                "worst_param": None,
                "worst_param_avg": None,
                "top3": [],
                "bottom3": [],
            }
        ),
        "ai_briefing_context": ai_briefing_context,
    }


@router.get("/dashboard/participants")
async def dashboard_participants(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None, description="Только этот участник"),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> List[Dict[str, Any]]:
    """Сводная таблица: одна строка на пару (участник × кейс), лучшая попытка; поле attempts_count."""
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    raw = _get_sessions_with_normalized(
        case_code=case_code,
        user_id=user_id,
        restrict_user_ids=allowed,
        limit=DASHBOARD_SESSION_LIMIT,
    )
    counts = _attempt_counts(raw)
    best = best_sessions_per_user_case(raw)
    session_ids = [s["session_id"] for s in best]
    snapshots_by_session = _get_stage_snapshots_for_sessions(session_ids)

    by_user_case: Dict[tuple, List[Dict]] = {}
    for s in raw:
        uid = s.get("user_id")
        cc = s.get("case_code") or ""
        if uid is not None:
            by_user_case.setdefault((uid, cc), []).append(s)

    out: List[Dict[str, Any]] = []
    for s in best:
        row = dict(s)
        uid = row.get("user_id")
        cc = row.get("case_code") or ""
        row["attempts_count"] = counts.get((uid, cc), 0) if uid is not None else 0
        row["stage_snapshots"] = snapshots_by_session.get(row["session_id"], [])
        row["row_key"] = f"{uid}:{cc}" if uid is not None else row["session_id"]

        all_attempts = by_user_case.get((uid, cc), [])
        spark_scores = sorted(
            [(a.get("created_at") or "", a.get("total_score")) for a in all_attempts if a.get("total_score") is not None],
            key=lambda x: x[0],
        )
        row["spark_data"] = [round(sc, 1) for _, sc in spark_scores]

        c_at = s.get("created_at") or ""
        u_at = s.get("updated_at") or ""
        if c_at and u_at:
            try:
                from services.dashboard_insights_service import _parse_iso_dt
                c_dt = _parse_iso_dt(c_at)
                u_dt = _parse_iso_dt(u_at)
                if c_dt and u_dt:
                    row["time_spent_seconds"] = max(0, int((u_dt - c_dt).total_seconds()))
                else:
                    row["time_spent_seconds"] = None
            except Exception:
                row["time_spent_seconds"] = None
        else:
            row["time_spent_seconds"] = None

        out.append(row)

    enrich_session_rows(out)
    return out


@router.get("/dashboard/behavior")
async def dashboard_behavior(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Поведенческие агрегаты и кластеры LEXIC по лучшим сессиям (как в таблице участников)."""
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    raw = _get_sessions_with_normalized(
        case_code=case_code,
        user_id=user_id,
        restrict_user_ids=allowed,
        limit=DASHBOARD_SESSION_LIMIT,
    )
    best = best_sessions_per_user_case(raw)
    session_ids = [s["session_id"] for s in best]
    behavior = aggregate_behavior_insights(session_ids)

    clusters: Dict[str, List[Dict]] = {}
    for s in best:
        lexic = {p: s[p] or 50 for p in LEXIC_PARAMS}
        ptype = classify_participant(lexic)
        t = ptype.get("type", "developing")
        clusters.setdefault(t, []).append({
            "name": s["name"],
            "session_id": s["session_id"],
            "score": s["total_score"],
            "case_code": s.get("case_code"),
            "profile_label": ptype.get("label", ""),
        })

    cluster_out = {
        k: {
            "count": len(v),
            "label": (v[0].get("profile_label") if v else "") or "",
            "participants": v[:12],
        }
        for k, v in clusters.items()
    }

    return {
        "case_code": case_code,
        "filter_user_id": user_id,
        "behavior": behavior,
        "clusters": cluster_out,
    }


def _dashboard_best_and_snapshots(
    case_code: Optional[str],
    user_id: Optional[int],
    current_user: Optional[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, List[Dict]], Dict[tuple, int]]:
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    raw = _get_sessions_with_normalized(
        case_code=case_code,
        user_id=user_id,
        restrict_user_ids=allowed,
        limit=DASHBOARD_SESSION_LIMIT,
    )
    best = best_sessions_per_user_case(raw)
    session_ids = [s["session_id"] for s in best]
    snapshots_by_session = _get_stage_snapshots_for_sessions(session_ids)
    ac = _attempt_counts(raw)
    return raw, best, snapshots_by_session, ac


@router.get("/dashboard/system-gaps")
async def dashboard_system_gaps(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Средние LEXIC по этапам (снимки), зоны и рекомендации."""
    _raw, best, snapshots_by_session, _ac = _dashboard_best_and_snapshots(case_code, user_id, current_user)
    gaps = compute_system_gaps(best, snapshots_by_session)
    gaps["case_code"] = case_code
    gaps["filter_user_id"] = user_id
    return gaps


@router.get("/dashboard/priorities")
async def dashboard_priorities(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Эвристические приоритеты вмешательства."""
    _raw, best, _snaps, _ac = _dashboard_best_and_snapshots(case_code, user_id, current_user)
    out = compute_priorities(best)
    out["case_code"] = case_code
    out["filter_user_id"] = user_id
    return out


@router.get("/dashboard/trends")
async def dashboard_trends(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Динамика средних LEXIC по месяцам (завершённые сессии)."""
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    out = compute_trends(
        restrict_user_ids=allowed,
        case_code=case_code,
        user_id=user_id,
    )
    out["case_code"] = case_code
    out["filter_user_id"] = user_id
    return out


@router.get("/dashboard/proxy-roi")
async def dashboard_proxy_roi(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Прокси эффективности: длительность, завершение, дельта между попытками."""
    raw, best, _snaps, ac = _dashboard_best_and_snapshots(case_code, user_id, current_user)
    out = compute_proxy_roi(raw, best, ac)
    out["case_code"] = case_code
    out["filter_user_id"] = user_id
    return out


@router.get("/dashboard/correlations")
async def dashboard_correlations(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    min_n: int = Query(15, ge=5, le=500),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Ориентировочная корреляция сообщений тьютора с итоговым баллом."""
    _raw, best, _snaps, _ac = _dashboard_best_and_snapshots(case_code, user_id, current_user)
    out = compute_correlations(best, min_n=min_n)
    out["case_code"] = case_code
    out["filter_user_id"] = user_id
    return out


@router.get("/dashboard/ai-briefing-context")
async def dashboard_ai_briefing_context(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Те же данные, что overview.ai_briefing_context: одна «плоскость» сессий + фильтр в памяти (без LLM)."""
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    base = _dashboard_load_base_sessions(allowed)
    scoped = _filter_sessions_for_ai_briefing_scope(base, case_code, user_id)
    return _ai_briefing_context_payload(scoped, case_code, user_id)


@router.get("/dashboard/ai-briefing")
async def dashboard_ai_briefing(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """AI-сгенерированный брифинг по команде: SWOT, alerts, action items."""
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    raw = _filter_sessions_for_ai_briefing_scope(
        _dashboard_load_base_sessions(allowed),
        case_code,
        user_id,
    )
    data_waterline = _max_updated_at_from_sessions(raw)
    generated_at = datetime.now(timezone.utc).isoformat()
    best = best_sessions_per_user_case(raw)

    if not best:
        return {
            "briefing_text": "Недостаточно данных для формирования аналитического брифинга.",
            "alerts": [],
            "swot": {"strengths": [], "weaknesses": [], "opportunities": [], "threats": []},
            "action_items": [],
            "generated_at": generated_at,
            "data_latest_session_updated_at": data_waterline,
        }

    kpi = _kpi_from_rows(best)
    session_ids = [s["session_id"] for s in best]
    behavior = aggregate_behavior_insights(session_ids)
    snapshots_by_session = _get_stage_snapshots_for_sessions(session_ids)
    gaps = compute_system_gaps(best, snapshots_by_session)

    out = _build_ai_briefing(kpi, behavior, gaps, best, case_code)
    out["generated_at"] = generated_at
    out["data_latest_session_updated_at"] = data_waterline
    return out


def _build_ai_briefing(
    kpi: Dict[str, Any],
    behavior: Dict[str, Any],
    gaps: Dict[str, Any],
    best_rows: List[Dict[str, Any]],
    case_code: Optional[str],
) -> Dict[str, Any]:
    """Формирует AI-брифинг через LLM или детерминированный fallback."""
    gp = kpi.get("group_profile") or {}
    avg_score = kpi.get("avg_score")
    n = kpi.get("participants", 0)
    risk_count = kpi.get("risk_count", 0)
    leader_count = kpi.get("leader_count", 0)
    completion_rate = kpi.get("completion_rate", 0)

    alerts: List[Dict[str, str]] = []
    if risk_count > 0:
        alerts.append({
            "level": "warning",
            "text": f"{risk_count} участник(ов) в группе риска (итоговый балл < 40 или ось LEXIC < 25).",
        })
    incomplete = n - kpi.get("completed", 0)
    if incomplete > 0:
        alerts.append({
            "level": "info",
            "text": f"{incomplete} участник(ов) ещё не завершили кейс.",
        })
    worst = kpi.get("worst_param")
    worst_avg = kpi.get("worst_param_avg")
    if worst and worst_avg is not None and worst_avg < 60:
        param_names = {"L": "Легитимность", "E": "Эффективность", "X": "Экспертиза", "I": "Интересы", "C": "Ясность"}
        alerts.append({
            "level": "warning",
            "text": f"Системно слабый параметр: {param_names.get(worst, worst)} (среднее {_to_10_scale(worst_avg)} / 10).",
        })

    strengths: List[str] = []
    weaknesses: List[str] = []
    opportunities: List[str] = []
    threats: List[str] = []

    param_names = {"L": "Легитимность", "E": "Эффективность", "X": "Экспертиза", "I": "Интересы", "C": "Ясность"}
    for p in LEXIC_PARAMS:
        v = gp.get(p)
        if v is None:
            continue
        v10 = _to_10_scale(v)
        if v >= 75:
            strengths.append(f"{param_names.get(p, p)}: {v10} / 10 (выше эталона)")
        elif v < 55:
            weaknesses.append(f"{param_names.get(p, p)}: {v10} / 10 (значительно ниже нормы)")
        elif v < 65:
            weaknesses.append(f"{param_names.get(p, p)}: {v10} / 10 (ниже нормы)")

    if leader_count > 0:
        strengths.append(f"{leader_count} участник(ов) показывают лидерский потенциал")
    if completion_rate and completion_rate > 0.8:
        strengths.append(f"Высокий уровень вовлечённости: {round(completion_rate * 100)}% завершили кейс")

    if risk_count > 0:
        threats.append(f"{risk_count} участник(ов) в группе риска требуют индивидуального внимания")

    for stage_info in gaps.get("stages", []):
        zone = stage_info.get("zone")
        label = stage_info.get("label", "")
        if zone == "critical":
            threats.append(f"{label}: критическая зона, требуется системное вмешательство")
        elif zone == "attention":
            opportunities.append(f"{label}: есть потенциал роста при целевой работе")
        elif zone == "strong":
            strengths.append(f"{label}: команда уверенно справляется")

    neg_styles = behavior.get("negotiation_styles") or []
    if neg_styles:
        dominant = neg_styles[0].get("style", "")
        if dominant:
            opportunities.append(f"Доминирующий стиль переговоров: {dominant} — можно развивать альтернативные подходы")

    action_items: List[str] = []
    if risk_count > 0:
        action_items.append("Провести индивидуальные встречи с участниками группы риска для выявления блокеров.")
    for stage_info in gaps.get("stages", []):
        if stage_info.get("zone") == "critical":
            action_items.append(stage_info.get("recommendation", ""))
    if worst and worst_avg is not None and worst_avg < 60:
        action_items.append(f"Организовать целевой тренинг по {param_names.get(worst, worst)} для всей команды.")
    if not action_items:
        action_items.append("Поддерживать текущий уровень, закрепляя практикой и разбором успешных кейсов.")

    briefing_parts: List[str] = []
    briefing_parts.append(
        f"В группе {n} участник(ов)"
        + (f" по кейсу {case_code}" if case_code else "")
        + f". Средний балл команды: {_to_10_scale(avg_score) if avg_score is not None else '—'} / 10."
        + f" Завершили: {round(completion_rate * 100)}%."
    )
    if strengths:
        briefing_parts.append("Сильные стороны: " + "; ".join(strengths[:3]) + ".")
    if weaknesses:
        briefing_parts.append("Зоны развития: " + "; ".join(weaknesses[:3]) + ".")
    if threats:
        briefing_parts.append("Внимание: " + "; ".join(threats[:2]) + ".")

    try:
        briefing_text = _generate_ai_briefing_text(kpi, behavior, gaps, best_rows, case_code)
        if briefing_text:
            briefing_parts = [briefing_text]
    except Exception as exc:
        log.warning("AI briefing LLM fallback: %s", exc)

    return {
        "briefing_text": " ".join(briefing_parts),
        "alerts": alerts,
        "swot": {
            "strengths": strengths,
            "weaknesses": weaknesses,
            "opportunities": opportunities,
            "threats": threats,
        },
        "action_items": action_items,
    }


def _generate_ai_briefing_text(
    kpi: Dict[str, Any],
    behavior: Dict[str, Any],
    gaps: Dict[str, Any],
    best_rows: List[Dict[str, Any]],
    case_code: Optional[str],
) -> Optional[str]:
    """LLM-генерация текста брифинга (если call_openai доступен)."""
    try:
        from services.ai_chat_service import call_openai
    except ImportError:
        return None

    gp = kpi.get("group_profile") or {}
    param_lines = ", ".join(
        f"{p}: {_to_10_scale(gp[p]) if gp.get(p) is not None else '—'}/10"
        for p in LEXIC_PARAMS
    )
    stages_lines = "; ".join(
        f"{s['label']}: среднее {_to_10_scale(s['overall_avg']) if s.get('overall_avg') is not None else '—'}/10, зона {s.get('zone', '—')}"
        for s in gaps.get("stages", [])
    )

    prompt = f"""Данные по группе в симуляторе (шкала баллов 0–10):
- Участников: {kpi.get('participants', 0)}, завершили: {kpi.get('completed', 0)} ({round((kpi.get('completion_rate') or 0) * 100)}%)
- Средний балл: {_to_10_scale(kpi['avg_score']) if kpi.get('avg_score') is not None else '—'}/10, стд. откл.: {kpi.get('score_std_dev', '—')}
- Профиль LEXIC (средние): {param_lines}
- В группе риска: {kpi.get('risk_count', 0)}, лидеров: {kpi.get('leader_count', 0)}
- Этапы: {stages_lines}
- Аргументация (ср.): {behavior.get('avg_argumentation_level', '—')}, осторожность: {behavior.get('avg_risk_aversion', '—')}

Сформируй краткий аналитический брифинг (2–3 абзаца) на русском для руководителя юридического отдела: ключевой вывод, сильные стороны, зоны роста, 2–3 рекомендации. Обращение на «Вы». Числа указывай по шкале 0–10, не переводи в проценты."""

    payload = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 800,
        "temperature": 0.5,
    }

    try:
        raw = call_openai(payload, timeout=15)
        if raw and len(raw) > 50:
            return raw.strip()
    except Exception as exc:
        log.warning("AI briefing generation failed: %s", exc)
    return None


@router.get("/dashboard/performance-distribution")
async def dashboard_performance_distribution(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Распределение результатов: квартили, гистограмма, box-plot данные."""
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    raw = _get_sessions_with_normalized(
        case_code=case_code,
        user_id=user_id,
        restrict_user_ids=allowed,
        limit=DASHBOARD_SESSION_LIMIT,
    )
    best = best_sessions_per_user_case(raw)

    if not best:
        return {
            "histogram": [],
            "box_plot": None,
            "quartile_groups": {"q1": [], "q2": [], "q3": [], "q4": []},
            "score_tiers": {},
        }

    scores = sorted([s["total_score"] for s in best if s["total_score"] is not None])
    scored_rows = sorted(
        [s for s in best if s["total_score"] is not None],
        key=lambda s: s["total_score"],
    )

    bins = [
        {"label": f"{_to_10_scale(0)}-{_to_10_scale(20)}", "min": 0, "max": 20, "count": 0, "tier": "poor"},
        {"label": f"{_to_10_scale(20)}-{_to_10_scale(40)}", "min": 20, "max": 40, "count": 0, "tier": "poor"},
        {"label": f"{_to_10_scale(40)}-{_to_10_scale(55)}", "min": 40, "max": 55, "count": 0, "tier": "fair"},
        {"label": f"{_to_10_scale(55)}-{_to_10_scale(70)}", "min": 55, "max": 70, "count": 0, "tier": "good"},
        {"label": f"{_to_10_scale(70)}-{_to_10_scale(85)}", "min": 70, "max": 85, "count": 0, "tier": "good"},
        {"label": f"{_to_10_scale(85)}-{_to_10_scale(100)}", "min": 85, "max": 101, "count": 0, "tier": "excellent"},
    ]
    for sc in scores:
        for b in bins:
            if b["min"] <= sc < b["max"]:
                b["count"] += 1
                break

    box_plot = None
    if scores:
        n = len(scores)
        q1_idx = n // 4
        q3_idx = 3 * n // 4
        box_plot = {
            "min": round(scores[0], 1),
            "q1": round(scores[q1_idx], 1),
            "median": round(scores[n // 2], 1),
            "q3": round(scores[q3_idx], 1),
            "max": round(scores[-1], 1),
            "mean": round(sum(scores) / n, 1),
        }

    quartile_groups: Dict[str, List[Dict]] = {"q1": [], "q2": [], "q3": [], "q4": []}
    if scored_rows:
        chunk = max(1, len(scored_rows) // 4)
        for i, s in enumerate(scored_rows):
            entry = {
                "name": s["name"],
                "session_id": s["session_id"],
                "total_score": s["total_score"],
                "case_code": s.get("case_code"),
            }
            if i < chunk:
                quartile_groups["q1"].append(entry)
            elif i < chunk * 2:
                quartile_groups["q2"].append(entry)
            elif i < chunk * 3:
                quartile_groups["q3"].append(entry)
            else:
                quartile_groups["q4"].append(entry)

    tier_counts: Counter = Counter()
    for sc in scores:
        if sc >= 82:
            tier_counts["excellent"] += 1
        elif sc >= 54:
            tier_counts["good"] += 1
        elif sc >= 42:
            tier_counts["fair"] += 1
        else:
            tier_counts["poor"] += 1

    return {
        "histogram": [{"label": b["label"], "count": b["count"], "tier": b["tier"]} for b in bins],
        "box_plot": box_plot,
        "quartile_groups": quartile_groups,
        "score_tiers": dict(tier_counts),
        "total_scored": len(scores),
    }


@router.get("/dashboard/participant/{session_id}/detail")
async def get_participant_detail(
    session_id: str,
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Полные данные участника для drill-down: отчёт + нормализованный профиль."""

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT user_id FROM game_session WHERE external_id = %s",
                (session_id,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    _assert_admin_session_allowed(current_user, row[0])

    return await _participant_detail_body(session_id)


async def _participant_detail_body(session_id: str) -> Dict[str, Any]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT payload_json, user_id FROM game_session WHERE external_id = %s",
                (session_id,),
            )
            row = cur.fetchone()

    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="Сессия не найдена")

    payload = row[0]
    gs_user_id = row[1]
    session = dict(payload)
    if not _resolve_session_external_id(session):
        session["id"] = session_id
    if not session.get("lexic"):
        session["lexic"] = {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50}

    # Завершённые сессии без актуального report_snapshot: один раз фиксируем снимок (нарратив + при необходимости stage3_detail)
    session, cached_report = ensure_case_report_snapshot(DATA_DIR, session)
    if cached_report is not None:
        try:
            save_game_session(session, user_id=gs_user_id)
        except Exception:
            pass

    preloaded_case: Optional[Dict[str, Any]] = None
    if cached_report is None and _report_snapshot_is_current(session.get("report_snapshot") or {}):
        try:
            preloaded_case = get_case(
                DATA_DIR, session.get("case_id") or session.get("case_code")
            )
        except Exception:
            preloaded_case = None

    # Нормализованный профиль: из payload, иначе один расчёт из БД (без LLM)
    norm_profile = session.get("lexic_normalized") or {}
    if not norm_profile:
        try:
            norm_profile = compute_full_normalized_profile(
                session_id,
                raw_lexic=session.get("lexic"),
            )
        except Exception:
            norm_profile = {}

    session["lexic_normalized"] = norm_profile

    # Полный отчёт из данных сессии и БД
    try:
        if cached_report is not None:
            report = cached_report
        else:
            report = generate_report(
                DATA_DIR, session, case_data=preloaded_case
            )
    except Exception as e:
        # Fallback: минимальный отчёт
        report = {
            "session_id": session_id,
            "final_lexic": session.get("lexic", {}),
            "lexic_normalized": norm_profile,
            "error": str(e),
        }

    return report


@router.get("/dashboard/stages-matrix")
async def get_stages_matrix(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Матрица прогресса по лучшей сессии на (участник × кейс)."""
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    raw = _get_sessions_with_normalized(
        case_code=case_code,
        user_id=user_id,
        restrict_user_ids=allowed,
        limit=DASHBOARD_SESSION_LIMIT,
    )
    best = best_sessions_per_user_case(raw)
    ac = _attempt_counts(raw)
    session_ids = [s["session_id"] for s in best]
    snapshots_by_session = _get_stage_snapshots_for_sessions(session_ids)

    matrix = []
    for s in best:
        snaps = snapshots_by_session.get(s["session_id"], [])
        stages_data = {}
        for snap in snaps:
            ns = snap.get("normalized_scores") or {}
            vals = [v for v in ns.values() if v is not None]
            avg = round(sum(vals) / len(vals), 1) if vals else None
            stages_data[snap["stage_code"]] = {
                "avg": avg,
                "normalized_scores": ns,
                "completed": True,
            }
        matrix.append({
            "session_id": s["session_id"],
            "user_id": s.get("user_id"),
            "case_code": s.get("case_code"),
            "name": s["name"],
            "total_score": s["total_score"],
            "risk": s["risk"],
            "leader": s["leader"],
            "attempts_count": ac.get((s.get("user_id"), s.get("case_code") or ""), 0),
            "stages": stages_data,
        })

    return {"matrix": matrix, "total": len(matrix)}


@router.get("/report/participant/{session_id}")
async def get_participant_report(
    session_id: str,
    current_user: Optional[Dict] = Depends(get_current_user),
) -> Dict[str, Any]:
    """Полный нормализованный отчёт для участника (по его session_id)."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT user_id FROM game_session WHERE external_id = %s",
                (session_id,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    session_uid = row[0]

    if current_user:
        user_id = current_user.get("id")
        role = current_user.get("role")
        if role not in ("admin", "superuser") and user_id:
            if session_uid != user_id:
                raise HTTPException(status_code=403, detail="Доступ запрещён")
        elif role == "admin":
            _assert_admin_session_allowed(current_user, session_uid)

    return await _participant_detail_body(session_id)


@router.get("/report/admin/group")
async def get_admin_group_report(
    case_code: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """Аналитический отчёт по группе: лучшая попытка на (участник × кейс)."""
    _assert_dashboard_user_in_scope(user_id, current_user)
    allowed = participant_user_ids_visible_to_viewer(current_user)
    raw = _get_sessions_with_normalized(
        case_code=case_code,
        user_id=user_id,
        restrict_user_ids=allowed,
        limit=DASHBOARD_SESSION_LIMIT,
    )
    ac = _attempt_counts(raw)
    sessions = best_sessions_per_user_case(raw)
    session_ids = [s["session_id"] for s in sessions]
    snapshots_by_session = _get_stage_snapshots_for_sessions(session_ids)

    if not sessions:
        return {"participants": [], "group_profile": None, "stats": {}}

    # Агрегированный профиль
    group_profile = {}
    for p in LEXIC_PARAMS:
        vals = [s[p] for s in sessions if s[p] is not None]
        group_profile[p] = round(sum(vals) / len(vals), 1) if vals else None

    # Статистика
    scores = [s["total_score"] for s in sessions if s["total_score"] is not None]
    avg_score = round(sum(scores) / len(scores), 1) if scores else None
    if len(scores) > 1:
        variance = sum((s - avg_score) ** 2 for s in scores) / len(scores)
        std_dev = round(math.sqrt(variance), 1)
    else:
        std_dev = 0.0

    # Кластеризация
    clusters: Dict[str, List[Dict]] = {}
    for s in sessions:
        lexic = {p: s[p] or 50 for p in LEXIC_PARAMS}
        ptype = classify_participant(lexic)
        t = ptype.get("type", "developing")
        clusters.setdefault(t, []).append({
            "name": s["name"],
            "session_id": s["session_id"],
            "score": s["total_score"],
            "case_code": s.get("case_code"),
        })

    # Проблемные этапы: по avg normalized_scores
    stage_avgs: Dict[str, Dict[str, List[float]]] = {}
    for sid, snaps in snapshots_by_session.items():
        for snap in snaps:
            sc = snap["stage_code"]
            stage_avgs.setdefault(sc, {})
            for p in LEXIC_PARAMS:
                v = (snap.get("normalized_scores") or {}).get(p)
                if v is not None:
                    stage_avgs[sc].setdefault(p, []).append(v)

    stages_summary = {}
    for sc, param_vals in stage_avgs.items():
        param_avgs = {p: round(sum(vals) / len(vals), 1) for p, vals in param_vals.items() if vals}
        overall_avg = round(sum(param_avgs.values()) / len(param_avgs), 1) if param_avgs else None
        stages_summary[sc] = {
            "param_avgs": param_avgs,
            "overall_avg": overall_avg,
            "participant_count": len({k for k, v in snapshots_by_session.items() if any(s["stage_code"] == sc for s in v)}),
        }

    participants_out = []
    for s in sessions:
        uid = s.get("user_id")
        cc = s.get("case_code") or ""
        participants_out.append({
            **s,
            "attempts_count": ac.get((uid, cc), 0) if uid is not None else 0,
            "stage_snapshots": snapshots_by_session.get(s["session_id"], []),
        })

    return {
        "case_code": case_code,
        "participants": participants_out,
        "group_profile": group_profile,
        "reference_profile": DEFAULT_REFERENCE,
        "stats": {
            "total": len(sessions),
            "avg_score": avg_score,
            "std_dev": std_dev,
            "risk_count": sum(1 for s in sessions if s["risk"]),
            "leader_count": sum(1 for s in sessions if s["leader"]),
        },
        "clusters": {k: {"count": len(v), "participants": v[:10]} for k, v in clusters.items()},
        "stages_summary": stages_summary,
    }
