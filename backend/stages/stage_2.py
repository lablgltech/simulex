"""Этап 2: Формирование позиции и выявление рисков — тренажёр по рискам в договоре (по драфту)."""
import hashlib
import json
import random
from pathlib import Path
from typing import Dict, Any, List, Optional
from stages.base_stage import BaseStage
from services.action_service import execute_action, validate_action_prerequisites, validate_action_mutex
from services.case_service import get_case
from config import DATA_DIR
from services.lexic_participation_service import stage2_lexic_eligible, snapshot_lexic


def _stage2_dir(data_dir: Path, case_id: str) -> Path:
    clean_id = str(case_id).replace("case-", "").strip()
    return data_dir / "cases" / f"case-{clean_id}" / "stage-2"


def _load_stage2_contract(data_dir: Path, case_id: str) -> Dict[str, Any]:
    """Загрузить контракт (contract.json)."""
    path = _stage2_dir(data_dir, case_id) / "contract.json"
    if not path.exists():
        return {"title": "", "clauses": [], "risk_matrix": {}}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_risk_matrix(data_dir: Path, case_id: str) -> Dict[str, Any]:
    """
    Загрузить матрицу рисков. Поддержка:
    - risk_matrix.json (драфт): { "contract_id", "risks": [ { clause_id, has_risk, correct_level, description } ] }
    - contract.json.risk_matrix: { clause_id: "high"|"medium"|"low" }
    Возвращает: { "by_clause": { clause_id: { "correct_level", "description", "has_risk" } }, "risks_list": [...] }
    """
    stage_dir = _stage2_dir(data_dir, case_id)
    path = stage_dir / "risk_matrix.json"
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        by_clause = {}
        risks_list = data.get("risks", [])
        for r in risks_list:
            cid = r.get("clause_id")
            by_clause[cid] = {
                "has_risk": r.get("has_risk", True),
                "correct_level": r.get("correct_level"),
                "description": r.get("description", ""),
            }
        return {"by_clause": by_clause, "risks_list": risks_list}

    contract_data = _load_stage2_contract(data_dir, case_id)
    matrix = contract_data.get("risk_matrix", {})
    by_clause = {
        cid: {"has_risk": True, "correct_level": level, "description": ""}
        for cid, level in matrix.items()
    }
    return {"by_clause": by_clause, "risks_list": [{"clause_id": k, "has_risk": True, "correct_level": v, "description": ""} for k, v in matrix.items()]}


def _load_game_config(data_dir: Path, case_id: str) -> Dict[str, Any]:
    path = _stage2_dir(data_dir, case_id) / "game_config.json"
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# Короткие подписи для ячеек матрицы (только из этого списка или из risk_matrix.json ≤60 символов).
# Чтобы в квадратиках никогда не уходил текст пункта договора.
SHORT_LABEL_MAX_LENGTH = 60
SHORT_LABELS_FALLBACK = {
    "1.4.1": "Территория использования",
    "1.4.2": "Срок использования",
    "1.6": "Доп. лицензии",
    "1.7": "Кастомизация",
    "2.3": "Режим поддержки",
    "3.1": "Стоимость и НДС",
    "3.2": "Порядок оплаты",
    "4.1": "Акты использования ПО и сопровождение",
    "4.2": "Акты и приёмка",
    "5.1": "Гарантийный срок",
    "6.1": "Неустойка (оплата)",
    "6.2": "Неустойка (работы)",
    "6.3": "Лимит ответственности",
    "6.4": "Исключения из возмещения",
    "7.1": "Претензионный порядок",
    "7.2": "Подсудность",
    "8.1": "Персональные данные",
    "9.2": "Расторжение",
}

