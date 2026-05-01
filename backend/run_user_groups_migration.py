"""
Миграция групп пользователей (user_group, user.group_id).

  cd backend && python run_user_groups_migration.py

Нужен POSTGRES_DSN в окружении или в backend/.env
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

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
                    os.environ.setdefault(_key, _val)

MIGRATION_FILE = Path(__file__).resolve().parent / "migrations_user_groups.sql"


def _statements(sql: str) -> list[str]:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    text = "\n".join(lines)
    out: list[str] = []
    for part in text.split(";"):
        s = part.strip()
        if s:
            out.append(s)
    return out


def main() -> None:
    if not MIGRATION_FILE.exists():
        print(f"Файл не найден: {MIGRATION_FILE}", file=sys.stderr)
        sys.exit(1)

    if not os.environ.get("POSTGRES_DSN", "").strip():
        print("Задайте POSTGRES_DSN в backend/.env или в окружении.", file=sys.stderr)
        sys.exit(1)

    from db import get_connection

    sql = MIGRATION_FILE.read_text(encoding="utf-8")
    stmts = _statements(sql)
    print(f"Миграция групп: {len(stmts)} операций")

    with get_connection() as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            for i, stmt in enumerate(stmts, 1):
                try:
                    cur.execute(stmt)
                    preview = stmt.replace("\n", " ")[:72]
                    print(f"  [{i}/{len(stmts)}] OK {preview}...")
                except Exception as e:
                    err = str(e).lower()
                    if "already exists" in err or "duplicate column" in err or "duplicate key" in err:
                        print(f"  [{i}/{len(stmts)}] пропуск (уже есть): {e}")
                    else:
                        print(f"  [{i}/{len(stmts)}] ошибка: {e}", file=sys.stderr)
                        sys.exit(1)

    print("Готово.")


if __name__ == "__main__":
    main()
