/**
 * Вход на этап: заголовок и цвет оверлея (тип/id этапа из конфига кейса).
 */

const THEME_BY_TYPE = {
  context: {
    background: 'linear-gradient(148deg, #0d9488 0%, #0f766e 42%, #115e59 100%)',
    titleColor: '#f0fdfa',
  },
  position: {
    background: 'linear-gradient(148deg, #ea580c 0%, #c2410c 48%, #9a3412 100%)',
    titleColor: '#fff7ed',
  },
  negotiation: {
    background: 'linear-gradient(148deg, #4f46e5 0%, #4338ca 45%, #3730a3 100%)',
    titleColor: '#eef2ff',
  },
  crisis: {
    background: 'linear-gradient(148deg, #be123c 0%, #9f1239 50%, #4c0519 100%)',
    titleColor: '#fff1f2',
  },
};

const THEME_BY_STAGE_ID = {
  'stage-1': THEME_BY_TYPE.context,
  'stage-2': THEME_BY_TYPE.position,
  'stage-3': THEME_BY_TYPE.negotiation,
  'stage-4': THEME_BY_TYPE.crisis,
};

const DEFAULT_THEME = {
  background: 'linear-gradient(148deg, #334155 0%, #1e293b 55%, #0f172a 100%)',
  titleColor: '#f8fafc',
};

/**
 * @param {{ id?: string, type?: string, title?: string } | null | undefined} stage
 * @returns {{ background: string, titleColor: string }}
 */
export function getStageEnterTheme(stage) {
  if (stage?.id && THEME_BY_STAGE_ID[stage.id]) return THEME_BY_STAGE_ID[stage.id];
  if (stage?.type && THEME_BY_TYPE[stage.type]) return THEME_BY_TYPE[stage.type];
  return DEFAULT_THEME;
}

/**
 * @param {{ id?: string, type?: string, title?: string } | null | undefined} stage
 * @param {number} stageNumberOneBased порядковый номер этапа (1, 2, …)
 * @returns {{ heading: string, theme: { background: string, titleColor: string } }}
 */
/** title в кейсах часто уже вида «Этап 2: …» — не дублировать префикс в оверлее входа. */
function stageTitleAlreadyNumbered(title, n) {
  const m = String(title).trim().match(/^Этап\s*(\d+)\s*:\s*/i);
  return m != null && Number(m[1]) === n;
}

export function getStageEnterWelcomePayload(stage, stageNumberOneBased) {
  const n = typeof stageNumberOneBased === 'number' && stageNumberOneBased > 0 ? stageNumberOneBased : 1;
  const customTitle = stage?.title && String(stage.title).trim();
  const heading =
    customTitle && stageTitleAlreadyNumbered(customTitle, n)
      ? customTitle
      : customTitle
        ? `Этап ${n}: ${customTitle}`
        : `Этап ${n}`;
  return {
    heading,
    theme: getStageEnterTheme(stage),
  };
}
