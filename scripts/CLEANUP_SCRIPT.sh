#!/bin/bash
# Скрипт для удаления неиспользуемых файлов

echo "🧹 Очистка проекта от неиспользуемых файлов..."
echo ""

# Удаление неиспользуемых компонентов frontend
echo "📦 Удаление неиспользуемых компонентов frontend..."
rm -f src/components/GameplayScreen.js
rm -f src/components/ActionPanel.js
rm -f src/components/ResourcePanel.js
rm -f src/components/ProgressBar.js
rm -f src/components/ReportScreen.js
rm -f src/components/LexicPanel.js
rm -f src/api/client.js

# Удаление дубликатов backend
echo "🔧 Удаление дубликатов backend..."
rm -f backend/utils.py

# Удаление устаревших скриптов
echo "📜 Удаление устаревших скриптов..."
rm -f deploy.sh
rm -f start.sh
rm -f start.bat
rm -f server-setup.sh

# Удаление тестового файла (опционально)
echo "🧪 Удаление тестового файла..."
rm -f test_case_loading.py

echo ""
echo "✅ Очистка завершена!"
echo ""
echo "⚠️  ВНИМАНИЕ: Директория ex/ не удалена автоматически."
echo "   Проверьте её содержимое и удалите вручную, если не нужна:"
echo "   rm -rf ex/"
