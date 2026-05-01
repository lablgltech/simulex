"""Сервис для генерации отчётов по прохождению кейса."""
from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path

from db import get_connection
from services.case_service import get_case, get_case_stage_count_from_db
from services.case_id import canonical_case_code, case_suffix
from services.stage_service import get_stage_actions
from services.negotiation_session_service import (
    get_negotiation_session_by_simulex_session,
    get_negotiation_history,
)
from services.stage3_lexic_service import compute_stage3_lexic_deltas
from services.document_service import ClauseStatus
from utils.recommendations import generate_recommendations
from services.session_context import (
    get_session_summary_and_profile,
    update_session_summary_and_profile,
)
from services.ai_model_config import get_model_for_consumer
from services.ai_payload import MINIMAL_SYSTEM_MESSAGE, compact_user_payload
from stages.stage_2 import _load_stage2_contract
from services.normalization_service import (
    apply_lexic_interest_legitimacy_coherence,
    compute_full_normalized_profile,
    classify_participant,
    get_growth_points,
    get_lexic_level,
    LEXIC_LEVEL_LABELS,
    LEXIC_LEVEL_COLORS,
    LEXIC_PARAMS,
    LEXIC_TOTAL_DISPLAY_WEIGHTS,
)
from config import DATA_DIR
from services.game_session_service import _session_external_id_for_db
from utils.file_loader import load_crisis_scenarios, load_contract_clauses
from services.lexic_lab_ledger_service import build_lexic_lab_ledger
                                                                                                                 
REPORT_SNAPSHOT_VERSION = 5                                                                                                                                


def _report_snapshot_is_current(snap: Any) -> bool:
    """Актуальный зафиксированный снимок отчёта (текущая версия + нарратив)."""
    if not isinstance(snap, dict):
        return False
    v_raw = snap.get("v")
    try:
        v_ok = int(v_raw) == REPORT_SNAPSHOT_VERSION
    except (TypeError, ValueError):
        v_ok = False
    if not v_ok:
        return False
    n = snap.get("narrative")
    if not isinstance(n, dict):
        return False

    def _nonempty_prose(val: Any) -> bool:
        if val is None:
            return False
        if isinstance(val, str):
            return bool(val.strip())
        return bool(val)

                                                                                       
                                                                                                        
    return bool(
        _nonempty_prose(n.get("overview"))
        or _nonempty_prose(n.get("strengths"))
        or _nonempty_prose(n.get("growth_areas"))
        or _nonempty_prose(n.get("conclusion"))
    )


def _resolve_session_external_id(session: Optional[Dict[str, Any]]) -> Optional[str]:
    """Внешний ID сессии для связи с game_session.external_id, stage_session, логами."""
    if not session or not isinstance(session, dict):
        return None
    s = _session_external_id_for_db(session)
    return s or None


def _resolve_case_id_for_get_case(session: Dict[str, Any]) -> Optional[str]:
    """Канонический код кейса из сессии для get_case и отчётов."""
    raw = session.get("case_id") or session.get("case_code")
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    return canonical_case_code(s)


def _session_completed_vs_n_stages(session: Dict[str, Any], n_stages: int) -> bool:
    if n_stages <= 0:
        return False
    try:
        cur = int(session.get("current_stage") or 1)
    except (TypeError, ValueError):
        return False
    return cur > n_stages


def is_session_case_completed(session: Dict[str, Any], case_data: Dict[str, Any]) -> bool:
    """Кейс завершён, если current_stage > числа этапов (после complete последнего этапа)."""
    stages = case_data.get("stages") or []
    n = len(stages)
    if n == 0:
        return False
    try:
        cur = int(session.get("current_stage") or 1)
    except (TypeError, ValueError):
        return False
    return cur > n


def ensure_case_report_snapshot(
    data_dir: Path, session: Dict[str, Any]
) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """
    Если кейс завершён и в сессии ещё нет зафиксированного снимка — один раз вызывает ИИ
    (summary/soft-skills + нарратив отчёта) через generate_report и вкладывает narrative в report_snapshot.

    Returns:
        (session_out, report_or_none). Если report_or_none не None — это полный ответ generate_report;
        вызывающий код должен сохранить session_out в БД и может вернуть report без повторного generate_report.
        save_game_session здесь не вызывается.
    """
    case_raw = session.get("case_id") or session.get("case_code")
    if not case_raw:
        return session, None
    snap = session.get("report_snapshot") or {}
    if _report_snapshot_is_current(snap):
        cc = canonical_case_code(str(case_raw))
        n_st = get_case_stage_count_from_db(cc)
        if n_st is not None and n_st > 0 and _session_completed_vs_n_stages(session, n_st):
            return session, None
    try:
        case_data = get_case(data_dir, canonical_case_code(str(case_raw)))
    except Exception:
        return session, None
    if not is_session_case_completed(session, case_data):
        return session, None
    if _report_snapshot_is_current(snap):
        return session, None
    report = generate_report(data_dir, session, case_data=case_data)
    out = dict(session)
    snap_body: Dict[str, Any] = {
        "v": REPORT_SNAPSHOT_VERSION,
        "frozen_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "narrative": report.get("narrative"),
        "display_total": report.get("total_score"),
    }
    s3d = (report.get("stage_details") or {}).get("stage-3")
    if isinstance(s3d, dict) and s3d:
        snap_body["stage3_detail"] = copy.deepcopy(s3d)
    out["report_snapshot"] = snap_body
    return out, report


                                                             
_CLAUSE_STATUS_NAMES = {
    1: "not_editable",
    2: "available",
    3: "selected",
    4: "no_edits",
    5: "accepted_bot",
    6: "changed",
    7: "not_agreed_escalation",
    8: "kept_counterparty",
    9: "excluded",
}


def _get_timeline(session_id: str, limit: int = 2000) -> List[Dict[str, Any]]:
    """Получить последние события session_action_log для сессии."""
    if not session_id:
        return []
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT action_type, stage_code, payload_json, created_at
                    FROM session_action_log
                    WHERE session_external_id = %s
                    ORDER BY created_at ASC
                    LIMIT %s
                    """,
                    (session_id, limit),
                )
                rows = cur.fetchall()
        return [
            {
                "action_type": r[0],
                "stage_code": r[1],
                "payload": r[2] or {},
                "created_at": r[3].isoformat() if r[3] else None,
            }
            for r in rows
        ]
    except Exception as e:
        print(f"WARNING report_service._get_timeline({session_id!r}): {e}")
        return []


def _game_session_created_updated(session_external_id: str) -> Tuple[Optional[datetime], Optional[datetime]]:
    """Границы жизни сессии в БД — запасной источник для длительности, если лог действий пуст."""
    if not session_external_id:
        return None, None
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT created_at, updated_at
                    FROM game_session
                    WHERE external_id = %s
                    """,
                    (str(session_external_id),),
                )
                row = cur.fetchone()
        if not row:
            return None, None
        c, u = row[0], row[1]
        if c is None or u is None:
            return None, None
        if not isinstance(c, datetime):
            c = datetime.fromisoformat(str(c).replace("Z", "+00:00"))
        if not isinstance(u, datetime):
            u = datetime.fromisoformat(str(u).replace("Z", "+00:00"))
        return c, u
    except Exception as e:
        print(f"WARNING report_service._game_session_created_updated({session_external_id!r}): {e}")
        return None, None


def _apply_game_session_timing_fallback(
    result: Dict[str, Any],
    session_external_id: Optional[str],
    timeline: List[Dict[str, Any]],
    case_data: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Если по логу нет событий (прод: сбой записи, пустая таблица) или получилось 0 с при непустой сессии в БД —
    берём интервал created_at…updated_at из game_session.
    При отсутствии лога заполняем длительности этапов равным делением (оценка, лучше чем нули).
    """
    if not session_external_id:
        return
    gc, gu = _game_session_created_updated(str(session_external_id))
    if gc is None or gu is None:
        return
    if gu < gc:
        return
    if gu.tzinfo is not None and gc.tzinfo is None:
        gc = gc.replace(tzinfo=gu.tzinfo)
    elif gc.tzinfo is not None and gu.tzinfo is None:
        gu = gu.replace(tzinfo=gc.tzinfo)
    span = max(0, int((gu - gc).total_seconds()))
    if span <= 0:
        return
    cur = result.get("total_seconds")
    if not timeline:
        result["total_seconds"] = span
        stages_cfg = (case_data or {}).get("stages") or []
        if stages_cfg and not result.get("stages"):
            n = len(stages_cfg)
            base, extra = divmod(span, n)
            result["stages"] = []
            for i, st in enumerate(stages_cfg):
                sid = st.get("id") or f"stage-{i + 1}"
                secs = base + (1 if i < extra else 0)
                result["stages"].append({
                    "stage_id": sid,
                    "stage_title": st.get("title") or f"Этап {i + 1}",
                    "seconds": secs,
                })
        return
    if cur is not None and cur == 0:
        result["total_seconds"] = span


def _tutor_dialog_excerpt(session_id: str, limit: int = 60, max_chars: int = 12000) -> str:
    """Фрагменты диалога с тьютором из tutor_message_log."""
    if not session_id:
        return ""
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT role, content, created_at
                    FROM tutor_message_log
                    WHERE session_external_id = %s
                    ORDER BY created_at ASC
                    LIMIT %s
                    """,
                    (str(session_id), limit),
                )
                rows = cur.fetchall()
    except Exception:
        return ""
    lines: List[str] = []
    for role, content, created_at in rows:
        ts = created_at.isoformat() if created_at else ""
        text = str(content or "").strip().replace("\n", " ")[:700]
        if text:
            lines.append(f"- [{ts}] {role}: {text}")
    s = "\n".join(lines)
    return s[:max_chars]


def _negotiation_chat_excerpt(session_id: str, max_chars: int = 14000) -> str:
    """Сжатая выгрузка переписки по пунктам договора (этап 3)."""
    if not session_id:
        return ""
    neg_id, _ = get_negotiation_session_by_simulex_session(str(session_id))
    if not neg_id:
        return ""
    try:
        hist = get_negotiation_history(int(neg_id))
    except Exception:
        return ""
    by_c = hist.get("chat_history_by_clause") or {}
    lines: List[str] = []
    for cid in sorted(by_c.keys(), key=lambda x: str(x)):
        msgs = by_c[cid]
        if not isinstance(msgs, list):
            continue
        for m in msgs:
            if not isinstance(m, dict):
                continue
            owner = m.get("owner") or m.get("role") or "?"
            text = (m.get("text") or m.get("content") or "").strip().replace("\n", " ")
            if not text:
                continue
            lines.append(f"- [пункт {cid}] {owner}: {text[:650]}")
    s = "\n".join(lines)
    return s[:max_chars]


def _timeline_text(timeline: List[Dict[str, Any]], max_lines: int = 80, max_chars: int = 8000) -> str:
    if not timeline:
        return ""
    lines: List[str] = []
    for e in timeline[-max_lines:]:
        st = e.get("stage_code") or "—"
        at = e.get("action_type") or "—"
        pl = e.get("payload") or {}
        snippet = json.dumps(pl, ensure_ascii=False)[:220] if pl else ""
        lines.append(f"- [{st}] {at} {snippet}")
    s = "\n".join(lines)
    return s[:max_chars]


def _stage2_qualitative_for_llm(s2: Dict[str, Any]) -> Dict[str, Any]:
    """
    Сводка этапа 2 для ИИ-нарратива: только качественные оценки, без числа рисков в матрице
    и без подсказок «N из M» (участник не должен видеть объём эталона).
    """
    summ = s2.get("summary") or {}
    tr = int(summ.get("total_risks") or 0)
    fr = int(summ.get("found_risks") or 0)
    mr = int(summ.get("missed_risks") or 0)
    fpos = int(summ.get("false_positives") or 0)
    out: Dict[str, Any] = {}
    if tr <= 0:
        out["matrix_rubric"] = "нет устойчивых данных матрицы для интерпретации"
        return out
    ratio = fr / tr if tr else 0.0
    if ratio >= 0.72:
        out["marked_coverage_vs_rubric"] = "высокая"
    elif ratio >= 0.45:
        out["marked_coverage_vs_rubric"] = "средняя"
    elif ratio >= 0.2:
        out["marked_coverage_vs_rubric"] = "низкая"
    else:
        out["marked_coverage_vs_rubric"] = "очень низкая"
    if fpos >= 3:
        out["spurious_marks"] = "много отметок вне рубрики"
    elif fpos >= 1:
        out["spurious_marks"] = "есть отметки вне рубрики"
    else:
        out["spurious_marks"] = "немного или нет"
    stats = s2.get("statistics") or {}
    err_n = int(stats.get("errors") or 0)
    if err_n >= 5:
        out["level_and_choice_vs_rubric"] = "сильные расхождения с рубрикой симулятора"
    elif err_n >= 2:
        out["level_and_choice_vs_rubric"] = "заметные расхождения с рубрикой симулятора"
    elif err_n == 1:
        out["level_and_choice_vs_rubric"] = "единичные расхождения с рубрикой"
    else:
        out["level_and_choice_vs_rubric"] = "в целом согласовано с рубрикой"
    used = s2.get("participant_used_risk_types")
    if used is True:
        out["optional_risk_type_chips"] = "использовались"
        tag_ok = summ.get("tag_correct_count")
        if isinstance(tag_ok, (int, float)) and int(tag_ok) >= 6:
            out["risk_type_chip_fit"] = "в основном удачно относительно рубрики"
        elif isinstance(tag_ok, (int, float)) and int(tag_ok) >= 2:
            out["risk_type_chip_fit"] = "смешанно относительно рубрики"
        elif isinstance(tag_ok, (int, float)):
            out["risk_type_chip_fit"] = "слабо относительно рубрики"
        else:
            out["risk_type_chip_fit"] = "данные по совпадению типов не выделены"
    elif used is False:
        out["optional_risk_type_chips"] = "не использовались (необязательный шаг)"
    if mr > 0 and fr == 0:
        out["pattern_note"] = "много неотмеченных зон внимания при почти нулевой отметке рисков"
    elif tr and mr / tr >= 0.5:
        out["pattern_note"] = "заметная доля неотмеченных зон внимания по рубрике"
    return out


