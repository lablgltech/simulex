/** Кейс «Договор — полный цикл» (`data/case.json`): дашборд по умолчанию только по нему. */
export const DEFAULT_DASHBOARD_CASE_CODE = 'case-001';

export const PARAMS = ['L', 'E', 'X', 'I', 'C'];

export const PARAM_META = {
  L: { label: 'Легитимность', icon: '⚖️', color: '#3b82f6' },
  E: { label: 'Эффективность', icon: '⚡', color: '#10b981' },
  X: { label: 'Экспертиза', icon: '🔍', color: '#f59e0b' },
  I: { label: 'Интересы', icon: '🛡️', color: '#ef4444' },
  C: { label: 'Ясность', icon: '💡', color: '#8b5cf6' },
};

export const DEFAULT_REFERENCE = { L: 75, E: 75, X: 75, I: 75, C: 75 };

/**
 * Перевод сырого балла 0–100 в шкалу 0–10 (как в отчёте участника).
 * Ниже базы (50): 0→0.5, 50→4.0 (штраф за слабый уровень).
 * Выше базы: 50→4.0, 100→10.0.
 */
export const to10Scale = (val100) => {
  const v = Math.max(0, Math.min(100, Number(val100) || 0));
  if (v <= 50) return Math.round((0.5 + (v / 50) * 3.5) * 10) / 10;
  return Math.round((4.0 + ((v - 50) / 50) * 6.0) * 10) / 10;
};

export const scoreColor10 = (val10) => {
  const t = Math.max(0, Math.min(10, val10)) / 10;
  const h = t * 120;
  const s = t < 0.4 ? 75 : 65;
  const l = 35 + t * 18;
  return `hsl(${h}, ${s}%, ${l}%)`;
};

export const getLevelColor = (value) => {
  if (value == null) return '#9ca3af';
  if (value >= 85) return '#10b981';
  if (value >= 70) return '#3b82f6';
  if (value >= 50) return '#f59e0b';
  if (value >= 30) return '#f97316';
  return '#ef4444';
};

export const NEGOTIATION_STYLE_RU = {
  collaborative: '🤝 Win-Win (совместный)',
  competitive: '⚔️ Конкурентный',
  avoidant: '🏃 Избегающий',
  mixed: '🔄 Смешанный',
  accommodating: '🤲 Уступчивый',
};

export const translateNegotiationStyle = (style) =>
  NEGOTIATION_STYLE_RU[style] || style;

export const SECTION_IDS = {
  briefing: 'section-briefing',
  competency: 'section-competency',
  team: 'section-team',
  actions: 'section-actions',
};

export const SIGNAL_RU = {
  low_score: 'Низкий балл',
  very_low_score: 'Очень низкий балл',
  stale_in_progress: 'Нет прогресса',
  high_missed_risks: 'Много пропущенных рисков',
  moderate_missed_risks: 'Умеренные пропуски рисков',
};
export const translateSignal = (s) => SIGNAL_RU[s] || s;

export const SECTIONS = [
  { id: SECTION_IDS.briefing, label: 'Брифинг' },
  { id: SECTION_IDS.competency, label: 'Компетенции' },
  { id: SECTION_IDS.team, label: 'Команда' },
  { id: SECTION_IDS.actions, label: 'Действия' },
];
