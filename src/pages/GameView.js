import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import CaseSelectionScreen from '../components/CaseSelectionScreen';
import { getStageComponent } from '../stages/StageRegistry';
import GameContextNavBar from '../components/GameContextNavBar';
import GameplayHud, { getGameplayHudClearanceTopPx } from '../components/GameplayHud';
import FinishCaseConfirm from '../components/FinishCaseConfirm';
import ReportView from '../components/ReportView';
import { API_URL, getAuthHeaders } from '../api/config';
import { handleApiError, safeFetch, safeFetchPostOn404Fallback } from '../api/errorHandler';
import { tutorAPI } from '../api/tutorApi';
import DocumentsModal from '../components/DocumentsModal';
import { SimugramProvider, CONTACT_IDS, useSimugram } from '../context/SimugramContext';
import SimugramPanel from '../components/simugram/SimugramPanel';
import SimulatorWelcomeOverlay from '../components/SimulatorWelcomeOverlay';
import SimulatorTourOverlay from '../components/SimulatorTourOverlay';
import StageEnterWelcomeOverlay from '../components/StageEnterWelcomeOverlay';
import { STAGE1_SIMUGRAM_COLUMN_BOTTOM_PAD_PX } from '../components/Stage1View';
import ReportLoadingOverlay from '../components/ReportLoadingOverlay';
import {
  activeGameSessionLocalKey,
  skipCaseSimulatorTourLocalKey,
  filterResolvableTourSteps,
  getStageTourSteps,
  buildIntroComicPanelsFromStages,
  getSimulatorIntroConfig,
  shouldShowSimulatorIntro,
} from '../config/simulatorTourSteps';
import { getStageEnterWelcomePayload } from '../config/stageWelcomeMessages';
import { userCanRestartSimulatorStage } from '../config/qaTracker';
import { applyDeadlinePlaceholders } from '../utils/casePlaceholders';
import { clearTutorChatLocal } from '../utils/tutorChatStorage';
import { clearStageDraft, clearAllStageDraftsForSession } from '../utils/stageDraftStorage';
import { clearWelcomeOverlaySlideStorage } from '../utils/simulatorWelcomeStorage';
import { canonicalCaseCode } from '../utils/caseId';
import { devLog } from '../utils/devLog';
import { PLATFORM_SHELL } from '../config/platformShell';

/** Макс. возраст снимка сессии в localStorage (мс). Раньше 30 мин — после F5 длинная пауза обнуляла прогресс. */
const SESSION_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** HUD внутри SimugramProvider: бейдж «почта» = сумма непрочитанных по контактам (в т.ч. когда панель Simugram открыта, но открыт другой чат). */
function GameplayHudWithSimugramUnread(hudProps) {
  const { totalUnread } = useSimugram();
  return <GameplayHud {...hudProps} simugramUnreadCount={totalUnread} />;
}

const SIMUGRAM_SNAPSHOT_CONTACT_IDS = new Set(Object.values(CONTACT_IDS));

/**
 * Синхронизация activeContact в ref для снимка localStorage + восстановление контакта после F5
 * (useLayoutEffect, чтобы родительский эффект сохранения не успел записать null до setActiveContact).
 */
function SimugramSessionSnapshotBridge({ activeContactSnapshotRef, contactIdRestoreRef, sessionId, onActiveContactChange }) {
  const { activeContact, setActiveContact } = useSimugram();

  useLayoutEffect(() => {
    if (!sessionId) return;
    const raw = contactIdRestoreRef.current;
    if (raw == null || raw === '') {
      contactIdRestoreRef.current = null;
      return;
    }
    if (typeof raw !== 'string' || !SIMUGRAM_SNAPSHOT_CONTACT_IDS.has(raw)) {
      contactIdRestoreRef.current = null;
      return;
    }
    contactIdRestoreRef.current = null;
    setActiveContact(raw);
  }, [sessionId, setActiveContact, contactIdRestoreRef]);

  useEffect(() => {
    activeContactSnapshotRef.current = { activeContact };
    onActiveContactChange?.();
  }, [activeContact, activeContactSnapshotRef, onActiveContactChange]);

  return null;
}

function getStagesFromCasePayload(casePayload) {
  if (!casePayload) return [];
  return casePayload.stages || casePayload.case?.stages || [];
}

/** Письма stage_enter этапа в формате state `emails`. `baseDate` — момент закрепления дедлайнов для этого этапа. */
function buildStageEnterDisplayEmails(stage, stageNumber, baseDate) {
  if (!stage?.emails?.length || !baseDate) return [];
  const t = baseDate.getTime();
  return stage.emails
    .filter((e) => e.trigger === 'stage_enter')
    .map((e) => {
      const body = applyDeadlinePlaceholders(e.body || '', baseDate);
      return {
        id: e.id,
        from: e.from || 'Система',
        subject: applyDeadlinePlaceholders(e.subject || '', baseDate),
        body,
        read: false,
        timestamp: t,
        stage: stageNumber,
      };
    });
}

/**
 * Актуализирует текст/from/subject из конфига для совпадающих id,
 * сохраняя read и timestamp у уже показанных писем.
 */
function mergeStageEnterIntoEmails(prev, freshStageEnterList) {
  if (!freshStageEnterList.length) return prev;
  const freshById = new Map(freshStageEnterList.map((e) => [e.id, e]));
  const prevIds = new Set(prev.map((e) => e.id));
  const updated = prev.map((e) => {
    const fresh = freshById.get(e.id);
    if (!fresh) return e;
    return { ...fresh, body: e.body, read: e.read, timestamp: e.timestamp };
  });
  const toAdd = freshStageEnterList.filter((e) => !prevIds.has(e.id));
  return [...updated, ...toAdd];
}

/** Закрепить момент времени для `{{deadline+N}}` на этапе (один раз на пару sessionId + номер этапа 1-based). */
function pinDeadlinePlaceholderBaseDate(pinMapRef, sessionId, stageNumber1Based, onFirstPin) {
  if (sessionId == null || String(sessionId).trim() === '') return new Date();
  const key = `${sessionId}:${stageNumber1Based}`;
  const m = pinMapRef.current;
  let created = false;
  if (m[key] == null) {
    m[key] = Date.now();
    created = true;
  }
  if (created && typeof onFirstPin === 'function') onFirstPin();
  return new Date(m[key]);
}

/** Секунды лимита таймера этапа для HUD: time_budget этапа или resources.time_budget; для этапа 2 с game_config бэкенд подставляет time_budget в ответ GET /api/case. */
function getStageWallClockSeconds(stage) {
  if (!stage) return null;
  const top = stage.time_budget;
  if (top != null && Number(top) > 0) return Number(top);
  const res = stage.resources?.time_budget;
  if (res != null && Number(res) > 0) return Number(res);
  return null;
}

