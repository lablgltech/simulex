#!/usr/bin/env python3
"""
Одной командой: создать БД, применить схему и заполнить кейсы из файлов.

Запуск из каталога backend (после настройки backend/.env):

    python init_db.py

Делает то же, что run_migrations.py + первый запуск backend по части данных:
- создаёт БД simulex, если её нет;
- применяет backend/migrations.sql;
- синхронизирует таблицы case и contract с data/case*.json и ресурсами кейсов.

После этого можно запускать backend (uvicorn) и frontend — кейсы уже в БД.

Если в `backend/.env` задано `RESEED_CASES_ON_STARTUP=0`, повторная полная синхронизация при **каждом** старте API не выполняется — используйте этот скрипт или админку после смены файлов кейсов.
"""

from pathlib import Path

# Гарантируем, что скрипт вызывают из backend
if Path(__file__).resolve().parent != Path.cwd():
    import sys
    print("Запускайте из каталога backend: cd backend && python init_db.py", file=sys.stderr)
    sys.exit(1)

from run_migrations import apply_migrations
from config import DATA_DIR
from services.case_service import force_reseed_cases_from_fs


def main() -> None:
    print("Шаг 1/2: применение миграций (схема БД)...")
    apply_migrations()
    print("Шаг 2/2: синхронизация кейсов и договоров из файлов...")
    force_reseed_cases_from_fs(DATA_DIR)
    print("Готово. БД simulex готова к работе. Запустите backend и frontend.")


if __name__ == "__main__":
    main()
