/**
 * Доступ к встроенному QA-трекеру. Должно совпадать с
 * backend/services/qa_bug_service.py → QA_TRACKER_GROUP_NAME
 */
export const QA_TRACKER_GROUP_NAME = 'ЛабЛигалТех';

function _normGroupName(s) {
  const t = String(s || '').trim();
  try {
    return t.normalize('NFC');
  } catch {
    return t;
  }
}

export function userHasQaTrackerAccess(user) {
  if (!user) return false;
  return _normGroupName(user.group_name) === _normGroupName(QA_TRACKER_GROUP_NAME);
}

/** Статус и заметка по замечанию QA: группа «ЛабЛигалТех» или admin/superuser (как backend update_bug_admin). */
export function userCanEditQaBugStatus(user) {
  if (!user) return false;
  const r = String(user.role || '').toLowerCase();
  if (r === 'admin' || r === 'superuser') return true;
  return userHasQaTrackerAccess(user);
}

/** Кнопка «Сброс этапа» в симуляторе: группа «ЛабЛигалТех» или роли superuser / admin (как на бэкенде). */
export function userCanRestartSimulatorStage(user) {
  if (!user) return false;
  const r = String(user.role || '').toLowerCase();
  if (r === 'superuser' || r === 'admin') return true;
  return userHasQaTrackerAccess(user);
}

/** Маппинг моста этап 3→4 в отчёте: админы / суперюзер или группа «ЛабЛигалТех» (как на бэкенде). */
export function userCanViewStage4BridgeTab(user) {
  if (!user) return false;
  const r = String(user.role || '').toLowerCase();
  if (r === 'admin' || r === 'superuser') return true;
  return userHasQaTrackerAccess(user);
}
