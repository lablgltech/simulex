/**
 * Этап 2: Формирование позиции — тренажёр по рискам в договоре
 * Договор и светофор рисков, модалка сравнения после «Готово!», «Документы» — тот же DocumentsModal со списком из /case/docs (reference_docs), как на остальных этапах.
 * Панель «Результаты проверки» на экране этапа отключена (см. SHOW_STAGE2_ONSCREEN_VALIDATION_REPORT).
 */
import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import MarkdownContent from './MarkdownContent';
import DocumentsModal from './DocumentsModal';
import { API_URL, getAuthHeaders } from '../api/config';
import { handleApiError, safeFetch } from '../api/errorHandler';
import { readStageDraft, writeStageDraft, clearStageDraft } from '../utils/stageDraftStorage';
import { canonicalCaseCode } from '../utils/caseId';
import './contractDocumentClauses.css';

/** Панель «Результаты проверки» под заданием после валидации. Данные в сессии сохраняются, UI не показываем. */
const SHOW_STAGE2_ONSCREEN_VALIDATION_REPORT = false;

const RISK_LEVELS = [
  { id: 'high', label: 'Высокий', color: '#dc2626', light: '#fef2f2' },
  { id: 'medium', label: 'Средний', color: '#d97706', light: '#fffbeb' },
  { id: 'low', label: 'Низкий', color: '#059669', light: '#ecfdf5' },
];

/** Единый стиль чипов «Тип риска» (в тон синей подсветке выбранного пункта). */
const RISK_TAG_STYLE = { color: '#2563eb', light: '#eff6ff', border: '#93c5fd' };

/** Типы риска (теги) — необязательно, +5 баллов за каждый верный тег. */
const RISK_TAGS = [
  { id: 'legal', label: 'Юридический', ...RISK_TAG_STYLE },
  { id: 'financial', label: 'Финансовый', ...RISK_TAG_STYLE },
  { id: 'operational', label: 'Операционный', ...RISK_TAG_STYLE },
  { id: 'reputational', label: 'Репутационный', ...RISK_TAG_STYLE },
];

const RISK_TAG_HINTS = {
  legal: 'Нарушение норм права, ненадлежащее оформление, недействительность условий.',
  operational: 'Сбои в исполнении договора, нарушение сроков, логистические проблемы.',
  financial: 'Убытки, штрафные санкции, неплатёжеспособность контрагента.',
  reputational: 'Ущерб деловой репутации, огласка, конфликты с партнёрами.',
};

const SL_SUBLICENSE_TAG = 'право на сублицензирование';

/** Пасхалка: серия из >5 подряд пунктов договора (по порядку в тексте), на каждом впервые выбран уровень риска. */
const CONTRACT_APOCALYPSE_EGG_COPY = 'У нас тут договор или апокалипсис?';
const CONTRACT_APOCALYPSE_EGG_SUBCOPY = 'Ты уверен, что риски везде?';

/** Идеальный выбор в «дополнительных условиях» (все верные, без лишних). */
const MISSING_CONDITIONS_PERFECT_TITLE = 'Подозрительно идеально!';
const MISSING_CONDITIONS_PERFECT_SUB = 'Ты точно не ИИ?';

function isExactMissingConditionsPerfect(selected, correctList) {
  const c = new Set(correctList.map((x) => String(x).trim()));
  const s = new Set(selected.map((x) => String(x).trim()).filter(Boolean));
  if (s.size !== c.size) return false;
  for (const item of c) {
    if (!s.has(item)) return false;
  }
  return true;
}

/** Теги облака «Хочу добавить в договор» — игрок может выбрать нужные кликом. */
const MISSING_CONDITIONS_TAGS = [
  SL_SUBLICENSE_TAG,
  'контрагент действует в пределах предоставленных прав',
  'контрагент не нарушает прав третьих лиц',
  'качество соответствует ТЗ',
  'гарантийный срок',
  'у третьих лиц нет исключительных прав',
  'обстоятельства, препятствующие использованию ПО отсутствуют',
  'заверения и гарантии достоверны',
  'контрагент всегда отвечает за претензии и убытки',
  'только контрагент урегулирует претензии',
];

/** Верные ответы для отчёта (если бэкенд не прислал). Неверно: гарантийный срок, контрагент всегда отвечает…, только контрагент урегулирует… */
const CORRECT_MISSING_CONDITIONS_REPORT = [
  SL_SUBLICENSE_TAG,
  'контрагент действует в пределах предоставленных прав',
  'контрагент не нарушает прав третьих лиц',
  'у третьих лиц нет исключительных прав',
  'качество соответствует ТЗ',
  'обстоятельства, препятствующие использованию ПО отсутствуют',
  'заверения и гарантии достоверны',
];

/** Эталон: для каждого пункта — список id тегов, которые для него верны (для отчёта, если бэкенд не прислал correct_tags). */
const CORRECT_TAGS_BY_CLAUSE = {
  '1.4.1': ['legal', 'operational'],
  '1.4.2': ['operational', 'financial'],
  '1.7': ['legal', 'operational'],
  '2.3': ['operational', 'financial'],
  '3.1': ['legal', 'financial'],
  '3.2': ['legal', 'financial'],
  '4.2': ['legal', 'operational'],
  '5.1': ['operational', 'financial'],
  '6.1': ['financial'],
  '6.2': ['legal', 'financial'],
  '6.3': ['legal', 'financial'],
  '6.4': ['legal', 'financial', 'reputational'],
  '7.1': ['operational', 'financial'],
  '8.1': ['legal', 'financial', 'reputational'],
  '9.2': ['legal', 'operational', 'financial'],
};

/** Варианты ответа на вопрос «А почему именно этот?» (порядок при показе — случайный) */
const WHY_REASONS = [
  'Пункт создает юридическую неопределенность или уязвимость',
  'Есть риск несоответствия законодательству/невозможности исполнения',
  'Есть угроза бюджету/экономической эффективности сделки',
  'Формулировка создает риск для имиджа/отношений с контрагентами',
  'Есть угроза публичному восприятию компании',
  'Формулировка создает сложности в практическом исполнении',
  'Есть риск для повседневной деятельности или ресурсов',
  'Отсутствие защитного механизма',
  'Несбалансированность прав сторон',
  'Неограниченная ответственность',
  'Скрытые затраты',
  'Недостаток ресурсов',
  'Технические ограничения',
  'Зависимость от третьих лиц',
];

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Мультяшный «бот» для модалки про слишком идеальный выбор доп. условий. */
function SuspiciousAiCartoon() {
  return (
    <svg
      viewBox="0 0 200 200"
      width={140}
      height={140}
      style={{ display: 'block', margin: '0 auto 8px' }}
      aria-hidden
    >
      <rect x="40" y="48" width="120" height="100" rx="24" fill="#e0e7ff" stroke="#6366f1" strokeWidth="3" />
      <rect x="52" y="64" width="36" height="28" rx="6" fill="#c7d2fe" stroke="#4f46e5" strokeWidth="2" />
      <rect x="112" y="64" width="36" height="28" rx="6" fill="#c7d2fe" stroke="#4f46e5" strokeWidth="2" />
      <circle cx="70" cy="78" r="6" fill="#312e81" />
      <circle cx="130" cy="78" r="6" fill="#312e81" />
      <path d="M78 112 Q100 98 122 112" fill="none" stroke="#4338ca" strokeWidth="3" strokeLinecap="round" />
      <rect x="88" y="124" width="24" height="8" rx="2" fill="#6366f1" />
      <path d="M100 36 L94 22 L106 22 Z" fill="#a5b4fc" />
      <circle cx="34" cy="92" r="6" fill="#fbbf24" opacity="0.9" />
      <circle cx="166" cy="88" r="5" fill="#fbbf24" opacity="0.85" />
      <text x="100" y="188" textAnchor="middle" fill="#64748b" fontSize="22" fontWeight="700" fontFamily="'Montserrat', system-ui, sans-serif">
        ?
      </text>
    </svg>
  );
}

/** Единственный источник подписей ячеек матрицы — только эти короткие названия (никогда не цитата из договора). */
const SHORT_CLAUSE_LABELS = {
  '1.4.1': 'Территория использования',
  '1.4.2': 'Срок использования',
  '1.6': 'Доп. лицензии',
  '1.7': 'Кастомизация',
  '2.3': 'Режим поддержки',
  '3.1': 'Стоимость и НДС',
  '3.2': 'Порядок оплаты',
  '4.1': 'Акты использования ПО и сопровождение',
  '4.2': 'Акты и приёмка',
  '5.1': 'Гарантийный срок',
  '6.1': 'Неустойка (оплата)',
  '6.2': 'Неустойка (работы)',
  '6.3': 'Лимит ответственности',
  '6.4': 'Исключения из возмещения',
  '7.1': 'Претензионный порядок',
  '7.2': 'Подсудность',
  '8.1': 'Персональные данные',
  '9.2': 'Расторжение',
};

