/**
 * API ИИ-тьютора (Сергей Павлович): чат, история, события.
 */

import { API_URL, getAuthHeaders } from './config';
import { safeFetch } from './errorHandler';

const base = (API_URL || '').replace(/\/$/, '');

export const tutorAPI = {
  chat: async ({ message, sessionId, caseId, currentStage }) =>
    safeFetch(`${base}/tutor/chat`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        message,
        session_id: sessionId ?? null,
        case_id: caseId ?? null,
        current_stage: currentStage ?? null,
      }),
    }),

  getHistory: async (sessionId) => {
    const q = sessionId != null ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    return safeFetch(`${base}/tutor/history${q}`, { headers: getAuthHeaders() });
  },

  event: async ({ eventType, payload, sessionId, caseId, currentStage }) =>
    safeFetch(`${base}/tutor/event`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        event_type: eventType,
        payload: payload || {},
        session_id: sessionId ?? null,
        case_id: caseId ?? null,
        current_stage: currentStage ?? null,
      }),
    }),
};
