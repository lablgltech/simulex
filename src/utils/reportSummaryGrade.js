/**
 * Словесная шкала итога отчёта.
 * Пороги по RAW 0–100 (внутренний балл), но label'ы отражают реальную 10-балльную шкалу
 * после нелинейной нормализации (baseline 50 → 4.0).
 *
 * Соответствие 10-балльной шкалы:
 *   0–1.9  → raw  0–20  → «Неудовлетворительно»
 *   2.0–3.4 → raw 21–42  → «Ниже ожиданий»
 *   3.5–4.9 → raw 43–54  → «Посредственно»
 *   5.0–6.4 → raw 55–69  → «Удовлетворительно»
 *   6.5–7.9 → raw 70–82  → «Хорошо»
 *   8.0–9.2 → raw 83–93  → «Отлично»
 *   9.3–10  → raw 94–100 → «Безупречно»
 */

export const SUMMARY_GRADE_TIERS = [
  {
    max: 20,
    key: 'fail',
    label: 'Неудовлетворительно',
    pillBg: '#3f0f12',
    pillFg: '#fecdd3',
    pillBorder: '#881337',
    accent: '#881337',
    bar: '#9f1239',
  },
  {
    max: 42,
    key: 'below_expectations',
    label: 'Ниже ожиданий',
    pillBg: '#7f1d1d',
    pillFg: '#fecaca',
    pillBorder: '#991b1b',
    accent: '#991b1b',
    bar: '#b91c1c',
  },
  {
    max: 54,
    key: 'mediocre',
    label: 'Посредственно',
    pillBg: '#7c2d12',
    pillFg: '#ffedd5',
    pillBorder: '#c2410c',
    accent: '#c2410c',
    bar: '#ea580c',
  },
  {
    max: 69,
    key: 'satisfactory',
    label: 'Удовлетворительно',
    pillBg: '#78350f',
    pillFg: '#fef3c7',
    pillBorder: '#b45309',
    accent: '#a16207',
    bar: '#ca8a04',
  },
  {
    max: 82,
    key: 'good',
    label: 'Хорошо',
    pillBg: '#365314',
    pillFg: '#ecfccb',
    pillBorder: '#4d7c0f',
    accent: '#3f6212',
    bar: '#65a30d',
  },
  {
    max: 93,
    key: 'excellent',
    label: 'Отлично',
    pillBg: '#115e59',
    pillFg: '#ccfbf1',
    pillBorder: '#0f766e',
    accent: '#0f766e',
    bar: '#14b8a6',
  },
  {
    max: 100,
    key: 'flawless',
    label: 'Безупречно',
    pillBg: '#134e4a',
    pillFg: '#ccfbf1',
    pillBorder: '#0d9488',
    accent: '#0e7490',
    bar: '#2dd4bf',
  },
];

/**
 * @param {number} rawScore
 * @returns {typeof SUMMARY_GRADE_TIERS[0] & { score: number }}
 */
export function getSummaryGrade(rawScore) {
  const score = Math.max(0, Math.min(100, Math.round(Number(rawScore) || 0)));
  for (const tier of SUMMARY_GRADE_TIERS) {
    if (score <= tier.max) {
      return { ...tier, score };
    }
  }
  const last = SUMMARY_GRADE_TIERS[SUMMARY_GRADE_TIERS.length - 1];
  return { ...last, score };
}
