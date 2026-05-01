from __future__ import annotations

"""
Вспомогательные функции для логирования контекста сессии (Этап 2).

Слой поверх PostgreSQL, который:
- пишет ключевые действия сессии в session_action_log;
- пишет диалог тьютора в tutor_message_log.
"""

from typing import Any, Dict, List, Optional, Tuple
import json

from db import get_connection
from services.ai_chat_service import call_openai
from services.ai_model_config import get_model_for_consumer
from services.ai_payload import MINIMAL_SYSTEM_MESSAGE


def _load_game_session_payload_json(session_external_id: str) -> Dict[str, Any]:
    """Сырой payload_json игровой сессии (для транскрипта этапа 1 и т.п.)."""
    if not session_external_id:
        return {}
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT payload_json FROM game_session WHERE external_id = %s",
                    (str(session_external_id),),
                )
                row = cur.fetchone()
        if not row or row[0] is None:
            return {}
        raw = row[0]
        if isinstance(raw, str):
            return json.loads(raw)
        if isinstance(raw, dict):
            return dict(raw)
        return {}
    except Exception:
        return {}


def _stage1_brief_insights_plain_text(payload: Dict[str, Any], max_chars: int = 3200) -> str:
    """Тексты заметок по блокам брифа из stage1_result (клиент хранит списки строк)."""
    sr = (payload or {}).get("stage1_result") or {}
    iba = sr.get("insights_by_attribute") or {}
    if not isinstance(iba, dict) or not iba:
        return ""
    lines: List[str] = []
    for aid, vals in iba.items():
        if not isinstance(vals, list) or not vals:
            continue
        texts: List[str] = []
        for x in vals[:10]:
            if isinstance(x, str) and x.strip():
                texts.append(x.strip()[:500])
            elif isinstance(x, dict):
                t = str(x.get("text") or "").strip()
                if t:
                    texts.append(t[:500])
        if texts:
            lines.append(f"Блок {aid}: " + " | ".join(texts))
    s = "\n".join(lines)
    return s[:max_chars] if len(s) > max_chars else s


def _stage1_transcript_lines(payload: Dict[str, Any], max_turns: int = 28) -> List[str]:
    sr = (payload or {}).get("stage1_result") or {}
    tr = sr.get("initiator_chat_transcript")
    if not isinstance(tr, list) or not tr:
        return []
    lines: List[str] = []
    for i, turn in enumerate(tr[-max_turns:]):
        if not isinstance(turn, dict):
            continue
        q = str(turn.get("question") or turn.get("q") or "").strip()
        a = str(turn.get("bot_response") or turn.get("a") or "").strip()
        qual = turn.get("quality") or ""
        hint = turn.get("quality_hint") or ""
        attr = turn.get("attribute_id") or ""
        head = f"  [{i + 1}]"
        if qual or hint:
            head += f" качество={qual}" + (f", hint={hint}" if hint else "")
        if attr:
            head += f", атрибут={attr}"
        if q:
            lines.append(f"{head}\n  Вопрос игрока: {q[:900]}")
        if a:
            lines.append(f"  Ответ инициатора: {a[:1100]}")
    return lines


def _stage3_negotiation_lines(
    session_external_id: str,
    *,
    max_clauses: int = 14,
    max_messages_per_clause: int = 18,
) -> List[str]:
    from services.negotiation_session_service import (
        get_negotiation_history,
        get_negotiation_session_by_simulex_session,
    )

    neg_id, _ = get_negotiation_session_by_simulex_session(str(session_external_id))
    if not neg_id:
        return []
    try:
        hist = get_negotiation_history(int(neg_id))
    except Exception:
        return []
    by_clause = hist.get("chat_history_by_clause") or {}
    if not by_clause:
        return []
    lines: List[str] = []
    keys = sorted(by_clause.keys(), key=lambda k: str(k))[:max_clauses]
    for cid in keys:
        msgs = by_clause.get(cid) or []
        if not msgs:
            continue
        lines.append(f"--- Пункт договора {cid} ---")
        slice_ = msgs[-max_messages_per_clause:]
        for m in slice_:
            if not isinstance(m, dict):
                continue
            owner = (m.get("owner") or "").lower()
            text = str(m.get("text") or "").strip()
            if not text:
                continue
            role = "Игрок" if owner == "player" else "Контрагент"
            lines.append(f"  {role}: {text[:750]}")
    return lines


def log_session_action(
    session_external_id: Optional[str],
    *,
    case_code: Optional[str],
    stage_code: Optional[str],
    action_type: str,
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Записать логическое действие в рамках сессии.

    Не бросает исключения наружу (ошибки БД логируются, но не ломают игровой поток).
    """
    if not session_external_id:
        return

    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO session_action_log (
                      session_external_id,
                      case_code,
                      stage_code,
                      action_type,
                      payload_json
                    )
                    VALUES (%s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        str(session_external_id),
                        case_code,
                        stage_code,
                        action_type,
                        json.dumps(payload or {}),
                    ),
                )
    except Exception as e:
        print(f"WARNING session_context.log_session_action({action_type!r}, {stage_code!r}): {e}")
        return


def log_tutor_message(
    session_external_id: Optional[str],
    *,
    role: str,
    content: str,
) -> None:
    """
    Записать сообщение тьютора/игрока в лог.
    """
    if not content:
        return

    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO tutor_message_log (
                      session_external_id,
                      role,
                      content
                    )
                    VALUES (%s, %s, %s)
                    """,
                    (
                        str(session_external_id) if session_external_id is not None else None,
                        role,
                        content,
                    ),
                )
    except Exception:
        return