def _stage2_behavior_paragraph_for_llm(s2: Dict[str, Any]) -> str:
    """Один абзац про этап 2 для промпта: без цитат пунктов и без эталонных уровней."""
    q = _stage2_qualitative_for_llm(s2)
    if q.get("matrix_rubric"):
        return f"Этап 2 — матрица рисков: {q['matrix_rubric']}."
    bits = [
        f"покрытие отметками относительно рубрики симулятора — {q.get('marked_coverage_vs_rubric', '—')}",
        f"лишние отметки — {q.get('spurious_marks', '—')}",
        f"согласованность уровней/выборов с рубрикой — {q.get('level_and_choice_vs_rubric', '—')}",
    ]
    chips = q.get("optional_risk_type_chips")
    if chips:
        bits.append(f"классификация типов риска (чипы) — {chips}")
        if q.get("risk_type_chip_fit"):
            bits.append(q["risk_type_chip_fit"])
    if q.get("pattern_note"):
        bits.append(f"паттерн: {q['pattern_note']}")
    return "Этап 2 — матрица рисков (без перечисления пунктов договора и без «правильных» уровней): " + "; ".join(bits) + "."


def _compact_stage_details_for_llm(
    stage_details: Dict[str, Any],
    stage1_attr_titles: Optional[Dict[str, str]] = None,
) -> str:
    """Краткая сводка по этапам без огромных вложенных структур."""
    out: Dict[str, Any] = {}
    s1 = stage_details.get("stage-1")
    if isinstance(s1, dict):
        iba = s1.get("insights_by_attribute") or {}
        n_ins = sum(len(v) if isinstance(v, list) else 0 for v in iba.values())
        n_blocks, _n_items = _stage1_insight_counts(iba)
        leg = s1.get("stage1_legitimacy") or {}
        st1_compact: Dict[str, Any] = {
            "questions_count": len(s1.get("questions") or []),
            "insight_items_count": n_ins,
            "brief_blocks_with_notes": n_blocks,
            "coverage_overall": leg.get("overall_coverage"),
            "l_delta": leg.get("l_delta"),
        }
        out["stage1"] = st1_compact
    s2 = stage_details.get("stage-2")
    if isinstance(s2, dict):
        out["stage2"] = _stage2_qualitative_for_llm(s2)
    s3 = stage_details.get("stage-3")
    if isinstance(s3, dict):
        ci = s3.get("chat_formulation_insights") or {}
        s3_compact: Dict[str, Any] = {
            k: s3.get(k)
            for k in ("agreed_count", "not_discussed_count", "in_progress_count", "total_points")
            if s3.get(k) is not None
        }
        if isinstance(ci, dict):
            s3_compact["chat_strong_n"] = len(ci.get("strong") or [])
            s3_compact["chat_weak_n"] = len(ci.get("weak") or [])
        if s3_compact:
            out["stage3"] = s3_compact
    s4 = stage_details.get("stage-4")
    if isinstance(s4, dict):
        out["stage4"] = {
            k: s4.get(k)
            for k in (
                "crisis_injected",
                "stage4_has_narrative",
                "done_count",
                "crisis_actions_count",
                "first_crisis_brief",
                "second_crisis_brief",
                "second_crisis_outcome_hint",
                "first_crisis_diagnosis_choices",
                "second_crisis_diagnosis_choices",
                "contract_edit_choices_readable",
                "stage4_lexic_model_fit",
            )
            if s4.get(k) is not None
        }
    return json.dumps(out, ensure_ascii=False)


def _format_stages_info_for_narrative(stages_info: Any, max_action_titles: int = 22) -> str:
    """
    Человекочитаемый список сценарных действий игрока по этапам (из stages_info отчёта).
    Основа для ИИ-нарратива «что сделал участник на каждом этапе».
    """
    if not isinstance(stages_info, list) or not stages_info:
        return "(Список действий по этапам не передан — опирайся на сводки этапов, хронологию и чаты.)"
    lines: List[str] = []
    for block in stages_info:
        if not isinstance(block, dict):
            continue
        sid = str(block.get("stage_id") or "—")
        title = str(block.get("stage_title") or sid).strip() or sid
        order = block.get("stage_order", "")
        completed = block.get("is_completed")
        comp_s = "завершён" if completed else "не завершён / в процессе на момент отчёта"
        lines.append(f"### Этап {order} — {title} (`{sid}`, {comp_s})")
        done = block.get("done_actions") or []
        if isinstance(done, list) and done:
            titles: List[str] = []
            for a in done[:max_action_titles]:
                if not isinstance(a, dict):
                    continue
                t = str(a.get("title") or "").strip()
                aid = str(a.get("id") or "").strip()
                if t:
                    titles.append(t)
                elif aid:
                    titles.append(aid)
            if titles:
                lines.append(f"- Выполнено действий: {len(done)}. По сценарию: " + "; ".join(titles))
                if len(done) > max_action_titles:
                    lines.append(f"- … и ещё {len(done) - max_action_titles} действий (не перечислены).")
            else:
                lines.append(f"- Выполнено действий по журналу: {len(done)} (без названий в данных).")
        else:
            lines.append("- Выполненных сценарных действий в сводке нет.")
        miss = block.get("missed_actions") or []
        miss_r = block.get("missed_required") or []
        if isinstance(miss_r, list) and miss_r:
            mt = [
                str(a.get("title") or a.get("id") or "").strip()
                for a in miss_r[:12]
                if isinstance(a, dict)
            ]
            mt = [x for x in mt if x]
            if mt:
                lines.append("- Обязательные действия не выполнены: " + "; ".join(mt))
        if isinstance(miss, list) and miss and not miss_r:
            mt = [
                str(a.get("title") or a.get("id") or "").strip()
                for a in miss[:10]
                if isinstance(a, dict)
            ]
            mt = [x for x in mt if x]
            if mt:
                lines.append("- Не сделано необязательных шагов сценария (примеры): " + "; ".join(mt))
        lines.append("")
    text = "\n".join(lines).strip()
    return text[:14000] if len(text) > 14000 else text


def _stage_details_behavior_digest(
    stage_details: Dict[str, Any],
    stage1_attr_titles: Optional[Dict[str, str]] = None,
) -> str:
    """Дополнительные поведенческие фрагменты по этапам (вопросы этапа 1, пункты этапа 3 и т.д.)."""
    parts: List[str] = []
    s1 = stage_details.get("stage-1")
    if isinstance(s1, dict):
        parts.append(_stage1_narrative_behavior_compact(s1, stage1_attr_titles))
    s2 = stage_details.get("stage-2")
    if isinstance(s2, dict):
        parts.append(_stage2_behavior_paragraph_for_llm(s2))
    s3 = stage_details.get("stage-3")
    if isinstance(s3, dict):

        def _clause_ids(lst: Any, n: int = 24) -> List[str]:
            out: List[str] = []
            if not isinstance(lst, list):
                return out
            for x in lst[:n]:
                if isinstance(x, dict) and x.get("clause_id") is not None:
                    out.append(str(x["clause_id"]))
            return out

        ag = _clause_ids(s3.get("agreed") or [])
        nd = _clause_ids(s3.get("not_discussed") or [])
        ip = _clause_ids(s3.get("in_progress") or [])
        if ag or nd or ip or s3.get("agreed_count") is not None:
            parts.append(
                "Этап 3 — распределение пунктов договора по итогу переговоров "
                f"(id пунктов; согласовано/закрыто: {', '.join(ag) if ag else '—'}; "
                f"без обсуждения: {', '.join(nd) if nd else '—'}; в процессе: {', '.join(ip) if ip else '—'})."
            )
    s4 = stage_details.get("stage-4")
    if isinstance(s4, dict) and s4.get("stage4_has_narrative"):
        s4_blk = _build_stage4_narrative_fact_block(s4)
        if s4_blk:
            parts.append(s4_blk)
    if not parts:
        return "(Расширенные поведенческие фрагменты по этапам в данных минимальны.)"
    return "\n\n".join(parts)[:12000]


def _stage2_risk_types_narrative_hint(stage_details: Dict[str, Any]) -> str:
    """
    Человекочитаемый факт для ИИ-нарратива: брал ли участник необязательную классификацию типов риска на этапе 2.
    Без чисел совпадений с эталоном — иначе модель переносит их в текст как «ответы к учебнику».
    """
    s2 = stage_details.get("stage-2")
    if not isinstance(s2, dict):
        return "Сводка этапа 2 в отчёте отсутствует — не выдумывай детали про типы риска."
    used = s2.get("participant_used_risk_types")
    summ = s2.get("summary") or {}
    tag_ok = summ.get("tag_correct_count")
    if used is True:
        fit = ""
        if isinstance(tag_ok, (int, float)):
            t = int(tag_ok)
            if t >= 6:
                fit = " По внутренней рубрике симулятора совпадение типов в основном удачное."
            elif t >= 2:
                fit = " По внутренней рубрике симулятора совпадение типов неоднородное."
            else:
                fit = " По внутренней рубрике симулятора совпадение типов слабое."
        return (
            "Участник заполнял необязательную классификацию типов риска по пунктам договора "
            "(юридический / финансовый / операционный / репутационный)."
            f"{fit} Не указывай в ответе участнику число верных совпадений и не формулируй как долю от объёма матрицы."
        )
    if used is False:
        return (
            "Участник не отмечал типы риска по пунктам на этапе 2 — в симуляторе это необязательный шаг "
            "поверх выбора уровня риска."
        )
    return (
        "Факт заполнения типов риска на этапе 2 в данных отчёта не зафиксирован — "
        "не утверждай, что участник их заполнял или сознательно пропустил."
    )


def _lexic_band_ru(value: float) -> str:
    """Словесная шкала для промпта — чуть строже, чем «всё от 50 среднее»."""
    if value >= 82:
        return "высокий"
    if value >= 70:
        return "хороший"
    if value >= 55:
        return "средний"
    if value >= 42:
        return "ниже среднего"
    return "низкий"


def _lexic_coherent_mean_min(coherent: Dict[str, Any]) -> Tuple[float, float]:
    """
    Среднее — взвешенное (E слабее остальных, см. LEXIC_TOTAL_DISPLAY_WEIGHTS).
    Минимум — только по L, X, I, C: темп (E) не должен тянуть шапку и тон отчёта вниз.
    """
    w = LEXIC_TOTAL_DISPLAY_WEIGHTS
    num = 0.0
    den = 0.0
    for p in LEXIC_PARAMS:
        try:
            v = float(coherent.get(p, 50) or 50)
        except (TypeError, ValueError):
            v = 50.0
        wt = float(w.get(p, 1.0) or 1.0)
        num += wt * v
        den += wt
    mean = (num / den) if den > 0 else 50.0
    subs_mins: List[float] = []
    for p in ("L", "X", "I", "C"):
        try:
            subs_mins.append(float(coherent.get(p, 50) or 50))
        except (TypeError, ValueError):
            subs_mins.append(50.0)
    mn = min(subs_mins) if subs_mins else 50.0
    return mean, mn


def _display_total_score_from_lexic(coherent: Dict[str, Any]) -> int:
    """
    Витринный итог: взвешенное среднее по осям (E слабее); «хвост» — минимум по L/X/I/C,
    чтобы провал по содержательным осям опускал балл, а не низкая эффективность времени.
    """
    mean, mn = _lexic_coherent_mean_min(coherent)
    if mn < 38:
        blended = 0.48 * mean + 0.52 * mn
    elif mn < 46:
        blended = 0.62 * mean + 0.38 * mn
    elif mn < 54:
        blended = 0.78 * mean + 0.22 * mn
    else:
        blended = mean
    return int(round(max(0.0, min(100.0, blended))))


def _report_score_tier(display_score: int, lexic_min: float) -> str:
    if display_score >= 78 and lexic_min >= 55:
        return "excellent"
    if display_score >= 62 and lexic_min >= 44:
        return "good"
    if display_score >= 50 and lexic_min >= 38:
        return "fair"
    return "poor"


def _report_summary_grade_label(display_score: int) -> str:
    """Словесный уровень итога (пороги совпадают с фронтом `reportSummaryGrade.js` v3)."""
    try:
        s = int(round(float(display_score)))
    except (TypeError, ValueError):
        s = 0
    s = max(0, min(100, s))
    tiers = (
        (20, "Неудовлетворительно"),
        (42, "Ниже ожиданий"),
        (54, "Посредственно"),
        (69, "Удовлетворительно"),
        (82, "Хорошо"),
        (93, "Отлично"),
        (100, "Безупречно"),
    )
    for mx, lab in tiers:
        if s <= mx:
            return lab
    return "Безупречно"


