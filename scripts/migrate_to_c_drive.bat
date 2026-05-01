@echo off
chcp 65001 >nul
set "SRC=%~dp0"
set "DST=C:\simulex"
set "SRC=%SRC:~0,-1%"

echo ========================================
echo   Копирование проекта в C:\simulex
echo ========================================
echo Источник: %SRC%
echo Назначение: %DST%
echo.

if not exist "%DST%" mkdir "%DST%"

echo Копирование файлов (без node_modules, .git, venv)...
robocopy "%SRC%" "%DST%" /E /XD node_modules .git venv __pycache__ /NFL /NDL /NJH /NJS /NC /NS
if errorlevel 8 (
  echo Ошибка копирования.
  pause
  exit /b 1
)

echo Копирование backend\.env...
if not exist "%DST%\backend" mkdir "%DST%\backend"
if exist "%SRC%\backend\.env" copy /Y "%SRC%\backend\.env" "%DST%\backend\.env" >nul

echo.
echo Готово. Проект скопирован в C:\simulex.
pause
