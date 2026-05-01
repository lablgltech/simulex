/** Совпадает с группой в ответе build_case_dependency_report для этапа */
export function stageDependencyGroup(stage) {
  if (!stage || typeof stage !== 'object') return '';
  const sid = String(stage.id || '').trim();
  const title = String(stage.title || sid).trim();
  return `Этап: ${title}`;
}
