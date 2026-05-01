"""Генерация кейсов: анкета → LangGraph."""

from __future__ import annotations

from typing import Any, Tuple

__all__ = ("start_case_gen_session", "submit_case_gen_answers", "run_case_gen_generation")


def __getattr__(name: str) -> Any:
    if name == "start_case_gen_session":
        from services.case_generation.facade import start_case_gen_session

        return start_case_gen_session
    if name == "submit_case_gen_answers":
        from services.case_generation.facade import submit_case_gen_answers

        return submit_case_gen_answers
    if name == "run_case_gen_generation":
        from services.case_generation.facade import run_case_gen_generation

        return run_case_gen_generation
    raise AttributeError(name)


def __dir__() -> Tuple[str, ...]:
    return __all__
