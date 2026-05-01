"""
Сервис нормализации оценок LEXIC.

Реализует трёхуровневую иерархическую модель:
  Уровень 1: Фиксация сырых дельт (снимки до/после каждого этапа)
  Уровень 2: min-max нормализация по теоретическим границам этапа → 0–100
  Уровень 3: взвешенная агрегация по этапам → итоговый LEXIC-профиль

Полная методика (этапы 1–4 + нормализация): docs/LEXIC_METHODOLOGY.md
Доп. план отчётов/дашборда: plans/lexic-normalization-reports-dashboard.md
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from config import DATA_DIR
from db import get_connection
from services.lexic_case_scale import (
    LexicCaseScaleError,
    resolve_stage1_reference_fact_count,
    resolve_stage2_risk_count,
    resolve_stage2_missing_pool_size,
    resolve_stage3_clause_count,
    resolve_stage4_crisis_stats,
    stage1_bounds_scale,
    stage4_bounds_scale,
)

                 
LEXIC_PARAMS = ("L", "E", "X", "I", "C")

                                                                               
                                          
                                                          
                                                             
                                                                               

                                                                              
                                                             
DEFAULT_STAGE_BOUNDS: Dict[str, Dict[str, Tuple[float, float]]] = {
    "stage-1": {
                                                                                                               
                                                         
        "L": (-10.0, 15.0),
                                                                        
        "E": (-50.0, 50.0),
                                                   
        "X": (-5.0, 6.0),
                                     
        "I": (0.0, 0.0),
                                                                                   
        "C": (-10.0, 10.0),
    },
    "stage-2": {
                                                                                                                               
                                                                                                                    
        "L": (-30.0, 50.0),
                        
        "E": (-10.0, 10.0),
                                               
        "X": (0.0, 45.0),
                                    
        "I": (0.0, 40.0),
                                              
        "C": (0.0, 20.0),
    },
    "stage-3": {
                                                         
        "L": (0.0, 50.0),
                                             
        "E": (0.0, 65.0),
                           
        "X": (0.0, 50.0),
                                                     
        "I": (-70.0, 50.0),
                           
        "C": (0.0, 50.0),
    },
    "stage-4": {
                                                       
                                                                      
                                                                                          
                                         
        "L": (-30.0, 60.0),
        "E": (-30.0, 40.0),
        "X": (-40.0, 60.0),
        "I": (-30.0, 50.0),
        "C": (-16.0, 24.0),
    },
}

                                                              
                                                                                                      
                                                                           
DEFAULT_STAGE_WEIGHTS: Dict[str, float] = {
    "stage-1": 0.26,
    "stage-2": 0.22,
    "stage-3": 0.28,
    "stage-4": 0.24,
}


                                                                               
                          
                                                                               


def calculate_stage_bounds(
    case_data: Dict[str, Any],
    stage_code: str,
) -> Dict[str, Tuple[float, float]]:
    """
    Рассчитать delta_min/delta_max для каждого параметра LEXIC по конкретному этапу.

    Этап 1 — границы из DEFAULT_STAGE_BOUNDS × scale(n эталонных ориентиров по блокам); scale ≥ 1 относительно эталона case-001.
    Этап 2 — число рисков в матрице (JSON кейса или stage-2.risk_count) и размер пула доп. условий.
    Этап 3 — число пунктов в gameData (или negotiable_clause_count).
    Этап 4 — число кризисных сценариев и объём правок по договору (crisis_scenarios.json или stage-4.lexic).
    Иначе — статические DEFAULT_STAGE_BOUNDS.

    Raises:
        LexicCaseScaleError: нет id кейса, этапа, файлов или явных полей масштаба (см. lexic_case_scale).

    Returns:
        {param: (delta_min, delta_max)}; если оба == 0 → параметр не затрагивается.
    """
    bounds = {p: DEFAULT_STAGE_BOUNDS.get(stage_code, {}).get(p, (0.0, 0.0)) for p in LEXIC_PARAMS}

    if stage_code == "stage-2":
        risk_count = resolve_stage2_risk_count(case_data, DATA_DIR)
        n_miss = resolve_stage2_missing_pool_size()
        bounds["L"] = (-(risk_count * 3 + 3 * n_miss), risk_count * 5 + n_miss * 5)
        bounds["X"] = (0.0, float(risk_count * 5))
        bounds["I"] = (0.0, float(risk_count * 4 * 5))

    if stage_code == "stage-3":
        clause_count = resolve_stage3_clause_count(case_data, DATA_DIR)
        bounds["L"] = (0.0, clause_count * 10.0)
        bounds["E"] = (0.0, clause_count * 13.0)
        bounds["X"] = (0.0, clause_count * 10.0)
        bounds["I"] = (-(clause_count * 14.0), clause_count * 10.0)
        bounds["C"] = (0.0, clause_count * 10.0)

    if stage_code == "stage-4":
        stats = resolve_stage4_crisis_stats(case_data, DATA_DIR)
        sc = stage4_bounds_scale(stats)
        base_s4 = DEFAULT_STAGE_BOUNDS.get("stage-4", {})
        for p in LEXIC_PARAMS:
            lo, hi = base_s4.get(p, (0.0, 0.0))
            if lo == 0.0 and hi == 0.0:
                bounds[p] = (0.0, 0.0)
            else:
                bounds[p] = (round(lo * sc, 3), round(hi * sc, 3))

    if stage_code == "stage-1":
        n1 = resolve_stage1_reference_fact_count(case_data)
        sc = stage1_bounds_scale(n1)
        base_s1 = DEFAULT_STAGE_BOUNDS.get("stage-1", {})
        for p in LEXIC_PARAMS:
            lo, hi = base_s1.get(p, (0.0, 0.0))
            if lo == 0.0 and hi == 0.0:
                bounds[p] = (0.0, 0.0)
            else:
                bounds[p] = (round(lo * sc, 3), round(hi * sc, 3))

    return bounds


def normalize_stage_delta(
    delta: float,
    delta_min: float,
    delta_max: float,
) -> Optional[float]:
    """
    Нормализовать дельту этапа к шкале 0–100.

    Returns:
        float 0–100 или None, если параметр не затрагивается (min == max == 0).
    """
    if delta_min == delta_max:
                                            
        return None
    span = delta_max - delta_min
    raw = 100.0 * (delta - delta_min) / span
    return max(0.0, min(100.0, raw))


def normalize_stage_scores(
    raw_deltas: Dict[str, float],
    bounds: Dict[str, Tuple[float, float]],
) -> Dict[str, Optional[float]]:
    """
    Нормализовать сырые дельты этапа по таблице границ.

    Returns:
        {param: 0–100 | None}
    """
    return {
        p: normalize_stage_delta(
            raw_deltas.get(p, 0.0),
            bounds[p][0],
            bounds[p][1],
        )
        for p in LEXIC_PARAMS
    }


                                                                    
                                                                                                              
_COHERENCE_CORE_PARAMS = ("X", "C")
_COHERENCE_I_MARGIN = 12.0
_COHERENCE_L_MARGIN = 15.0

                                                                                                 
LEXIC_TOTAL_DISPLAY_WEIGHTS: Dict[str, float] = {
    "L": 1.0,
    "E": 0.35,
    "X": 1.0,
    "I": 1.0,
    "C": 1.0,
}

                                                                                                              
                                                                                                                
                                                                                            
LEXIC_STAGE_AGGREGATE_SHARE_IN_FINAL: float = 0.28


def blend_lexic_final_with_raw(
    aggregated_normalized: Dict[str, float],
    raw_lexic: Dict[str, Any],
    stage_aggregate_share: Optional[float] = None,
) -> Dict[str, float]:
    """
    Смешивает взвешенный по этапам нормализованный агрегат с текущим сырым LEXIC сессии по каждой оси.

    stage_aggregate_share — доля aggregated (по умолчанию LEXIC_STAGE_AGGREGATE_SHARE_IN_FINAL);
    (1 - share) идёт из raw_lexic.
    """
    w = (
        float(stage_aggregate_share)
        if stage_aggregate_share is not None
        else LEXIC_STAGE_AGGREGATE_SHARE_IN_FINAL
    )
    w = max(0.0, min(1.0, w))
    out: Dict[str, float] = {}
    for p in LEXIC_PARAMS:
        try:
            raw_v = float(raw_lexic.get(p, 50) or 50)
        except (TypeError, ValueError):
            raw_v = 50.0
        norm_v = float(aggregated_normalized.get(p, 50.0) or 50.0)
        blended = (1.0 - w) * raw_v + w * norm_v
        out[p] = round(max(0.0, min(100.0, blended)), 1)
    return out


def load_session_raw_lexic_from_db(session_external_id: str) -> Optional[Dict[str, Any]]:
    """Сырой LEXIC из payload_json сессии (для смеси в compute_full_normalized_profile)."""
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT payload_json->'lexic'
                    FROM game_session
                    WHERE external_id = %s
                    """,
                    (session_external_id,),
                )
                row = cur.fetchone()
        if not row:
            return None
        lex = row[0]
        if lex is None:
            return None
        if isinstance(lex, str):
            parsed = json.loads(lex)
            return dict(parsed) if isinstance(parsed, dict) else None
        return dict(lex) if isinstance(lex, dict) else None
    except Exception as e:
        print(f"⚠️ normalization_service: не удалось прочитать payload_json.lexic: {e}")
        return None