/** Общие названия для матрицы рисков (без цитаты из пункта). Для неизвестных — «Пункт X.X». */
function getClauseShortTitle(clauses, clauseId) {
  const key = String(clauseId).trim();
  if (SHORT_CLAUSE_LABELS[key]) return SHORT_CLAUSE_LABELS[key];
  return `Пункт ${key}`;
}

/** В момент отрисовки: если подпись похожа на цитату из договора — подменяем на короткую из словаря. */
function ensureMatrixLabel(text, clauseId) {
  const key = String(clauseId).trim();
  const shortLabel = SHORT_CLAUSE_LABELS[key] ?? `Пункт ${key}`;
  if (text == null || typeof text !== 'string') return shortLabel;
  const t = text.trim();
  if (t.length > 45) return shortLabel;
  if (/^(Заказчик|Исполнитель|Режим работы|По результатам|Стоимость определяется|СТОИМОСТЬ И ПОРЯДОК|ГАРАНТИИ|ОТВЕТСТВЕННОСТЬ)/i.test(t)) return shortLabel;
  return t;
}

/** Мини-спидометр: полукруглая шкала + стрелка в цвете риска */
function SpeedometerIcon({ color, size = 44 }) {
  const w = size;
  const h = size * 0.55;
  const cx = w / 2;
  const cy = h * 0.92;
  const r = w * 0.38;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', flexShrink: 0 }}>
      {/* Дуга шкалы (полукруг снизу) */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none"
        stroke={color}
        strokeWidth={Math.max(2, size / 14)}
        strokeLinecap="round"
      />
      {/* Стрелка (указывает вверх — «максимум») */}
      <line
        x1={cx}
        y1={cy}
        x2={cx}
        y2={cy - r * 0.75}
        stroke={color}
        strokeWidth={Math.max(1.5, size / 20)}
        strokeLinecap="round"
      />
      {/* Кружок в центре крепления стрелки */}
      <circle cx={cx} cy={cy} r={size / 16} fill={color} />
    </svg>
  );
}

