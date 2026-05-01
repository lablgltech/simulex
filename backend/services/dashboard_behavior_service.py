"""
Агрегаты поведенческой аналитики для дашборда руководителя (soft-skills, этап 2, summary).
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Dict, List, Optional

from db import get_connection


def _mean(vals: List[float]) -> Optional[float]:
    if not vals:
        return None
    return round(sum(vals) / len(vals), 3)


def _median(vals: List[float]) -> Optional[float]:
    if not vals:
        return None
    s = sorted(vals)
    m = len(s) // 2
    if len(s) % 2:
        return round(s[m], 2)
    return round((s[m - 1] + s[m]) / 2, 2)


def load_behavior_batch(session_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """По списку session_id: soft_skills, summary, stage2 summary, narrative flag."""
    if not session_ids:
        return {}
    out: Dict[str, Dict[str, Any]] = {
        sid: {
            "soft_skills": {},
            "summary_text": "",
            "has_summary": False,
            "stage2_summary": {},
            "has_narrative": False,
        }
        for sid in session_ids
    }
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT session_external_id, profile_json
                FROM session_soft_skills
                WHERE session_external_id = ANY(%s)
                """,
                (session_ids,),
            )
            for sid, pj in cur.fetchall():
                if sid and sid in out:
                    out[sid]["soft_skills"] = pj if isinstance(pj, dict) else {}

            cur.execute(
                """
                SELECT session_external_id, summary_text
                FROM session_summary
                WHERE session_external_id = ANY(%s)
                """,
                (session_ids,),
            )
            for sid, st in cur.fetchall():
                if sid and sid in out:
                    t = (str(st) if st is not None else "").strip()
                    out[sid]["summary_text"] = t
                    out[sid]["has_summary"] = bool(t)

            cur.execute(
                """
                SELECT external_id,
                       payload_json->'stage2_report' AS stage2,
                       payload_json->'report_snapshot' AS report_snap
                FROM game_session
                WHERE external_id = ANY(%s)
                """,
                (session_ids,),
            )
            for sid, stage2, rs in cur.fetchall():
                if not sid or sid not in out:
                    continue
                s2 = stage2 if isinstance(stage2, dict) else {}
                summ = (s2.get("summary") or {}) if s2 else {}
                out[sid]["stage2_summary"] = summ
                rsd = rs if isinstance(rs, dict) else {}
                narr = rsd.get("narrative") if rsd else None
                out[sid]["has_narrative"] = bool(narr and isinstance(narr, dict))

    return out


def enrich_session_rows(rows: List[Dict[str, Any]]) -> None:
    """Дополняет строки участников превью summary и метриками этапа 2 (in-place)."""
    ids = [r["session_id"] for r in rows if r.get("session_id")]
    if not ids:
        return
    batch = load_behavior_batch(ids)
    for r in rows:
        sid = r.get("session_id")
        if not sid:
            continue
        meta = batch.get(sid) or {}
        st = meta.get("summary_text") or ""
        if st:
            r["summary_preview"] = st[:220] + ("…" if len(st) > 220 else "")
        else:
            r["summary_preview"] = None
        r["has_summary"] = bool(meta.get("has_summary"))
        r["has_narrative"] = bool(meta.get("has_narrative"))
        sk = meta.get("soft_skills") or {}
        if sk:
            r["negotiation_style"] = sk.get("negotiation_style")
            for k in ("argumentation_level", "risk_aversion", "self_reflection"):
                if sk.get(k) is not None:
                    r[k] = sk.get(k)
        s2 = meta.get("stage2_summary") or {}
        if s2:
            if s2.get("missed_risks") is not None:
                r["stage2_missed_risks"] = int(s2["missed_risks"])
            if s2.get("false_positives") is not None:
                r["stage2_false_positives"] = int(s2["false_positives"])


def aggregate_behavior_insights(session_ids: List[str]) -> Dict[str, Any]:
    """
    Агрегаты по лучшим сессиям (список external_id).
    """
    if not session_ids:
        return {
            "sessions_count": 0,
            "with_soft_skills_profile": 0,
            "with_summary": 0,
            "with_narrative": 0,
            "avg_argumentation_level": None,
            "avg_risk_aversion": None,
            "avg_self_reflection": None,
            "median_missed_risks": None,
            "avg_missed_risks": None,
            "median_false_positives": None,
            "negotiation_styles": [],
            "stage2_sessions_with_data": 0,
        }

    batch = load_behavior_batch(session_ids)
    arg_lev: List[float] = []
    risk_av: List[float] = []
    self_ref: List[float] = []
    missed: List[float] = []
    false_pos: List[float] = []
    styles: Counter = Counter()
    n_sk = n_sum = n_narr = n_s2 = 0

    for sid in session_ids:
        meta = batch.get(sid) or {}
        sk = meta.get("soft_skills") or {}
        if sk:
            n_sk += 1
            for key, bucket in (
                ("argumentation_level", arg_lev),
                ("risk_aversion", risk_av),
                ("self_reflection", self_ref),
            ):
                v = sk.get(key)
                if isinstance(v, (int, float)):
                    bucket.append(float(v))
            stl = sk.get("negotiation_style")
            if isinstance(stl, str) and stl.strip():
                styles[stl.strip()] += 1
        if meta.get("has_summary"):
            n_sum += 1
        if meta.get("has_narrative"):
            n_narr += 1
        s2 = meta.get("stage2_summary") or {}
        if s2 and any(k in s2 for k in ("missed_risks", "false_positives", "found_risks", "total_risks")):
            n_s2 += 1
            if s2.get("missed_risks") is not None:
                missed.append(float(s2["missed_risks"]))
            if s2.get("false_positives") is not None:
                false_pos.append(float(s2["false_positives"]))

    neg_styles = [{"style": k, "count": v} for k, v in styles.most_common()]

    return {
        "sessions_count": len(session_ids),
        "with_soft_skills_profile": n_sk,
        "with_summary": n_sum,
        "with_narrative": n_narr,
        "avg_argumentation_level": _mean(arg_lev),
        "avg_risk_aversion": _mean(risk_av),
        "avg_self_reflection": _mean(self_ref),
        "median_missed_risks": _median(missed),
        "avg_missed_risks": _mean(missed),
        "median_false_positives": _median(false_pos),
        "negotiation_styles": neg_styles,
        "stage2_sessions_with_data": n_s2,
    }
