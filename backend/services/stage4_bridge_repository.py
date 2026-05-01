"""Чтение/запись game_session_stage4_bridge."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from psycopg2.extras import Json

from db import get_connection


def fetch_stage4_bridge(game_session_external_id: str, case_code: str) -> Optional[Dict[str, Any]]:
    eid = str(game_session_external_id or "").strip()
    cc = str(case_code or "").strip()
    if not eid or not cc:
        return None
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT original_text_by_clause_id, contract_selections, selection_source,
                       option_texts_snapshot, updated_at
                FROM game_session_stage4_bridge
                WHERE game_session_external_id = %s AND case_code = %s
                """,
                (eid, cc),
            )
            row = cur.fetchone()
    if not row:
        return None
    return {
        "original_text_by_clause_id": row[0] if isinstance(row[0], dict) else (row[0] or {}),
        "contract_selections": row[1] if isinstance(row[1], dict) else (row[1] or {}),
        "selection_source": row[2] if isinstance(row[2], dict) else (row[2] or {}),
        "option_texts_snapshot": row[3] if isinstance(row[3], dict) else row[3],
        "updated_at": row[4].isoformat() if row[4] else None,
    }


def upsert_stage4_bridge(
    game_session_external_id: str,
    case_code: str,
    original_text_by_clause_id: Dict[str, str],
    contract_selections: Dict[str, str],
    selection_source: Dict[str, Any],
    option_texts_snapshot: Optional[Dict[str, Any]] = None,
) -> None:
    eid = str(game_session_external_id or "").strip()
    cc = str(case_code or "").strip()
    if not eid or not cc:
        return
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO game_session_stage4_bridge (
                  game_session_external_id, case_code,
                  original_text_by_clause_id, contract_selections, selection_source,
                  option_texts_snapshot, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (game_session_external_id, case_code) DO UPDATE SET
                  original_text_by_clause_id = EXCLUDED.original_text_by_clause_id,
                  contract_selections = EXCLUDED.contract_selections,
                  selection_source = EXCLUDED.selection_source,
                  option_texts_snapshot = EXCLUDED.option_texts_snapshot,
                  updated_at = NOW()
                """,
                (
                    eid,
                    cc,
                    Json(original_text_by_clause_id),
                    Json(contract_selections),
                    Json(selection_source),
                    Json(option_texts_snapshot) if option_texts_snapshot is not None else None,
                ),
            )
        conn.commit()
