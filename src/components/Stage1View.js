import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { createPortal } from 'react-dom';
import MarkdownContent from './MarkdownContent';
import { stage1InsightAPI, stage1QuestionAPI } from '../api/stage1Api';
import { readStageDraft, writeStageDraft } from '../utils/stageDraftStorage';

/** Аватар руководителя проекта (Михаил) в чате этапа 1 / Симуграм PM. */
const AVATAR_MIKHAIL_URL = `${process.env.PUBLIC_URL || ''}/images/avatar-mikhail.png`;
const DOC_TYPES = { simple: 'Простой', medium: 'Средний', complex: 'Сложный' };

/* Максимальная длина текста заметки при выделении из документа (символов) */
const INSIGHT_MAX_LENGTH = 500;

/** Максимум проверок качества заметки (ИИ) на одну заметку */
const MAX_INSIGHT_EVAL_ATTEMPTS = 3;

/** После стольки мс ожидания ответа чата показываем «долго думает / кофе» вместо «печатает». */
const STAGE1_CHAT_TYPING_SLOW_MS = 6000;

const STAGE1_CHAT_SLOW_TYPING_MESSAGES = [
  'Руководитель проекта на минуту отошёл за кофе…',
  'Секунду, руководитель проекта перехватил кофе у кулера…',
  'Руководитель проекта наливает чай и скоро вернётся…',
  'Руководитель проекта ушёл за водой — ответ чуть задерживается…',
  'Чуть дольше обычного: руководитель проекта как раз у кофемашины…',
  'Руководитель проекта отлучился на пару минут — обычно это кофе или вода…',
  'Руководитель проекта пока добивает капучино…',
  'Небольшая задержка — руководитель проекта не теряет время и топает за эспрессо…',
  'Руководитель проекта на секунду отвлёкся — скоро снова в чате…',
];

function pickStage1SlowTypingMessage() {
  return STAGE1_CHAT_SLOW_TYPING_MESSAGES[
    Math.floor(Math.random() * STAGE1_CHAT_SLOW_TYPING_MESSAGES.length)
  ];
}

/** Карточка заметки на доске: padding справа под кнопку × */
const INSIGHT_BOARD_CARD_PADDING_RIGHT = 32;
const INSIGHT_NOTE_REMOVE_BTN_RIGHT = 8;
/** Тень как у заметок на доске (карточка с рамкой) */
const BOARD_NOTE_BOX_SHADOW = '0 2px 6px rgba(0,0,0,0.1)';

/** Колонка «•» в брифе: та же ширина + gap, что у строк заметок — кнопка «+» и подсказка drop выровнены с текстом списка */
const BRIEF_NOTE_MARKER_COL_MIN_WIDTH = 12;
const BRIEF_NOTE_MARKER_GAP = 8;

/** Блоки брифа: минималистичное выделение (этап 1), без полноширинных «волосатых» линий */
const BRIEF_BLOCK = {
  headingColor: '#1e293b',
  accentLine: {
    height: 2,
    width: 'min(140px, 40%)',
    maxWidth: 220,
    background: 'linear-gradient(90deg, rgba(30,41,59,0.9) 0%, rgba(30,41,59,0.28) 55%, rgba(30,41,59,0) 100%)',
    borderRadius: 999,
    marginTop: 8,
  },
  card: {
    padding: '14px 16px 16px',
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
  },
  cardConclusion: {
    padding: '14px 16px 16px',
    background: '#ffffff',
    border: '2px solid #10b981',
    borderRadius: 10,
    boxShadow: '0 2px 8px rgba(16, 185, 129, 0.12)',
  },
};

/** Сколько записей истории чата хранить в localStorage (в API по-прежнему slice(-8)) */
const STAGE1_MAX_CHAT_HISTORY = 30;

/** Псевдо-документ «Бриф» в блоке документов (не из API кейса) */
const STAGE1_BRIEF_DOC_ID = 'simulex:stage1:brief';

/** Разделитель и отступ над кнопкой «Отправить бриф» — тем же числом задаётся padding-top основной колонки этапа */
const STAGE1_COMPLETE_BTN_BORDER_PX = 1;
const STAGE1_COMPLETE_BTN_PADDING_TOP_PX = 12;
const STAGE1_DOC_TO_COMPLETE_BTN_GAP =
  STAGE1_COMPLETE_BTN_BORDER_PX + STAGE1_COMPLETE_BTN_PADDING_TOP_PX;

/** Запас снизу у внутренней обёртки: box-shadow карточек (~8px blur) иначе режется родителем с overflow: hidden */
const STAGE1_CARD_SHADOW_BOTTOM_PAD_PX = 8;

/**
 * Совпадает с padding-bottom внутренней обёртки сетки этапа 1.
 * Низ колонки атрибутов (тянется на обе строки сетки) совпадает с низом контента минус эта величина.
 */
export const STAGE1_SIMUGRAM_COLUMN_BOTTOM_PAD_PX = 16 + STAGE1_CARD_SHADOW_BOTTOM_PAD_PX;

/**
 * Раньше использовался для padding-bottom колонки Симуграм в GameView (выровнять по низу карточки без строки кнопки).
 * Оставлен для совместимости импортов; для выравнивания с зелёной кнопкой «Отправить бриф» нужен только
 * {@link STAGE1_SIMUGRAM_COLUMN_BOTTOM_PAD_PX}.
 */
export const STAGE1_SIMUGRAM_COLUMN_BOTTOM_PAD_DOC_PANEL_PX =
  STAGE1_SIMUGRAM_COLUMN_BOTTOM_PAD_PX +
  STAGE1_DOC_TO_COMPLETE_BTN_GAP +
  STAGE1_COMPLETE_BTN_BORDER_PX +
  10 +
  10 +
  21;

/** Первое сообщение от руководителя проекта (Симуграм), если история чата пуста */
const STAGE1_PM_OPENING_MESSAGE =
  'Привет! Я готов ответить на любые вопросы по проекту и при необходимости прислать недостающие документы.';

/** Единое положение крестика закрытия документа/брифа относительно белого фрейма панели документов */
const STAGE1_DOC_CLOSE_TOP_PX = 16;
const STAGE1_DOC_CLOSE_RIGHT_PX = 20;
const STAGE1_DOC_CLOSE_SIZE_PX = 28;
/** Заголовок не под крестик (flex + абсолютная кнопка) */
const STAGE1_DOC_TITLE_PAD_RIGHT_FOR_CLOSE_PX = STAGE1_DOC_CLOSE_SIZE_PX + 12;

function isBriefDocId(id) {
  return id === STAGE1_BRIEF_DOC_ID;
}

/** Текст для нативного `title` (системный тултип браузера) у кнопок перехода к целевому документу */
function stage1DocNavTargetTitle(doc) {
  if (!doc) return '';
  if (isBriefDocId(doc.id)) return 'Перейти к брифу';
  const t = doc.title ? String(doc.title) : 'Документ';
  return `Перейти к «${t}»`;
}

const STAGE1_DOC_GRID_HINT_BRIEF = 'Посмотри, что нужно собрать в брифе';
const STAGE1_DOC_GRID_HINT_MATERIAL = 'Найди здесь то, что тебе понадобится для брифа';
const STAGE1_DOC_GRID_ARROW_COLOR = '#9F9696';
const STAGE1_DOC_GRID_ARROW_GAP_PX = 8;
const STAGE1_DOC_GRID_ARROW_HEAD_INSET_PX = 10;

/** Пустой экран документов: подсказка сверху с внешней стороны, прямая пунктирная серая стрелка к верхнему углу иконки с зазором */
function Stage1DocGridItem({ doc, onOpen, showHints = true }) {
  const wrapRef = useRef(null);
  const iconRef = useRef(null);
  const textRef = useRef(null);
  const [geom, setGeom] = useState({ w: 200, h: 1, d: '' });
  const isBrief = isBriefDocId(doc.id);
  const hintText = isBrief ? STAGE1_DOC_GRID_HINT_BRIEF : STAGE1_DOC_GRID_HINT_MATERIAL;
  const safeId = `cap_${String(doc.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const recompute = useCallback(() => {
    const wrap = wrapRef.current;
    const icon = iconRef.current;
    const txt = textRef.current;
    if (!wrap || !icon) return;
    const wr = wrap.getBoundingClientRect();
    const w = Math.max(1, wr.width);
    const h = Math.max(1, wr.height);
    if (!showHints || !txt) {
      setGeom({ w, h, d: '' });
      return;
    }
    const ir = icon.getBoundingClientRect();
    const tr = txt.getBoundingClientRect();
    const g = STAGE1_DOC_GRID_ARROW_GAP_PX;
    let ex;
    let ey = ir.top - wr.top + 10;
    if (isBrief) {
      ex = ir.left - wr.left - g;
    } else {
      ex = ir.right - wr.left + g;
    }
    let sx;
    let sy;
    if (isBrief) {
      sx = tr.left - wr.left + tr.width / 2;
      sy = tr.bottom - wr.top - 2;
    } else {
      sx = tr.right - wr.left - tr.width / 3;
      sy = tr.bottom - wr.top - 2;
    }
    const dx = ex - sx;
    const dy = ey - sy;
    const dist = Math.hypot(dx, dy);
    const inset = STAGE1_DOC_GRID_ARROW_HEAD_INSET_PX;
    let x2 = ex;
    let y2 = ey;
    if (dist > inset) {
      x2 = ex - (dx / dist) * inset;
      y2 = ey - (dy / dist) * inset;
    }
    const d = `M ${sx} ${sy} L ${x2} ${y2}`;
    setGeom({ w, h, d });
  }, [doc.id, isBrief, showHints]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute, hintText, showHints]);

  useEffect(() => {
    const ro =
      typeof ResizeObserver !== 'undefined' && wrapRef.current
        ? new ResizeObserver(() => recompute())
        : null;
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', recompute);
    const t = window.setTimeout(recompute, 0);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', recompute);
      window.clearTimeout(t);
    };
  }, [recompute]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        /** Фиксированная ширина колонки: ряд по центру с gap, без растягивания на всю ширину панели (как у grid 1fr) */
        width: 200,
        maxWidth: 200,
        minWidth: 0,
        flexShrink: 0,
        boxSizing: 'border-box',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {showHints ? (
        <p
          ref={textRef}
          style={{
            ...T.S,
            color: STAGE1_HINT_TEXT_COLOR,
            margin: 0,
            marginBottom: 10,
            padding: isBrief ? '0 0 0 6px' : '0 0 6px 6px',
            left: isBrief ? '-90px' : '80px',
            textAlign: isBrief ? 'left' : 'right',
            alignSelf: 'stretch',
            width: '100%',
            maxWidth: '100%',
            lineHeight: 1.45,
            boxSizing: 'border-box',
            position: 'relative',
            zIndex: 4,
          }}
        >
          {hintText}
        </p>
      ) : null}
      {showHints && geom.d ? (
        <svg
          width={geom.w}
          height={geom.h}
          viewBox={`0 0 ${geom.w} ${geom.h}`}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            pointerEvents: 'none',
            zIndex: 3,
            overflow: 'visible',
          }}
          aria-hidden
        >
          <defs>
            <marker
              id={safeId}
              markerWidth="4.5"
              markerHeight="4.5"
              refX="3.8"
              refY="2.25"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L4.5,2.25 L0,4.5 z" fill={STAGE1_DOC_GRID_ARROW_COLOR} />
            </marker>
          </defs>
          <path
            d={geom.d}
            fill="none"
            stroke={STAGE1_DOC_GRID_ARROW_COLOR}
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="4 4"
            markerEnd={`url(#${safeId})`}
          />
        </svg>
      ) : null}
      <button
        type="button"
        onClick={() => onOpen(doc.id)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 12,
          borderRadius: 8,
          transition: 'background 0.15s',
          maxWidth: 180,
          minWidth: 120,
          userSelect: 'none',
          WebkitUserSelect: 'none',
          position: 'relative',
          zIndex: 2,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = '#f1f5f9';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'none';
        }}
      >
        <svg
          ref={iconRef}
          width="48"
          height="60"
          viewBox="0 0 48 60"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M6 4C6 2.343 7.343 1 9 1H31L47 17V56C47 57.657 45.657 59 44 59H9C7.343 59 6 57.657 6 56V4Z" fill="white" stroke="#d1d5db" strokeWidth="1.5"/>
          <path d="M31 1V13C31 15.209 32.791 17 35 17H47" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinejoin="round"/>
          <rect x="13" y="26" width="22" height="2" rx="1" fill="#e5e7eb"/>
          <rect x="13" y="33" width="22" height="2" rx="1" fill="#e5e7eb"/>
          <rect x="13" y="40" width="15" height="2" rx="1" fill="#e5e7eb"/>
        </svg>
        <div
          style={{
            ...T.S,
            fontWeight: 600,
            color: '#374151',
            textAlign: 'center',
            maxWidth: 180,
            whiteSpace: 'normal',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            lineHeight: 1.2,
          }}
        >
          {doc.title}
        </div>
      </button>
    </div>
  );
}

