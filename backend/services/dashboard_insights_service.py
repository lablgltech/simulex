"""
Инсайты дашборда руководителя: системные зоны по этапам, приоритеты, тренды, прокси ROI, корреляции.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from db import get_connection
from services.dashboard_behavior_service import load_behavior_batch
from services.normalization_service import LEXIC_PARAMS

ZONE_CRITICAL = "critical"
ZONE_ATTENTION = "attention"
ZONE_STRONG = "strong"
THRESH_LOW = 60.0
THRESH_HIGH = 75.0

STALE_DAYS_DEFAULT = 14
LOW_SCORE_HARD = 45.0
LOW_SCORE_SOFT = 55.0
MISSED_RISKS_HIGH = 4
MISSED_RISKS_MED = 2

STAGE_LABELS = {
    "stage-1": "Этап 1",
    "stage-2": "Этап 2",
    "stage-3": "Этап 3",
    "stage-4": "Этап 4",
}


def industry_reference_from_env() -> Optional[Dict[str, float]]:
    raw = os.getenv("INDUSTRY_LEXIC_JSON", "").strip()
    if not raw:
        return None
    try:
        d = json.loads(raw)
        if not isinstance(d, dict):
            return None
        out: Dict[str, float] = {}
        for p in LEXIC_PARAMS:
            v = d.get(p)
            if v is not None:
                out[p] = float(v)
        return out if out else None
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def _zone_for_avg(avg: Optional[float]) -> str:
    if avg is None:
        return ZONE_ATTENTION
    if avg < THRESH_LOW:
        return ZONE_CRITICAL
    if avg < THRESH_HIGH:
        return ZONE_ATTENTION
    return ZONE_STRONG


def _recommendation_for_stage(stage_code: str, zone: str, param_avgs: Dict[str, float]) -> str:
    """Шаблоны рекомендаций без LLM."""
    weakest = None
    if param_avgs:
        with_vals = [(p, v) for p, v in param_avgs.items() if v is not None]
        if with_vals:
            weakest = min(with_vals, key=lambda x: x[1])[0]
    if zone == ZONE_STRONG:
        return "Поддерживать уровень: закрепить практикой и разбором успешных кейсов."

    if stage_code == "stage-2":
        if zone != ZONE_STRONG:
            return "Воркшоп по матрице рисков и проверке допущений; разбор пропущенных рисков на этапе 2."
    if stage_code == "stage-3":
        return "Ролевые переговоры с обратной связью по тактике и устойчивости позиции."
    if stage_code == "stage-4":
        return "Тренинг по фиксации договорённостей и контролю исполнения."
    if stage_code == "stage-1":
        return "Структурирование подготовки: цели, зоны торга, критерии успеха до входа в диалог."

    if weakest == "I":
        return "Тренинг по балансу интересов и защите позиции без уступок сверх разумного."
    if weakest == "C":
        return "Практика ясных формулировок и проверки понимания (перефраз, резюме раундов)."
    if weakest == "L":
        return "Разбор легитимности позиции и аргументации (нормы, факты, последовательность)."
    if weakest == "E":
        return "Фокус на эффективности: приоритизация тем, тайм-менеджмент в переговорах."
    if weakest == "X":
        return "Углубление предметной экспертизы по предмету сделки и типовым возражениям."

    return "Индивидуальный разбор с участником и целевое мини-обучение по слабым параметрам LEXIC."


def compute_system_gaps(
    best_rows: List[Dict[str, Any]],
    snapshots_by_session: Dict[str, List[Dict[str, Any]]],
) -> Dict[str, Any]:
    """
    Агрегаты normalized_scores по stage_code по лучшим сессиям.
    """
    stage_param_vals: Dict[str, Dict[str, List[float]]] = {}
    for s in best_rows:
        sid = s.get("session_id")
        if not sid:
            continue
        for snap in snapshots_by_session.get(sid, []):
            sc = snap.get("stage_code")
            if not sc:
                continue
            ns = snap.get("normalized_scores") or {}
            stage_param_vals.setdefault(sc, {})
            for p in LEXIC_PARAMS:
                v = ns.get(p)
                if v is not None:
                    stage_param_vals[sc].setdefault(p, []).append(float(v))

    stage_order = ["stage-1", "stage-2", "stage-3", "stage-4"]
    stages_out: List[Dict[str, Any]] = []
    heatmap: Dict[str, Dict[str, Optional[float]]] = {}

    for sc in stage_order:
        pv = stage_param_vals.get(sc, {})
        if not pv:
            continue
        param_avgs: Dict[str, Optional[float]] = {}
        for p in LEXIC_PARAMS:
            vals = pv.get(p, [])
            param_avgs[p] = round(sum(vals) / len(vals), 1) if vals else None
        nums = [v for v in param_avgs.values() if v is not None]
        overall = round(sum(nums) / len(nums), 1) if nums else None
        zone = _zone_for_avg(overall)
        heatmap[sc] = dict(param_avgs)
        stages_out.append({
            "stage_code": sc,
            "label": STAGE_LABELS.get(sc, sc),
            "param_avgs": param_avgs,
            "overall_avg": overall,
            "zone": zone,
            "recommendation": _recommendation_for_stage(sc, zone, {k: v for k, v in param_avgs.items() if v is not None}),
            "participant_count": len({s["session_id"] for s in best_rows if any(
                x.get("stage_code") == sc for x in snapshots_by_session.get(s["session_id"], [])
            )}),
        })

    bar_by_stage = [
        {"stage_code": s["stage_code"], "label": s["label"], "overall_avg": s["overall_avg"]}
        for s in stages_out
    ]

    return {
        "stages": stages_out,
        "heatmap": heatmap,
        "bar_by_stage": bar_by_stage,
        "thresholds": {"low": THRESH_LOW, "high": THRESH_HIGH},
    }


def _parse_iso_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        s2 = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s2)
    except (ValueError, TypeError):
        return None


def compute_priorities(
    best_rows: List[Dict[str, Any]],
    stale_days: int = STALE_DAYS_DEFAULT,
) -> Dict[str, Any]:
    """Эвристические приоритеты вмешательства."""
    if not best_rows:
        return {"items": [], "critical_count": 0}

    ids = [r["session_id"] for r in best_rows if r.get("session_id")]
    batch = load_behavior_batch(ids)
    now = datetime.now(timezone.utc)
    items: List[Dict[str, Any]] = []

    for r in best_rows:
        sid = r.get("session_id")
        uid = r.get("user_id")
        name = r.get("name") or r.get("username") or "—"
        cc = r.get("case_code") or ""
        status = r.get("status")
        total = r.get("total_score")
        updated = _parse_iso_dt(r.get("updated_at"))

        meta = batch.get(sid) if sid else {}
        s2 = (meta or {}).get("stage2_summary") or {}
        missed = s2.get("missed_risks")
        missed_n = int(missed) if missed is not None else None

        stale = False
        if status != "completed" and updated:
            u = updated.replace(tzinfo=timezone.utc) if updated.tzinfo is None else updated.astimezone(timezone.utc)
            delta = now - u
            stale = delta.days >= stale_days

        signals: List[str] = []
        priority = "medium"
        action = "Обсудить цели и план прохождения кейса."

        if stale:
            signals.append("stale_in_progress")
            priority = "high"
            action = "Связаться 1:1: давно нет прогресса по незавершённому кейсу; выяснить блокеры."

        if total is not None and total < LOW_SCORE_HARD:
            signals.append("very_low_score")
            priority = "high"
            action = "Индивидуальный разбор результата; при необходимости повторная попытка с ментором."

        if total is not None and LOW_SCORE_HARD <= total < LOW_SCORE_SOFT and not stale:
            signals.append("low_score")
            if priority != "high":
                priority = "medium"
            action = "Короткая обратная связь по отчёту; точечные материалы по слабым осям LEXIC."

        if missed_n is not None and missed_n >= MISSED_RISKS_HIGH and (total is None or total < LOW_SCORE_SOFT):
            signals.append("high_missed_risks")
            priority = "high"
            action = "Воркшоп по выявлению рисков (этап 2); разбор конкретных пропусков."

        if missed_n is not None and MISSED_RISKS_MED <= missed_n < MISSED_RISKS_HIGH and total is not None and total < LOW_SCORE_SOFT:
            signals.append("moderate_missed_risks")
            if priority == "medium" and "high_missed_risks" not in signals:
                action = "Практика на кейсах с матрицей рисков; чек-лист перед этапом 2."

        if not signals:
            continue

        items.append({
            "session_id": sid,
            "user_id": uid,
            "name": name,
            "case_code": cc,
            "signals": signals,
            "priority": priority,
            "suggested_action": action,
            "total_score": total,
        })

    priority_rank = {"high": 0, "medium": 1, "low": 2}
    items.sort(key=lambda x: (priority_rank.get(x["priority"], 9), -(x["total_score"] or 0)))

    critical_count = sum(1 for x in items if x["priority"] == "high")
    return {"items": items, "critical_count": critical_count, "stale_days": stale_days}


def compute_trends(
    restrict_user_ids: Optional[List[int]],
    case_code: Optional[str],
    user_id: Optional[int],
) -> Dict[str, Any]:
    """Средние LEXIC по месяцам (завершённые сессии: current_stage > 4 в payload)."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            conditions: List[str] = [
                "(gs.payload_json->>'current_stage')::int > 4",
                "gs.total_score_normalized IS NOT NULL",
            ]
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

            where = " AND ".join(conditions)
            cur.execute(
                f"""
                SELECT
                  (date_trunc('month', gs.updated_at))::date AS ym,
                  AVG(gs.lexic_l_normalized),
                  AVG(gs.lexic_e_normalized),
                  AVG(gs.lexic_x_normalized),
                  AVG(gs.lexic_i_normalized),
                  AVG(gs.lexic_c_normalized),
                  AVG(gs.total_score_normalized),
                  COUNT(*)
                FROM game_session gs
                WHERE {where}
                GROUP BY 1
                ORDER BY 1 ASC
                """,
                params,
            )
            rows = cur.fetchall()

    series: List[Dict[str, Any]] = []
    for row in rows:
        ym, al, ae, ax, ai, ac, atot, cnt = row
        if ym is None:
            continue
        series.append({
            "month": ym.isoformat() if hasattr(ym, "isoformat") else str(ym),
            "L": round(float(al), 1) if al is not None else None,
            "E": round(float(ae), 1) if ae is not None else None,
            "X": round(float(ax), 1) if ax is not None else None,
            "I": round(float(ai), 1) if ai is not None else None,
            "C": round(float(ac), 1) if ac is not None else None,
            "total": round(float(atot), 1) if atot is not None else None,
            "sessions": int(cnt),
        })

    return {"series": series}


