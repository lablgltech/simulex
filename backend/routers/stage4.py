"""API этапа 4: кризис — контент из case-stage-4 (кризисы, письмо Дока, договор), выбор кризиса по LEXIC, генерация таймлайна."""
import json
import random
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api_errors import client_500_detail_from_exception
from config import DATA_DIR
from routers.auth import get_current_user
from services.stage4_bridge_service import load_contract_and_bridge_for_stage4
from utils.file_loader import (
    load_contract_clauses,
    load_crisis_scenarios,
    load_doc_letter_text,
    load_stage4_full_contract_markdown,
    load_timeline_events_pool,
    resolve_timeline_events_json_path,
)

router = APIRouter(prefix="/api", tags=["stage4"])

LEXIC_PRIORITY = ["L", "E", "X", "I", "C"]

DEFAULT_DIAGNOSTIC_OPTIONS = {
    "risk_assessment": [
        {"id": "non_critical", "text": "Некритичная"},
        {"id": "significant", "text": "Значимая"},
        {"id": "critical", "text": "Критичная"},
    ],
    "legal_basis": [
        {"id": "rights", "text": "Недостаточно чёткое регулирование прав на доработки"},
        {"id": "vague", "text": "Размытые обязательства по результату доработок"},
        {"id": "vendor", "text": "Недобросовестность вендора"},
        {"id": "market", "text": "Общая ситуация на рынке"},
    ],
    "immediate_action": [
        {"id": "harsh", "text": "Срочно принимать жёсткие меры (претензии, суд)"},
        {"id": "wait", "text": "Ничего не делать, ждать"},
        {"id": "assess", "text": "Оценить возможность изменения условий до подписания"},
    ],
}


PLAYER_ERROR_CRISIS_TYPES = {"territory", "term", "acts", "liability", "documents"}


def _select_crisis_by_contract_selections(
    scenarios: List[Dict],
    contract_clauses: List[Dict],
    contract_selections: Dict[str, str],
) -> Optional[Dict]:
    """
    Триггер внутри этапа 4: выбор кризиса по выборам по договору (A/B/C).
    - Все пункты-ловушки исправлены (везде C) → внешний кризис.
    - Иначе → случайный среди кризисов по ошибкам (territory, term, acts, liability, documents).
    """
    if not scenarios:
        return None
    external = [s for s in scenarios if s.get("crisis_type") == "external"]
    player_error = [s for s in scenarios if s.get("crisis_type") in PLAYER_ERROR_CRISIS_TYPES]
    if not player_error:
        player_error = [s for s in scenarios if s not in external]

    if _all_traps_fixed(contract_clauses, contract_selections) and external:
        return random.choice(external)
    if player_error:
        return random.choice(player_error)
    return random.choice(scenarios)


def _select_crisis_by_lexic(scenarios: List[Dict], lexic: Dict[str, int]) -> Optional[Dict]:
    """Выбор кризиса по минимальному LEXIC-параметру (приоритет L > E > X > I > C). Резерв, если нет stage3_correct."""
    if not scenarios:
        return None
    lexic = lexic or {}
    min_param = None
    min_val = None
    for p in LEXIC_PRIORITY:
        v = lexic.get(p, 50)
        if min_val is None or v < min_val:
            min_val = v
            min_param = p
    if min_param is None:
        min_param = "L"
    candidates = [s for s in scenarios if s.get("trigger_lexic_param") == min_param]
    if not candidates:
        candidates = [s for s in scenarios if s.get("trigger_lexic_param") is None]
    if not candidates:
        candidates = scenarios
    return random.choice(candidates)


def _enrich_diagnostic_questions(crisis: Dict) -> List[Dict]:
    """Добавить варианты ответов к вопросам диагностики из сценария или дефолтные."""
    questions = list(crisis.get("diagnostic_questions") or [])
    result = []
    for q in questions:
        q = dict(q)
        q_type = q.get("type") or "risk_assessment"
        options = q.get("options")
        if not options:
            if q_type == "legal_basis" and crisis.get("legal_basis_options"):
                q["options"] = crisis["legal_basis_options"]
            elif q_type == "immediate_action" and crisis.get("immediate_action_options"):
                q["options"] = crisis["immediate_action_options"]
            elif q_type in DEFAULT_DIAGNOSTIC_OPTIONS:
                q["options"] = DEFAULT_DIAGNOSTIC_OPTIONS[q_type]
        result.append(q)
    return result


