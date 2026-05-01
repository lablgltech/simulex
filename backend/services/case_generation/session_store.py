"""In-memory хранилище сессий генерации кейса с TTL."""

from __future__ import annotations

import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

SessionStatus = Literal[
    "intake",
    "questionnaire",
    "ready_to_generate",
    "generating",
    "done",
    "failed",
    "questionnaire_stuck",
]

TTL_SECONDS = int(os.getenv("CASE_GEN_SESSION_TTL_SECONDS", str(48 * 3600)))
MAX_QUESTIONNAIRE_ROUNDS = int(os.getenv("CASE_GEN_MAX_QUESTIONNAIRE_ROUNDS", "8"))
MAX_QUESTIONS_PER_ROUND = int(os.getenv("CASE_GEN_MAX_QUESTIONS_PER_ROUND", "12"))


@dataclass
class CaseGenSession:
    session_id: str
    user_id: int
    created_at: float
    expires_at: float
    contract_template: str
    guide: str
    creator_intent: str
    template_case_id: str
    ingest_warnings: List[str] = field(default_factory=list)
    questionnaire_round: int = 0
    questions_history: List[Dict[str, Any]] = field(default_factory=list)
    current_questions: List[Dict[str, Any]] = field(default_factory=list)
    answers: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    status: SessionStatus = "questionnaire"
    questionnaire_complete: bool = False
    questionnaire_profile: Optional[Dict[str, Any]] = None
    last_error: Optional[str] = None
    options: Dict[str, Any] = field(default_factory=dict)


_lock = threading.Lock()
_sessions: Dict[str, CaseGenSession] = {}


def _now() -> float:
    return time.time()


def create_session(
    *,
    user_id: int,
    contract_template: str,
    guide: str,
    creator_intent: str,
    template_case_id: str,
    ingest_warnings: List[str],
    options: Optional[Dict[str, Any]] = None,
) -> CaseGenSession:
    sid = str(uuid.uuid4())
    t = _now()
    sess = CaseGenSession(
        session_id=sid,
        user_id=user_id,
        created_at=t,
        expires_at=t + TTL_SECONDS,
        contract_template=contract_template,
        guide=guide,
        creator_intent=creator_intent,
        template_case_id=template_case_id,
        ingest_warnings=list(ingest_warnings),
        status="questionnaire",
        options=dict(options or {}),
    )
    with _lock:
        _purge_expired_unlocked()
        _sessions[sid] = sess
    return sess


def _purge_expired_unlocked() -> None:
    t = _now()
    dead = [k for k, s in _sessions.items() if s.expires_at < t]
    for k in dead:
        del _sessions[k]


def get_session(session_id: str) -> Optional[CaseGenSession]:
    with _lock:
        _purge_expired_unlocked()
        s = _sessions.get(session_id)
        if not s:
            return None
        if s.expires_at < _now():
            del _sessions[session_id]
            return None
        return s


class SessionNotFoundError(Exception):
    pass


class SessionForbiddenError(Exception):
    pass


def require_session(session_id: str, user_id: int) -> CaseGenSession:
    s = get_session(session_id)
    if not s:
        raise SessionNotFoundError(session_id)
    if s.user_id != user_id:
        raise SessionForbiddenError(session_id)
    return s


def update_session(session_id: str, **kwargs: Any) -> None:
    with _lock:
        s = _sessions.get(session_id)
        if not s:
            return
        for k, v in kwargs.items():
            if hasattr(s, k):
                setattr(s, k, v)


def delete_session(session_id: str) -> None:
    with _lock:
        _sessions.pop(session_id, None)