def compute_proxy_roi(
    raw_sessions: List[Dict[str, Any]],
    best_rows: List[Dict[str, Any]],
    attempt_counts: Dict[Tuple[Optional[int], str], int],
) -> Dict[str, Any]:
    """Прокси: длительность, completion по лучшим строкам, средняя дельта балла между попытками."""
    if not best_rows:
        return {
            "avg_session_hours": None,
            "completion_rate": None,
            "avg_score_delta_repeats": None,
            "repeats_with_delta_count": 0,
        }

    durations_sec: List[float] = []
    for r in best_rows:
        c = _parse_iso_dt(r.get("created_at"))
        u = _parse_iso_dt(r.get("updated_at"))
        if c and u:
            du = u.replace(tzinfo=timezone.utc) if u.tzinfo is None else u
            dc = c.replace(tzinfo=timezone.utc) if c.tzinfo is None else c
            sec = (du - dc).total_seconds()
            if sec >= 0:
                durations_sec.append(sec)

    n = len(best_rows)
    completed = sum(1 for r in best_rows if r.get("status") == "completed")
    completion_rate = round(completed / n, 3) if n else None

    avg_hours = round(sum(durations_sec) / len(durations_sec) / 3600.0, 2) if durations_sec else None

                                                                              
    by_key: Dict[Tuple[Any, str], List[float]] = {}
    for s in raw_sessions:
        uid = s.get("user_id")
        cc = s.get("case_code") or ""
        ts = s.get("total_score")
        if uid is None or ts is None:
            continue
        by_key.setdefault((uid, cc), []).append(float(ts))

    deltas: List[float] = []
    for key, scores in by_key.items():
        if attempt_counts.get(key, 0) <= 1:
            continue
        if len(scores) < 2:
            continue
        deltas.append(max(scores) - min(scores))

    avg_delta = round(sum(deltas) / len(deltas), 2) if deltas else None

    return {
        "avg_session_hours": avg_hours,
        "completion_rate": completion_rate,
        "avg_score_delta_repeats": avg_delta,
        "repeats_with_delta_count": len(deltas),
        "sample_best_sessions": n,
    }