def _month_order(month_str: str) -> int:
    """Извлечь порядковый номер месяца из строки «Через N месяц(ев/а)» для сортировки."""
    if not month_str:
        return 0
    m = re.search(r"(\d+)", str(month_str))
    return int(m.group(1)) if m else 0


def _month_label(n: int) -> str:
    """Склонение: 1 месяц, 2 месяца, 5 месяцев."""
    if n % 10 == 1 and n % 100 != 11:
        return "месяц"
    if n % 10 in (2, 3, 4) and (n % 100 < 10 or n % 100 >= 20):
        return "месяца"
    return "месяцев"


def _generate_timeline(
    pool: List[Dict], case_id: str = "case-stage-4", selected_crisis: Optional[Dict] = None
) -> List[Dict]:
    """Генерировать таймлайн: по одному событию на каждый месяц (без дублей) + кризис в конце.
    Если у выбранного кризиса есть timeline_events — используем их, иначе — пул событий."""
    crisis_events = (selected_crisis or {}).get("timeline_events")
    if crisis_events and isinstance(crisis_events, list):
        last_month = 0
        for e in crisis_events:
            m = _month_order(e.get("month") or "")
            if m > last_month:
                last_month = m
        # Кризис в тот же месяц, что и последнее событие сценария (соответствие тексту: «Прошло 22 месяца», «Через 10 месяцев» и т.д.)
        crisis_month = f"Через {last_month} {_month_label(last_month)}"
        return [
            *[dict(e) for e in crisis_events],
            {"month": crisis_month, "label": "Кризис", "status": "fail", "crisis": True},
        ]
    config_path = resolve_timeline_events_json_path(DATA_DIR, case_id)
    min_before = 4
    max_before = 6
    if config_path is not None:
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                min_before = cfg.get("min_events_before_crisis", min_before)
                max_before = cfg.get("max_events_before_crisis", max_before)
        except Exception:
            pass
    pool_no_crisis = [e for e in pool if not e.get("crisis")]
    if not pool_no_crisis:
        pool_no_crisis = pool
    by_month: Dict[int, List[Dict]] = {}
    for e in pool_no_crisis:
        order = _month_order(e.get("month") or "")
        by_month.setdefault(order, []).append(e)
    available_months = sorted(k for k in by_month.keys() if k > 0)
    if not available_months:
        n = random.randint(min_before, min(max_before, len(pool_no_crisis)))
        n = max(1, min(n, len(pool_no_crisis)))
        chosen = random.sample(pool_no_crisis, n)
        chosen = sorted(chosen, key=lambda e: (_month_order(e.get("month") or ""), e.get("label") or ""))
        last_month = max(_month_order(e.get("month") or "") for e in chosen) if chosen else 6
    else:
        n = random.randint(min_before, min(max_before, len(available_months)))
        n = max(1, min(n, len(available_months)))
        picked_months = random.sample(available_months, n)
        picked_months.sort()
        chosen = []
        for i, month_num in enumerate(picked_months):
            events = by_month[month_num]
            # После проблемного события (warn) следующее должно быть разрешением (done); перед кризисом — по возможности done
            need_done = (
                (i > 0 and chosen[-1].get("status") == "warn")
                or (i == len(picked_months) - 1)  # последнее перед кризисом
            )
            done_events = [e for e in events if e.get("status") == "done"]
            if need_done and done_events:
                chosen.append(random.choice(done_events))
            else:
                chosen.append(random.choice(events))
        last_month = max(picked_months)
    # Кризис — случайно через 1–3 месяца после последнего события
    crisis_month_num = last_month + random.randint(1, 3)
    crisis_month = f"Через {crisis_month_num} {_month_label(crisis_month_num)}"
    chosen.append({
        "month": crisis_month,
        "label": "Кризис",
        "status": "fail",
        "crisis": True,
    })
    return chosen