/* Уровни текста: H3, H4, P (основной), B (жирный того же размера), S (мелкий) */
const T = {
  H3: { fontSize: 18, fontWeight: 700 },
  H4: { fontSize: 16, fontWeight: 600 },
  P: { fontSize: 14, fontWeight: 400 },
  B: { fontSize: 14, fontWeight: 600 },
  S: { fontSize: 12, fontWeight: 400 },
};

/** Служебные подсказки и пояснения этапа 1 — один оттенок, читаемый на белом (не бледный серый) */
const STAGE1_HINT_TEXT_COLOR = '#64748b';

const BRIEF_ROW_ICON_BTN = {
  width: 28,
  height: 28,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  color: STAGE1_HINT_TEXT_COLOR,
  transition: 'background 0.15s ease',
  flexShrink: 0,
};

/** Капсула вокруг стрелок навигации — обводка и тень как у заметок на доске */
const STAGE1_DOC_NAV_PILL = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '6px 12px',
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: 999,
  boxSizing: 'border-box',
  boxShadow: BOARD_NOTE_BOX_SHADOW,
  maxWidth: '100%',
};

/** Шрифт как у подписи навигации — для canvas-измерения ширины (антиджиттер капсулы) */
const STAGE1_DOC_NAV_TITLE_FONT = '500 13px Montserrat, system-ui, -apple-system, sans-serif';

/** Подпись целевого документа в навигации (обрезка длинных title; ширина слота задаётся снаружи по max среди документов) */
const STAGE1_DOC_NAV_TITLE = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 13,
  fontWeight: 500,
  color: '#111827',
};

/** Максимальная визуальная ширина строки заголовка среди списка — фиксированный слот подписи без «прыжков» UI */
function measureDocNavTitlesMaxWidthPx(titles) {
  if (!titles || !titles.length) return 100;
  try {
    if (typeof document === 'undefined') return 100;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 100;
    ctx.font = STAGE1_DOC_NAV_TITLE_FONT;
    let max = 0;
    for (const raw of titles) {
      const s = raw != null && String(raw).trim() !== '' ? String(raw) : 'Документ';
      max = Math.max(max, ctx.measureText(s).width);
    }
    return Math.ceil(max) + 10;
  } catch {
    return 140;
  }
}

/** Кнопка сегмента «назад» / «вперёд» с иконкой и названием */
const STAGE1_DOC_NAV_SEGMENT_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 28,
  padding: '2px 6px',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  color: STAGE1_HINT_TEXT_COLOR,
  transition: 'background 0.15s ease',
  flexShrink: 0,
};

/** Одна кнопка «< название >», когда доступен только один другой документ (всего два в списке) */
const STAGE1_DOC_NAV_SINGLE_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  minHeight: 28,
  padding: '2px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  color: '#111827',
  transition: 'background 0.15s ease',
  flexShrink: 0,
};

/** Задержка перед выставлением нативного `title` у карусели — ближе к ощущению от кнопки «Закрыть документ» (без тултипа сразу при касании). */
const STAGE1_DOC_NAV_NATIVE_TITLE_DELAY_MS = 100;

function Stage1DocNavTitleButton({ nativeTitle, ariaLabel, style, onClick, children }) {
  const [titleShown, setTitleShown] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    setTitleShown(false);
  }, [nativeTitle]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    []
  );

  const hover = {
    onMouseEnter: (e) => {
      e.currentTarget.style.background = '#f1f5f9';
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setTitleShown(true);
      }, STAGE1_DOC_NAV_NATIVE_TITLE_DELAY_MS);
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.background = 'transparent';
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setTitleShown(false);
    },
  };

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={titleShown ? nativeTitle : undefined}
      onClick={onClick}
      style={style}
      {...hover}
    >
      {children}
    </button>
  );
}

/** Мгновенный тултип (не нативный title): fixed + portal, без задержки и без обрезки overflow брифа */
function BriefInsightIconTooltip({
  text,
  children,
  placement = 'below',
  maxWidth = 280,
  textAlign = 'center',
}) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);

  const showAtAnchor = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (placement === 'above') {
      setPos({
        left: r.left + r.width / 2,
        top: r.top - 6,
      });
    } else {
      setPos({
        left: r.left + r.width / 2,
        top: r.bottom + 6,
      });
    }
    setShow(true);
  }, [placement]);

  const hide = useCallback(() => setShow(false), []);

  /** Центр по якорю + translate(-50%) уводит тултип за край экрана — поджимаем по ширине viewport */
  useLayoutEffect(() => {
    if (!show || !tooltipRef.current) return;
    const node = tooltipRef.current;
    const w = node.getBoundingClientRect().width;
    const margin = 10;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    if (!vw || !Number.isFinite(w) || w <= 0) return;
    const anchor = wrapRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const anchorCenter = anchor.left + anchor.width / 2;
    const half = w / 2;
    const minCenter = margin + half;
    const maxCenter = vw - margin - half;
    const clamped = Math.min(Math.max(anchorCenter, minCenter), maxCenter);
    setPos((p) => (Math.abs(p.left - clamped) < 0.5 ? p : { ...p, left: clamped }));
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const hideOnMove = () => setShow(false);
    window.addEventListener('scroll', hideOnMove, true);
    window.addEventListener('resize', hideOnMove);
    return () => {
      window.removeEventListener('scroll', hideOnMove, true);
      window.removeEventListener('resize', hideOnMove);
    };
  }, [show]);

  const bubbleStyle = {
    background: '#ffffff',
    borderRadius: 12,
    padding: '8px 12px',
    maxWidth,
    ...T.S,
    fontSize: 12,
    fontWeight: 400,
    color: '#374151',
    lineHeight: 1.4,
    whiteSpace: 'normal',
    fontFamily: 'inherit',
  };

  const caretUp = (
    <div
      aria-hidden
      style={{
        width: 0,
        height: 0,
        borderLeft: '9px solid transparent',
        borderRight: '9px solid transparent',
        borderBottom: '10px solid #ffffff',
      }}
    />
  );

  const caretDown = (
    <div
      aria-hidden
      style={{
        width: 0,
        height: 0,
        borderLeft: '9px solid transparent',
        borderRight: '9px solid transparent',
        borderTop: '10px solid #ffffff',
        marginTop: -1,
      }}
    />
  );

  return (
    <>
      <span
        ref={wrapRef}
        style={{ display: 'inline-flex', verticalAlign: 'top' }}
        onMouseEnter={showAtAnchor}
        onMouseLeave={hide}
      >
        {children}
      </span>
      {show &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              transform: placement === 'above' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
              zIndex: 10050,
              pointerEvents: 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              filter: `drop-shadow(${BOARD_NOTE_BOX_SHADOW})`,
              maxWidth: 'min(100vw - 20px, 100%)',
              boxSizing: 'border-box',
            }}
          >
            {placement === 'below' ? (
              <>
                {caretUp}
                <div style={{ ...bubbleStyle, marginTop: -1, textAlign }}>{text}</div>
              </>
            ) : (
              <>
                <div style={{ ...bubbleStyle, textAlign }}>{text}</div>
                {caretDown}
              </>
            )}
          </div>,
          document.body
        )}
    </>
  );
}

function Stage1DocNavArrows({ prevDoc, nextDoc, onNavigate, titleSlotWidthPx }) {
  const chevronLeft = 'M15 18l-6-6 6-6';
  const chevronRight = 'M9 18l6-6-6-6';
  const titleOf = (doc) => (doc?.title ? String(doc.title) : 'Документ');
  const w = Math.max(48, Number(titleSlotWidthPx) || 100);
  const titleStyle = {
    ...STAGE1_DOC_NAV_TITLE,
    fontFamily: "'Montserrat', system-ui, -apple-system, sans-serif",
    width: w,
    minWidth: w,
    maxWidth: w,
    display: 'inline-block',
    textAlign: 'center',
    boxSizing: 'border-box',
    verticalAlign: 'middle',
  };
  const spacer = (
    <span style={{ width: 18 + 6 + w, minWidth: 18 + 6 + w, flexShrink: 0, alignSelf: 'stretch' }} aria-hidden />
  );
  const svgChevron = (d) => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );

  const singleOtherDoc =
    prevDoc && nextDoc && prevDoc.id === nextDoc.id ? prevDoc : null;

  if (singleOtherDoc) {
    return (
      <div style={STAGE1_DOC_NAV_PILL}>
        <Stage1DocNavTitleButton
          nativeTitle={stage1DocNavTargetTitle(singleOtherDoc)}
          ariaLabel={`Перейти к документу: ${titleOf(singleOtherDoc)}`}
          onClick={() => onNavigate(singleOtherDoc.id)}
          style={{ ...STAGE1_DOC_NAV_SINGLE_BTN }}
        >
          {svgChevron(chevronLeft)}
          <span style={titleStyle}>{titleOf(singleOtherDoc)}</span>
          {svgChevron(chevronRight)}
        </Stage1DocNavTitleButton>
      </div>
    );
  }

  return (
    <div style={STAGE1_DOC_NAV_PILL}>
      {prevDoc ? (
        <Stage1DocNavTitleButton
          nativeTitle={stage1DocNavTargetTitle(prevDoc)}
          ariaLabel={`Предыдущий документ: ${titleOf(prevDoc)}`}
          onClick={() => onNavigate(prevDoc.id)}
          style={{ ...STAGE1_DOC_NAV_SEGMENT_BTN }}
        >
          {svgChevron(chevronLeft)}
          <span style={titleStyle}>{titleOf(prevDoc)}</span>
        </Stage1DocNavTitleButton>
      ) : (
        spacer
      )}
      <span
        style={{
          color: STAGE1_HINT_TEXT_COLOR,
          fontWeight: 400,
          userSelect: 'none',
          padding: '0 2px',
          flexShrink: 0,
        }}
        aria-hidden
      >
        |
      </span>
      {nextDoc ? (
        <Stage1DocNavTitleButton
          nativeTitle={stage1DocNavTargetTitle(nextDoc)}
          ariaLabel={`Следующий документ: ${titleOf(nextDoc)}`}
          onClick={() => onNavigate(nextDoc.id)}
          style={{ ...STAGE1_DOC_NAV_SEGMENT_BTN }}
        >
          <span style={titleStyle}>{titleOf(nextDoc)}</span>
          {svgChevron(chevronRight)}
        </Stage1DocNavTitleButton>
      ) : (
        spacer
      )}
    </div>
  );
}

function InitiatorAvatar() {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #64748b 0%, #475569 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 18,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        М
      </div>
    );
  }
  return (
    <img
      src={AVATAR_MIKHAIL_URL}
      alt="Михаил"
      onError={() => setFailed(true)}
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        objectFit: 'cover',
        objectPosition: '50% 25%',
        flexShrink: 0,
        imageRendering: 'pixelated',
        display: 'block',
      }}
    />
  );
}

