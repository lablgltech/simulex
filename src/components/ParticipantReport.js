import React, { useState, useEffect, useMemo, useRef } from 'react';
import LexicRadarChart from './LexicRadarChart';
import TrajectoryChart from './TrajectoryChart';
import { getApiUrl, getAuthHeaders } from '../api/config';
import { getSummaryGrade } from '../utils/reportSummaryGrade';
import { userHasQaTrackerAccess } from '../config/qaTracker';

/**
 * Персонализированный отчёт для участника симуляции.
 * Вкладка «Профиль»: карточки осей и радар — по **игровому** LEXIC (`final_lexic`, после согласованности L/I),
 * т.е. прямой итог правил симулятора. Нормализованная эталонная шкала и поэтапные снимки — «Динамика» и «Разбор LEXIC».
 * showParticipantStageTabs — для дашборда руководителя: вкладки «Динамика» и «По этапам» без «Моста».
 *
 * Props:
 *   report  — объект отчёта из /api/report/generate или /api/report/participant/{id}
 */

const PARAM_META = {
  L: { label: 'Легитимность', icon: '⚖️', color: '#3b82f6',
       desc: 'Соблюдение регламентов, процедур и правовых оснований' },
  E: { label: 'Эффективность', icon: '⚡', color: '#10b981',
       desc: 'Оптимальное использование времени и ресурсов' },
  X: { label: 'Экспертиза', icon: '🔍', color: '#f59e0b',
       desc: 'Глубина анализа, качество оценки рисков' },
  I: { label: 'Интересы', icon: '🛡️', color: '#ef4444',
       desc: 'Защита компании, баланс рисков, сохранение репутации' },
  C: { label: 'Ясность', icon: '💡', color: '#8b5cf6',
       desc: 'Чёткость формулировок, понятность для бизнеса' },
};

const PARAMS = ['L', 'E', 'X', 'I', 'C'];

/** Текст для блока «Зоны развития»: отдельные фразы, без шаблона с ошибочным согласованием. */
const LEXIC_GROWTH_ZONE_COPY = {
  L:
    'Опирайтесь на легенду кейса, полномочия и процедуру: так проще выстроить позицию, которую потом можно отстаивать в переговорах и в правке договора.',
  E:
    'Планируйте порядок действий и следите за лимитами этапа: сфокусированная работа экономит время и снижает «лишние» итерации по тексту.',
  X:
    'Углубляйте разбор фактов, рисков и применимых норм — от этого зависит точность выводов и уверенность в спорных пунктах.',
  I:
    'Тренируйте баланс защиты интересов компании и репутационных рисков: важно не уйти ни в необоснованную жёсткость, ни в уступки в ущерб бизнесу.',
  C:
    'Практикуйте формулировки, понятные бизнесу и контрагенту: ясный текст реже ломает согласование и снижает риск недопонимания.',
};

const LEVEL_COLORS = {
  outstanding: '#10b981',
  good: '#3b82f6',
  average: '#f59e0b',
  below_average: '#f97316',
  critical: '#ef4444',
};

/** Как backend/services/normalization_service.get_lexic_level — рамка карточки совпадает с показанным баллом */
function lexicLevelKeyFromScore(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 'average';
  if (s >= 85) return 'outstanding';
  if (s >= 70) return 'good';
  if (s >= 50) return 'average';
  if (s >= 30) return 'below_average';
  return 'critical';
}

/**
 * Витрина вкладки «Профиль»: всегда игровой итог (`final_lexic`), а не нормализация по этапам.
 * Нормализованный профиль измеряет долю «теоретического прироста» на этапах и для «как отыграл в симуляторе»
 * воспринимается хуже; он остаётся на «Динамика» / «Разбор LEXIC».
 */
function resolveReportDisplayLexic(report) {
  if (!report) return { displayLexic: {} };
  const raw = report.final_lexic || {};
  const displayLexic = {};
  PARAMS.forEach((p) => {
    displayLexic[p] = Math.round(Number(raw[p]) || 50);
  });
  return { displayLexic };
}

/** Согласовано с Stage4View (OUTCOMES) — текст для отчёта без импорта экрана этапа */
const STAGE4_OUTCOME_DETAILS = {
  failed: {
    headline: 'Диагностика не открыла возврат к договору',
    timeline: ['Через 6 месяцев — кризис сохраняется'],
    detail:
      'Стоит пересмотреть степень угрозы, правовое основание и первоочередную меру — от этого зависит появление опции возврата.',
  },
  accept: {
    headline: 'Принятие последствий без возврата к тексту договора',
    timeline: [
      'На таймлайне остаётся точка кризиса',
      'Компания осознанно идёт в переговоры или доплату — решение управляемое при верной диагностике',
    ],
    detail:
      'Исход зависит от корректности диагностики и выбранной первоочередной меры (как в туториале этапа 4).',
  },
  repeat: {
    headline: 'Возврат к договору не устранил правовое основание кризиса',
    timeline: [
      'Исполнение продолжается',
      'Кризис реализуется; последствия зависят от выбранной первоочередной меры',
    ],
    detail:
      'Правки не сняли причину — по сценарию возможна красная точка на таймлайне и описание реализовавшегося исхода.',
  },
  fixed: {
    headline: 'После правок формулировки исключают заявленную претензию',
    timeline: [
      'Исполнение по скорректированному договору',
      'Кризис по данному основанию не возникает; возможны вторичные бизнес-трения',
    ],
    detail:
      'На экране симулятора показывается обоснование по выбранным пунктам (варианты A/B/C, таймер редактирования).',
  },
  noChange: {
    headline: 'Возврат к договору без фактических изменений пунктов',
    timeline: [
      'Исполнение идёт по прежним формулировкам',
      'Далее в сценарии наступает второй кризис (иное основание или внешняя угроза)',
    ],
    detail:
      'По туториалу: неизменённые пункты могут стать основанием повторного кризиса; на втором круге договор уже не редактируется.',
  },
};

const STAGE2_TAG_KEYS = ['legal', 'financial', 'operational', 'reputational'];

/** Сводка по типам риска (чипы) из полного stage2_report.clause_results */
function computeStage2RiskTypeTagStats(stage2Report) {
  const rows = Array.isArray(stage2Report?.clause_results) ? stage2Report.clause_results : [];
  let correct = 0;
  let wrong = 0;
  let missed = 0;
  let expectedSlots = 0;
  for (const row of rows) {
    if (!row?.user_selected) continue;
    const tr = row.tag_results || {};
    const ctags = Array.isArray(row.correct_tags) ? row.correct_tags : [];
    expectedSlots += ctags.length;
    for (const t of STAGE2_TAG_KEYS) {
      const v = tr[t];
      if (v === 'ok') correct += 1;
      else if (v === 'wrong') wrong += 1;
      else if (v === 'missed') missed += 1;
    }
  }
  return { correct, wrong, missed, expectedSlots };
}

/** Подробные подсказки для модалки «?» на карточке параметра */
const LEXIC_PARAM_HELP = {
  L: {
    whatItIs:
      'Параметр отражает, насколько ваши решения в симуляции соответствуют заложенным в кейс ожиданиям: легенде, гайду, матрице рисков и процедурным требованиям — то есть насколько вы действуете как юрист, который опирается на нормы, договорённости и внутренние стандарты компании.',
    howCalculated:
      'В ходе этапов движок начисляет изменения L за конкретные действия (верно отмеченные риски, доп. условия к договору, переговоры и т.д.). В этом отчёте на вкладке «Профиль» показан итоговый сырой LEXIC сессии (0–100). Нормализованная разбивка по этапам — на вкладке «Динамика».',
    howToImprove:
      'Внимательно опирайтесь на легенду и справочные материалы кейса. На этапе анализа контекста — полнота выводов и вопросов к инициатору. На этапе рисков — не пропускайте пункты из матрицы, не отмечайте лишнее, корректно заполняйте «облако» недостающих условий. В переговорах и кризисных ветках — последовательность и уважение к процедуре.',
    whyMatters:
      'Для практикующего юриста легитимность — основа доверия: суды, регуляторы и контрагенты оценивают не только результат, но и то, был ли путь к нему процедурно чистым и обоснованным.',
  },
  E: {
    whatItIs:
      'Эффективность в симуляторе — это рациональное использование ограниченных ресурсов (виртуального времени и очков) и укладывание в лимиты там, где они заданы сценарием.',
    howCalculated:
      'За этапы с таймингом (например, этап 2) начисляются бонусы за укладывание в лимит времени и штрафы за перерасход. Другие действия могут косвенно влиять на E через трату ресурсов. На вкладке «Профиль» показан итоговый игровой E (0–100), как в движке после прохождения этапов.',
    howToImprove:
      'Планируйте порядок действий, не выполняйте заведомо лишние шаги, следите за таймером и бюджетом очков на этапе. Перед «Готово» убедитесь, что обязательные действия закрыты без лишних итераций.',
    whyMatters:
      'В работе юриста время и фокус — дефицитные ресурсы: эффективность определяет, успеете ли вы закрыть сделку, пройти согласование и не сжечь бюджет отдела.',
  },
  X: {
    whatItIs:
      'Экспертиза здесь — прежде всего качество юридического анализа рисков: верно ли вы определили уровень опасности пункта договора относительно эталонной матрицы кейса.',
    howCalculated:
      'На этапе 2 за каждый пункт с риском начисляются баллы за совпадение уровня (высокий / средний / низкий) с эталоном и штрафы за ошибки. Эти изменения затем участвуют в нормализованном профиле X в отчёте.',
    howToImprove:
      'Сверяйте формулировки договора с матрицей рисков; относитесь к «серым» зонам критично; при сомнениях возвращайтесь к легенде и типовым рискам для отрасли.',
    whyMatters:
      'Ошибка в оценке риска в реальной сделке может стоить компании денег, споров или репутации — экспертиза — это ваша профессиональная «страховка».',
  },
  I: {
    whatItIs:
      'Интересы отражают, насколько вы защищаете позицию компании при классификации рисков по типам: юридический, финансовый, операционный, репутационный и т.д., в соответствии с эталоном симулятора.',
    howCalculated:
      'На этапе 2 за правильно назначенные типы риска по пунктам начисляются баллы; неверные теги снижают результат. Итоговый показатель I в отчёте — нормализованная агрегация по сессии.',
    howToImprove:
      'Для каждого отмеченного риска выбирайте типы, которые реально следуют из текста пункта; не бойтесь комбинировать несколько типов, если сценарий это допускает; сопоставляйте с интересами «своей» стороны в кейсе.',
    whyMatters:
      'Юрист переводит сухой текст договора на язык бизнес-рисков: от того, как вы их классифицируете, зависит, услышит ли вас руководство и контрагент.',
  },
  C: {
    whatItIs:
      'Ясность — качество коммуникации: насколько ваши вопросы, пояснения и аргументы понятны, структурны и уместны в диалоге с «бизнесом» и контрагентом в рамках сценария.',
    howCalculated:
      'На этапе 1 оцениваются вопросы к инициатору и связанные метрики; на последующих этапах — элементы, связанные с обоснованием позиции и переговорами (в т.ч. квалификационные фрагменты по методике LEXIC кейса). В отчёте показан нормализованный итог по C.',
    howToImprove:
      'Формулируйте один чёткий вопрос вместо «портянки»; в переговорах связывайте правовую позицию с коммерческим смыслом; заполняйте обоснования там, где интерфейс это запрашивает, полно и по существу.',
    whyMatters:
      'Сильный юрист не только прав, но и понятен: от ясности зависит скорость согласований и доверие к юридической функции внутри компании.',
  },
};

