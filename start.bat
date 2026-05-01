@echo off
REM Запуск Симулекса (MVP)
REM Версия 0.1
REM Дата: 24 января 2026

echo.
echo ===================================
echo 🚀 Запуск Симулекса
echo ===================================
echo.
echo 📋 Информация о проекте:
echo   Название: Симулекс - Юридический кейс-симулятор
echo   Версия: 0.1 MVP
echo   Дата: 24 января 2026
echo.

REM Проверяем, установлены ли зависимости
if not exist "node_modules" (
  echo 📦 Установка зависимостей...
  call npm install
  if errorlevel 1 (
    echo Ошибка при установке зависимостей!
    pause
    exit /b 1
  )
)

echo.
echo 🔄 Запуск приложения...
echo.
echo 📍 Адреса:
echo   🎨 Frontend: http://localhost:3000
echo   ⚙️  Backend:  http://localhost:5000
echo.
echo 💡 Советы:
echo   - Используйте роль 'Игрок' для прохождения кейсов
echo   - Используйте роль 'Администратор' для создания/редактирования кейсов
echo   - Отслеживайте параметры LEXIC во время прохождения
echo.
echo Нажмите любую клавишу для начала...
pause >nul

call npm run dev

pause
