"""
Простой скрипт для применения SQL-миграций к PostgreSQL без psql.

Запускается один раз в dev-окружении:

    python3 run_migrations.py

Использует тот же DSN, что и backend (см. db.get_dsn / POSTGRES_DSN).
Применяет `migrations.sql` и остальные файлы из `MIGRATION_SQL_FILES` (см. константу в этом модуле).
При необходимости задайте пароль: set POSTGRES_DSN=postgresql://postgres:пароль@localhost:5432/simulex
"""

from pathlib import Path
import sys
from urllib.parse import urlparse, urlunparse

import psycopg2
from psycopg2 import errorcodes

from db import get_dsn

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def _safe_stmt_preview(stmt: str, n: int = 88) -> str:
    return stmt[:n].replace("\u2011", "-").encode("ascii", errors="replace").decode("ascii")


def _skip_failed_statement(stmt: str, exc: BaseException) -> bool:
    """
    Если pgvector не установлен в PostgreSQL, часть migrations.sql недоступна.
    Пропускаем только связанные с vector/ivfflat операторы и зависящие от них объекты,
    чтобы остальная схема (в т.ч. user, game_session) создалась.
    """
    s = stmt.strip().lower()
    msg = str(exc).lower()
    if "vector(" in s or "using ivfflat" in s or "vector_cosine_ops" in s:
        return True
    if "create extension" in s and "vector" in s:
        return True
    if getattr(exc, "pgcode", None) == errorcodes.FEATURE_NOT_SUPPORTED:
        return True
    if "vector" in msg or "ivfflat" in msg:
        return True
    if "rag_document_chunk" in msg and ("does not exist" in msg or "не существует" in msg):
        return True
    if getattr(exc, "pgcode", None) == errorcodes.UNDEFINED_TABLE:
        if "rag_document_chunk" in s or "rag_document_chunk" in msg:
            return True
        if "rag_chunk_entity" in s or "rag_session_chunk_history" in s:
            return True
    return False


def ensure_database_exists(db_name: str = "simulex") -> None:
    """
    Создать БД, если её ещё нет.

    Подключаемся к служебной БД postgres с теми же учётными данными, что и POSTGRES_DSN.
    """
    dsn = get_dsn()
    parsed = urlparse(dsn)
    # подключаемся к БД postgres для создания simulex
    admin_dsn = urlunparse((parsed.scheme, parsed.netloc, "/postgres", parsed.params, parsed.query, parsed.fragment))
    conn = psycopg2.connect(admin_dsn)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
            exists = cur.fetchone() is not None
            if not exists:
                cur.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        conn.close()


# Порядок важен: сначала базовая схема, затем дополнительные таблицы.
MIGRATION_SQL_FILES = (
    "migrations.sql",
    "migrations_ai_global_lessons.sql",
    "migrations_admin_autoplay_job.sql",
    "migrations_case_content_json.sql",
    "migrations_session_summary_fallback.sql",
    "migrations_lexic_normalization.sql",
)


def _apply_sql_file(conn: psycopg2.extensions.connection, sql_path: Path) -> None:
    sql = sql_path.read_text(encoding="utf-8")
    statements = [s.strip() for s in sql.split(";") if s.strip()]
    for stmt in statements:
        try:
            with conn.cursor() as cur:
                cur.execute(stmt + ";")
            conn.commit()
        except psycopg2.Error as exc:
            conn.rollback()
            if _skip_failed_statement(stmt, exc):
                print(f"[migrations] skip (pgvector/missing dep): {_safe_stmt_preview(stmt)}...")
                continue
            if getattr(exc, "pgcode", None) == errorcodes.UNDEFINED_COLUMN and "group_id" in str(exc).lower():
                _patch_user_group_id_column(conn)
                try:
                    with conn.cursor() as cur:
                        cur.execute(stmt + ";")
                    conn.commit()
                    continue
                except psycopg2.Error as exc2:
                    conn.rollback()
                    raise exc2 from exc
            raise


def _patch_user_group_id_column(conn: psycopg2.extensions.connection) -> None:
    """Старые БД после частичных миграций: таблица user без group_id."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS group_id INTEGER '
                "REFERENCES user_group(id) ON DELETE SET NULL;"
            )
            cur.execute('CREATE INDEX IF NOT EXISTS idx_user_group_id ON "user"(group_id);')
        conn.commit()
    except psycopg2.Error:
        conn.rollback()


def apply_migrations() -> None:
    ensure_database_exists("simulex")

    base = Path(__file__).parent
    dsn = get_dsn()
    conn = psycopg2.connect(dsn)
    try:
        for name in MIGRATION_SQL_FILES:
            path = base / name
            if not path.is_file():
                raise FileNotFoundError(f"Файл миграции не найден: {path}")
            _apply_sql_file(conn, path)
        _patch_user_group_id_column(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    apply_migrations()
    print("Миграции успешно применены к базе данных.")

