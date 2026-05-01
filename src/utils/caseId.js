/**
 * Канонический код кейса (зеркало backend/services/case_id.py canonical_case_code).
 * Внешний контракт API: ровно один префикс case-.
 */
const DEFAULT_CASE_CODE = 'case-001';

/**
 * @param {string|null|undefined} raw
 * @returns {string}
 */
export function canonicalCaseCode(raw) {
  if (raw == null) return DEFAULT_CASE_CODE;
  let s = String(raw).trim();
  if (!s) return DEFAULT_CASE_CODE;
  while (s.startsWith('case-')) {
    s = s.slice(5).trimStart();
  }
  if (!s) return DEFAULT_CASE_CODE;
  if (s === '001') return DEFAULT_CASE_CODE;
  return `case-${s}`;
}
