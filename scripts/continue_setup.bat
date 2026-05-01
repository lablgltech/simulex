@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Продолжение установки: миграции + загрузка дампа (PostgreSQL должен быть запущен).
echo.

set VENV_PY=backend\venv\Scripts\python.exe
if not exist "%VENV_PY%" (
  echo Ошибка: не найден backend\venv. Сначала выполните: python setup_and_restore.py
  pause
  exit /b 1
)

echo [1/2] Применение миграций...
"%VENV_PY%" backend\run_migrations.py
if errorlevel 1 (
  echo Ошибка миграций. Проверьте, что PostgreSQL запущен на порту 5432.
  pause
  exit /b 1
)
echo Миграции применены.
echo.

echo [2/2] Загрузка дампа simulex-20260205-182943-local.dump...
set DUMP=simulex-20260205-182943-local.dump
if not exist "%DUMP%" (
  echo Ошибка: файл %DUMP% не найден.
  pause
  exit /b 1
)

pg_restore -h localhost -p 5432 -U postgres -d simulex --clean --if-exists --no-owner --no-acl "%DUMP%"
if errorlevel 1 (
  echo Если ошибка из-за пароля, выполните: set PGPASSWORD=ваш_пароль
  echo Затем снова запустите этот файл.
  pause
  exit /b 1
)

echo.
echo Готово. Запуск backend:
echo   cd backend
echo   venv\Scripts\activate
echo   uvicorn main:app --reload --port 5000
pause
