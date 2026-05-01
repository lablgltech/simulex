@echo off
chcp 65001 >nul
echo Установка PostgreSQL через winget...
echo.
winget install PostgreSQL.PostgreSQL --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo.
  echo Если winget не сработал, установите вручную:
  echo 1. Откройте https://www.postgresql.org/download/windows/
  echo 2. Скачайте установщик с EDB и запустите.
  echo 3. При установке запомните пароль пользователя postgres и порт 5432.
  echo 4. Добавьте папку bin в PATH: C:\Program Files\PostgreSQL\16\bin
  pause
  exit /b 1
)
echo.
echo Установка завершена. Перезапустите cmd и запустите службу PostgreSQL:
echo   services.msc - найти PostgreSQL - Запустить
echo Или перезагрузите компьютер, служба часто стартует автоматически.
pause
