#!/bin/bash
# Аварийное восстановление Simulex на VPS (simulex.lablegal.tech).
# Когда SSH/HTTPS «висят», зайти: панель хостера → VNC/serial → root → выполнить этот файл
# (скопировать с GitHub raw или с локального клона: scripts/vps-emergency-recover-simulex.sh).
#
set -euo pipefail

echo "=== Simulex: память и нагрузка ==="
uptime
free -h || true
swapon --show 2>/dev/null || true
echo ""

echo "=== Backend (supervisor) ==="
supervisorctl status simulex-backend 2>/dev/null || echo "supervisorctl недоступен"
supervisorctl restart simulex-backend 2>/dev/null || true
sleep 2
supervisorctl status simulex-backend 2>/dev/null || true
echo ""

echo "=== Проверка API на localhost:5001 ==="
curl -sS -o /tmp/simulex_api_test.txt -w "HTTP %{http_code}\n" --connect-timeout 5 --max-time 15 http://127.0.0.1:5001/api/test || echo "curl backend failed"
head -c 200 /tmp/simulex_api_test.txt 2>/dev/null || true
echo ""
echo ""

echo "=== Nginx ==="
nginx -t 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
systemctl is-active nginx 2>/dev/null || true
echo ""

echo "=== Проверка через nginx (локально) ==="
curl -sS -o /dev/null -w "HTTP %{http_code}\n" --connect-timeout 5 --max-time 15 -H "Host: simulex.lablegal.tech" http://127.0.0.1/api/test 2>/dev/null || echo "curl nginx failed"
echo ""
echo "Готово. Если swap 100% — добавьте RAM или временно увеличьте swap; при зависании: reboot."
