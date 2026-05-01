@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запуск frontend (React), порт 3000...
echo Откройте: http://localhost:3000
echo.
if not exist "node_modules" (
  echo Установка зависимостей npm...
  call npm install
)
call npm run client:dev
pause