# Типы риска (теги): для каждого типа — список clause_id, которые к нему относятся. За правильный тег +5 баллов.
RISK_TAG_CLAUSES = {
    "legal": ["1.4.1", "1.7", "3.1", "3.2", "4.2", "6.2", "6.3", "6.4", "8.1", "9.2"],
    "operational": ["1.4.1", "1.4.2", "1.7", "2.3", "4.2", "5.1", "7.1", "9.2"],
    "financial": ["1.4.2", "2.3", "3.1", "3.2", "5.1", "6.1", "6.2", "6.3", "6.4", "7.1", "8.1", "9.2"],
    "reputational": ["6.4", "8.1"],
}
PT_TAG_CORRECT = 5

# Верные ответы для облака «Хочу добавить в договор» (для отчёта и начисления баллов).
# Неправильные варианты: гарантийный срок, контрагент всегда отвечает за претензии и убытки, только контрагент урегулирует претензии.
MISSING_CONDITIONS_CORRECT = [
    "право на сублицензирование",
    "контрагент действует в пределах предоставленных прав",
    "контрагент не нарушает прав третьих лиц",
    "у третьих лиц нет исключительных прав",
    "качество соответствует ТЗ",
    "обстоятельства, препятствующие использованию ПО отсутствуют",
    "заверения и гарантии достоверны",
]
PT_MISSING_CORRECT = 5   # устар.: для отчёта «доп. условия»; LEXIC L считается отдельно
PT_MISSING_WRONG = -5

# LEXIC этап 2 (начисление на сессию, clamp 0–100)
PT_L_RISK_HIT = 5       # L: верно отметил пункт с риском (уровень не важен)
PT_L_RISK_FALSE = -3    # L: отметил пункт без риска в матрице
PT_L_MISSING_OK = 5     # L: верно выбрал доп. условие к договору
PT_L_MISSING_BAD = -3   # L: выбрал условие, которое добавлять не нужно
PT_E_ONTIME = 10        # E: уложился во время
PT_E_LATE = -10         # E: не уложился
PT_X_LEVEL = 5          # X: верный уровень риска (цвет)
PT_I_TAG_OK = 5         # I: верно отмеченный тип риска по пункту
PT_C_CLARIFY_FULL = 20  # C: один случайный пункт после валидации — все типы верно по нему + все пункты обоснования (I — частично за тег)

# Бонус за обоснование (для проверки полноты под C); в summary больше не +5
PT_JUSTIFICATION_BONUS = 0


def _lexic_apply(session: Dict[str, Any], deltas: Dict[str, int]) -> Dict[str, Any]:
    lex = dict(session.get("lexic") or {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50})
    for k in ("L", "E", "X", "I", "C"):
        if k not in lex or lex[k] is None:
            lex[k] = 50
    for key, d in deltas.items():
        if key not in lex or d == 0:
            continue
        lex[key] = max(0, min(100, int(lex[key]) + int(d)))
    return lex

# Пункты обоснования по типам риска (строки должны совпадать с фронтендом WHY_REASONS).
WHY_REASONS_BY_TYPE = {
    "legal": [
        "Неограниченная ответственность",
        "Отсутствие защитного механизма",
        "Пункт создает юридическую неопределенность или уязвимость",
        "Есть риск несоответствия законодательству/невозможности исполнения",
        "Несбалансированность прав сторон",
    ],
    "operational": [
        "Есть риск для повседневной деятельности или ресурсов",
        "Недостаток ресурсов",
        "Формулировка создает сложности в практическом исполнении",
        "Технические ограничения",
        "Зависимость от третьих лиц",
    ],
    "financial": [
        "Скрытые затраты",
        "Есть угроза бюджету/экономической эффективности сделки",
    ],
    "reputational": [
        "Формулировка создает риск для имиджа/отношений с контрагентами",
        "Есть угроза публичному восприятию компании",
    ],
}