export default function GameView({
  /** id пользователя из БД — обязателен для изоляции localStorage между аккаунтами */
  currentUserId,
  /** Объект пользователя для отчёта (вкладка моста 3→4 и т.п.) */
  viewerUser,
  onLogout,
  appMenu,
  /** Только админ/суперюзер: пути к конфигу, LEXIC, лишнее в карточках */
  showCaseTechnicalMetadata = false,
}) {
  const sessionStorageKey = useMemo(() => {
    if (currentUserId == null || Number.isNaN(Number(currentUserId))) return null;
    try {
      return activeGameSessionLocalKey(Number(currentUserId));
    } catch {
      return null;
    }
  }, [currentUserId]);

  const [gameState, setGameState] = useState('case-selection'); // Начинаем с выбора кейса
  const [caseData, setCaseData] = useState(null);
  const [session, setSession] = useState(null);
  const [currentStage, setCurrentStage] = useState(0);
  const [report, setReport] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const [stageStartTime, setStageStartTime] = useState(null);
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [emails, setEmails] = useState([]);
  const [simugramOpen, setSimugramOpen] = useState(false);
  /** Тур интерфейса: off | welcome | steps */
  const [tourPhase, setTourPhase] = useState('off');
  const [tourSteps, setTourSteps] = useState([]);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const tourPrevStageRef = useRef(null);
  /** После приветствия: сначала HUD, затем цепочка шагов текущего этапа */
  const chainedHudToStageTourRef = useRef(false);
  /** Снимок: было ли окно «Документы» этапа 2 открыто до шага тура s2-docs */
  const stage2DocsTourSnapshotRef = useRef(null);
  const stage2DocsTourFetchStartedRef = useRef(false);
  const [newEmailModal, setNewEmailModal] = useState(null); // Письмо для модального окна
  const [unreadEmailsQueue, setUnreadEmailsQueue] = useState([]); // Очередь непрочитанных писем
  const previousEmailsRef = useRef([]); // Для отслеживания новых писем
  /** Индексы этапов (0…), для которых пользователь уже закрыл плашку входа — чтобы после F5 не повторять */
  const [dismissedStageBanners, setDismissedStageBanners] = useState([]);
  const [stageCompleteInFlight, setStageCompleteInFlight] = useState(false);
  const stageCompleteInFlightRef = useRef(false);
  /** Сброс внутреннего UI этапа и таймера после POST /stage/restart */
  const [stageRemountKey, setStageRemountKey] = useState(0);
  const restartStageInFlightRef = useRef(false);
  const [restartStageLoading, setRestartStageLoading] = useState(false);
  const simugramRef = useRef(null);
  const simugramActiveContactRestoreRef = useRef(null);
  const simugramUiSnapshotRef = useRef({ activeContact: null });
  const [simugramSnapshotTick, setSimugramSnapshotTick] = useState(0);
  const bumpSimugramSnapshotTick = useCallback(() => {
    setSimugramSnapshotTick((n) => n + 1);
  }, []);

  /** Метки времени для `{{deadline+N}}` по ключу `sessionId:номерЭтапа1based` — не пересчитывать от «сейчас» при refetch. */
  const deadlinePlaceholderPinMsRef = useRef({});
  const [deadlinePinSaveTick, setDeadlinePinSaveTick] = useState(0);
  const prevSessionIdForDeadlinePinsRef = useRef(null);
  useLayoutEffect(() => {
    const sid = session?.id;
    if (sid == null || String(sid).trim() === '') {
      prevSessionIdForDeadlinePinsRef.current = null;
      deadlinePlaceholderPinMsRef.current = {};
      return;
    }
    const prev = prevSessionIdForDeadlinePinsRef.current;
    if (prev != null && prev !== sid) {
      deadlinePlaceholderPinMsRef.current = {};
    }
    prevSessionIdForDeadlinePinsRef.current = sid;
  }, [session?.id]);

  const getDeadlinePlaceholderBaseDate = useCallback(
    (stageNumber1Based) =>
      pinDeadlinePlaceholderBaseDate(
        deadlinePlaceholderPinMsRef,
        session?.id,
        stageNumber1Based,
        () => setDeadlinePinSaveTick((n) => n + 1)
      ),
    [session?.id]
  );

  const forgetDeadlinePlaceholderBaseForStage = useCallback(
    (stageNumber1Based) => {
      if (session?.id == null || String(session.id).trim() === '') return;
      delete deadlinePlaceholderPinMsRef.current[`${session.id}:${stageNumber1Based}`];
      setDeadlinePinSaveTick((n) => n + 1);
    },
    [session?.id]
  );

  /** Ключ «сессия:этап:remount» — сброс HUD-таймера только при смене этапа/рестарте, не при refetch кейса */
  const timerInitKeyRef = useRef(null);
  /** Абсолютный дедлайн HUD-таймера (ms) — пересчёт по Date.now() при тике и при возврате на вкладку (фон режет setInterval). */
  const wallClockDeadlineMsRef = useRef(null);
  const [stage1ChatState, setStage1ChatState] = useState(null);
  const [stage3ChatState, setStage3ChatState] = useState(null);
  /** Этап 2: «Документы» — тот же DocumentsModal; список из GET /case/docs (= содержимое reference_docs), динамический бриф — как на этапах 1/3/4. */
  const [stage2BriefModalOpen, setStage2BriefModalOpen] = useState(false);
  const [stage2CaseDocs, setStage2CaseDocs] = useState(null); // { case_id, docs }
  const [stage2CaseDocsLoading, setStage2CaseDocsLoading] = useState(false);
  const [stage2CaseDocsError, setStage2CaseDocsError] = useState(null);
  const [showDocsModal, setShowDocsModal] = useState(false);
  const [caseDocs, setCaseDocs] = useState(null);
  const [caseDocsLoading, setCaseDocsLoading] = useState(false);
  const [caseDocsError, setCaseDocsError] = useState(null);
  /** Этап 4: markdown финального договора для вкладки в модалке «Документы» */
  const [stage4FinalContractMarkdown, setStage4FinalContractMarkdown] = useState(null);
  /** Этап 4: увеличивается при каждом закрытии модалки «новое письмо» (Закрыть) на этапе 4 — Stage4View переходит phaseIntro → phaseCutscene */
  const [stage4EmailModalCloseNonce, setStage4EmailModalCloseNonce] = useState(0);
  /** Этап 4, фаза договора: секунды для таймера в GameplayHud (как этапный таймер на этапе 2) */
  const [stage4ContractHudSeconds, setStage4ContractHudSeconds] = useState(null);
  const prevPlayStageIdxForS4Ref = useRef(null);
  const [showFinishCaseConfirm, setShowFinishCaseConfirm] = useState(false);
  /** В режиме симуляции верхняя панель скрыта, открывается кнопкой «…» в HUD */
  const [playNavExpanded, setPlayNavExpanded] = useState(false);
  /** Высота развёрнутого <header> — чтобы HUD был сразу под шапкой, без лишнего зазора */
  const playNavHeaderRef = useRef(null);
  const [playNavHeaderBottomPx, setPlayNavHeaderBottomPx] = useState(0);
  /** Краткое приветствие при входе на этап (после снятия глобального тура / при смене этапа) */
  const [stageEnterWelcome, setStageEnterWelcome] = useState(null);
  const sessionIdForStageWelcomeRef = useRef(null);
  const prevStageForWelcomeRef = useRef(null);
  /** Блокирует автозапуск тура этапа, пока открыта плашка входа на этап */
  const stageWelcomeBlocksAutoTourRef = useRef(false);
  /** После HUD: плашка этапа 1, затем по onComplete — тур экрана этапа */
  const pendingStageTourAfterBannerFromHudRef = useRef(false);
  /** Письма этапа (модалка) только после welcome + пошагового тура и карточки «этап N» */
  const emailModalBlockedByOnboardingRef = useRef(false);

  const appRoleSuffix =
    appMenu?.role === 'superuser'
      ? ' (суперюзер)'
      : appMenu?.role === 'admin'
        ? ' (админ)'
        : '';

  /** Кнопка «Сброс этапа» — ЛабЛигалТех / superuser / admin (`user_can_restart_simulator_stage` на бэкенде). */
  const canRestartSimulatorStage = userCanRestartSimulatorStage(viewerUser);

  useEffect(() => {
    const idx =
      session?.current_stage != null ? session.current_stage - 1 : currentStage;
    if (typeof idx !== 'number') return;
    if (idx === 3 && prevPlayStageIdxForS4Ref.current !== 3) {
      setStage4EmailModalCloseNonce(0);
      setStage4ContractHudSeconds(null);
    }
    if (idx !== 3) {
      setStage4ContractHudSeconds(null);
    }
    prevPlayStageIdxForS4Ref.current = idx;
  }, [session?.current_stage, currentStage]);

  const readSkipCaseTour = useCallback(() => {
    if (currentUserId == null || Number.isNaN(Number(currentUserId))) return false;
    try {
      const k = skipCaseSimulatorTourLocalKey(Number(currentUserId));
      return typeof localStorage !== 'undefined' && localStorage.getItem(k) === '1';
    } catch {
      return false;
    }
  }, [currentUserId]);

  const handleStage4FinalContractForDocuments = useCallback((markdown) => {
    setStage4FinalContractMarkdown(markdown);
  }, []);

  const setSkipCaseTourFlag = useCallback(
    (value) => {
      if (currentUserId == null || Number.isNaN(Number(currentUserId))) return;
      try {
        const k = skipCaseSimulatorTourLocalKey(Number(currentUserId));
        if (value) localStorage.setItem(k, '1');
        else localStorage.removeItem(k);
      } catch (_) {}
    },
    [currentUserId]
  );

  const finishPlayingTour = useCallback(() => {
    chainedHudToStageTourRef.current = false;
    setTourPhase('off');
    setTourSteps([]);
    setTourStepIndex(0);
    tourPrevStageRef.current = currentStage;
  }, [currentStage]);

  useLayoutEffect(() => {
    if (!playNavExpanded) {
      setPlayNavHeaderBottomPx(0);
      return undefined;
    }
    const el = playNavHeaderRef.current;
    if (!el) {
      setPlayNavHeaderBottomPx(72);
      return undefined;
    }
    const measure = () => {
      setPlayNavHeaderBottomPx(Math.ceil(el.getBoundingClientRect().height));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [playNavExpanded, gameState, currentStage, caseData, session?.current_stage]);

  /**
   * После трёхчастного приветствия — без тура по HUD.
   * Плашку «Этап N» ставим в том же синхронном шаге, что и tourPhase off, иначе один кадр
   * виден интерфейс этапа до useEffect — заметное моргание.
   */
  const finishIntroAndEnterPlaying = useCallback(() => {
    clearWelcomeOverlaySlideStorage(session?.id, session?.case_id);
    const actualCaseData = caseData?.case || caseData;
    const stages = actualCaseData?.stages || [];
    const st = stages[currentStage];
    if (st && stages.length > 1) {
      stageWelcomeBlocksAutoTourRef.current = true;
      emailModalBlockedByOnboardingRef.current = true;
      prevStageForWelcomeRef.current = currentStage;
      setStageEnterWelcome(getStageEnterWelcomePayload(st, currentStage + 1));
    }
    finishPlayingTour();
  }, [caseData, currentStage, finishPlayingTour, session?.id, session?.case_id]);

  /** Кнопка «…»: только обучение экрана текущего этапа (без приветствия и HUD). */
  const startSimulatorTour = useCallback(() => {
    if (gameState !== 'playing' || !session || !caseData) return;
    chainedHudToStageTourRef.current = false;
    const actualCaseData = caseData?.case || caseData;
    const st = actualCaseData?.stages?.[currentStage];
    const stageSteps = filterResolvableTourSteps(getStageTourSteps(st?.id, st?.type));
    if (stageSteps.length === 0) return;
    setTourSteps(stageSteps);
    setTourStepIndex(0);
    setTourPhase('steps');
  }, [gameState, session, caseData, currentStage]);

  const activeSimulatorTourStepId =
    gameState === 'playing' && tourPhase === 'steps' && tourSteps.length > 0
      ? tourSteps[tourStepIndex]?.id ?? null
      : null;

  const simulatorIntroConfig = useMemo(() => getSimulatorIntroConfig(caseData), [caseData]);
  const introComicPanels = useMemo(
    () => buildIntroComicPanelsFromStages(getStagesFromCasePayload(caseData), simulatorIntroConfig),
    [caseData, simulatorIntroConfig]
  );

  const startLocalStageTourAfterBanner = useCallback(() => {
    const actualCaseData = caseData?.case || caseData;
    const st = actualCaseData?.stages?.[currentStage];
    if (!st) return;
    const stageSteps = filterResolvableTourSteps(getStageTourSteps(st.id, st.type));
    if (stageSteps.length === 0) return;
    requestAnimationFrame(() => {
      setTourSteps(stageSteps);
      setTourStepIndex(0);
      setTourPhase('steps');
    });
  }, [caseData, currentStage]);

  const tryChainStageTourAfterHud = useCallback(() => {
    if (!chainedHudToStageTourRef.current) return false;
    const actualCaseData = caseData?.case || caseData;
    const st = actualCaseData?.stages?.[currentStage];
    const stageSteps = filterResolvableTourSteps(getStageTourSteps(st?.id, st?.type));
    if (stageSteps.length === 0) {
      chainedHudToStageTourRef.current = false;
      return false;
    }
    if (currentStage === 0) {
      chainedHudToStageTourRef.current = false;
      const singleStage = (actualCaseData?.stages || []).length === 1;
      if (singleStage) {
        finishPlayingTour();
        requestAnimationFrame(() => startLocalStageTourAfterBanner());
        return true;
      }
      pendingStageTourAfterBannerFromHudRef.current = true;
      prevStageForWelcomeRef.current = 0;
      stageWelcomeBlocksAutoTourRef.current = true;
      emailModalBlockedByOnboardingRef.current = true;
      setStageEnterWelcome(getStageEnterWelcomePayload(st, currentStage + 1));
      finishPlayingTour();
      return true;
    }
    chainedHudToStageTourRef.current = false;
    // Оставляем шаги HUD в списке: с первого шага этапа можно вернуться «Назад» к подсказкам панели.
    setTourSteps((prev) => [...prev, ...stageSteps]);
    setTourStepIndex((i) => i + 1);
    return true;
  }, [caseData, currentStage, finishPlayingTour, startLocalStageTourAfterBanner]);

  const handleStageEnterBannerComplete = useCallback(() => {
    stageWelcomeBlocksAutoTourRef.current = false;
    setStageEnterWelcome(null);
    setDismissedStageBanners((prev) =>
      prev.includes(currentStage) ? prev : [...prev, currentStage]
    );
    pendingStageTourAfterBannerFromHudRef.current = false;
  }, [currentStage]);

  const handleSimulatorTourNext = useCallback(() => {
    if (tourStepIndex >= tourSteps.length - 1) {
      if (tryChainStageTourAfterHud()) return;
      finishPlayingTour();
    } else {
      setTourStepIndex((i) => i + 1);
    }
  }, [tourStepIndex, tourSteps.length, tryChainStageTourAfterHud, finishPlayingTour]);

  const handleSimulatorTourSkip = useCallback(() => {
    if (tryChainStageTourAfterHud()) return;
    finishPlayingTour();
  }, [tryChainStageTourAfterHud, finishPlayingTour]);

  // Восстановление состояния сессии после перезагрузки страницы (только свой ключ и ownerUserId)
  useEffect(() => {
    if (!sessionStorageKey || currentUserId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = window.localStorage.getItem(sessionStorageKey);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved || !saved.session || !saved.caseData) return;
        const snapshotSavedAt = Number(saved.savedAt || 0);
        if (
          !Number.isFinite(snapshotSavedAt) ||
          snapshotSavedAt <= 0 ||
          Date.now() - snapshotSavedAt > SESSION_SNAPSHOT_MAX_AGE_MS
        ) {
          window.localStorage.removeItem(sessionStorageKey);
          return;
        }

        const ownerId = saved.ownerUserId;
        if (ownerId == null || Number(ownerId) !== Number(currentUserId)) {
          console.warn('⚠️ Снимок сессии симуляции в localStorage не совпадает с текущим пользователем — очищаем');
          window.localStorage.removeItem(sessionStorageKey);
          return;
        }

        let mergedSession = saved.session;
        try {
          const token =
            typeof localStorage !== 'undefined' && localStorage.getItem('simulex_auth_token');
          if (token) {
            const resSync = await fetch(
              `${API_URL}/session/${encodeURIComponent(String(saved.session.id))}`,
              { credentials: 'include', headers: getAuthHeaders() }
            );
            if (!cancelled && resSync.ok) {
              const serverPayload = await resSync.json();
              const localMs = snapshotSavedAt;
              const srvIso = serverPayload.server_sync_at;
              const srvMs = srvIso ? Date.parse(srvIso) : 0;
              const caseMatch =
                canonicalCaseCode(serverPayload.case_id || '') ===
                canonicalCaseCode(saved.session.case_id || '');
              if (srvMs && caseMatch && srvMs >= localMs - 120000) {
                mergedSession = {
                  ...saved.session,
                  current_stage:
                    serverPayload.current_stage ?? saved.session.current_stage,
                  lexic: serverPayload.lexic ?? saved.session.lexic,
                  resources: serverPayload.resources ?? saved.session.resources,
                  actions_done: serverPayload.actions_done ?? saved.session.actions_done,
                  stage_scores: serverPayload.stage_scores ?? saved.session.stage_scores,
                };
              } else if (serverPayload.case_id && saved.session.case_id && !caseMatch) {
                console.warn(
                  'Восстановление: серверный снимок сессии относится к другому кейсу — используется localStorage'
                );
              }
            }
          }
        } catch (_) {
          /* сеть / офлайн — остаёмся на localStorage */
        }

        const actualCaseData = saved.caseData?.case || saved.caseData;
        const totalStages = actualCaseData?.stages?.length || 0;
        const sessionCurrentStage = mergedSession?.current_stage || 0;
        const restoreReportScreen =
          saved.gameState === 'report' &&
          saved.report &&
          typeof saved.report === 'object';

        // Завершённая сессия без экрана отчёта в снимке — не восстанавливаем (избегаем странного состояния после complete).
        // Если в снимке уже открыт отчёт с телом — оставляем для F5 на странице отчёта.
        if (
          sessionCurrentStage > totalStages &&
          totalStages > 0 &&
          !restoreReportScreen
        ) {
          devLog('⚠️ Обнаружена завершенная сессия в localStorage (не экран отчёта), очищаем');
          window.localStorage.removeItem(sessionStorageKey);
          return;
        }

        devLog('♻️ Восстановление сессии из localStorage:', mergedSession?.id, mergedSession?.case_id);

        if (saved.deadlinePlaceholderPins && typeof saved.deadlinePlaceholderPins === 'object') {
          deadlinePlaceholderPinMsRef.current = { ...saved.deadlinePlaceholderPins };
        }

        const stageIndex =
          typeof saved.currentStage === 'number'
            ? saved.currentStage
            : mergedSession.current_stage
              ? mergedSession.current_stage - 1
              : 0;

        const dismissedRaw = saved.dismissedStageBanners;
        const dismissed = Array.isArray(dismissedRaw)
          ? dismissedRaw.map((n) => Number(n)).filter((n) => !Number.isNaN(n))
          : // Старые снимки: не повторяем плашки уже пройденных этапов
            Array.from({ length: Math.max(0, stageIndex) }, (_, i) => i);
        // До setState: иначе эффект плашки этапа обнулит prev и снова покажет приветствие / подтянет «новые» письма
        sessionIdForStageWelcomeRef.current = mergedSession.id;
        prevStageForWelcomeRef.current = dismissed.includes(stageIndex) ? stageIndex : null;
        tourPrevStageRef.current = stageIndex;
        const bannerStillPending = !dismissed.includes(stageIndex);
        stageWelcomeBlocksAutoTourRef.current = bannerStillPending;
        emailModalBlockedByOnboardingRef.current = bannerStillPending;

        setDismissedStageBanners(dismissed);
        if (Array.isArray(saved.emails)) {
          setEmails(saved.emails);
          previousEmailsRef.current = [...saved.emails];
        }

        setSimugramOpen(saved.simugramOpen === true);
        if (typeof saved.playNavExpanded === 'boolean') {
          setPlayNavExpanded(saved.playNavExpanded);
        }
        const ac = saved.simugramActiveContact;
        simugramActiveContactRestoreRef.current =
          typeof ac === 'string' && SIMUGRAM_SNAPSHOT_CONTACT_IDS.has(ac) ? ac : null;

        const restoreTourFromSnapshot = () => {
          const tp = saved.tourPhase;
          if (tp !== 'welcome' && tp !== 'steps') return;
          if (tp === 'welcome' && !shouldShowSimulatorIntro(saved.caseData)) return;
          queueMicrotask(() => {
            if (cancelled) return;
            if (tp === 'welcome') {
              setTourPhase('welcome');
            } else if (Array.isArray(saved.tourStepsSnapshot) && saved.tourStepsSnapshot.length > 0) {
              setTourSteps(saved.tourStepsSnapshot);
              const maxIdx = saved.tourStepsSnapshot.length - 1;
              setTourStepIndex(Math.min(Math.max(0, Number(saved.tourStepIndex) || 0), maxIdx));
              setTourPhase('steps');
            }
          });
        };

        setSession(mergedSession);
        setCurrentStage(stageIndex);
        setGameState(saved.gameState === 'report' ? 'report' : 'playing');
        if (restoreReportScreen) {
          setReport(saved.report);
        } else {
          setReport(null);
        }

        // Подгружаем кейс с сервера, чтобы письма (и текст писем) были актуальными
        const caseId = mergedSession?.case_id;
        if (caseId) {
          try {
            const res = await fetch(`${API_URL}/case?id=${encodeURIComponent(canonicalCaseCode(caseId))}`, { credentials: 'include' });
            if (!cancelled && res.ok) {
              const freshCase = await res.json();
              setCaseData(freshCase);
              const st = getStagesFromCasePayload(freshCase)[stageIndex];
              const toMerge = buildStageEnterDisplayEmails(
                st,
                stageIndex + 1,
                pinDeadlinePlaceholderBaseDate(
                  deadlinePlaceholderPinMsRef,
                  mergedSession.id,
                  stageIndex + 1,
                  () => setDeadlinePinSaveTick((n) => n + 1)
                )
              );
              if (toMerge.length > 0) {
                setEmails((prev) => mergeStageEnterIntoEmails(prev, toMerge));
              }
              restoreTourFromSnapshot();
              return;
            }
          } catch (_) {}
        }

        // Fallback: сохранённый caseData; подмешиваем stage_enter из него (текст может быть старым)
        setCaseData(saved.caseData);
        const stFallback = actualCaseData?.stages?.[stageIndex];
        const toMergeFb = buildStageEnterDisplayEmails(
          stFallback,
          stageIndex + 1,
          pinDeadlinePlaceholderBaseDate(
            deadlinePlaceholderPinMsRef,
            mergedSession.id,
            stageIndex + 1,
            () => setDeadlinePinSaveTick((n) => n + 1)
          )
        );
        if (toMergeFb.length > 0) {
          setEmails((prev) => mergeStageEnterIntoEmails(prev, toMergeFb));
        }
        restoreTourFromSnapshot();
      } catch (e) {
        console.warn('⚠️ Не удалось восстановить сессию из localStorage:', e);
        try {
          window.localStorage.removeItem(sessionStorageKey);
        } catch (_) {}
      }
    })();
    return () => { cancelled = true; };
  }, [sessionStorageKey, currentUserId]);

  // Подтягиваем кейс с сервера при смене этапа/сессии и синхронизируем stage_enter (текст писем из JSON).
  // Без «одного refetch на id сессии»: в React Strict Mode первый fetch отменяется и повторный не запускался;
  // плюс при переходе на другой этап нужна свежая выборка для актуальных писем этапа.
  useEffect(() => {
    if (gameState !== 'playing' || !session?.case_id) return;

    let cancelled = false;
    const stageIndex = session.current_stage ? session.current_stage - 1 : currentStage;

    (async () => {
      try {
        const res = await fetch(`${API_URL}/case?id=${encodeURIComponent(canonicalCaseCode(session.case_id))}`, { credentials: 'include' });
        if (cancelled || !res.ok) return;
        const freshCase = await res.json();
        const stage = getStagesFromCasePayload(freshCase)[stageIndex];
        const toMerge = buildStageEnterDisplayEmails(
          stage,
          stageIndex + 1,
          pinDeadlinePlaceholderBaseDate(
            deadlinePlaceholderPinMsRef,
            session?.id,
            stageIndex + 1,
            () => setDeadlinePinSaveTick((n) => n + 1)
          )
        );
        if (!toMerge.length) return;
        if (!cancelled) {
          setCaseData(freshCase);
          setEmails((prev) => mergeStageEnterIntoEmails(prev, toMerge));
        }
      } catch (_) {}
    })();
    return () => {
      cancelled = true;
    };
  }, [gameState, session?.id, session?.case_id, session?.current_stage, currentStage]);

  // Таймер этапа (только если в конфиге этапа задан time_budget > 0)
  useEffect(() => {
    if (gameState !== 'playing' || !session) return;

    const tick = () => {
      setTimeRemaining((prev) => {
        const deadline = wallClockDeadlineMsRef.current;
        if (deadline == null) return prev;
        if (prev === null || prev === undefined) return prev;
        return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      });
    };
    const interval = setInterval(tick, 1000);

    return () => clearInterval(interval);
  }, [gameState, session?.id]);

  /** После ухода на другую вкладку браузер замораживает/редко вызывает таймер — синхронизируем с дедлайном. */
  useEffect(() => {
    if (gameState !== 'playing' || !session) return undefined;
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const deadline = wallClockDeadlineMsRef.current;
      if (deadline == null) return;
      setTimeRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [gameState, session?.id]);

  // Сброс таймера при смене этапа (или рестарте): длительность из time_budget кейса.
  // НЕ зависит от caseData, чтобы refetch кейса не сбрасывал обратный отсчёт.
  // После F5 сначала приходит session, caseData подтягивается асинхронно — не фиксируем initKey, пока нет
  // конфига этапа, иначе один раз выставится timeRemaining=null и таймер больше не появится (тот же initKey).
  useEffect(() => {
    if (gameState !== 'playing' || !session) return;
    const stageIndex = session.current_stage ? session.current_stage - 1 : currentStage;
    const initKey = `${session.id}:${stageIndex}:${stageRemountKey}`;

    const actualCaseData = caseData?.case || caseData;
    const stages = actualCaseData?.stages;
    if (!Array.isArray(stages) || stageIndex < 0 || stageIndex >= stages.length) {
      return;
    }
    const st = stages[stageIndex];
    if (!st) return;

    if (timerInitKeyRef.current === initKey) return;
    timerInitKeyRef.current = initKey;

    const secs = getStageWallClockSeconds(st);

    let restoredRemaining = null;
    if (sessionStorageKey != null && secs != null && session?.id != null) {
      try {
        const raw = window.localStorage.getItem(sessionStorageKey);
        if (raw) {
          const saved = JSON.parse(raw);
          const wid = saved?.wallClockTimerSessionId;
          const wst = saved?.wallClockTimerStageIndex;
          const wrk = saved?.wallClockTimerRemountKey;
          const wr = saved?.wallClockTimerRemainingAtSave;
          const ws = Number(saved?.wallClockTimerSavedAt || 0);
          if (
            wid === session.id &&
            wst === stageIndex &&
            wrk === stageRemountKey &&
            typeof wr === 'number' &&
            Number.isFinite(wr) &&
            wr >= 0 &&
            Number.isFinite(ws) &&
            ws > 0
          ) {
            const elapsedSec = Math.max(0, Math.floor((Date.now() - ws) / 1000));
            restoredRemaining = Math.max(0, Math.floor(wr) - elapsedSec);
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (secs != null) {
      const R =
        restoredRemaining != null
          ? Math.min(secs, Math.max(0, restoredRemaining))
          : secs;
      setTimeRemaining(R);
      setStageStartTime(Date.now() - (secs - R) * 1000);
      wallClockDeadlineMsRef.current = Date.now() + Math.max(0, R) * 1000;
    } else {
      setTimeRemaining(null);
      wallClockDeadlineMsRef.current = null;
      setStageStartTime(Date.now());
    }
    if (session.current_stage && session.current_stage - 1 !== currentStage) {
      devLog('🔄 Синхронизация currentStage с session:', session.current_stage - 1);
      setCurrentStage(session.current_stage - 1);
    }
  }, [
    gameState,
    session?.id,
    session?.current_stage,
    caseData,
    currentStage,
    stageRemountKey,
    sessionStorageKey,
  ]);

  useEffect(() => {
    if (gameState !== 'playing') return;
    if (tourPhase === 'welcome' || tourPhase === 'steps') return;
    setPlayNavExpanded(false);
  }, [gameState, session?.id, session?.current_stage, tourPhase]);

  useEffect(() => {
    if (tourPhase !== 'steps' || !tourSteps.length) return;
    const step = tourSteps[tourStepIndex];
    if (step?.expandNav) setPlayNavExpanded(true);
  }, [tourPhase, tourStepIndex, tourSteps]);

  useEffect(() => {
    if (gameState !== 'playing') {
      setStageEnterWelcome(null);
      stageWelcomeBlocksAutoTourRef.current = false;
    }
  }, [gameState]);

  useEffect(() => {
    if (gameState !== 'playing' || !caseData || !session) return;

    const actualCaseData = caseData?.case || caseData;
    const st = actualCaseData.stages?.[currentStage];
    if (!st) return;

    if (sessionIdForStageWelcomeRef.current !== session.id) {
      sessionIdForStageWelcomeRef.current = session.id;
      prevStageForWelcomeRef.current = null;
      stageWelcomeBlocksAutoTourRef.current = false;
    }

    if (tourPhase === 'welcome') return;

    /* Пока идёт пошаговый тур — не показываем плашку и не трогаем prev: иначе после тура
       prev уже совпадает с этапом 1 и оверлей входа на этап никогда не показывается. */
    if (tourPhase === 'steps') return;

    if (prevStageForWelcomeRef.current === currentStage) return;

    prevStageForWelcomeRef.current = currentStage;

    const singleStage = (actualCaseData.stages || []).length === 1;
    if (singleStage) {
      queueMicrotask(() => {
        handleStageEnterBannerComplete();
      });
      return;
    }

    stageWelcomeBlocksAutoTourRef.current = true;
    emailModalBlockedByOnboardingRef.current = true;
    setStageEnterWelcome(getStageEnterWelcomePayload(st, currentStage + 1));
  }, [currentStage, gameState, caseData, session, tourPhase, handleStageEnterBannerComplete]);

  useEffect(() => {
    emailModalBlockedByOnboardingRef.current =
      tourPhase !== 'off' ||
      stageEnterWelcome != null ||
      stageWelcomeBlocksAutoTourRef.current;
  }, [tourPhase, stageEnterWelcome]);

  // Автообучение при входе на этап временно отключено: запуск только вручную через меню «…».

  // Сохраняем ключевые части состояния сессии в localStorage (ключ и ownerUserId — текущий пользователь)
  useEffect(() => {
    if (!sessionStorageKey || currentUserId == null) return;
    if (!session || !caseData) return;
    if (gameState !== 'playing' && gameState !== 'report') return;

    const stageIdxForTimer =
      session?.current_stage != null ? session.current_stage - 1 : currentStage;
    let tourStepsSnapshot = null;
    if (tourPhase === 'steps' && Array.isArray(tourSteps) && tourSteps.length > 0) {
      try {
        tourStepsSnapshot = JSON.parse(JSON.stringify(tourSteps));
      } catch (_) {
        tourStepsSnapshot = null;
      }
    }
    const snapshot = {
      savedAt: Date.now(),
      ownerUserId: Number(currentUserId),
      gameState,
      session,
      caseData,
      currentStage,
      dismissedStageBanners,
      emails,
      snapshotVersion: 7,
      /** Только на экране отчёта — чтобы F5 не сбрасывал на выбор кейса */
      ...(gameState === 'report' && report && typeof report === 'object' ? { report } : {}),
      tourPhase,
      tourStepIndex,
      tourStepsSnapshot,
      simugramOpen,
      playNavExpanded,
      simugramActiveContact: simugramUiSnapshotRef.current?.activeContact ?? null,
      deadlinePlaceholderPins: { ...deadlinePlaceholderPinMsRef.current },
      /** HUD-таймер этапа: после F5 не сбрасывать на полный time_budget (этапы 2–4 и др.). */
      wallClockTimerSessionId: session?.id ?? null,
      wallClockTimerStageIndex: stageIdxForTimer,
      wallClockTimerRemountKey: stageRemountKey,
      wallClockTimerRemainingAtSave:
        typeof timeRemaining === 'number' && Number.isFinite(timeRemaining)
          ? Math.max(0, Math.floor(timeRemaining))
          : null,
      wallClockTimerSavedAt: Date.now(),
    };

    try {
      window.localStorage.setItem(sessionStorageKey, JSON.stringify(snapshot));
    } catch (e) {
      console.warn('⚠️ Не удалось сохранить сессию в localStorage:', e);
    }
  }, [
    sessionStorageKey,
    currentUserId,
    session,
    caseData,
    currentStage,
    gameState,
    report,
    dismissedStageBanners,
    emails,
    simugramOpen,
    playNavExpanded,
    simugramSnapshotTick,
    timeRemaining,
    stageRemountKey,
    deadlinePinSaveTick,
    tourPhase,
    tourStepIndex,
    tourSteps,
  ]);

  // Управление очередью новых писем
  useEffect(() => {
    if (emails.length === 0) {
      previousEmailsRef.current = [];
      setUnreadEmailsQueue([]);
      return;
    }

    // Находим новые непрочитанные письма
    const previousEmailIds = new Set(previousEmailsRef.current.map(e => e.id));
    const newUnreadEmails = emails.filter(
      email => !email.read && !previousEmailIds.has(email.id)
    );

    // Если есть новые письма, обновляем очередь
    if (newUnreadEmails.length > 0) {
      setUnreadEmailsQueue(prev => {
        const existingIds = new Set(prev.map(e => e.id));
        const uniqueNew = newUnreadEmails.filter(e => !existingIds.has(e.id));
        return [...uniqueNew, ...prev];
      });
    }

    // Обновляем предыдущий список писем
    previousEmailsRef.current = [...emails];
  }, [emails]);

  // Показываем модальное окно для новых писем только после полного «обучения»:
  // нет welcome/тура и закрыта карточка входа на этап (иначе каша с оверлеями).
  useEffect(() => {
    if (
      gameState === 'playing' &&
      !emailModalBlockedByOnboardingRef.current &&
      !newEmailModal &&
      unreadEmailsQueue.length > 0
    ) {
      const timer = setTimeout(() => {
        setNewEmailModal((prev) => {
          if (prev) return prev;
          if (emailModalBlockedByOnboardingRef.current) return null;
          return unreadEmailsQueue[0] || null;
        });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [gameState, newEmailModal, unreadEmailsQueue, tourPhase, stageEnterWelcome]);

  const handleCaseSelect = async (caseId) => {
    devLog('🚀 Запуск кейса:', caseId);
    devLog('   Тип caseId:', typeof caseId, 'Значение:', JSON.stringify(caseId));
    
    // Очищаем снимок текущего пользователя при выборе нового кейса
    try {
      if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
    } catch (e) {
      console.warn('⚠️ Не удалось очистить localStorage:', e);
    }
    
    // Сбрасываем состояние
    setReport(null);
    setDismissedStageBanners([]);
    setEmails([]);
    setNewEmailModal(null);
    setUnreadEmailsQueue([]);
    previousEmailsRef.current = [];
    setStage4EmailModalCloseNonce(0);
    setSelectedCaseId(caseId);
    setGameState('loading');
    
    try {
      // Загружаем данные кейса
      const canonId = canonicalCaseCode(caseId);
      const caseUrl = `${API_URL}/case?id=${encodeURIComponent(canonId)}`;
      devLog('📂 Загрузка кейса:', caseUrl);
      const caseData = await safeFetch(caseUrl);
      devLog('✅ Кейс загружен:', {
        id: caseData.id,
        title: caseData.title,
        stagesCount: caseData.stages?.length,
        stages: caseData.stages?.map(s => ({ id: s.id, type: s.type, title: s.title, order: s.order })) || []
      });
      setCaseData(caseData);

      // Запускаем сессию
      devLog('🎮 Создание сессии для кейса:', caseId);
      const session = await safeFetch(`${API_URL}/session/start`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ case_id: canonId })
      });
      devLog('✅ Сессия создана:', {
        sessionId: session.id,
        caseId: session.case_id,
        currentStage: session.current_stage,
        caseDataId: caseData.id,
        caseDataStages: caseData.stages?.map(s => ({ id: s.id, type: s.type, order: s.order })) || []
      });
      setSession(session);
      tourPrevStageRef.current = null;
      pendingStageTourAfterBannerFromHudRef.current = false;
      const showFullCaseWelcome = !readSkipCaseTour() && shouldShowSimulatorIntro(caseData);
      if (showFullCaseWelcome) {
        setTourPhase('welcome');
      } else {
        setTourPhase('off');
        setTourSteps([]);
        setTourStepIndex(0);
      }

      // Устанавливаем правильный индекс этапа на основе current_stage из сессии
      // current_stage в сессии - это порядковый номер (1, 2, 3...), а нам нужен индекс (0, 1, 2...)
      const initialStageIndex = session.current_stage ? session.current_stage - 1 : 0;
      devLog('🎯 Установка начального этапа:', {
        sessionCurrentStage: session.current_stage,
        calculatedIndex: initialStageIndex,
        stageInCase: caseData.stages?.[initialStageIndex] ? {
          id: caseData.stages[initialStageIndex].id,
          type: caseData.stages[initialStageIndex].type,
          title: caseData.stages[initialStageIndex].title
        } : null
      });
      setCurrentStage(initialStageIndex);
      setGameState('playing');
      
      // Генерируем письма для текущего этапа
      generateStageEmails(caseData, initialStageIndex);
    } catch (error) {
      console.error('❌ Ошибка при запуске кейса:', error);
      handleApiError(error);
      setGameState('error');
    }
  };

  /** Преобразует описание письма из кейса в объект для UI (id, from, subject, body, read, timestamp, stage). */
  const toDisplayEmail = useCallback(
    (conf, stageNumber) => {
      const base = getDeadlinePlaceholderBaseDate(stageNumber);
      const t = base.getTime();
      return {
        id: conf.id,
        from: conf.from || 'Система',
        subject: applyDeadlinePlaceholders(conf.subject || '', base),
        body: applyDeadlinePlaceholders(conf.body || '', base),
        read: false,
        timestamp: t,
        stage: stageNumber,
      };
    },
    [getDeadlinePlaceholderBaseDate]
  );

  /** Письма при входе на этап → пуш в Simugram (контакт «Ирина Петровна»). */
  const generateStageEmails = (caseData, stageIndex) => {
    const actualCaseData = caseData?.case || caseData;
    const stage = actualCaseData?.stages?.[stageIndex];
    const toMerge = buildStageEnterDisplayEmails(
      stage,
      stageIndex + 1,
      getDeadlinePlaceholderBaseDate(stageIndex + 1)
    );
    if (!toMerge.length) return;
    setEmails((prev) => mergeStageEnterIntoEmails(prev, toMerge));
    toMerge.forEach((e) => simugramRef.current?.pushBossEmail(e));
    setSimugramOpen(true);
    setTimeout(() => simugramRef.current?.openContact(CONTACT_IDS.BOSS), 50);
    if (stageIndex === 3) {
      setTimeout(() => setStage4EmailModalCloseNonce((n) => n + 1), 600);
    }
  };

  const handleAction = async (actionId) => {
    if (!session) {
      console.error('❌ Нет сессии для выполнения действия');
      return;
    }

    try {
      devLog('🎯 Выполнение действия:', actionId, 'для сессии:', session.id);
      const data = await safeFetch(`${API_URL}/action/execute`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action_id: actionId, session })
      });
      
      devLog('✅ Действие выполнено');
      devLog('📊 LEXIC до:', session.lexic);
      devLog('📊 LEXIC после:', data.session.lexic);
      devLog('📊 Изменения:', {
        L: data.session.lexic.L - session.lexic.L,
        E: data.session.lexic.E - session.lexic.E,
        X: data.session.lexic.X - session.lexic.X,
        I: data.session.lexic.I - session.lexic.I,
        C: data.session.lexic.C - session.lexic.C
      });
      
      // Обновляем сессию
      setSession(data.session);
      
      // Письма по триггеру after_action: из конфига этапа (trigger === "after_action", action_id === actionId)
      const actualCaseData = caseData?.case || caseData;
      const currentStageIndex = data.session.current_stage - 1;
      const stage = actualCaseData?.stages?.[currentStageIndex];
      if (stage?.emails) {
        const stageNumber = currentStageIndex + 1;
        const toAdd = stage.emails
          .filter(e => e.trigger === 'after_action' && e.action_id === actionId)
          .map(e => toDisplayEmail(e, stageNumber));
        if (toAdd.length > 0) {
          setEmails(prev => {
            const existingIds = new Set(prev.map(x => x.id));
            const newOnes = toAdd.filter(e => !existingIds.has(e.id));
            return [...prev, ...newOnes];
          });
          toAdd.forEach((e) => simugramRef.current?.pushBossEmail(e));
        }
      }
    } catch (error) {
      console.error('❌ Ошибка при выполнении действия:', actionId, error);
      // Показываем более детальную ошибку
      const errorMessage = error?.error || error?.message || 'Неизвестная ошибка при выполнении действия';
      handleApiError({ error: errorMessage });
    }
  };

  const handleMarkEmailAsRead = (emailId) => {
    setEmails(prev => prev.map(email => 
      email.id === emailId ? { ...email, read: true } : email
    ));
  };

  const handleNewEmailModalClose = () => {
    const closedEmailId = newEmailModal?.id;
    const stageIdx =
      session?.current_stage != null ? session.current_stage - 1 : currentStage;
    if (
      gameState === 'playing' &&
      stageIdx === 3 &&
      newEmailModal &&
      Number(newEmailModal.stage) === 4
    ) {
      setStage4EmailModalCloseNonce((n) => n + 1);
    }

    // Помечаем письмо как прочитанное
    if (newEmailModal && !newEmailModal.read) {
      handleMarkEmailAsRead(newEmailModal.id);
    }

    // Проверяем, есть ли еще непрочитанные письма
    setTimeout(() => {
      const remainingUnreadEmails = emails.filter(
        (email) => !email.read && email.id !== closedEmailId
      );

      if (remainingUnreadEmails.length > 0 && gameState === 'playing') {
        if (emailModalBlockedByOnboardingRef.current) {
          setNewEmailModal(null);
          setUnreadEmailsQueue(remainingUnreadEmails);
          return;
        }
        setNewEmailModal(remainingUnreadEmails[0]);
        setUnreadEmailsQueue(remainingUnreadEmails);
      } else {
        setNewEmailModal(null);
        setUnreadEmailsQueue([]);
      }
    }, 200);
  };

  const handleStage1BeforeComplete = (sessionWithResult) => {
    setSession(sessionWithResult);
    void handleStageComplete(sessionWithResult);
  };

  /** @param {object} [sessionOverride] — сразу после этапа 1: свежий объект сессии с stage1_result (ещё не в state). */
  const handleStageComplete = async (sessionOverride) => {
    const sess = sessionOverride ?? session;
    if (!sess || !caseData) return;
    if (stageCompleteInFlightRef.current) return;

    const actualCaseData = caseData?.case || caseData;
    const stage = actualCaseData.stages[currentStage];
    if (!stage) return;

    stageCompleteInFlightRef.current = true;
    setStageCompleteInFlight(true);

    const completedStageIndex = currentStage;
    const totalStages = actualCaseData.stages.length;
    const isLastStage = currentStage >= totalStages - 1;

    try {
      const data = await safeFetch(`${API_URL}/stage/complete`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ stage_id: stage.id, session: sess })
      });
      setSession(data.session);
      const mergeSrc = data.next_stage_email_merge;
      if (
        mergeSrc &&
        Array.isArray(mergeSrc.emails) &&
        mergeSrc.emails.length &&
        data.session?.id != null
      ) {
        const sn = Number(mergeSrc.stage_number);
        if (!Number.isNaN(sn) && sn >= 1) {
          const toMerge = buildStageEnterDisplayEmails(
            { emails: mergeSrc.emails },
            sn,
            pinDeadlinePlaceholderBaseDate(
              deadlinePlaceholderPinMsRef,
              data.session.id,
              sn,
              () => setDeadlinePinSaveTick((n) => n + 1)
            )
          );
          if (toMerge.length) {
            setEmails((prev) => mergeStageEnterIntoEmails(prev, toMerge));
          }
        }
      }
      if (completedStageIndex === 0 && sess?.id) {
        try {
          clearStageDraft(sess.id, 1);
        } catch (_) {
          /* ignore */
        }
      }
      if (sess?.id && completedStageIndex >= 1 && completedStageIndex <= 3) {
        try {
          clearStageDraft(sess.id, completedStageIndex + 1);
        } catch (_) {
          /* ignore */
        }
      }

      if (data.session.current_stage > totalStages) {
        devLog('✅ Все этапы завершены, генерируем отчет');
        await generateReport(data.session);
      } else {
        const nextStageIndex = data.session.current_stage - 1;
        devLog('🔄 Переход на этап:', nextStageIndex + 1, 'из', totalStages);
        setCurrentStage(nextStageIndex);
        generateStageEmails(actualCaseData, nextStageIndex);
      }
    } catch (error) {
      handleApiError(error);
      if (isLastStage) setGameState('playing');
    } finally {
      stageCompleteInFlightRef.current = false;
      setStageCompleteInFlight(false);
    }
  };

  const handleRestartStage = useCallback(async () => {
    if (!userCanRestartSimulatorStage(viewerUser)) return;
    if (!session || !caseData || gameState !== 'playing') return;
    if (stageCompleteInFlightRef.current || restartStageInFlightRef.current) return;

    const stageIdx = currentStage;
    restartStageInFlightRef.current = true;
    setRestartStageLoading(true);
    try {
      const base = API_URL.replace(/\/$/, '');
      const data = await safeFetchPostOn404Fallback(
        [`${base}/stage/restart`, `${base}/session/restart-stage`],
        { session },
        { headers: getAuthHeaders() }
      );
      const next = data.session;
      if (!next) throw new Error('Пустой ответ сессии');

      sessionIdForStageWelcomeRef.current = next.id;
      prevStageForWelcomeRef.current = stageIdx;
      tourPrevStageRef.current = stageIdx;
      stageWelcomeBlocksAutoTourRef.current = false;
      setStageEnterWelcome(null);
      setTourPhase('off');
      setTourSteps([]);
      setTourStepIndex(0);
      chainedHudToStageTourRef.current = false;
      pendingStageTourAfterBannerFromHudRef.current = false;
      emailModalBlockedByOnboardingRef.current = false;

      if (stageIdx === 3) {
        setStage4EmailModalCloseNonce(0);
      }

      const stageNum = stageIdx + 1;
      const actualCaseData = caseData?.case || caseData;
      const stageCfg = actualCaseData?.stages?.[stageIdx];
      forgetDeadlinePlaceholderBaseForStage(stageNum);
      const stageEnterToRestore = buildStageEnterDisplayEmails(
        stageCfg,
        stageNum,
        getDeadlinePlaceholderBaseDate(stageNum)
      );
      setEmails((prev) => {
        const n = prev.filter((e) => e.stage !== stageNum);
        const existingIds = new Set(n.map((x) => x.id));
        const newOnes = stageEnterToRestore.filter((e) => !existingIds.has(e.id));
        const merged = [...n, ...newOnes];
        // Только список без восстановленных писем — иначе эффект очереди не посчитает stage_enter «новыми»
        previousEmailsRef.current = n;
        return merged;
      });
      setNewEmailModal(null);
      setUnreadEmailsQueue([]);

      setDismissedStageBanners((prev) =>
        prev.includes(stageIdx) ? prev : [...prev, stageIdx]
      );

      if (stageIdx === 0 && session?.id) {
        try {
          window.localStorage.removeItem(`simulex_s1_chat_${session.id}`);
          window.localStorage.removeItem(`simulex_s1_patience_${session.id}`);
          clearStageDraft(session.id, 1);
        } catch (_) {
          /* ignore */
        }
        if (currentUserId != null) clearTutorChatLocal(currentUserId, session.id);
      }
      if (session?.id && stageIdx >= 1 && stageIdx <= 3) {
        try {
          clearStageDraft(session.id, stageIdx + 1);
        } catch (_) {
          /* ignore */
        }
      }

      setSession(next);
      setStageRemountKey((k) => k + 1);
    } catch (error) {
      handleApiError(error);
    } finally {
      restartStageInFlightRef.current = false;
      setRestartStageLoading(false);
    }
  }, [
    viewerUser,
    session,
    caseData,
    gameState,
    currentStage,
    currentUserId,
    forgetDeadlinePlaceholderBaseForStage,
    getDeadlinePlaceholderBaseDate,
  ]);

  const generateReport = async (finalSession) => {
    setGameState('report-loading');
    try {
      const report = await safeFetch(`${API_URL}/report/generate`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ session: finalSession })
      });
      setReport(report);
      setGameState('report');
    } catch (error) {
      handleApiError(error);
      setGameState('playing');
    }
  };

  const handleFinishCase = () => {
    pendingStageTourAfterBannerFromHudRef.current = false;
    setStageEnterWelcome(null);
    stageWelcomeBlocksAutoTourRef.current = false;
    if (session?.id && currentUserId != null) clearTutorChatLocal(currentUserId, session.id);
    if (session?.id) {
      try {
        clearAllStageDraftsForSession(session.id);
        window.localStorage.removeItem(`simulex_s1_chat_${session.id}`);
        window.localStorage.removeItem(`simulex_s1_patience_${session.id}`);
      } catch (_) {
        /* ignore */
      }
    }
    setGameState('case-selection');
    setReport(null);
    setCaseData(null);
    setSession(null);
    setCurrentStage(0);
    setSelectedCaseId(null);
    setStage4EmailModalCloseNonce(0);
    setEmails([]);
    setDismissedStageBanners([]);
    setUnreadEmailsQueue([]);
    previousEmailsRef.current = [];
    try {
      if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
    } catch {}
  };

  const handleBackToStart = () => {
    pendingStageTourAfterBannerFromHudRef.current = false;
    setStageEnterWelcome(null);
    stageWelcomeBlocksAutoTourRef.current = false;
    if (session?.id && currentUserId != null) clearTutorChatLocal(currentUserId, session.id);
    if (session?.id) {
      try {
        clearAllStageDraftsForSession(session.id);
        window.localStorage.removeItem(`simulex_s1_chat_${session.id}`);
        window.localStorage.removeItem(`simulex_s1_patience_${session.id}`);
      } catch (_) {
        /* ignore */
      }
    }
    setGameState('case-selection');
    setReport(null);
    setCaseData(null);
    setSession(null);
    setCurrentStage(0);
    setSelectedCaseId(null);
    setStage4EmailModalCloseNonce(0);
    setEmails([]);
    setDismissedStageBanners([]);
    setUnreadEmailsQueue([]);
    previousEmailsRef.current = [];
    try {
      if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
    } catch {}
  };

  const unreadEmailCount = emails.filter(e => !e.read).length;

  const buildDocsWithDynamicBrief = (serverData, sessionArg, caseDataArg) => {
    const docsFromServer = serverData?.docs || [];
    const actualCase = (caseDataArg?.case || caseDataArg) || {};
    const stages = actualCase.stages || [];
    const hasStage1 = stages.some((s) => s.id === 'stage-1' || s.type === 'context');
    const stage1Result = sessionArg?.stage1_result;

    // Одноэтапники этапов 2–4: в reference_docs нужен статичный brief.md (нет этапа 1 в сценарии).
    // Кейсы с интерактивным этапом 1 (полный цикл или case-stage-1): моковый бриф в «Документы»
    // не показываем, пока нет stage1_result — бриф собирается в интерфейсе этапа 1.
    if (hasStage1 && !stage1Result) {
      return docsFromServer.filter((d) => d.id !== 'brief');
    }
    if (!hasStage1 || !stage1Result) {
      return docsFromServer;
    }

    const stage1 = stages.find((s) => s.id === 'stage-1' || s.type === 'context') || {};
    const attributes = stage1.attributes || [];
    const insightsByAttr = stage1Result.insights_by_attribute || {};

    const conclusionText = stage1Result.conclusion_text || '';
    let md = '## Бриф по сделке (по итогам этапа 1)\n\n';
    if (attributes.length > 0) {
      attributes.forEach((attr, idx) => {
        const isConclusion = attr.type === 'conclusion';
        if (isConclusion) {
          md += `### ${idx + 1}. ${attr.title}\n\n`;
          if (conclusionText.trim()) {
            md += `${conclusionText.trim()}\n\n`;
          } else {
            md += '_Нет данных по этому блоку брифа._\n\n';
          }
          return;
        }
        const texts = insightsByAttr[attr.id] || [];
        md += `### ${idx + 1}. ${attr.title}\n\n`;
        if (texts.length > 0) {
          texts.forEach((t) => {
            const line = typeof t === 'string' ? t : String(t);
            md += `- ${line}\n`;
          });
          md += '\n';
        } else {
          md += '_Нет данных по этому блоку брифа._\n\n';
        }
      });
    } else {
      // Fallback, если по какой-то причине нет конфигурации атрибутов
      const entries = Object.entries(insightsByAttr);
      if (entries.length === 0) {
        md += '_Бриф пока пуст — нет заметок с этапа 1._\n';
      } else {
        entries.forEach(([key, texts]) => {
          md += `### ${key}\n\n`;
          (Array.isArray(texts) ? texts : []).forEach((t) => {
            const line = typeof t === 'string' ? t : String(t);
            md += `- ${line}\n`;
          });
          md += '\n';
        });
      }
    }

    const dynamicBriefDoc = {
      id: 'brief',
      title: 'Бриф по сделке',
      kind: 'markdown',
      filename: null,
      content: md,
    };

    const withoutOldBrief = docsFromServer.filter((d) => d.id !== 'brief');
    return [dynamicBriefDoc, ...withoutOldBrief];
  };

  const loadStage2CaseDocuments = useCallback(
    async (isCancelled = () => false) => {
      if (!session) return;
      const rawCid = session.case_id || (caseData?.case || caseData)?.id;
      if (!rawCid) {
        if (!isCancelled()) {
          setStage2CaseDocsError('Не удалось определить кейс для загрузки документов');
        }
        return;
      }
      const cid = canonicalCaseCode(rawCid);
      if (!isCancelled()) {
        setStage2CaseDocsLoading(true);
        setStage2CaseDocsError(null);
      }
      try {
        const data = await safeFetch(
          `${API_URL}/case/docs?case_id=${encodeURIComponent(cid)}`
        );
        if (isCancelled()) return;
        const docsWithBrief = buildDocsWithDynamicBrief(data, session, caseData);
        setStage2CaseDocs({ case_id: cid, docs: docsWithBrief });
      } catch (err) {
        if (isCancelled()) return;
        const msg =
          err?.detail || err?.error || err?.message || 'Не удалось загрузить документы кейса';
        setStage2CaseDocsError(msg);
        setStage2CaseDocs(null);
      } finally {
        setStage2CaseDocsLoading(false);
      }
    },
    [session, caseData]
  );

  useEffect(() => {
    const actualCaseData = caseData?.case || caseData;
    const stNow = actualCaseData?.stages?.[currentStage];
    const isSt2 = stNow && (stNow.id === 'stage-2' || stNow.type === 'position');
    if (!isSt2 || gameState !== 'playing') {
      stage2DocsTourSnapshotRef.current = null;
      stage2DocsTourFetchStartedRef.current = false;
      return;
    }

    const onDocsStep = tourPhase === 'steps' && activeSimulatorTourStepId === 's2-docs';

    if (!onDocsStep) {
      stage2DocsTourFetchStartedRef.current = false;
      if (stage2DocsTourSnapshotRef.current !== null) {
        const prevOpen = stage2DocsTourSnapshotRef.current;
        stage2DocsTourSnapshotRef.current = null;
        if (!prevOpen) {
          setStage2BriefModalOpen(false);
          setStage2CaseDocs(null);
          setStage2CaseDocsError(null);
        }
      }
      return;
    }

    if (stage2DocsTourFetchStartedRef.current) return;
    stage2DocsTourFetchStartedRef.current = true;
    if (stage2DocsTourSnapshotRef.current === null) {
      stage2DocsTourSnapshotRef.current = stage2BriefModalOpen;
    }
    let cancelled = false;
    setStage2BriefModalOpen(true);
    loadStage2CaseDocuments(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [
    gameState,
    currentStage,
    caseData,
    tourPhase,
    activeSimulatorTourStepId,
    stage2BriefModalOpen,
    loadStage2CaseDocuments,
  ]);

  const handleOpenDocuments = async () => {
    if (!session) return;
    const rawDocCase = session.case_id || (caseData?.case || caseData)?.id;
    if (!rawDocCase) return;
    const caseIdFromSession = canonicalCaseCode(rawDocCase);

    const actualCaseData = caseData?.case || caseData;
    const stages = actualCaseData?.stages;
    const stNow = stages?.length ? stages[currentStage] : null;
    const isStage2Active =
      stNow && (stNow.id === 'stage-2' || stNow.type === 'position');
    if (isStage2Active) {
      setShowDocsModal(false);
      setStage2BriefModalOpen(true);
      await loadStage2CaseDocuments(() => false);
      return;
    }

    setShowDocsModal(true);
    if (caseDocs && canonicalCaseCode(caseDocs.case_id || '') === caseIdFromSession) {
      // Кэш по case_id не учитывал появление stage1_result после этапа 1 — бриф оставался
      // отфильтрованным, как при первом открытии «Документы» до завершения этапа 1.
      setCaseDocs((prev) => {
        if (!prev) return prev;
        const docsWithBrief = buildDocsWithDynamicBrief(
          { docs: prev.docs || [] },
          session,
          caseData
        );
        return { ...prev, docs: docsWithBrief };
      });
      return;
    }

    setCaseDocsLoading(true);
    setCaseDocsError(null);
    try {
      const data = await safeFetch(
        `${API_URL}/case/docs?case_id=${encodeURIComponent(caseIdFromSession)}`
      );
      const docsWithBrief = buildDocsWithDynamicBrief(data, session, caseData);
      setCaseDocs({ ...data, case_id: caseIdFromSession, docs: docsWithBrief });
    } catch (err) {
      const msg = err?.detail || err?.error || err?.message || 'Не удалось загрузить документы кейса';
      setCaseDocsError(msg);
    } finally {
      setCaseDocsLoading(false);
    }
  };

  useEffect(() => {
    const actualCaseData = caseData?.case || caseData;
    const stNow = actualCaseData?.stages?.[currentStage];
    const isSt2 = stNow && (stNow.id === 'stage-2' || stNow.type === 'position');
    if (!isSt2) {
      setStage2BriefModalOpen(false);
      setStage2CaseDocs(null);
      setStage2CaseDocsError(null);
    }
  }, [currentStage, caseData]);

  const handleTutorEvent = async (eventType, payload) => {
    if (!simugramRef.current) return;
    try {
      const actualCaseData = caseData?.case || caseData;
      const data = await tutorAPI.event({
        eventType,
        payload,
        sessionId: session?.id ?? undefined,
        caseId: actualCaseData?.id ?? undefined,
        currentStage: session?.current_stage != null ? session.current_stage - 1 : undefined,
      });
      if (data?.message) {
        simugramRef.current.appendTutorMessage(data.message);
      }
    } catch (_) {}
  };

  /** Этап 3: по клику на пункт — открыть Симуграм и активный чат с юристом (Иван Кузнецов). */
  const openStage3LawyerSimugram = useCallback(() => {
    setSimugramOpen(true);
    setTimeout(() => {
      simugramRef.current?.openContact(CONTACT_IDS.LAWYER);
    }, 50);
  }, []);

  const handleBossPoll = useCallback(
    (pollData) => {
      if (!simugramRef.current) return;
      const pollId = pollData.id;
      const origOnSubmit = pollData.onSubmit;
      simugramRef.current.pushBossPoll({
        ...pollData,
        onSubmit: (selectedReasons) => {
          if (origOnSubmit) origOnSubmit(selectedReasons);
          setTimeout(() => {
            simugramRef.current?.markBossPollDone?.(pollId);
          }, 600);
        },
      });
      setSimugramOpen(true);
      simugramRef.current.openContact(CONTACT_IDS.BOSS);
    },
    []
  );

  if (gameState === 'case-selection') {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          height: '100%',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
        }}
      >
        <header style={{ flexShrink: 0 }}>
          <GameContextNavBar
            variant="lobby"
            username={appMenu?.username ?? ''}
            roleSuffix={appRoleSuffix}
            onLogout={appMenu?.onLogout ?? onLogout}
            onLogoClick={handleBackToStart}
            onMyReports={appMenu ? () => appMenu.onNavigate('my-reports') : undefined}
            onQaBugs={
              appMenu?.showQaBugs ? () => appMenu.onNavigate('qa-bugs') : undefined
            }
            onAdminPanel={
              appMenu?.isAdmin ? () => appMenu.onNavigate('admin') : undefined
            }
          />
        </header>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <CaseSelectionScreen
            onCaseSelect={handleCaseSelect}
            onBack={onLogout}
            showTechnicalMetadata={showCaseTechnicalMetadata}
          />
        </div>
      </div>
    );
  }

  if (gameState === 'loading') {
    return <div style={{ textAlign: 'center', paddingTop: '100px' }}>⏳ Загрузка кейса...</div>;
  }

  if (gameState === 'error') {
    return <div style={{ textAlign: 'center', paddingTop: '100px' }}>❌ Ошибка загрузки</div>;
  }

  if (gameState === 'report-loading') {
    return <ReportLoadingOverlay />;
  }

  if (gameState === 'report' && report) {
    return (
      <ReportView
        report={report}
        caseData={caseData}
        viewerUser={viewerUser}
        onRestart={() => {
          const rawId =
            selectedCaseId ||
            session?.case_id ||
            caseData?.id ||
            caseData?.case?.id ||
            report?.case_id;
          const againId = rawId ? canonicalCaseCode(String(rawId)) : null;
          try {
            if (session?.id && currentUserId != null) clearTutorChatLocal(currentUserId, session.id);
            if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
          } catch {}
          setReport(null);
          setDismissedStageBanners([]);
          if (!againId) {
            setGameState('case-selection');
            setCaseData(null);
            setSession(null);
            setCurrentStage(0);
            return;
          }
          void handleCaseSelect(againId);
        }}
        onBackToStart={() => {
          try {
            if (session?.id && currentUserId != null) clearTutorChatLocal(currentUserId, session.id);
            if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
          } catch {}
          setGameState('case-selection');
          setReport(null);
          setCaseData(null);
          setSession(null);
          setCurrentStage(0);
          setSelectedCaseId(null);
          setDismissedStageBanners([]);
        }}
      />
    );
  }

  if (!caseData || !session) return null;

  // Обрабатываем структуру caseData
  const actualCaseData = caseData?.case || caseData;
  if (!actualCaseData || !actualCaseData.stages) return null;

      // Используем current_stage из сессии, если он есть
      let stageIndex = session?.current_stage ? session.current_stage - 1 : currentStage;
      const totalStages = actualCaseData.stages.length;
      
      // Убеждаемся, что индекс в допустимых пределах
      if (stageIndex < 0) {
        stageIndex = 0;
      }
      
      // Проверяем, что индекс этапа не превышает количество этапов
      // Если все этапы завершены (current_stage строго больше totalStages), генерируем отчет
      // НО только если:
      // 1. Это действительно завершение (current_stage > totalStages)
      // 2. Отчет еще не был сгенерирован (!report)
      // 3. Симуляция в состоянии 'playing' (не при восстановлении или загрузке)
      if (
        gameState === 'playing' &&
        session?.current_stage && 
        session.current_stage > totalStages && 
        !report
      ) {
        devLog('✅ Все этапы завершены, генерируем отчет', {
          current_stage: session.current_stage,
          totalStages: totalStages,
          gameState: gameState
        });
        // Генерируем отчет асинхронно
        generateReport(session);
        return null; // Показываем загрузку отчета
      }
      
      // Если индекс выходит за пределы, но это не завершение - корректируем его
      if (stageIndex >= totalStages) {
        console.warn('⚠️ Индекс этапа выходит за пределы, корректируем на последний этап', {
          stageIndex,
          totalStages,
          current_stage: session?.current_stage
        });
        stageIndex = totalStages - 1;
      }
      
      const stage = actualCaseData.stages[stageIndex];
      
      devLog('🎯 Определение этапа для отображения:', {
        caseId: actualCaseData.id,
        caseTitle: actualCaseData.title,
        sessionCurrentStage: session?.current_stage,
        currentStage: currentStage,
        calculatedStageIndex: stageIndex,
        totalStages: totalStages,
        selectedStage: stage ? { id: stage.id, type: stage.type, title: stage.title, order: stage.order } : null,
        allStages: actualCaseData.stages.map(s => ({ id: s.id, type: s.type, title: s.title, order: s.order }))
      });
      
      if (!stage) {
        console.error('❌ Этап не найден:', stageIndex, 'всего этапов:', totalStages);
        console.error('   Доступные этапы:', actualCaseData.stages.map(s => ({ id: s.id, type: s.type, order: s.order })));
        // Если этап не найден и все этапы завершены, генерируем отчет
        if (session?.current_stage > totalStages && !report) {
          generateReport(session);
          return null;
        }
        return <div>Ошибка: этап не найден (индекс: {stageIndex})</div>;
      }
  
  // Обогащаем данные этапа информацией из сессии
  const enrichedStage = {
    ...stage,
    // Фильтруем действия: показываем только те, которые еще не выполнены
    actions: (stage.actions || []).map(action => ({
      ...action,
      isDone: session?.actions_done?.includes(action.id) || false
    }))
  };
  
  if (process.env.NODE_ENV !== 'production') {
    devLog('📊 Отображение этапа:', {
      index: stageIndex,
      id: enrichedStage.id,
      type: enrichedStage.type,
      title: enrichedStage.title,
      actionsCount: enrichedStage.actions?.length || 0
    });
  }

  // Получаем компонент этапа из реестра
  const StageComponent = getStageComponent(enrichedStage);

  // Этапы с кастомным UI (Stage1, Stage2, Stage3) управляют своим layout
  const isStage1 = enrichedStage.id === 'stage-1' || enrichedStage.type === 'context';
  const isStage2 = enrichedStage.id === 'stage-2' || enrichedStage.type === 'position';
  const isStage3 = enrichedStage.id === 'stage-3' || enrichedStage.type === 'negotiation';
  const isStage4 = enrichedStage.id === 'stage-4' || enrichedStage.type === 'crisis';
  const needsFullScreen = isStage1 || isStage2 || isStage3 || isStage4;
  const showStageTimer = getStageWallClockSeconds(enrichedStage) != null;

  const handleSessionUpdate = (updatedSession) => {
    if (updatedSession && typeof setSession === 'function') setSession(updatedSession);
  };

  const stageContent = (
    <StageComponent
      key={`${session?.id}-${stageIndex}-${stageRemountKey}`}
      session={session}
      stage={enrichedStage}
      caseData={caseData}
      onAction={handleAction}
      onComplete={handleStageComplete}
      onStage1BeforeComplete={isStage1 ? handleStage1BeforeComplete : undefined}
      timeRemaining={timeRemaining}
      onBackToStart={isStage2 ? undefined : handleBackToStart}
      onFinishCase={handleFinishCase}
      onTutorEvent={isStage3 ? undefined : handleTutorEvent}
      onSessionUpdate={handleSessionUpdate}
      onChatExpose={isStage1 ? setStage1ChatState : isStage3 ? setStage3ChatState : undefined}
      onDiscussClauseOpen={isStage3 ? openStage3LawyerSimugram : undefined}
      simulatorTourStepId={activeSimulatorTourStepId}
      stageCompleteInFlight={stageCompleteInFlight}
      hudClearanceTopPx={isStage1 ? getGameplayHudClearanceTopPx(playNavExpanded) : undefined}
      chatColumnTopInsetPx={
        isStage3 ? getGameplayHudClearanceTopPx(playNavExpanded) : undefined
      }
      stageStartTime={isStage2 ? stageStartTime : undefined}
      {...(isStage2
        ? {
            showBriefModal: stage2BriefModalOpen,
            onCloseBriefModal: () => {
              setStage2BriefModalOpen(false);
              setStage2CaseDocs(null);
              setStage2CaseDocsError(null);
            },
            documentsModalDocs: stage2CaseDocs?.docs ?? [],
            documentsModalLoading: stage2CaseDocsLoading,
            documentsModalError: stage2CaseDocsError,
            onBossPoll: handleBossPoll,
          }
        : {})}
      {...(isStage4
        ? {
            onFinalContractForDocumentsChange: handleStage4FinalContractForDocuments,
            stage4EmailModalCloseNonce,
            onContractHudTimerSeconds: setStage4ContractHudSeconds,
          }
        : {})}
    />
  );

  const baseDocumentsModalDocs = caseDocs?.docs || [];
  const documentsModalDocsMerged =
    isStage4 && stage4FinalContractMarkdown
      ? [
          ...baseDocumentsModalDocs,
          {
            id: 'simulex-stage4-final-contract',
            title: 'Финальная версия договора',
            content: stage4FinalContractMarkdown,
          },
        ]
      : baseDocumentsModalDocs;

  return (
    <SimugramProvider key={`simugram-${session?.id ?? 'nosess'}-${stageRemountKey}`}>
    <SimugramSessionSnapshotBridge
      activeContactSnapshotRef={simugramUiSnapshotRef}
      contactIdRestoreRef={simugramActiveContactRestoreRef}
      sessionId={session?.id}
      onActiveContactChange={bumpSimugramSnapshotTick}
    />
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {playNavExpanded && (
        <header ref={playNavHeaderRef} style={{ flexShrink: 0 }}>
          <GameContextNavBar
            variant="playing"
            username={appMenu?.username ?? ''}
            roleSuffix={appRoleSuffix}
            onLogout={appMenu?.onLogout ?? onLogout}
            onLogoClick={handleBackToStart}
            onQaBugs={
              appMenu?.showQaBugs ? () => appMenu.onNavigate('qa-bugs') : undefined
            }
            onSimulatorTour={startSimulatorTour}
            onFinishCaseClick={() => setShowFinishCaseConfirm(true)}
            stageTitle={enrichedStage?.title || 'Прохождение кейса'}
            points={session.resources.points}
            showCreditsStrip={showCaseTechnicalMetadata && !isStage1}
          />
        </header>
      )}
      {showFinishCaseConfirm && (
        <FinishCaseConfirm
          onDismiss={() => setShowFinishCaseConfirm(false)}
          onConfirm={() => {
            setShowFinishCaseConfirm(false);
            handleFinishCase();
          }}
        />
      )}
      {PLATFORM_SHELL ? (
        <GameplayHud
          showTimer={showStageTimer}
          timeRemaining={timeRemaining}
          hudExtraCountdownSeconds={stage4ContractHudSeconds}
          onRestartStage={canRestartSimulatorStage ? handleRestartStage : undefined}
          restartStageBusy={restartStageLoading}
          restartStageDisabled={stageCompleteInFlight}
          onDocumentsClick={handleOpenDocuments}
          onSimugramToggle={undefined}
          simugramUnreadCount={0}
          onToggleNav={() => setPlayNavExpanded((v) => !v)}
          navExpanded={playNavExpanded}
          stackBelowHeader={playNavExpanded}
          playHeaderBottomPx={playNavExpanded && playNavHeaderBottomPx > 0 ? playNavHeaderBottomPx : null}
        />
      ) : (
        <GameplayHudWithSimugramUnread
          showTimer={showStageTimer}
          timeRemaining={timeRemaining}
          hudExtraCountdownSeconds={stage4ContractHudSeconds}
          onRestartStage={canRestartSimulatorStage ? handleRestartStage : undefined}
          restartStageBusy={restartStageLoading}
          restartStageDisabled={stageCompleteInFlight}
          onDocumentsClick={handleOpenDocuments}
          onSimugramToggle={() => setSimugramOpen((prev) => !prev)}
          onToggleNav={() => setPlayNavExpanded((v) => !v)}
          navExpanded={playNavExpanded}
          stackBelowHeader={playNavExpanded}
          playHeaderBottomPx={playNavExpanded && playNavHeaderBottomPx > 0 ? playNavHeaderBottomPx : null}
        />
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: needsFullScreen ? 'hidden' : 'auto',
            padding: needsFullScreen ? 0 : '20px 20px 0',
            ...(isStage4 ? { background: '#f5f5f5' } : {}),
          }}
        >
          {stageContent}
        </div>
        {!PLATFORM_SHELL && (
        <div
          style={{
            width: simugramOpen ? 370 : 0,
            flexShrink: 0,
            overflow: 'hidden',
            borderLeft: 'none',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            transition: 'width 0.2s ease',
            background: '#f5f5f5',
            ...(simugramOpen
              ? {
                  paddingTop: getGameplayHudClearanceTopPx(playNavExpanded),
                  boxSizing: 'border-box',
                  ...(isStage4
                    ? { paddingBottom: 60 }
                    : isStage1
                      ? {
                          /* Этап 1: совпадает с нижним inset сетки (тень карточки + «Отправить бриф»). */
                          paddingBottom: STAGE1_SIMUGRAM_COLUMN_BOTTOM_PAD_PX,
                        }
                      : isStage3
                        ? {
                            /* Этап 3: отступ снизу = блок «прогресс + завершить этап», низ композера Симуграма на уровне низа карточки договора (--simulex-stage3-progress-block-height из Stage3View). */
                            paddingBottom:
                              'var(--simulex-stage3-progress-block-height, 0px)',
                          }
                        : {}),
                }
              : {}),
          }}
        >
          <SimugramPanel
            ref={simugramRef}
            isOpen={simugramOpen}
            onToggle={() => setSimugramOpen((prev) => !prev)}
            tutorPersistUserId={currentUserId}
            sessionId={session?.id}
            caseId={actualCaseData?.id}
            currentStage={stageIndex}
            currentStageObj={enrichedStage}
            caseData={caseData}
            session={session}
            getDeadlinePlaceholderBaseDate={getDeadlinePlaceholderBaseDate}
            stage1Props={stage1ChatState}
            stage3Props={stage3ChatState}
            onAction={(action, payload) => {
              if (action === 'open-documents') {
                handleOpenDocuments();
              } else if (action === 'scroll-to') {
                const el = document.querySelector(`[data-tutor-highlight="${payload}"]`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              } else if (action === 'open-doc') {
                window.dispatchEvent(new CustomEvent('simugram:open-doc', { detail: { docId: payload } }));
              } else if (action === 'open-doc-scroll') {
                const [docId, scrollTarget] = (payload || '').split('#');
                window.dispatchEvent(new CustomEvent('simugram:open-doc', { detail: { docId, scrollTarget } }));
              }
            }}
          />
        </div>
        )}
      </div>
      <DocumentsModal
        isOpen={showDocsModal}
        onClose={() => setShowDocsModal(false)}
        docs={documentsModalDocsMerged}
        loading={caseDocsLoading}
        error={caseDocsError}
      />
      {tourPhase === 'welcome' && shouldShowSimulatorIntro(caseData) && (
        <SimulatorWelcomeOverlay
          key={`sim-welcome-${session?.id ?? 'nosess'}`}
          introConfig={simulatorIntroConfig}
          comicPanels={introComicPanels}
          persistenceSessionId={session?.id}
          persistenceCaseId={session?.case_id}
          onContinue={finishIntroAndEnterPlaying}
          onSkip={finishIntroAndEnterPlaying}
          onSetSkipNextLaunch={setSkipCaseTourFlag}
        />
      )}
      {tourPhase === 'steps' && tourSteps.length > 0 && (
        <SimulatorTourOverlay
          step={tourSteps[tourStepIndex]}
          stepIndex={tourStepIndex}
          totalSteps={tourSteps.length}
          canBack={tourStepIndex > 0}
          isLast={tourStepIndex >= tourSteps.length - 1}
          onBack={() => setTourStepIndex((i) => Math.max(0, i - 1))}
          onNext={handleSimulatorTourNext}
          onSkip={handleSimulatorTourSkip}
        />
      )}
      {stageEnterWelcome && tourPhase !== 'welcome' && (
        <StageEnterWelcomeOverlay
          key={`${session?.id}-${stageEnterWelcome.heading}`}
          heading={stageEnterWelcome.heading}
          theme={stageEnterWelcome.theme}
          onComplete={handleStageEnterBannerComplete}
        />
      )}
    </div>
    </SimugramProvider>
  );
}
