#!/bin/bash
set -e

cd "$(cd "$(dirname "$0")" && pwd)"
# Используем ключ деплоя из локальной директории deploy/keys
SSH_KEY="$(pwd)/deploy/keys/simcon_deploy"
SERVER="root@80.93.62.29"

echo "🚀 Деплой Simulex на продакшен"
echo "================================"

echo ""
echo "📦 Шаг 1: Сборка фронтенда..."
npm run build

echo ""
echo "📤 Шаг 2: Загрузка фронтенда..."
rsync -avz --delete -e "ssh -i $SSH_KEY" \
  build/ $SERVER:/opt/simulex/build/

echo ""
echo "🔎 Проверка: JS-бандл на сервере не пустой (иначе белый экран)..."
MAIN_LOCAL=$(ls build/static/js/main.*.js 2>/dev/null | head -1)
if [ -z "$MAIN_LOCAL" ] || [ ! -s "$MAIN_LOCAL" ]; then
  echo "   ❌ Локально $MAIN_LOCAL отсутствует или 0 байт — деплой прерван."
  exit 1
fi
REMOTE_BYTES=$(ssh -i "$SSH_KEY" "$SERVER" 'f=$(ls /opt/simulex/build/static/js/main.*.js 2>/dev/null | head -1); test -n "$f" -a -s "$f" && wc -c < "$f" | tr -d " " || echo 0')
if [ "${REMOTE_BYTES:-0}" -lt 100000 ] 2>/dev/null; then
  echo "   ❌ На сервере main*.js слишком мал или пуст ($REMOTE_BYTES байт). Повторите rsync вручную."
  exit 1
fi
echo "   OK (на сервере ~${REMOTE_BYTES} байт)"

echo ""
echo "📤 Шаг 3: Загрузка бэкенда..."
rsync -avz --delete \
  --exclude='venv' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='*.pyo' \
  --exclude='.env' \
  -e "ssh -i $SSH_KEY" \
  backend/ $SERVER:/opt/simulex/backend/

echo ""
echo "📤 Шаг 4: Загрузка данных (кейсы и договор этапа 3)..."
# Не трогать uploads/ на сервере (QA-вложения и прочие загрузки в data/uploads — не в git)
rsync -avz --delete \
  --filter='protect uploads/' \
  -e "ssh -i $SSH_KEY" \
  data/ $SERVER:/opt/simulex/data/

echo ""
echo "📤 Шаг 5: Загрузка конфига Nginx (приложение в корне, /api)..."
rsync -avz -e "ssh -i $SSH_KEY" \
  deploy/nginx-simulex.conf $SERVER:/opt/simulex/deploy/

echo ""
echo "🔄 Шаг 6: Установка зависимостей и перезапуск сервисов..."
ssh -i $SSH_KEY $SERVER << 'ENDSSH'
echo "   Права на start_prod.sh..."
chmod +x /opt/simulex/backend/start_prod.sh
echo "   Установка зависимостей Python (pip install -r requirements.txt)..."
cd /opt/simulex/backend && ./venv/bin/pip install -r requirements.txt -q
echo "   Перезапуск бэкенда (supervisorctl restart)..."
# Важно: в start_prod.sh у gunicorn включён --preload. При preload SIGHUP НЕ подхватывает
# новый код Python с диска — мастер уже импортировал модули; только полный restart гарантирует
# актуальный tutor_service и прочие правки. См. benoitc/gunicorn#2449.
if supervisorctl restart simulex-backend 2>/dev/null; then
  echo "   supervisorctl restart simulex-backend — ок"
  sleep 2
else
  echo "   ⚠️ supervisorctl restart не удался — проверьте имя программы в supervisor"
fi
echo "   Установка конфига Nginx для simulex.lablegal.tech (корень /, API /api)..."
mkdir -p /opt/simulex/deploy
cp /opt/simulex/deploy/nginx-simulex.conf /etc/nginx/sites-available/simulex.conf
ln -sf /etc/nginx/sites-available/simulex.conf /etc/nginx/sites-enabled/simulex.conf 2>/dev/null || true
nginx -t && systemctl reload nginx || echo "   ⚠️ Ошибка Nginx (проверьте конфиг и SSL)"
ENDSSH

echo ""
echo "✅ Деплой завершен!"
echo ""
echo "🌐 Приложение: https://simulex.lablegal.tech/"
echo "🔌 API:         https://simulex.lablegal.tech/api/test"
echo ""
echo "📊 Проверка:"
echo "   curl https://simulex.lablegal.tech/api/test"
