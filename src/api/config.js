/**
 * Централизованная конфигурация API
 * Используется во всех компонентах для определения базового URL API
 *
 * Продакшен: https://simulex.lablegal.tech/ — фронт и API в корне (API: /api).
 */

/** Куда в dev уходит прокси CRA (`package.json` → `proxy`, `src/setupProxy.js`). Для текстов ошибок в UI. */
export const LOCAL_DEV_BACKEND_ORIGIN = 'http://127.0.0.1:5000';

export const getApiUrl = () => {
  // Если установлена переменная окружения — используем её
  if (process.env.REACT_APP_API_URL) {
    let u = String(process.env.REACT_APP_API_URL).trim().replace(/\/$/, '');
    // Частая ошибка: http://localhost:5000 без /api — тогда запросы идут на /session/... и FastAPI отвечает 404
    if (/^https?:\/\//i.test(u) && !/\/api(?:\/|$)/i.test(u)) {
      u = `${u}/api`;
    }
    return u;
  }

  const host = window.location.hostname;

  // Локальная разработка: запросы идут на тот же origin (localhost:3000), прокси перенаправляет на бекенд :5000
  if (host === 'localhost' || host === '127.0.0.1') {
    return '/api';
  }

  // Продакшен: приложение на https://simulex.lablegal.tech/, API по /api
  if (host === 'simulex.lablegal.tech') {
    return '/api';
  }

  return '/api';
};

/** Базовый URL сервера (без /api), для картинок и статики: например http://localhost:5000 или '' на проде */
export const getApiBaseUrl = () => {
  const api = getApiUrl();
  return api.replace(/\/api\/?$/, '');
};

export const API_URL = getApiUrl();

/** Заголовки с JWT для авторизованных запросов */
export const getAuthHeaders = () => {
  const headers = { 'Content-Type': 'application/json' };
  const token = typeof localStorage !== 'undefined' && localStorage.getItem('simulex_auth_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};

// Для админки: базовый URL (например http://localhost:5000/api/admin) и заголовки (опционально X-Admin-Key из .env)
export const getAdminApiUrl = () => {
  return getApiUrl() + '/admin';
};

export const ADMIN_API_URL = getAdminApiUrl();

export const getAdminHeaders = () => {
  const headers = { 'Content-Type': 'application/json' };
  const token = typeof localStorage !== 'undefined' && localStorage.getItem('simulex_auth_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};
