/**
 * Централизованная обработка ошибок API
 */

import { LOCAL_DEV_BACKEND_ORIGIN } from './config';

/**
 * Обрабатывает ошибку API и возвращает сообщение
 * @param {Error|Object} error - Объект ошибки
 * @param {boolean} showAlert - Показывать ли alert (по умолчанию true)
 * @returns {string} Сообщение об ошибке
 */
/** Сообщение при недоступности сервера (Failed to fetch / connection refused) */
const NETWORK_ERROR_HINT = `Не удалось подключиться к серверу. Из корня репозитория: npm run backend:dev (API ${LOCAL_DEV_BACKEND_ORIGIN}) и npm run dev или npm start для фронта (localhost:3000). Затем нажмите «Повторить».`;

function isNetworkError(error) {
  const msg = (error?.message || '').toLowerCase();
  return (
    msg === 'failed to fetch' ||
    msg.includes('networkerror') ||
    msg.includes('load failed') ||
    msg.includes('connection refused') ||
    (error?.name === 'TypeError' && msg.includes('fetch'))
  );
}

export const handleApiError = (error, showAlert = true) => {
  let message = 'Произошла ошибка';

  if (isNetworkError(error)) {
    message = NETWORK_ERROR_HINT;
  } else if (error?.detail) {
    message = typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail);
  } else if (error?.error) {
    message = error.error;
  } else if (error?.message) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }

  console.error('API Error:', error);

  if (showAlert) {
    alert('❌ ' + message);
  }

  return message;
};

/**
 * Обрабатывает ответ от API
 * @param {Response} response - Response объект от fetch
 * @returns {Promise<Object>} Распарсенный JSON или ошибка
 */
export const handleApiResponse = async (response) => {
  if (!response.ok) {
    let errorData;
    try {
      const body = await response.json();
      errorData = {
        error: `HTTP ${response.status}: ${response.statusText}`,
        ...body,
        detail: body.detail ?? body.error ?? `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (e) {
      errorData = { error: `HTTP ${response.status}: ${response.statusText}`, detail: `HTTP ${response.status}: ${response.statusText}` };
    }
    throw errorData;
  }
  return await response.json();
};

/**
 * Безопасный fetch с обработкой ошибок
 * @param {string} url - URL для запроса
 * @param {Object} options - Опции для fetch
 * @returns {Promise<Object>} Результат запроса
 */
/** Текст для сетевой ошибки (доступен для использования в UI) */
export const getNetworkErrorHint = () => NETWORK_ERROR_HINT;

export const safeFetch = async (url, options = {}) => {
  try {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    return await handleApiResponse(response);
  } catch (error) {
    if (isNetworkError(error)) {
      const hint = getNetworkErrorHint();
      handleApiError({ ...error, message: hint });
      throw { ...error, message: hint, _networkError: true };
    }
    handleApiError(error);
    throw error;
  }
};

/**
 * POST с перебором URL: при 404 пробует следующий путь (разные прокси/версии бэкенда).
 * @param {string[]} urls
 * @param {Object|string} body
 * @param {{ headers?: Record<string, string> }} [opts] — например { headers: getAuthHeaders() }
 */
export const safeFetchPostOn404Fallback = async (urls, body = {}, opts = {}) => {
  const extraHeaders = opts.headers && typeof opts.headers === 'object' ? opts.headers : {};
  try {
    let lastResponse = null;
    const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    for (const url of urls) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: payload,
      });
      lastResponse = response;
      if (response.status === 404) {
        continue;
      }
      return await handleApiResponse(response);
    }
    if (lastResponse) {
      return await handleApiResponse(lastResponse);
    }
    throw { detail: 'Нет доступных адресов API', error: 'NO_URLS' };
  } catch (error) {
    if (isNetworkError(error)) {
      const hint = getNetworkErrorHint();
      handleApiError({ ...error, message: hint });
      throw { ...error, message: hint, _networkError: true };
    }
    handleApiError(error);
    throw error;
  }
};
