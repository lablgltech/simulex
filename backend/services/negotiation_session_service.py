"""
Сервисный слой для работы с сессиями переговоров (negotiation_session)
и этапными сессиями (stage_session).

Используется этапом 3 (Согласование) для:
- создания сессии переговоров на основе общей сессии Симулекса;
- получения связанной negotiation_session_id по simulex_session_id + stage_code;
- чтения/записи history_json.
"""

from __future__ import annotations

from typing import Optional, Tuple, Dict, Any
import json

from db import get_connection


STAGE_CODE_NEGOTIATION = "stage-3"


def get_case_code_for_negotiation_session(negotiation_session_id: int) -> str:
    """
    Получить case_code (идентификатор кейса) для сессии переговоров.
    Читает из stage_session по связи negotiation_session -> stage_session.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ss.case_code
                FROM negotiation_session ns
                JOIN stage_session ss ON ns.stage_session_id = ss.id
                WHERE ns.id = %s
                """,
                (negotiation_session_id,),
            )
            row = cur.fetchone()
    if row and row[0]:
        return str(row[0]).strip() or "case-001"
    return "case-001"


def get_negotiation_session_by_simulex_session(
    simulex_session_id: str,
) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
    """
    Найти negotiation_session и её history_json по simulex_session_id (только для этапа 3).
    Не создаёт записей. Используется для отчёта.

    Возвращает (negotiation_session_id, history) или (None, None), если сессии переговоров нет.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ns.id, ns.history_json
                FROM stage_session ss
                JOIN negotiation_session ns ON ns.stage_session_id = ss.id
                WHERE ss.simulex_session_id = %s AND ss.stage_code = %s
                """,
                (simulex_session_id, STAGE_CODE_NEGOTIATION),
            )
            row = cur.fetchone()
    if not row:
        return None, None
    neg_id, raw = row[0], row[1] or {}
    history = {
        "clause_status": raw.get("clause_status", {}),
        "clause_replacements": raw.get("clause_replacements", {}),
        "total_points": raw.get("total_points", 0),
    }
    return neg_id, history