def _required_justification_reasons_for_clause(clause_id: str, report: Dict[str, Any]) -> set:
    """По отчёту вернуть множество верных пунктов обоснования для данного clause_id (по correct_tags)."""
    clause_results = report.get("clause_results") or []
    row = next((r for r in clause_results if str(r.get("clause_id", "")).strip() == str(clause_id).strip()), None)
    if not row:
        return set()
    correct_tags = row.get("correct_tags") or []
    required = set()
    for tag in correct_tags:
        tag_lower = str(tag).strip().lower()
        for reason in WHY_REASONS_BY_TYPE.get(tag_lower, []):
            required.add(reason)
    return required


def _justification_bonus(clause_id: str, selected_reasons: List[str], report: Dict[str, Any]) -> int:
    """Полное обоснование по пункту (для C и отображения); без отдельных баллов в summary."""
    clause_results = report.get("clause_results") or []
    row = next((r for r in clause_results if str(r.get("clause_id", "")).strip() == str(clause_id).strip()), None)
    if not row:
        return 0
    tag_results = row.get("tag_results") or {}
    for tag_id in ("legal", "financial", "operational", "reputational"):
        if tag_results.get(tag_id) == "wrong":
            return 0
    required = _required_justification_reasons_for_clause(clause_id, report)
    selected_set = {str(s).strip() for s in (selected_reasons or []) if s}
    if required and selected_set == required:
        return 1
    return 0


def _tags_exact_for_clause(clause_id: str, report: Dict[str, Any], clause_tags_map: Dict[str, Any]) -> bool:
    """По одному пункту набор типов риска игрока совпадает с эталоном (для C)."""
    cid = str(clause_id).strip()
    row = next(
        (r for r in report.get("clause_results") or [] if str(r.get("clause_id", "")).strip() == cid),
        None,
    )
    if not row:
        return False
    correct = frozenset(str(x).lower() for x in (row.get("correct_tags") or []))
    raw = clause_tags_map.get(cid)
    if raw is None:
        raw = clause_tags_map.get(clause_id) or []
    if not isinstance(raw, list):
        raw = []
    user = frozenset(str(x).lower() for x in raw)
    return user == correct


def _pick_clarify_clause_id(
    session: Dict[str, Any],
    clause_results: List[Dict[str, Any]],
    clause_tags: Optional[Dict[str, List[str]]] = None,
) -> Optional[str]:
    """
    Один случайный пункт для уточнения (детерминированно от id сессии).

    Кандидат подходит только если:
    - игрок отметил по нему риск (user_selected=true),
    - и по этому же пункту выбраны типы риска (непустой список тегов).
    """
    clause_tags = clause_tags or {}
    tagged_clause_ids = {
        str(cid).strip()
        for cid, tags in clause_tags.items()
        if str(cid).strip() and isinstance(tags, list) and len(tags) > 0
    }
    candidates = sorted(
        {
            str(r.get("clause_id", "")).strip()
            for r in clause_results
            if r.get("user_selected")
            and str(r.get("clause_id", "")).strip()
            and str(r.get("clause_id", "")).strip() in tagged_clause_ids
        }
    )
    if not candidates:
        return None
    sid = str(session.get("id") or session.get("case_id") or "simulex")
    seed = int(hashlib.sha256(f"clarify:{sid}:{','.join(candidates)}".encode()).hexdigest()[:12], 16)
    rng = random.Random(seed)
    return rng.choice(candidates)


def _load_stage2_legend(data_dir: Path, case_id: str, stage_config: Dict[str, Any]) -> str:
    """Текст гайда этапа 2: сначала legend.md кейса, иначе путь из resources.legend_md."""
    clean = str(case_id).replace("case-", "").strip()
    p_case = data_dir / "cases" / f"case-{clean}" / "stage-2" / "legend.md"
    if p_case.exists():
        try:
            return p_case.read_text(encoding="utf-8")
        except OSError:
            pass
    rel = (stage_config.get("resources") or {}).get("legend_md") or ""
    if rel:
        rel = str(rel).replace("\\", "/")
        if rel.startswith("data/"):
            rel = rel[5:].lstrip("/")
        p_res = data_dir / rel
        if p_res.exists():
            try:
                return p_res.read_text(encoding="utf-8")
            except OSError:
                pass
    return ""