export default function Stage2View({
  session,
  stage,
  onAction,
  onComplete,
  timeRemaining,
  onFinishCase,
  onSessionUpdate,
  /** Время входа на текущий этап (ms) — для E: секунды до «Готово» */
  stageStartTime,
  caseData,
  showBriefModal = false,
  onCloseBriefModal,
  /** Документы для модалки: полный ответ /case/docs после merge динамического брифа (передаёт GameView). */
  documentsModalDocs = [],
  documentsModalLoading = false,
  documentsModalError = null,
  /** Шаги локального тура: s2-traffic — выбрать первый пункт; s2-risk-types — показать ряд типов риска */
  simulatorTourStepId = null,
  /** Запрос завершения этапа на сервере — как на этапах 1 и 4 */
  stageCompleteInFlight = false,
  /** Callback для отправки вопроса босса (голосовалки) в Симуграм вместо модалки */
  onBossPoll,
}) {
  const [contract, setContract] = useState({ title: '', preamble: '', trailer: '', clauses: [] });
  const [gameConfig, setGameConfig] = useState({});
  const [riskDescriptions, setRiskDescriptions] = useState([]);
  const [riskMatrix, setRiskMatrix] = useState({}); // эталонная матрица: clause_id -> high|medium|low
  const [selectedClauseId, setSelectedClauseId] = useState(null);
  const [clauseRisks, setClauseRisks] = useState({});
  const [clauseTags, setClauseTags] = useState({}); // clause_id -> ['legal', 'financial', ...], необязательно
  const [selectedMissingConditions, setSelectedMissingConditions] = useState([]); // выбранные пункты из облака «В договоре не хватает условий»
  const [riskSelectionOrder, setRiskSelectionOrder] = useState([]);

  const clauseRiskKey = (id) => String(id ?? '').trim();
  const [radarPlacements, setRadarPlacements] = useState({});
  const [radarPlacementsByZone, setRadarPlacementsByZone] = useState({
    legal: [],
    reputational: [],
    financial: [],
    operational: [],
  });
  const [stage2Report, setStage2Report] = useState(null);
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState(null);
  const [showTaskResultModal, setShowTaskResultModal] = useState(false);
  const [modalClauseTextId, setModalClauseTextId] = useState(null);
  const [showBossChoiceModal, setShowBossChoiceModal] = useState(false);
  const [bossChoiceClauseId, setBossChoiceClauseId] = useState(null);
  const [showWhyModal, setShowWhyModal] = useState(false);

  /** Подписи ячеек матрицы — только из SHORT_CLAUSE_LABELS или «Пункт X.X». API/risk_descriptions не используем для подписи, чтобы никогда не показывать цитату из договора. */
  const getCellLabel = useCallback((clauseId) => getClauseShortTitle(contract.clauses, clauseId), [contract.clauses]);
  const [whyModalClauseId, setWhyModalClauseId] = useState(null);
  /** Пасхалка: дрожь договора и модалка до закрытия (>5 пунктов подряд с первым выбором риска). */
  const [apocalypseContractShake, setApocalypseContractShake] = useState(false);
  const [showApocalypseEggModal, setShowApocalypseEggModal] = useState(false);
  const apocalypseEggDismissedRef = useRef(false);
  const [showMissingPerfectModal, setShowMissingPerfectModal] = useState(false);
  const missingConditionsUserTouchedRef = useRef(false);
  const missingPerfectModalShownOnceRef = useRef(false);
  const consecutiveRiskPickStreakRef = useRef({ lastDocIndex: null, len: 0 });
  const [whyReasonsShuffled, setWhyReasonsShuffled] = useState([]);
  const [selectedWhyReasons, setSelectedWhyReasons] = useState([]);
  const [justifying, setJustifying] = useState(false);
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const [riskTagTooltip, setRiskTagTooltip] = useState(null); // { text, x, y }
  const [s2DraftHydrated, setS2DraftHydrated] = useState(false);
  const radarContainerRef = React.useRef(null);
  const radarProcessDropRef = React.useRef(null);

  useLayoutEffect(() => {
    setS2DraftHydrated(false);
  }, [session?.id]);

  /** Обработка drop на радаре через document mouseup в родителе — работает после переключения со Светофора */
  const handleRadarDragStart = React.useCallback(() => {
    const handler = (e) => {
      document.removeEventListener('mouseup', handler, true);
      if (radarProcessDropRef.current) radarProcessDropRef.current(e.clientX, e.clientY);
    };
    document.addEventListener('mouseup', handler, true);
  }, []);

  const validationDone = session?.stage2_validation_done === true;
  /** После «Отправить на проверку» и после успешной проверки — договор и задание только для просмотра */
  const stage2GameUiLocked = validating || validationDone;
  const reportFromSession = session?.stage2_report;
  const reportToShow = stage2Report || reportFromSession;
  const canComplete = validationDone;

  /** Список тегов для UI: из game_config или дефолт; пункт про сублицензирование всегда присутствует. */
  const missingConditionsDisplayTags = useMemo(() => {
    const fromCfg = gameConfig?.missing_conditions_tags;
    const base =
      Array.isArray(fromCfg) && fromCfg.length > 0 ? [...fromCfg] : [...MISSING_CONDITIONS_TAGS];
    const hasSub = base.some((t) => String(t).trim() === SL_SUBLICENSE_TAG);
    return hasSub ? base : [SL_SUBLICENSE_TAG, ...base];
  }, [gameConfig]);

  /** Один уровень риска на пункт (без «дубликатов» ключей и мусорных значений). */
  const clauseRisksEffective = useMemo(() => {
    const m = {};
    for (const [k, v] of Object.entries(clauseRisks || {})) {
      const id = clauseRiskKey(k);
      if (id && (v === 'high' || v === 'medium' || v === 'low')) m[id] = v;
    }
    return m;
  }, [clauseRisks]);
  const hasSelectedRiskTypes = useMemo(() => {
    const riskIds = new Set(Object.keys(clauseRisksEffective));
    return Object.entries(clauseTags || {}).some(([k, arr]) => {
      const id = clauseRiskKey(k);
      return riskIds.has(id) && Array.isArray(arr) && arr.length > 0;
    });
  }, [clauseRisksEffective, clauseTags]);

  useEffect(() => {
    if (loading || simulatorTourStepId !== 's2-traffic') return;
    const firstId = contract.clauses?.[0]?.id;
    if (firstId != null) setSelectedClauseId(firstId);
  }, [simulatorTourStepId, loading, contract.clauses]);

  useEffect(() => {
    if (loading || simulatorTourStepId !== 's2-risk-types') return;
    const firstId = contract.clauses?.[0]?.id;
    if (firstId == null) return;
    const id = String(firstId).trim();
    setSelectedClauseId(firstId);
    setClauseRisks((prev) => {
      const v = prev[id];
      if (v === 'high' || v === 'medium' || v === 'low') return prev;
      return { ...prev, [id]: 'low' };
    });
  }, [simulatorTourStepId, loading, contract.clauses]);

  useEffect(() => {
    if (!session?.case_id || stage?.id !== 'stage-2') return;
    const caseIdParam = encodeURIComponent(canonicalCaseCode(session.case_id));
    setLoading(true);
    setError(null);
    safeFetch(`${API_URL}/stage/data?case_id=${caseIdParam}&stage_id=stage-2`)
      .then((data) => {
        const custom = data.custom_data || {};
        setContract({
          title: custom.contract_title || 'Договор',
          preamble: custom.contract_preamble || '',
          trailer: custom.contract_trailer || '',
          clauses: custom.clauses || [],
        });
        setGameConfig(custom.game_config || {});
        setRiskDescriptions(custom.risk_descriptions || []);
        setRiskMatrix(custom.risk_matrix || {});
        // Восстанавливаем выбор по пунктам только после того, как пользователь уже нажимал «Проверить» —
        // иначе при первом открытии договора не показываем чужой/старый выбор из сессии.
        if (session.stage2_validation_done && session.stage2_clause_risks && typeof session.stage2_clause_risks === 'object') {
          const norm = {};
          for (const [k, v] of Object.entries(session.stage2_clause_risks)) {
            const id = clauseRiskKey(k);
            if (id && (v === 'high' || v === 'medium' || v === 'low')) norm[id] = v;
          }
          setClauseRisks(norm);
          setRiskSelectionOrder(Object.keys(norm));
          const tags = {};
          if (session.stage2_clause_tags && typeof session.stage2_clause_tags === 'object') {
            for (const [k, v] of Object.entries(session.stage2_clause_tags)) {
              if (norm[clauseRiskKey(k)] && Array.isArray(v)) tags[clauseRiskKey(k)] = v;
            }
          }
          setClauseTags(tags);
        } else if (session.stage2_clause_tags && typeof session.stage2_clause_tags === 'object') {
          setClauseTags(session.stage2_clause_tags);
        }
        if (Array.isArray(session.stage2_missing_conditions_selected)) {
          setSelectedMissingConditions(session.stage2_missing_conditions_selected);
        }
        if (session.stage2_radar_placements && Object.keys(session.stage2_radar_placements).length > 0) {
          setRadarPlacements(session.stage2_radar_placements);
        }
        if (session.stage2_report) {
          setStage2Report(session.stage2_report);
        }

        const sess = sessionRef.current;
        const draft = sess?.id ? readStageDraft(sess.id, 2) : null;
        if (draft?.version === 1 && !sess?.stage2_validation_done) {
          if (draft.selectedClauseId != null && String(draft.selectedClauseId).trim() !== '') {
            setSelectedClauseId(draft.selectedClauseId);
          }
          if (draft.clauseRisks && typeof draft.clauseRisks === 'object') {
            setClauseRisks(draft.clauseRisks);
          }
          if (draft.clauseTags && typeof draft.clauseTags === 'object') {
            setClauseTags(draft.clauseTags);
          }
          if (Array.isArray(draft.selectedMissingConditions)) {
            setSelectedMissingConditions(draft.selectedMissingConditions);
          }
          if (Array.isArray(draft.riskSelectionOrder)) {
            setRiskSelectionOrder(draft.riskSelectionOrder);
          }
          if (draft.radarPlacements && typeof draft.radarPlacements === 'object') {
            setRadarPlacements(draft.radarPlacements);
          }
          if (draft.radarPlacementsByZone && typeof draft.radarPlacementsByZone === 'object') {
            setRadarPlacementsByZone((prev) => ({
              legal: Array.isArray(draft.radarPlacementsByZone.legal)
                ? draft.radarPlacementsByZone.legal
                : prev.legal,
              reputational: Array.isArray(draft.radarPlacementsByZone.reputational)
                ? draft.radarPlacementsByZone.reputational
                : prev.reputational,
              financial: Array.isArray(draft.radarPlacementsByZone.financial)
                ? draft.radarPlacementsByZone.financial
                : prev.financial,
              operational: Array.isArray(draft.radarPlacementsByZone.operational)
                ? draft.radarPlacementsByZone.operational
                : prev.operational,
            }));
          }
        }
      })
      .catch((err) => {
        setError(handleApiError(err));
        setContract({ title: '', clauses: [] });
      })
      .finally(() => {
        setS2DraftHydrated(true);
        setLoading(false);
      });
  }, [session?.case_id, session?.id, stage?.id]);

  useEffect(() => {
    if (!s2DraftHydrated || !session?.id || session.stage2_validation_done) return;
    writeStageDraft(session.id, 2, {
      version: 1,
      savedAt: Date.now(),
      selectedClauseId,
      clauseRisks,
      clauseTags,
      selectedMissingConditions,
      riskSelectionOrder,
      radarPlacements,
      radarPlacementsByZone,
    });
  }, [
    s2DraftHydrated,
    session?.id,
    session?.stage2_validation_done,
    selectedClauseId,
    clauseRisks,
    clauseTags,
    selectedMissingConditions,
    riskSelectionOrder,
    radarPlacements,
    radarPlacementsByZone,
  ]);

  const closeDocsModal = onCloseBriefModal || (() => {});

  const handleClauseClick = (clauseId) => {
    setSelectedClauseId(selectedClauseId === clauseId ? null : clauseId);
  };

  const handleRiskSelect = (levelId) => {
    if (!selectedClauseId) return;
    const id = clauseRiskKey(selectedClauseId);
    if (!id) return;
    const clauses = contract.clauses || [];
    const docIndex = clauses.findIndex((c) => clauseRiskKey(c.id) === id);
    let hadRiskBefore = false;
    for (const [k, v] of Object.entries(clauseRisks || {})) {
      if (clauseRiskKey(k) === id && (v === 'high' || v === 'medium' || v === 'low')) {
        hadRiskBefore = true;
        break;
      }
    }
    setClauseRisks((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (clauseRiskKey(k) === id) delete next[k];
      });
      next[id] = levelId;
      return next;
    });
    setRiskSelectionOrder((prev) => (prev.some((x) => clauseRiskKey(x) === id) ? prev : [...prev, id]));
    setSelectedClauseId(null);

    const streak = consecutiveRiskPickStreakRef.current;
    if (docIndex >= 0 && !hadRiskBefore) {
      if (streak.lastDocIndex === null) {
        streak.len = 1;
        streak.lastDocIndex = docIndex;
      } else if (docIndex === streak.lastDocIndex + 1) {
        streak.len += 1;
        streak.lastDocIndex = docIndex;
      } else {
        streak.len = 1;
        streak.lastDocIndex = docIndex;
      }
      if (streak.len <= 5) apocalypseEggDismissedRef.current = false;
      if (streak.len > 5 && !apocalypseEggDismissedRef.current) {
        setShowApocalypseEggModal(true);
        setApocalypseContractShake(true);
      }
    }
  };

  const closeApocalypseEggModal = () => {
    apocalypseEggDismissedRef.current = true;
    setShowApocalypseEggModal(false);
    setApocalypseContractShake(false);
  };

  const closeMissingPerfectModal = () => setShowMissingPerfectModal(false);

  useEffect(() => {
    if (!missingConditionsUserTouchedRef.current || missingPerfectModalShownOnceRef.current) return;
    if (!isExactMissingConditionsPerfect(selectedMissingConditions, CORRECT_MISSING_CONDITIONS_REPORT)) return;
    missingPerfectModalShownOnceRef.current = true;
    setShowMissingPerfectModal(true);
  }, [selectedMissingConditions]);

  /** Снять отметку риска по пункту (не показывать в матрице сравнения и в отчёте как выбор игрока). */
  const handleClearClauseRisk = (clauseId) => {
    const id = clauseRiskKey(clauseId);
    if (!id) return;
    setClauseRisks((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (clauseRiskKey(k) === id) delete next[k];
      });
      return next;
    });
    setClauseTags((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (clauseRiskKey(k) === id) delete next[k];
      });
      return next;
    });
    setRiskSelectionOrder((prev) => prev.filter((x) => clauseRiskKey(x) !== id));
    setSelectedClauseId(null);
    consecutiveRiskPickStreakRef.current = { lastDocIndex: null, len: 0 };
    apocalypseEggDismissedRef.current = false;
    setShowApocalypseEggModal(false);
    setApocalypseContractShake(false);
  };

  const handleClosePopup = () => setSelectedClauseId(null);

  const handleTagToggle = (clauseId, tagId) => {
    const cid = clauseRiskKey(clauseId);
    if (!cid) return;
    setClauseTags((prev) => {
      const list = prev[cid] || [];
      const next = list.includes(tagId) ? list.filter((t) => t !== tagId) : [...list, tagId];
      if (next.length === 0) {
        const rest = { ...prev };
        delete rest[cid];
        return rest;
      }
      return { ...prev, [cid]: next };
    });
  };


  const handleRadarPlacement = (clauseId, { axisIndex, value }) => {
    setRadarPlacements((prev) => ({ ...prev, [clauseId]: { axisIndex, value } }));
  };

  const handleRadarZonePlacement = (clauseId, zoneId) => {
    setRadarPlacementsByZone((prev) => ({
      ...prev,
      [zoneId]: prev[zoneId]?.includes(clauseId) ? prev[zoneId] : [...(prev[zoneId] || []), clauseId],
    }));
  };

  /** Пункты для радара (оставлено для возможного восстановления вкладки): пункты с высоким риском; если таких нет — все пункты договора (чтобы радар не был пустым) */
  const radarClauses = useMemo(() => {
    const clauses = contract.clauses || [];
    let ids = Object.entries(riskMatrix)
      .filter(([, level]) => level === 'high')
      .map(([id]) => id);
    if (ids.length === 0) ids = clauses.map((c) => c.id).filter(Boolean);
    ids.sort((a, b) => String(a).localeCompare(String(b)));
    return ids.map((clauseId) => {
      const c = clauses.find((x) => x.id === clauseId);
      const rawText = c?.text ? String(c.text).trim() : '';
      const textWithoutHeader = rawText.replace(/^##\s*\d+\.?\s*[^\n]*\n\n?/, '').trim() || rawText;
      return {
        clauseId,
        clauseLabel: textWithoutHeader ? `${clauseId}. ${textWithoutHeader}` : clauseId,
      };
    });
  }, [contract.clauses, riskMatrix]);

  const handleValidate = ({ onValidated } = {}) => {
    setValidating(true);
    setError(null);
    const stage2_seconds_elapsed =
      typeof stageStartTime === 'number' && stageStartTime > 0
        ? Math.max(0, Math.floor((Date.now() - stageStartTime) / 1000))
        : undefined;
    const clauseRisksPayload = {};
    for (const [k, v] of Object.entries(clauseRisks)) {
      const id = clauseRiskKey(k);
      if (id && (v === 'high' || v === 'medium' || v === 'low')) clauseRisksPayload[id] = v;
    }
    const riskIds = new Set(Object.keys(clauseRisksPayload));
    const clauseTagsSanitized = Object.fromEntries(
      Object.entries(clauseTags).filter(([k]) => riskIds.has(clauseRiskKey(k)))
    );
    safeFetch(`${API_URL}/stage/2/validate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
          session,
          clause_risks: clauseRisksPayload,
          clause_tags: clauseTagsSanitized,
          missing_conditions: selectedMissingConditions,
          ...(stage2_seconds_elapsed !== undefined ? { stage2_seconds_elapsed } : {}),
        }),
    })
      .then((data) => {
        if (data.session && onSessionUpdate) onSessionUpdate(data.session);
        if (data.session?.stage2_validation_done && data.session?.id) {
          clearStageDraft(data.session.id, 2);
        }
        if (data.report) {
          setStage2Report(data.report);
          setShowTaskResultModal(false);
          setModalClauseTextId(null);
          setClauseRisks(clauseRisksPayload);
          setClauseTags(clauseTagsSanitized);
          const hasRisks = Object.keys(clauseRisksPayload).length > 0;
          const didAdditionalTask = Object.values(clauseTagsSanitized).some(
            (arr) => Array.isArray(arr) && arr.length > 0
          );
          if (hasRisks && didAdditionalTask && onBossPoll) {
            const cid = data.session?.stage2_clarify_clause_id ?? data.report?.clarify_clause_id;
            const cidStr = cid != null ? String(cid).trim() : '';
            const cl = cidStr && (contract.clauses || []).find((c) => String(c.id).trim() === cidStr);
            const rawLabel = cl?.text && cl.text.startsWith('## ') && cl.text.includes('\n\n')
              ? cl.text.slice(cl.text.indexOf('\n\n') + 2)
              : cl?.text;
            const stripMdInline = (s) =>
              s ? s.replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\*([^*]*)\*/g, '$1')
                   .replace(/__([^_]*)__/g, '$1').replace(/_([^_]*)_/g, '$1')
                   .replace(/`([^`]*)`/g, '$1').trim() : '';
            const label = rawLabel ? `${cl.id}. ${stripMdInline(rawLabel)}` : (cidStr ? `Пункт ${cidStr}` : '');
            const tags = ((cidStr && clauseTagsSanitized[cidStr]) || [])
              .map((tagId) => RISK_TAGS.find((t) => t.id === tagId)?.label)
              .filter(Boolean);
            const pollId = `boss-poll-s2-${cidStr}-${Date.now()}`;
            onBossPoll({
              id: pollId,
              question: `Почему для пункта «${label}» выбраны именно эти типы риска?`,
              options: shuffleArray(WHY_REASONS),
              tags,
              onSubmit: (selectedReasons) => {
                const curSession = sessionRef.current;
                safeFetch(`${API_URL}/stage/2/justification`, {
                  method: 'POST',
                  headers: getAuthHeaders(),
                  body: JSON.stringify({
                    session: curSession,
                    clause_id: cidStr,
                    selected_reasons: selectedReasons,
                  }),
                })
                  .then((d) => {
                    if (d.session && onSessionUpdate) onSessionUpdate(d.session);
                    if (d.session?.stage2_report) setStage2Report(d.session.stage2_report);
                    onComplete?.(d.session || curSession);
                  })
                  .catch((err) => setError(handleApiError(err)));
              },
            });
          } else if (hasRisks && didAdditionalTask) {
            setShowBossChoiceModal(true);
          }
          if (typeof onValidated === 'function') onValidated(data.session, { didAdditionalTask });
        }
      })
      .catch((err) => setError(handleApiError(err)))
      .finally(() => setValidating(false));
  };

  const getRiskColor = (levelId) => {
    const r = RISK_LEVELS.find((x) => x.id === levelId);
    return r ? r.color : 'transparent';
  };

  /** Пункт для модалки босса — один случайный из отмеченных (задаётся бэкендом при «Готово»). */
  const bossModalClauseId = useMemo(() => {
    const sid = session?.stage2_clarify_clause_id ?? reportToShow?.clarify_clause_id;
    return sid != null && String(sid).trim() ? String(sid).trim() : null;
  }, [session?.stage2_clarify_clause_id, reportToShow?.clarify_clause_id]);

  useEffect(() => {
    if (showBossChoiceModal && bossModalClauseId) {
      setWhyReasonsShuffled(shuffleArray(WHY_REASONS));
      setSelectedWhyReasons([]);
      setWhyModalClauseId(bossModalClauseId);
    }
  }, [showBossChoiceModal, bossModalClauseId]);

  const handleSubmitJustification = () => {
    if (!whyModalClauseId) return;
    setJustifying(true);
    setError(null);
    safeFetch(`${API_URL}/stage/2/justification`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        session,
        clause_id: whyModalClauseId,
        selected_reasons: selectedWhyReasons,
      }),
    })
      .then((data) => {
        if (data.session && onSessionUpdate) onSessionUpdate(data.session);
        if (data.session?.stage2_report) setStage2Report(data.session.stage2_report);
        if (data.session?.id) clearStageDraft(data.session.id, 2);
        setShowWhyModal(false);
        setShowBossChoiceModal(false);
        setWhyModalClauseId(null);
        setSelectedWhyReasons([]);
        // После подтверждения обоснования сразу завершаем этап 2.
        onComplete?.(data.session || session);
      })
      .catch((err) => setError(handleApiError(err)))
      .finally(() => setJustifying(false));
  };

  return (
    <div
      style={{
        padding: 0,
        width: '100%',
        maxWidth: '100%',
        height: '100%',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxSizing: 'border-box',
        background: '#f5f5f5',
      }}
    >
      <div
        style={{
          padding: '0 16px 16px 16px',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
      {error && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #dc2626',
            color: '#991b1b',
            padding: '12px',
            borderRadius: '8px',
            marginBottom: '20px',
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: '#6b7280' }}>Загрузка договора...</p>
      ) : (
        <div data-tutor-highlight="stage2_main_tabs" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
            }}
          >
          {/* Одна белая область с тонкой чёрной рамкой (макет вайбкодинг) */}
          {apocalypseContractShake ? (
            <style>{`
              @keyframes stage2ContractApocalypseShake {
                0%, 100% { transform: translate(0, 0) rotate(0deg); }
                15% { transform: translate(-0.6px, 0.4px) rotate(-0.12deg); }
                30% { transform: translate(0.7px, -0.35px) rotate(0.1deg); }
                45% { transform: translate(-0.45px, -0.5px) rotate(-0.08deg); }
                60% { transform: translate(0.5px, 0.45px) rotate(0.11deg); }
                75% { transform: translate(-0.55px, 0.25px) rotate(-0.1deg); }
              }
            `}</style>
          ) : null}
          <div
            data-tutor-highlight="stage2_contract_area"
            style={{
              background: 'white',
              border: 'none',
              borderRadius: 12,
              boxShadow: '0 10px 28px rgba(15, 23, 42, 0.1)',
              padding: '24px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 400,
              ...(apocalypseContractShake
                ? {
                    animation: 'stage2ContractApocalypseShake 0.16s ease-in-out infinite',
                    willChange: 'transform',
                  }
                : {}),
            }}
          >
            {/* Рабочая область этапа: блокируется на время запроса проверки и после успешной валидации */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                pointerEvents: stage2GameUiLocked ? 'none' : 'auto',
                opacity: stage2GameUiLocked ? 0.88 : 1,
                transition: 'opacity 0.2s ease',
              }}
            >
            {/* Договор: название сверху, преамбула, пункты (название подраздела → номер пункта → текст), трейлер */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ marginTop: 0, marginBottom: '16px', color: '#1f2937', fontSize: '20px', fontWeight: 700, textAlign: 'center', letterSpacing: '0.02em' }}>
                {contract.title || 'Договор'}
              </h2>
              <div className="simulex-content">
              {contract.preamble ? (
                <div style={{ marginBottom: '20px' }}>
                  {(() => {
                    const firstLineEnd = contract.preamble.indexOf('\n');
                    const firstLine = firstLineEnd >= 0 ? contract.preamble.slice(0, firstLineEnd) : contract.preamble;
                    const rest = firstLineEnd >= 0 ? contract.preamble.slice(firstLineEnd + 1) : '';
                    const moscowLabel = '**г. Москва**';
                    const idx = firstLine.indexOf(moscowLabel);
                    if (idx >= 0) {
                      const leftPart = moscowLabel;
                      const rightPart = firstLine.slice(idx + moscowLabel.length).trim();
                      return (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px', marginBottom: rest ? '1em' : 0 }}>
                            <MarkdownContent content={leftPart} />
                            <span style={{ whiteSpace: 'nowrap' }}>{rightPart}</span>
                          </div>
                          {rest ? <MarkdownContent content={rest} /> : null}
                        </>
                      );
                    }
                    return <MarkdownContent content={contract.preamble} />;
                  })()}
                </div>
              ) : null}
              <div className="simulex-contract-clauses-list">
                {contract.clauses.map((clause) => {
                  const riskLevel = clauseRisksEffective[clauseRiskKey(clause.id)];
                  const isSelected = selectedClauseId === clause.id;
                  const stripColor = getRiskColor(riskLevel) || '#e5e7eb';
                  const sectionMatch = clause.text && clause.text.startsWith('## ') && clause.text.includes('\n\n');
                  const sectionTitle = sectionMatch ? clause.text.slice(0, clause.text.indexOf('\n\n')).replace(/^##\s*/, '') : null;
                  const clauseBody = sectionMatch ? clause.text.slice(clause.text.indexOf('\n\n') + 2) : clause.text;
                  const canPickClause = !stage2GameUiLocked;
                  const dimOthers = canPickClause && selectedClauseId != null && !isSelected;
                  const surfaceClass = [
                    'simulex-contract-clause-surface',
                    canPickClause && isSelected && 'simulex-contract-clause-surface--selected',
                    canPickClause && !isSelected && !dimOthers && 'simulex-contract-clause-surface--available',
                    dimOthers && 'simulex-contract-clause-surface--dimmed',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <div key={clause.id} className="simulex-contract-clause-stack">
                      {sectionTitle ? (
                        <div className="simulex-contract-section-heading">{sectionTitle}</div>
                      ) : null}
                      <div
                        style={{
                          display: 'flex',
                          gap: '16px',
                          alignItems: 'flex-start',
                        }}
                      >
                        <div
                          style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            minWidth: 0,
                            overflow: 'visible',
                          }}
                        >
                          <div
                            role="button"
                            tabIndex={canPickClause ? 0 : -1}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => canPickClause && handleClauseClick(clause.id)}
                            onKeyDown={(e) => {
                              if (!canPickClause) return;
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                handleClauseClick(clause.id);
                              }
                            }}
                            className={surfaceClass}
                            style={{ '--simulex-clause-strip': stripColor }}
                          >
                            <div className="simulex-contract-clause-inner">
                              <span className="simulex-contract-clause-num">{clause.id}.</span>
                              <div className="simulex-contract-clause-text">
                                <MarkdownContent content={clauseBody} />
                              </div>
                            </div>
                          </div>
                          {/* Теги — только после выбора уровня риска (красный/оранжевый/зелёный), без отдельной рамки */}
                          {riskLevel && (
                            <div
                              data-tutor-highlight="stage2_risk_type_row"
                              style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}
                            >
                              <span style={{ fontSize: '12px', color: '#64748b', marginRight: '4px' }}>Тип риска:</span>
                              {RISK_TAGS.map((tag) => {
                                const selected = (clauseTags[clauseRiskKey(clause.id)] || []).includes(tag.id);
                                const bg = selected ? tag.color : tag.light;
                                const border = selected ? tag.color : tag.border;
                                const textColor = selected ? '#fff' : tag.color;
                                const hint = RISK_TAG_HINTS[tag.id] || tag.label;
                                return (
                                  <button
                                    key={tag.id}
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); handleTagToggle(clauseRiskKey(clause.id), tag.id); }}
                                    onMouseEnter={(e) => {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      setRiskTagTooltip({
                                        text: hint,
                                        x: rect.left + rect.width / 2,
                                        y: rect.top - 10,
                                      });
                                    }}
                                    onMouseMove={(e) => {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      setRiskTagTooltip((prev) => (
                                        prev && prev.text === hint
                                          ? { ...prev, x: rect.left + rect.width / 2, y: rect.top - 10 }
                                          : prev
                                      ));
                                    }}
                                    onMouseLeave={() => setRiskTagTooltip(null)}
                                    onBlur={() => setRiskTagTooltip(null)}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '8px',
                                      fontSize: '13px',
                                      fontWeight: 600,
                                      padding: '6px 14px',
                                      borderRadius: '10px',
                                      border: `2px solid ${border}`,
                                      background: bg,
                                      color: textColor,
                                      cursor: 'pointer',
                                    }}
                                    aria-label={`${tag.label}: ${hint}`}
                                  >
                                    <span
                                      style={{
                                        width: 10,
                                        height: 10,
                                        borderRadius: '50%',
                                        background: selected ? '#fff' : tag.color,
                                        flexShrink: 0,
                                      }}
                                    />
                                    {tag.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      {/* Панель выбора риска — справа от выбранного пункта */}
                      {isSelected && (
                        <div
                          data-tutor-highlight="stage2_risk_panel"
                          style={{
                            background: 'linear-gradient(180deg, #fafafa 0%, #ffffff 100%)',
                            border: '1px solid #e5e7eb',
                            borderRadius: '12px',
                            padding: '20px',
                            minWidth: 160,
                            flexShrink: 0,
                            boxShadow: '0 4px 14px rgba(0,0,0,0.06)',
                          }}
                          role="dialog"
                          aria-label="Выбор уровня риска"
                        >
                          <p style={{
                            margin: '0 0 16px',
                            fontWeight: 600,
                            color: '#1e293b',
                            fontSize: '13px',
                          }}>
                            Уровень риска
                          </p>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', alignItems: 'center' }}>
                            {RISK_LEVELS.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                onClick={() => handleRiskSelect(r.id)}
                                title={r.label}
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'center',
                                  gap: '6px',
                                  background: 'none',
                                  border: 'none',
                                  padding: '6px',
                                  cursor: 'pointer',
                                  borderRadius: '10px',
                                  transition: 'transform 0.15s ease, background 0.15s ease',
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.transform = 'scale(1.06)';
                                  e.currentTarget.style.background = r.light;
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.transform = 'scale(1)';
                                  e.currentTarget.style.background = 'transparent';
                                }}
                              >
                                <SpeedometerIcon color={r.color} size={48} />
                                <span style={{
                                  fontSize: '11px',
                                  color: '#6b7280',
                                  letterSpacing: '0.02em',
                                  fontWeight: 500,
                                }}>
                                  {r.label}
                                </span>
                              </button>
                            ))}
                          </div>
                          {selectedClauseId && clauseRisksEffective[clauseRiskKey(selectedClauseId)] && (
                            <button
                              type="button"
                              onClick={() => handleClearClauseRisk(selectedClauseId)}
                              style={{
                                marginTop: '14px',
                                padding: '8px 12px',
                                background: '#fff7ed',
                                border: '1px solid #fdba74',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                width: '100%',
                                fontSize: '12px',
                                color: '#9a3412',
                                fontWeight: 600,
                              }}
                            >
                              Снять отметку риска
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={handleClosePopup}
                            style={{
                              marginTop: '12px',
                              padding: '8px 12px',
                              background: '#f3f4f6',
                              border: '1px solid #e5e7eb',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              width: '100%',
                              fontSize: '12px',
                              color: '#6b7280',
                              fontWeight: 500,
                            }}
                          >
                            Отмена
                          </button>
                        </div>
                      )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {contract.trailer ? (
                <div style={{ marginTop: '20px' }}>
                  <MarkdownContent content={contract.trailer} />
                </div>
              ) : null}
              </div>
            </div>

            {/* Облако тегов: чего не хватает в договоре — клик переключает выбор (оформлено как задание) */}
            <div
              data-tutor-highlight="stage2_extra_conditions"
              style={{
                marginTop: '20px',
                marginBottom: '8px',
                padding: '18px 20px',
                border: '2px solid #3b82f6',
                borderRadius: '10px',
                background: '#eff6ff',
                boxShadow: '0 2px 8px rgba(59, 130, 246, 0.15)',
              }}
            >
              <div
                style={{
                  display: 'inline-block',
                  marginBottom: '12px',
                  padding: '4px 10px',
                  background: '#3b82f6',
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.3px',
                  borderRadius: '6px',
                }}
              >
                дополнительные условия
              </div>
              <p style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
                Хочу добавить в договор
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 10px', alignItems: 'center' }}>
                {missingConditionsDisplayTags.map((label) => {
                  const selected = selectedMissingConditions.includes(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        missingConditionsUserTouchedRef.current = true;
                        setSelectedMissingConditions((prev) =>
                          prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]
                        );
                      }}
                      style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        color: selected ? '#fff' : '#475569',
                        background: selected ? '#2563eb' : '#f1f5f9',
                        border: `1px solid ${selected ? '#2563eb' : '#cbd5e1'}`,
                        borderRadius: '999px',
                        whiteSpace: 'nowrap',
                        cursor: 'pointer',
                        fontWeight: selected ? 600 : 400,
                      }}
                      title={selected ? 'Убрать из выбора' : 'Добавить в выбор'}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Кнопка «Готово!» внизу по центру — открывает окно сравнения матрицы и выбора пользователя */}
            {!validationDone && (
              <div
                data-tutor-highlight="stage2_done_row"
                style={{ marginTop: '24px', display: 'flex', justifyContent: 'center' }}
              >
                <button
                  type="button"
                  onClick={() => setShowTaskResultModal(true)}
                  disabled={validating}
                  style={{
                    padding: '10px 24px',
                    borderRadius: 8,
                    border: 'none',
                    background: validating ? '#9ca3af' : '#16a34a',
                    color: '#fff',
                    cursor: validating ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  {validating ? 'Проверка...' : 'Готово!'}
                </button>
              </div>
            )}

            {/* Отчёт после валидации (по флагу — скрыт с экрана этапа) */}
            {SHOW_STAGE2_ONSCREEN_VALIDATION_REPORT && reportToShow && (
              <div
                style={{
                  marginTop: '24px',
                  padding: '16px',
                  background: '#f0fdf4',
                  border: '1px solid #86efac',
                  borderRadius: '4px',
                }}
              >
                <h3 style={{ marginTop: 0, color: '#166534', fontSize: '16px' }}>Результаты проверки</h3>
                {reportToShow.summary && (
                  <div style={{ marginBottom: '12px', fontSize: '14px' }}>
                    <strong>Сводка:</strong> баллов {reportToShow.summary.total_score} из{' '}
                    {reportToShow.summary.max_score}; найдено рисков {reportToShow.summary.found_risks}{' '}
                    из {reportToShow.summary.total_risks}; ложных срабатываний{' '}
                    {reportToShow.summary.false_positives}; пропущено {reportToShow.summary.missed_risks}.
                    {reportToShow.summary.tag_score != null && reportToShow.summary.tag_score > 0 && (
                      <span style={{ marginLeft: '8px', color: '#059669' }}>
                        Бонус за теги: +{reportToShow.summary.tag_score} ({reportToShow.summary.tag_correct_count} верных).
                      </span>
                    )}
                    {reportToShow.summary.missing_conditions_score != null && (
                      <span style={{ marginLeft: '8px', color: reportToShow.summary.missing_conditions_score >= 0 ? '#059669' : '#dc2626' }}>
                        Доп. условия: {reportToShow.summary.missing_conditions_score >= 0 ? '+' : ''}{reportToShow.summary.missing_conditions_score} баллов
                        {reportToShow.summary.missing_conditions_correct_count != null && ` (${reportToShow.summary.missing_conditions_correct_count} верных)`}.
                      </span>
                    )}
                    {reportToShow.summary.justification_bonus != null && reportToShow.summary.justification_bonus > 0 && (
                      <span style={{ marginLeft: '8px', color: '#059669' }}>
                        Бонус за обоснование выбора: +{reportToShow.summary.justification_bonus} баллов.
                      </span>
                    )}
                  </div>
                )}
                {/* Правильный ответ по обоснованию — показываем только если пользователь верно определил типы риска (юридический, операционный, финансовый, репутационный) */}
                {session?.stage2_justification_show_correct === true && (session?.stage2_justification_correct_reasons?.length > 0) && (
                  <div style={{ marginBottom: '12px', padding: '12px', background: 'rgba(255,255,255,0.7)', borderRadius: '8px', border: '1px solid #bbf7d0' }}>
                    <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: '13px', color: '#166534' }}>
                      Обоснование выбора
                    </p>
                    <p style={{ margin: 0, fontSize: '12px', color: '#059669' }}>
                      <strong>Правильные причины:</strong>{' '}
                      {session.stage2_justification_correct_reasons.join('; ')}
                    </p>
                  </div>
                )}
                {/* В договоре не хватает условий: выбранные игроком и верные ответы — показываем всегда при наличии отчёта */}
                {(() => {
                  const selected = reportToShow.missing_conditions_selected ?? session?.stage2_missing_conditions_selected ?? selectedMissingConditions ?? [];
                  const correct = reportToShow.missing_conditions_correct ?? CORRECT_MISSING_CONDITIONS_REPORT;
                  const selectedList = Array.isArray(selected) ? selected : [];
                  const correctList = Array.isArray(correct) ? correct : CORRECT_MISSING_CONDITIONS_REPORT;
                  return (
                    <div style={{ marginBottom: '12px', padding: '12px', background: 'rgba(255,255,255,0.7)', borderRadius: '8px', border: '1px solid #bbf7d0' }}>
                      <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: '13px', color: '#166534' }}>
                        В договоре не хватает условий
                      </p>
                      <p style={{ margin: '0 0 4px', fontSize: '12px', color: '#475569' }}>
                        <strong>Выбранные вами:</strong>{' '}
                        {selectedList.length > 0 ? selectedList.join('; ') : '—'}
                      </p>
                      <p style={{ margin: 0, fontSize: '12px', color: '#059669' }}>
                        <strong>Верные ответы:</strong>{' '}
                        {correctList.join('; ')}
                      </p>
                    </div>
                  );
                })()}
                {/* По пунктам: уровень риска (красный/оранжевый/зелёный) — показываем всегда; типы риска (юридический и т.д.) — только при втором сценарии */}
                {reportToShow.clause_results?.filter((r) => r.user_selected).length > 0 && (() => {
                  const didTypeClassification = session?.stage2_clause_tags && Object.values(session.stage2_clause_tags).some((arr) => Array.isArray(arr) && arr.length > 0);
                  const selected = reportToShow.clause_results.filter((r) => r.user_selected);
                  return (
                    <ul style={{ margin: '12px 0 0 0', padding: 0, listStyle: 'none', fontSize: '13px' }}>
                      {selected.map((r) => {
                        const levelLabel = (id) => RISK_LEVELS.find((l) => l.id === id)?.label || id;
                        const levelOk = r.risk_level_correct === true;
                        const tagRes = r.tag_results || {};
                        const tagLabel = (res) => (res === 'ok' ? 'верно' : res === 'wrong' ? 'неверно' : res === 'missed' ? 'пропущен' : '—');
                        return (
                          <li
                            key={r.clause_id}
                            style={{
                              marginBottom: '10px',
                              padding: '10px 12px',
                              background: 'rgba(255,255,255,0.6)',
                              borderRadius: '6px',
                              borderLeft: `3px solid ${levelOk ? '#059669' : '#dc2626'}`,
                            }}
                          >
                            <div style={{ fontWeight: 600, color: '#1e293b', marginBottom: didTypeClassification ? '4px' : 0 }}>
                              Пункт {r.clause_id}: уровень риска —{' '}
                              {levelOk ? (
                                <span style={{ color: '#059669' }}>верно</span>
                              ) : (
                                <span style={{ color: '#dc2626' }}>
                                  неверно (указано «{levelLabel(r.user_risk_level)}», верно — «{levelLabel(r.correct_risk_level)}»)
                                </span>
                              )}
                            </div>
                            {didTypeClassification && (
                              <div style={{ color: '#475569', display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'baseline' }}>
                                <span style={{ fontWeight: 600, marginRight: '4px' }}>Типы риска:</span>
                                {RISK_TAGS.map((t) => {
                                  const res = tagRes[t.id];
                                  const correctForClause = (r.correct_tags && r.correct_tags.length > 0 ? r.correct_tags : CORRECT_TAGS_BY_CLAUSE[String(r.clause_id).trim()] || []).includes(t.id);
                                  let text = tagLabel(res);
                                  let color = res === 'ok' ? '#059669' : res === 'wrong' ? '#dc2626' : res === 'missed' ? '#d97706' : '#94a3b8';
                                  if (res == null && correctForClause) {
                                    text = 'верно (эталон)';
                                    color = '#059669';
                                  } else if (res == null) {
                                    text = '—';
                                    color = '#94a3b8';
                                  }
                                  return (
                                    <span key={t.id}>
                                      {t.label}: <span style={{ color, fontWeight: 600 }}>{text}</span>
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()}
                {reportToShow.errors?.length > 0 && (
                  <ul style={{ margin: '8px 0 0 20px', color: '#7f1d1d', fontSize: '14px' }}>
                    {reportToShow.errors.map((e, i) => (
                      <li key={i}>
                        Пункт {e.clause_id}: указано «{e.user_risk_level}», верно — «
                        {e.correct_risk_level}». {e.description}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            </div>

            {/* Кнопки навигации внизу (всегда кликабельны) */}
            <div style={{ display: 'flex', gap: '15px', justifyContent: 'flex-end', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e5e7eb', pointerEvents: 'auto' }}>
              <button
                type="button"
                onClick={() => {
                  if (stageCompleteInFlight) return;
                  onComplete?.();
                }}
                disabled={!canComplete || !!stageCompleteInFlight}
                aria-busy={!!stageCompleteInFlight}
                style={{
                  padding: '12px 24px',
                  background: stageCompleteInFlight
                    ? '#6ee7b7'
                    : !canComplete
                      ? '#d1d5db'
                      : '#10b981',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: stageCompleteInFlight ? 'wait' : !canComplete ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  fontSize: '14px',
                  opacity: !canComplete && !stageCompleteInFlight ? 0.6 : stageCompleteInFlight ? 0.92 : 1,
                  boxShadow: stageCompleteInFlight ? 'none' : undefined,
                }}
              >
                {stageCompleteInFlight ? 'Сохранение и переход…' : 'Завершить этап'}
              </button>
            </div>
          </div>
          </div>
        </div>
      )}

      {/* Модалка босса теперь в Симуграм (onBossPoll). Fallback-модалка для случая без onBossPoll не рендерится. */}

      {/* Модальное окно «А почему именно этот?» — выбор причины после «Вот этот!» */}
      {showWhyModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2100,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
          onClick={() => setShowWhyModal(false)}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 12,
              padding: 24,
              maxWidth: 560,
              width: '100%',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 20px 0', fontSize: 18, color: '#1e293b', fontWeight: 700 }}>
              А почему именно этот?
            </h3>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                marginBottom: 24,
                paddingRight: 4,
              }}
            >
              <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 12px 0' }}>
                Можно выбрать несколько причин.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {whyReasonsShuffled.map((reason, index) => {
                  const selected = selectedWhyReasons.includes(reason);
                  return (
                    <button
                      key={reason}
                      type="button"
                      onClick={() => {
                        setSelectedWhyReasons((prev) =>
                          prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]
                        );
                      }}
                      style={{
                        padding: '14px 16px',
                        borderRadius: 10,
                        border: `2px solid ${selected ? '#2563eb' : '#e2e8f0'}`,
                        background: selected ? '#dbeafe' : '#f8fafc',
                        color: selected ? '#1e40af' : '#334155',
                        fontWeight: selected ? 600 : 500,
                        fontSize: 14,
                        cursor: 'pointer',
                        textAlign: 'left',
                        wordBreak: 'break-word',
                        whiteSpace: 'normal',
                        lineHeight: 1.4,
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontWeight: 700, opacity: 0.8 }}>
                        {index + 1}.
                      </span>
                      <span>{reason}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              {selectedWhyReasons.length > 0 && (
                <span style={{ fontSize: 14, color: '#64748b' }}>
                  Выбрано: {selectedWhyReasons.length}
                </span>
              )}
              <button
                type="button"
                onClick={handleSubmitJustification}
                disabled={justifying}
                style={{
                  marginLeft: 'auto',
                  padding: '12px 32px',
                  fontSize: 16,
                  border: 'none',
                  borderRadius: 10,
                  cursor: justifying ? 'wait' : 'pointer',
                  fontWeight: 700,
                  background: '#16a34a',
                  color: '#fff',
                  opacity: justifying ? 0.8 : 1,
                }}
              >
                {justifying ? 'Проверка...' : 'Готово'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Пасхалка: серия из >5 пунктов подряд — крупный текст по центру; закрытие снимает дрожь договора */}
      {showApocalypseEggModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="stage2-apocalypse-egg-title"
          style={{
            position: 'fixed',
            inset: 0,
            // Выше SimulatorTourOverlay (12000) и StageEnterWelcomeOverlay (11050), иначе пасхалка «не видна»
            zIndex: 12100,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
          onClick={closeApocalypseEggModal}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 16,
              padding: '40px 36px',
              maxWidth: 520,
              width: '100%',
              textAlign: 'center',
              boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
              border: '1px solid #e2e8f0',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p
              id="stage2-apocalypse-egg-title"
              style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 800,
                color: '#b45309',
                lineHeight: 1.35,
                letterSpacing: '0.01em',
              }}
            >
              {CONTRACT_APOCALYPSE_EGG_COPY}
            </p>
            <p
              style={{
                margin: '20px 0 28px',
                fontSize: 18,
                fontWeight: 600,
                color: '#475569',
                lineHeight: 1.45,
              }}
            >
              {CONTRACT_APOCALYPSE_EGG_SUBCOPY}
            </p>
            <button
              type="button"
              onClick={closeApocalypseEggModal}
              style={{
                padding: '14px 36px',
                fontSize: 16,
                fontWeight: 700,
                border: 'none',
                borderRadius: 12,
                cursor: 'pointer',
                background: '#1e40af',
                color: '#fff',
              }}
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Все верные пункты в «дополнительных условиях» — без лишних */}
      {showMissingPerfectModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="stage2-missing-perfect-title"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 12110,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
          onClick={closeMissingPerfectModal}
        >
          <style>{`
            @keyframes stage2AiWiggle {
              0%, 100% { transform: rotate(0deg); }
              25% { transform: rotate(-2deg); }
              75% { transform: rotate(2deg); }
            }
          `}</style>
          <div
            style={{
              background: '#fff',
              borderRadius: 16,
              padding: '36px 32px 40px',
              maxWidth: 520,
              width: '100%',
              textAlign: 'center',
              boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
              border: '1px solid #e2e8f0',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ animation: 'stage2AiWiggle 2s ease-in-out infinite' }}>
              <SuspiciousAiCartoon />
            </div>
            <p
              id="stage2-missing-perfect-title"
              style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 800,
                color: '#b45309',
                lineHeight: 1.35,
                letterSpacing: '0.01em',
              }}
            >
              {MISSING_CONDITIONS_PERFECT_TITLE}
            </p>
            <p
              style={{
                margin: '18px 0 28px',
                fontSize: 18,
                fontWeight: 600,
                color: '#475569',
                lineHeight: 1.45,
              }}
            >
              {MISSING_CONDITIONS_PERFECT_SUB}
            </p>
            <button
              type="button"
              onClick={closeMissingPerfectModal}
              style={{
                padding: '14px 36px',
                fontSize: 16,
                fontWeight: 700,
                border: 'none',
                borderRadius: 12,
                cursor: 'pointer',
                background: '#1e40af',
                color: '#fff',
              }}
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Модальное окно после нажатия «Готово!»: эталонная матрица + выбор пользователя */}
      {showTaskResultModal && (() => {
        const COLORS = { high: '#f87171', medium: '#fdba74', low: '#86efac' };
        const LEVEL_ORDER = { high: 0, medium: 1, low: 2 };
        const initialList = Object.entries(riskMatrix)
          .filter(([, level]) => level)
          .map(([clause_id, level]) => ({ clause_id, level }));
        initialList.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || String(a.clause_id).localeCompare(String(b.clause_id)));
        const refCells = initialList.map((item) => {
          const key = String(item.clause_id).trim();
          return {
            clause_id: item.clause_id,
            color: COLORS[item.level],
            label: SHORT_CLAUSE_LABELS[key] ?? `Пункт ${key}`,
          };
        });
        const userRisksNorm = {};
        for (const [k, v] of Object.entries(clauseRisks || {})) {
          const id = String(k ?? '').trim();
          if (id && (v === 'high' || v === 'medium' || v === 'low')) userRisksNorm[id] = v;
        }
        const userHigh = Object.keys(userRisksNorm)
          .filter((cid) => userRisksNorm[cid] === 'high')
          .sort((a, b) => String(a).localeCompare(String(b)));
        const userMedium = Object.keys(userRisksNorm)
          .filter((cid) => userRisksNorm[cid] === 'medium')
          .sort((a, b) => String(a).localeCompare(String(b)));
        const userLow = Object.keys(userRisksNorm)
          .filter((cid) => userRisksNorm[cid] === 'low')
          .sort((a, b) => String(a).localeCompare(String(b)));
        const modalCellSize = 80;
        const modalCols = 5;
        const modalRows = Math.max(3, Math.ceil(refCells.length / modalCols));
        const modalGap = 10;
        const modalPadding = 14;
        const modalGridWidth = modalCols * modalCellSize + (modalCols - 1) * modalGap + 2 * modalPadding;
        const modalGridHeight = modalRows * modalCellSize + (modalRows - 1) * modalGap + 2 * modalPadding;
        const clauseById = (id) => contract.clauses?.find((c) => c.id === id);

        return (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 2000,
              background: 'rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}
          >
            <div
              style={{
                background: '#fff',
                borderRadius: 12,
                padding: 24,
                maxWidth: 1000,
                width: '100%',
                maxHeight: '90vh',
                overflow: 'auto',
                boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: 20, color: '#1e40af' }}>
                Здесь ты можешь еще раз проверить, насколько твой выбор соответствует эталонной матрице
              </h3>
              <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', gap: 32, alignItems: 'flex-start' }}>
                {/* Слева: эталонная матрица рисков */}
                <div style={{ flexShrink: 0 }}>
                  <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, fontWeight: 600 }}>Эталонная матрица</p>
                  <div
                    style={{
                      width: modalGridWidth,
                      height: modalGridHeight,
                      border: '1px solid #e2e8f0',
                      borderRadius: 14,
                      overflow: 'hidden',
                      background: '#f1f5f9',
                      padding: modalPadding,
                      boxSizing: 'border-box',
                      display: 'grid',
                      gridTemplateColumns: `repeat(${modalCols}, ${modalCellSize}px)`,
                      gridTemplateRows: `repeat(${modalRows}, ${modalCellSize}px)`,
                      gap: modalGap,
                      boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.04)',
                    }}
                  >
                    {refCells.map((cell) => (
                      <div
                        key={cell.clause_id}
                        style={{
                          background: cell.color,
                          borderRadius: 10,
                          border: '1px solid rgba(0,0,0,0.08)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '5px 4px',
                          boxSizing: 'border-box',
                          width: modalCellSize,
                          height: modalCellSize,
                          boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                        }}
                      >
                        <span style={{ fontSize: 9, fontWeight: 600, color: '#1e293b', textAlign: 'center', lineHeight: 1.2, wordBreak: 'break-word' }}>
                          {ensureMatrixLabel(cell.label, cell.clause_id)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Справа: выбор игрока по уровню риска */}
                <div style={{ flexShrink: 0 }}>
                  <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, fontWeight: 600 }}>Ваш выбор по уровню риска</p>
                  <div
                    style={{
                      width: modalGridWidth,
                      minHeight: modalGridHeight,
                      border: '2px solid #e5e7eb',
                      borderRadius: 12,
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    <div style={{ flex: 1, background: '#f87171', padding: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignContent: 'flex-start', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', width: '100%', marginBottom: 4 }}>Высокий</span>
                      {userHigh.map((cid) => (
                        <button
                          key={cid}
                          type="button"
                          onClick={() => setModalClauseTextId(modalClauseTextId === cid ? null : cid)}
                          style={{
                            padding: '6px 12px',
                            borderRadius: 8,
                            border: '2px solid rgba(255,255,255,0.8)',
                            background: 'rgba(255,255,255,0.2)',
                            color: '#fff',
                            fontWeight: 700,
                            cursor: 'pointer',
                            fontSize: 13,
                          }}
                        >
                          {cid}
                        </button>
                      ))}
                    </div>
                    <div style={{ flex: 1, background: '#fdba74', padding: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignContent: 'flex-start', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', width: '100%', marginBottom: 4 }}>Средний</span>
                      {userMedium.map((cid) => (
                        <button
                          key={cid}
                          type="button"
                          onClick={() => setModalClauseTextId(modalClauseTextId === cid ? null : cid)}
                          style={{
                            padding: '6px 12px',
                            borderRadius: 8,
                            border: '2px solid rgba(255,255,255,0.8)',
                            background: 'rgba(255,255,255,0.2)',
                            color: '#fff',
                            fontWeight: 700,
                            cursor: 'pointer',
                            fontSize: 13,
                          }}
                        >
                          {cid}
                        </button>
                      ))}
                    </div>
                    <div style={{ flex: 1, background: '#86efac', padding: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignContent: 'flex-start', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#1f2937', width: '100%', marginBottom: 4 }}>Низкий</span>
                      {userLow.map((cid) => (
                        <button
                          key={cid}
                          type="button"
                          onClick={() => setModalClauseTextId(modalClauseTextId === cid ? null : cid)}
                          style={{
                            padding: '6px 12px',
                            borderRadius: 8,
                            border: '2px solid rgba(0,0,0,0.15)',
                            background: 'rgba(255,255,255,0.5)',
                            color: '#166534',
                            fontWeight: 700,
                            cursor: 'pointer',
                            fontSize: 13,
                          }}
                        >
                          {cid}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Текст выбранного пункта при клике на номер */}
              {modalClauseTextId && (
                <div style={{ marginTop: 16, padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                  <p style={{ margin: '0 0 8px 0', fontSize: 12, color: '#64748b', fontWeight: 600 }}>Пункт {modalClauseTextId}</p>
                  <div style={{ fontSize: 14, color: '#334155', lineHeight: 1.6 }}>
                    <MarkdownContent content={clauseById(modalClauseTextId)?.text || ''} />
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 24 }}>
                <button
                  type="button"
                  onClick={() => {
                    setShowTaskResultModal(false);
                    setModalClauseTextId(null);
                  }}
                  disabled={validating || !!stageCompleteInFlight}
                  style={{
                    padding: '10px 24px',
                    background: '#fff',
                    color: '#475569',
                    border: '1px solid #cbd5e1',
                    borderRadius: 8,
                    cursor:
                      validating || !!stageCompleteInFlight
                        ? 'not-allowed'
                        : 'pointer',
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  Вернуться к редактированию
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowTaskResultModal(false);
                    setModalClauseTextId(null);
                    if (hasSelectedRiskTypes) {
                      handleValidate();
                      return;
                    }
                    handleValidate({
                      onValidated: (nextSession) => {
                        onSessionUpdate?.(nextSession);
                        onComplete?.(nextSession);
                      },
                    });
                  }}
                  disabled={validating || (!hasSelectedRiskTypes && !!stageCompleteInFlight)}
                  style={{
                    padding: '10px 24px',
                    background: validating ? '#9ca3af' : '#16a34a',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor:
                      validating || (!hasSelectedRiskTypes && !!stageCompleteInFlight)
                        ? 'not-allowed'
                        : 'pointer',
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  {!hasSelectedRiskTypes
                    ? (stageCompleteInFlight ? 'Сохранение и переход…' : (validating ? 'Проверка...' : 'Завершить этап'))
                    : (validating ? 'Проверка...' : 'Отправить на проверку')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Документы — тот же UI, что на этапе 1 (сайдбар + контент) */}
      {showBriefModal && (
        <DocumentsModal
          isOpen
          onClose={closeDocsModal}
          docs={documentsModalDocs}
          loading={documentsModalLoading}
          error={documentsModalError}
          tutorHighlightShellId="stage2_docs_modal"
        />
      )}
      {riskTagTooltip && (
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            left: riskTagTooltip.x,
            top: riskTagTooltip.y,
            transform: 'translate(-50%, -100%)',
            maxWidth: 360,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(15, 23, 42, 0.96)',
            color: '#fff',
            fontSize: 12,
            lineHeight: 1.35,
            boxShadow: '0 10px 28px rgba(2, 6, 23, 0.35)',
            zIndex: 13000,
            pointerEvents: 'none',
            whiteSpace: 'normal',
          }}
        >
          {riskTagTooltip.text}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '100%',
              transform: 'translateX(-50%)',
              width: 0,
              height: 0,
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: '6px solid rgba(15, 23, 42, 0.96)',
            }}
          />
        </div>
      )}

      </div>
    </div>
  );
}
