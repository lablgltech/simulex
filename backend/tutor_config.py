"""
Настройки ИИ-тьютора (Сергей Палыч).

Значения по умолчанию можно переопределить переменными окружения (в т.ч. в backend/.env).
Префикс переменных: TUTOR_*.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from services.ai_model_config import DEFAULT_PROJECT_LLM_MODEL


def _env_int(key: str, default: int) -> int:
    val = os.getenv(key)
    if val is None:
        return default
    try:
        return int(val)
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    val = os.getenv(key)
    if val is None:
        return default
    try:
        return float(val)
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    val = (os.getenv(key) or "").strip().lower()
    if val in ("1", "true", "yes"):
        return True
    if val in ("0", "false", "no"):
        return False
    return default


@dataclass(frozen=True)
class TutorConfig:
    """Сводные настройки тьютора."""
    # Модель и параметры основного чата
    model: str
    temperature: float
    max_tokens: int
    # Окно истории: сколько сообщений хранить в памяти и сколько передавать в API
    max_history_messages: int
    history_window: int
    # Параметры для спорадических ответов на события (on_event)
    event_temperature: float
    event_max_tokens: int
    # Минимальный интервал между спонтанными репликами по одной сессии (сек); 0 = без паузы
    event_cooldown_seconds: int

    @classmethod
    def from_env(cls) -> TutorConfig:
        return cls(
            model=os.getenv("TUTOR_MODEL")
            or os.getenv("OPENAI_MODEL", DEFAULT_PROJECT_LLM_MODEL),
            temperature=_env_float("TUTOR_TEMPERATURE", 0.7),
            max_tokens=_env_int("TUTOR_MAX_TOKENS", 500),
            max_history_messages=_env_int("TUTOR_MAX_HISTORY_MESSAGES", 50),
            history_window=_env_int("TUTOR_HISTORY_WINDOW", 20),
            event_temperature=_env_float("TUTOR_EVENT_TEMPERATURE", 0.6),
            event_max_tokens=_env_int("TUTOR_EVENT_MAX_TOKENS", 150),
            event_cooldown_seconds=_env_int("TUTOR_EVENT_COOLDOWN_SECONDS", 90),
        )


# Единственный экземпляр, загружается при первом импорте
tutor_config: TutorConfig = TutorConfig.from_env()
