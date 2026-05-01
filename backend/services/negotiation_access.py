"""
Проверка владения game_session / negotiation_session для устранения IDOR.
"""

from __future__ import annotations

from typing import Optional

from db import get_connection


def get_game_session_user_id_for_external(external_id: str) -> Optional[int]:
    """user_id в game_session по external_id, или None если записи нет."""
    eid = str(external_id or "").strip()
    if not eid:
        return None
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT user_id FROM game_session WHERE external_id = %s',
                (eid,),
            )
            row = cur.fetchone()
    if not row or row[0] is None:
        return None
    return int(row[0])


def user_owns_game_session_external(external_id: str, user_id: int) -> bool:
    """Совпадение user_id game_session с переданным."""
    got = get_game_session_user_id_for_external(external_id)
    if got is None:
        return False
    return int(got) == int(user_id)


def get_game_session_user_id_for_negotiation(negotiation_session_id: int) -> Optional[int]:
    """
    user_id владельца сессии (через game_session.external_id = stage_session.simulex_session_id),
    или None, если нет цепочки/записи.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT gs.user_id
                FROM negotiation_session ns
                JOIN stage_session ss ON ns.stage_session_id = ss.id
                LEFT JOIN game_session gs ON gs.external_id = ss.simulex_session_id
                WHERE ns.id = %s
                """,
                (int(negotiation_session_id),),
            )
            row = cur.fetchone()
    if not row:
        return None
    u = row[0]
    if u is None:
        return None
    return int(u)


def user_owns_negotiation_session(negotiation_session_id: int, user_id: int) -> bool:
    got = get_game_session_user_id_for_negotiation(negotiation_session_id)
    if got is None:
        return False
    return int(got) == int(user_id)