def apply_lexic_interest_legitimacy_coherence(lexic: Optional[Dict[str, Any]]) -> Dict[str, float]:
    """
    Ограничивает L и I сверху, если низкие экспертиза (X) и ясность (C):
    нельзя одновременно показывать «высокую защиту интересов / легитимность» при провале базовой компетентности.
    Эффективность (E) в этот потолок не входит — низкий темп не «режет» L/I.
    """
    src = lexic or {}
    out: Dict[str, float] = {p: float(src.get(p, 50) or 50) for p in LEXIC_PARAMS}
    core = sum(out[p] for p in _COHERENCE_CORE_PARAMS) / float(len(_COHERENCE_CORE_PARAMS))
    if core < 40.0:
        margin_i = 8.0
        margin_l = 10.0
    elif core < 48.0:
        margin_i = 10.0
        margin_l = 12.0
    else:
        margin_i = _COHERENCE_I_MARGIN
        margin_l = _COHERENCE_L_MARGIN
    cap_i = min(100.0, core + margin_i)
    cap_l = min(100.0, core + margin_l)
    if out["I"] > cap_i:
        out["I"] = round(cap_i, 1)
    if out["L"] > cap_l:
        out["L"] = round(cap_l, 1)
    return out


def aggregate_final_lexic(
    stage_snapshots: List[Dict[str, Any]],
    weights: Optional[Dict[str, float]] = None,
) -> Dict[str, float]:
    """
    Агрегировать нормализованные оценки по этапам → итоговый LEXIC-профиль.

    Формула для каждого параметра p:
        LEXIC_final[p] = Σ(w[k] × norm[k][p]) / Σ(w[k])
        только по этапам, где norm[k][p] ≠ None

    Args:
        stage_snapshots: список снимков из session_lexic_stage
        weights: {stage_code: weight}; если None — берём DEFAULT_STAGE_WEIGHTS

    Returns:
        {param: 0–100}; если нет данных → 50 (нейтральное значение)
    """
    if weights is None:
        weights = DEFAULT_STAGE_WEIGHTS

    result: Dict[str, float] = {}

    for p in LEXIC_PARAMS:
        weighted_sum = 0.0
        total_weight = 0.0
        for snap in stage_snapshots:
            stage_code = snap.get("stage_code", "")
            norm_scores = snap.get("normalized_scores") or {}
            norm_val = norm_scores.get(p)
            if norm_val is None:
                continue
            w = weights.get(stage_code, 0.25)
            weighted_sum += w * norm_val
            total_weight += w

        if total_weight > 0:
            result[p] = round(weighted_sum / total_weight, 1)
        else:
            result[p] = 50.0                                              

    return result