def _short_description(clause_id: str, description: str) -> str:
    """Вернуть короткую подпись для ячейки: из description, если она короткая, иначе из словаря."""
    desc = (description or "").strip()
    if desc and len(desc) <= SHORT_LABEL_MAX_LENGTH:
        return desc
    return SHORT_LABELS_FALLBACK.get(str(clause_id).strip(), f"Пункт {clause_id}")


class Stage2(BaseStage):
    """Этап 2: Формирование позиции и выявление рисков — работа с договором и классификация рисков."""

    def get_stage_info(self) -> Dict[str, Any]:
        return {
            "title": "Этап 2: Формирование позиции и выявление рисков",
            "intro": "Выявите пункты договора, содержащие риск, и классифицируйте уровень риска.",
            "type": "position",
            "points_budget": self.stage_config.get("points_budget", 7),
            "custom_mechanics": ["contract", "risk_classification"],
        }

    def get_actions(self) -> List[Dict[str, Any]]:
        return self.stage_config.get("actions", [])

    def get_custom_data(self) -> Dict[str, Any]:
        """Контракт, game_config, эталонная матрица рисков и описания для UI."""
        case_id = self.case_data.get("id", "")
        contract_data = _load_stage2_contract(DATA_DIR, case_id)
        risk_data = _load_risk_matrix(DATA_DIR, case_id)
        game_config = _load_game_config(DATA_DIR, case_id)
        risks_for_ui = [
            {
                "clause_id": r.get("clause_id"),
                "description": _short_description(r.get("clause_id", ""), r.get("description", "")),
            }
            for r in risk_data.get("risks_list", [])
        ]
        # Эталонная матрица для отображения на вкладке «Матрица рисков» (clause_id -> high|medium|low)
        by_clause = risk_data.get("by_clause", {})
        risk_matrix = {
            cid: info.get("correct_level")
            for cid, info in by_clause.items()
            if info.get("correct_level")
        }
        legend_md = _load_stage2_legend(DATA_DIR, case_id, self.stage_config)
        return {
            "contract_title": contract_data.get("title", "Договор"),
            "contract_preamble": contract_data.get("preamble", ""),
            "contract_trailer": contract_data.get("trailer", ""),
            "clauses": contract_data.get("clauses", []),
            "game_config": game_config,
            "risk_descriptions": risks_for_ui,
            "risk_matrix": risk_matrix,
            "legend_markdown": legend_md,
        }

    def validate_risks_and_report(
        self,
        session: Dict[str, Any],
        clause_risks: Dict[str, str],
        clause_tags: Optional[Dict[str, List[str]]] = None,
        missing_conditions: Optional[List[str]] = None,
        stage2_seconds_elapsed: Optional[int] = None,
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        """
        Отчёт по рискам + начисление LEXIC: L (риски и доп. условия), E (время), X (уровень), I (типы риска).
        """
        lexic_pres = snapshot_lexic(session)
        case_id = self.case_data.get("id", "")
        contract_data = _load_stage2_contract(DATA_DIR, case_id)
        risk_data = _load_risk_matrix(DATA_DIR, case_id)
        game_config = _load_game_config(DATA_DIR, case_id)

        by_clause = risk_data.get("by_clause", {})
        clauses_with_risk = {str(cid).strip() for cid, v in by_clause.items() if v.get("has_risk") and v.get("correct_level")}
        total_risks = len(clauses_with_risk)
        clauses_list = {c["id"]: c for c in contract_data.get("clauses", [])}

        _raw_risks = clause_risks or {}
        clause_risks = {str(k).strip(): v for k, v in _raw_risks.items() if v}

        _raw_tags = clause_tags or {}
        clause_tags = {}
        for k, v in _raw_tags.items():
            if not isinstance(v, list):
                continue
            key = str(k).strip()
            clause_tags[key] = [str(t).strip().lower() for t in v]
        # Типы риска только по пунктам, где игрок реально отметил уровень (не «залипшие» теги после снятия риска)
        risk_keys = set(clause_risks.keys())
        clause_tags = {k: v for k, v in clause_tags.items() if str(k).strip() in risk_keys}
        all_clause_ids = {str(cid).strip() for cid in (set(clauses_list.keys()) | set(by_clause.keys()))}

        def correct_tags_for_clause(cid: str) -> List[str]:
            cid_norm = str(cid).strip()
            return [tag_id for tag_id, allowed in RISK_TAG_CLAUSES.items() if cid_norm in [str(x).strip() for x in allowed]]

        def tag_result_for(cid: str, tag_id: str) -> Optional[str]:
            cid_norm = str(cid).strip()
            allowed = RISK_TAG_CLAUSES.get(tag_id, [])
            correct_for_clause = cid_norm in [str(x).strip() for x in allowed]
            user_tags = clause_tags.get(cid_norm) or clause_tags.get(cid) or []
            selected = tag_id in user_tags
            if selected and correct_for_clause:
                return "ok"
            if selected and not correct_for_clause:
                return "wrong"
            if not selected and correct_for_clause:
                return "missed"
            return None

        clause_results = []
        found_risks = false_positives = missed_risks = 0
        for cid in sorted(all_clause_ids):
            user_selected = cid in clause_risks
            user_level = clause_risks.get(cid)
            info = by_clause.get(cid, {})
            has_risk = bool(info.get("has_risk") and info.get("correct_level"))
            correct_level = info.get("correct_level") if has_risk else None
            clause_correct = (user_selected and has_risk) or (not user_selected and not has_risk)
            risk_level_correct = (user_level == correct_level) if (user_selected and correct_level) else None

            if user_selected and has_risk:
                found_risks += 1
            elif user_selected and not has_risk:
                false_positives += 1
            elif not user_selected and has_risk:
                missed_risks += 1

            row = {
                "clause_id": cid,
                "user_selected": user_selected,
                "user_risk_level": user_level,
                "correct_risk_level": correct_level,
                "clause_correct": clause_correct,
                "risk_level_correct": risk_level_correct,
                "score_delta": 0,
                "description": _short_description(cid, info.get("description", "")),
            }
            if user_selected:
                row["tag_results"] = {
                    "legal": tag_result_for(cid, "legal"),
                    "financial": tag_result_for(cid, "financial"),
                    "operational": tag_result_for(cid, "operational"),
                    "reputational": tag_result_for(cid, "reputational"),
                }
                row["correct_tags"] = correct_tags_for_clause(cid)
            clause_results.append(row)

        # —— L: Legal compliance ——
        l_delta = 0
        for cid in clause_risks:
            if cid in clauses_with_risk:
                l_delta += PT_L_RISK_HIT
            else:
                l_delta += PT_L_RISK_FALSE
        missing_conditions = missing_conditions or []
        correct_set = {str(x).strip() for x in MISSING_CONDITIONS_CORRECT}
        selected_list = [str(x).strip() for x in missing_conditions if x]
        for c in MISSING_CONDITIONS_CORRECT:
            c_norm = str(c).strip()
            if c_norm in selected_list:
                l_delta += PT_L_MISSING_OK
            else:
                l_delta += PT_L_MISSING_BAD
        for s in selected_list:
            if s not in correct_set:
                l_delta += PT_L_MISSING_BAD

        # —— E: Efficiency (время) ——
        tlim = game_config.get("time_limit") or {}
        if tlim.get("enabled"):
            limit_sec = int(tlim.get("seconds", 1800))
            elapsed = stage2_seconds_elapsed
            if elapsed is not None and elapsed >= 0:
                e_delta = PT_E_ONTIME if elapsed <= limit_sec else PT_E_LATE
            else:
                e_delta = PT_E_ONTIME
        else:
            e_delta = PT_E_ONTIME

        # —— X: Expertise (уровень риска) ——
        x_delta = 0
        for cid, ul in clause_risks.items():
            if cid not in clauses_with_risk:
                continue
            if ul == by_clause.get(cid, {}).get("correct_level"):
                x_delta += PT_X_LEVEL

        # —— I: Interest (верные типы риска, по каждому «ok») ——
        i_delta = 0
        tag_correct_count = 0
        for row in clause_results:
            if not row.get("user_selected"):
                continue
            for t in ("legal", "financial", "operational", "reputational"):
                if (row.get("tag_results") or {}).get(t) == "ok":
                    i_delta += PT_I_TAG_OK
                    tag_correct_count += 1

        # Используем stage2_lexic_service для расчёта LEXIC
        try:
            from services.stage2_lexic_service import compute_stage2_lexic
            initial_lexic = dict(session.get("lexic") or {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50})
            tlim = game_config.get("time_limit") or {}
            time_limit_sec = int(tlim.get("seconds", 1800)) if tlim.get("enabled") else None
            new_lexic, lexic_breakdown = compute_stage2_lexic(
                clause_risks=clause_risks,
                clause_tags=clause_tags,
                missing_conditions=missing_conditions,
                by_clause=by_clause,
                stage2_seconds_elapsed=stage2_seconds_elapsed,
                time_limit_seconds=time_limit_sec,
                clarify_clause_id=clarify_clause_id if 'clarify_clause_id' in dir() else None,
                has_justification_for_clarify=False,  # будет обновлено после выбора пункта обоснования
                initial_lexic=initial_lexic,
            )
            updated_lexic = new_lexic
            l_delta = lexic_breakdown["summary"]["lexic_deltas"]["L"]
            e_delta = lexic_breakdown["summary"]["lexic_deltas"]["E"]
            x_delta = lexic_breakdown["summary"]["lexic_deltas"]["X"]
            i_delta = lexic_breakdown["summary"]["lexic_deltas"]["I"]
        except Exception as _lexic_err:
            # Fallback: оригинальная inline-логика
            print(f"⚠️ stage_2: ошибка при использовании stage2_lexic_service: {_lexic_err}")
            lexic_deltas = {"L": l_delta, "E": e_delta, "X": x_delta, "I": i_delta}
            updated_lexic = _lexic_apply(session, lexic_deltas)
            lexic_breakdown = {}

        lexic_deltas = {"L": l_delta, "E": e_delta, "X": x_delta, "I": i_delta}

        missing_conditions_correct_count = sum(1 for c in MISSING_CONDITIONS_CORRECT if str(c).strip() in selected_list)
        missing_conditions_wrong_count = sum(1 for c in MISSING_CONDITIONS_CORRECT if str(c).strip() not in selected_list)
        missing_conditions_wrong_count += sum(1 for s in selected_list if s not in correct_set)
        miss_l = 0
        for c in MISSING_CONDITIONS_CORRECT:
            if str(c).strip() in selected_list:
                miss_l += PT_L_MISSING_OK
            else:
                miss_l += PT_L_MISSING_BAD
        for s in selected_list:
            if s not in correct_set:
                miss_l += PT_L_MISSING_BAD

        max_i = sum(len(correct_tags_for_clause(c)) for c in clauses_with_risk) * PT_I_TAG_OK
        could_clarify = False
        if isinstance(clause_tags, dict):
            for cid in clause_risks:
                if cid not in clauses_with_risk:
                    continue
                tlist = clause_tags.get(cid)
                if isinstance(tlist, list) and len(tlist) > 0:
                    could_clarify = True
                    break
        max_positive = (
            PT_L_RISK_HIT * total_risks
            + PT_L_MISSING_OK * len(MISSING_CONDITIONS_CORRECT)
            + PT_E_ONTIME
            + PT_X_LEVEL * total_risks
            + max(1, max_i)
        )
        if could_clarify:
            max_positive += PT_C_CLARIFY_FULL
        total_points = l_delta + e_delta + x_delta + i_delta
        score_percent = round(100 * max(0, total_points) / max_positive, 1) if max_positive else 0

        summary = {
            "total_score": total_points,
            "max_score": max_positive,
            "found_risks": found_risks,
            "total_risks": total_risks,
            "false_positives": false_positives,
            "missed_risks": missed_risks,
            "tag_score": i_delta,
            "tag_correct_count": tag_correct_count,
            "missing_conditions_score": miss_l,
            "missing_conditions_correct_count": missing_conditions_correct_count,
            "missing_conditions_wrong_count": missing_conditions_wrong_count,
            "lexic_deltas_stage2": lexic_deltas,
        }
        clarify_clause_id = _pick_clarify_clause_id(session, clause_results, clause_tags)
        report = {
            "summary": summary,
            "clause_results": clause_results,
            "clarify_clause_id": clarify_clause_id,
            "statistics": {
                "total_clauses_with_risk": total_risks,
                "correct": sum(1 for r in clause_results if r.get("risk_level_correct")),
                "errors": sum(1 for r in clause_results if r.get("user_selected") and r.get("correct_risk_level") is not None and r.get("risk_level_correct") is False),
                "score_percent": score_percent,
            },
            "errors": [r for r in clause_results if r.get("user_selected") and not r.get("clause_correct") or (r.get("risk_level_correct") is False)],
            "correct_answers": [r for r in clause_results if r.get("clause_correct") and r.get("risk_level_correct")],
            "missing_conditions_selected": list(missing_conditions),
            "missing_conditions_correct": list(MISSING_CONDITIONS_CORRECT),
        }

        eligible, skip_reason = stage2_lexic_eligible(report, total_risks)
        lexic_out = dict(lexic_pres) if not eligible else dict(updated_lexic)

        updated = dict(session)
        updated["lexic"] = lexic_out
        report = dict(report)
        report["lexic_scored"] = bool(eligible)
        if not eligible:
            updated["stage2_lexic_skipped"] = True
            updated["stage2_lexic_skip_reason"] = skip_reason
        else:
            updated.pop("stage2_lexic_skipped", None)
            updated.pop("stage2_lexic_skip_reason", None)
        updated["stage2_report"] = report
        updated["stage2_validation_done"] = True
        updated["stage2_clause_risks"] = dict(clause_risks)
        updated["stage2_clause_tags"] = {k: list(v) for k, v in clause_tags.items() if isinstance(v, list)}
        updated["stage2_missing_conditions_selected"] = list(missing_conditions)
        updated["stage2_clarify_awarded"] = False
        updated["stage2_clarify_clause_id"] = clarify_clause_id
        return updated, report

    def submit_justification(
        self,
        session: Dict[str, Any],
        clause_id: str,
        selected_reasons: List[str],
    ) -> Dict[str, Any]:
        """
        Обоснование по пункту босса: после «Готово» это всегда stage2_clarify_clause_id.
        clause_id из запроса не используется для оценки (пункт задаёт только сервер).
        C (+20): все типы верны по этому пункту + полный набор обоснований.
        """
        report = (session.get("stage2_report") or {}).copy()
        if not report:
            return dict(session)
        clarify_cid = str(session.get("stage2_clarify_clause_id") or "").strip()
        # Fallback для старых сессий без clarify_clause_id
        cid_eval = clarify_cid or str(clause_id or "").strip()
        if not cid_eval:
            return dict(session)
        clause_results = report.get("clause_results") or []
        row = next(
            (r for r in clause_results if str(r.get("clause_id", "")).strip() == cid_eval),
            None,
        )
        tag_results = (row or {}).get("tag_results") or {}
        has_wrong_type = any(tag_results.get(t) == "wrong" for t in ("legal", "financial", "operational", "reputational"))
        show_correct_answer = not has_wrong_type
        required_reasons = list(_required_justification_reasons_for_clause(cid_eval, report)) if show_correct_answer else []

        justification_complete = _justification_bonus(cid_eval, selected_reasons or [], report) == 1
        updated = dict(session)
        updated["stage2_justification_bonus"] = 1 if justification_complete else 0
        updated["stage2_justification_clause_id"] = cid_eval
        updated["stage2_justification_selected"] = list(selected_reasons or [])
        updated["stage2_justification_show_correct"] = show_correct_answer
        updated["stage2_justification_correct_reasons"] = required_reasons if show_correct_answer else []

        summary = (report.get("summary") or {}).copy()
        summary["justification_complete"] = justification_complete
        tags_map = updated.get("stage2_clause_tags") or session.get("stage2_clause_tags") or {}
        tags_ok = _tags_exact_for_clause(clarify_cid, report, tags_map) if clarify_cid else False
        can_award_c = (
            bool(clarify_cid)
            and not updated.get("stage2_clarify_awarded")
            and not session.get("stage2_lexic_skipped")
        )
        if can_award_c and tags_ok and justification_complete:
            updated["lexic"] = _lexic_apply(updated, {"C": PT_C_CLARIFY_FULL})
            updated["stage2_clarify_awarded"] = True
            summary["clarify_c_awarded"] = PT_C_CLARIFY_FULL
            prev_total = summary.get("total_score", 0)
            if isinstance(prev_total, (int, float)):
                summary["total_score"] = prev_total + PT_C_CLARIFY_FULL
            ld = dict(summary.get("lexic_deltas_stage2") or {})
            ld["C"] = ld.get("C", 0) + PT_C_CLARIFY_FULL
            summary["lexic_deltas_stage2"] = ld
            mx = summary.get("max_score") or 0
            tot = summary.get("total_score", 0)
            if mx:
                stats = dict(report.get("statistics") or {})
                stats["score_percent"] = round(100 * max(0, tot) / mx, 1)
                report["statistics"] = stats
        report = dict(report)
        report["summary"] = summary
        updated["stage2_report"] = report
        return updated

    def validate_action(self, action_id: str, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        action = next((a for a in self.get_actions() if a.get("id") == action_id), None)
        if not action:
            return False, "Действие не найдено"
        is_valid, error_msg = validate_action_prerequisites(action, session)
        if not is_valid:
            return False, error_msg
        case_id = session.get("case_id", "").replace("case-", "") if session.get("case_id") else None
        case_data = get_case(DATA_DIR, case_id)
        is_valid, error_msg = validate_action_mutex(action, case_data, session)
        if not is_valid:
            return False, error_msg
        return True, None

    def execute_action(self, action_id: str, session: Dict[str, Any], **kwargs) -> Dict[str, Any]:
        action = next((a for a in self.get_actions() if a.get("id") == action_id), None)
        if not action:
            raise ValueError("Действие не найдено")
        return execute_action(action, session)

    def can_complete(self, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        if session.get("stage2_validation_done"):
            return True, None
        required = [a for a in self.get_actions() if a.get("is_required")]
        if required:
            for req in required:
                if req.get("id") not in session.get("actions_done", []):
                    return False, f'Требуется выполнить: "{req.get("title")}"'
        case_id = self.case_data.get("id", "")
        risk_data = _load_risk_matrix(DATA_DIR, case_id)
        has_any_risk = any(
            v.get("has_risk") and v.get("correct_level")
            for v in (risk_data.get("by_clause") or {}).values()
        )
        if has_any_risk:
            return False, 'Нажмите «Готово», чтобы проверить классификацию рисков.'
        return True, None

    def on_complete(self, session: Dict[str, Any]) -> Dict[str, Any]:
        return session
