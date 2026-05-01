@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запуск backend (FastAPI), порт 5000...
echo API: http://localhost:5000   Docs: http://localhost:5000/docs
echo.
cd backend
call venv\Scripts\activate
uvicorn main:app --reload --port 5000
pause
