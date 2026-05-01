"""
Сервис для хранения общей сессии Симулекса в PostgreSQL.

Сессия, которую сейчас создаёт backend в create_session (session_service),
остаётся JSON-структурой, но дополнительно сохраняется в таблицу game_session:
- external_id  = session["id"]  (текущий строковый ID);
- case_code    = session["case_id"];
- payload_json = полный JSON сессии.
"""

from __future__ import annotations

from typing import Any, Dict, Optional
import json

from db import get_connection


def _session_external_id_for_db(session: Dict[str, Any]) -> str:
    """Строковый id сессии для game_session.external_id (как в отчётах и stage_service)."""
    for k in ("id", "external_id", "session_id", "session_external_id"):
        v = session.get(k)
        if v is None:
            continue
        s = str(v).strip()
        if s and s.lower() != "none":
            return s
    return ""


def _session_case_code_for_db(session: Dict[str, Any]) -> str:
    """Код кейса для колонки case_code и согласованности с payload (как case_id в create_session)."""
    raw = session.get("case_id")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        raw = session.get("case_code")
    if raw is None:
        return ""
    s = str(raw).strip()
    if not s or s.lower() == "none":
        return ""
    return s


def save_game_session(session: Dict[str, Any], user_id: Optional[int] = None) -> None:
  """
  Создать или обновить запись общей сессии игрока в БД.
  Используется при старте кейса. user_id — привязка к пользователю (если авторизован).
  """
  external_id = _session_external_id_for_db(session)
  case_code = _session_case_code_for_db(session)
  if not external_id or not case_code:
    return

  payload = dict(session)
  if not str(payload.get("id") or "").strip():
    payload["id"] = external_id
  if not payload.get("case_id"):
    payload["case_id"] = case_code

  with get_connection() as conn:
    with conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO game_session (external_id, case_code, payload_json, user_id)
        VALUES (%s, %s, %s::jsonb, %s)
        ON CONFLICT (external_id) DO UPDATE SET
          case_code    = EXCLUDED.case_code,
          payload_json = EXCLUDED.payload_json,
          user_id      = COALESCE(EXCLUDED.user_id, game_session.user_id),
          updated_at   = NOW()
        """,
        (external_id, case_code, json.dumps(payload), user_id),
      )


def get_game_session(external_id: str) -> Optional[Dict[str, Any]]:
  """
  Получить сохранённую сессию по external_id (строковому ID текущей сессии).
  Пока не используется router'ами, но готово для будущих сценариев
  (загрузка/восстановление сессии).
  """
  with get_connection() as conn:
    with conn.cursor() as cur:
      cur.execute(
        """
        SELECT payload_json
        FROM game_session
        WHERE external_id = %s
        """,
        (str(external_id),),
      )
      row = cur.fetchone()

  if not row:
    return None
  return row[0] or {}


def get_game_session_for_user(external_id: str, user_id: int) -> Optional[Dict[str, Any]]:
  """
  Получить сессию по external_id только если она принадлежит пользователю user_id.
  Для личного кабинета (просмотр своих отчётов).
  """
  with get_connection() as conn:
    with conn.cursor() as cur:
      cur.execute(
        """
        SELECT payload_json, updated_at
        FROM game_session
        WHERE external_id = %s AND user_id = %s
        """,
        (str(external_id), user_id),
      )
      row = cur.fetchone()
  if not row:
    return None
  payload = row[0] or {}
  updated_at = row[1]
  if isinstance(payload, dict):
    merged = dict(payload)
    merged.setdefault("id", str(external_id))
    merged.setdefault("external_id", str(external_id))
    if updated_at is not None:
      try:
        merged["server_sync_at"] = updated_at.isoformat()
      except (AttributeError, TypeError):
        merged["server_sync_at"] = str(updated_at)
    return merged
  return payload

