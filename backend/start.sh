#!/bin/bash
# Скрипт для запуска Python бекенда

cd "$(dirname "$0")"

# Проверка виртуального окружения
if [ ! -d "venv" ]; then
    echo "📦 Создание виртуального окружения..."
    python3 -m venv venv
fi

# Активация виртуального окружения
source venv/bin/activate

# Установка зависимостей
if [ ! -f "venv/.installed" ]; then
    echo "📥 Установка зависимостей..."
    pip install -r requirements.txt
    touch venv/.installed
fi

# Запуск сервера
echo "🚀 Запуск бекенда..."
uvicorn main:app --reload --port 5000
