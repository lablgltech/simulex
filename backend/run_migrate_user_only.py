#!/usr/bin/env python3
"""Применить только миграцию user + user_id в game_session (без pgvector)."""
import os
import sys
from pathlib import Path

# Load .env
env_path = Path(__file__).resolve().parent / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip().strip('"').strip("'")

dsn = os.environ.get("POSTGRES_DSN")
if not dsn:
    print("POSTGRES_DSN not set", file=sys.stderr)
    sys.exit(1)

import psycopg2

sql_path = Path(__file__).resolve().parent / "migrate_user_only.sql"
conn = psycopg2.connect(dsn)
conn.autocommit = True
cur = conn.cursor()
cur.execute(sql_path.read_text(encoding="utf-8"))
cur.close()
conn.close()
print("Migration OK")
