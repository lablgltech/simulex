@echo off
chcp 65001 >nul
REM Развёртывание проекта по GETTING_STARTED.md и загрузка дампа в БД
REM Запускайте из корня проекта (папка simulex).

echo.
echo ========================================
echo   Развёртывание Симулекс + загрузка дампа
echo ========================================
echo.

REM Вариант Б: без Node.js — только backend и дамп.

REM --- 1. Backend venv и pip ---
echo [1/3] Backend: venv и зависимости...
cd backend
if not exist "venv" (
  python -m venv venv
  if errorlevel 1 ( echo Ошибка: создание venv. & cd .. & exit /b 1 )
)
call venv\Scripts\activate
pip install -r requirements.txt -q
if errorlevel 1 ( echo Ошибка: pip install. & cd .. & exit /b 1 )
echo.

REM --- 3. Миграции (создание БД и схемы) ---
echo [2/3] Применение миграций PostgreSQL...
python run_migrations.py
if errorlevel 1 (
  echo Ошибка: миграции. Убедитесь, что PostgreSQL запущен и доступен.
  cd ..
  exit /b 1
)
cd ..
echo.

REM --- 3. Загрузка дампа ---
echo [3/3] Загрузка дампа в базу simulex...
set DUMPFILE=simulex-20260205-182943-local.dump
if not exist "%DUMPFILE%" (
  echo Ошибка: файл "%DUMPFILE%" не найден в текущей папке.
  exit /b 1
)

REM Требуется pg_restore (PostgreSQL в PATH). По умолчанию: localhost:5432, пользователь postgres.
REM При необходимости задайте: set PGPASSWORD=пароль
pg_restore -h localhost -p 5432 -U postgres -d simulex --clean --if-exists --no-owner --no-acl "%DUMPFILE%"
if errorlevel 1 (
  echo.
  echo Если ошибка из-за пользователя/пароля, выполните вручную:
  echo   set PGPASSWORD=ваш_пароль
  echo   pg_restore -h localhost -p 5432 -U postgres -d simulex --clean --if-exists --no-owner --no-acl "%DUMPFILE%"
  echo Или укажите своего пользователя: pg_restore -h localhost -p 5432 -U ВАШ_ПОЛЬЗОВАТЕЛЬ -d simulex ...
  exit /b 1
)

echo.
echo ========================================
echo   Готово. Запуск: start.bat или см. п.5 GETTING_STARTED.md
echo ========================================
pause