def compute_total_score(lexic_final: Dict[str, float]) -> float:
    """Итоговый балл: взвешенное среднее; ось E слабее остальных (см. LEXIC_TOTAL_DISPLAY_WEIGHTS)."""
    w = LEXIC_TOTAL_DISPLAY_WEIGHTS
    num = sum(w.get(p, 1.0) * float(lexic_final.get(p, 50.0) or 50.0) for p in LEXIC_PARAMS)
    den = sum(w.get(p, 1.0) for p in LEXIC_PARAMS)
    if den <= 0:
        return 50.0
    return round(num / den, 1)


                                                                               
                                                
                                                                               


def save_stage_snapshot(
    session_external_id: str,
    stage_code: str,
    stage_order: int,
    lexic_before: Dict[str, int],
    lexic_after: Dict[str, int],
    case_data: Optional[Dict[str, Any]] = None,
    weight: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """
    Сохранить снимок LEXIC этапа (до/после + нормализация) в session_lexic_stage.

    Если запись уже существует — обновляет.
    При успехе возвращает запись в том же формате, что get_stage_snapshots; при ошибке — None.
    """
                                                          
    raw_deltas: Dict[str, float] = {}
    for p in LEXIC_PARAMS:
        before = int(lexic_before.get(p, 50))
        after = int(lexic_after.get(p, 50))
        raw_deltas[p] = float(after - before)

                            
    bounds = calculate_stage_bounds(case_data or {}, stage_code)
    normalized = normalize_stage_scores(raw_deltas, bounds)

    if weight is None:
        weight = DEFAULT_STAGE_WEIGHTS.get(stage_code, 0.25)

    raw_row = {p: raw_deltas[p] for p in LEXIC_PARAMS}
    norm_row = {p: normalized[p] for p in LEXIC_PARAMS}
    lb = dict(lexic_before) if isinstance(lexic_before, dict) else {}
    la = dict(lexic_after) if isinstance(lexic_after, dict) else {}

    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO session_lexic_stage (
                        session_external_id, stage_code, stage_order,
                        lexic_before, lexic_after, raw_deltas,
                        normalized_scores, weight, completed_at
                    )
                    VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s, NOW())
                    ON CONFLICT (session_external_id, stage_code) DO UPDATE SET
                        lexic_after        = EXCLUDED.lexic_after,
                        raw_deltas         = EXCLUDED.raw_deltas,
                        normalized_scores  = EXCLUDED.normalized_scores,
                        weight             = EXCLUDED.weight,
                        completed_at       = NOW()
                    """,
                    (
                        session_external_id,
                        stage_code,
                        stage_order,
                        json.dumps(lb),
                        json.dumps(la),
                        json.dumps(raw_row),
                        json.dumps(norm_row),
                        weight,
                    ),
                )
    except Exception as e:
        print(f"⚠️ normalization_service: ошибка сохранения снимка {stage_code}: {e}")
        return None

    ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "stage_code": stage_code,
        "stage_order": stage_order,
        "lexic_before": lb,
        "lexic_after": la,
        "raw_deltas": raw_row,
        "normalized_scores": norm_row,
        "weight": float(weight),
        "completed_at": ts,
    }


def get_stage_snapshots(session_external_id: str) -> List[Dict[str, Any]]:
    """Загрузить все снимки LEXIC по этапам для сессии."""
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT stage_code, stage_order, lexic_before, lexic_after,
                           raw_deltas, normalized_scores, weight, completed_at
                    FROM session_lexic_stage
                    WHERE session_external_id = %s
                    ORDER BY stage_order ASC
                    """,
                    (session_external_id,),
                )
                rows = cur.fetchall()
        return [
            {
                "stage_code": r[0],
                "stage_order": r[1],
                "lexic_before": r[2] or {},
                "lexic_after": r[3] or {},
                "raw_deltas": r[4] or {},
                "normalized_scores": r[5] or {},
                "weight": float(r[6]) if r[6] is not None else 0.25,
                "completed_at": r[7].isoformat() if r[7] else None,
            }
            for r in rows
        ]
    except Exception as e:
        print(f"⚠️ normalization_service: ошибка загрузки снимков: {e}")
        return []


