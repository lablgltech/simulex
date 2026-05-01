/**
 * Локальная копия чата с ИИ-наставником (Симуграм): переживает F5 и перезапуск in-memory бэкенда.
 * Ключ привязан к пользователю и id сессии симуляции (как stage1 chat в Stage1View).
 */

function tutorChatStorageKey(userId, sessionId) {
  if (userId == null || Number.isNaN(Number(userId))) return null;
  if (sessionId == null || String(sessionId).trim() === '') return null;
  return `simulex_tutor_msgs_v1_u${Number(userId)}_s${String(sessionId)}`;
}

/**
 * @returns {Array<{ id?: string, role: string, content: string, time?: number | null }>|null}
 */
export function readTutorChatLocal(userId, sessionId) {
  const key = tutorChatStorageKey(userId, sessionId);
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'tutor'));
  } catch {
    return null;
  }
}

export function writeTutorChatLocal(userId, sessionId, messages) {
  const key = tutorChatStorageKey(userId, sessionId);
  if (!key || typeof localStorage === 'undefined') return;
  try {
    const minimal = (messages || []).map((m) => ({
      id: m.id,
      role: m.role === 'contact' ? 'tutor' : m.role,
      content: m.content || '',
      time: m.time != null ? m.time : null,
    }));
    localStorage.setItem(key, JSON.stringify(minimal));
  } catch {
    /* quota / private mode */
  }
}

export function clearTutorChatLocal(userId, sessionId) {
  const key = tutorChatStorageKey(userId, sessionId);
  if (!key || typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
