# -*- coding: utf-8 -*-
"""
Вариант Б: venv, pip, миграции, загрузка дампа. Без Node.js.
Запуск из корня проекта: python setup_and_restore.py
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).resolve().parent
BACKEND = PROJECT_ROOT / "backend"
VENV = BACKEND / "venv"
DUMP_NAME = "simulex-20260205-182943-local.dump"


def _load_backend_env():
    """Подгрузить backend/.env в os.environ (для миграций и pg_restore)."""
    env_file = BACKEND / ".env"
    if not env_file.exists():
        return
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


def start_postgres_windows():
    """Запуск службы PostgreSQL на Windows и проверка статуса."""
    # типичные имена службы
    names = ["postgresql-x64-18", "postgresql-x64-17", "postgresql-x64-16", "postgresql-x64-15", "PostgreSQL"]
    for name in names:
        p = subprocess.run(
            ["net", "start", name],
            capture_output=True,
            text=True,
            timeout=30,
        )
        # 0 = запущено, 2 = уже запущена
        if p.returncode in (0, 2):
            print(f"  Служба PostgreSQL ({name}): запущена или уже работает.")
            return True
    return False


def check_postgres_running():
    """Проверка: слушает ли что-то порт 5432 (упрощённо — попытка подключения через venv)."""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(("127.0.0.1", 5432))
        s.close()
        return True
    except Exception:
        return False


def run(cmd, cwd=None, env=None):
    cwd = cwd or PROJECT_ROOT
    e = os.environ.copy()
    if env:
        e.update(env)
    p = subprocess.run(cmd, cwd=cwd, env=e, shell=False)
    if p.returncode != 0:
        print(f"Ошибка: команда завершилась с кодом {p.returncode}", file=sys.stderr)
        sys.exit(p.returncode)


def main():
    _load_backend_env()
    print("[1/5] Создание venv в backend...")
    if not VENV.exists():
        run([sys.executable, "-m", "venv", str(VENV)])
    else:
        print("  venv уже есть.")

    venv_python = VENV / "Scripts" / "python.exe"
    if not venv_python.exists():
        venv_python = VENV / "bin" / "python"
    if not venv_python.exists():
        print("Ошибка: не найден python в venv", file=sys.stderr)
        sys.exit(1)

    print("[2/5] Установка зависимостей backend...")
    run([str(venv_python), "-m", "pip", "install", "-r", str(BACKEND / "requirements.txt"), "-q"])

    print("[3/5] PostgreSQL: запуск и проверка...")
    if sys.platform == "win32":
        if not check_postgres_running():
            print("  PostgreSQL не отвечает на порту 5432, пробуем запустить службу...")
            start_postgres_windows()
            time.sleep(3)
        if check_postgres_running():
            print("  Статус: порт 5432 доступен.")
        else:
            print("  Предупреждение: порт 5432 недоступен. Миграции могут упасть.")
    else:
        if not check_postgres_running():
            print("  Предупреждение: порт 5432 недоступен. Запустите PostgreSQL (например: sudo systemctl start postgresql).")

    print("[4/5] Применение миграций...")
    p = subprocess.run(
        [str(venv_python), "run_migrations.py"],
        cwd=BACKEND,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
    )
    if p.returncode != 0:
        print(p.stdout or "", file=sys.stderr)
        print(p.stderr or "", file=sys.stderr)
        if "Connection refused" in (p.stderr or "") or "10061" in (p.stderr or ""):
            print("\nПодключение к PostgreSQL не удалось. Запустите сервер БД (служба PostgreSQL или pg_ctl), затем снова выполните: python setup_and_restore.py", file=sys.stderr)
        sys.exit(p.returncode)

    dump_path = PROJECT_ROOT / DUMP_NAME
    if not dump_path.exists():
        print(f"Ошибка: файл дампа не найден: {dump_path}", file=sys.stderr)
        sys.exit(1)

    print("[5/5] Загрузка дампа в БД simulex...")
    pg_restore = shutil.which("pg_restore") or shutil.which("pg_restore.exe")
    if not pg_restore and sys.platform == "win32":
        pf = os.environ.get("ProgramFiles", "C:\\Program Files")
        for ver in ("18", "17", "16", "15", "14", "13"):
            exe = Path(pf) / "PostgreSQL" / ver / "bin" / "pg_restore.exe"
            if exe.exists():
                pg_restore = str(exe)
                break
        if not pg_restore and Path(pf, "PostgreSQL").exists():
            for sub in Path(pf, "PostgreSQL").iterdir():
                if sub.is_dir():
                    exe = sub / "bin" / "pg_restore.exe"
                    if exe.exists():
                        pg_restore = str(exe)
                        break
    if not pg_restore:
        pg_restore = "pg_restore"

    # Проверка: найден ли pg_restore (иначе subprocess выдаст FileNotFoundError)
    if pg_restore == "pg_restore" and sys.platform == "win32":
        exe_in_path = shutil.which("pg_restore") or shutil.which("pg_restore.exe")
        if not exe_in_path:
            print("Ошибка: pg_restore не найден. Добавьте в PATH папку bin PostgreSQL, например:", file=sys.stderr)
            print('  set "PATH=%PATH%;C:\\Program Files\\PostgreSQL\\18\\bin"', file=sys.stderr)
            print("затем снова запустите: python setup_and_restore.py", file=sys.stderr)
            sys.exit(1)

    # Учётные данные для pg_restore: из POSTGRES_DSN или PGUSER/PGPASSWORD
    env = os.environ.copy()
    dsn = os.environ.get("POSTGRES_DSN")
    if dsn:
        u = urlparse(dsn)
        # извлечь user:password из netloc (postgres:pass@localhost:5432)
        if u.netloc and "@" in u.netloc:
            auth, _ = u.netloc.rsplit("@", 1)
            if ":" in auth:
                user, password = auth.split(":", 1)
                env.setdefault("PGUSER", user)
                env.setdefault("PGPASSWORD", password)
    if "PGPASSWORD" not in env:
        env["PGPASSWORD"] = os.environ.get("PGPASSWORD", "")

    cmd = [
        pg_restore,
        "-h", "localhost",
        "-p", "5432",
        "-U", env.get("PGUSER", "postgres"),
        "-d", "simulex",
        "--clean", "--if-exists", "--no-owner", "--no-acl",
        str(dump_path),
    ]

    p = subprocess.run(cmd, cwd=PROJECT_ROOT, env=env)
    if p.returncode != 0:
        print("Если ошибка из-за пользователя/пароля, задайте: set PGPASSWORD=пароль", file=sys.stderr)
        print("Или укажите пользователя: set PGUSER=ваш_пользователь", file=sys.stderr)
        sys.exit(p.returncode)

    print("Готово. Backend: cd backend && venv\\Scripts\\activate && uvicorn main:app --reload --port 5000")


if __name__ == "__main__":
    main()