def compute_full_normalized_profile(
    session_external_id: str,
    weights: Optional[Dict[str, float]] = None,
    raw_lexic: Optional[Dict[str, Any]] = None,
    preloaded_snapshots: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Рассчитать полный нормализованный LEXIC-профиль для сессии.

    raw_lexic: сырой профиль из сессии (рекомендуется передавать актуальный dict после этапа).
               Если None — читается из game_session.payload_json.lexic.
    preloaded_snapshots: если задан — не выполняется SELECT по session_lexic_stage (например,
        список уже объединён с только что сохранённым этапом).

    Returns:
        {
            "final": {L, E, X, I, C},      # смесь агрегата по этапам + сырой LEXIC, затем согласованность L/I
            "final_stage_aggregate_only": {…},  # только взвешенное среднее норм по этапам (до смеси и L/I)
            "total_score": float,
            "stages": [snapshot, ...],
            "stage_weights": {...},
        }
    """
    snapshots = (
        preloaded_snapshots
        if preloaded_snapshots is not None
        else get_stage_snapshots(session_external_id)
    )

    if not snapshots:
        return {
            "final": {p: 50.0 for p in LEXIC_PARAMS},
            "final_stage_aggregate_only": {p: 50.0 for p in LEXIC_PARAMS},
            "total_score": 50.0,
            "stages": [],
            "stage_weights": weights or DEFAULT_STAGE_WEIGHTS,
        }

    final_stage_only = aggregate_final_lexic(snapshots, weights)
    raw_src = raw_lexic if raw_lexic is not None else load_session_raw_lexic_from_db(session_external_id)
    if raw_src and any(raw_src.get(p) is not None for p in LEXIC_PARAMS):
        final_lexic = blend_lexic_final_with_raw(final_stage_only, raw_src)
    else:
        final_lexic = dict(final_stage_only)
    final_lexic = apply_lexic_interest_legitimacy_coherence(final_lexic)
    total_score = compute_total_score(final_lexic)

    return {
        "final": final_lexic,
        "final_stage_aggregate_only": final_stage_only,
        "total_score": total_score,
        "stages": snapshots,
        "stage_weights": weights or DEFAULT_STAGE_WEIGHTS,
    }


def save_normalized_to_game_session(
    session_external_id: str,
    normalized_profile: Dict[str, Any],
) -> None:
    """
    Сохранить нормализованные значения в денормализованные колонки game_session
    для быстрых запросов дашборда.
    """
    final = normalized_profile.get("final", {})
    total_score = normalized_profile.get("total_score")

    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE game_session SET
                        total_score_normalized = %s,
                        lexic_l_normalized     = %s,
                        lexic_e_normalized     = %s,
                        lexic_x_normalized     = %s,
                        lexic_i_normalized     = %s,
                        lexic_c_normalized     = %s,
                        updated_at             = NOW()
                    WHERE external_id = %s
                    """,
                    (
                        total_score,
                        final.get("L"),
                        final.get("E"),
                        final.get("X"),
                        final.get("I"),
                        final.get("C"),
                        session_external_id,
                    ),
                )
    except Exception as e:
        print(f"⚠️ normalization_service: ошибка обновления game_session: {e}")


                                                                               
                        
                                                                               


