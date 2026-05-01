@echo off
cd /d "%~dp0"
echo Запуск backend и frontend в отдельных окнах...
start "Simulex Backend" cmd /k "cd /d "%~dp0" && cd backend && call venv\Scripts\activate && uvicorn main:app --reload --port 5000"
timeout /t 2 /nobreak >nul
start "Simulex Frontend" cmd /k "cd /d "%~dp0" && npm run client:dev"
echo.
echo Backend: http://localhost:5000   Docs: http://localhost:5000/docs
echo Frontend: http://localhost:3000
echo Оба окна можно закрыть для остановки.
pause
