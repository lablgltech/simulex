#!/usr/bin/env bash
# Запуск FastAPI под Supervisor через gunicorn + uvicorn-воркеры.
# Gunicorn поддерживает graceful reload (SIGHUP): новые воркеры
# поднимаются до остановки старых — нет зазора при деплое.
# --preload: один раз импортирует main до fork; иначе RESEED_CASES_ON_STARTUP на старте
# выполняется в каждом воркере параллельно и может повесить PostgreSQL.
# После деплоя кода нужен полный restart gunicorn (не SIGHUP): иначе мастер держит старые модули в памяти.
set -e
cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
exec ./venv/bin/gunicorn main:app \
  --worker-class uvicorn.workers.UvicornWorker \
  --workers "${WORKERS:-2}" \
  --preload \
  --bind "0.0.0.0:${PORT:-5000}" \
  --graceful-timeout 30 \
  --timeout 900 \
  --access-logfile - \
  --error-logfile -