def get_lexic_level(score: float) -> str:
    """Определить уровень по нормализованному баллу."""
    if score >= 85:
        return "outstanding"
    if score >= 70:
        return "good"
    if score >= 50:
        return "average"
    if score >= 30:
        return "below_average"
    return "critical"


LEXIC_LEVEL_LABELS: Dict[str, str] = {
    "outstanding": "⭐ Выдающийся",
    "good": "🔵 Хороший",
    "average": "🟡 Средний",
    "below_average": "🟠 Ниже среднего",
    "critical": "🔴 Критический",
}

LEXIC_LEVEL_COLORS: Dict[str, str] = {
    "outstanding": "#10b981",
    "good": "#3b82f6",
    "average": "#f59e0b",
    "below_average": "#f97316",
    "critical": "#ef4444",
}


def _param_name(p: str) -> str:
    names = {"L": "Легитимность", "E": "Эффективность", "X": "Экспертиза", "I": "Интересы", "C": "Ясность"}
    return names.get(p, p)


def _lexic_basis(v: Dict[str, float]) -> List[Dict[str, Any]]:
    """Пять осей по убыванию балла — прозрачная привязка подписи к L/E/X/I/C."""
    return [
        {"param": p, "name": _param_name(p), "value": int(round(v[p]))}
        for p in sorted(LEXIC_PARAMS, key=lambda x: -v[x])
    ]