def _compute_timing_data(
    session: Dict[str, Any],
    timeline: List[Dict[str, Any]],
    case_data: Dict[str, Any],
    session_external_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Вычислить длительность прохождения (общую и по этапам) из session.started_at + timeline; запасной источник — game_session."""
    result: Dict[str, Any] = {"total_seconds": None, "stages": []}

    def _parse_ts(raw: Any) -> Optional[datetime]:
        if raw is None:
            return None
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None

    def _make_comparable(*timestamps: Optional[datetime]) -> None:
        """Ensure all timestamps are either all naive or all aware by stripping tzinfo."""
        pass

    all_ts: List[datetime] = []
    if timeline:
        for ev in timeline:
            ts = _parse_ts(ev.get("created_at"))
            if ts:
                all_ts.append(ts)

    started_at = _parse_ts(session.get("started_at"))
    if started_at and all_ts:
        all_ts_aware = any(t.tzinfo is not None for t in all_ts)
        if all_ts_aware and started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=all_ts[0].tzinfo)
    elif started_at is None and all_ts:
        started_at = min(all_ts)

    if started_at is None:
        _apply_game_session_timing_fallback(result, session_external_id, timeline, case_data)
        return result

    if all_ts:
        last_ts = max(all_ts)
        if last_ts.tzinfo is not None and started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=last_ts.tzinfo)
        elif last_ts.tzinfo is None and started_at.tzinfo is not None:
            last_ts = last_ts.replace(tzinfo=started_at.tzinfo)
    else:
        last_ts = started_at

    result["total_seconds"] = max(0, int((last_ts - started_at).total_seconds()))

    stages_cfg = case_data.get("stages") or []
    if not timeline:
        _apply_game_session_timing_fallback(result, session_external_id, timeline, case_data)
        return result

    stage_first_ts: Dict[str, datetime] = {}
    stage_last_ts: Dict[str, datetime] = {}
    stage_complete_at: Dict[str, datetime] = {}
    for ev in timeline:
        sc = ev.get("stage_code")
        ca = ev.get("created_at")
        if not sc or not ca:
            continue
        try:
            ts = datetime.fromisoformat(str(ca).replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        if sc not in stage_first_ts or ts < stage_first_ts[sc]:
            stage_first_ts[sc] = ts
        if sc not in stage_last_ts or ts > stage_last_ts[sc]:
            stage_last_ts[sc] = ts
        if (ev.get("action_type") or "") == "stage_complete":
            if sc not in stage_complete_at or ts > stage_complete_at[sc]:
                stage_complete_at[sc] = ts

    def _align_pair(a: datetime, b: datetime) -> Tuple[datetime, datetime]:
        if b.tzinfo is not None and a.tzinfo is None:
            a = a.replace(tzinfo=b.tzinfo)
        elif a.tzinfo is not None and b.tzinfo is None:
            b = b.replace(tzinfo=a.tzinfo)
        return a, b

    ordered_ids = [st.get("id") or f"stage-{i + 1}" for i, st in enumerate(stages_cfg)]

    for idx, st in enumerate(stages_cfg):
        sid = ordered_ids[idx]
        f = stage_first_ts.get(sid)
        l = stage_last_ts.get(sid)
        end_c = stage_complete_at.get(sid)
        secs: Optional[int] = None

                                                                              
                                                                                           
        if end_c is not None:
            if idx == 0:
                start_c = started_at
            else:
                prev_sid = ordered_ids[idx - 1]
                start_c = stage_complete_at.get(prev_sid)
                if start_c is None:
                    start_c = f
            if start_c is None:
                start_c = f or started_at
            start_c, end_c = _align_pair(start_c, end_c)
            secs = max(0, int((end_c - start_c).total_seconds()))
        elif f and l:
            start_e, end_e = _align_pair(f, l)
            secs = max(0, int((end_e - start_e).total_seconds()))
        elif f:
            secs = 0
        result["stages"].append({
            "stage_id": sid,
            "stage_title": st.get("title") or f"Этап {idx + 1}",
            "seconds": secs,
        })
    _apply_game_session_timing_fallback(result, session_external_id, timeline, case_data)
    return result


def _compute_ranking_data(
    session_external_id: Optional[str],
    case_code: str,
    total_score: int,
) -> Dict[str, Any]:
    """Вычислить процентиль участника среди всех завершённых сессий того же кейса."""
    result: Dict[str, Any] = {
        "percentile": None,
        "total_sessions": 0,
        "rank": None,
    }
    if not session_external_id or not case_code:
        return result
    try:
        from db import get_connection
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT COUNT(*) FROM game_session
                    WHERE case_code = %s
                      AND payload_json IS NOT NULL
                      AND payload_json->'report_snapshot' IS NOT NULL
                      AND payload_json->>'report_snapshot' != 'null'
                    """,
                    (case_code,),
                )
                total_row = cur.fetchone()
                total_sessions = total_row[0] if total_row else 0
                if total_sessions < 2:
                    result["total_sessions"] = max(1, total_sessions)
                    result["percentile"] = 100
                    result["rank"] = 1
                    return result

                cur.execute(
                    """
                    SELECT external_id, payload_json->'lexic' as lex
                    FROM game_session
                    WHERE case_code = %s
                      AND payload_json IS NOT NULL
                      AND payload_json->'report_snapshot' IS NOT NULL
                      AND payload_json->>'report_snapshot' != 'null'
                    """,
                    (case_code,),
                )
                rows = cur.fetchall()
                scores = []
                for ext_id, lex_json in rows:
                    if not lex_json or not isinstance(lex_json, dict):
                        scores.append((ext_id, 50))
                        continue
                    coherent = apply_lexic_interest_legitimacy_coherence(lex_json)
                    s = _display_total_score_from_lexic(coherent)
                    scores.append((ext_id, s))
                scores.sort(key=lambda x: x[1], reverse=True)
                total_n = len(scores)
                my_rank = total_n
                for i, (eid, s) in enumerate(scores):
                    if eid == session_external_id:
                        my_rank = i + 1
                        break
                below_count = sum(1 for _, s in scores if s < total_score)
                percentile = round(below_count / total_n * 100) if total_n > 0 else 100
                result["percentile"] = percentile
                result["total_sessions"] = total_n
                result["rank"] = my_rank
    except Exception as exc:
        print(f"⚠️ _compute_ranking_data: {exc}")
    return result


_LEXIC_AXIS_LABELS_FOR_NARRATIVE: Dict[str, str] = {
    "L": "легитимность и опора на процедуру кейса (бриф, гайд, матрица рисков)",
    "E": "эффективность использования времени и качества вопросов на этапе контекста",
    "X": "экспертиза в выявлении и классификации рисков по договору",
    "I": "учёт интересов компании при разметке типов рисков",
    "C": "ясность формулировок и аргументации в переговорах и диалогах",
}


def _lexic_digest_for_narrative(lexic: Dict[str, Any]) -> str:
    """
    Краткая словесная сводка LEXIC для промпта — без JSON, чтобы модель интерпретировала, а не копировала цифры.
    """
    labels = _LEXIC_AXIS_LABELS_FOR_NARRATIVE
    lines: List[str] = []
    for p in LEXIC_PARAMS:
        try:
            v = float(lexic.get(p, 50))
        except (TypeError, ValueError):
            v = 50.0
        lines.append(f"— {p} ({labels[p]}): {_lexic_band_ru(v)} уровень (ориентир ~{round(v)} из 100).")
    return "\n".join(lines)


def _full_lexic_digest_for_narrative(
    raw_lexic: Dict[str, Any],
    final_norm: Optional[Dict[str, Any]],
) -> str:
    """Сырой профиль движка + при наличии нормализованный итог (как на радаре отчёта)."""
    base = _lexic_digest_for_narrative(raw_lexic)
    if not final_norm or not isinstance(final_norm, dict):
        return base
    labels = _LEXIC_AXIS_LABELS_FOR_NARRATIVE
    norm_lines: List[str] = []
    for p in LEXIC_PARAMS:
        if p not in final_norm:
            continue
        try:
            v = float(final_norm[p])
        except (TypeError, ValueError):
            continue
        norm_lines.append(f"— {p} ({labels[p]}): {_lexic_band_ru(v)} уровень (ориентир ~{round(v)} из 100).")
    if not norm_lines:
        return base
    if not any(abs(float(final_norm.get(p, 50)) - 50.0) > 0.5 for p in LEXIC_PARAMS if p in final_norm):
        return base
    return (
        base
        + "\n\nНормализованный итог по методике кейса (согласуется с радаром в интерфейсе при наличии снимков этапов):\n"
        + "\n".join(norm_lines)
    )


def _growth_points_digest_for_narrative(points: Any, max_items: int = 10) -> str:
    """Крупные перепады нормализованного LEXIC между этапами — для приоритизации советов."""
    if not isinstance(points, list) or not points:
        return ""
    lines: List[str] = []
    for item in points[:max_items]:
        if not isinstance(item, dict):
            continue
        sc = str(item.get("stage_code") or "?")
        pname = str(item.get("param_name") or item.get("param") or "?")
        try:
            d = float(item.get("delta", 0))
        except (TypeError, ValueError):
            d = 0.0
        kind = item.get("type")
        tag = "усиление" if kind == "growth" else "просадка" if kind == "decline" else "изменение"
        lines.append(f"— После {sc}: «{pname}» ~{d:+.1f} ({tag}).")
    if not lines:
        return ""
    return (
        "Крупные перепады нормализованного профиля между этапами (ориентир для приоритетов в советах):\n"
        + "\n".join(lines)
    )


def _soft_skills_digest(soft_skills: Dict[str, Any]) -> str:
    if not soft_skills:
        return "Нет сведений."
    parts: List[str] = []
    for k, v in list(soft_skills.items())[:12]:
        if isinstance(v, (int, float)):
            parts.append(f"{k}: {round(float(v), 2)}")
        elif isinstance(v, str) and v.strip():
            parts.append(f"{k}: {v.strip()[:200]}")
        elif isinstance(v, dict):
            parts.append(f"{k}: {json.dumps(v, ensure_ascii=False)[:300]}")
    return "\n".join(parts) if parts else "Нет сведений."


def _recommendations_digest(recs: List[Any]) -> str:
    if not recs:
        return "Нет."
    lines: List[str] = []
    for i, r in enumerate(recs[:12], 1):
        lines.append(f"{i}. {str(r).strip()}")
    return "\n".join(lines)


_RISK_LEVEL_RANK: Dict[str, int] = {
    "low": 0,
    "низкий": 0,
    "medium": 1,
    "средний": 1,
    "high": 2,
    "высокий": 2,
}


def _risk_level_rank(level: Any) -> Optional[int]:
    if level is None:
        return None
    s = str(level).strip().lower()
    return _RISK_LEVEL_RANK.get(s)


def _stage1_attribute_titles(case_data: Dict[str, Any]) -> Dict[str, str]:
    for st in case_data.get("stages") or []:
        if not isinstance(st, dict) or st.get("id") != "stage-1":
            continue
        out: Dict[str, str] = {}
        for a in st.get("attributes") or []:
            if not isinstance(a, dict):
                continue
            aid = str(a.get("id") or "").strip()
            if aid:
                out[aid] = str(a.get("title") or aid).strip() or aid
        return out
    return {}


def _stage1_insight_item_text(entry: Any, max_len: int = 220) -> str:
    """Текст одной заметки брифа: клиент шлёт строки; автоплей/старые сессии — dict с полем text."""
    if entry is None:
        return ""
    if isinstance(entry, str):
        return entry.strip()[:max_len]
    if isinstance(entry, dict):
        return str(entry.get("text") or "").strip()[:max_len]
    return str(entry).strip()[:max_len]


def _format_stage1_insights_for_digest(
    iba: Any,
    attr_titles: Optional[Dict[str, str]] = None,
    *,
    max_per_attr: int = 8,
    max_item_len: int = 220,
) -> List[str]:
    """Строки для промпта: заметки по блокам (дословные фрагменты). Для нарратива отчёта не используется — иначе модель копирует структуру брифа и подсказки."""
    if not isinstance(iba, dict) or not iba:
        return []
    titles = attr_titles or {}
    lines_ins: List[str] = []
    for attr_key, insights in iba.items():
        if not isinstance(insights, list) or not insights:
            continue
        ak = str(attr_key)
        block = titles.get(ak) or ak
        items = [
            t
            for t in (
                _stage1_insight_item_text(x, max_item_len)
                for x in insights[:max_per_attr]
            )
            if t
        ]
        if items:
            lines_ins.append(f"  «{block}» (id {ak}): " + " | ".join(items))
    return lines_ins


def _stage1_insight_counts(iba: Any) -> tuple[int, int]:
    """(число блоков с хотя бы одной заметкой, общее число заметок)."""
    if not isinstance(iba, dict) or not iba:
        return 0, 0
    blocks = 0
    total = 0
    for _k, insights in iba.items():
        if not isinstance(insights, list) or not insights:
            continue
        texts = [_stage1_insight_item_text(x, 4096) for x in insights]
        texts = [t for t in texts if t]
        if texts:
            blocks += 1
            total += len(texts)
    return blocks, total


