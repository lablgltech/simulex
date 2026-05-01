#!/usr/bin/env python3
"""
Скрипт для принудительной синхронизации БД с кейсами из файлов.
Используется для обновления названий кейсов и других изменений в JSON файлах.
"""
import sys
from pathlib import Path

# Добавляем путь к backend для импортов
sys.path.insert(0, str(Path(__file__).parent))

from config import DATA_DIR
from services.case_service import force_reseed_cases_from_fs

if __name__ == "__main__":
    print("🔄 Синхронизация БД с файлами кейсов...")
    print(f"📁 Директория данных: {DATA_DIR}")
    
    try:
        force_reseed_cases_from_fs(DATA_DIR)
        print("\n✅ Синхронизация завершена успешно!")
        print("💡 Обновите страницу в браузере, чтобы увидеть новые названия кейсов.")
    except Exception as e:
        print(f"\n❌ Ошибка при синхронизации: {e}")
        sys.exit(1)
