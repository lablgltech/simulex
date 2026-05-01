"""
Простой слой подключения к PostgreSQL для Симулекса.

Используется всеми модулями, которые работают с БД:
- кейсы и этапы (case, case_stage, case_stage_action),
- договоры переговоров (contract),
- сессии этапов и переговоров (stage_session, negotiation_session),
- логи событий.

Подключение настраивается через переменную окружения POSTGRES_DSN, например:
  export POSTGRES_DSN="postgresql://user:password@localhost:5432/simulex"
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import psycopg2

# Гарантируем загрузку .env до первого обращения к БД
import config  # noqa: F401

_DEFAULT_DSN = "postgresql://localhost:5432/simulex"


def _read_dsn_from_env_file() -> str | None:
  """Читаем POSTGRES_DSN из backend/.env (приоритет над окружением)."""
  for env_path in (
    Path(__file__).resolve().parent / ".env",
    Path(__file__).resolve().parent.parent / "backend" / ".env",
  ):
    try:
      if not env_path.exists():
        continue
      with env_path.open("r", encoding="utf-8-sig") as f:
        for line in f:
          line = line.strip()
          if not line or line.startswith("#") or "=" not in line:
            continue
          key, value = line.split("=", 1)
          key = key.strip().lstrip("\ufeff")
          if key == "POSTGRES_DSN":
            val = value.strip().strip('"').strip("'").strip()
            if val:
              return val
    except OSError:
      continue
  return None


def get_dsn() -> str:
  """
  Получить DSN для подключения к PostgreSQL.
  Сначала читаем backend/.env, затем POSTGRES_DSN из окружения, иначе дефолт.
  """
  from_file = _read_dsn_from_env_file()
  if from_file:
    return from_file
  return os.getenv("POSTGRES_DSN") or _DEFAULT_DSN


@contextmanager
def get_connection() -> Iterator[psycopg2.extensions.connection]:
  """
  Синхронное подключение к PostgreSQL.

  Используем контекстный менеджер:
      with get_connection() as conn:
          with conn.cursor() as cur:
              cur.execute(...)

  Автоматически делает commit, если не было исключения, и rollback при ошибках.
  """
  conn = psycopg2.connect(get_dsn())
  try:
    yield conn
    conn.commit()
  except Exception:
    conn.rollback()
    raise
  finally:
    conn.close()


def ensure_extensions() -> None:
  """
  Хук для создания необходимых расширений/настроек в БД (например, uuid-ossp).
  Может вызываться из отдельного скрипта миграций.
  """
  with get_connection() as conn:
    with conn.cursor() as cur:
      cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
      # Расширение pgvector для работы с эмбеддингами (RAG)
      try:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
      except Exception:
        # На некоторых окружениях расширение может быть не установлено;
        # в этом случае миграции должны либо установить его вручную,
        # либо RAG‑функциональность будет недоступна.
        pass