def get_or_create_stage_and_negotiation_session(
    simulex_session_id: str,
    case_code: str,
    contract_code: str,
) -> Tuple[int, int]:
    """
    Найти или создать stage_session + negotiation_session для этапа 3.

    Возвращает (stage_session_id, negotiation_session_id).
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
                                                  
            cur.execute(
                """
                SELECT id FROM stage_session
                WHERE simulex_session_id = %s AND stage_code = %s
                """,
                (simulex_session_id, STAGE_CODE_NEGOTIATION),
            )
            row = cur.fetchone()
            if row:
                stage_session_id = row[0]
            else:
                cur.execute(
                    """
                    INSERT INTO stage_session (simulex_session_id, stage_code, case_code, payload_json)
                    VALUES (%s, %s, %s, '{}'::jsonb)
                    RETURNING id
                    """,
                    (simulex_session_id, STAGE_CODE_NEGOTIATION, case_code),
                )
                stage_session_id = cur.fetchone()[0]

                                         
            cur.execute(
                "SELECT id FROM contract WHERE code = %s",
                (contract_code,),
            )
            contract_row = cur.fetchone()
            if not contract_row:
                raise RuntimeError(
                    f"Договор с code='{contract_code}' не найден в таблице contract. "
                    "Создайте запись в БД перед запуском этапа 3."
                )
            contract_id = contract_row[0]

                                                        
            cur.execute(
                """
                SELECT id FROM negotiation_session
                WHERE stage_session_id = %s AND contract_id = %s
                """,
                (stage_session_id, contract_id),
            )
            n_row = cur.fetchone()
            if n_row:
                negotiation_session_id = n_row[0]
            else:
                cur.execute(
                    """
                    INSERT INTO negotiation_session (stage_session_id, contract_id, history_json)
                    VALUES (%s, %s, '{}'::jsonb)
                    RETURNING id
                    """,
                    (stage_session_id, contract_id),
                )
                negotiation_session_id = cur.fetchone()[0]

    return stage_session_id, negotiation_session_id


def get_negotiation_history(negotiation_session_id: int) -> Dict[str, Any]:
    """
    Получить history_json для указанной negotiation_session.
    Если истории ещё нет, возвращает базовую структуру.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT history_json
                FROM negotiation_session
                WHERE id = %s
                """,
                (negotiation_session_id,),
            )
            row = cur.fetchone()

    if not row:
        raise RuntimeError(f"negotiation_session {negotiation_session_id} не найдена")

    raw = row[0] or {}
                                                                                 
    chat_history_by_clause: Dict[str, list] = dict(raw.get("chat_history_by_clause") or {})
    if not chat_history_by_clause and raw.get("chat_history"):
                                                                                  
        for msg in raw.get("chat_history", []):
            cid = str(msg.get("clauseId") or "")
            if cid:
                chat_history_by_clause.setdefault(cid, []).append(msg)
                                                                                                 
    def _flatten_chat_history(by_clause: Dict[str, list]) -> list:
        out: list = []
        for cid in sorted(by_clause.keys()):
            out.extend(by_clause[cid] or [])
        return out

                                                     
                                                                    
                                                                                    
    history: Dict[str, Any] = {
        "chat_history_by_clause": chat_history_by_clause,
        "chat_history": _flatten_chat_history(chat_history_by_clause),
        "clause_status": raw.get("clause_status", {}),
        "clause_replacements": raw.get("clause_replacements", {}),
        "total_points": raw.get("total_points", 0),
                                                                                                               
        "patience": raw.get("patience", {}),
        "max_patience": raw.get("max_patience", 100),
        "mode": raw.get("mode", "ai"),
        "ai": raw.get(
            "ai",
            {
                "enabled": True,
                "max_objections_per_item": 4,
            },
        ),
                                                                               
        "ai_lessons_by_clause": raw.get("ai_lessons_by_clause", {}),
    }
                                    
    if "lawyer_name" in raw:
        history["lawyer_name"] = raw["lawyer_name"]
    if "lawyer_company" in raw:
        history["lawyer_company"] = raw["lawyer_company"]
                                                                                                  
    if raw.get("clause_dialogue_started_at"):
        history["clause_dialogue_started_at"] = raw["clause_dialogue_started_at"]
    if raw.get("clause_dialogue_summaries"):
        history["clause_dialogue_summaries"] = raw["clause_dialogue_summaries"]
                                                                                                                                    
    if raw.get("excluded_clause_ids"):
        history["excluded_clause_ids"] = list(raw["excluded_clause_ids"])

    return history


def _ensure_json_serializable(obj: Any) -> Any:
    """Рекурсивно приводит объект к JSON-сериализуемому виду (защита от Errno 22 на Windows)."""
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _ensure_json_serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_ensure_json_serializable(x) for x in obj]
    return str(obj)


def reset_negotiation_contract_to_initial(negotiation_session_id: int) -> None:
    """
    Сбросить подставленные в договор тексты и прогресс переговоров: исходные формулировки из кейса,
    пустая история чата по пунктам. Вызывается при повторном старте этапа 3 без кэша negotiation_session_id.
    """
    history = get_negotiation_history(negotiation_session_id)
    history["clause_replacements"] = {}
    history["clause_status"] = {}
    history["chat_history_by_clause"] = {}
    history["chat_history"] = []
    history["total_points"] = 0
    history.pop("excluded_clause_ids", None)
    history.pop("clause_dialogue_started_at", None)
    history["patience"] = {}
    history.pop("stage3_patience_off_topic_count", None)
    history["ai_lessons_by_clause"] = {}
    history.pop("clause_dialogue_summaries", None)
    save_negotiation_history(negotiation_session_id, history)


def save_negotiation_history(
    negotiation_session_id: int,
    history: Dict[str, Any],
) -> None:
    """
    Сохранить history_json для negotiation_session.
    """
    safe_history = _ensure_json_serializable(history)
    json_str = json.dumps(safe_history, ensure_ascii=False)
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE negotiation_session
                SET history_json = %s::jsonb,
                    updated_at = NOW()
                WHERE id = %s
                """,
                (json_str, negotiation_session_id),
            )
            if cur.rowcount != 1:
                raise RuntimeError(
                    f"Не удалось обновить history_json для negotiation_session {negotiation_session_id}"
                )


def set_ai_mode(negotiation_session_id: int, enabled: bool) -> Dict[str, Any]:
    """
    Включить / выключить ИИ‑режим для данной negotiation_session.

    Флаг хранится в history_json: поля mode ('ai' / 'simple') и ai.enabled.
    В продукте без NEGOTIATION_ALLOW_SIMPLE_MODE=1 simple-режим не используется (см. chat_service.is_ai_mode).
    Возвращает актуальное состояние настроек.
    """
    history = get_negotiation_history(negotiation_session_id)
                                                                    
                                                                         
    history["chat_history_by_clause"] = {}
    history["chat_history"] = []
    history["clause_status"] = {}
    history["clause_replacements"] = {}
    history["total_points"] = 0
    history.pop("clause_dialogue_started_at", None)

    history["mode"] = "ai" if enabled else "simple"
    ai_cfg = history.get("ai") or {}
    ai_cfg["enabled"] = bool(enabled)
    if "max_objections_per_item" not in ai_cfg:
        ai_cfg["max_objections_per_item"] = 4
    history["ai"] = ai_cfg
    save_negotiation_history(negotiation_session_id, history)
    return {"mode": history["mode"], "ai": history["ai"]}

