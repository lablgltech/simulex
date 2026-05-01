#!/usr/bin/env python3
"""
Создать первого суперпользователя (или нового). Запуск из каталога backend:

    python create_superuser.py
    python create_superuser.py --username admin --password secret --role superuser

По умолчанию: username=super, password=super, role=superuser.
Таблица "user" должна существовать (миграции применены).
"""
import argparse
import os
import sys
from pathlib import Path

# Загрузка .env до импорта сервисов
_env = Path(__file__).resolve().parent / ".env"
if _env.exists():
    with _env.open("r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

from services.auth_service import create_user, get_user_by_username, update_user_password


def main():
    parser = argparse.ArgumentParser(description="Создать суперпользователя или пользователя")
    parser.add_argument("--username", default="super", help="Логин")
    parser.add_argument("--password", default="super", help="Пароль")
    parser.add_argument("--role", default="superuser", choices=["superuser", "admin", "user"])
    parser.add_argument("--email", default="", help="Email (опционально)")
    parser.add_argument("--reset-password", action="store_true", help="Сбросить пароль существующему пользователю")
    args = parser.parse_args()

    existing = get_user_by_username(args.username.strip().lower())
    if existing:
        if args.reset_password:
            try:
                update_user_password(args.username, args.password)
                print(f"Пароль для пользователя '{args.username}' обновлён.")
                return
            except Exception as e:
                print(f"Ошибка: {e}", file=sys.stderr)
                sys.exit(1)
        print(f"Пользователь '{args.username}' уже существует. Используйте --reset-password, чтобы сбросить пароль.", file=sys.stderr)
        sys.exit(1)
    try:
        u = create_user(
            username=args.username,
            password=args.password,
            role=args.role,
            email=args.email or None,
        )
        print(f"Создан: id={u['id']}, username={u['username']}, role={u['role']}")
    except Exception as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