def _get_trap_crisis_types(contract_clauses: List[Dict]) -> List[str]:
    """Пункты-ловушки: у которых есть risk_profile.related_crisis_type (привязанный тип кризиса)."""
    types_ = []
    for c in contract_clauses or []:
        if not c.get("clause_id"):
            continue
        rp = c.get("risk_profile")
        if isinstance(rp, dict) and rp.get("related_crisis_type"):
            types_.append(rp["related_crisis_type"])
    return types_


def _all_traps_fixed(contract_clauses: List[Dict], contract_selections: Dict[str, str]) -> bool:
    """Игрок внёс правки во все ловушки (для каждого пункта выбран правильный вариант, см. correct_variant_id)."""
    trap_types = _get_trap_crisis_types(contract_clauses)
    if not trap_types:
        return True
    for c in contract_clauses or []:
        cid = c.get("clause_id")
        if not cid or not isinstance(c.get("risk_profile"), dict) or not c["risk_profile"].get("related_crisis_type"):
            continue
        correct_id = c.get("correct_variant_id", "C")
        if (contract_selections or {}).get(cid) != correct_id:
            return False
    return True


def _select_second_crisis(
    first_crisis_id: str,
    first_outcome: str,
    contract_clauses: List[Dict],
    contract_selections: Dict[str, str],
    scenarios: List[Dict],
) -> Optional[Dict]:
    """
    Выбор второго кризиса:
    - Внешний кризис только когда игрок всё сделал корректно при исправлении договора (fixed и все ловушки в C).
    - noChange (не вносил правок) -> кризис, привязанный к пункту-ловушке (не внешний).
    - repeat (вносил, но не все ловушки) -> кризис по неисправленным пунктам.
    - accept (принял последствия) -> любой другой, не внешний.
    """
    if not scenarios:
        return None
    external = [s for s in scenarios if s.get("crisis_type") == "external"]
    if not external:
        external = [s for s in scenarios if s.get("crisis_id", "").startswith("crisis-external")]

    clauses_by_id = {c.get("clause_id"): c for c in (contract_clauses or []) if c.get("clause_id")}
    trap_types = _get_trap_crisis_types(contract_clauses)

    # Внешний только при fixed и все ловушки исправлены (везде C)
    if first_outcome == "fixed" and _all_traps_fixed(contract_clauses, contract_selections) and external:
        return random.choice(external)

    # noChange: не вносил правок — кризис, привязанный к пункту (ловушки остались A)
    if first_outcome == "noChange" and trap_types:
        corresponding = [
            s for s in scenarios
            if s.get("crisis_type") in trap_types and s.get("crisis_id") != first_crisis_id
        ]
        if corresponding:
            return random.choice(corresponding)

    # repeat: соответствующий — по пунктам, которые не исправил (выбран не правильный вариант)
    if first_outcome == "repeat":
        unfixed_types = set()
        for clause_id, choice in (contract_selections or {}).items():
            cl = clauses_by_id.get(clause_id)
            if not cl or not isinstance(cl.get("risk_profile"), dict):
                continue
            correct_id = cl.get("correct_variant_id", "C")
            if choice and choice != correct_id:
                t = cl["risk_profile"].get("related_crisis_type")
                if t:
                    unfixed_types.add(t)
        if unfixed_types:
            corresponding = [
                s for s in scenarios
                if s.get("crisis_type") in unfixed_types and s.get("crisis_id") != first_crisis_id
            ]
            if corresponding:
                return random.choice(corresponding)

    # accept / failed / иначе: любой новый (не первый), не внешний
    others = [s for s in scenarios if s.get("crisis_id") != first_crisis_id and s not in external]
    if not others:
        others = [s for s in scenarios if s.get("crisis_id") != first_crisis_id]
    return random.choice(others) if others else random.choice(scenarios)


