const { createProxyMiddleware } = require('http-proxy-middleware');

/**
 * Прокси для разработки: фронт :3000 (PORT в .env.development) → /api на бекенд :5000.
 * Target по умолчанию http://127.0.0.1:5000 (не localhost — на macOS ::1 может уйти в AirPlay).
 * Переопределение: BACKEND_DEV_URL в .env.development.
 */
module.exports = function (app) {
  const raw = process.env.BACKEND_DEV_URL || 'http://127.0.0.1:5000';
  const target = String(raw).replace(/\/$/, '');
  const opts = { target, changeOrigin: true };

  app.use('/api', createProxyMiddleware(opts));
  // Короткий путь к HTML-логам (не под /api) — см. main.py GET /simulex-logs
  app.use('/simulex-logs', createProxyMiddleware(opts));
};
