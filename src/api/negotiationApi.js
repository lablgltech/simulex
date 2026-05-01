import { API_URL, getAuthHeaders } from './config';
import { safeFetch, safeFetchPostOn404Fallback } from './errorHandler';

const base = () => (API_URL || '').replace(/\/$/, '');

/**
 * Валидный числовой id negotiation_session (иначе в URL попадёт «undefined» → 404 Not Found на бэкенде).
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseNegotiationSessionId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  if (s === 'undefined' || s === 'null' || s === 'NaN') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Проверка доступности бэкенда (без alert). Для этапа 3 перед инициализацией сессии.
 * @returns {Promise<boolean>} true если бэкенд отвечает
 */
export const checkBackendHealth = async () => {
  try {
    const res = await fetch(`${base()}/health`, { method: 'GET', credentials: 'include' });
    return res.ok;
  } catch {
    return false;
  }
};

// Работа с сессией переговоров (backend: /api/session/negotiation/start)
export const negotiationSessionAPI = {
  /**
   * @param {object} session — сессия Симулекса
   * @param {string} [contractCode]
   * @param {{ resetContractToInitial?: boolean }} [options] — без локального кэша negotiation_session: сбросить подстановки в договор к исходным
   */
  start: async (session, contractCode = 'dogovor_PO', options = {}) => {
    const resetContractToInitial = Boolean(options.resetContractToInitial);
    return safeFetch(`${API_URL}/session/negotiation/start`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        session,
        contract_code: contractCode,
        reset_contract_to_initial: resetContractToInitial,
      }),
    });
  },
};

// Document API (backend: /api/document/...)
export const documentAPI = {
  getClauses: async (negotiationSessionId) =>
    safeFetch(`${API_URL.replace(/\/$/, '')}/document/session/${negotiationSessionId}/clauses`, {
      headers: getAuthHeaders(),
    }),
};

// Chat API (backend: /api/chat/...)
export const chatAPI = {
  activate: async (negotiationSessionId, clauseId, action) => {
    const id = parseNegotiationSessionId(negotiationSessionId);
    if (id == null) {
      return Promise.reject(Object.assign(new Error('negotiation_session_id не задан'), { code: 'NO_SESSION' }));
    }
    return safeFetch(
      `${API_URL.replace(/\/$/, '')}/chat/session/${id}/clause/${encodeURIComponent(clauseId)}/activate`,
      {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action }),
      }
    );
  },

  sendMessage: async (negotiationSessionId, clauseId, messageData) => {
    const id = parseNegotiationSessionId(negotiationSessionId);
    if (id == null) {
      return Promise.reject(Object.assign(new Error('negotiation_session_id не задан'), { code: 'NO_SESSION' }));
    }
    return safeFetch(
      `${API_URL.replace(/\/$/, '')}/chat/session/${id}/clause/${encodeURIComponent(clauseId)}/message`,
      {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(messageData),
      }
    );
  },

  getHistory: async (negotiationSessionId) => {
    const id = parseNegotiationSessionId(negotiationSessionId);
    if (id == null) {
      return Promise.reject(Object.assign(new Error('negotiation_session_id не задан'), { code: 'NO_SESSION' }));
    }
    return safeFetch(`${API_URL.replace(/\/$/, '')}/chat/session/${id}/history`, {
      headers: getAuthHeaders(),
    });
  },

  setAiMode: async (negotiationSessionId, enabled) => {
    const id = parseNegotiationSessionId(negotiationSessionId);
    if (id == null) {
      return Promise.reject(Object.assign(new Error('negotiation_session_id не задан'), { code: 'NO_SESSION' }));
    }
    return safeFetch(`${API_URL.replace(/\/$/, '')}/chat/session/${id}/ai-mode`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ enabled }),
    });
  },

  /** Сброс подстановок в договоре и чата к исходным формулировкам (без смены флага ИИ-режима). */
  resetNegotiationProgress: async (negotiationSessionId) => {
    const id = parseNegotiationSessionId(negotiationSessionId);
    if (id == null) {
      return Promise.reject(Object.assign(new Error('negotiation_session_id не задан'), { code: 'NO_SESSION' }));
    }
    const base = API_URL.replace(/\/$/, '');
    // Два эквивалентных маршрута на бэкенде; при 404 на первом (прокси/nginx/старая сборка) пробуем второй.
    return safeFetchPostOn404Fallback(
      [
        `${base}/session/negotiation/${id}/reset-progress`,
        `${base}/chat/session/${id}/reset-progress`,
      ],
      {},
      { headers: getAuthHeaders() }
    );
  },
};