def _generate_second_timeline(
    pool: List[Dict],
    crisis_month: str,
    selected_crisis: Optional[Dict] = None,
    case_id: str = "case-stage-4",
) -> List[Dict]:
    """Таймлайн «продолжение исполнения договора» до второго кризиса. Если у выбранного кризиса есть timeline_events — используем их, иначе 2–3 события из пула + кризис."""
    crisis_events = (selected_crisis or {}).get("timeline_events")
    if crisis_events and isinstance(crisis_events, list):
        last_month = 0
        for e in crisis_events:
            m = _month_order(e.get("month") or "")
            if m > last_month:
                last_month = m
        crisis_month_str = f"Через {last_month} {_month_label(last_month)}"
        return [
            *[dict(e) for e in crisis_events],
            {"month": crisis_month_str, "label": "Кризис", "status": "fail", "crisis": True},
        ]
    pool_no_crisis = [e for e in pool if not e.get("crisis")]
    if not pool_no_crisis:
        pool_no_crisis = pool
    by_month: Dict[int, List[Dict]] = {}
    for e in pool_no_crisis:
        order = _month_order(e.get("month") or "")
        by_month.setdefault(order, []).append(e)
    available = sorted(k for k in by_month.keys() if k > 0)
    n = min(2, len(available)) if available else min(2, len(pool_no_crisis))
    if available:
        picked = random.sample(available, n)
        picked.sort()
        chosen = [random.choice(by_month[m]) for m in picked]
    else:
        chosen = random.sample(pool_no_crisis, n)
        chosen.sort(key=lambda e: (_month_order(e.get("month") or ""), e.get("label") or ""))
    chosen.append({
        "month": crisis_month or "Через 6 месяцев",
        "label": "Кризис",
        "status": "fail",
        "crisis": True,
    })
    return chosen