def _stage1_narrative_behavior_compact(
    s1: Dict[str, Any],
    _stage1_attr_titles: Optional[Dict[str, str]] = None,
) -> str:
    """
    Сводка этапа 1 для ИИ-нарратива: без дословных заметок по разделам брифа и без перечня названий блоков —
    иначе текст отчёта повторяет форму ключей к ответу.
    """
    parts: List[str] = []
    qs = s1.get("questions") or []
    g = m = b = 0
    if isinstance(qs, list):
        for q in qs:
            if not isinstance(q, dict):
                continue
            if q.get("quality_hint") == "off_topic":
                continue
            qn = str(q.get("quality") or "").strip().lower()
            if qn == "good":
                g += 1
            elif qn in ("medium", "poor"):
                m += 1
            elif qn == "bad":
                b += 1
    parts.append(
        "Этап 1 — вопросы к инициатору (агрегат): "
        f"хороших по глубине {g}, средних/уточняющих {m}, слабых {b}. "
        "Не пересказывай формулировки вопросов и не привязывай выводы к названиям блоков брифа из кейса."
    )
    iba = s1.get("insights_by_attribute") or {}
    n_blocks, n_ins = _stage1_insight_counts(iba)
    leg = s1.get("stage1_legitimacy") or {}
    cov = leg.get("overall_coverage")
    cov_s = ""
    if cov is not None:
        try:
            cov_s = f" Покрытие ключевых фактов по модели симулятора (без перечня фактов): ~{int(round(float(cov) * 100))}%."
        except (TypeError, ValueError):
            cov_s = ""
    parts.append(
        f"Этап 1 — работа с брифом: блоков с осмысленным текстом {n_blocks}, всего заметок {n_ins}.{cov_s} "
        "Не цитируй заметки и не разбирай отчёт по разделам брифа один в один."
    )
    conc = str(s1.get("conclusion_text") or "").strip()
    if len(conc) > 40:
        parts.append(
            "Этап 1 — заключение участника (короткий фрагмент для оценки связности и правового тона, не для пересказа):\n"
            + conc[:480]
        )
    return "\n".join(parts)


def _tag_mismatch_hint(tag_results: Optional[Dict[str, Any]]) -> Optional[str]:
    if not tag_results or not isinstance(tag_results, dict):
        return None
    wrong = any(v == "wrong" for v in tag_results.values())
    missed = any(v == "missed" for v in tag_results.values())
    if wrong and missed:
        return "Типы риска по пункту не совпали с тем, что в учебной модели считается полным и точным набором."
    if wrong:
        return "Отмечены типы риска, которые для этого пункта в модели кейса не подтверждаются."
    if missed:
        return "Не отражены типы риска, которые для этого пункта в модели кейса считаются важными."
    return None


def build_reference_gap_notes(
    session: Dict[str, Any],
    case_data: Dict[str, Any],
    data_dir: Path,
    *,
    max_lines: int = 44,
) -> List[str]:
    """
    Краткие педагогические заметки: где поведение участника расходится с учебной моделью кейса
    и где на этапе 4 явно совпало с моделью (диагностика, правки договора, скорость).
    Без раскрытия эталонных ответов (не указываем правильные уровни, варианты A/B/C, ID ответов).
    """
    lines: List[str] = []
    _raw_cid = (
        session.get("case_id") or session.get("case_code") or case_data.get("id") or ""
    ).strip()
    case_id = canonical_case_code(_raw_cid) if _raw_cid else ""

                    
    s1 = session.get("stage1_result")
    if isinstance(s1, dict):
        weak_q = 0
        for q in s1.get("questions") or []:
            if not isinstance(q, dict):
                continue
            qn = (q.get("quality") or "").strip().lower()
            if qn in ("bad", "medium", "poor"):
                weak_q += 1
                if weak_q <= 2:
                    lines.append(
                        "Этап 1 (контекст): часть вопросов к инициатору по отдельным темам брифа получилась менее глубокой, "
                        "чем ожидает методика кейса — не хватило конкретики или недостающих уточнений."
                    )
        if weak_q > 2:
            lines.append(
                "Этап 1: несколько тем брифа закрыты вопросами средней или слабой глубины относительно модели кейса."
            )
        for q in s1.get("questions") or []:
            if not isinstance(q, dict):
                continue
            qn = (q.get("quality") or "").strip().lower()
            if qn == "good" and q.get("ideal_insight_received") is False:
                lines.append(
                    "Этап 1: по отдельной теме вопрос к инициатору сильный по форме, но из ответа не зафиксирована "
                    "полнота по ожиданиям методики — не хватило уточняющего вопроса или проверки предположения."
                )
                break
        ct = str(s1.get("conclusion_text") or "").strip()
        if ct and len(ct) < 50:
            lines.append(
                "Этап 1: итоговое заключение по брифу очень короткое — по методике кейса полезнее явно связать выводы с рисками и пробелами сделки."
            )

                    
                                                                                             
                                                                 
    s2rep = session.get("stage2_report")
    if isinstance(s2rep, dict):
        summ = s2rep.get("summary") or {}
        mc_wrong = summ.get("missing_conditions_wrong_count")
        if isinstance(mc_wrong, int) and mc_wrong > 0:
            lines.append(
                "Этап 2 (риски): в блоке «недостающие условия» выбор не совпал с тем, что в модели считается полным и точным."
            )
        stats = s2rep.get("statistics") or {}
        err_n = stats.get("errors")
        if isinstance(err_n, int) and err_n >= 3:
            lines.append(
                "Этап 2: много расхождений с матрицей рисков по разным пунктам — типичный паттерн: не дочитывать формулировку "
                "или путать уровень опасности с «шумом» в тексте."
            )
        tr = int(summ.get("total_risks") or 0)
        fr = int(summ.get("found_risks") or 0)
        mr = int(summ.get("missed_risks") or 0)
        fpos = int(summ.get("false_positives") or 0)
        if tr > 0 and fr == 0 and mr > 0:
            lines.append(
                "Этап 2 (риски): по рубрике симулятора отмечено мало или ноль существенных зон внимания в матрице — "
                "стоит тренировать чтение договора по слоям (финансы, исполнение, право, границы ответственности), без привязки к конкретным пунктам этого кейса."
            )
        elif tr > 0 and mr > 0 and (mr / tr) >= 0.45:
            lines.append(
                "Этап 2 (риски): заметная часть зон внимания по рубрике симулятора осталась без отметки."
            )
        if isinstance(err_n, int) and 1 <= err_n <= 2:
            lines.append(
                "Этап 2 (риски): есть отдельные расхождения по уровню риска или выбору пункта относительно рубрики симулятора — "
                "полезно сверять формулировку с последствиями для сторон."
            )
        if fpos >= 2:
            lines.append(
                "Этап 2 (риски): встречаются отметки риска там, где рубрика симулятора не считает пункт ключевым — проверяйте опору на текст и избегайте «риска ради риска»."
            )
        cr = s2rep.get("clause_results") or []
        tag_issue = False
        for row in cr:
            if not isinstance(row, dict) or not row.get("user_selected"):
                continue
            th = _tag_mismatch_hint(row.get("tag_results"))
            if th:
                tag_issue = True
                break
        if tag_issue:
            lines.append(
                "Этап 2 (риски): по классификации типов риска (чипы) есть расхождения с рубрикой симулятора — "
                "имеет смысл отдельно тренировать соответствие формулировки и юридического/финансового/операционного измерения."
            )

                                                                                                                               
                                                                          

                    
    s4s = session.get("stage_4_state") or {}
    if isinstance(s4s, dict) and s4s.get("selected_crisis_id_first"):
        try:
            from services.stage4_lexic_service import compute_stage4_lexic

            raw_sc = load_crisis_scenarios(data_dir, case_id) if case_id else None
            slist = (raw_sc or {}).get("crisis_scenarios") or []
            by_c = {
                str(s.get("crisis_id") or s.get("id")): s
                for s in slist
                if isinstance(s, dict) and (s.get("crisis_id") or s.get("id"))
            }
            lex4 = compute_stage4_lexic(s4s, by_c)
            det = (lex4 or {}).get("details") or {}
            id_first = str(s4s.get("selected_crisis_id_first") or "")
            id_second = str(s4s.get("selected_crisis_id_second") or "")
            if id_first:
                lines.append(
                    "Этап 4 (журнал симулятора): первый сценарий кризиса id "
                    + id_first
                    + (f"; второй сценарий id {id_second}." if id_second else ".")
                )

            def _crisis_diag(which: str, label: str) -> None:
                nonlocal lines
                q1 = (det.get(f"q1_{which}") or {}).get("result")
                q2 = (det.get(f"q2_{which}") or {}).get("result")
                q3 = (det.get(f"q3_{which}") or {}).get("result")
                if q1 == "wrong":
                    lines.append(
                        f"{label}: степень угрозы в диагностике не совпала с тем, что заложено в сценарии (возможна недо- или переоценка)."
                    )
                if q2 == "wrong":
                    lines.append(
                        f"{label}: правовое основание подобрано неполностью или с лишними вариантами относительно модели кейса."
                    )
                if q3 == "wrong":
                    lines.append(
                        f"{label}: первая мера в приоритете не оптимальна по сценарию (есть более удачный или менее рискованный ход)."
                    )
                if q3 == "acceptable":
                    lines.append(
                        f"{label}: выбранная мера допустима, но в сценарии предпочтительнее другой приоритет действий."
                    )

            _crisis_diag("first", "Кризис (первая диагностика)")
            q1f = (det.get("q1_first") or {}).get("result")
            q2f = (det.get("q2_first") or {}).get("result")
            q3f = (det.get("q3_first") or {}).get("result")
            if q1f == "correct" and q2f == "correct" and q3f == "correct":
                lines.append(
                    "Этап 4 (первый кризис): диагностика в целом согласована с учебной моделью сценария (угроза, правовое основание, первая мера)."
                )
            else:
                if q1f == "correct":
                    lines.append("Этап 4 (первый кризис): оценка степени угрозы совпала с моделью кейса.")
                if q2f == "correct":
                    lines.append("Этап 4 (первый кризис): набор правовых оснований совпал с моделью кейса.")
                if q3f == "correct":
                    lines.append("Этап 4 (первый кризис): приоритетная мера совпала с предпочтительным ходом по модели кейса.")
            acc = (det.get("accept") or {}).get("result")
            ttv = str(s4s.get("time_travel_choice") or "")
            if acc == "error":
                lines.append(
                    "Кризис: сочетание «принять последствия» и твоей оценки угрозы в модели выглядит менее удачным — часто имеет смысл вернуться к договору."
                )
            elif acc == "ok" and ttv != "return":
                lines.append(
                    "Этап 4: без возврата к договору сочетание оценки угрозы и линии «принять последствия» согласовано с моделью кейса."
                )
            ce = det.get("clause_edits") or {}
            saw_wrong_edit = saw_acc_edit = saw_ign = False
            for item in (ce.get("clause_details") or [])[:12]:
                if not isinstance(item, dict):
                    continue
                res = item.get("result")
                if res == "wrong" and not saw_wrong_edit:
                    saw_wrong_edit = True
                    lines.append(
                        "Кризис: при возврате к договору хотя бы одна правка не приводит к целевому снятию основания по учебной модели."
                    )
                elif res == "acceptable" and not saw_acc_edit:
                    saw_acc_edit = True
                    lines.append(
                        "Кризис: есть компромиссные формулировки — сценарий допускает, но не как лучший исход."
                    )
                elif res == "ignored_risky" and not saw_ign:
                    saw_ign = True
                    lines.append(
                        "Кризис: не затронуты пункты, которые сценарий помечает как требующие изменения при возврате."
                    )
            clause_details = ce.get("clause_details") or []
            n_cor = sum(1 for x in clause_details if isinstance(x, dict) and x.get("result") == "correct")
            n_wr = sum(1 for x in clause_details if isinstance(x, dict) and x.get("result") == "wrong")
            n_ign = sum(1 for x in clause_details if isinstance(x, dict) and x.get("result") == "ignored_risky")
            if clause_details and n_wr == 0 and n_ign == 0 and n_cor > 0:
                lines.append(
                    "Этап 4: выбранные редакции договора по проверенным пунктам совпали с целевой моделью кейса."
                )
            elif n_cor and (n_wr or n_ign):
                lines.append(
                    "Этап 4: часть редакций договора совпала с целевой моделью кейса; по отдельным пунктам остаётся расхождение или пропуск."
                )
            sp = (det.get("speed") or {}).get("result")
            if sp == "late":
                lines.append(
                    "Кризис: по времени правки договора ты уложился(ась) хуже, чем ожидает модель для бонуса за скорость."
                )
            elif sp == "fast":
                lines.append(
                    "Этап 4: время внесения правок в договор после возврата быстрее порога модели для лучшего бонуса за скорость."
                )
            elif sp == "ontime":
                lines.append(
                    "Этап 4: время внесения правок укладывается в ожидания модели по скорости."
                )

            if s4s.get("diagnosis_answers_second"):
                _crisis_diag("second", "Кризис (вторая диагностика)")
                q1s = (det.get("q1_second") or {}).get("result")
                q2s = (det.get("q2_second") or {}).get("result")
                q3s = (det.get("q3_second") or {}).get("result")
                if q1s == "correct" and q2s == "correct" and q3s == "correct":
                    lines.append(
                        "Этап 4 (второй кризис): диагностика в целом согласована с учебной моделью сценария."
                    )
                else:
                    if q1s == "correct":
                        lines.append("Этап 4 (второй кризис): оценка угрозы совпала с моделью кейса.")
                    if q2s == "correct":
                        lines.append("Этап 4 (второй кризис): правовые основания совпали с моделью кейса.")
                    if q3s == "correct":
                        lines.append("Этап 4 (второй кризис): приоритетная мера совпала с предпочтительным ходом по модели кейса.")
        except Exception:
            pass

             
    out = [ln for ln in lines if isinstance(ln, str) and ln.strip()]
    return out[:max_lines]