def update_session_summary_and_profile(
    session_external_id: str,
    *,
    case_code: Optional[str] = None,
    max_actions: int = 30,
    max_messages: int = 20,
) -> None:
    """
    Обновить текстовое summary сессии и soft-skills профиль на основе последних действий и диалога.

    Учитывает также:
    - транскрипт чата с инициатором на этапе 1 (stage1_result.initiator_chat_transcript в payload);
    - переписку по пунктам договора на этапе 3 (negotiation_session.history_json).
    """
    if not session_external_id:
        return

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT action_type, payload_json, created_at, stage_code
                FROM session_action_log
                WHERE session_external_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (session_external_id, max_actions),
            )
            actions_rows = cur.fetchall()

            cur.execute(
                """
                SELECT role, content, created_at
                FROM tutor_message_log
                WHERE session_external_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (session_external_id, max_messages),
            )
            messages_rows = cur.fetchall()

    payload_session = _load_game_session_payload_json(session_external_id)
    s1_lines = _stage1_transcript_lines(payload_session)
    s3_lines = _stage3_negotiation_lines(session_external_id)

    if not actions_rows and not messages_rows and not s1_lines and not s3_lines:
        return

    actions_repr = []
    for action_type, payload_json, created_at, stage_code in reversed(actions_rows):
        stage_str = f"[{stage_code}]" if stage_code else ""
        actions_repr.append(
            f"- {created_at.isoformat()} {stage_str} {action_type}: {json.dumps(payload_json or {}, ensure_ascii=False)[:300]}"
        )

    messages_repr = []
    for role, content, created_at in reversed(messages_rows):
        messages_repr.append(
            f"- {created_at.isoformat()} {role}: {str(content)[:400]}"
        )

    system_prompt = MINIMAL_SYSTEM_MESSAGE

    parts = [
        f"Сессия: {session_external_id}, кейс: {case_code or 'unknown'}\n",
        "Последние действия:\n" + ("\n".join(actions_repr) if actions_repr else "(нет)"),
        "\nФрагменты диалога с наставником:\n" + ("\n".join(messages_repr) if messages_repr else "(нет)"),
    ]
    if s1_lines:
        parts.append("\nЭтап 1 — диалог с инициатором (вопросы и ответы):\n" + "\n".join(s1_lines))
    else:
        parts.append("\nЭтап 1 — транскрипт чата с инициатором: (нет в сохранённой сессии)")
    s1_brief = _stage1_brief_insights_plain_text(payload_session)
    if s1_brief.strip():
        parts.append(
            "\nЭтап 1 — заметки участника в блоках брифа (как сохранено в сессии; оцени содержательность):\n"
            + s1_brief
        )
    if s3_lines:
        parts.append("\nЭтап 3 — переговоры по договору (реплики по пунктам):\n" + "\n".join(s3_lines))
    else:
        parts.append("\nЭтап 3 — переписка по пунктам: (нет или сессия переговоров не создана)")

    user_content = "\n".join(parts)
    if len(user_content) > 28000:
        user_content = user_content[:28000] + "\n...[фрагмент обрезан по лимиту]"

    payload = {
        "model": get_model_for_consumer("report"),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
        "max_tokens": 1100,
    }

    try:
        raw = call_openai(payload)
        parsed = json.loads(raw)
    except Exception:
        return

    summary_text = str(parsed.get("summary_text") or "").strip()
    soft_skills = parsed.get("soft_skills") or {}

    with get_connection() as conn:
        with conn.cursor() as cur:
            if summary_text:
                cur.execute(
                    """
                    INSERT INTO session_summary (session_external_id, summary_text, updated_at)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (session_external_id) DO UPDATE SET
                      summary_text = EXCLUDED.summary_text,
                      updated_at   = NOW()
                    """,
                    (session_external_id, summary_text),
                )

            if soft_skills:
                cur.execute(
                    """
                    INSERT INTO session_soft_skills (session_external_id, profile_json, updated_at)
                    VALUES (%s, %s::jsonb, NOW())
                    ON CONFLICT (session_external_id) DO UPDATE SET
                      profile_json = EXCLUDED.profile_json,
                      updated_at   = NOW()
                    """,
                    (session_external_id, json.dumps(soft_skills, ensure_ascii=False)),
                )


def get_session_summary_and_profile(
    session_external_id: str,
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    Получить последнее summary и профиль soft-skills для сессии.
    """
    if not session_external_id:
        return None, None

    summary_text: Optional[str] = None
    profile: Optional[Dict[str, Any]] = None

    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT summary_text
                    FROM session_summary
                    WHERE session_external_id = %s
                    """,
                    (session_external_id,),
                )
                row = cur.fetchone()
                if row:
                    summary_text = row[0]

                cur.execute(
                    """
                    SELECT profile_json
                    FROM session_soft_skills
                    WHERE session_external_id = %s
                    """,
                    (session_external_id,),
                )
                row = cur.fetchone()
                if row and row[0]:
                    profile = row[0]
    except Exception:
        return None, None

    return summary_text, profile
