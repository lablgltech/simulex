@echo off
chcp 65001 >nul
cd /d "%~dp0backend"
echo Starting Simulex backend on http://127.0.0.1:5000
echo Do not close this window while using the app.
echo.
python -m uvicorn main:app --reload --port 5000
pause
