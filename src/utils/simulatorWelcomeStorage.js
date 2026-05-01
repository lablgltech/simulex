/** Слайд полноэкранного приветствия (SimulatorWelcomeOverlay) — sessionStorage на время вкладки. */

const PREFIX = 'simulexWelcomeOverlay:v1:';

export function getWelcomeOverlaySlideStorageKey(sessionId, caseId) {
  const sid = sessionId != null && String(sessionId).trim() !== '' ? String(sessionId) : '';
  const cid = caseId != null && String(caseId).trim() !== '' ? String(caseId) : '';
  if (!sid || !cid) return null;
  return `${PREFIX}${sid}:${cid}`;
}

export function clearWelcomeOverlaySlideStorage(sessionId, caseId) {
  const k = getWelcomeOverlaySlideStorageKey(sessionId, caseId);
  if (!k) return;
  try {
    window.sessionStorage.removeItem(k);
  } catch (_) {
    /* ignore */
  }
}

/** Слайд приветствия (mainIndex 0…2, комикс, ручной режим) — для восстановления после F5. */
export function readWelcomeOverlaySlideSnapshot(sessionId, caseId) {
  const k = getWelcomeOverlaySlideStorageKey(sessionId, caseId);
  if (!k) return null;
  try {
    const raw = window.sessionStorage.getItem(k);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o.mainIndex !== 'number' || o.mainIndex < 0 || o.mainIndex > 2) return null;
    return {
      mainIndex: o.mainIndex,
      revealedCount: typeof o.revealedCount === 'number' ? Math.max(0, Math.floor(o.revealedCount)) : 0,
      manualTakeover: !!o.manualTakeover,
      slideDir: typeof o.slideDir === 'number' && o.slideDir !== 0 ? o.slideDir : 1,
    };
  } catch {
    return null;
  }
}

export function writeWelcomeOverlaySlideSnapshot(sessionId, caseId, payload) {
  const k = getWelcomeOverlaySlideStorageKey(sessionId, caseId);
  if (!k) return;
  try {
    window.sessionStorage.setItem(k, JSON.stringify({ ...payload, savedAt: Date.now() }));
  } catch (_) {
    /* ignore */
  }
}