def classify_participant(lexic_final: Dict[str, float]) -> Dict[str, Any]:
    """
    Ролевая метка и короткое человеческое пояснение по итоговым баллам LEXIC (L, E, X, I, C).

    label — живое имя «типа» без формул; description — смысл для участника простым языком.
    Числа по осям — только в basis (чипы в UI). Не ИИ. type — для кластеров на дашборде.
    """
    if not lexic_final:
        return {"type": "unknown", "label": "Не определён", "description": "", "basis": []}

    v = {p: float(lexic_final.get(p, 50) or 50) for p in LEXIC_PARAMS}
    for p in LEXIC_PARAMS:
        v[p] = max(0.0, min(100.0, v[p]))

    basis = _lexic_basis(v)

    avg = sum(v[p] for p in LEXIC_PARAMS) / 5
    hi = max(v[p] for p in LEXIC_PARAMS)
    lo = min(v[p] for p in LEXIC_PARAMS)
    spread = hi - lo
    order = sorted(LEXIC_PARAMS, key=lambda p: -v[p])
    top, second, bottom = order[0], order[1], order[-1]

    def R(type_id: str, label: str, description: str) -> Dict[str, Any]:
        return {"type": type_id, "label": label, "description": description, "basis": basis}

    l, e, x, i, c = v["L"], v["E"], v["X"], v["I"], v["C"]

                                                                    
    if lo >= 58 and spread <= 20 and avg >= 62:
        return R(
            "lexic_even_high",
            "🌟 Сильный общий профиль",
            "По симуляции у тебя нет одного явного «провала»: процедура, риски, переговоры и ясность выглядят в одном духе. "
            "Это редкая ровная картина — хорошая база под ответственные сделки.",
        )

    if v[bottom] < 48:
        role_weak = {
            "L": "📜 Главный вызов — рамка и полномочия",
            "E": "⏱️ Главный вызов — время и темп",
            "X": "🔍 Главный вызов — глубина и риски",
            "I": "🛡️ Главный вызов — защита интересов компании",
            "C": "💡 Главный вызов — ясность для бизнеса",
        }.get(bottom, "🌱 Есть явное слабое звено")
        weak_expl = {
            "L": "Симулятор увидел, что опора на процедуру, полномочия и «как положено» у тебя слабее остального. "
            "На практике это часто про внимание к срокам, формальным основаниям и аккуратность в рамках сделки.",
            "E": "Самое узкое место — эффективность: не увязнуть в лишнем, уложиться во время, держать фокус. "
            "В переговорах и при дедлайнах это обычно первое, что замечают коллеги.",
            "X": "Экспертиза — разбор условий, уровень риска, детали — уходит ниже остальных тем в профиле. "
            "Имеет смысл целенаправленно тренировать матрицу рисков и проверку формулировок.",
            "I": "Интересы компании в цифрах симулятора не на первом плане. "
            "Стоит следить, чтобы защита позиции не уступала удобству или быстрым уступкам.",
            "C": "Ясность для бизнеса и контрагента — поле для роста: структура аргумента и простые формулировки без воды.",
        }.get(
            bottom,
            "Есть направление, где симулятор зафиксировал заметно более низкий результат, чем по остальным темам.",
        )
        return R(f"lexic_weak_{bottom}", role_weak, weak_expl)

    if spread >= 30:
        return R(
            "lexic_contrast",
            "⚡ Профиль с сильным перекосом",
            "Есть тема, где ты выглядишь очень уверенно, и тема, где заметно слабее. "
            "Такой почерк нормален, но в сложной сделке слабое место могут использовать — имеет смысл его сознательно подтянуть.",
        )

                                                                      
    if l >= 72 and x >= 68:
        return R(
            "lexic_LX",
            "⚖️ Юрист-аналитик",
            "Тебе естественно совмещать рамку договора и глубокий разбор рисков: процедура и суть условий идут вместе. "
            "Такой стиль часто у тех, кто не боится деталей и держит опору на нормы.",
        )
    if e >= 72 and c >= 68:
        return R(
            "lexic_EC",
            "⚡ Чёткий и быстрый",
            "Ты хорошо сочетаешь темп и понятность: не теряешь время и доносишь мысль так, чтобы её поймали без лишних раундов.",
        )
    if i >= 72 and l >= 66:
        return R(
            "lexic_IL",
            "🛡️ Защитник в рамках права",
            "Ты упорно держишь интересы компании, но не срываешься в «ломать ради победы» — опора на легитимность для тебя важна.",
        )
    if x >= 72 and i >= 66:
        return R(
            "lexic_XI",
            "🔍 Переговорщик на фактах",
            "Разбор рисков и фокус на выгоде стороны у тебя идут в связке: споришь и отстаиваешь позицию на аргументах, а не на громких фразах.",
        )
    if c >= 72 and e >= 66:
        return R(
            "lexic_CE",
            "💬 Ясный коммуникатор",
            "Сильная подача плюс ощущение, что ты не растягиваешь процесс зря: мысль структурирована, темп рабочий.",
        )
    if l >= 70 and c >= 66:
        return R(
            "lexic_LC",
            "📋 По правилам и понятным словам",
            "Ты связываешь «как положено» с языком, понятным бизнесу: меньше канцелярита, больше ясной опоры на процедуру.",
        )
    if e >= 70 and l >= 64:
        return R(
            "lexic_EL",
            "⏱️ Оперативный и в рамке",
            "Решения приходят быстро, при этом ты не сбрасываешь со счетов правовую опору — баланс скорости и осторожности.",
        )
    if x >= 70 and c >= 64:
        return R(
            "lexic_XC",
            "🎯 Эксперт, который объясняет",
            "Сильная экспертиза по сути договора и способность упаковать выводы так, чтобы их не переиначили.",
        )
    if i >= 68 and x >= 64:
        return R(
            "lexic_IX",
            "🛡️ Интересы на аргументах",
            "Отстаиваешь позицию компании, опираясь на разбор сути и рисков, а не на общие лозунги.",
        )

    if v[top] - v[second] >= 14 and v[top] >= 70:
        peak_role = {
            "L": "⚖️ Твоя явная сила — процедура и нормы",
            "E": "⏱️ Твоя явная сила — скорость и фокус",
            "X": "🔍 Твоя явная сила — разбор рисков и деталей",
            "I": "🛡️ Твоя явная сила — защита интересов компании",
            "C": "💡 Твоя явная сила — ясность формулировок",
        }.get(top, "🎯 Явный лидер по одному направлению")
        peak_expl = {
            "L": "Остальные темы в профиле играют вторую роль. Это не минус, если сознательно подстраховываешь слабые места в команде.",
            "E": "Ты выигрываешь за счёт темпа и концентрации; следи, чтобы скорость не жертвовала глубиной там, где она критична.",
            "X": "Тебя тянет вглубь условий и рисков; важно не забывать про баланс интересов и понятность для неюристов.",
            "I": "Защита позиции компании у тебя на первом плане; проверяй, что рамка права и ясность коммуникации не отстают.",
            "C": "Формулировки и структура аргумента — твой козырь; убедись, что за ними всегда стоит достаточная экспертиза по рискам.",
        }.get(
            top,
            "Одно направление в профиле заметно сильнее остальных — используй это как опору и не игнорируй хвост.",
        )
        return R(f"lexic_peak_{top}", peak_role, peak_expl)

    if spread <= 14 and 50 <= avg < 64:
        return R(
            "lexic_even_mid",
            "📊 Спокойный средний уровень",
            "Без ярких пиков и без провала в одну сторону: симуляция видит ровную середину. "
            "Хорошая отправная точка — можно выбрать одну компетенцию и целенаправленно её усилить.",
        )

    if avg >= 62 and spread < 18:
        return R(
            "lexic_universal",
            "🎯 Сбалансированный стиль",
            "Ни одна тема не доминирует в профиле: ты не «узкий специалист по одной букве», а более ровный игрок по всем направлениям сразу.",
        )

    return R(
        "lexic_mixed",
        "🔀 Разноцветный профиль",
        "У тебя одновременно есть сильные и слабые стороны в разных темах; картина не сводится к одному шаблону. "
        "Так часто бывает в длинных кейсах: важно осознанно добирать то, что отстаёт.",
    )


def get_growth_points(
    stage_snapshots: List[Dict[str, Any]],
    threshold: float = 15.0,
) -> List[Dict[str, Any]]:
    """
    Найти точки роста и снижения в динамике LEXIC по этапам.

    Returns:
        [{"stage_code": ..., "param": ..., "delta": ..., "type": "growth"|"decline"}, ...]
    """
    points = []
    for i, snap in enumerate(stage_snapshots):
        for p in LEXIC_PARAMS:
            norm_scores = snap.get("normalized_scores") or {}
            norm_val = norm_scores.get(p)
            if norm_val is None:
                continue
            if i == 0:
                continue
            prev_snap = stage_snapshots[i - 1]
            prev_norm = (prev_snap.get("normalized_scores") or {}).get(p)
            if prev_norm is None:
                continue
            delta = norm_val - prev_norm
            if abs(delta) >= threshold:
                points.append(
                    {
                        "stage_code": snap["stage_code"],
                        "stage_order": snap["stage_order"],
                        "param": p,
                        "param_name": _param_name(p),
                        "delta": round(delta, 1),
                        "type": "growth" if delta > 0 else "decline",
                    }
                )
    return sorted(points, key=lambda x: abs(x["delta"]), reverse=True)
