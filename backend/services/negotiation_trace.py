"""Телеметрия одного хода переговоров (без внешних вызовов)."""

from __future__ import annotations

import contextvars
import logging
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator, Optional

logger = logging.getLogger(__name__)

_trace: contextvars.ContextVar[Optional["NegotiationTrace"]] = contextvars.ContextVar(
    "negotiation_trace", default=None
)


@dataclass
class NegotiationTrace:
    clause_id: str
    openai_http_calls: int = 0
    openai_http_wall_seconds: float = 0.0
    phases: list[tuple[str, float]] = field(default_factory=list)


@contextmanager
def negotiation_trace_scope(clause_id: str) -> Iterator[NegotiationTrace]:
    t = NegotiationTrace(clause_id=str(clause_id))
    token = _trace.set(t)
    try:
        yield t
    finally:
        if t.openai_http_calls:
            logger.info(
                "[NegotiationTrace] clause_id=%s http_calls=%s http_wall_s=%.3f",
                t.clause_id,
                t.openai_http_calls,
                t.openai_http_wall_seconds,
            )
        _trace.reset(token)


def note_completion_http_call() -> None:
    tr = _trace.get()
    if tr is not None:
        tr.openai_http_calls += 1


def note_http_wall_seconds(seconds: float) -> None:
    tr = _trace.get()
    if tr is not None and seconds > 0:
        tr.openai_http_wall_seconds += float(seconds)


def negotiation_trace_add_phase(name: str, seconds: float) -> None:
    tr = _trace.get()
    if tr is None or not name:
        return
    tr.phases.append((str(name), max(0.0, float(seconds))))


def get_active_negotiation_trace() -> Optional[NegotiationTrace]:
    return _trace.get()
