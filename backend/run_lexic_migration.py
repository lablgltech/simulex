"""
Запуск миграции для LEXIC-нормализации.

Создаёт таблицы:
  - session_lexic_stage  (снимки LEXIC по этапам)
  - report_cache         (кэш отчётов)

И добавляет колонки в game_session:
  - total_score_normalized, lexic_l_normalized, etc.

Использование:
  cd backend && python run_lexic_migration.py
"""

import os
import sys
from pathlib import Path

# Загружаем .env
_env_path = Path(__file__).resolve().parent / ".env"
if _env_path.exists():
    with _env_path.open("r", encoding="utf-8-sig") as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                _key = _k.strip()
                _val = _v.strip().strip('"').strip("'").strip()
                if _key and _val:
                    os.environ[_key] = _val

from db import get_connection

MIGRATION_FILE = Path(__file__).resolve().parent / "migrations_lexic_normalization.sql"


def run_migration():
    if not MIGRATION_FILE.exists():
        print(f"❌ Файл миграции не найден: {MIGRATION_FILE}")
        sys.exit(1)

    sql = MIGRATION_FILE.read_text(encoding="utf-8")
    statements = [s.strip() for s in sql.split(";") if s.strip() and not s.strip().startswith("--")]

    print(f"🔧 Запуск миграции LEXIC... ({len(statements)} операций)")

    import psycopg2
    dsn = os.environ.get("POSTGRES_DSN", "")
    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    for stmt in statements:
        if not stmt:
            continue
        try:
            with conn.cursor() as cur:
                cur.execute(stmt)
            conn.commit()
            print(f"  ✅ {stmt[:80].replace(chr(10), ' ')}...")
        except Exception as e:
            conn.rollback()
            err_str = str(e).lower()
            if "already exists" in err_str or "duplicate column" in err_str:
                print(f"  ⚠️  Уже существует (пропущено): {stmt[:60]}...")
            else:
                print(f"  ❌ Ошибка: {e}")

    conn.close()
    print("✅ Миграция LEXIC завершена!")


if __name__ == "__main__":
    run_migration()