/* Стили чата инициатора (как в этапе 3) */
const STAGE1_CHAT_CSS = `
.stage1-initiator-chat .chat-frame { display: flex; flex-direction: column; max-height: 70vh; background: #ebeae6; padding: 0; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
.stage1-initiator-chat .chat-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #ffffff; border-bottom: 1px solid #e5e7eb; }
.stage1-initiator-chat .chat-header h3 { margin: 0; font-size: 18px; font-weight: 700; color: #1a1a1a; }
.stage1-initiator-chat .chat-close { width: 28px; height: 28px; padding: 0; border: none; border-radius: 50%; background: rgba(0,0,0,0.1); color: #1a1a1a; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px; font-weight: 600; transition: all 0.2s ease; }
.stage1-initiator-chat .chat-close:hover { background: rgba(0,0,0,0.2); }
.stage1-initiator-chat .chat-messages { flex: 1; overflow-y: auto; padding: 16px; background-color: #ebeae6; display: flex; flex-direction: column; gap: 12px; min-height: 120px; }
.stage1-initiator-chat .message { display: flex; }
.stage1-initiator-chat .message-player { justify-content: flex-end; }
.stage1-initiator-chat .message-bot { justify-content: flex-start; }
.stage1-initiator-chat .message-bubble { display: inline-block; width: fit-content; max-width: 85%; padding: 10px 14px; border-radius: 16px; word-wrap: break-word; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
.stage1-initiator-chat .message-player .message-bubble { text-align: left; }
.stage1-initiator-chat .message-text { display: inline-block; max-width: 100%; white-space: pre-wrap; line-height: 1.5; }
.stage1-initiator-chat .message-player .message-bubble { background-color: #d6d3cb; color: #1f1e1a; border-bottom-right-radius: 4px; }
.stage1-initiator-chat .message-bot .message-bubble { display: inline-flex; flex-direction: column; align-items: flex-start; background-color: #ffffff; color: #1f1e1a; border: 1px solid #e5e7eb; border-bottom-left-radius: 4px; }
.stage1-initiator-chat .message-bot .message-text { display: block; width: 100%; min-width: 0; }
.stage1-initiator-chat .message-meta { font-size: 12px; font-weight: 400; color: #6b7280; margin-top: 4px; }
.stage1-initiator-chat .chat-input { border-top: 1px solid #e5e7eb; padding: 16px; background-color: #ffffff; }
.stage1-initiator-chat .options-label { font-size: 12px; font-weight: 400; margin-bottom: 6px; color: #1f2937; }
.stage1-initiator-chat .chat-textarea { width: 100%; min-height: 72px; padding: 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; font-weight: 400; resize: vertical; box-sizing: border-box; }
.stage1-initiator-chat .chat-input select { width: 100%; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; font-weight: 400; margin-bottom: 10px; }
.stage1-initiator-chat .btn-chat { display: inline-flex; align-items: center; justify-content: center; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: background-color 0.2s; }
.stage1-initiator-chat .btn-chat-primary { background-color: #10b981; color: #fff; }
.stage1-initiator-chat .btn-chat-primary:hover:not(:disabled) { background-color: #059669; }
.stage1-initiator-chat .btn-chat-secondary { background-color: #e5e7eb; color: #374151; }
.stage1-initiator-chat .btn-chat-secondary:hover { background-color: #d1d5db; }
.stage1-initiator-chat .stage1-chat-doc-link { display: inline-flex; flex-direction: row; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; background: #f3f4f6; border: 1px solid #e5e7eb; color: #374151; font-size: 14px; font-weight: 500; cursor: pointer; transition: background 0.2s, border-color 0.2s; max-width: 100%; box-sizing: border-box; }
.stage1-initiator-chat .stage1-chat-doc-link:hover { background: #e5e7eb; border-color: #d1d5db; }
.stage1-initiator-chat .stage1-chat-doc-link-icon { display: flex; align-items: center; justify-content: center; color: #6b7280; flex-shrink: 0; }
.stage1-initiator-chat .stage1-chat-doc-link-label { font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; min-width: 0; }
.stage1-initiator-chat.stage1-initiator-chat-inline .chat-frame { max-height: none; border-radius: 10px; box-shadow: none; }
.stage1-chat-blocked { padding: 12px 16px; background: #fff7ed; border-top: 1px solid #fed7aa; color: #9a3412; font-size: 13px; font-weight: 500; text-align: center; }
`;

function ensureStage1ChatStylesInjected() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('stage1-initiator-chat-styles')) return;
  const style = document.createElement('style');
  style.id = 'stage1-initiator-chat-styles';
  style.textContent = STAGE1_CHAT_CSS;
  document.head.appendChild(style);
}

