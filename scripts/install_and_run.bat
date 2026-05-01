@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   Установка и запуск Симулекс
echo ========================================
echo.

if not exist "backend\.env" (
  echo Создайте backend\.env с строкой:
  echo   POSTGRES_DSN=postgresql://postgres:ВАШ_ПАРОЛЬ@localhost:5432/simulex
  echo затем снова запустите этот файл.
  pause
  exit /b 1
)

echo [1/3] Проверка окружения (venv, зависимости, миграции, дамп)...
python setup_and_restore.py
if errorlevel 1 (
  echo Ошибка установки. Исправьте и запустите снова.
  pause
  exit /b 1
)
echo.

echo [2/3] Зависимости frontend (npm)...
if not exist "node_modules" (
  call npm install
  if errorlevel 1 (
    echo Ошибка npm install. Установите Node.js с https://nodejs.org/
    pause
    exit /b 1
  )
) else (
  echo node_modules уже есть.
)
echo.

echo [3/3] Запуск backend и frontend...
start "Simulex Backend" cmd /k "cd /d "%~dp0" && cd backend && call venv\Scripts\activate && uvicorn main:app --reload --port 5000"
timeout /t 3 /nobreak >nul
start "Simulex Frontend" cmd /k "cd /d "%~dp0" && npm run client:dev"

echo.
echo Backend:  http://localhost:5000   Docs: http://localhost:5000/docs
echo Frontend: http://localhost:3000
echo.
echo Закройте окна Backend и Frontend для остановки.
pause