@router.get("/stage4/content")
async def get_stage4_content(case_id: str = "case-stage-4"):
    """Получить контент этапа 4: сценарии кризисов, текст письма Дока, пункты договора."""
    try:
        scenarios_data = load_crisis_scenarios(DATA_DIR, case_id)
        doc_letter = load_doc_letter_text(DATA_DIR, case_id)
        contract = load_contract_clauses(DATA_DIR, case_id)
        scenarios = (scenarios_data or {}).get("crisis_scenarios") or []
        clauses = (contract or {}).get("clauses") or []
        first_letter_intro = (
            "Мы подписали договор в редакции, как договорился бизнес. К сожалению, не все твои правки учтены. "
            "Сейчас мы на этапе исполнения и произойти может все, что угодно."
        )
        return {
            "case_id": case_id,
            "crisis_scenarios": scenarios,
            "doc_letter_text": doc_letter or "",
            "contract_clauses": clauses,
            "contract_title": (contract or {}).get("title", ""),
            "first_letter_intro": first_letter_intro,
            "full_contract_document_md": load_stage4_full_contract_markdown(DATA_DIR, case_id) or "",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


class Stage4InitRequest(BaseModel):
    case_id: str = "case-stage-4"
    session: Dict[str, Any] = {}
    contract_selections: Dict[str, str] = {}  # clause_id -> "A"|"B"|"C", триггер выбора кризиса внутри этапа 4
    simulex_session_id: Optional[str] = None  # внешний id игровой сессии → мост 3→4 из БД


class Stage4SecondCrisisRequest(BaseModel):
    case_id: str = "case-stage-4"
    first_crisis_id: str
    first_outcome: str  # accept | fixed | repeat | noChange
    contract_selections: Dict[str, str] = {}  # clause_id -> "A"|"B"|"C"
    simulex_session_id: Optional[str] = None
    session: Dict[str, Any] = {}


@router.post("/stage4/second-crisis")
async def stage4_second_crisis(
    body: Stage4SecondCrisisRequest, _u: Dict[str, Any] = Depends(get_current_user)
):
    """
    После первого исхода: вернуть второй кризис и короткий таймлайн до него.
    Второй кризис всегда наступает: внешний (если всё правильно), соответствующий (по неисправленным пунктам) или любой новый.
    """
    try:
        case_id = body.case_id or "case-stage-4"
        scenarios_data = load_crisis_scenarios(DATA_DIR, case_id)
        scenarios = (scenarios_data or {}).get("crisis_scenarios") or []
        if not scenarios:
            raise HTTPException(status_code=404, detail="Сценарии кризисов не найдены")
        sess = body.session or {}
        sim_sid = body.simulex_session_id or sess.get("id") or sess.get("session_id")
        sim_sid = str(sim_sid).strip() if sim_sid else None
        if sim_sid:
            _, _, clauses = load_contract_and_bridge_for_stage4(
                DATA_DIR, case_id, sim_sid, sess
            )
        else:
            contract = load_contract_clauses(DATA_DIR, case_id)
            clauses = (contract or {}).get("clauses") or []
        pool = load_timeline_events_pool(DATA_DIR, case_id)
        second = _select_second_crisis(
            body.first_crisis_id,
            body.first_outcome,
            clauses,
            body.contract_selections or {},
            scenarios,
        )
        if not second:
            second = scenarios[0]
        second = dict(second)
        second["diagnostic_questions"] = _enrich_diagnostic_questions(second)
        # Таймлайн до второго кризиса: если у сценария есть timeline_events — используем их (продолжение исполнения), иначе пул и случайный месяц 7/9/11
        second_crisis_month = random.choice([7, 9, 11])
        crisis_month = f"Через {second_crisis_month} месяцев"
        second_timeline = _generate_second_timeline(pool or [], crisis_month, selected_crisis=second, case_id=case_id)
        return {
            "case_id": case_id,
            "second_crisis": second,
            "second_timeline_events": second_timeline,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/stage4/init")
async def stage4_init(
    body: Stage4InitRequest, _u: Dict[str, Any] = Depends(get_current_user)
):
    """
    Инициализация этапа 4: выбор кризиса по триггеру внутри этапа (contract_selections).
    - Если передан contract_selections: все ловушки C → внешний кризис, иначе → случайный из 5 по ошибкам.
    - Если contract_selections не передан (прямой вход на этап 4): случайный кризис из всех 6.
    Возвращает: selected_crisis, timeline_events, doc_letter_text, contract_clauses.
    """
    try:
        case_id = body.case_id or "case-stage-4"
        session = body.session or {}
        sim_sid = body.simulex_session_id or session.get("id") or session.get("session_id")
        sim_sid = str(sim_sid).strip() if sim_sid else None

        scenarios_data = load_crisis_scenarios(DATA_DIR, case_id)
        scenarios = (scenarios_data or {}).get("crisis_scenarios") or []
        if not scenarios:
            raise HTTPException(status_code=404, detail="Сценарии кризисов не найдены")

        if sim_sid:
            contract, contract_selections, clauses = load_contract_and_bridge_for_stage4(
                DATA_DIR, case_id, sim_sid, session
            )
        else:
            contract = load_contract_clauses(DATA_DIR, case_id)
            clauses = (contract or {}).get("clauses") or []
            contract_selections = body.contract_selections or {}

        if contract_selections and clauses:
            selected = _select_crisis_by_contract_selections(scenarios, clauses, contract_selections)
        else:
            selected = None
        if not selected:
            selected = random.choice(scenarios)
        selected = dict(selected)
        selected["diagnostic_questions"] = _enrich_diagnostic_questions(selected)

        doc_letter = load_doc_letter_text(DATA_DIR, case_id)
        pool = load_timeline_events_pool(DATA_DIR, case_id)
        timeline_events = _generate_timeline(pool, case_id, selected)

        first_letter_intro = (
            "Мы подписали договор в редакции, как договорился бизнес. К сожалению, не все твои правки учтены. "
            "Сейчас мы на этапе исполнения и произойти может все, что угодно."
        )
        return {
            "case_id": case_id,
            "first_letter_intro": first_letter_intro,
            "selected_crisis": selected,
            "timeline_events": timeline_events,
            "doc_letter_text": doc_letter or "",
            "contract_clauses": clauses,
            "contract_title": (contract or {}).get("title", ""),
            "contract_selections": contract_selections,
            "full_contract_document_md": load_stage4_full_contract_markdown(DATA_DIR, case_id) or "",
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))