function LexicHelpModal({ paramKey, onClose }) {
  if (!paramKey || !LEXIC_PARAM_HELP[paramKey]) return null;
  const meta = PARAM_META[paramKey];
  const help = LEXIC_PARAM_HELP[paramKey];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lexic-help-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: '14px',
          maxWidth: '520px',
          width: '100%',
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
          border: '1px solid #e2e8f0',
        }}
      >
        <div
          style={{
            padding: '18px 20px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '12px',
          }}
        >
          <h2 id="lexic-help-title" style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
            {meta.icon} {meta.label} ({paramKey})
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            style={{
              flexShrink: 0,
              width: '36px',
              height: '36px',
              borderRadius: '8px',
              border: '1px solid #e5e7eb',
              background: '#f8fafc',
              cursor: 'pointer',
              fontSize: '20px',
              lineHeight: 1,
              color: '#64748b',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '20px' }}>
          {[
            { title: 'Что означает параметр', body: help.whatItIs },
            { title: 'Как считается в отчёте', body: help.howCalculated },
            { title: 'Как повысить балл', body: help.howToImprove },
            { title: 'Почему это важно для юриста', body: help.whyMatters },
          ].map((block) => (
            <div key={block.title} style={{ marginBottom: '18px' }}>
              <h3 style={{ fontSize: '13px', fontWeight: '700', color: '#334155', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {block.title}
              </h3>
              <p style={{ fontSize: '14px', color: '#475569', lineHeight: '1.65', margin: 0 }}>{block.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Нормализация 0-100 → 0.0-10.0 (не линейная!).
 * Базовый LEXIC = 50 (стартовое значение) — это «просто прокликал», а не «средний результат».
 * Ниже базы: 0→0.5, 50→4.0 (пришёл и потыкал).
 * Выше базы: 50→4.0, 100→10.0 (реальный навык вознаграждается).
 */
function to10Scale(val100) {
  const v = Math.max(0, Math.min(100, Number(val100) || 0));
  if (v <= 50) {
    return Math.round((0.5 + (v / 50) * 3.5) * 10) / 10;
  }
  return Math.round((4.0 + ((v - 50) / 50) * 6.0) * 10) / 10;
}

/** Цвет по 10-балльной шкале: тёмно-красный (0) → оранжевый (4) → жёлтый (6) → светло-зелёный (10) */
function scoreColor10(val10) {
  const t = Math.max(0, Math.min(10, val10)) / 10;
  const h = t * 120;
  const s = t < 0.4 ? 75 : 65;
  const l = 35 + t * 18;
  return `hsl(${h}, ${s}%, ${l}%)`;
}

/** Казино-анимация: быстро набирает от 0 до target, потом колеблется ±0.2 */
function useAnimatedScore(target, durationMs = 1800, wobbleMs = 800) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef(null);
  const startRef = useRef(null);

  useEffect(() => {
    if (target == null) return;
    const tgt = Number(target);
    if (!Number.isFinite(tgt)) { setDisplay(0); return; }

    startRef.current = performance.now();
    const totalMs = durationMs + wobbleMs;

    const tick = (now) => {
      const elapsed = now - startRef.current;
      if (elapsed >= totalMs) {
        setDisplay(tgt);
        return;
      }
      if (elapsed < durationMs) {
        const p = elapsed / durationMs;
        const eased = 1 - Math.pow(1 - p, 3);
        setDisplay(Math.round(tgt * eased * 10) / 10);
      } else {
        const wobbleT = (elapsed - durationMs) / wobbleMs;
        const amp = 0.3 * (1 - wobbleT);
        const freq = 6 + wobbleT * 10;
        const wobble = amp * Math.sin(freq * wobbleT * Math.PI);
        setDisplay(Math.round((tgt + wobble) * 10) / 10);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, durationMs, wobbleMs]);

  return display;
}

function AnimatedScoreDisplay({ value10, label, size = 'large' }) {
  const animated = useAnimatedScore(value10, 2000, 900);
  const color = scoreColor10(animated);
  const fontSize = size === 'large' ? '56px' : '32px';
  const labelSize = size === 'large' ? '14px' : '12px';
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          fontSize,
          fontWeight: '900',
          color,
          lineHeight: 1.1,
          fontVariantNumeric: 'tabular-nums',
          transition: 'color 0.3s',
          textShadow: `0 2px 12px ${color}44`,
        }}
      >
        {animated.toFixed(1)}
      </div>
      {label && (
        <div style={{ fontSize: labelSize, color: '#64748b', fontWeight: '600', marginTop: '4px' }}>
          {label}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин ${s} сек`;
  return `${s} сек`;
}

/** Персональные пункты для вкладки «Рекомендации» из JSON нарратива ИИ */
function parseAiRecommendationBullets(narrative) {
  const b = narrative?.recommendation_bullets;
  if (!Array.isArray(b)) return [];
  return b.map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
}

/**
 * Лёгкий рендерер markdown-подмножества (заголовки, списки, жирный, курсив, абзацы).
 * Не тянет react-markdown ради экономии бандла.
 */
export function NarrativeBodyParagraphs({ text, paragraphStyle }) {
  if (!text || !String(text).trim()) return null;

  const baseStyle = { fontSize: '14px', lineHeight: '1.65', color: '#334155', margin: '0 0 10px 0', ...paragraphStyle };

  const inlineMarkdown = (str) => {
    const parts = [];
    const re = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
    let lastIdx = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      if (m.index > lastIdx) parts.push(str.slice(lastIdx, m.index));
      if (m[2]) parts.push(<strong key={m.index}>{m[2]}</strong>);
      else if (m[3]) parts.push(<em key={m.index}>{m[3]}</em>);
      lastIdx = re.lastIndex;
    }
    if (lastIdx < str.length) parts.push(str.slice(lastIdx));
    return parts;
  };

  const lines = String(text).split('\n');
  const blocks = [];
  let buf = [];
  let listBuf = [];
  let olBuf = [];

  const flushParagraph = () => {
    const joined = buf.join(' ').trim();
    buf = [];
    if (joined) blocks.push({ type: 'p', content: joined });
  };
  const flushList = () => {
    if (listBuf.length) { blocks.push({ type: 'ul', items: [...listBuf] }); listBuf = []; }
  };
  const flushOl = () => {
    if (olBuf.length) { blocks.push({ type: 'ol', items: [...olBuf] }); olBuf = []; }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); flushList(); flushOl(); continue; }

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) { flushParagraph(); flushList(); flushOl(); blocks.push({ type: 'h', level: hMatch[1].length, content: hMatch[2] }); continue; }

    const liMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (liMatch) { flushParagraph(); flushOl(); listBuf.push(liMatch[1]); continue; }

    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) { flushParagraph(); flushList(); olBuf.push(olMatch[1]); continue; }

    flushList(); flushOl();
    buf.push(trimmed);
  }
  flushParagraph(); flushList(); flushOl();

  const hStyles = {
    2: { fontSize: '16px', fontWeight: '700', color: '#0f172a', margin: '16px 0 8px 0' },
    3: { fontSize: '15px', fontWeight: '700', color: '#1e293b', margin: '14px 0 6px 0' },
    4: { fontSize: '14px', fontWeight: '600', color: '#334155', margin: '10px 0 4px 0' },
  };

  return (
    <div>
      {blocks.map((b, i) => {
        if (b.type === 'h') {
          const Tag = `h${Math.min(b.level + 1, 6)}`;
          return <Tag key={i} style={hStyles[b.level] || hStyles[3]}>{inlineMarkdown(b.content)}</Tag>;
        }
        if (b.type === 'ul') return (
          <ul key={i} style={{ margin: '4px 0 10px 0', paddingLeft: '20px', ...baseStyle }}>
            {b.items.map((it, j) => <li key={j} style={{ marginBottom: '4px' }}>{inlineMarkdown(it)}</li>)}
          </ul>
        );
        if (b.type === 'ol') return (
          <ol key={i} style={{ margin: '4px 0 10px 0', paddingLeft: '20px', ...baseStyle }}>
            {b.items.map((it, j) => <li key={j} style={{ marginBottom: '4px' }}>{inlineMarkdown(it)}</li>)}
          </ol>
        );
        return <p key={i} style={baseStyle}>{inlineMarkdown(b.content)}</p>;
      })}
    </div>
  );
}

export default function ParticipantReport({
  report,
  onRestart,
  onBackToStart,
  viewerUser,
  showParticipantStageTabs = false,
}) {
  const [activeSection, setActiveSection] = useState('overview');
  const [lexicHelpKey, setLexicHelpKey] = useState(null);
  const [stage4Bridge, setStage4Bridge] = useState(null);
  const [stage4BridgeErr, setStage4BridgeErr] = useState(null);
  const [stage4BridgeLoading, setStage4BridgeLoading] = useState(false);

  const isSuperuser = Boolean(
    viewerUser && String(viewerUser.role || '').toLowerCase() === 'superuser',
  );
  const showDynamicsAndDetailsTabs = isSuperuser || showParticipantStageTabs;
  const bridgeSessionId = report?.simulex_session_id || report?.session_external_id;
  const showBridgeTab = isSuperuser && Boolean(bridgeSessionId);
  const showLexicLabTab = Boolean(userHasQaTrackerAccess(viewerUser));

  useEffect(() => {
    if (!report || activeSection !== 'stage4bridge' || !showBridgeTab || !bridgeSessionId) return undefined;
    let cancelled = false;
    setStage4BridgeLoading(true);
    setStage4BridgeErr(null);
    fetch(`${getApiUrl()}/report/stage4-bridge/${encodeURIComponent(String(bridgeSessionId))}`, {
      credentials: 'include',
      headers: getAuthHeaders(),
    })
      .then((res) => {
        if (!res.ok) return res.text().then((t) => { throw new Error(t || res.statusText); });
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setStage4Bridge(data);
      })
      .catch((e) => {
        if (!cancelled) setStage4BridgeErr(e?.message || String(e));
      })
      .finally(() => {
        if (!cancelled) setStage4BridgeLoading(false);
      });
    return () => { cancelled = true; };
  }, [report, activeSection, showBridgeTab, bridgeSessionId]);

  const lexicNorm = report?.lexic_normalized || {};
  const { displayLexic } = resolveReportDisplayLexic(report);
  const stageSnapshots = lexicNorm.stages || report?.stage_snapshots || [];
  const growthPoints = report?.growth_points || [];
  const narrative = report?.narrative || {};
  const softSkills = report?.session_soft_skills || {};
  const stageDetails = report?.stage_details || {};
  const gapNotes = Array.isArray(report?.reference_gap_notes) ? report.reference_gap_notes : [];
  const gapsFor = (prefix) => gapNotes.filter((x) => typeof x === 'string' && x.startsWith(prefix));
  // Определяем, какие этапы реально присутствуют в кейсе (есть данные)
  const hasStage1 = Boolean(stageDetails['stage-1']);
  const hasStage2 = Boolean(stageDetails['stage-2']);
  const hasStage3 = Boolean(stageDetails['stage-3']);
  // Этап 4 показываем только если он есть в кейсе (не null) И был реально пройден
  const hasStage4 = Boolean(stageDetails['stage-4']) && stageDetails['stage-4'] !== null;
  const hasAnyStageDetails = hasStage1 || hasStage2 || hasStage3 || hasStage4;

  // Сильные и слабые параметры
  const strongParams = PARAMS.filter((p) => (displayLexic[p] ?? 0) >= 70);
  const weakParams = PARAMS.filter((p) => (displayLexic[p] ?? 0) < 60);

  // Приоритизированные рекомендации (движок); если есть ИИ — показываем их на вкладке «Рекомендации»
  const recommendations = report?.recommendations || [];
  const aiRecommendationBullets = parseAiRecommendationBullets(narrative);
  const groupPeerLexic = report?.lexic_group_peer_max || null;
  const sections = useMemo(() => {
    const list = [{ id: 'overview', label: '📊 Профиль', icon: '📊' }];
    if (showDynamicsAndDetailsTabs) {
      list.push({ id: 'trajectory', label: '📈 Динамика', icon: '📈' });
    }
    list.push({ id: 'strengths_growth', label: '💪 Сильные стороны и рост', icon: '💪' });
    list.push({ id: 'recommendations', label: '📋 Рекомендации', icon: '📋' });
    if (showDynamicsAndDetailsTabs && hasAnyStageDetails) {
      list.push({ id: 'details', label: '🔍 По этапам', icon: '🔍' });
    }
    if (showBridgeTab) {
      list.push({ id: 'stage4bridge', label: '🔗 Мост 3→4', icon: '🔗' });
    }
    if (showLexicLabTab) {
      list.push({ id: 'lexic_lab', label: '🔬 Разбор LEXIC', icon: '🔬' });
    }
    return list;
  }, [
    showDynamicsAndDetailsTabs,
    hasAnyStageDetails,
    showBridgeTab,
    showLexicLabTab,
  ]);

  useEffect(() => {
    const ids = sections.map((s) => s.id);
    if (!ids.includes(activeSection)) {
      setActiveSection('overview');
    }
  }, [sections, activeSection]);

  if (!report) return null;

  const labLedger = report.lexic_lab_ledger || null;

  return (
    <div
      style={{
        minHeight: '100vh',
        boxSizing: 'border-box',
        background: 'linear-gradient(to bottom, #f0f9ff, #e0f2fe)',
        padding: '32px 16px',
        /* Не flex-row: иначе при родителе с фиксированной высотой (колонка App) белая карточка
           тянется по cross-axis на 100vh, а контент ниже вкладок визуально уезжает на градиент. */
        flexShrink: 0,
      }}
    >
      <div
        style={{
          maxWidth: '1320px',
          width: '100%',
          margin: '0 auto',
          background: 'white',
          borderRadius: '16px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.1)',
          padding: '40px',
          boxSizing: 'border-box',
        }}
      >
        {/* Поздравление */}
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div style={{ fontSize: '48px', marginBottom: '8px', animation: 'reportBounce 0.6s ease' }}>🎉</div>
          <h1 style={{ fontSize: '30px', fontWeight: '800', color: '#0f172a', marginBottom: '6px', letterSpacing: '-0.02em' }}>
            Поздравляем! Симуляция завершена
          </h1>
          <p style={{ fontSize: '16px', color: '#475569', marginBottom: '4px' }}>
            {report.case_title || 'Кейс'}
          </p>
          <p style={{ fontSize: '13px', color: '#94a3b8', margin: 0 }}>
            {report.completed_stages || '—'} из {report.total_stages || '—'} этапов пройдено
          </p>
        </div>

        {/* Главная оценка — 10-балльная шкала */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '28px 20px',
          marginBottom: '24px',
          background: `linear-gradient(135deg, ${scoreColor10(to10Scale(report.total_score))}08, ${scoreColor10(to10Scale(report.total_score))}18)`,
          borderRadius: '16px',
          border: `2px solid ${scoreColor10(to10Scale(report.total_score))}30`,
        }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: '#64748b', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Общая оценка
          </div>
          <AnimatedScoreDisplay value10={to10Scale(report.total_score)} label="из 10" size="large" />
          <div style={{
            marginTop: '10px',
            fontSize: '14px',
            fontWeight: '700',
            color: '#1e293b',
          }}>
            {report.rating || getSummaryGrade(report.total_score).label}
          </div>
        </div>

        {/* Время и рейтинг */}
        {(report.timing || report.ranking) && (
          <div style={{
            display: 'flex',
            gap: '12px',
            marginBottom: '24px',
            flexWrap: 'wrap',
          }}>
            {report.timing?.total_seconds != null && (
              <div style={{
                flex: '1 1 200px',
                padding: '16px 20px',
                background: '#f0f9ff',
                borderRadius: '12px',
                border: '1px solid #bae6fd',
              }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
                  Время прохождения
                </div>
                <div style={{ fontSize: '22px', fontWeight: '800', color: '#0c4a6e', marginBottom: '8px' }}>
                  {formatDuration(report.timing.total_seconds)}
                </div>
                {Array.isArray(report.timing.stages) && report.timing.stages.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {report.timing.stages.map((st) => (
                      <div key={st.stage_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#475569' }}>
                        <span>{st.stage_title}</span>
                        <span style={{ fontWeight: '600', fontVariantNumeric: 'tabular-nums' }}>
                          {formatDuration(st.seconds)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {report.ranking?.percentile != null && (() => {
              const pct = report.ranking.percentile;
              const total = report.ranking.total_sessions || 1;
              const place = Math.max(1, Math.ceil((100 - pct) / 100 * total));
              const accent = pct >= 75 ? '#059669' : pct >= 50 ? '#d97706' : '#dc2626';
              const bg = pct >= 75 ? '#f0fdf4' : pct >= 50 ? '#fffbeb' : '#fef2f2';
              const border = pct >= 75 ? '#a7f3d0' : pct >= 50 ? '#fde68a' : '#fecaca';
              const barBg = pct >= 75 ? '#d1fae5' : pct >= 50 ? '#fef3c7' : '#fee2e2';
              const label = pct >= 90 ? 'Вы в числе лучших!'
                : pct >= 75 ? 'Отличный результат'
                : pct >= 50 ? 'Выше среднего'
                : 'Есть куда расти';
              return (
                <div style={{
                  flex: '1 1 200px',
                  padding: '16px 20px',
                  background: bg,
                  borderRadius: '12px',
                  border: `1px solid ${border}`,
                }}>
                  <div style={{ fontSize: '11px', fontWeight: '600', color: '#334155', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
                    Рейтинг среди участников
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '6px' }}>
                    <span style={{ fontSize: '26px', fontWeight: '800', color: accent }}>{place}</span>
                    <span style={{ fontSize: '14px', fontWeight: '600', color: '#64748b' }}>место из {total}</span>
                  </div>
                  <div style={{
                    height: '8px', borderRadius: '4px', background: barBg,
                    overflow: 'hidden', marginBottom: '8px',
                  }}>
                    <div style={{
                      height: '100%', borderRadius: '4px',
                      width: `${Math.max(4, pct)}%`, background: accent,
                      transition: 'width 0.6s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>
                    Лучше, чем {Math.round(pct)}% участников &middot; {label}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
        <style>{`
          @keyframes reportBounce {
            0% { transform: scale(0.3) translateY(20px); opacity: 0; }
            60% { transform: scale(1.15) translateY(-4px); opacity: 1; }
            100% { transform: scale(1) translateY(0); }
          }
        `}</style>

        {/* Навигация по разделам */}
        <div
          style={{
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            justifyContent: 'center',
            marginBottom: '32px',
          }}
        >
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: '600',
                cursor: 'pointer',
                border: activeSection === s.id ? '2px solid #3b82f6' : '2px solid #e5e7eb',
                background: activeSection === s.id ? '#3b82f6' : 'white',
                color: activeSection === s.id ? 'white' : '#374151',
                transition: 'all 0.15s',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Секция: Профиль */}
        {activeSection === 'overview' && (
          <div>
            {/* Карточки параметров — основной вид */}
            <div
              style={{
                overflowX: 'auto',
                marginBottom: '28px',
                WebkitOverflowScrolling: 'touch',
                paddingBottom: '4px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'nowrap',
                  gap: '12px',
                  width: '100%',
                  minWidth: 0,
                }}
              >
              {PARAMS.map((p) => {
                const val = Math.round(displayLexic[p] ?? 50);
                const val10 = to10Scale(val);
                const color10 = scoreColor10(val10);
                return (
                  <div
                    key={p}
                    style={{
                      flex: '1 1 0',
                      minWidth: '132px',
                      maxWidth: '100%',
                      padding: '16px 14px',
                      borderRadius: '12px',
                      border: `2px solid ${color10}35`,
                      background: `linear-gradient(145deg, ${color10}10, white)`,
                      boxShadow: '0 2px 8px rgba(15,23,42,0.06)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        marginBottom: '10px',
                        gap: '8px',
                      }}
                    >
                      <span style={{ fontSize: '17px', fontWeight: '800', color: '#1f2937' }}>
                        {PARAM_META[p].icon} {p}
                      </span>
                      <button
                        type="button"
                        onClick={() => setLexicHelpKey(p)}
                        title="Что означает параметр"
                        style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '999px',
                          border: '1px solid #cbd5e1',
                          background: 'white',
                          cursor: 'pointer',
                          fontSize: '14px',
                          fontWeight: '700',
                          color: '#475569',
                          lineHeight: 1,
                          flexShrink: 0,
                        }}
                      >
                        ?
                      </button>
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: '600', color: '#334155', marginBottom: '10px' }}>
                      {PARAM_META[p].label}
                    </div>
                    <AnimatedScoreDisplay value10={val10} label="из 10" size="small" />
                    <div
                      style={{ height: '6px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden', marginTop: '10px' }}
                    >
                      <div
                        style={{ width: `${val}%`, height: '100%', background: color10, transition: 'width 1.2s ease-out' }}
                      />
                    </div>
                  </div>
                );
              })}
              </div>
            </div>

            <div
              style={{
                marginBottom: '32px',
                paddingBottom: '8px',
                borderBottom: '1px solid #e5e7eb',
              }}
            >
              <h3
                style={{
                  fontSize: '15px',
                  fontWeight: '600',
                  color: '#334155',
                  margin: '0 0 16px 0',
                  textAlign: 'center',
                }}
              >
                Диаграмма профиля LEXIC
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                <LexicRadarChart
                  lexic={displayLexic}
                  groupProfile={groupPeerLexic}
                  normalizedLexic={null}
                  size={380}
                  showLegend={false}
                  showLevels
                  axisValueDisplay="number"
                  hideTitle
                  groupLayerLegendLabel="Лучшее в группе по этому кейсу"
                />
              </div>
            </div>

            {/* ИИ-нарратив: обратная связь разбита по секциям; bullets могут быть без prose-полей */}
            {(narrative.overview ||
              narrative.strengths ||
              narrative.growth_areas ||
              narrative.conclusion ||
              aiRecommendationBullets.length > 0) && (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ fontSize: '18px', fontWeight: '700', color: '#0f172a', marginBottom: '16px' }}>
                  Обратная связь по итогам симуляции
                </h3>

                {narrative.overview && (
                  <div style={{
                    padding: '18px 20px',
                    borderRadius: '12px',
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    marginBottom: '12px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                      <span style={{ fontSize: '18px' }}>📋</span>
                      <h4 style={{ fontSize: '14px', fontWeight: '700', color: '#334155', margin: 0 }}>Общее впечатление</h4>
                    </div>
                    <NarrativeBodyParagraphs
                      text={narrative.overview}
                      paragraphStyle={{
                        fontSize: '14px',
                        color: '#475569',
                        lineHeight: '1.75',
                        marginBottom: '8px',
                        marginTop: 0,
                        fontFamily: 'inherit',
                        fontStyle: 'normal',
                        whiteSpace: 'normal',
                      }}
                    />
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                  {narrative.strengths && (
                    <div style={{
                      padding: '18px 20px',
                      borderRadius: '12px',
                      background: '#f0fdf4',
                      border: '1px solid #bbf7d0',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                        <span style={{ fontSize: '18px' }}>💪</span>
                        <h4 style={{ fontSize: '14px', fontWeight: '700', color: '#166534', margin: 0 }}>Что получилось хорошо</h4>
                      </div>
                      <NarrativeBodyParagraphs
                        text={narrative.strengths}
                        paragraphStyle={{
                          fontSize: '13px',
                          color: '#374151',
                          lineHeight: '1.7',
                          marginBottom: '6px',
                          marginTop: 0,
                        }}
                      />
                    </div>
                  )}

                  {narrative.growth_areas && (
                    <div style={{
                      padding: '18px 20px',
                      borderRadius: '12px',
                      background: '#fffbeb',
                      border: '1px solid #fde68a',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                        <span style={{ fontSize: '18px' }}>🎯</span>
                        <h4 style={{ fontSize: '14px', fontWeight: '700', color: '#92400e', margin: 0 }}>Над чем стоит поработать</h4>
                      </div>
                      <NarrativeBodyParagraphs
                        text={narrative.growth_areas}
                        paragraphStyle={{
                          fontSize: '13px',
                          color: '#374151',
                          lineHeight: '1.7',
                          marginBottom: '6px',
                          marginTop: 0,
                        }}
                      />
                    </div>
                  )}
                </div>

                {narrative.conclusion && (
                  <div style={{
                    padding: '16px 20px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, #eff6ff, #f0f9ff)',
                    border: '1px solid #bfdbfe',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <span style={{ fontSize: '16px' }}>✨</span>
                      <h4 style={{ fontSize: '13px', fontWeight: '700', color: '#1e40af', margin: 0 }}>Итог</h4>
                    </div>
                    <NarrativeBodyParagraphs
                      text={narrative.conclusion}
                      paragraphStyle={{
                        fontSize: '14px',
                        color: '#334155',
                        lineHeight: '1.7',
                        marginBottom: '4px',
                        marginTop: 0,
                        fontWeight: '500',
                      }}
                    />
                  </div>
                )}

                {!narrative.overview &&
                  !narrative.strengths &&
                  !narrative.growth_areas &&
                  !narrative.conclusion &&
                  aiRecommendationBullets.length > 0 && (
                  <div
                    style={{
                      padding: '16px 20px',
                      borderRadius: '12px',
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                    }}
                  >
                    <p style={{ margin: '0 0 10px', fontSize: '13px', color: '#64748b', lineHeight: 1.6 }}>
                      Текстовые разделы обратной связи сейчас недоступны; ниже — ориентиры развития из отчёта
                      (полный список также на вкладке «Рекомендации»).
                    </p>
                    <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#334155', lineHeight: 1.65 }}>
                      {aiRecommendationBullets.map((rec, i) => (
                        <li key={i} style={{ marginBottom: '6px' }}>{rec}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

          </div>
        )}

        {/* Секция: Динамика */}
        {activeSection === 'trajectory' && (
          <div>
            <TrajectoryChart
              stageSnapshots={stageSnapshots}
              growthPoints={growthPoints}
              width={860}
              height={300}
            />
            {stageSnapshots.length >= 2 && (
              <details style={{ marginTop: '20px' }}>
                <summary
                  style={{
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: '600',
                    color: '#475569',
                    userSelect: 'none',
                    marginBottom: '8px',
                  }}
                >
                  Подробная разбивка по этапам и осям
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                  {stageSnapshots.map((snap, i) => {
                    const normScores = snap.normalized_scores || {};
                    const avg = PARAMS.reduce((s, p) => s + (normScores[p] || 50), 0) / PARAMS.length;
                    const avgGrade = getSummaryGrade(avg);
                    const avgRounded = Math.round(avg);
                    return (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '10px 16px',
                          background: '#f9fafb',
                          borderRadius: '8px',
                        }}
                      >
                        <div
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '8px',
                            background: '#f1f5f9',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 'bold',
                            fontSize: '13px',
                            color: '#334155',
                          }}
                        >
                          Э{snap.stage_order}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '13px', fontWeight: '600', color: '#1f2937' }}>
                            {snap.stage_code?.replace('stage-', 'Этап ') || `Этап ${i + 1}`}
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
                            {PARAMS.map((p) => {
                              const v = normScores[p];
                              if (v == null) return null;
                              const g = getSummaryGrade(v);
                              const vr = Math.round(v);
                              return (
                                <span
                                  key={p}
                                  style={{ fontSize: '11px', fontWeight: '700', color: g.accent }}
                                  title={`${p}: ${vr}`}
                                >
                                  {p}:{vr}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                        <div
                          style={{
                            fontSize: '14px',
                            fontWeight: '800',
                            color: avgGrade.accent,
                            textAlign: 'right',
                            maxWidth: '120px',
                            lineHeight: 1.25,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {avgRounded}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Секция: сильные стороны и зоны роста (структура по осям; текст наставника только на «Профиль») */}
        {activeSection === 'strengths_growth' && (
          <div>
            <h3 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1f2937', marginBottom: '8px' }}>
              💪 Сильные стороны и зоны роста
            </h3>
            <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '22px', lineHeight: 1.5 }}>
              Развёрнутый текст наставника — на вкладке «Профиль». Здесь — сводка по осям LEXIC.
            </p>

            <h4 style={{ fontSize: '16px', fontWeight: '700', color: '#166534', marginBottom: '14px' }}>
              Сильные стороны (≥ 70)
            </h4>
            {strongParams.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '28px' }}>
                {strongParams.map((p) => {
                  const val = Math.round(displayLexic[p] ?? 50);
                  const val10 = to10Scale(val);
                  const c = scoreColor10(val10);
                  return (
                    <div
                      key={p}
                      style={{
                        padding: '16px',
                        borderRadius: '10px',
                        border: '1px solid #a7f3d0',
                        background: '#f0fdf4',
                        display: 'flex',
                        gap: '16px',
                        alignItems: 'flex-start',
                      }}
                    >
                      <div style={{ fontSize: '28px' }}>{PARAM_META[p].icon}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937' }}>
                            {PARAM_META[p].label}
                          </span>
                          <span style={{ fontSize: '18px', fontWeight: '800', color: c, fontVariantNumeric: 'tabular-nums' }}>
                            {val10.toFixed(1)}
                          </span>
                        </div>
                        <p style={{ fontSize: '13px', color: '#374151', lineHeight: '1.5', margin: 0 }}>
                          {PARAM_META[p].desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style={{ color: '#6b7280', fontStyle: 'italic', marginBottom: '28px' }}>
                Пока нет осей с баллом от 70 — продолжайте набирать опыт по кейсу.
              </p>
            )}

            <h4 style={{ fontSize: '16px', fontWeight: '700', color: '#9a3412', marginBottom: '14px' }}>
              Зоны развития (&lt; 60)
            </h4>
            {weakParams.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {weakParams.map((p) => {
                  const val = Math.round(displayLexic[p] ?? 50);
                  const val10 = to10Scale(val);
                  const priority = 70 - val;
                  const c = scoreColor10(val10);
                  return (
                    <div
                      key={p}
                      style={{
                        padding: '16px',
                        borderRadius: '10px',
                        border: '1px solid #fed7aa',
                        background: '#fff7ed',
                        display: 'flex',
                        gap: '16px',
                        alignItems: 'flex-start',
                      }}
                    >
                      <div style={{ fontSize: '28px' }}>{PARAM_META[p].icon}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937' }}>
                            {PARAM_META[p].label}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span
                              style={{
                                fontSize: '11px',
                                padding: '2px 8px',
                                borderRadius: '999px',
                                background: priority > 30 ? '#fee2e2' : '#fef3c7',
                                color: priority > 30 ? '#991b1b' : '#92400e',
                              }}
                            >
                              {priority > 30 ? 'Высокий приоритет' : 'Средний'}
                            </span>
                            <span style={{ fontSize: '18px', fontWeight: '800', color: c, fontVariantNumeric: 'tabular-nums' }}>
                              {val10.toFixed(1)}
                            </span>
                          </div>
                        </div>
                        <p style={{ fontSize: '13px', color: '#374151', lineHeight: '1.5', margin: 0 }}>
                          {LEXIC_GROWTH_ZONE_COPY[p] || PARAM_META[p].desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                style={{
                  padding: '24px',
                  background: '#ecfdf5',
                  borderRadius: '12px',
                  textAlign: 'center',
                  color: '#065f46',
                }}
              >
                🌟 Отлично! По всем параметрам выше порога 60.
              </div>
            )}
          </div>
        )}

        {/* Секция: Рекомендации */}
        {activeSection === 'recommendations' && (
          <div>
            <h3 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1f2937', marginBottom: '10px' }}>
              📋 Рекомендации по развитию
            </h3>
            {aiRecommendationBullets.length > 0 ? (
              <>
                <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.55', margin: '0 0 16px 0' }}>
                  Ориентиры для развития компетенций (переносимые на другие сделки), сгенерированные ИИ с учётом ваших метрик,
                  динамики по этапам и зон внимания по рубрике — без пошаговых спойлеров по сценарию этого кейса.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {aiRecommendationBullets.map((rec, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: '12px',
                        padding: '14px 16px',
                        background: 'linear-gradient(90deg, #f0fdf4 0%, #f9fafb 12%)',
                        borderRadius: '10px',
                        borderLeft: '4px solid #22c55e',
                      }}
                    >
                      <span
                        style={{
                          minWidth: '24px',
                          height: '24px',
                          borderRadius: '50%',
                          background: '#22c55e',
                          color: 'white',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '12px',
                          fontWeight: 'bold',
                        }}
                      >
                        {i + 1}
                      </span>
                      <p style={{ fontSize: '14px', color: '#374151', lineHeight: '1.5', margin: 0 }}>{rec}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : recommendations.length > 0 ? (
              <>
                <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.55', margin: '0 0 16px 0' }}>
                  Автоматические подсказки по LEXIC и этапам. При следующем прохождении с генерацией отчёта могут появиться пункты от ИИ.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {recommendations.map((rec, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: '12px',
                        padding: '14px 16px',
                        background: '#f9fafb',
                        borderRadius: '10px',
                        borderLeft: `4px solid ${i < 2 ? '#3b82f6' : i < 4 ? '#f59e0b' : '#e5e7eb'}`,
                      }}
                    >
                      <span
                        style={{
                          minWidth: '24px',
                          height: '24px',
                          borderRadius: '50%',
                          background: i < 2 ? '#3b82f6' : i < 4 ? '#f59e0b' : '#9ca3af',
                          color: 'white',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '12px',
                          fontWeight: 'bold',
                        }}
                      >
                        {i + 1}
                      </span>
                      <p style={{ fontSize: '14px', color: '#374151', lineHeight: '1.5', margin: 0 }}>{rec}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p style={{ color: '#6b7280', fontStyle: 'italic' }}>
                ✨ Отличные результаты! Продолжайте в том же духе.
              </p>
            )}

            {/* Soft-skills */}
            {Object.keys(softSkills).length > 0 && (
              <div style={{ marginTop: '24px' }}>
                <h4 style={{ fontSize: '15px', fontWeight: '600', color: '#374151', marginBottom: '12px' }}>
                  Оценка поведенческих навыков
                </h4>
                <p style={{ fontSize: '12px', color: '#64748b', lineHeight: '1.5', margin: '-6px 0 12px 0' }}>
                  Источник — ИИ по логам сессии. Проценты не суммируются в итоговый балл LEXIC.
                </p>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                    gap: '10px',
                  }}
                >
                  {Object.entries(softSkills).map(([key, value]) => {
                    if (key === 'negotiation_style') {
                      return (
                        <div key={key} style={{ padding: '12px', background: '#f9fafb', borderRadius: '8px' }}>
                          <div style={{ fontSize: '11px', color: '#9ca3af' }}>Стиль переговоров (классификация ИИ)</div>
                          <div style={{ fontSize: '14px', fontWeight: '600', color: '#374151', marginTop: '4px' }}>
                            {value === 'collaborative' ? '🤝 Win-Win (совместный)' :
                             value === 'competitive' ? '⚔️ Конкурентный' :
                             value === 'avoidant' ? '🏃 Избегающий' : '🔄 Смешанный'}
                          </div>
                        </div>
                      );
                    }
                    const pct = Math.round(Number(value) * 100);
                    const meta = {
                      argumentation_level: { label: 'Аргументация', hint: 'сила обоснования в текстах' },
                      risk_aversion: { label: 'Осторожность', hint: '0 — склонность к риску, 100 — осторожный подход' },
                      self_reflection: { label: 'Рефлексия', hint: 'заметность самооценки и выводов в диалоге' },
                    }[key];
                    const label = meta?.label || key;
                    return (
                      <div key={key} style={{ padding: '12px', background: '#f9fafb', borderRadius: '8px' }}>
                        <div style={{ fontSize: '11px', color: '#9ca3af' }}>{label}</div>
                        {meta?.hint && (
                          <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px', lineHeight: 1.35 }}>{meta.hint}</div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                          <div style={{ height: '6px', flex: 1, background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden', marginRight: '8px' }}>
                            <div style={{ width: `${Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0}%`, height: '100%', background: '#3b82f6' }} />
                          </div>
                          <span style={{ fontSize: '13px', fontWeight: '600', color: '#374151' }}>{Number.isFinite(pct) ? `${pct}%` : '—'}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Секция: Детали по этапам */}
        {activeSection === 'details' && (
          <div>
            <h3 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1f2937', marginBottom: '20px' }}>
              🔍 Что было на каждом этапе
            </h3>

            {/* Этап 1 — Анализ контекста */}
            {hasStage1 && (() => {
              const s1 = stageDetails['stage-1'];
              const coverage = s1.stage1_legitimacy?.overall_coverage ?? null;
              const coveragePct = coverage != null ? Math.round(coverage * 100) : null;
              const insightCount = s1.insights_count ?? s1.insights_by_attribute
                ? Object.values(s1.insights_by_attribute || {}).reduce((acc, arr) => acc + (arr?.length || 0), 0)
                : null;
              const questions = s1.questions || [];
              const goodQ = questions.filter(q => q.quality === 'good' && q.quality_hint !== 'off_topic').length;
              const totalQ = questions.filter(q => q.quality_hint !== 'off_topic').length;

              let coverageLabel = '';
              let coverageColor = '#6b7280';
              if (coveragePct != null) {
                if (coveragePct >= 88) { coverageLabel = 'Отличное'; coverageColor = '#10b981'; }
                else if (coveragePct >= 72) { coverageLabel = 'Хорошее'; coverageColor = '#3b82f6'; }
                else if (coveragePct >= 48) { coverageLabel = 'Частичное'; coverageColor = '#f59e0b'; }
                else if (coveragePct >= 22) { coverageLabel = 'Слабое'; coverageColor = '#f97316'; }
                else { coverageLabel = 'Низкое'; coverageColor = '#ef4444'; }
              }

              return (
                <StageDetailBlock
                  icon="📄"
                  title="Этап 1 — Выявление контекста"
                  color={{ bg: '#f0f9ff', border: '#bae6fd', head: '#0369a1' }}
                >
                  {coveragePct != null && (
                    <MetricRow label="Покрытие ключевых фактов">
                      <ProgressBar value={coveragePct} color={coverageColor} />
                      <span style={{ fontSize: '12px', color: coverageColor, fontWeight: '600', marginLeft: '8px' }}>
                        {coveragePct}% — {coverageLabel}
                      </span>
                    </MetricRow>
                  )}
                  {insightCount != null && (
                    <MetricRow label="Заметок в брифе" value={`${insightCount}`}
                      hint="Тексты, которые вы вынесли в блоки брифа с карты сделки" />
                  )}
                  {totalQ > 0 && (
                    <MetricRow label="Вопросы инициатору">
                      <span style={{ fontSize: '13px', color: '#374151' }}>
                        {goodQ} из {totalQ} — развёрнутые и по делу
                        {goodQ < totalQ && ` (${totalQ - goodQ} потребовало уточнений)`}
                      </span>
                    </MetricRow>
                  )}
                  {s1.stage1_legitimacy?.l_delta != null && (
                    <MetricRow label="Влияние на Легитимность (L)">
                      <DeltaBadge delta={s1.stage1_legitimacy.l_delta} />
                      <span style={{ fontSize: '12px', color: '#6b7280', marginLeft: '6px' }}>
                        {s1.stage1_legitimacy.l_delta > 0
                          ? 'Хорошая полнота анализа повысила правовую компетентность'
                          : 'Неполный анализ снизил оценку по легитимности'}
                      </span>
                    </MetricRow>
                  )}
                  {gapsFor('Этап 1').length > 0 && (
                    <div style={{ marginTop: '12px' }}>
                      <div style={{ fontSize: '12px', fontWeight: '600', color: '#0369a1', marginBottom: '6px' }}>
                        На что обратить внимание
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#4b5563', lineHeight: 1.5 }}>
                        {gapsFor('Этап 1').map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </StageDetailBlock>
              );
            })()}

            {/* Этап 2 — Выявление рисков */}
            {hasStage2 && (() => {
              const s2 = stageDetails['stage-2'];
              const sm = s2?.summary || {};
              const found = sm.found_risks ?? 0;
              const total = sm.total_risks ?? 0;
              const missed = sm.missed_risks ?? 0;
              const fp = sm.false_positives ?? 0;
              const foundPct = total > 0 ? Math.round((found / total) * 100) : 0;
              const tagCorrectSummary = sm.tag_correct_count ?? 0;
              const usedRiskTypes = Boolean(s2?.participant_used_risk_types);
              const tagStats = computeStage2RiskTypeTagStats(s2);
              const tagCorrect =
                tagStats.expectedSlots > 0 ? tagStats.correct : tagCorrectSummary;
              const tagExpected = tagStats.expectedSlots;
              const tagPct =
                usedRiskTypes && tagExpected > 0
                  ? Math.round((tagCorrect / tagExpected) * 100)
                  : null;
              const showTagPerformance = usedRiskTypes || tagCorrectSummary > 0;
              let tagQualLabel = '';
              let tagQualColor = '#6b7280';
              if (tagPct != null && usedRiskTypes) {
                if (tagPct >= 85 && tagStats.wrong === 0) {
                  tagQualLabel = 'Сильная классификация';
                  tagQualColor = '#10b981';
                } else if (tagPct >= 65) {
                  tagQualLabel = 'Уверенно';
                  tagQualColor = '#3b82f6';
                } else if (tagPct >= 45) {
                  tagQualLabel = 'Есть пробелы';
                  tagQualColor = '#f59e0b';
                } else {
                  tagQualLabel = 'Стоит потренироваться';
                  tagQualColor = '#ef4444';
                }
              }

              let qualLabel = '';
              let qualColor = '#6b7280';
              if (foundPct >= 88 && fp === 0) { qualLabel = 'Отличный результат'; qualColor = '#10b981'; }
              else if (foundPct >= 72 && fp <= 1) { qualLabel = 'Хороший результат'; qualColor = '#3b82f6'; }
              else if (foundPct >= 58) { qualLabel = 'Средний результат'; qualColor = '#f59e0b'; }
              else { qualLabel = 'Требует работы'; qualColor = '#ef4444'; }

              return (
                <StageDetailBlock
                  icon="⚠️"
                  title="Этап 2 — Риски в договоре"
                  color={{ bg: '#fff7ed', border: '#fed7aa', head: '#c2410c' }}
                >
                  <div
                    style={{
                      marginBottom: '14px',
                      padding: '12px 14px',
                      borderRadius: '10px',
                      background: usedRiskTypes ? '#fffbeb' : '#f9fafb',
                      border: `1px solid ${usedRiskTypes ? '#fcd34d' : '#e5e7eb'}`,
                      fontSize: '13px',
                      lineHeight: 1.5,
                      color: '#374151',
                    }}
                  >
                    <div style={{ fontWeight: '700', color: '#c2410c', marginBottom: '6px' }}>
                      {usedRiskTypes ? 'Типы риска: вы прошли дополнительный шаг' : 'Типы риска: шаг не выполнялся'}
                    </div>
                    {usedRiskTypes ? (
                      <span>
                        Вы отметили тип риска (юридический, финансовый, операционный или репутационный) хотя бы по одному
                        пункту договора. Это необязательная часть сценария, но она помогает структурировать понимание риска.
                      </span>
                    ) : (
                      <span>
                        Классификацию типов по пунктам вы не заполняли — в симуляторе это дополнительная задача. При
                        следующем прохождении можно добавить типы там, где уже выбран уровень риска.
                      </span>
                    )}
                  </div>
                  <MetricRow label="Выявленные риски">
                    <ProgressBar value={foundPct} color={qualColor} />
                    <span style={{ fontSize: '12px', color: qualColor, fontWeight: '600', marginLeft: '8px' }}>
                      {found} из {total} рисков — {qualLabel}
                    </span>
                  </MetricRow>
                  {missed > 0 && (
                    <MetricRow label="Пропущено рисков" value={`${missed}`}
                      valueColor="#f97316"
                      hint="Опасные пункты договора, которые остались незамеченными" />
                  )}
                  {fp > 0 && (
                    <MetricRow label="Ложные срабатывания" value={`${fp}`}
                      valueColor="#6b7280"
                      hint="Безопасные пункты, которые были ошибочно отмечены как рискованные" />
                  )}
                  {showTagPerformance && (
                    <div
                      style={{
                        marginTop: '12px',
                        paddingTop: '12px',
                        borderTop: '1px dashed #fdba74',
                      }}
                    >
                      <div style={{ fontSize: '12px', fontWeight: '700', color: '#9a3412', marginBottom: '8px' }}>
                        Как получилось с типами риска
                      </div>
                      {usedRiskTypes && tagExpected > 0 && tagPct != null ? (
                        <MetricRow label="Совпадения с эталоном по типам">
                          <ProgressBar value={tagPct} color={tagQualColor} />
                          <span style={{ fontSize: '12px', color: tagQualColor, fontWeight: '600', marginLeft: '8px' }}>
                            {tagCorrect} из {tagExpected} — {tagQualLabel}
                          </span>
                        </MetricRow>
                      ) : !usedRiskTypes && tagCorrectSummary > 0 ? (
                        <MetricRow
                          label="Верно указано типов (по эталону кейса)"
                          value={`${tagCorrectSummary}`}
                          hint="Юридический, финансовый, операционный или репутационный — по каждому верному совпадению"
                        />
                      ) : usedRiskTypes && tagCorrectSummary > 0 && tagExpected === 0 ? (
                        <MetricRow
                          label="Верно указано типов (по эталону кейса)"
                          value={`${tagCorrectSummary}`}
                          hint="Юридический, финансовый, операционный или репутационный — по каждому верному совпадению"
                        />
                      ) : usedRiskTypes ? (
                        <div style={{ fontSize: '12px', color: '#6b7280', lineHeight: 1.45 }}>
                          Детальная разбивка по типам в сохранённом отчёте недоступна; факт участия в классификации учтён выше.
                        </div>
                      ) : null}
                      {usedRiskTypes && tagStats.wrong > 0 ? (
                        <MetricRow
                          label="Лишние типы (не подходят к пункту)"
                          value={`${tagStats.wrong}`}
                          valueColor="#f97316"
                          hint="Отмеченный тип не совпадает с эталонной классификацией для этого пункта"
                        />
                      ) : null}
                      {usedRiskTypes && tagStats.missed > 0 ? (
                        <MetricRow
                          label="Пропущены ожидаемые типы"
                          value={`${tagStats.missed}`}
                          valueColor="#ea580c"
                          hint="Для пункта в эталоне указан тип, который вы не отметили"
                        />
                      ) : null}
                    </div>
                  )}
                  {gapsFor('Этап 2').length > 0 && (
                    <div style={{ marginTop: '12px' }}>
                      <div style={{ fontSize: '12px', fontWeight: '600', color: '#c2410c', marginBottom: '6px' }}>
                        На что обратить внимание
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#4b5563', lineHeight: 1.5 }}>
                        {gapsFor('Этап 2').map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </StageDetailBlock>
              );
            })()}

            {/* Этап 3 — Переговоры */}
            {hasStage3 && (() => {
              const s3 = stageDetails['stage-3'];
              const agreed = s3.agreed_count ?? 0;
              const notDiscussed = s3.not_discussed_count ?? 0;
              const inProgress = s3.in_progress_count ?? 0;
              const total = agreed + notDiscussed + inProgress;
              const agreedPct = total > 0 ? Math.round((agreed / total) * 100) : 0;

              // Статусы пунктов
              const agreedList = s3.agreed || [];
              // Различаем: player изменил (changed), бот принял без обсуждения (no_edits/accepted_bot), эскалация
              const playerWon = agreedList.filter(c => c.status === 'changed').length;
              const keptOriginal = agreedList.filter(c => c.status === 'no_edits').length;
              const botAccepted = agreedList.filter(c => c.status === 'accepted_bot').length;
              const escalated = agreedList.filter(c => c.status === 'not_agreed_escalation' || c.status === 'kept_counterparty').length;

              return (
                <StageDetailBlock
                  icon="🤝"
                  title="Этап 3 — Переговоры по договору"
                  color={{ bg: '#f0fdf4', border: '#a7f3d0', head: '#065f46' }}
                >
                  {total > 0 && (
                    <MetricRow label="Пунктов урегулировано">
                      <ProgressBar value={agreedPct} color={agreedPct >= 70 ? '#10b981' : agreedPct >= 40 ? '#f59e0b' : '#ef4444'} />
                      <span style={{ fontSize: '12px', color: '#374151', marginLeft: '8px' }}>
                        {agreed} из {total} пунктов завершены
                      </span>
                    </MetricRow>
                  )}
                  {playerWon > 0 && (
                    <MetricRow label="Редакция принята" value={`${playerWon} пункт(а)`}
                      valueColor="#10b981"
                      hint="Контрагент согласился с вашей редакцией — это успех переговоров" />
                  )}
                  {keptOriginal > 0 && (
                    <MetricRow label="Оставлены без изменений" value={`${keptOriginal} пункт(а)`}
                      hint="Пункты, которые вы решили не оспаривать" />
                  )}
                  {botAccepted > 0 && (
                    <MetricRow label="Принято контрагентом" value={`${botAccepted} пункт(а)`}
                      hint="Контрагент принял условие без ваших возражений" />
                  )}
                  {escalated > 0 && (
                    <MetricRow label="Остались спорными" value={`${escalated} пункт(а)`}
                      valueColor="#f97316"
                      hint="Пункты, по которым не удалось достичь соглашения — потенциальный риск" />
                  )}
                  {notDiscussed > 0 && (
                    <MetricRow label="Не обсуждались" value={`${notDiscussed} пункт(а)`}
                      valueColor="#9ca3af"
                      hint="Пункты договора, до которых переговоры не дошли" />
                  )}
                  {(() => {
                    const ci = s3.chat_formulation_insights || {};
                    const strong = ci.strong || [];
                    const weak = ci.weak || [];
                    if (!strong.length && !weak.length) return null;
                    const ms = ci.method_summary || {};
                    const nAi = Number(ms.ai) || 0;
                    const nRules = Number(ms.rules) || 0;
                    const formulationCaption =
                      nAi > 0
                        ? `Формулировки в чате — шкалы L–C по методике этапа 3 (ИИ, та же логика, что оценка переговоров; пунктов по ИИ: ${nAi}${nRules ? `, fallback правила: ${nRules}` : ''})`
                        : 'Формулировки в чате — fallback без ИИ (упрощённые правила по истории сообщений)';
                    return (
                      <div style={{ marginTop: '14px' }}>
                        <div style={{ fontSize: '12px', fontWeight: '700', color: '#065f46', marginBottom: '8px' }}>
                          {formulationCaption}
                        </div>
                        {strong.length > 0 && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={{ fontSize: '11px', fontWeight: '600', color: '#10b981', marginBottom: '4px' }}>
                              Удачнее получилось
                            </div>
                            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#374151', lineHeight: 1.45 }}>
                              {strong.map((row, i) => (
                                <li key={`s-${i}`}>
                                  <span style={{ fontWeight: 600 }}>{row.clause_title || row.clause_id}</span>
                                  {row.last_player_message_excerpt
                                    ? ` — «${row.last_player_message_excerpt}»`
                                    : ''}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {weak.length > 0 && (
                          <div>
                            <div style={{ fontSize: '11px', fontWeight: '600', color: '#ea580c', marginBottom: '4px' }}>
                              Есть что усилить
                            </div>
                            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#374151', lineHeight: 1.45 }}>
                              {weak.map((row, i) => (
                                <li key={`w-${i}`}>
                                  <span style={{ fontWeight: 600 }}>{row.clause_title || row.clause_id}</span>
                                  {row.last_player_message_excerpt
                                    ? ` — «${row.last_player_message_excerpt}»`
                                    : ''}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {gapsFor('Этап 3').length > 0 && (
                    <div style={{ marginTop: '12px' }}>
                      <div style={{ fontSize: '12px', fontWeight: '600', color: '#065f46', marginBottom: '6px' }}>
                        На что обратить внимание
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#4b5563', lineHeight: 1.5 }}>
                        {gapsFor('Этап 3').map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </StageDetailBlock>
              );
            })()}

            {/* Этап 4 — Кризис */}
            {hasStage4 && (() => {
              const s4 = stageDetails['stage-4'];
              // stage_4_state содержит детали диагностики: возврат, исход
              const s4State = s4.stage_4_state || report.stage_4_state || {};
              const narrative =
                s4.stage4_has_narrative ??
                !!(s4State.selected_crisis_id_first || Object.keys(s4State.diagnosis_answers_first || {}).length);
              const injected = s4.crisis_injected || narrative;
              const doneCount = s4.done_count ?? 0;
              const totalActions = s4.crisis_actions_count ?? 0;
              const timeTravel = s4State.time_travel_choice;
              const firstOutcome = s4State.first_outcome_key;

              let outcomeText = '';
              let outcomeColor = '#6b7280';
              if (!injected) {
                outcomeText = 'Кризисная ситуация не наступила';
                outcomeColor = '#10b981';
              } else if (firstOutcome === 'fixed') {
                outcomeText = 'Кризис предотвращён — вы исправили договор и устранили угрозу';
                outcomeColor = '#10b981';
              } else if (firstOutcome === 'noChange') {
                outcomeText =
                  'Возврат к договору без правок — сценарий ведёт ко второму кризису на другом основании';
                outcomeColor = '#f97316';
              } else if (firstOutcome === 'failed') {
                outcomeText = 'Диагностика не позволила предложить возврат — кризис сохраняется';
                outcomeColor = '#ef4444';
              } else if (firstOutcome === 'accept' || timeTravel === 'ignore') {
                outcomeText = 'Вы приняли последствия без исправления договора';
                outcomeColor = '#f59e0b';
              } else if (firstOutcome === 'repeat') {
                outcomeText = 'Кризис повторился — правки договора не устранили проблему';
                outcomeColor = '#ef4444';
              } else if (injected) {
                outcomeText = 'Кризисная ситуация наступила';
                outcomeColor = '#f59e0b';
              }

              const outcomeDetail =
                firstOutcome && STAGE4_OUTCOME_DETAILS[firstOutcome]
                  ? STAGE4_OUTCOME_DETAILS[firstOutcome]
                  : null;
              const firstBrief = s4.first_crisis_brief;
              const secondBrief = s4.second_crisis_brief;
              const dFirst = s4.first_crisis_diagnosis_choices || {};
              const dSecond = s4.second_crisis_diagnosis_choices || {};
              const contractReadable = s4.contract_edit_choices_readable || [];
              const secondHint =
                s4.second_crisis_outcome_hint
                || (dSecond.first_measure_choice
                  ? `Первая мера (по данным сессии): ${dSecond.first_measure_choice}`
                  : null);
              const hasSecond =
                !!(secondBrief || s4State.selected_crisis_id_second || Object.keys(s4State.diagnosis_answers_second || {}).length);
              const crisisGaps = gapNotes.filter(
                (x) => typeof x === 'string' && (x.startsWith('Кризис') || x.includes('Кризис:')),
              );

              return (
                <StageDetailBlock
                  icon="🚨"
                  title="Этап 4 — Кризис и последствия"
                  color={{ bg: '#faf5ff', border: '#e9d5ff', head: '#6b21a8' }}
                >
                  <MetricRow label="Итог кризиса">
                    <span style={{ fontSize: '13px', color: outcomeColor, fontWeight: '600' }}>
                      {outcomeText || (injected ? 'Кризис произошёл' : 'Кризиса не было')}
                    </span>
                  </MetricRow>
                  {timeTravel === 'return' && (
                    <MetricRow label="Возврат в договор"
                      value="Да"
                      hint="Редактор договора с таймером (до 10 мин), варианты A/B/C по пунктам" />
                  )}
                  {timeTravel === 'ignore' && (
                    <MetricRow label="Возврат в договор"
                      value="Нет"
                      hint="Вы предпочли принять последствия без изменения договора" />
                  )}
                  {totalActions > 0 && (
                    <MetricRow label="Антикризисные действия" value={`${doneCount} из ${totalActions}`}
                      valueColor={doneCount === totalActions ? '#10b981' : '#f59e0b'} />
                  )}
                  {injected && (firstBrief?.summary || s4State.selected_crisis_id_first) && (
                    <>
                      <div style={{
                        marginTop: '14px',
                        marginBottom: '6px',
                        fontSize: '12px',
                        fontWeight: '700',
                        color: '#5b21b6',
                        letterSpacing: '0.02em',
                      }}>
                        Первый кризис
                      </div>
                      <MetricRow label="Ситуация">
                        <span style={{ fontSize: '12px', color: '#374151', lineHeight: 1.5, fontWeight: 500 }}>
                          {firstBrief?.summary
                            || `Идентификатор сценария: ${s4State.selected_crisis_id_first}`}
                        </span>
                      </MetricRow>
                      {(dFirst.threat_choice || (dFirst.legal_basis_choices || []).length || dFirst.first_measure_choice) && (
                        <div style={{ marginTop: '10px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '600', color: '#5b21b6', marginBottom: '6px' }}>
                            Ваши ответы в диагностике (1-й кризис)
                          </div>
                          {dFirst.threat_choice && (
                            <MetricRow label="Степень угрозы">
                              <span style={{ fontSize: '12px', color: '#374151' }}>{dFirst.threat_choice}</span>
                            </MetricRow>
                          )}
                          {(dFirst.legal_basis_choices || []).length > 0 && (
                            <MetricRow label="Правовое основание">
                              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#374151', lineHeight: 1.45 }}>
                                {(dFirst.legal_basis_choices || []).map((t, i) => (
                                  <li key={i}>{t}</li>
                                ))}
                              </ul>
                            </MetricRow>
                          )}
                          {dFirst.first_measure_choice && (
                            <MetricRow label="Мера в первую очередь">
                              <span style={{ fontSize: '12px', color: '#374151' }}>{dFirst.first_measure_choice}</span>
                            </MetricRow>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {injected && timeTravel === 'return' && contractReadable.length > 0 && (
                    <div style={{ marginTop: '12px' }}>
                      <div style={{ fontSize: '11px', fontWeight: '600', color: '#5b21b6', marginBottom: '6px' }}>
                        Выбор в редакторе договора (возврат ко времени до кризиса)
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#374151', lineHeight: 1.45 }}>
                        {contractReadable.map((row, i) => (
                          <li key={i}>
                            <span style={{ fontWeight: 600 }}>{row.clause_title}</span>
                            {': '}
                            {row.variant_label || row.variant_id}
                            {row.variant_summary ? ` — ${row.variant_summary}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {injected && outcomeDetail && (
                    <>
                      <MetricRow label="Исход (шаги 3–5)">
                        <span style={{ fontSize: '12px', color: '#1f2937', lineHeight: 1.45, fontWeight: 600 }}>
                          {outcomeDetail.headline}
                        </span>
                      </MetricRow>
                      <MetricRow label="Хронология (схема)">
                        <ul style={{
                          margin: 0,
                          paddingLeft: '18px',
                          fontSize: '12px',
                          color: '#4b5563',
                          lineHeight: 1.5,
                        }}>
                          {outcomeDetail.timeline.map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                      </MetricRow>
                      <MetricRow label="Пояснение">
                        <span style={{ fontSize: '11px', color: '#6b7280', lineHeight: 1.45 }}>
                          {outcomeDetail.detail}
                        </span>
                      </MetricRow>
                    </>
                  )}
                  {injected && hasSecond && (
                    <>
                      <div style={{
                        marginTop: '14px',
                        marginBottom: '6px',
                        fontSize: '12px',
                        fontWeight: '700',
                        color: '#5b21b6',
                        letterSpacing: '0.02em',
                      }}>
                        Второй кризис (шаг 6)
                      </div>
                      <MetricRow label="Сценарий">
                        <span style={{ fontSize: '12px', color: '#374151', lineHeight: 1.5, fontWeight: 500 }}>
                          {secondBrief?.summary
                            || (s4State.selected_crisis_id_second
                              ? `Идентификатор сценария: ${s4State.selected_crisis_id_second}`
                              : 'Сценарий второго кризиса')}
                        </span>
                      </MetricRow>
                      <MetricRow label="Режим">
                        <span style={{ fontSize: '11px', color: '#6b7280', lineHeight: 1.45 }}>
                          Редактирование договора не предусмотрено — только диагностика (угроза, основание, мера) и фиксация последствий.
                        </span>
                      </MetricRow>
                      {(dSecond.threat_choice || (dSecond.legal_basis_choices || []).length || dSecond.first_measure_choice) && (
                        <div style={{ marginTop: '10px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '600', color: '#5b21b6', marginBottom: '6px' }}>
                            Ваши ответы в диагностике (2-й кризис)
                          </div>
                          {dSecond.threat_choice && (
                            <MetricRow label="Степень угрозы">
                              <span style={{ fontSize: '12px', color: '#374151' }}>{dSecond.threat_choice}</span>
                            </MetricRow>
                          )}
                          {(dSecond.legal_basis_choices || []).length > 0 && (
                            <MetricRow label="Правовое основание">
                              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#374151', lineHeight: 1.45 }}>
                                {(dSecond.legal_basis_choices || []).map((t, i) => (
                                  <li key={i}>{t}</li>
                                ))}
                              </ul>
                            </MetricRow>
                          )}
                          {dSecond.first_measure_choice && (
                            <MetricRow label="Мера в первую очередь">
                              <span style={{ fontSize: '12px', color: '#374151' }}>{dSecond.first_measure_choice}</span>
                            </MetricRow>
                          )}
                        </div>
                      )}
                      {secondHint && (
                        <MetricRow label="Итог второго кризиса">
                          <span style={{ fontSize: '12px', color: '#1f2937', lineHeight: 1.45, fontWeight: 500 }}>
                            {secondHint}
                          </span>
                        </MetricRow>
                      )}
                    </>
                  )}
                  {injected && crisisGaps.length > 0 && (
                    <div style={{ marginTop: '12px' }}>
                      <div style={{ fontSize: '12px', fontWeight: '600', color: '#6b21a8', marginBottom: '6px' }}>
                        На что обратить внимание (кризис)
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#4b5563', lineHeight: 1.5 }}>
                        {crisisGaps.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </StageDetailBlock>
              );
            })()}

            {!hasAnyStageDetails && (
              <p style={{ color: '#9ca3af', fontStyle: 'italic' }}>Детальные данные по этапам недоступны.</p>
            )}
          </div>
        )}

        {activeSection === 'stage4bridge' && (
          <div>
            <h3 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1f2937', marginBottom: '12px' }}>
              Мост этапа 3 → этап 4
            </h3>
            <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '20px', lineHeight: 1.5 }}>
              Согласованный текст переговоров, буква A/B/C для логики кризиса на этапе 4 и источник сопоставления
              (exact / normalized / fuzzy / llm / default).
            </p>
            {stage4BridgeLoading && <p style={{ color: '#6b7280' }}>Загрузка…</p>}
            {stage4BridgeErr && (
              <div style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '8px',
                padding: '12px',
                color: '#b91c1c',
              }}
              >
                {stage4BridgeErr}
              </div>
            )}
            {!stage4BridgeLoading && !stage4BridgeErr && stage4Bridge && (
              <>
                {!stage4Bridge.bridge && (
                  <p style={{ color: '#6b7280' }}>
                    Для этой сессии запись моста в БД не найдена (этап 3 не завершён или миграция не применена).
                  </p>
                )}
                {stage4Bridge.bridge && (() => {
                  const b = stage4Bridge.bridge;
                  const sel = b.contract_selections || {};
                  const src = b.selection_source || {};
                  const orig = b.original_text_by_clause_id || {};
                  const snap = b.option_texts_snapshot || {};
                  const cids = [...new Set([
                    ...Object.keys(sel),
                    ...Object.keys(orig),
                    ...Object.keys(snap),
                  ])].sort();
                  return (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                            <th style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>clause_id</th>
                            <th style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Выбор</th>
                            <th style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Источник</th>
                            <th style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Согласованный текст</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cids.map((cid) => {
                            const s = src[cid];
                            const srcLabel = typeof s === 'string' ? s : (s && s.source) || '—';
                            return (
                              <tr key={cid} style={{ borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' }}>
                                <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '12px' }}>{cid}</td>
                                <td style={{ padding: '8px', fontWeight: 600 }}>{sel[cid] || '—'}</td>
                                <td style={{ padding: '8px' }}>{srcLabel}</td>
                                <td style={{ padding: '8px', color: '#374151', maxWidth: '420px' }}>
                                  <div style={{ maxHeight: '88px', overflow: 'auto' }}>{orig[cid] || '—'}</div>
                                  {snap[cid] && (
                                    <details style={{ marginTop: '6px', fontSize: '11px', color: '#64748b' }}>
                                      <summary style={{ cursor: 'pointer' }}>Варианты A/B/C (снимок)</summary>
                                      <pre style={{
                                        whiteSpace: 'pre-wrap',
                                        margin: '6px 0 0',
                                        fontSize: '10px',
                                        wordBreak: 'break-word',
                                      }}
                                      >
                                        {JSON.stringify(snap[cid], null, 0)}
                                      </pre>
                                    </details>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {activeSection === 'lexic_lab' && showLexicLabTab && (labLedger ? (() => {
          const intro = labLedger.intro || {};
          const totals = labLedger.totals || {};
          const snaps = Array.isArray(labLedger.snapshots_table) ? labLedger.snapshots_table : [];
          const stages = Array.isArray(labLedger.detail_stages) ? labLedger.detail_stages : [];
          const lineColor = (kind) => {
            if (kind === 'minus') return '#b91c1c';
            if (kind === 'plus') return '#047857';
            return '#374151';
          };
          return (
            <div>
              <h3 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1f2937', marginBottom: '8px' }}>
                {intro.title || 'Разбор LEXIC'}
              </h3>
              <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '16px' }}>
                Вкладка только для участников группы «ЛабЛигалТех» (методическая отладка и прозрачность расчёта).
              </p>
              {(intro.paragraphs || []).map((p, i) => (
                <p key={i} style={{ fontSize: '14px', color: '#475569', lineHeight: 1.65, margin: '0 0 12px 0' }}>
                  {p}
                </p>
              ))}
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '16px',
                marginBottom: '24px',
                alignItems: 'flex-end',
              }}
              >
                <div style={{
                  padding: '16px 20px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
                  border: '1px solid #bfdbfe',
                  minWidth: '200px',
                }}
                >
                  <div style={{ fontSize: '12px', color: '#1d4ed8', fontWeight: 600, marginBottom: '4px' }}>
                    Итог на «эталонной» шкале 0–100
                  </div>
                  <div style={{ fontSize: '32px', fontWeight: 800, color: '#1e3a8a' }}>
                    {totals.score_on_ideal_scale_0_100 ?? '—'}
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748b', marginTop: '6px', maxWidth: '280px' }}>
                    {totals.formula_short}
                  </div>
                </div>
              </div>
              <h4 style={{ fontSize: '15px', fontWeight: 700, color: '#1f2937', margin: '20px 0 10px' }}>
                Нормализованный профиль и зазор до 100
              </h4>
              <div style={{ overflowX: 'auto', marginBottom: '20px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                      <th style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Ось</th>
                      <th style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Нормализовано (отчёт)</th>
                      <th style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>До эталона 100</th>
                      <th style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Сырой профиль (после согласованности L/I)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PARAMS.map((p) => (
                      <tr key={p} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px', fontWeight: 600 }}>{p} — {PARAM_META[p]?.label || p}</td>
                        <td style={{ padding: '8px' }}>{totals.final_normalized?.[p] ?? '—'}</td>
                        <td style={{ padding: '8px' }}>{totals.gap_to_100_per_param?.[p] ?? '—'}</td>
                        <td style={{ padding: '8px' }}>{totals.raw_profile_after_coherence?.[p] ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {labLedger.stage2_recomputed === false && (
                <p style={{ fontSize: '12px', color: '#92400e', marginBottom: '16px' }}>
                  Этап 2: полный пошаговый разбор не восстановлен из матрицы кейса — показана краткая сводка из отчёта.
                </p>
              )}
              <h4 style={{ fontSize: '15px', fontWeight: 700, color: '#1f2937', margin: '20px 0 10px' }}>
                Снимки по этапам (сырые дельты → нормализация в 0–100)
              </h4>
              {snaps.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: '14px' }}>Нет записей session_lexic_stage (нормализация недоступна).</p>
              ) : (
                <div style={{ overflowX: 'auto', marginBottom: '24px' }}>
                  {snaps.map((row) => (
                    <div
                      key={row.stage_code}
                      style={{
                        marginBottom: '16px',
                        padding: '12px 14px',
                        background: '#f8fafc',
                        borderRadius: '10px',
                        border: '1px solid #e2e8f0',
                      }}
                    >
                      <div style={{ fontWeight: 700, color: '#334155', marginBottom: '8px' }}>
                        {row.title} <span style={{ fontWeight: 500, color: '#64748b' }}>(вес {row.weight})</span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead>
                          <tr style={{ textAlign: 'left', color: '#64748b' }}>
                            <th style={{ padding: '4px 6px' }}>Ось</th>
                            <th style={{ padding: '4px 6px' }}>Сырая Δ</th>
                            <th style={{ padding: '4px 6px' }}>Норма 0–100</th>
                            <th style={{ padding: '4px 6px' }}>Границы Δ (min…max)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {PARAMS.map((p) => {
                            const rd = row.raw_deltas?.[p];
                            const ns = row.normalized_scores?.[p];
                            const b = row.bounds?.[p];
                            const span = b && `${b.min} … ${b.max}`;
                            return (
                              <tr key={p} style={{ borderTop: '1px solid #e2e8f0' }}>
                                <td style={{ padding: '6px', fontWeight: 600 }}>{p}</td>
                                <td style={{ padding: '6px' }}>{rd ?? '—'}</td>
                                <td style={{ padding: '6px' }}>{ns != null ? ns : '—'}</td>
                                <td style={{ padding: '6px', fontSize: '11px', color: '#64748b' }}>{span || '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
              <h4 style={{ fontSize: '15px', fontWeight: 700, color: '#1f2937', margin: '20px 0 10px' }}>
                Понятный разбор начислений по этапам
              </h4>
              {stages.map((block) => (
                <div
                  key={block.stage_code}
                  style={{
                    marginBottom: '18px',
                    padding: '14px 16px',
                    borderRadius: '10px',
                    border: '1px solid #e5e7eb',
                    background: 'white',
                  }}
                >
                  <div style={{ fontWeight: 700, color: '#111827', marginBottom: '10px' }}>{block.title}</div>
                  <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', lineHeight: 1.6 }}>
                    {(block.lines || []).map((ln, j) => (
                      <li key={j} style={{ color: lineColor(ln.kind), marginBottom: '6px' }}>
                        {ln.text}
                        {(ln.params || []).length > 0 && (
                          <span style={{ fontSize: '11px', color: '#94a3b8', marginLeft: '6px' }}>
                            [{ln.params.join(', ')}]
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          );
        })() : (
          <div>
            <h3 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1f2937', marginBottom: '12px' }}>
              Разбор LEXIC
            </h3>
            <p style={{ fontSize: '14px', color: '#64748b', lineHeight: 1.6, marginBottom: '12px' }}>
              Сервер не вернул блок <code style={{ fontSize: '12px' }}>lexic_lab_ledger</code> (поле отсутствует или при сборке отчёта была ошибка).
              Перезапустите бэкенд с актуальным кодом и снова сгенерируйте отчёт. Если группа в админке уже «ЛабЛигалТех», а служебных экранов (например «Замечания QA») не видно — выполните выход и повторный вход, чтобы в сессии обновились{' '}
              <code style={{ fontSize: '12px' }}>group_name</code> и отчёт.
            </p>
          </div>
        ))}

        {(onRestart || onBackToStart) && (
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '40px', flexWrap: 'wrap' }}>
            {onRestart && (
              <button
                type="button"
                onClick={onRestart}
                style={{
                  padding: '12px 28px',
                  borderRadius: '10px',
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  fontSize: '15px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                🔄 Пройти ещё раз
              </button>
            )}
            {onBackToStart && (
              <button
                type="button"
                onClick={onBackToStart}
                style={{
                  padding: '12px 28px',
                  borderRadius: '10px',
                  background: 'white',
                  color: '#374151',
                  border: '2px solid #e5e7eb',
                  fontSize: '15px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                ← Вернуться к началу
              </button>
            )}
          </div>
        )}
      </div>
      <LexicHelpModal paramKey={lexicHelpKey} onClose={() => setLexicHelpKey(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Вспомогательные компоненты для блоков деталей по этапам
// ---------------------------------------------------------------------------

function StageDetailBlock({ icon, title, color, children }) {
  return (
    <div style={{
      marginBottom: '16px',
      padding: '16px 20px',
      background: color.bg,
      borderRadius: '12px',
      border: `1px solid ${color.border}`,
    }}>
      <h4 style={{
        color: color.head,
        marginBottom: '12px',
        fontSize: '15px',
        fontWeight: '700',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        {icon} {title}
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {children}
      </div>
    </div>
  );
}

function MetricRow({ label, value, valueColor, hint, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', minHeight: '24px' }}>
      <span style={{
        fontSize: '12px',
        color: '#6b7280',
        minWidth: '180px',
        paddingTop: '2px',
        flexShrink: 0,
      }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', flex: 1, flexWrap: 'wrap', gap: '4px' }}>
        {children || (
          <span style={{ fontSize: '13px', fontWeight: '600', color: valueColor || '#1f2937' }}>
            {value}
          </span>
        )}
        {hint && (
          <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: '4px' }}>
            — {hint}
          </span>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ value, color }) {
  return (
    <div style={{
      width: '100px',
      height: '8px',
      background: '#e5e7eb',
      borderRadius: '999px',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      <div style={{
        width: `${Math.max(0, Math.min(100, value))}%`,
        height: '100%',
        background: color,
        transition: 'width 0.4s ease',
      }} />
    </div>
  );
}

function DeltaBadge({ delta }) {
  const isPositive = delta > 0;
  const isNeutral = delta === 0;
  return (
    <span style={{
      fontSize: '12px',
      fontWeight: '700',
      color: isNeutral ? '#6b7280' : isPositive ? '#10b981' : '#ef4444',
      background: isNeutral ? '#f3f4f6' : isPositive ? '#d1fae5' : '#fee2e2',
      padding: '2px 8px',
      borderRadius: '999px',
    }}>
      {isPositive ? '+' : ''}{delta}
    </span>
  );
}