def _reference_gap_notes_for_stage3(stage3: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(stage3, dict):
        return []
    notes: List[str] = []
    nd = int(stage3.get("not_discussed_count") or 0)
    ip = int(stage3.get("in_progress_count") or 0)
    if nd > 0:
        notes.append(
            f"Этап 3 (переговоры): {nd} пункт(ов) остались без обсуждения — в полном прохождении обычно важнее закрыть больше зон риска диалогом."
        )
    if ip > 0:
        notes.append(
            "Этап 3: часть пунктов осталась в незавершённом статусе переговоров относительно зафиксированного состояния сессии."
        )
    return notes


def _crisis_risk_option_map(crisis: Dict[str, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for q in crisis.get("diagnostic_questions") or []:
        if not isinstance(q, dict):
            continue
        if q.get("type") != "risk_assessment" and str(q.get("question_id") or "") not in ("q1-risk", "q1"):
            continue
        for o in q.get("options") or []:
            if isinstance(o, dict) and o.get("id"):
                out[str(o["id"])] = str(o.get("text") or o["id"]).strip()
        break
    return out


def _diagnosis_readable_block(crisis: Dict[str, Any], answers: Dict[str, Any]) -> Dict[str, Any]:
    """Тексты выбранных ответов кризисной диагностики (без подсветки эталона)."""
    if not isinstance(crisis, dict) or not isinstance(answers, dict):
        return {}
    block: Dict[str, Any] = {}
    rmap = _crisis_risk_option_map(crisis)
    r1 = answers.get("q1-risk") or answers.get("risk_assessment") or answers.get("q1")
    if r1:
        block["threat_choice"] = rmap.get(str(r1), str(r1))

    raw_lb = answers.get("q2-legal") or answers.get("legal_basis") or []
    ids = raw_lb if isinstance(raw_lb, list) else ([raw_lb] if raw_lb else [])
    id_set = {str(x) for x in ids}
    lb_texts: List[str] = []
    for opt in crisis.get("legal_basis_options") or []:
        if not isinstance(opt, dict):
            continue
        oid = str(opt.get("id") or opt.get("option_id") or "")
        if oid in id_set:
            t = str(opt.get("text") or "").strip()
            if t:
                lb_texts.append(t)
    if lb_texts:
        block["legal_basis_choices"] = lb_texts

    q3 = (
        answers.get("q3-action")
        or answers.get("immediate_action")
        or answers.get("q3")
    )
    for o in crisis.get("immediate_action_options") or []:
        if isinstance(o, dict) and str(o.get("id")) == str(q3):
            block["first_measure_choice"] = str(o.get("text") or o.get("id") or "").strip()
            break
    return block


def _contract_selections_readable(
    selections: Dict[str, Any],
    contract_doc: Dict[str, Any],
) -> List[Dict[str, str]]:
    if not isinstance(selections, dict) or not selections:
        return []
    by_clause = {str(c.get("clause_id") or c.get("id") or ""): c for c in (contract_doc.get("clauses") or []) if isinstance(c, dict)}
    rows: List[Dict[str, str]] = []
    for cid_raw, var_id in selections.items():
        cid = str(cid_raw)
        c = by_clause.get(cid) or {}
        title = str(c.get("title") or cid).strip()
        vid = str(var_id or "").upper()
        label = ""
        summary = ""
        for v in c.get("variants") or []:
            if not isinstance(v, dict):
                continue
            if str(v.get("id") or "").upper() == vid:
                label = str(v.get("label") or vid).strip()
                summary = str(v.get("text") or v.get("effect") or "").strip()[:240]
                break
        rows.append(
            {
                "clause_id": cid,
                "clause_title": title,
                "variant_id": vid,
                "variant_label": label or vid,
                "variant_summary": summary,
            }
        )
    return rows


def _merge_stage4_readable_summary(
    out: Dict[str, Any],
    s4s: Dict[str, Any],
    case_id_clean: str,
) -> None:
    if not s4s or not case_id_clean:
        return
    raw_sc = load_crisis_scenarios(DATA_DIR, case_id_clean) or {}
    slist = raw_sc.get("crisis_scenarios") or []
    by_c = {
        str(s.get("crisis_id") or s.get("id")): s
        for s in slist
        if isinstance(s, dict) and (s.get("crisis_id") or s.get("id"))
    }
    id1 = str(s4s.get("selected_crisis_id_first") or "")
    id2 = str(s4s.get("selected_crisis_id_second") or "")
    a1 = s4s.get("diagnosis_answers_first") or {}
    a2 = s4s.get("diagnosis_answers_second") or {}
    if isinstance(a1, dict) and id1:
        c1 = by_c.get(id1) or {}
        d1 = _diagnosis_readable_block(c1, a1)
        if d1:
            out["first_crisis_diagnosis_choices"] = d1
    if isinstance(a2, dict) and id2 and a2:
        c2 = by_c.get(id2) or {}
        d2 = _diagnosis_readable_block(c2, a2)
        if d2:
            out["second_crisis_diagnosis_choices"] = d2
    cdoc = load_contract_clauses(DATA_DIR, case_id_clean) or {}
    sel = s4s.get("contract_selections") or {}
    if isinstance(sel, dict) and sel:
        out["contract_edit_choices_readable"] = _contract_selections_readable(sel, cdoc)


def _reference_gap_notes_from_stage3_chat(stage3: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(stage3, dict):
        return []
    ci = stage3.get("chat_formulation_insights") or {}
    weak = ci.get("weak") or []
    lines: List[str] = []
    for w in weak[:5]:
        if not isinstance(w, dict):
            continue
        t = str(w.get("clause_title") or "пункт").strip()
        ex = str(w.get("last_player_message_excerpt") or "").strip().replace("\n", " ")
        if len(ex) > 140:
            ex = ex[:137] + "…"
        lines.append(
            f"Этап 3 (переговоры): по теме «{t}» по методике оценки диалога этапа 3 (шкалы L–C) формулировки в чате выглядят слабо "
            f"(структура, опора на договор, баланс интересов). "
            f"Фрагмент твоей реплики: «{ex or '…'}»."
        )
    return lines


def _enrich_stage3_with_chat_insights(
    base: Dict[str, Any],
    neg_id: int,
    data_dir: Path,
    case_id_clean: str,
    *,
    use_ai: bool = True,
) -> Dict[str, Any]:
    out = dict(base)
    try:
        hist = get_negotiation_history(int(neg_id))
    except Exception:
        return out
    by_c = hist.get("chat_history_by_clause") or {}
    if not by_c:
        return out
    try:
        cd = _load_stage2_contract(data_dir, case_id_clean)
        clause_list = cd.get("clauses") or []
        lex3 = compute_stage3_lexic_deltas(
            hist, clause_list, include_details=True, use_ai=use_ai
        )
    except Exception:
        return out
    clause_scores = lex3.get("clause_scores") or []
    insights: List[Dict[str, Any]] = []
    for item in clause_scores:
        if not isinstance(item, dict):
            continue
        cid = str(item.get("clause_id") or "")
        eval_method = str(item.get("method") or "rules")
        scores = item.get("scores") or {}
        if not isinstance(scores, dict):
            continue
        avg = sum(float(scores.get(p, 0) or 0) for p in ("L", "E", "X", "I", "C")) / 5.0
        msgs = by_c.get(cid)
        if msgs is None and cid.isdigit():
            msgs = by_c.get(str(int(cid)))
        if not isinstance(msgs, list):
            msgs = []
        excerpt = ""
        for m in reversed(msgs):
            if not isinstance(m, dict):
                continue
            if m.get("owner") in ("player", "user"):
                excerpt = str(m.get("text") or m.get("content") or "").strip().replace("\n", " ")
                break
        clause_title = ""
        for c in clause_list:
            if not isinstance(c, dict):
                continue
            if str(c.get("id") or c.get("clause_id") or "") == cid:
                clause_title = str(c.get("title") or c.get("short_title") or "").strip()[:100]
                break
        insights.append(
            {
                "clause_id": cid,
                "clause_title": clause_title or f"пункт {cid}",
                "avg_rule_score": round(avg, 2),
                "eval_method": eval_method,
                "last_player_message_excerpt": excerpt[:220],
            }
        )
    strong = sorted([x for x in insights if x["avg_rule_score"] >= 6.5], key=lambda x: -x["avg_rule_score"])[:5]
    weak = sorted([x for x in insights if x["avg_rule_score"] < 5.0], key=lambda x: x["avg_rule_score"])[:5]
    out["chat_formulation_insights"] = {
        "strong": strong,
        "weak": weak,
        "per_clause": insights[:14],
        "method_summary": lex3.get("method_summary"),
    }
    return out


def _resolve_case_asset_path(data_dir: Path, rel: str) -> Optional[Path]:
    """Путь к файлу внутри data/: rel как в JSON ('data/cases/...' или 'cases/...')."""
    rel = str(rel or "").strip().replace("\\", "/")
    if not rel:
        return None
    if rel.startswith("data/"):
        p = data_dir / rel[5:]
    else:
        p = data_dir / rel
    return p if p.is_file() else None


def _read_case_legend_md(data_dir: Path, case_id: str, stage_id: str) -> Optional[str]:
    """Текст legend.md этапа (как на экране), без лишних логов."""
    _raw = str(case_id).strip()
    if not _raw:
        return None
    clean = case_suffix(canonical_case_code(_raw))
    if not clean:
        return None
    p = data_dir / "cases" / f"case-{clean}" / stage_id / "legend.md"
    if not p.is_file():
        return None
    try:
        return p.read_text(encoding="utf-8")
    except OSError:
        return None


def _live_case_sources_for_narrative_llm(data_dir: Path, case_data: Dict[str, Any]) -> str:
    """
    Факты из файлов, реально используемых этапами (легенды, gameData), чтобы модель не опиралась
    на устаревшие однострочники в JSON.
    """
    parts: List[str] = []
    case_id = str(case_data.get("id") or "").strip()
    if not case_id:
        return ""
    for sid in ("stage-1", "stage-3"):
        md = _read_case_legend_md(data_dir, case_id, sid)
        if md and md.strip():
            flat = " ".join(md.split())[:2000]
            parts.append(f"[{sid} legend.md]\n{flat}")
    contract = case_data.get("contract") if isinstance(case_data.get("contract"), dict) else {}
    gd_rel = (contract or {}).get("gamedata_path") or (contract or {}).get("gamedata_json")
    if gd_rel:
        gp = _resolve_case_asset_path(data_dir, str(gd_rel))
        if gp:
            try:
                with gp.open("r", encoding="utf-8") as f:
                    g = json.load(f)
                                                                                                         
                cp = str(g.get("counterpart_persona") or "").strip()
                if cp:
                    parts.append(f"[gameData.json] counterpart_persona (начало): {cp[:520]}")
            except (OSError, json.JSONDecodeError):
                pass
    return "\n\n".join(parts)


def _compact_case_context_for_narrative(data_dir: Path, case_data: Dict[str, Any], max_chars: int = 4000) -> str:
    """
    Суть кейса для разговорной обратной связи: тема сделки, этапы, фокусы — без полных текстов договора.
    Сначала — выдержки из legend.md / gameData (источник правды для имён и предмета сделки).
    """
    chunks: List[str] = []
    live = _live_case_sources_for_narrative_llm(data_dir, case_data)
    if live.strip():
        chunks.append(
            "Материалы этапов (обязательно опирайся на это для названий сторон, вендора и предмета сделки; "
            "не выдумывай другие компании):"
        )
        chunks.append(live)
    cid = case_data.get("id") or case_data.get("code") or "—"
    chunks.append(f"Идентификатор: {cid}")
    chunks.append(f"Название: {case_data.get('title') or '—'}")
    desc = (case_data.get("description") or "").strip()
    if desc:
        chunks.append(f"Кратко о симуляции: {desc[:600]}")
    contract = case_data.get("contract") or {}
    if isinstance(contract, dict) and contract:
        cd = (contract.get("description") or contract.get("code") or "").strip()
        if cd:
            if live.strip():
                chunks.append(
                    f"Метаописание договора из JSON (справочно; при конфликте с материалами этапов выше — игнорируй): {cd[:500]}"
                )
            else:
                chunks.append(f"Предмет договора в кейсе: {cd[:500]}")
    stages = case_data.get("stages") or []
    for st in stages:
        if not isinstance(st, dict):
            continue
        sid = st.get("id") or ""
        stype = st.get("type") or ""
        title = st.get("title") or sid
        chunks.append(f"\n▸ {title} ({sid}, тип: {stype})")
        intro = (st.get("intro") or "").strip()
        if intro:
            chunks.append(intro[:500])
        if sid == "stage-1":
            for a in (st.get("attributes") or [])[:10]:
                if not isinstance(a, dict):
                    continue
                                                                                                                   
                if str(a.get("type") or "").strip().lower() == "conclusion":
                    continue
                at = a.get("title")
                ad = (a.get("description") or "").strip()[:220]
                if at and str(at).strip().lower() in (
                    "квалификация сделки",
                    "вывод: квалификация сделки",
                ):
                    continue
                if at:
                    chunks.append(f"  • Блок брифа «{at}»: {ad}")
            chunks.append(
                "  • Вывод о правовой природе сделки — отдельный блок брифа (участник заполняет сам); "
                "в обратной связи не подставляй эталон методики и не называй «канонический» тип договора, если участник его явно не сформулировал."
            )
            leg = st.get("legend")
            if isinstance(leg, str) and leg.strip():
                leg_flat = " ".join(leg.split())[:450]
                chunks.append(f"  Логика этапа (фрагмент): {leg_flat}")
        if sid == "stage-2":
            chunks.append("  Фокус: выявление и разметка рисков по пунктам договора, типы и уровни риска.")
        if sid == "stage-3":
            chunks.append("  Фокус: переговоры по спорным пунктам договора с контрагентом.")
        if sid == "stage-4" or str(stype).lower() == "crisis":
            chunks.append("  Фокус: управление кризисной ситуацией после подписания/исполнения.")
    text = "\n".join(chunks)
    if len(text) > max_chars:
        return text[: max_chars - 3] + "..."
    return text


def _build_stage3_report(
    session_id: str,
    data_dir: Path,
    case_id_clean: str,
    *,
    chat_insights_use_ai: bool = True,
) -> Optional[Dict[str, Any]]:
    """Сформировать сводку по этапу 3 (переговоры) из negotiation_session + выжимка по формулировкам в чате (ИИ опционален)."""
    neg_id, history = get_negotiation_session_by_simulex_session(session_id)
    if neg_id is None or not history:
        return None
    clause_status = history.get("clause_status") or {}
                                                                                                                           
    agreed = []                                                        
    not_discussed = []               
    in_progress = []              
    for cid, status in clause_status.items():
        try:
            st = int(status)
        except (TypeError, ValueError):
            st = 0
        name = _CLAUSE_STATUS_NAMES.get(st, "unknown")
        if st in (
            ClauseStatus["ACCEPTED_BOT"],
            ClauseStatus["NO_EDITS"],
            ClauseStatus["CHANGED"],
            ClauseStatus["NOT_AGREED_ESCALATION"],
            ClauseStatus["KEPT_COUNTERPARTY"],
            ClauseStatus["EXCLUDED"],
        ):
            agreed.append({"clause_id": cid, "status": name})
        elif st == ClauseStatus["AVAILABLE"]:
            not_discussed.append({"clause_id": cid, "status": name})
        else:
            in_progress.append({"clause_id": cid, "status": name})
    base = {
        "negotiation_session_id": neg_id,
        "total_points": history.get("total_points", 0),
        "agreed_count": len(agreed),
        "not_discussed_count": len(not_discussed),
        "in_progress_count": len(in_progress),
        "agreed": agreed,
        "not_discussed": not_discussed,
        "in_progress": in_progress,
    }
    if case_id_clean:
        try:
            return _enrich_stage3_with_chat_insights(
                base, int(neg_id), data_dir, case_id_clean, use_ai=chat_insights_use_ai
            )
        except Exception:
            return base
    return base


def _stage4_crisis_brief_from_data(sc: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not sc or not isinstance(sc, dict):
        return None
    cid = str(sc.get("crisis_id") or sc.get("id") or "").strip()
    if not cid:
        return None
    desc = (sc.get("crisis_description") or sc.get("problem_description") or "").strip()
    if len(desc) > 280:
        desc = desc[:277] + "…"
    return {"id": cid, "summary": desc}


def _stage4_second_outcome_hint(stage4_state: Dict[str, Any], crisis: Dict[str, Any]) -> Optional[str]:
    """Краткий итог второго кризиса по выбранной Q3 и immediate_action_outcomes (как в Stage4View)."""
    answers = stage4_state.get("diagnosis_answers_second") or {}
    if not isinstance(answers, dict) or not answers:
        return None
    aid = (
        answers.get("q3-action")
        or answers.get("immediate_action")
        or answers.get("q3")
        or answers.get("action")
    )
    if not aid:
        return "Диагностика второго кризиса зафиксирована; мера в первую очередь в данных отчёта не указана."
    out = (crisis.get("immediate_action_outcomes") or {}).get(str(aid)) or {}
    t = out.get("type")
    if t == "bad":
        return "Итог второго кризиса: выбранная мера в сценарии ведёт к наиболее тяжёлым последствиям для компании."
    if t == "viable":
        return "Итог второго кризиса: мера допустима, но часть правовых или бизнес-рисков сохраняется."
    return "Итог второго кризиса: выбранная мера в целом соответствует ситуации."


def _build_stage4_summary(session: Dict[str, Any], case_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Сформировать краткую сводку по этапу 4 (кризис).
    Возвращает None если этапа 4 нет в кейсе.
    """
    stages = case_data.get("stages") or []
    stage4 = next((s for s in stages if s.get("id") == "stage-4" or s.get("type") == "crisis"), None)

                                                   
    if not stage4:
        return None

    actions_done = session.get("actions_done") or []
    crisis_actions = session.get("crisis_actions") or []
    stage4_action_ids = set()
    for a in get_stage_actions(stage4):
        stage4_action_ids.add(a.get("id"))
    for a in crisis_actions:
        if a.get("id"):
            stage4_action_ids.add(a.get("id"))
    done_stage4 = [aid for aid in actions_done if aid in stage4_action_ids]
    s4s = session.get("stage_4_state") or {}
                                                                                                                 
    stage4_has_narrative = bool(
        s4s.get("selected_crisis_id_first")
        or (isinstance(s4s.get("diagnosis_answers_first"), dict) and s4s["diagnosis_answers_first"])
    )
    out: Dict[str, Any] = {
        "crisis_injected": bool(session.get("crisis_injected")),
        "stage4_has_narrative": stage4_has_narrative,
        "crisis_actions_count": len(crisis_actions),
        "done_actions": done_stage4,
        "done_count": len(done_stage4),
    }
    _cid_raw = (
        session.get("case_id") or session.get("case_code") or case_data.get("id") or ""
    ).strip()
    cid_for_fs = canonical_case_code(_cid_raw) if _cid_raw else ""
    if cid_for_fs and stage4_has_narrative:
        raw_sc = load_crisis_scenarios(DATA_DIR, cid_for_fs) or {}
        slist = raw_sc.get("crisis_scenarios") or []
        by_id = {
            str(s.get("crisis_id") or s.get("id")): s
            for s in slist
            if isinstance(s, dict) and (s.get("crisis_id") or s.get("id"))
        }
        id1 = str(s4s.get("selected_crisis_id_first") or "")
        id2 = str(s4s.get("selected_crisis_id_second") or "")
        if id1:
            b1 = _stage4_crisis_brief_from_data(by_id.get(id1))
            if b1:
                out["first_crisis_brief"] = b1
        if id2:
            c2 = by_id.get(id2)
            b2 = _stage4_crisis_brief_from_data(c2)
            if b2:
                out["second_crisis_brief"] = b2
            hint = _stage4_second_outcome_hint(s4s, c2 or {})
            if hint:
                out["second_crisis_outcome_hint"] = hint
    if cid_for_fs and stage4_has_narrative and s4s:
        _merge_stage4_readable_summary(out, s4s, cid_for_fs)
        try:
            from services.stage4_lexic_service import compute_stage4_lexic

            raw_sc2 = load_crisis_scenarios(DATA_DIR, cid_for_fs) or {}
            sl2 = raw_sc2.get("crisis_scenarios") or []
            by_c2 = {
                str(s.get("crisis_id") or s.get("id")): s
                for s in sl2
                if isinstance(s, dict) and (s.get("crisis_id") or s.get("id"))
            }
            lex4 = compute_stage4_lexic(s4s, by_c2)
            det4 = (lex4 or {}).get("details") or {}
            if det4:
                out["stage4_lexic_model_fit"] = _summarize_stage4_lexic_details(det4, s4s)
        except Exception:
            pass
    return out


def _summarize_stage4_lexic_details(det: Dict[str, Any], s4s: Dict[str, Any]) -> Dict[str, Any]:
    """
    Компактная сводка соответствия решений на этапе 4 учебной модели (без эталонных id и формулировок «правильного» ответа).
    """

    def _q_label(res: Any) -> str:
        r = str(res or "")
        return {
            "correct": "совпало_с_моделью",
            "wrong": "не_совпало_с_моделью",
            "acceptable": "допустимо_не_лучший",
        }.get(r, r or "—")

    out: Dict[str, Any] = {}
    d1: Dict[str, str] = {}
    for key, ru in (
        ("q1_first", "угроза"),
        ("q2_first", "правовое_основание"),
        ("q3_first", "первая_мера"),
    ):
        r = (det.get(key) or {}).get("result")
        if r:
            d1[ru] = _q_label(r)
    if d1:
        out["diagnostics_first"] = d1

    if isinstance(s4s.get("diagnosis_answers_second"), dict) and s4s.get("diagnosis_answers_second"):
        d2: Dict[str, str] = {}
        for key, ru in (
            ("q1_second", "угроза"),
            ("q2_second", "правовое_основание"),
            ("q3_second", "первая_мера"),
        ):
            r = (det.get(key) or {}).get("result")
            if r:
                d2[ru] = _q_label(r)
        if d2:
            out["diagnostics_second"] = d2

    ttc = str(s4s.get("time_travel_choice") or "")
    out["after_first_outcome"] = "вернулся_к_договору" if ttc == "return" else "без_возврата_к_редактированию"

    acc = (det.get("accept") or {}).get("result")
    if acc:
        out["accept_vs_model"] = "ok" if str(acc) == "ok" else "error"

    ce = det.get("clause_edits") or {}
    details = ce.get("clause_details") or []
    counts = {"correct": 0, "acceptable": 0, "wrong": 0, "ignored_risky": 0}
    for it in details:
        if not isinstance(it, dict):
            continue
        rr = str(it.get("result") or "")
        if rr in counts:
            counts[rr] += 1
    if any(counts.values()):
        out["clause_edit_counts"] = counts

    sp = (det.get("speed") or {}).get("result")
    if sp:
        out["contract_edit_speed"] = str(sp)

    return out


def _format_diagnosis_readable_lines(block: Any) -> str:
    if not isinstance(block, dict) or not block:
        return ""
    bits: List[str] = []
    if block.get("threat_choice"):
        bits.append(f"оценка угрозы: {block['threat_choice']}")
    lb = block.get("legal_basis_choices")
    if isinstance(lb, list) and lb:
        bits.append("правовое основание (выбор): " + "; ".join(str(x) for x in lb[:4]))
    if block.get("first_measure_choice"):
        bits.append(f"мера в приоритете: {block['first_measure_choice']}")
    return "; ".join(bits)[:900]


def _build_stage4_narrative_fact_block(s4: Optional[Dict[str, Any]]) -> str:
    """
    Текстовый блок фактов по этапу 4 для ИИ-нарратива: какие кризисы, что выбрано в диагностике, как сошлось с моделью.
    """
    if not isinstance(s4, dict) or not s4.get("stage4_has_narrative"):
        return ""
    lines: List[str] = ["Этап 4 (кризис) — факты для оценки (не пересказывай списком участнику)."]

    b1 = s4.get("first_crisis_brief")
    if isinstance(b1, dict) and (b1.get("id") or b1.get("summary")):
        sid = str(b1.get("id") or "").strip()
        sm = str(b1.get("summary") or "").strip()
        if sm:
            lines.append(f"- Первый сценарий кризиса (id {sid}): {sm[:320]}")
        elif sid:
            lines.append(f"- Первый сценарий кризиса (id {sid}).")

    dch1 = s4.get("first_crisis_diagnosis_choices")
    h1 = _format_diagnosis_readable_lines(dch1)
    if h1:
        lines.append(f"- Выборы в диагностике (первый кризис): {h1}")

    b2 = s4.get("second_crisis_brief")
    if isinstance(b2, dict) and (b2.get("id") or b2.get("summary")):
        sid2 = str(b2.get("id") or "").strip()
        sm2 = str(b2.get("summary") or "").strip()
        if sm2:
            lines.append(f"- Второй сценарий кризиса (id {sid2}): {sm2[:320]}")
        elif sid2:
            lines.append(f"- Второй сценарий кризиса (id {sid2}).")

    dch2 = s4.get("second_crisis_diagnosis_choices")
    h2 = _format_diagnosis_readable_lines(dch2)
    if h2:
        lines.append(f"- Выборы в диагностике (второй кризис): {h2}")

    rows = s4.get("contract_edit_choices_readable")
    if isinstance(rows, list) and rows:
        bits = []
        for row in rows[:10]:
            if not isinstance(row, dict):
                continue
            ct = str(row.get("clause_title") or row.get("clause_id") or "").strip()
            lab = str(row.get("variant_label") or row.get("variant_id") or "").strip()
            if ct or lab:
                bits.append(f"{ct or 'пункт'} → {lab or 'вариант'}")
        if bits:
            lines.append("- Правки договора после возврата (выбор вариантов): " + "; ".join(bits))

    fit = s4.get("stage4_lexic_model_fit")
    if isinstance(fit, dict) and fit:
        if fit.get("after_first_outcome"):
            ao = str(fit["after_first_outcome"])
            lines.append(
                "- Ветка после первого исхода: "
                + (
                    "игрок вернулся к редактированию договора."
                    if ao == "вернулся_к_договору"
                    else "игрок не возвращался к редактированию договора (линия принятия последствий / без правок)."
                )
            )
        def _fit_line(label: str, dfit: Dict[str, Any]) -> str:
            ru = {
                "совпало_с_моделью": "совпадает с моделью кейса",
                "не_совпало_с_моделью": "не совпало с моделью кейса",
                "допустимо_не_лучший": "допустимо по модели, есть предпочтительнее",
            }
            parts = [f"{k}: {ru.get(str(v), str(v))}" for k, v in dfit.items()]
            return f"- {label}: " + "; ".join(parts)

        df = fit.get("diagnostics_first")
        if isinstance(df, dict) and df:
            lines.append(_fit_line("Сверка первой диагностики с моделью кейса", df))
        ds = fit.get("diagnostics_second")
        if isinstance(ds, dict) and ds:
            lines.append(_fit_line("Сверка второй диагностики с моделью кейса", ds))
        av = fit.get("accept_vs_model")
        if av == "ok":
            lines.append("- Сочетание «принять последствия» и оценки угрозы в первой ветке: по модели кейса удачно.")
        elif av == "error":
            lines.append("- Сочетание «принять последствия» и оценки угрозы: по модели кейса менее удачно (см. также зоны внимания).")
        cc = fit.get("clause_edit_counts")
        if isinstance(cc, dict) and any(cc.values()):
            lines.append(
                "- Правки договора по пунктам (модель кейса): "
                f"целевых={cc.get('correct', 0)}, допустимых={cc.get('acceptable', 0)}, "
                f"неудачных={cc.get('wrong', 0)}, пропущено_рискованных={cc.get('ignored_risky', 0)}."
            )
        spd = fit.get("contract_edit_speed")
        if spd:
            lines.append(f"- Скорость внесения правок (модель): {spd}.")

    hint = s4.get("second_crisis_outcome_hint")
    if isinstance(hint, str) and hint.strip():
        lines.append(f"- Итог второго кризиса (по выбранной мере): {hint.strip()[:400]}")

    return "\n".join(lines)[:6000]


def _enrich_stage2_detail_for_report(stage2: Any, session: Dict[str, Any]) -> Any:
    """
    Копия сводки этапа 2 для отчёта: флаг «игрок заполнял типы риска» (чипы под пунктами).
    Не мутирует объект из сессии.
    """
    if not isinstance(stage2, dict):
        return stage2
    out = dict(stage2)
    tags_map = session.get("stage2_clause_tags") or {}
    used = any(isinstance(v, list) and len(v) > 0 for v in tags_map.values())
    out["participant_used_risk_types"] = bool(used)
    return out


def _generate_report_narrative(
    session_id: str,
    report_data: Dict[str, Any],
    timeout: float = 12.0,
) -> Optional[Dict[str, Any]]:
    """
    Письменная обратная связь по результатам, логам и чатам: деловой сдержанный тон, обращение к участнику на «Вы».
    Возвращает overview, strengths, growth_areas, conclusion или None при ошибке.
    """
    try:
        from services.ai_chat_service import call_openai
    except ImportError:
        return None
    summary_text = report_data.get("session_summary_text") or ""
    soft_skills = report_data.get("session_soft_skills") or {}
    lexic_digest = (report_data.get("lexic_digest") or "").strip()
    growth_points_digest = (report_data.get("growth_points_digest") or "").strip()
    recommendations = report_data.get("recommendations") or []
    stage_details = report_data.get("stage_details") or {}
    case_title = report_data.get("case_title") or "Кейс"
    case_context = (report_data.get("case_context") or "").strip()
    total_stages = report_data.get("total_stages", 4)
    completed_stages = report_data.get("completed_stages", 0)
    participant_label = report_data.get("participant_type") or ""
    timeline = report_data.get("timeline") or []
    tone_meta = report_data.get("narrative_tone") or {}
    tier = str(tone_meta.get("tier") or "good")
    _dt = tone_meta.get("display_total")
    _lm = tone_meta.get("lexic_mean")
    _lx = tone_meta.get("lexic_min")
    metrics_tone_line = ""
    if _dt is not None and _lm is not None and _lx is not None:
        try:
            _dtn = int(round(float(_dt)))
        except (TypeError, ValueError):
            _dtn = 0
        _grade = _report_summary_grade_label(_dtn)
        metrics_tone_line = (
            f"Итог для тона: уровень «{_grade}» (внутренняя витрина ~{_dtn}); "
            f"по осям LEXIC среднее ~{_lm}, минимум ~{_lx}.\n"
        )
    tone_summary_tier = tier

    tutor_part = _tutor_dialog_excerpt(session_id) if session_id else ""
    neg_part = _negotiation_chat_excerpt(session_id) if session_id else ""
    timeline_part = _timeline_text(
        timeline if isinstance(timeline, list) else [],
        max_lines=120,
        max_chars=10000,
    )
    s1_titles = report_data.get("stage1_attribute_titles")
    if not isinstance(s1_titles, dict):
        s1_titles = {}
    stages_compact = _compact_stage_details_for_llm(stage_details, s1_titles)
    stages_info = report_data.get("stages_info") or []
    stages_actions_text = _format_stages_info_for_narrative(stages_info)
    stage_behavior_digest = _stage_details_behavior_digest(stage_details, s1_titles)
    stage2_types_hint = _stage2_risk_types_narrative_hint(stage_details)
    rec_digest = _recommendations_digest(recommendations if isinstance(recommendations, list) else [])
    skills_digest = _soft_skills_digest(soft_skills if isinstance(soft_skills, dict) else {})

    gap_notes = report_data.get("reference_gap_notes") or []
    if isinstance(gap_notes, list):
        gap_lines = [str(x).strip() for x in gap_notes if isinstance(x, str) and str(x).strip()]
    else:
        gap_lines = []

    narrative_payload: Dict[str, Any] = {
        "kind": "session_report_narrative",
        "output_format": {
            "type": "json",
            "fields": [
                "overview",
                "strengths",
                "growth_areas",
                "conclusion",
                "recommendation_bullets",
            ],
        },
        "case_title": case_title,
        "case_context": case_context or None,
        "progress": {
            "completed_stages": completed_stages,
            "total_stages": total_stages,
            "participant_label": participant_label or None,
        },
        "reference_gap_notes": gap_lines[:28],
        "stage_actions_text": stages_actions_text,
        "stage_behavior_digest": stage_behavior_digest,
        "lexic_digest": lexic_digest or None,
        "growth_points_digest": growth_points_digest or None,
        "stages_compact": stages_compact,
        "stage2_types_hint": stage2_types_hint,
        "session_summary_excerpt": summary_text[:2500] if summary_text else None,
        "skills_digest": skills_digest,
        "recommendations_digest": rec_digest,
        "tutor_dialog_excerpt": tutor_part or None,
        "negotiation_excerpt": neg_part or None,
        "timeline_excerpt": timeline_part or None,
        "tone": {
            "metrics_line": metrics_tone_line or None,
            "summary_tier": tone_summary_tier,
        },
    }
    user_content = compact_user_payload(narrative_payload)

    system_prompt = MINIMAL_SYSTEM_MESSAGE

    model = get_model_for_consumer("report")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.28,
        "max_tokens": 4800,
    }
    try:
        raw = call_openai(payload)
        if not raw or len(raw) < 10:
            return None
        json_start = raw.find("{")
        json_end = raw.rfind("}") + 1
        if json_start < 0 or json_end <= json_start:
            return None
        parsed = json.loads(raw[json_start:json_end])
        bullets_raw = parsed.get("recommendation_bullets")
        bullets: List[str] = []
        if isinstance(bullets_raw, list):
            for x in bullets_raw:
                s = str(x).strip()
                if s:
                    bullets.append(s)
        elif isinstance(bullets_raw, str) and bullets_raw.strip():
            bullets = [ln.strip() for ln in bullets_raw.split("\n") if ln.strip()]
        bullets = bullets[:12]
        return {
            "overview": str(parsed.get("overview") or "").strip(),
            "strengths": str(parsed.get("strengths") or "").strip(),
            "growth_areas": str(parsed.get("growth_areas") or "").strip(),
            "conclusion": str(parsed.get("conclusion") or "").strip(),
            "recommendation_bullets": bullets,
        }
    except Exception as e:
        print(f"⚠️ report_service: _generate_report_narrative: {e}")
        return None


def _generate_recommendation_bullets_only(
    report_data: Dict[str, Any],
    timeout: float = 10.0,
) -> List[str]:
    """
    Короткий вызов LLM только для списка recommendation_bullets, если основной нарратив дал мало пунктов.
    """
    try:
        from services.ai_chat_service import call_openai
    except ImportError:
        return []
    case_title = report_data.get("case_title") or "Кейс"
    case_context = (report_data.get("case_context") or "").strip()
    lexic_digest = (report_data.get("lexic_digest") or "").strip()
    growth_digest = (report_data.get("growth_points_digest") or "").strip()
    stage_details = report_data.get("stage_details") or {}
    s1_titles = report_data.get("stage1_attribute_titles")
    if not isinstance(s1_titles, dict):
        s1_titles = {}
    stages_compact = _compact_stage_details_for_llm(stage_details, s1_titles)
    stage2_types_hint = _stage2_risk_types_narrative_hint(stage_details)
    rec_digest = _recommendations_digest(report_data.get("recommendations") or [])
    skills_digest = _soft_skills_digest(report_data.get("session_soft_skills") or {})
    gap_notes = report_data.get("reference_gap_notes") or []
    if isinstance(gap_notes, list):
        gap_lines = [str(x).strip() for x in gap_notes if isinstance(x, str) and str(x).strip()]
    else:
        gap_lines = []
    bullets_payload: Dict[str, Any] = {
        "kind": "session_report_recommendation_bullets",
        "output_format": {"type": "json", "fields": ["recommendation_bullets"]},
        "case_title": case_title,
        "case_context_excerpt": case_context[:3800] if case_context else case_title,
        "lexic_digest": lexic_digest or None,
        "growth_digest": growth_digest or None,
        "stages_compact": stages_compact,
        "reference_gap_notes": gap_lines[:28],
        "stage2_types_hint": stage2_types_hint,
        "recommendations_digest": rec_digest,
        "skills_digest": skills_digest,
    }
    user_content = compact_user_payload(bullets_payload)
    system_prompt = MINIMAL_SYSTEM_MESSAGE

    model = get_model_for_consumer("report")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.22,
        "max_tokens": 1400,
    }
    try:
        raw = call_openai(payload, timeout=int(timeout))
        if not raw or len(raw) < 10:
            return []
        json_start = raw.find("{")
        json_end = raw.rfind("}") + 1
        if json_start < 0 or json_end <= json_start:
            return []
        parsed = json.loads(raw[json_start:json_end])
        bullets_raw = parsed.get("recommendation_bullets")
        out: List[str] = []
        if isinstance(bullets_raw, list):
            for x in bullets_raw:
                s = str(x).strip()
                if s:
                    out.append(s)
        elif isinstance(bullets_raw, str) and bullets_raw.strip():
            out = [ln.strip() for ln in bullets_raw.split("\n") if ln.strip()]
        return out[:12]
    except Exception:
        return []


def _ensure_narrative_recommendation_bullets(
    narrative: Optional[Dict[str, Any]],
    report_data: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    if not narrative or not isinstance(narrative, dict):
        return narrative
    bullets_raw = narrative.get("recommendation_bullets")
    clean: List[str] = []
    if isinstance(bullets_raw, list):
        clean = [str(x).strip() for x in bullets_raw if str(x).strip()]
    elif isinstance(bullets_raw, str) and bullets_raw.strip():
        clean = [ln.strip() for ln in bullets_raw.split("\n") if ln.strip()]
    if len(clean) >= 4:
        out = dict(narrative)
        out["recommendation_bullets"] = clean[:12]
        return out
    extra = _generate_recommendation_bullets_only(report_data)
    merged: List[str] = []
    seen = set()
    for b in clean + extra:
        key = b.lower()[:100]
        if key in seen:
            continue
        seen.add(key)
        merged.append(b)
        if len(merged) >= 10:
            break
    out = dict(narrative)
    out["recommendation_bullets"] = merged[:12]
    return out


def _extend_recommendations(lexic: Dict[str, int], session_soft_skills: Optional[Dict] = None, stage2_report: Optional[Dict] = None) -> List[str]:
    """Рекомендации по LEXIC + опционально по soft-skills и этапу 2."""
    recs = list(generate_recommendations(lexic))
    if session_soft_skills:
        if (session_soft_skills.get("self_reflection") or 0) < 0.4:
            recs.append("Рефлексия: рекомендуется чаще фиксировать итог решений и диалога с тьютором.")
        if (session_soft_skills.get("argumentation_level") or 0) < 0.4:
            recs.append("Аргументация: усильте обоснование позиций в переговорах и при классификации рисков.")
    if stage2_report:
        summary = stage2_report.get("summary") or {}
        missed = summary.get("missed_risks", 0)
        false_pos = summary.get("false_positives", 0)
        if missed > 0:
            recs.append(
                f"Риски (этап 2): пропущено отметок — {missed}. Имеет смысл дополнительно пройти матрицу рисков."
            )
        if false_pos > 0:
            recs.append(
                f"Этап 2: зафиксированы ложные срабатывания — {false_pos}. Стоит уточнить критерии оценки рисков."
            )
    return recs


def _fetch_lexic_group_peer_max(
    session_external_id: Optional[str],
    case_code: str,
) -> Optional[Dict[str, int]]:
    """
    По каждой оси LEXIC — максимум нормализованного значения среди других сессий
    того же кейса и той же группы пользователя (для ориентира на радаре отчёта).
    """
    if not session_external_id or not str(case_code).strip():
        return None
    cc = str(case_code).strip()
    ex = str(session_external_id).strip()
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT u.group_id
                    FROM game_session gs
                    JOIN "user" u ON u.id = gs.user_id
                    WHERE gs.external_id = %s
                    """,
                    (ex,),
                )
                row = cur.fetchone()
        if not row or row[0] is None:
            return None
        group_id = int(row[0])
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                      MAX(gs.lexic_l_normalized),
                      MAX(gs.lexic_e_normalized),
                      MAX(gs.lexic_x_normalized),
                      MAX(gs.lexic_i_normalized),
                      MAX(gs.lexic_c_normalized)
                    FROM game_session gs
                    JOIN "user" u ON u.id = gs.user_id
                    WHERE gs.case_code = %s
                      AND u.group_id = %s
                      AND gs.external_id <> %s
                      AND gs.lexic_l_normalized IS NOT NULL
                      AND gs.lexic_e_normalized IS NOT NULL
                      AND gs.lexic_x_normalized IS NOT NULL
                      AND gs.lexic_i_normalized IS NOT NULL
                      AND gs.lexic_c_normalized IS NOT NULL
                    """,
                    (cc, group_id, ex),
                )
                agg = cur.fetchone()
    except Exception as _e:
        print(f"⚠️ report_service: lexic_group_peer_max: {_e}")
        return None
    if not agg or agg[0] is None:
        return None
    lv, ev, xv, iv, cv = agg
    return {
        "L": int(round(float(lv))),
        "E": int(round(float(ev))),
        "X": int(round(float(xv))),
        "I": int(round(float(iv))),
        "C": int(round(float(cv))),
    }


def generate_report(
    data_dir: Path,
    session: Dict[str, Any],
    *,
    case_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Собрать отчёт (метрики, этапы, рекомендации из правил). LLM по нарративу — если нет актуального report_snapshot v=2; при открытии с актуальным снимком — нарратив и stage3_detail из снимка, без повторного ИИ по этапу 3."""
    case_id = _resolve_case_id_for_get_case(session)
    print(
        f"📊 Генерация отчета для case_id: '{session.get('case_id') or session.get('case_code')}' -> '{case_id}'"
    )
    if case_data is not None:
        case_data = copy.deepcopy(case_data)
    else:
        case_data = get_case(data_dir, case_id)
    case_id_clean = case_suffix(str(case_data.get("id") or "case-001"))
    print(f"📊 Загружен кейс: '{case_data.get('id')}', этапов: {len(case_data.get('stages', []))}")
    coherent_lexic = apply_lexic_interest_legitimacy_coherence(session.get("lexic"))
    _mean_lex, _min_lex = _lexic_coherent_mean_min(coherent_lexic)
    total_score = _display_total_score_from_lexic(coherent_lexic)
    score_tier = _report_score_tier(total_score, _min_lex)
    rating_label = _report_summary_grade_label(total_score)
    if not case_data.get("stages") or not isinstance(case_data["stages"], list) or len(case_data["stages"]) == 0:
        raise ValueError("Кейс не содержит этапов")
    total_stages = len(case_data["stages"])
    stages_info = []
    for index, stage in enumerate(case_data["stages"]):
        all_actions = get_stage_actions(stage)
        done_actions = [a for a in all_actions if a.get("id") in session.get("actions_done", [])]
        missed_actions = [a for a in all_actions if a.get("id") not in session.get("actions_done", []) and not a.get("is_required")]
        missed_required = [a for a in all_actions if a.get("id") not in session.get("actions_done", []) and a.get("is_required")]
        stages_info.append({
            "stage_id": stage.get("id"),
            "stage_order": stage.get("order") or stage.get("order_index") or (index + 1),
            "stage_title": stage.get("title"),
            "stage_type": stage.get("type"),
            "total_actions": len(all_actions),
            "done_actions": [{"id": a.get("id"), "title": a.get("title"), "type": a.get("type")} for a in done_actions],
            "missed_actions": [{"id": a.get("id"), "title": a.get("title"), "type": a.get("type"), "reason": "Не выполнено"} for a in missed_actions],
            "missed_required": [{"id": a.get("id"), "title": a.get("title"), "type": a.get("type"), "reason": "Обязательное действие не выполнено"} for a in missed_required],
            "is_completed": index < session.get("current_stage", 1) - 1,
        })

    session_external_id = _resolve_session_external_id(session)
    snap = session.get("report_snapshot") or {}
    has_frozen_llm = _report_snapshot_is_current(snap)
    completed_case = is_session_case_completed(session, case_data)
                                                                                                                 
    run_llm_interpretation = completed_case and not has_frozen_llm

    if session_external_id and run_llm_interpretation:
        try:
            update_session_summary_and_profile(
                str(session_external_id),
                case_code=session.get("case_id") or session.get("case_code"),
                max_actions=80,
                max_messages=60,
            )
        except Exception as _su:
            print(f"⚠️ report_service: update_session_summary_and_profile: {_su}")
    session_summary_text, session_soft_skills = (
        get_session_summary_and_profile(session_external_id) if session_external_id else (None, None)
    )
    timeline = _get_timeline(session_external_id) if session_external_id else []

                             
                                                                                
    stage1_raw = session.get("stage1_result")
    if stage1_raw and isinstance(stage1_raw, dict):
        stage1_data = dict(stage1_raw)
                                                                              
        if session.get("stage1_legitimacy"):
            stage1_data["stage1_legitimacy"] = session["stage1_legitimacy"]
        if session.get("stage1_expertise"):
            stage1_data["stage1_expertise"] = session["stage1_expertise"]
        if session.get("stage1_lexic_breakdown"):
            stage1_data["lexic_breakdown"] = session["stage1_lexic_breakdown"]
    else:
        stage1_data = stage1_raw

                                                                
    stage4_summary = _build_stage4_summary(session, case_data)
    if stage4_summary and session.get("stage_4_state"):
        stage4_summary["stage_4_state"] = session["stage_4_state"]

                                                                                                                   
    if (
        has_frozen_llm
        and isinstance(snap.get("stage3_detail"), dict)
        and snap["stage3_detail"]
    ):
        s3_from_db = copy.deepcopy(snap["stage3_detail"])
    elif session_external_id:
        s3_from_db = _build_stage3_report(
            str(session_external_id),
            data_dir,
            case_id_clean,
            chat_insights_use_ai=not has_frozen_llm,
        )
    else:
        s3_from_db = None
    stage_details = {
        "stage-1": stage1_data,
        "stage-2": session.get("stage2_report"),
        "stage-3": s3_from_db,
        "stage-4": stage4_summary,
    }

    s2_detail = stage_details.get("stage-2")
    if s2_detail is not None:
        stage_details["stage-2"] = _enrich_stage2_detail_for_report(s2_detail, session)

    reference_gap_notes: List[str] = list(build_reference_gap_notes(session, case_data, data_dir))
    reference_gap_notes.extend(_reference_gap_notes_for_stage3(stage_details.get("stage-3")))
    reference_gap_notes.extend(_reference_gap_notes_from_stage3_chat(stage_details.get("stage-3")))

    completed_stages = min(session.get("current_stage", 1) - 1, total_stages)
    recommendations = _extend_recommendations(
        {p: int(round(coherent_lexic[p])) for p in LEXIC_PARAMS},
        session_soft_skills=session_soft_skills,
        stage2_report=session.get("stage2_report"),
    )

                                                                                                                                                  
    pre_ln = session.get("lexic_normalized")
    can_reuse_norm = (
        isinstance(pre_ln, dict)
        and pre_ln
        and (
            (isinstance(pre_ln.get("final"), dict) and pre_ln["final"])
            or (isinstance(pre_ln.get("stages"), list) and len(pre_ln["stages"]) > 0)
        )
    )
    lexic_normalized: dict = {}
    if can_reuse_norm:
        lexic_normalized = dict(pre_ln)
    elif session_external_id:
        try:
            lexic_normalized = compute_full_normalized_profile(
                session_external_id,
                raw_lexic=session.get("lexic"),
            ) or {}
        except Exception as _e:
            print(f"⚠️ report_service: ошибка нормализации: {_e}")
            lexic_normalized = dict(pre_ln) if isinstance(pre_ln, dict) else {}
    if not lexic_normalized and isinstance(pre_ln, dict):
        lexic_normalized = dict(pre_ln)

                                                                          
    final_norm = lexic_normalized.get("final", {})
    if final_norm and any(v != 50.0 for v in final_norm.values()):
        total_score_normalized = lexic_normalized.get("total_score", total_score)
    else:
        total_score_normalized = total_score

                                                                                                              
    raw_lexic_vals = {p: coherent_lexic[p] for p in LEXIC_PARAMS}
    lexic_levels = {
        p: {
            "level": get_lexic_level(raw_lexic_vals[p]),
            "label": LEXIC_LEVEL_LABELS.get(get_lexic_level(raw_lexic_vals[p]), ""),
            "color": LEXIC_LEVEL_COLORS.get(get_lexic_level(raw_lexic_vals[p]), "#6b7280"),
        }
        for p in LEXIC_PARAMS
    }

                                                    
    stage_snapshots = lexic_normalized.get("stages", [])
    growth_points = get_growth_points(stage_snapshots) if stage_snapshots else []

    participant_type = classify_participant(raw_lexic_vals)

    _cc_raw = str(
        session.get("case_id") or session.get("case_code") or case_data.get("id") or ""
    ).strip()
    case_code_row = canonical_case_code(_cc_raw) if _cc_raw else ""
    lexic_group_peer_max = _fetch_lexic_group_peer_max(session_external_id, case_code_row)

    timing_data = _compute_timing_data(session, timeline, case_data, session_external_id)
    ranking_data = _compute_ranking_data(session_external_id, case_code_row, total_score)

    report = {
        "title": "📊 Отчет о прохождении",
        "case_id": case_data.get("id"),
        "case_version": case_data.get("version", session.get("case_version")),
        "completed_stages": completed_stages,
        "total_stages": total_stages,
        "actions_count": len(session.get("actions_done", [])),
        "final_lexic": {p: int(round(coherent_lexic[p])) for p in LEXIC_PARAMS},
        "total_score": total_score,
        "total_score_normalized": total_score_normalized,
        "rating": rating_label,
        "score_tier": score_tier,
        "recommendations": recommendations,
        "stages_info": stages_info,
        "simulex_session_id": session_external_id,
        "case_title": case_data.get("title", "Кейс"),
        "session_summary_text": session_summary_text,
        "session_soft_skills": session_soft_skills,
        "timeline": timeline if timeline else None,
        "stage_details": stage_details,
                                 
        "lexic_normalized": lexic_normalized,
        "lexic_levels": lexic_levels,
        "stage_snapshots": stage_snapshots,
        "growth_points": growth_points,
        "participant_type": participant_type,
        "reference_gap_notes": reference_gap_notes,
        "lexic_group_peer_max": lexic_group_peer_max,
        "timing": timing_data,
        "ranking": ranking_data,
    }

    try:
        report["lexic_lab_ledger"] = build_lexic_lab_ledger(
            session,
            case_data,
            lexic_normalized=lexic_normalized if isinstance(lexic_normalized, dict) else {},
            coherent_lexic=coherent_lexic,
            total_score_normalized=float(total_score_normalized),
            data_dir=data_dir,
        )
    except Exception as _ll:
        print(f"⚠️ report_service: lexic_lab_ledger: {_ll}")
        report["lexic_lab_ledger"] = None

                                         
    _raw_lexic_int = {p: int(round(coherent_lexic[p])) for p in LEXIC_PARAMS}
    _growth_digest = _growth_points_digest_for_narrative(growth_points)
    report_for_narrative = {
        "session_summary_text": session_summary_text,
        "session_soft_skills": session_soft_skills,
        "final_lexic": _raw_lexic_int,
        "final_lexic_normalized": final_norm,
        "lexic_digest": _full_lexic_digest_for_narrative(_raw_lexic_int, final_norm if isinstance(final_norm, dict) else None),
        "growth_points_digest": _growth_digest,
        "case_context": _compact_case_context_for_narrative(data_dir, case_data),
        "recommendations": recommendations,
        "stage_details": stage_details,
        "case_title": report["case_title"],
        "total_stages": total_stages,
        "completed_stages": completed_stages,
        "participant_type": participant_type.get("label", ""),
        "timeline": timeline,
        "stages_info": stages_info,
        "reference_gap_notes": reference_gap_notes,
        "narrative_tone": {
            "tier": score_tier,
            "display_total": total_score,
            "lexic_mean": round(_mean_lex, 1),
            "lexic_min": round(_min_lex, 1),
        },
        "stage1_attribute_titles": _stage1_attribute_titles(case_data),
    }
    if completed_case and has_frozen_llm:
        frozen_n = snap.get("narrative")
        report["narrative"] = frozen_n if isinstance(frozen_n, dict) else None
    elif run_llm_interpretation:
        narrative = _generate_report_narrative(session_external_id or "", report_for_narrative)
        narrative = _ensure_narrative_recommendation_bullets(
            narrative if narrative else None,
            report_for_narrative,
        )
        report["narrative"] = narrative if narrative else None
    else:
        report["narrative"] = None

    print(
        f"📊 Отчет создан: {report['rating']} (витрина: {total_score}, LEX ср./мин: "
        f"{round(_mean_lex, 1)}/{round(_min_lex, 1)}, норм.: {total_score_normalized})"
    )
    return report
