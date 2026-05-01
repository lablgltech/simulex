#!/usr/bin/env python3
"""
Выгрузка замечаний QA с областью «Обучение / тур» (как на проде).

Запуск из корня репозитория (нужен backend/.env с POSTGRES_DSN или аналогом):

  cd backend && python3 ../scripts/export_qa_tour_bugs.py
  python3 scripts/export_qa_tour_bugs.py   # если PYTHONPATH=backend

Скриншоты: имена в attachments_json лежат в data/uploads/qa/ на сервере/локально.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Репозиторий: .../simulex-1
REPO = Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from db import get_connection  # noqa: E402

AREA = "обучение_тур"

SQL = """
SELECT id, area, finding_type, severity, status, title, steps,
       COALESCE(attachments_json::text, '[]'), attachment_url, environment, case_code,
       created_at, updated_at
FROM qa_bug_report
WHERE area = %s
ORDER BY created_at DESC
"""

COLS = [
    "id",
    "area",
    "finding_type",
    "severity",
    "status",
    "title",
    "steps",
    "attachments_json",
    "attachment_url",
    "environment",
    "case_code",
    "created_at",
    "updated_at",
]


def main() -> int:
    rows_out = []
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(SQL, (AREA,))
                rows = cur.fetchall()
    except Exception as e:
        print(json.dumps({"error": str(e), "hint": "Проверьте backend/.env и миграции qa_bug_report"}, ensure_ascii=False))
        return 1

    for r in rows:
        rows_out.append(dict(zip(COLS, r)))

    print(json.dumps({"area": AREA, "count": len(rows_out), "bugs": rows_out}, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
