"""Просмотр dev-логов этапа 3 в браузере (альтернатива терминалу Cursor).

Маршруты вешаются на app в main.py (надёжнее, чем отдельный include_router).
"""

from __future__ import annotations

from dev_mirror_log import MIRROR_PATH, get_recent_lines


def recent_logs_payload(limit: int) -> dict:
    lim = max(1, min(int(limit), 5000))
    lines = get_recent_lines(lim)
    return {
        "lines": lines,
        "count": len(lines),
        "mirror_file": str(MIRROR_PATH),
    }


_LOGS_HTML = """<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Логи Симулекс — этап 3</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 16px; background: #0f172a; color: #e2e8f0; }
    h1 { font-size: 1.1rem; margin: 0 0 8px; }
    p { color: #94a3b8; font-size: 0.9rem; margin: 0 0 12px; }
    code { background: #1e293b; padding: 2px 6px; border-radius: 4px; }
    #bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    pre { background: #020617; border: 1px solid #334155; border-radius: 8px; padding: 12px;
          overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.4;
          max-height: 80vh; overflow-y: auto; }
    .err { color: #f87171; }
    button { padding: 6px 12px; cursor: pointer; border-radius: 6px; border: 1px solid #475569;
             background: #1e293b; color: #e2e8f0; }
    label { color: #94a3b8; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Логи переговоров (этап 3) и API</h1>
  <p>Обновление каждые 2 с. Удобные адреса:<br/>
     <code>http://127.0.0.1:5000/simulex-logs</code> (напрямую бэкенд)<br/>
     <code>http://localhost:3000/simulex-logs</code> (через прокси CRA)<br/>
     <code>http://localhost:3000/api/dev/logs-view</code> (классический путь)</p>
  <p>Файл на диске: <code>backend/dev_stage3_chat_mirror.log</code> (можно открыть в редакторе).</p>
  <div id="bar">
    <button type="button" id="btn">Обновить сейчас</button>
    <label><input type="checkbox" id="auto" checked/> Авто каждые 2 с</label>
    <label><input type="checkbox" id="stick" checked/> Прокрутка вниз</label>
    <span id="status"></span>
  </div>
  <pre id="out"></pre>
  <script>
    const NL = String.fromCharCode(10);
    const out = document.getElementById('out');
    const status = document.getElementById('status');
    async function load() {
      try {
        const r = await fetch('/api/dev/recent-logs?limit=800');
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || r.status);
        out.textContent = (j.lines || []).join(NL);
        status.textContent = 'Строк: ' + j.count + ' · ' + new Date().toLocaleTimeString();
        status.className = '';
        if (document.getElementById('stick').checked)
          out.scrollTop = out.scrollHeight;
      } catch (e) {
        status.textContent = 'Ошибка: ' + e.message;
        status.className = 'err';
      }
    }
    document.getElementById('btn').onclick = load;
    load();
    setInterval(function() {
      if (document.getElementById('auto').checked) load();
    }, 2000);
  </script>
</body>
</html>
"""

# Всегда отдаём 200 (не 404), если маршрут зарегистрирован, но SIMULEX_LOG_VIEWER=0.
LOGS_VIEWER_DISABLED_HTML = """<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Логи Симулекс — отключено</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 16px; background: #0f172a; color: #e2e8f0; }
    code { background: #1e293b; padding: 2px 6px; border-radius: 4px; }
    p { color: #94a3b8; max-width: 52rem; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>Просмотр логов отключён</h1>
  <p>В <code>backend/.env</code> задано <code>SIMULEX_LOG_VIEWER=0</code> (или аналог). Чтобы снова видеть поток логов в браузере,
     удалите эту строку или поставьте <code>SIMULEX_LOG_VIEWER=1</code> и перезапустите процесс uvicorn на порту API.</p>
  <p>Логи по-прежнему можно смотреть в файле <code>backend/dev_stage3_chat_mirror.log</code> и в терминале, где запущен API.</p>
</body>
</html>
"""
