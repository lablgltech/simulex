/**
 * Черновики UI этапов 1–4 в localStorage (один формат ключа, одна логика).
 * Ключ: `simulex_s{этап}_draft_v1_{sessionId}` — payload с `version: 1` внутри JSON.
 */

const MAX_BYTES = 3_500_000;

export function stageDraftStorageKey(sessionId, stageNum) {
  if (sessionId == null || String(sessionId).trim() === '') return null;
  const n = Number(stageNum);
  if (n !== 1 && n !== 2 && n !== 3 && n !== 4) return null;
  return `simulex_s${n}_draft_v1_${String(sessionId)}`;
}

export function readStageDraft(sessionId, stageNum) {
  const key = stageDraftStorageKey(sessionId, stageNum);
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || data.version !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeStageDraft(sessionId, stageNum, payload) {
  const key = stageDraftStorageKey(sessionId, stageNum);
  if (!key || typeof localStorage === 'undefined') return;
  try {
    const s = JSON.stringify(payload);
    if (s.length > MAX_BYTES) return;
    localStorage.setItem(key, s);
  } catch {
    /* quota */
  }
}

export function clearStageDraft(sessionId, stageNum) {
  const key = stageDraftStorageKey(sessionId, stageNum);
  if (!key || typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Выход из кейса / сброс сессии — убрать все черновики этапов для этой игровой сессии. */
export function clearAllStageDraftsForSession(sessionId) {
  clearStageDraft(sessionId, 1);
  clearStageDraft(sessionId, 2);
  clearStageDraft(sessionId, 3);
  clearStageDraft(sessionId, 4);
}