export default function Stage1View({
  session,
  stage,
  onAction,
  onComplete,
  onStage1BeforeComplete,
  timeRemaining,
  onBackToStart,
  onFinishCase,
  onTutorEvent,
  onSessionUpdate,
  /** Callback: Stage1 передаёт свои чат-данные и колбэки в GameView → SimugramPanel */
  onChatExpose,
  /** id шага локального тура (`s1-brief`) — открыть документ «Бриф», чтобы подсветка нашла якорь */
  simulatorTourStepId = null,
  /** Запрос завершения этапа ушёл на сервер — блокируем повторные клики и показываем текст загрузки */
  stageCompleteInFlight = false,
  /** Зазор под HUD для колонки «Доска…» (как у Симуграм); минус общий padding-top этапа, иначе доска уезжает ниже шапки Симуграм */
  hudClearanceTopPx = 0,
}) {
  const baseDocuments = stage?.documents || [];
  const requestedDocuments = session?.stage1_requested_documents || [];
  // Документы, которые уже были открыты (например, письмо): держим их в списке, даже если сессия ещё не успела обновиться.
  const [stickyOpenedDocs, setStickyOpenedDocs] = useState([]);
  const [selectedDocId, setSelectedDocId] = useState(null);
  /** После ручного закрытия единственного документа не авто-открывать снова; сбрасывается, когда документов не 1 */
  const lastAttachedDocRef = useRef(null);
  // Список уже приложенных документов — обновляется синхронно при ответе с document_attached, чтобы следующий запрос к API всегда отправлял актуальный список
  const alreadySentDocsRef = useRef([]);
  // Для API: сессия + документы из ref (на случай если сессия ещё не обновилась)
  const requestedDocumentsForApi = (() => {
    const fromSession = requestedDocuments || [];
    const fromRef = alreadySentDocsRef.current || [];
    const ids = new Set(fromSession.map((d) => d.id));
    const extra = fromRef.filter((d) => d.id && !ids.has(d.id));
    if (extra.length === 0) return fromSession.length ? fromSession : null;
    return [...fromSession, ...extra];
  })();
  const baseList = (() => {
    const out = [];
    const seen = new Set();
    const push = (d) => {
      if (!d?.id || seen.has(d.id)) return;
      seen.add(d.id);
      out.push(d);
    };
    baseDocuments.forEach(push);
    requestedDocuments.forEach(push);
    (stickyOpenedDocs || []).forEach(push);
    return out;
  })();
  const missingOpenDoc =
    selectedDocId && !baseList.some((d) => d.id === selectedDocId) && lastAttachedDocRef.current?.id === selectedDocId
      ? lastAttachedDocRef.current
      : null;
  const documents = missingOpenDoc ? [...baseList, missingOpenDoc] : baseList;
  const attributes = stage?.attributes || [];
  const legend = stage?.content_md || stage?.legend || '';
  // null means no time limit for this stage
  const timeBudget = stage?.time_budget ?? null;
  const hasTimeBudget = timeBudget !== null;

  const [showLegendPopup, setShowLegendPopup] = useState(false);
  const [showTimeExpiredPopup, setShowTimeExpiredPopup] = useState(false);
  const tourBriefDocIdRef = useRef(null);
  useEffect(() => {
    if (simulatorTourStepId === 's1-brief') {
      setSelectedDocId((prev) => {
        if (tourBriefDocIdRef.current === null) {
          tourBriefDocIdRef.current = prev;
        }
        return STAGE1_BRIEF_DOC_ID;
      });
      return;
    }
    if (tourBriefDocIdRef.current !== null) {
      const restore = tourBriefDocIdRef.current;
      tourBriefDocIdRef.current = null;
      setSelectedDocId(restore);
    }
  }, [simulatorTourStepId]);
  const [closedDocIds, setClosedDocIds] = useState([]);
  const [insights, setInsights] = useState([]);
  const [insightsByAttribute, setInsightsByAttribute] = useState({});
  const [chatHistory, setChatHistory] = useState([]);

  useEffect(() => {
    if (!session?.id || chatHistory.length === 0) return;
    try {
      const toSave =
        chatHistory.length > STAGE1_MAX_CHAT_HISTORY
          ? chatHistory.slice(-STAGE1_MAX_CHAT_HISTORY)
          : chatHistory;
      localStorage.setItem(`simulex_s1_chat_${session.id}`, JSON.stringify(toSave));
    } catch {
      /* ignore */
    }
  }, [chatHistory, session?.id]);

  const nowTime = () =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [selectedAttrForChat, setSelectedAttrForChat] = useState(null);
  const [questionInput, setQuestionInput] = useState('');
  const [lastBotResponse, setLastBotResponse] = useState(null);
  const [pendingInsightText, setPendingInsightText] = useState('');
  const [selectionTruncated, setSelectionTruncated] = useState(false);
  const [draggedInsightId, setDraggedInsightId] = useState(null);
  /** Результат проверки качества по id заметки (не затирается при проверке другой заметки) */
  const [insightEvaluationsById, setInsightEvaluationsById] = useState({});
  /** Свёрнут ли блок результата проверки (true = видна только строка с оценкой) */
  const [insightEvalCollapsedById, setInsightEvalCollapsedById] = useState({});
  const [insightEvaluationLoading, setInsightEvaluationLoading] = useState(false);
  const [evaluatingInsightId, setEvaluatingInsightId] = useState(null);
  /** Сколько успешных проверок качества использовано всего (общий лимит на доску) */
  const [insightEvalUsedCount, setInsightEvalUsedCount] = useState(0);
  const [editingInsightId, setEditingInsightId] = useState(null);
  const [editingInsightText, setEditingInsightText] = useState('');
  const [editingInsightFocused, setEditingInsightFocused] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [askQuestionLoading, setAskQuestionLoading] = useState(false);
  /** Подмена «печатает…» если ответ дольше STAGE1_CHAT_TYPING_SLOW_MS */
  const [askQuestionSlowTypingHint, setAskQuestionSlowTypingHint] = useState(null);
  const [initiatorPatience, setInitiatorPatience] = useState(100);
  const [patienceEmoji, setPatienceEmoji] = useState('');
  const [showPatienceEmoji, setShowPatienceEmoji] = useState(false);
  const lastPatienceRef = useRef(100);
  const emojiTimeoutRef = useRef(null);
  const editTextareaRef = useRef(null);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [confirmRemoveInsightId, setConfirmRemoveInsightId] = useState(null);
  const [showManualInsightForm, setShowManualInsightForm] = useState(false);
  const [manualInsightText, setManualInsightText] = useState('');
  const [manualInsightAttrId, setManualInsightAttrId] = useState(null);
  const [conclusionText, setConclusionText] = useState('');
  const documentContentRef = useRef(null);
  const selectionTextRef = useRef(null);
  const selectionHandlerRef = useRef(null);
  const chatMessagesEndRef = useRef(null);
  const manualInsightTextareaRef = useRef(null);
  const conclusionBlockRef = useRef(null);
  const briefScrollRef = useRef(null);
  const documentPanelRef = useRef(null);

  const chatRestoredRef = useRef(false);
  const [s1DraftHydrated, setS1DraftHydrated] = useState(false);

  useLayoutEffect(() => {
    if (!session?.id) {
      setS1DraftHydrated(false);
      return;
    }
    if (chatRestoredRef.current) return;
    chatRestoredRef.current = true;

    try {
      const pRaw = localStorage.getItem(`simulex_s1_patience_${session.id}`);
      if (pRaw !== null && pRaw !== '') {
        const n = parseInt(pRaw, 10, 10);
        if (!Number.isNaN(n)) {
          const clamped = Math.max(0, Math.min(100, n));
          lastPatienceRef.current = clamped;
          setInitiatorPatience(clamped);
        }
      }
      const saved = localStorage.getItem(`simulex_s1_chat_${session.id}`);
      let initialChat = [];
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) initialChat = parsed;
      }
      if (initialChat.length === 0) {
        const responseTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        initialChat = [
          {
            attribute_id: null,
            question: '',
            bot_response: STAGE1_PM_OPENING_MESSAGE,
            insightSaved: false,
            questionTime: null,
            responseTime,
          },
        ];
      }
      setChatHistory(initialChat);
    } catch {
      /* ignore */
    }

    try {
      const draft = readStageDraft(session.id, 1);
      if (draft) {
        if (draft.selectedDocId != null && draft.selectedDocId !== '') {
          setSelectedDocId(String(draft.selectedDocId));
        }
        if (Array.isArray(draft.closedDocIds)) {
          setClosedDocIds(draft.closedDocIds.filter((id) => id != null).map(String));
        }
        if (Array.isArray(draft.insights)) {
          setInsights(draft.insights);
        }
        if (draft.insightsByAttribute && typeof draft.insightsByAttribute === 'object') {
          setInsightsByAttribute(draft.insightsByAttribute);
        }
        if (Array.isArray(draft.stickyOpenedDocs)) {
          setStickyOpenedDocs(
            draft.stickyOpenedDocs
              .filter((d) => d && d.id)
              .map((d) => ({
                id: String(d.id),
                title: typeof d.title === 'string' ? d.title : 'Документ',
                content: typeof d.content === 'string' ? d.content : '',
              }))
          );
        }
        if (typeof draft.conclusionText === 'string') {
          setConclusionText(draft.conclusionText);
        }
        if (draft.insightEvaluationsById && typeof draft.insightEvaluationsById === 'object') {
          setInsightEvaluationsById(draft.insightEvaluationsById);
        }
        if (draft.insightEvalCollapsedById && typeof draft.insightEvalCollapsedById === 'object') {
          setInsightEvalCollapsedById(draft.insightEvalCollapsedById);
        }
        const evMap =
          draft.insightEvaluationsById && typeof draft.insightEvaluationsById === 'object'
            ? draft.insightEvaluationsById
            : {};
        const scoredFromDraft = Object.values(evMap).filter(
          (v) => v && typeof v.score === 'number' && !Number.isNaN(v.score)
        ).length;
        let fromField = 0;
        const rawUsed = draft.insightEvalUsedCount;
        if (typeof rawUsed === 'number' && Number.isFinite(rawUsed) && rawUsed >= 0) {
          fromField = Math.floor(rawUsed);
        } else if (typeof rawUsed === 'string' && String(rawUsed).trim() !== '') {
          const n = parseInt(String(rawUsed).trim(), 10, 10);
          if (!Number.isNaN(n) && n >= 0) fromField = n;
        }
        setInsightEvalUsedCount(Math.max(fromField, scoredFromDraft));
      }
    } catch {
      /* ignore */
    }

    setS1DraftHydrated(true);
  }, [session?.id]);

  useEffect(() => {
    if (!session?.id || !s1DraftHydrated) return;
    writeStageDraft(session.id, 1, {
      version: 1,
      savedAt: Date.now(),
      selectedDocId,
      closedDocIds,
      insights,
      insightsByAttribute,
      stickyOpenedDocs: (stickyOpenedDocs || []).map((d) => ({
        id: d?.id,
        title: d?.title,
        content: typeof d?.content === 'string' ? d.content : '',
      })),
      conclusionText,
      insightEvalUsedCount,
      insightEvaluationsById,
      insightEvalCollapsedById,
    });
  }, [
    s1DraftHydrated,
    session?.id,
    selectedDocId,
    closedDocIds,
    insights,
    insightsByAttribute,
    stickyOpenedDocs,
    conclusionText,
    insightEvalUsedCount,
    insightEvaluationsById,
    insightEvalCollapsedById,
  ]);

  const actionsDone = session?.actions_done || [];
  const resources = session?.resources || {};
  const timeLeft = hasTimeBudget ? Math.min(resources.time ?? timeBudget, timeBudget) : Infinity;
  const timeExpired = hasTimeBudget && timeLeft <= 0;
  const questionsUsed = actionsDone.filter((id) => id === 's1-ask-question' || id.startsWith('s1-ask-question-')).length;
  const canAskMore = !timeExpired && initiatorPatience > 0;
  /** Документы шире доски заметок (раньше 55/45 при развёрнутой доске) */
  const mainViewGridTemplate = '62fr 38fr';

  const getActionIdForDoc = (docId) => {
    const action = stage?.actions?.find((a) => a.document_id === docId);
    return action?.id;
  };

  const isDocOpened = (docId) => {
    const actionId = getActionIdForDoc(docId);
    return actionId ? actionsDone.includes(actionId) : false;
  };
  const isDocClosed = (_docId) => false;
  const canOpenDoc = (_docId) => true;
  const canClickDoc = (_docId) => true;

  useEffect(() => {
    ensureStage1ChatStylesInjected();
  }, []);

  // Синхронизируем ref «уже приложенных» с сессией (например после восстановления из localStorage)
  useEffect(() => {
    const fromSession = session?.stage1_requested_documents || [];
    if (fromSession.length === 0) return;
    const byId = new Map(alreadySentDocsRef.current.map((d) => [d.id, d]));
    fromSession.forEach((d) => { if (d.id) byId.set(d.id, d); });
    const next = Array.from(byId.values());
    if (next.length !== alreadySentDocsRef.current.length) alreadySentDocsRef.current = next;
  }, [session?.stage1_requested_documents]);

  useEffect(() => {
    if (selectedDocId && documentPanelRef.current) {
      documentPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [selectedDocId]);

  const isBriefOpen = selectedDocId === STAGE1_BRIEF_DOC_ID;

  useEffect(() => {
    if (isBriefOpen) return;
    if (!chatMessagesEndRef.current) return;
    const t = setTimeout(() => {
      chatMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 0);
    return () => clearTimeout(t);
  }, [isBriefOpen, chatOpen, chatHistory.length, askQuestionLoading]);

  useEffect(() => {
    if (!askQuestionLoading) {
      setAskQuestionSlowTypingHint(null);
      return undefined;
    }
    const t = window.setTimeout(() => {
      setAskQuestionSlowTypingHint(pickStage1SlowTypingMessage());
    }, STAGE1_CHAT_TYPING_SLOW_MS);
    return () => window.clearTimeout(t);
  }, [askQuestionLoading]);

  useEffect(() => {
    const ta = manualInsightTextareaRef.current;
    if (!ta || !showManualInsightForm) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(24, ta.scrollHeight) + 'px';
  }, [showManualInsightForm, manualInsightText]);

  useEffect(() => {
    if (hasTimeBudget && timeExpired) setShowTimeExpiredPopup(true);
  }, [hasTimeBudget, timeExpired]);

  useEffect(() => {
    if (!isBriefOpen) {
      setShowManualInsightForm(false);
      setManualInsightText('');
      setManualInsightAttrId(null);
    }
  }, [isBriefOpen]);

  useEffect(() => {
    if (!editingInsightId || !editTextareaRef.current) return;
    const ta = editTextareaRef.current;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(100, ta.scrollHeight)}px`;
  }, [editingInsightId, editingInsightText]);

  const addInsight = useCallback((text, source = 'document', meta = {}) => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    const limited = trimmed.length > INSIGHT_MAX_LENGTH ? trimmed.slice(0, INSIGHT_MAX_LENGTH) : trimmed;
    setInsights((prev) => [
      { id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`, text: limited, source, ...meta },
      ...prev,
    ]);
  }, []);

  const openManualNoteForBriefAttr = useCallback((attrId) => {
    setManualInsightAttrId((prev) => {
      if (prev !== attrId) setManualInsightText('');
      return attrId;
    });
    setShowManualInsightForm(true);
  }, []);

  const saveManualNoteFromBrief = useCallback(() => {
    const attrId = manualInsightAttrId;
    const trimmed = manualInsightText?.trim();
    if (!attrId || !trimmed) return;
    const limited = trimmed.length > INSIGHT_MAX_LENGTH ? trimmed.slice(0, INSIGHT_MAX_LENGTH) : trimmed;
    const newInsight = {
      id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: limited,
      source: 'manual',
    };
    setInsights((prev) => [newInsight, ...prev]);
    setInsightsByAttribute((prev) => ({
      ...prev,
      [attrId]: [newInsight.id, ...(prev[attrId] || [])],
    }));
    setShowManualInsightForm(false);
    setManualInsightText('');
    setManualInsightAttrId(null);
  }, [manualInsightAttrId, manualInsightText]);

  const cancelManualNoteFromBrief = useCallback(() => {
    setShowManualInsightForm(false);
    setManualInsightText('');
    setManualInsightAttrId(null);
  }, []);

  const applyPatienceUpdate = useCallback((value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    const clamped = Math.max(0, Math.min(100, value));
    const prev = lastPatienceRef.current;
    lastPatienceRef.current = clamped;
    setInitiatorPatience(clamped);
    if (session?.id) {
      try {
        localStorage.setItem(`simulex_s1_patience_${session.id}`, String(clamped));
      } catch {
        /* ignore */
      }
    }
    const drop = prev - clamped;
    if (drop <= 0) return;
    let emoji = '🙂';
    if (drop > 20) emoji = '😡';
    else if (drop > 10) emoji = '😠';
    setPatienceEmoji(emoji);
    setShowPatienceEmoji(true);
    if (emojiTimeoutRef.current) clearTimeout(emojiTimeoutRef.current);
    emojiTimeoutRef.current = setTimeout(() => setShowPatienceEmoji(false), 900);
  }, [session?.id]);

  const handleOpenDoc = (docId) => {
    const actionId = getActionIdForDoc(docId);
    if (!actionId || actionsDone.includes(actionId)) {
      setSelectedDocId(docId);
      return;
    }
    onAction(actionId);
    setSelectedDocId(docId);
  };

  const handleCloseDoc = (_docId) => {
    setSelectedDocId(null);
  };

  useEffect(() => {
    const handler = (e) => {
      const { docId, scrollTarget } = e.detail || {};
      if (!docId) return;
      handleOpenDoc(docId);
      if (scrollTarget === 'conclusion') {
        let attempts = 0;
        const tryScroll = () => {
          if (conclusionBlockRef.current) {
            conclusionBlockRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
          if (++attempts < 20) setTimeout(tryScroll, 100);
        };
        setTimeout(tryScroll, 50);
      }
    };
    window.addEventListener('simugram:open-doc', handler);
    return () => window.removeEventListener('simugram:open-doc', handler);
  });

  // Проверка, что выделение внутри контейнера документа
  const isSelectionInsideContainer = useCallback((selection, container) => {
    if (!selection || selection.rangeCount === 0 || !container) return false;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    return anchor && focus && container.contains(anchor) && container.contains(focus);
  }, []);

  // По selectionchange всегда держим актуальный текст выделения в ref (только если внутри контейнера)
  useEffect(() => {
    if (!selectedDocId || isBriefDocId(selectedDocId)) return;
    const container = documentContentRef.current;
    if (!container) return;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!isSelectionInsideContainer(sel, container)) return;
      const text = sel.toString().trim();
      if (text) selectionTextRef.current = text;
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [selectedDocId, isSelectionInsideContainer]);

  // По mouseup показываем попап: берём текст из ref (обновляется по selectionchange); если ref пуст — один раз читаем getSelection (на случай порядка событий в части браузеров)
  const handleSelectText = useCallback(() => {
    const container = documentContentRef.current;
    if (!container || !selectedDocId || isBriefDocId(selectedDocId)) return;
    let text = selectionTextRef.current;
    if (!text) {
      const sel = window.getSelection();
      if (isSelectionInsideContainer(sel, container)) {
        text = sel.toString().trim();
      }
    }
    if (!text) return;
    selectionTextRef.current = null;
    if (text.length > INSIGHT_MAX_LENGTH) {
      setSelectionTruncated(true);
      setPendingInsightText(text.slice(0, INSIGHT_MAX_LENGTH));
    } else {
      setSelectionTruncated(false);
    setPendingInsightText(text);
    }
  }, [selectedDocId, isSelectionInsideContainer]);

  useEffect(() => {
    if (!selectedDocId || isBriefDocId(selectedDocId)) return;
    selectionHandlerRef.current = handleSelectText;
    const onDocMouseUp = () => selectionHandlerRef.current?.();
    document.addEventListener('mouseup', onDocMouseUp, true);
    return () => {
      document.removeEventListener('mouseup', onDocMouseUp, true);
      selectionHandlerRef.current = null;
    };
  }, [selectedDocId, handleSelectText]);

  const handleConfirmAddInsight = () => {
    if (pendingInsightText.trim()) {
      addInsight(pendingInsightText.trim(), 'document', { documentId: selectedDocId });
      setPendingInsightText('');
      setSelectionTruncated(false);
      window.getSelection()?.removeAllRanges?.();
      selectionTextRef.current = null;
    }
  };

  const handleCancelPendingInsight = () => {
    setPendingInsightText('');
    setSelectionTruncated(false);
    window.getSelection()?.removeAllRanges?.();
    selectionTextRef.current = null;
  };

  const handleAskQuestion = async (externalText) => {
    const rawText = externalText || questionInput;
    if (!canAskMore || !rawText.trim() || askQuestionLoading) return;
    const questionText = rawText.trim();
    const questionSentAt = nowTime();
    setPendingQuestion({
      question: questionText,
      attributeTitle: '',
      sentAt: questionSentAt,
    });
    setAskQuestionLoading(true);
    const nextQuestionId = 's1-ask-question';

    const applyResponse = (botText, quality, idealReceived, qualityHint, documentAttached) => {
      setPendingQuestion(null);
    setLastBotResponse({ text: botText, quality, ideal_insight_received: idealReceived });
    setChatHistory((prev) => [
      ...prev,
      {
          attribute_id: null,
          question: questionText,
        quality,
        ideal_insight_received: idealReceived,
          quality_hint: qualityHint ?? null,
        bot_response: botText,
          insightSaved: false,
          documentAttachedId: documentAttached?.id ?? null,
          documentAttachedTitle: documentAttached?.title ?? null,
          questionTime: questionSentAt,
          responseTime: nowTime(),
      },
    ]);
      onAction(nextQuestionId);
    setQuestionInput('');
      if (typeof onTutorEvent === 'function') {
        onTutorEvent('stage_chat_message', { text: questionText });
      }
    };

    try {
      // Все документы с контентом (ТЗ и приложенные) передаём в запрос, чтобы модель могла проверять:
      // ответ есть в документе → только отсылка к материалам, без подсказки из базы знаний
      const documents_context = documents
        .filter((d) => d.content)
        .map((d) => ({ doc_id: d.id, content: d.content || '' }));
      const case_context = {
        title: stage?.title || null,
        intro: stage?.intro || null,
        attributes: (stage?.attributes || []).map((a) => ({
          id: a.id,
          title: a.title,
          reference_insights: a.reference_insights || [],
        })),
        requestable_documents: stage?.requestable_documents ?? [],
      };
      const result = await stage1QuestionAPI.answer({
        question_text: questionText,
        attribute_id: null,
        attribute_title: null,
        reference_insights: null,
        documents_context: documents_context.length ? documents_context : null,
        case_context,
        case_id: session?.case_id ?? null,
        chat_history: chatHistory
          .filter((e) => String(e.question || '').trim().length > 0)
          .slice(-8)
          .map((e) => ({
            attribute_id: e.attribute_id ?? null,
            question: e.question,
            bot_response: e.bot_response,
          })),
        current_patience: initiatorPatience,
        off_topic_count: chatHistory.filter((e) => e.quality_hint === 'off_topic').length,
        stage1_requested_documents: requestedDocumentsForApi?.length ? requestedDocumentsForApi : null,
      });
      if (typeof result.patience === 'number') {
        applyPatienceUpdate(result.patience);
      }
      if (result.chat_blocked) {
        // Мат/оскорбление — показываем финальное сообщение и блокируем навсегда
        setPendingQuestion(null);
        setChatHistory((prev) => [
          ...prev,
          {
            attribute_id: null,
            question: questionText,
            quality: 'bad',
            ideal_insight_received: false,
            bot_response: result.answer_text || result.answerText || '',
            insightSaved: false,
            hideInsightButton: true,
            isBlocking: true,
            questionTime: questionSentAt,
            responseTime: nowTime(),
          },
        ]);
        setQuestionInput('');
        return;
      }
      const hint = (result.quality_hint || 'partial').toLowerCase();
      // good: full, document; medium: partial; bad: clarify, off_topic и остальные
      const quality = hint === 'full' || hint === 'document' ? 'good' : hint === 'partial' ? 'medium' : 'bad';
      const idealReceived = hint === 'full' || hint === 'document';
      const documentAttached = result.document_attached
        ? { id: result.document_attached.id, title: result.document_attached.title || result.document_attached.id }
        : null;
      applyResponse(result.answer_text || result.answerText || '', quality, idealReceived, hint, documentAttached);

      if (result.document_attached) {
        const doc = {
          id: result.document_attached.id,
          title: result.document_attached.title || result.document_attached.id,
          content: result.document_attached.content || '',
        };
        lastAttachedDocRef.current = doc;
        // Сразу добавляем в ref, чтобы следующий запрос к API отправил этот id как «уже присыланный»
        const prev = alreadySentDocsRef.current;
        if (!prev.some((d) => d.id === doc.id)) {
          alreadySentDocsRef.current = [...prev, doc];
        }
        if (typeof onSessionUpdate === 'function' && session) {
          const existing = session.stage1_requested_documents || [];
          if (!existing.some((d) => d.id === doc.id)) {
            const nextSession = {
              ...session,
              stage1_requested_documents: [...existing, doc],
            };
            startTransition(() => {
              onSessionUpdate(nextSession);
            });
          }
        }
      }
    } catch (err) {
      const quality = questionText.length >= 30 ? 'good' : questionText.length >= 15 ? 'medium' : 'bad';
      const idealReceived = quality === 'good';
      const botText =
        quality === 'good'
          ? 'Уточните, пожалуйста, вопрос.'
          : quality === 'medium'
            ? 'Не совсем понял. Уточните, пожалуйста, вопрос.'
            : 'Уточните, пожалуйста, вопрос.';
      applyResponse(botText, quality, idealReceived, null);
    } finally {
      setAskQuestionLoading(false);
    }
  };

  const handleAddInsightFromChat = (text, chatIndex) => {
    if (text?.trim()) addInsight(text, 'chat');
    if (typeof chatIndex === 'number') {
      setChatHistory((prev) =>
        prev.map((e, i) => (i === chatIndex ? { ...e, insightSaved: true } : e))
      );
    }
  };

  const handleAskQuestionRef = useRef(handleAskQuestion);
  handleAskQuestionRef.current = handleAskQuestion;
  const handleAddInsightRef = useRef(handleAddInsightFromChat);
  handleAddInsightRef.current = handleAddInsightFromChat;

  useEffect(() => {
    if (typeof onChatExpose !== 'function') return;
    onChatExpose({
      stageSessionId: session?.id ?? null,
      chatHistory,
      pendingQuestion,
      initiatorPatience,
      loading: askQuestionLoading,
      onSendQuestion: (text) => handleAskQuestionRef.current?.(text),
      onSaveInsight: (text, idx) => handleAddInsightRef.current?.(text, idx),
      onDocumentClick: (docId) => setSelectedDocId(docId),
    });
  }, [session?.id, chatHistory, pendingQuestion, initiatorPatience, askQuestionLoading, onChatExpose]);

  const handleEvaluateInsight = async (insightId) => {
    const insight = insights.find((i) => i.id === insightId);
    if (!insight?.text?.trim()) return;
    if (insightEvalUsedCount >= MAX_INSIGHT_EVAL_ATTEMPTS) return;
    const assignedAttrId = Object.keys(insightsByAttribute).find((attrId) =>
      (insightsByAttribute[attrId] || []).includes(insightId)
    );
    if (!assignedAttrId) return;
    const attr = assignedAttrId ? attributes.find((a) => a.id === assignedAttrId) : null;
    let documentSnippet = null;
    if (insight.documentId) {
      const doc = documents.find((d) => d.id === insight.documentId);
      const raw = (doc && (doc.content || doc.content_snippet)) || '';
      if (raw) {
        const needle = insight.text.trim().slice(0, 120);
        const idx = raw.indexOf(needle.slice(0, Math.min(40, needle.length)));
        if (idx >= 0) {
          documentSnippet = raw.slice(Math.max(0, idx - 80), idx + Math.min(420, needle.length + 200));
        } else {
          documentSnippet = raw.slice(0, 500);
        }
      }
    }
    // Заметка без привязки к документу: если по блоку уже запрошены подтверждающие документы — передаём фрагмент в оценку (сверка с письмом и т.п.).
    if (!documentSnippet?.trim() && attr?.document_requirements?.length) {
      const reqIds = new Set(
        (attr.document_requirements || []).map((r) => r?.document_id).filter(Boolean)
      );
      const requestedIds = new Set((requestedDocuments || []).map((d) => d?.id).filter(Boolean));
      for (const doc of documents || []) {
        if (!doc?.id || !requestedIds.has(doc.id) || !reqIds.has(doc.id)) continue;
        const raw = (doc.content || doc.content_snippet || '').trim();
        if (raw) {
          documentSnippet = raw.slice(0, 1200);
          break;
        }
      }
    }
    const all_attributes = attributes
      .filter((a) => a.type !== 'conclusion')
      .map((a) => ({
        id: a.id,
        title: a.title,
        reference_insights: a.reference_insights ?? null,
        document_requirements: a.document_requirements ?? null,
      }));
    const existing_insights_by_attribute = {};
    attributes
      .filter((a) => a.type !== 'conclusion')
      .forEach((a) => {
        const ids = insightsByAttribute[a.id] || [];
        existing_insights_by_attribute[a.id] = ids
          .map((id) => insights.find((i) => i.id === id)?.text || '')
          .filter(Boolean);
      });

    setEvaluatingInsightId(insightId);
    setInsightEvaluationLoading(true);
    try {
      const requested_document_ids = (requestedDocuments || []).map((d) => d?.id).filter(Boolean);
      const result = await stage1InsightAPI.evaluate({
        insight_text: insight.text.trim(),
        attribute_id: attr?.id ?? null,
        attribute_title: attr?.title ?? null,
        reference_insights: attr?.reference_insights ?? null,
        document_snippet: documentSnippet,
        case_id: session?.case_id ?? null,
        requested_document_ids,
        all_attributes,
        existing_insights_by_attribute,
      });
      const gq = Array.isArray(result.guiding_questions) ? result.guiding_questions.filter(Boolean) : [];
      setInsightEvalUsedCount((prev) => prev + 1);
      setInsightEvaluationsById((prev) => ({
        ...prev,
        [insightId]: {
          score: result.score,
          feedback: result.feedback,
          suggestion: result.suggestion ?? null,
          guiding_questions: gq,
          misclassified: Boolean(result.misclassified),
          pending_documents: Array.isArray(result.pending_documents) ? result.pending_documents : [],
          noise_note: result.noise_note ?? null,
        },
      }));
      setInsightEvalCollapsedById((prev) => ({ ...prev, [insightId]: false }));
    } catch (err) {
      setInsightEvaluationsById((prev) => ({
        ...prev,
        [insightId]: {
          score: null,
          feedback: 'Не удалось оценить (проверьте подключение и OPENROUTER_API_KEY/OPENAI_API_KEY на сервере)',
          suggestion: null,
          guiding_questions: [],
          misclassified: false,
        },
      }));
      setInsightEvalCollapsedById((prev) => ({ ...prev, [insightId]: false }));
    } finally {
      setInsightEvaluationLoading(false);
      setEvaluatingInsightId(null);
    }
  };

  const assignInsightToAttribute = (insightId, attrId) => {
    setInsightsByAttribute((prev) => {
      const next = {};
      Object.keys(prev).forEach((id) => {
        next[id] = (prev[id] || []).filter((i) => i !== insightId);
      });
      next[attrId] = [insightId, ...(next[attrId] || [])];
      return next;
    });
    setInsightEvaluationsById((prev) => {
      if (!prev[insightId]) return prev;
      const next = { ...prev };
      delete next[insightId];
      return next;
    });
    setInsightEvalCollapsedById((prev) => {
      if (!(insightId in prev)) return prev;
      const next = { ...prev };
      delete next[insightId];
      return next;
    });
    setDraggedInsightId(null);
  };

  const handleRemoveInsight = (insightId) => {
    setConfirmRemoveInsightId(insightId);
  };

  const doRemoveInsight = (insightId) => {
    setInsights((prev) => prev.filter((i) => i.id !== insightId));
    setInsightEvaluationsById((prev) => {
      if (!prev[insightId]) return prev;
      const next = { ...prev };
      delete next[insightId];
      return next;
    });
    setInsightEvalCollapsedById((prev) => {
      if (!(insightId in prev)) return prev;
      const next = { ...prev };
      delete next[insightId];
      return next;
    });
    setInsightsByAttribute((prev) => {
      const next = {};
      Object.keys(prev).forEach((attrId) => {
        next[attrId] = (prev[attrId] || []).filter((id) => id !== insightId);
      });
      return next;
    });
    setConfirmRemoveInsightId(null);
  };

  const startEditInsight = (insightId) => {
    const insight = insights.find((i) => i.id === insightId);
    if (insight) {
      setEditingInsightId(insightId);
      setEditingInsightText(insight.text || '');
    }
  };

  const saveEditInsight = () => {
    if (!editingInsightId || !editingInsightText.trim()) {
      setEditingInsightId(null);
      setEditingInsightText('');
      return;
    }
    const limited = editingInsightText.trim().length > INSIGHT_MAX_LENGTH
      ? editingInsightText.trim().slice(0, INSIGHT_MAX_LENGTH)
      : editingInsightText.trim();
    const prevRow = insights.find((i) => i.id === editingInsightId);
    if (prevRow && prevRow.text !== limited) {
      setInsightEvaluationsById((prev) => {
        if (!prev[editingInsightId]) return prev;
        const next = { ...prev };
        delete next[editingInsightId];
        return next;
      });
      setInsightEvalCollapsedById((prev) => {
        if (!(editingInsightId in prev)) return prev;
        const next = { ...prev };
        delete next[editingInsightId];
        return next;
      });
    }
    setInsights((prev) =>
      prev.map((i) => (i.id === editingInsightId ? { ...i, text: limited } : i))
    );
    setEditingInsightId(null);
    setEditingInsightText('');
    setEditingInsightFocused(false);
  };

  const cancelEditInsight = () => {
    setEditingInsightId(null);
    setEditingInsightText('');
    setEditingInsightFocused(false);
  };

  /** Снять заметку с атрибута — она снова появляется на доске собранной информации, не удаляется */
  const handleUnassignInsight = (insightId, attrId) => {
    setInsightsByAttribute((prev) => {
      const next = { ...prev };
      next[attrId] = (next[attrId] || []).filter((id) => id !== insightId);
      return next;
    });
    setInsightEvaluationsById((prev) => {
      if (!prev[insightId]) return prev;
      const next = { ...prev };
      delete next[insightId];
      return next;
    });
    setInsightEvalCollapsedById((prev) => {
      if (!(insightId in prev)) return prev;
      const next = { ...prev };
      delete next[insightId];
      return next;
    });
  };

  const handleDragStart = (e, insightId) => {
    setDraggedInsightId(insightId);
    e.dataTransfer.setData('text/plain', insightId);
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragEnd = () => setDraggedInsightId(null);
  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDropOnAttr = (e, attrId) => {
    e.preventDefault();
    const insightId = e.dataTransfer.getData('text/plain') || draggedInsightId;
    if (insightId) assignInsightToAttribute(insightId, attrId);
  };

  const getInsightTextById = (id) => insights.find((i) => i.id === id)?.text || '';

  const buildStage1Result = () => {
    const timeByActions = (session?.actions_done || []).reduce((acc, actionId) => {
      const action = stage?.actions?.find((a) => a.id === actionId);
      if (action?.costs?.time) acc += action.costs.time;
      return acc;
    }, 0);
    const timeSpentDocs = (session?.actions_done || [])
      .filter((id) => id.startsWith('s1-open-doc-'))
      .reduce((acc, actionId) => {
        const action = stage?.actions?.find((a) => a.id === actionId);
        if (action?.costs?.time) acc += action.costs.time;
        return acc;
      }, 0);
    const timeSpentQuestions = (session?.actions_done || [])
      .filter((id) => id.startsWith('s1-ask-question-'))
      .reduce((acc, actionId) => {
        const action = stage?.actions?.find((a) => a.id === actionId);
        if (action?.costs?.time) acc += action.costs.time;
        return acc;
      }, 0);

    const insightsByAttrForBackend = {};
    Object.keys(insightsByAttribute).forEach((attrId) => {
      const ids = insightsByAttribute[attrId] || [];
      insightsByAttrForBackend[attrId] = ids.map((id) => getInsightTextById(id)).filter(Boolean);
    });

    const transcript = chatHistory.slice(-45).map((e) => ({
      question: (e.question || '').slice(0, 2000),
      bot_response: (e.bot_response || '').slice(0, 2000),
      quality: e.quality ?? null,
      quality_hint: e.quality_hint ?? null,
      attribute_id: e.attribute_id ?? null,
    }));

    return {
      insights_count: insights.length,
      time_spent_documents: timeSpentDocs,
      time_spent_questions: timeSpentQuestions,
      insights_by_attribute: insightsByAttrForBackend,
      conclusion_text: conclusionText.trim() || null,
      questions: chatHistory
        .filter((q) => String(q.question || '').trim().length > 0)
        .map((q) => ({
          attribute_id: q.attribute_id,
          question: (q.question || '').slice(0, 2000),
          quality: q.quality,
          ideal_insight_received: q.ideal_insight_received,
          quality_hint: q.quality_hint ?? null,
        })),
      /** Для анализа на бэкенде (summary / отчёт); не используется в LEXIC */
      initiator_chat_transcript: transcript.length ? transcript : undefined,
    };
  };

  const handleCompleteStage = () => {
    const stage1_result = buildStage1Result();
    const sessionWithResult = { ...session, stage1_result };
    if (onStage1BeforeComplete) {
      onStage1BeforeComplete(sessionWithResult);
    } else {
      onComplete({ session: sessionWithResult });
    }
  };

  const selectedDoc = useMemo(() => {
    if (selectedDocId === STAGE1_BRIEF_DOC_ID) {
      return { id: STAGE1_BRIEF_DOC_ID, title: 'Бриф' };
    }
    return documents.find((d) => d.id === selectedDocId) ?? null;
  }, [selectedDocId, documents]);

  const documentIconsForGrid = useMemo(() => {
    const briefEntry = { id: STAGE1_BRIEF_DOC_ID, title: 'Бриф' };
    const hasBrief = documents.some((d) => d.id === STAGE1_BRIEF_DOC_ID);
    if (hasBrief) {
      const briefItem = documents.find((d) => d.id === STAGE1_BRIEF_DOC_ID);
      const rest = documents.filter((d) => d.id !== STAGE1_BRIEF_DOC_ID);
      return [briefItem, ...rest];
    }
    return [briefEntry, ...documents];
  }, [documents]);

  const { prevNavDoc, nextNavDoc, showDocNavArrows } = useMemo(() => {
    const list = documentIconsForGrid;
    const idx = list.findIndex((d) => d.id === selectedDocId);
    const n = list.length;
    if (n < 2 || idx < 0) {
      return { prevNavDoc: null, nextNavDoc: null, showDocNavArrows: false };
    }
    // Циклическая навигация: при n≥2 «предыдущий»/«следующий» всегда соседи по кругу
    // (для двух документов обе стороны указывают на второй документ).
    const prevNavDoc = list[(idx - 1 + n) % n];
    const nextNavDoc = list[(idx + 1) % n];
    return { prevNavDoc, nextNavDoc, showDocNavArrows: true };
  }, [documentIconsForGrid, selectedDocId]);

  const docNavTitleSlotWidthPx = useMemo(() => {
    const titles = documentIconsForGrid.map((d) =>
      d?.title != null && String(d.title).trim() !== '' ? String(d.title) : 'Документ'
    );
    return measureDocNavTitlesMaxWidthPx(titles);
  }, [documentIconsForGrid]);

  useEffect(() => {
    if (!selectedDoc?.id || isBriefDocId(selectedDoc.id)) return;
    setStickyOpenedDocs((prev) => {
      if (prev.some((d) => d?.id === selectedDoc.id)) return prev;
      return [...prev, selectedDoc];
    });
  }, [selectedDocId, selectedDoc?.id]);

  if (showLegendPopup && legend) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: 20,
        }}
      >
        <div
          style={{
            background: 'white',
            maxWidth: 560,
            maxHeight: '80vh',
            overflow: 'auto',
            padding: 24,
            borderRadius: 8,
            boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
            whiteSpace: 'pre-wrap',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          <div style={{ marginBottom: 16, fontWeight: 'bold', fontSize: 16 }}>Легенда и правила</div>
          <div className="simulex-content" style={{ whiteSpace: 'pre-wrap' }}>
            {legend}
          </div>
          <button
            type="button"
            onClick={() => setShowLegendPopup(false)}
            style={{
              marginTop: 20,
              padding: '10px 24px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            Закрыть окно легенды
          </button>
        </div>
      </div>
    );
  }

  // Снекбар «Очки времени закончились» — внизу экрана, не перекрывает контент; кнопка «Понятно» закрывает
  const timeExpiredSnackbar =
    showTimeExpiredPopup && timeExpired ? (
      <div
        role="status"
        aria-live="polite"
        id="time-expired-snackbar"
        style={{
          position: 'fixed',
          bottom: 20,
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: 'calc(100vw - 40px)',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '14px 20px',
          background: '#1e293b',
          color: 'white',
          borderRadius: 8,
          boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
          zIndex: 1000,
        }}
      >
        <span style={{ fontSize: 14, lineHeight: 1.4, flex: 1 }}>
          Очки времени закончились. Можно просмотреть открытый документ и открыть бриф по иконке «Бриф» в блоке документов, чтобы дозаполнить карту сделки и завершить этап.
        </span>
        <button
          type="button"
          onClick={() => setShowTimeExpiredPopup(false)}
          style={{
            flexShrink: 0,
            padding: '8px 20px',
            fontSize: 14,
            fontWeight: 600,
            background: 'white',
            color: '#1e293b',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Понятно
        </button>
      </div>
    ) : null;

  const askQuestionTimeCost = stage?.actions?.find((a) => a.id === 's1-ask-question' || a.id?.startsWith('s1-ask-question-'))?.costs?.time ?? 10;

  const notesBoardHudPaddingTop = Math.max(0, (hudClearanceTopPx || 0) - STAGE1_DOC_TO_COMPLETE_BTN_GAP);

  const stage1BoardUnassignedInsights = useMemo(
    () =>
      insights.filter(
        (i) =>
          !Object.keys(insightsByAttribute).some((attrId) =>
            (insightsByAttribute[attrId] || []).includes(i.id)
          )
      ),
    [insights, insightsByAttribute]
  );

  return (
    <>
      {/* minWidth: 0 не ставим у корня: иначе контент перестаёт задавать минимальную ширину flex-элементу в GameView и блок «скукоживается». height/minHeight 100% — чтобы растянуться по высоте родителя (в GameView обёртка без display:flex). */}
      <div style={{ width: '100%', maxWidth: '100%', height: '100%', minHeight: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxSizing: 'border-box', userSelect: 'none', WebkitUserSelect: 'none', background: '#f5f5f5' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            padding: `${STAGE1_DOC_TO_COMPLETE_BTN_GAP}px 16px ${16 + STAGE1_CARD_SHADOW_BOTTOM_PAD_PX}px 16px`,
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: mainViewGridTemplate,
              gridTemplateRows: 'minmax(0, 1fr) auto',
              rowGap: STAGE1_DOC_TO_COMPLETE_BTN_GAP,
              columnGap: 16,
              flex: 1,
              minHeight: 0,
              /* visible: иначе box-shadow карточек (документы / доска) обрезается снизу у края сетки */
              overflow: 'visible',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
          >
      {/* Чат с руководителем проекта перенесён в Simugram */}

      <div
        ref={documentPanelRef}
        data-tutor-highlight="stage1_document_list"
        style={{
          gridColumn: 1,
          gridRow: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'visible',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            height: notesBoardHudPaddingTop,
            minHeight: notesBoardHudPaddingTop,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingBottom: 8,
            boxSizing: 'border-box',
          }}
        >
          {showDocNavArrows ? (
            <Stage1DocNavArrows
              prevDoc={prevNavDoc}
              nextDoc={nextNavDoc}
              onNavigate={handleOpenDoc}
              titleSlotWidthPx={docNavTitleSlotWidthPx}
            />
          ) : null}
        </div>
        <div
          style={{
            background: '#ffffff',
            borderRadius: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            padding: '16px 20px 20px 20px',
            position: 'relative',
            boxSizing: 'border-box',
          }}
        >
        {selectedDoc ? (
          <button
            type="button"
            onClick={() => handleCloseDoc(selectedDoc.id)}
            title={isBriefDocId(selectedDoc.id) ? 'Закрыть бриф' : 'Закрыть документ'}
            aria-label={isBriefDocId(selectedDoc.id) ? 'Закрыть бриф' : 'Закрыть документ'}
            style={{
              position: 'absolute',
              top: STAGE1_DOC_CLOSE_TOP_PX,
              right: STAGE1_DOC_CLOSE_RIGHT_PX,
              zIndex: 5,
              background: 'none',
              border: 'none',
              fontSize: 16,
              fontWeight: 700,
              cursor: 'pointer',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              width: STAGE1_DOC_CLOSE_SIZE_PX,
              height: STAGE1_DOC_CLOSE_SIZE_PX,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#6b7280',
              transition: 'background 0.15s, color 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f1f5f9';
              e.currentTarget.style.color = '#1e293b';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'none';
              e.currentTarget.style.color = '#6b7280';
            }}
          >
            ✕
          </button>
        ) : null}
        {selectedDoc ? (
          isBriefDocId(selectedDoc.id) ? (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', height: '100%' }}>
              <div data-tutor-highlight="stage1_brief_area" style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ background: '#ffffff', borderRadius: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', minHeight: 0, overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ flexShrink: 0, padding: '0 20px 0 20px' }}>
                  <h3
                    style={{
                      margin: 0,
                      marginBottom: 8,
                      ...T.H3,
                      fontSize: 22,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      paddingRight: STAGE1_DOC_TITLE_PAD_RIGHT_FOR_CLOSE_PX,
                      boxSizing: 'border-box',
                    }}
                  >
                    Бриф
                  </h3>
                  <BriefInsightIconTooltip
                    text="Проверить качество заметки можно после того, как вы привязали её к блоку брифа. Количество попыток ИИ-проверки на этап ограничено."
                    placement="below"
                    maxWidth={300}
                    textAlign="left"
                  >
                    <span
                      style={{
                        ...T.S,
                        color: STAGE1_HINT_TEXT_COLOR,
                        fontWeight: 600,
                        textAlign: 'left',
                        cursor: 'help',
                        display: 'inline-block',
                        margin: '8px 0 16px 0',
                      }}
                    >
                      Проверка качества: {insightEvalUsedCount}/{MAX_INSIGHT_EVAL_ATTEMPTS}
                    </span>
                  </BriefInsightIconTooltip>
                </div>
                <div
                  ref={briefScrollRef}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: 'auto',
                    padding: '0 20px 16px 20px',
                    userSelect: 'text',
                    WebkitUserSelect: 'text',
                  }}
                >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {attributes.map((attr) => {
                    const isConclusion = attr.type === 'conclusion';
                    const docReqs = Array.isArray(attr.document_requirements) ? attr.document_requirements : [];
                    // Для бейджа "подтверждено документом" используем реальный список документов в панели
                    // (stage.documents + уже приложенные через чат), а не только session.stage1_requested_documents,
                    // иначе бейдж может не появиться до прихода обновлённой сессии.
                    const docsForBadges = documents || [];
                    const hasVerifiedDoc =
                      docReqs.length > 0 &&
                      docReqs.some((r) => r?.document_id && docsForBadges.some((d) => d?.id === r.document_id));
                    const hasVerifiedDocBadge = hasVerifiedDoc;
                    return (
                    <div
                      key={attr.id}
                        ref={isConclusion ? conclusionBlockRef : undefined}
                        onDragOver={isConclusion ? undefined : handleDragOver}
                        onDrop={isConclusion ? undefined : (e) => handleDropOnAttr(e, attr.id)}
                      style={{
                        ...(isConclusion ? BRIEF_BLOCK.cardConclusion : BRIEF_BLOCK.card),
                        minHeight: 60,
                        boxSizing: 'border-box',
                      }}
                    >
                        <div style={{ marginBottom: isConclusion ? 8 : 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                            <span style={{ ...T.H4, color: BRIEF_BLOCK.headingColor, fontWeight: 700 }}>{attr.title}</span>
                            {hasVerifiedDocBadge && (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  padding: '2px 8px',
                                  borderRadius: 999,
                                  background: '#ecfdf5',
                                  color: '#065f46',
                                  ...T.S,
                                  fontSize: 11,
                                  fontWeight: 700,
                                }}
                                title="Подтверждающий документ по этому блоку уже запрошен"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                  <path d="M14 2v6h6" />
                                  <path d="M9 15l2 2 4-4" />
                                </svg>
                                {docReqs?.[0]?.label || 'Документ'}
                              </span>
                            )}
                            {attr.description && (
                              <BriefInsightIconTooltip
                                text={attr.description}
                                placement="above"
                                maxWidth={320}
                                textAlign="left"
                              >
                            <button
                              type="button"
                                  aria-label="Описание блока"
                              style={{
                                    width: 20,
                                    height: 20,
                                    padding: 0,
                                    border: 'none',
                                    borderRadius: '50%',
                                    background: 'transparent',
                                    color: STAGE1_HINT_TEXT_COLOR,
                                    cursor: 'help',
                                    ...T.S,
                                    fontWeight: 700,
                                    lineHeight: 1,
                                    flexShrink: 0,
                                  }}
                                >
                                  ?
                                </button>
                              </BriefInsightIconTooltip>
                            )}
                          </div>
                          {!isConclusion && <div style={BRIEF_BLOCK.accentLine} aria-hidden />}
                        </div>
                        {isConclusion ? (
                          <textarea
                            value={conclusionText}
                            onChange={(e) => setConclusionText(e.target.value)}
                            placeholder="Укажите правовую природу договора (тип сделки)…"
                            rows={4}
                            style={{
                              width: '100%',
                              padding: '8px 10px',
                              border: '1px solid #e5e7eb',
                              borderRadius: 6,
                              background: 'white',
                              ...T.P,
                              lineHeight: 1.5,
                              resize: 'none',
                              boxSizing: 'border-box',
                              fontFamily: 'inherit',
                            }}
                          />
                        ) : (
                          <>
                            {!(showManualInsightForm && manualInsightAttrId === attr.id) && (
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: BRIEF_NOTE_MARKER_GAP,
                                  marginBottom: 8,
                                }}
                              >
                                <span
                                  aria-hidden
                                  style={{
                                    minWidth: BRIEF_NOTE_MARKER_COL_MIN_WIDTH,
                                    flexShrink: 0,
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() => openManualNoteForBriefAttr(attr.id)}
                                  style={{
                                    padding: '6px 0',
                                    minHeight: 32,
                                    boxSizing: 'border-box',
                                    ...T.B,
                                    fontSize: 12,
                                    color: STAGE1_HINT_TEXT_COLOR,
                                    background: 'transparent',
                                    border: 'none',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    textDecoration: 'underline',
                                    textUnderlineOffset: 2,
                                  }}
                                >
                                  + Добавить заметку вручную
                                </button>
                              </div>
                            )}
                            {showManualInsightForm && manualInsightAttrId === attr.id && (
                              <div style={{ marginBottom: 10 }}>
                                <div
                                  style={{
                                    display: 'flex',
                                    gap: BRIEF_NOTE_MARKER_GAP,
                                    alignItems: 'flex-start',
                                  }}
                                >
                                  <span
                                    aria-hidden
                                    style={{
                                      color: '#374151',
                                      flexShrink: 0,
                                      marginTop: 3,
                                      minWidth: BRIEF_NOTE_MARKER_COL_MIN_WIDTH,
                                      textAlign: 'center',
                                    }}
                                  >
                                    •
                                  </span>
                                  <textarea
                                    ref={manualInsightTextareaRef}
                                    value={manualInsightText}
                                    onChange={(e) => setManualInsightText(e.target.value)}
                                    placeholder="Введите заметку…"
                                    rows={1}
                                    style={{
                                      flex: 1,
                                      minWidth: 0,
                                      minHeight: 22,
                                      border: 'none',
                                      background: 'transparent',
                                      outline: 'none',
                                      boxShadow: 'none',
                                      ...T.P,
                                      lineHeight: 1.5,
                                      resize: 'none',
                                      overflow: 'hidden',
                                      fontFamily: 'inherit',
                                      padding: '2px 0',
                                      color: '#374151',
                                    }}
                                    onFocus={(e) => {
                                      e.target.style.boxShadow = 'inset 0 -1px 0 0 #cbd5e1';
                                    }}
                                    onBlur={(e) => {
                                      e.target.style.boxShadow = 'none';
                                    }}
                                    autoFocus
                                  />
                                </div>
                                <div
                                  style={{
                                    display: 'flex',
                                    gap: 8,
                                    marginTop: 6,
                                    paddingLeft: BRIEF_NOTE_MARKER_COL_MIN_WIDTH + BRIEF_NOTE_MARKER_GAP,
                                  }}
                                >
                                  <button
                                    type="button"
                                    onClick={saveManualNoteFromBrief}
                                    style={{
                                      padding: '4px 10px',
                                      minHeight: 28,
                                      boxSizing: 'border-box',
                                      ...T.B,
                                      fontSize: 12,
                                      color: '#000000',
                                      background: '#e0e7ff',
                                      border: 'none',
                                      borderRadius: 4,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Сохранить
                                  </button>
                                  <button
                                    type="button"
                                    onClick={cancelManualNoteFromBrief}
                                    style={{
                                      padding: '4px 10px',
                                      minHeight: 28,
                                      boxSizing: 'border-box',
                                      ...T.B,
                                      fontSize: 12,
                                      color: '#000000',
                                      background: 'transparent',
                                      border: 'none',
                                      borderRadius: 4,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Отмена
                                  </button>
                                </div>
                              </div>
                            )}
                            <ul
                              style={{
                                listStyle: 'none',
                                paddingLeft: 0,
                                margin: '0 0 0 0',
                                ...T.P,
                                lineHeight: 1.5,
                                color: '#374151',
                                wordBreak: 'break-word',
                              }}
                            >
                              {(insightsByAttribute[attr.id] || []).map((insightId) => {
                                const insight = insights.find((i) => i.id === insightId);
                                if (!insight) return null;
                                const qualityEval = insightEvaluationsById[insightId];
                                const evalCollapsed = insightEvalCollapsedById[insightId] === true;
                                const evalBusy = evaluatingInsightId === insightId && insightEvaluationLoading;
                                const evalInsightDisabled =
                                  !insight.text?.trim() ||
                                  insightEvalUsedCount >= MAX_INSIGHT_EVAL_ATTEMPTS ||
                                  evalBusy;
                                const evalScore = typeof qualityEval?.score === 'number' ? qualityEval.score : null;
                                let evalAccentColor = '#e5e7eb';
                                let evalLabel = '';
                                if (evalScore !== null) {
                                  if (evalScore >= 80) {
                                    evalLabel = 'Отлично';
                                    evalAccentColor = '#22c55e';
                                  } else if (evalScore >= 50) {
                                    evalLabel = 'Можно лучше';
                                    evalAccentColor = '#f59e0b';
                                  } else {
                                    evalLabel = 'Требует доработки';
                                    evalAccentColor = '#ef4444';
                                  }
                                }
                                const evalInsightTitle = !insight.text?.trim()
                                  ? 'проверить качество — сначала введите текст заметки'
                                  : insightEvalUsedCount >= MAX_INSIGHT_EVAL_ATTEMPTS
                                    ? 'проверить качество — лимит проверок на этап исчерпан'
                                    : evalBusy
                                      ? 'проверка качества…'
                                      : 'проверить качество';
                                return (
                                  <li key={insightId} style={{ marginTop: 8, paddingBottom: 8, borderBottom: '1px solid #f1f5f9' }}>
                                    <div
                                      style={{
                                        display: 'flex',
                                        gap: BRIEF_NOTE_MARKER_GAP,
                                        alignItems: 'flex-start',
                                      }}
                                    >
                                      <span
                                        aria-hidden
                                        style={{
                                          color: '#374151',
                                          flexShrink: 0,
                                          marginTop: 2,
                                          minWidth: BRIEF_NOTE_MARKER_COL_MIN_WIDTH,
                                          textAlign: 'center',
                                        }}
                                      >
                                        •
                                      </span>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        {editingInsightId === insightId ? (
                                          <div>
                                            <textarea
                                              ref={editTextareaRef}
                                              value={editingInsightText}
                                              onChange={(e) => setEditingInsightText(e.target.value)}
                                              onFocus={() => setEditingInsightFocused(true)}
                                              onBlur={() => setEditingInsightFocused(false)}
                                              onKeyDown={(e) => {
                                                if (e.key === 'Escape') cancelEditInsight();
                                              }}
                                              placeholder="Текст заметки"
                                              rows={3}
                                              style={{
                                                width: '100%',
                                                boxSizing: 'border-box',
                                                padding: 8,
                                                border: '1px solid #e5e7eb',
                                                borderColor: editingInsightFocused ? '#d1d5db' : '#e5e7eb',
                                                borderRadius: 6,
                                                outline: 'none',
                                                ...T.P,
                                                resize: 'none',
                                                minHeight: 100,
                                                overflow: 'hidden',
                                              }}
                                              autoFocus
                                            />
                                            {editingInsightText.trim().length > INSIGHT_MAX_LENGTH && (
                                              <p style={{ margin: '4px 0 0 0', ...T.S, color: STAGE1_HINT_TEXT_COLOR }}>
                                                Выделение ограничено {INSIGHT_MAX_LENGTH} символами
                                              </p>
                                            )}
                                            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                                              <button
                                                type="button"
                                                onClick={() => saveEditInsight()}
                                                style={{
                                                  padding: '6px 12px',
                                                  minHeight: 32,
                                                  boxSizing: 'border-box',
                                                  ...T.B,
                                                  fontSize: 12,
                                                  color: '#000000',
                                                  background: '#e0e7ff',
                                                  border: 'none',
                                                  borderRadius: 4,
                                                  cursor: 'pointer',
                                                }}
                                              >
                                                Сохранить
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => cancelEditInsight()}
                                                style={{
                                                  padding: '6px 12px',
                                                  minHeight: 32,
                                                  boxSizing: 'border-box',
                                                  ...T.B,
                                                  fontSize: 12,
                                                  color: '#000000',
                                                  background: '#e5e7eb',
                                                  border: 'none',
                                                  borderRadius: 4,
                                                  cursor: 'pointer',
                                                }}
                                              >
                                                Отмена
                                              </button>
                                            </div>
                                          </div>
                                        ) : (
                                          <div style={{ ...T.P, lineHeight: 1.5, color: '#374151', wordBreak: 'break-word' }}>
                                            {insight.text}
                                          </div>
                                        )}
                                        {qualityEval && (
                                          <div
                                            style={{
                                              marginTop: 8,
                                              boxSizing: 'border-box',
                                              padding: 8,
                                              background: '#f8fafc',
                                              borderRadius: 6,
                                              borderLeft: evalAccentColor !== '#e5e7eb' ? `3px solid ${evalAccentColor}` : 'none',
                                              ...T.S,
                                            }}
                                          >
                                            <div
                                              style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: 8,
                                              }}
                                            >
                                              <p style={{ margin: 0, ...T.B, flex: 1, minWidth: 0 }}>
                                                {evalLabel ? evalLabel : 'Оценка: —'}
                                              </p>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  setInsightEvalCollapsedById((prev) => ({
                                                    ...prev,
                                                    [insightId]: !prev[insightId],
                                                  }))
                                                }
                                                aria-expanded={!evalCollapsed}
                                                title={evalCollapsed ? 'Развернуть подробности' : 'Свернуть подробности'}
                                                style={{
                                                  flexShrink: 0,
                                                  width: 28,
                                                  height: 28,
                                padding: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                                  background: 'transparent',
                                                  border: 'none',
                                                  borderRadius: 4,
                                cursor: 'pointer',
                                                  color: STAGE1_HINT_TEXT_COLOR,
                              }}
                            >
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                  {evalCollapsed ? <path d="M6 9l6 6 6-6" /> : <path d="M18 15l-6-6-6 6" />}
                                                </svg>
                            </button>
                          </div>
                                            {!evalCollapsed && (
                                              <>
                                                <p style={{ margin: '8px 0 4px 0', color: '#475569', ...T.P }}>{qualityEval.feedback}</p>
                                                {Array.isArray(qualityEval.pending_documents) && qualityEval.pending_documents.length > 0 && (
                                                  <p style={{ margin: '0 0 6px 0', color: '#92400e', fontStyle: 'italic', ...T.P }}>
                                                    Есть ли документальное подтверждение этих данных?
                                                  </p>
                                                )}
                                                {qualityEval.noise_note && (
                                                  <p style={{ margin: '8px 0 4px 0', color: '#475569', ...T.P }}>
                                                    {qualityEval.noise_note}
                                                  </p>
                                                )}
                                                {Array.isArray(qualityEval.guiding_questions) && qualityEval.guiding_questions.length > 0 && (
                                                  <div style={{ margin: '4px 0 0 0' }}>
                                                    <p style={{ margin: '0 0 4px 0', ...T.B, color: '#334155' }}>Для самопроверки:</p>
                                                    <ul style={{ margin: 0, paddingLeft: 18, color: '#475569', ...T.P }}>
                                                      {qualityEval.guiding_questions.map((q, qi) => (
                                                        <li key={qi} style={{ marginBottom: 4 }}>
                                                          {q}
                                                        </li>
                                                      ))}
                                                    </ul>
                      </div>
                                                )}
                                              </>
                                            )}
                    </div>
                                        )}
                </div>
                                      {editingInsightId !== insightId && (
                                        <div style={{ display: 'flex', gap: 2, flexShrink: 0, alignItems: 'flex-start' }}>
                                          <BriefInsightIconTooltip text="вернуть на доску">
                                            <button
                                              type="button"
                                              onClick={() => handleUnassignInsight(insightId, attr.id)}
                                              aria-label="вернуть на доску"
                                              style={BRIEF_ROW_ICON_BTN}
                                              onMouseEnter={(e) => {
                                                e.currentTarget.style.background = '#f1f5f9';
                                              }}
                                              onMouseLeave={(e) => {
                                                e.currentTarget.style.background = 'transparent';
                                              }}
                                            >
                                              <span style={{ ...T.S, lineHeight: 1 }}>↩</span>
                                            </button>
                                          </BriefInsightIconTooltip>
                                          <BriefInsightIconTooltip text="редактировать">
                                            <button
                                              type="button"
                                              onClick={() => startEditInsight(insightId)}
                                              aria-label="редактировать"
                                              style={BRIEF_ROW_ICON_BTN}
                                              onMouseEnter={(e) => {
                                                e.currentTarget.style.background = '#f1f5f9';
                                              }}
                                              onMouseLeave={(e) => {
                                                e.currentTarget.style.background = 'transparent';
                                              }}
                                            >
                                              <span style={{ ...T.S, lineHeight: 1 }} aria-hidden>
                                                ✎
                                              </span>
                                            </button>
                                          </BriefInsightIconTooltip>
                                          {!qualityEval && (
                                            <BriefInsightIconTooltip text={evalInsightTitle}>
                                              <button
                                                type="button"
                                                aria-disabled={evalInsightDisabled}
                                                aria-label={evalInsightTitle}
                                                onClick={(e) => {
                                                  if (evalInsightDisabled) {
                                                    e.preventDefault();
                                                    return;
                                                  }
                                                  handleEvaluateInsight(insightId);
                                                }}
                                                onKeyDown={(e) => {
                                                  if (
                                                    evalInsightDisabled &&
                                                    (e.key === 'Enter' || e.key === ' ')
                                                  ) {
                                                    e.preventDefault();
                                                  }
                                                }}
                                                style={{
                                                  ...BRIEF_ROW_ICON_BTN,
                                                  cursor: evalInsightDisabled ? 'not-allowed' : 'pointer',
                                                  opacity:
                                                    (!insight.text?.trim() ||
                                                      insightEvalUsedCount >= MAX_INSIGHT_EVAL_ATTEMPTS) &&
                                                    !evalBusy
                                                      ? 0.45
                                                      : 1,
                                                }}
                                                onMouseEnter={(e) => {
                                                  if (!evalInsightDisabled) e.currentTarget.style.background = '#f1f5f9';
                                                }}
                                                onMouseLeave={(e) => {
                                                  e.currentTarget.style.background = 'transparent';
                                                }}
                                              >
                                                <span style={{ ...T.S, lineHeight: 1 }} aria-hidden>
                                                  {evalBusy ? '…' : '✨'}
                                                </span>
                                              </button>
                                            </BriefInsightIconTooltip>
                                          )}
              </div>
                                      )}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                            {(insightsByAttribute[attr.id] || []).length === 0 && (
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: BRIEF_NOTE_MARKER_GAP,
                                  marginTop: 6,
                                  padding: '6px 0',
                                  color: STAGE1_HINT_TEXT_COLOR,
                                  ...T.S,
                                  lineHeight: 1.4,
                                }}
                              >
                                <span
                                  aria-hidden
                                  style={{
                                    minWidth: BRIEF_NOTE_MARKER_COL_MIN_WIDTH,
                                    flexShrink: 0,
                                  }}
                                />
                                <span>Перетащите заметку с доски сюда</span>
                              </div>
                            )}
                          </>
                        )}
          </div>
                    );
                  })}
                </div>
                </div>
              </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', height: '100%' }}>
              <h3
                style={{
                  margin: 0,
                  marginBottom: 16,
                  ...T.H3,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  paddingRight: STAGE1_DOC_TITLE_PAD_RIGHT_FOR_CLOSE_PX,
                  boxSizing: 'border-box',
                  flexShrink: 0,
                }}
              >
                {selectedDoc.title}
              </h3>
              <p style={{ ...T.S, color: STAGE1_HINT_TEXT_COLOR, margin: '0 0 12px 0', userSelect: 'none', WebkitUserSelect: 'none', flexShrink: 0 }}>
                Выделите текст в документе и нажмите «Добавить как заметку» в появившейся панели
              </p>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                <div style={{ overflow: 'hidden', flex: '0 0 auto', width: '100%', paddingRight: 16 }}>
                  <div
                    ref={documentContentRef}
                    style={{ ...T.P, lineHeight: 1.6, color: '#374151', userSelect: 'text', WebkitUserSelect: 'text', width: '100%' }}
                  >
                    {selectedDoc.content ? (
                      <MarkdownContent content={selectedDoc.content} />
                    ) : (
                      <p style={{ color: STAGE1_HINT_TEXT_COLOR }}>Контент документа не загружен.</p>
                    )}
                  </div>
                </div>
              </div>
              {pendingInsightText ? (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    background: '#ffffff',
                    border: '2px solid #10b981',
                    borderRadius: 8,
                    boxShadow: '0 2px 8px rgba(16,185,129,0.12)',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                  }}
                >
                  <p style={{ ...T.B, fontSize: 12, color: '#000000', margin: '0 0 8px 0' }}>
                    Добавить на доску собранной информации?
                  </p>
                  {selectionTruncated && (
                    <p style={{ ...T.S, color: STAGE1_HINT_TEXT_COLOR, margin: '0 0 6px 0' }}>
                      Выделение ограничено {INSIGHT_MAX_LENGTH} символами.
                    </p>
                  )}
                  <p
                    style={{
                      ...T.P,
                      lineHeight: 1.5,
                      color: '#374151',
                      margin: '0 0 12px 0',
                      wordBreak: 'break-word',
                      maxHeight: 60,
                      overflow: 'auto',
                    }}
                  >
                    «{pendingInsightText.length > 80 ? pendingInsightText.slice(0, 80) + '…' : pendingInsightText}»
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={handleConfirmAddInsight}
                      style={{
                        padding: '6px 12px',
                        minHeight: 32,
                        boxSizing: 'border-box',
                        ...T.B,
                        fontSize: 12,
                        color: '#000000',
                        background: '#e0e7ff',
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                      }}
                    >
                      Добавить как заметку
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelPendingInsight}
                      style={{
                        padding: '6px 12px',
                        minHeight: 32,
                        boxSizing: 'border-box',
                        ...T.B,
                        fontSize: 12,
                        color: '#000000',
                        background: '#e5e7eb',
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                      }}
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        ) : (
          <div
            data-tutor-highlight="stage1_view_toggle"
            style={{
              flex: 1,
              minHeight: 0,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0,
              paddingLeft: 12,
              paddingRight: 12,
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                width: '100%',
                boxSizing: 'border-box',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start',
                flexWrap: 'wrap',
                gap: 28,
              }}
            >
              {documentIconsForGrid.map((doc) => (
                <Stage1DocGridItem
                  key={doc.id}
                  doc={doc}
                  onOpen={handleOpenDoc}
                  showHints={documentIconsForGrid.length <= 2}
                />
              ))}
            </div>
          </div>
        )}
        </div>
        </div>
      </div>

      <div
        data-tutor-highlight="stage1_attributes_column"
        style={{
          gridColumn: 2,
          gridRow: '1 / -1',
          minWidth: 136,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'visible',
          paddingTop: notesBoardHudPaddingTop,
          boxSizing: 'border-box',
        }}
      >
      <div
        style={{
          background: '#ffffff',
          borderRadius: 10,
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          minHeight: 0,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <div style={{ padding: 16, paddingBottom: 0, flexShrink: 0, boxSizing: 'border-box' }}>
          <h3 style={{ margin: 0, ...T.H3 }}>Доска собранной информации</h3>
          {isBriefOpen ? (
            <p
              style={{
                ...T.S,
                margin: '10px 0 0 0',
                color: STAGE1_HINT_TEXT_COLOR,
                lineHeight: 1.45,
                userSelect: 'text',
                WebkitUserSelect: 'text',
              }}
            >
              Редактировать и проверять качество заметки можно после переноса в бриф.
              Здесь отображаются только заметки, ещё не привязанные к брифу
            </p>
          ) : null}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginTop: 12,
            marginBottom: 16,
            flex: 1,
            minHeight: 0,
            padding: 16,
            paddingTop: 0,
            boxSizing: 'border-box',
          }}
        >
          {stage1BoardUnassignedInsights.length === 0 ? (
            <div
              style={{
                flex: 1,
                minHeight: 140,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px 8px',
              }}
            >
              <p
                style={{
                  ...T.S,
                  margin: 0,
                  maxWidth: 300,
                  textAlign: 'center',
                  color: STAGE1_HINT_TEXT_COLOR,
                  lineHeight: 1.5,
                  userSelect: 'text',
                  WebkitUserSelect: 'text',
                }}
              >
                Сюда сохраняются заметки из документов и чата — затем их можно перенести в бриф
              </p>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
              }}
            >
              {stage1BoardUnassignedInsights.map((i) => (
            <div
              key={i.id}
              draggable={isBriefOpen}
              onDragStart={isBriefOpen ? (e) => handleDragStart(e, i.id) : undefined}
              onDragEnd={isBriefOpen ? handleDragEnd : undefined}
              style={{
                    position: 'relative',
                    padding: '12px 32px 12px 14px',
                    background: 'white',
                    border: '1px solid #e5e7eb',
                borderRadius: 8,
                    boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
                    ...T.P,
                lineHeight: 1.5,
                    color: '#000000',
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
                    cursor: isBriefOpen ? 'grab' : 'default',
                    opacity: isBriefOpen && draggedInsightId === i.id ? 0.5 : 1,
              }}
            >
          <button
            type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveInsight(i.id); }}
                    title="Удалить заметку с доски"
            style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      width: 22,
                      height: 22,
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'transparent',
                      color: STAGE1_HINT_TEXT_COLOR,
              border: 'none',
                      borderRadius: 4,
              cursor: 'pointer',
                      fontSize: 18,
                      lineHeight: 1,
            }}
          >
                    ×
          </button>
                  <div style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>{i.text}</div>
        </div>
              ))}
            </div>
          )}
      </div>
      </div>
      </div>
        <div
          style={{
            gridColumn: 1,
            gridRow: 2,
            minWidth: 0,
            boxSizing: 'border-box',
            paddingTop: 0,
            borderTop: `${STAGE1_COMPLETE_BTN_BORDER_PX}px solid #e5e7eb`,
          }}
        >
          <button
            type="button"
            onClick={handleCompleteStage}
            disabled={!!stageCompleteInFlight}
            aria-busy={!!stageCompleteInFlight}
            style={{
              width: '100%',
              padding: '10px 16px',
              background: stageCompleteInFlight ? '#6ee7b7' : '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              cursor: stageCompleteInFlight ? 'wait' : 'pointer',
              ...T.B,
              boxShadow: stageCompleteInFlight ? 'none' : '0 2px 6px rgba(16,185,129,0.3)',
              opacity: stageCompleteInFlight ? 0.92 : 1,
            }}
          >
            {stageCompleteInFlight ? 'Сохранение и переход на следующий этап…' : 'Отправить бриф. Завершить этап'}
          </button>
        </div>
          </div>
        </div>
      </div>
        {confirmRemoveInsightId && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
              zIndex: 1001,
            padding: 20,
          }}
        >
          <div
            style={{
              background: 'white',
              padding: 24,
              borderRadius: 8,
              boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
                maxWidth: 360,
              }}
            >
              <p style={{ margin: '0 0 20px 0', ...T.P }}>Вы уверены, что хотите удалить заметку с доски?</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setConfirmRemoveInsightId(null)}
                  style={{ padding: '8px 16px', background: '#e5e7eb', border: 'none', borderRadius: 6, cursor: 'pointer', ...T.P }}
                >
                  Отмена
                </button>
              <button
                type="button"
                  onClick={() => doRemoveInsight(confirmRemoveInsightId)}
                  style={{ padding: '8px 16px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', ...T.P }}
                >
                  Удалить
              </button>
            </div>
          </div>
        </div>
      )}
        {timeExpiredSnackbar}
      </>
  );
}