def _pearson(xs: List[float], ys: List[float]) -> Optional[float]:
    n = len(xs)
    if n < 3 or n != len(ys):
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return None
    return round(num / (dx * dy), 3)


def compute_correlations(
    best_rows: List[Dict[str, Any]],
    min_n: int = 15,
) -> Dict[str, Any]:
    """Корреляция числа сообщений тьютора с итоговым баллом (ориентировочно)."""
    if len(best_rows) < min_n:
        return {
            "available": False,
            "min_n": min_n,
            "n": len(best_rows),
            "pearson_tutor_messages_vs_total": None,
            "points": [],
        }

    ids = [r["session_id"] for r in best_rows if r.get("session_id")]
    if not ids:
        return {"available": False, "min_n": min_n, "n": 0, "pearson_tutor_messages_vs_total": None, "points": []}

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT session_external_id, COUNT(*)::int
                FROM tutor_message_log
                WHERE session_external_id = ANY(%s)
                GROUP BY session_external_id
                """,
                (ids,),
            )
            counts = {row[0]: row[1] for row in cur.fetchall()}

    xs: List[float] = []
    ys: List[float] = []
    points: List[Dict[str, Any]] = []
    for r in best_rows:
        sid = r.get("session_id")
        tot = r.get("total_score")
        if not sid or tot is None:
            continue
        c = float(counts.get(sid, 0))
        xs.append(c)
        ys.append(float(tot))
        points.append({
            "session_id": sid,
            "name": r.get("name"),
            "tutor_messages": int(c),
            "total_score": float(tot),
        })

    if len(xs) < min_n:
        return {
            "available": False,
            "min_n": min_n,
            "n": len(xs),
            "pearson_tutor_messages_vs_total": None,
            "points": points[:50],
        }

    r_val = _pearson(xs, ys)
    return {
        "available": True,
        "min_n": min_n,
        "n": len(xs),
        "pearson_tutor_messages_vs_total": r_val,
        "points": points,
        "disclaimer": "Ориентировочная связь по данным симулятора; не вывод причинности.",
    }
