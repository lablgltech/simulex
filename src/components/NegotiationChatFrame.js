import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { chatAPI } from '../api/negotiationApi';

/** Поле 1 → explanationText; поле 2 → formulationText (бэкенд). */
const EXPLANATION_PROPOSAL_PLACEHOLDER =
  'Предлагаем изложить в новой редакции, поскольку...';

/** Стартовый текст в поле «Ваша предлагаемая редакция»; при отправке без правок не считается редакцией. */
const REVISION_DEFAULT_PROMPT = 'Введите текст новой редакции пункта';

function revisionLooksUnset(raw) {
  const t = (raw || '').trim();
  // Раньше подсказка была значением поля; поддерживаем для старых сессий.
  return t === '' || t === REVISION_DEFAULT_PROMPT;
}

/** Сообщения по пункту из history_json.chat_history_by_clause (ключи id / number / clause-n). */
function pickClauseHistoryEntries(rawHistory, clauseId, selectedClause) {
  const by = rawHistory?.chat_history_by_clause || {};
  const keysToTry = [];
  const cid = String(clauseId || '').trim();
  if (cid) keysToTry.push(cid);
  if (selectedClause?.id) keysToTry.push(String(selectedClause.id));
  if (selectedClause?.number != null) {
    keysToTry.push(String(selectedClause.number));
    const n = String(selectedClause.number).replace(/^clause-/, '');
    if (n) keysToTry.push(`clause-${n}`);
  }
  for (const k of keysToTry) {
    const arr = by[k];
    if (Array.isArray(arr) && arr.length) {
      return [...arr].sort((a, b) =>
        String(a?.timestamp || '').localeCompare(String(b?.timestamp || ''))
      );
    }
  }
  if (cid) {
    for (const [k, arr] of Object.entries(by)) {
      if (!Array.isArray(arr) || !arr.length) continue;
      if (k === cid || String(k).startsWith(`${cid}_`)) {
        return [...arr].sort((a, b) =>
          String(a?.timestamp || '').localeCompare(String(b?.timestamp || ''))
        );
      }
    }
  }
  return [];
}

function negotiationServerMsgToUi(m, nowTimeFn) {
  const ts = m?.timestamp || m?.time;
  let timeStr = '';
  if (ts) {
    try {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) {
        timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } catch {
      timeStr = '';
    }
  }
  const own = m?.owner === 'player' || m?.owner === 'user' ? 'player' : 'bot';
  const text = (m?.text || m?.message || '').trim();
  return {
    ...m,
    text,
    owner: own,
    time: timeStr || nowTimeFn(),
  };
}

export default function NegotiationChatFrame({
  negotiationSessionId,
  clauseId,
  action,
  onClose,
  onStatusUpdate,
  onChatComplete,
  onClauseAgreed,
  isActive,
  selectedClause,
  onAccept,
  onPropose,
  aiModeEnabled = true,
  onTutorEvent,
  onPatienceChange,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [chatData, setChatData] = useState(null);
  const [messages, setMessages] = useState([]);
  const [currentStep, setCurrentStep] = useState(
    isActive && !action ? 'selectAction' : 'activate'
  );
  const [currentAction, setCurrentAction] = useState(action);
  const [requiresJustification, setRequiresJustification] = useState(false);
  const [playerExplanationProposalInput, setPlayerExplanationProposalInput] = useState('');
  const [playerRevisionInput, setPlayerRevisionInput] = useState('');
  const [savedReasonIndex, setSavedReasonIndex] = useState(null);
  const [savedChoiceIndex, setSavedChoiceIndex] = useState(null);
  const [isBotTyping, setIsBotTyping] = useState(false);
  const [lawyerName, setLawyerName] = useState('Юрист Иван Кузнецов');
  const [lawyerCompany, setLawyerCompany] = useState('из ООО «1С Консалтинг»');
  const [showActionButtons, setShowActionButtons] = useState(!action && isActive);
  const [selectedOption, setSelectedOption] = useState(null);
  const messagesEndRef = useRef(null);
  const revisionTextareaRef = useRef(null);
  const [patience, setPatience] = useState(100);
  const [patienceEmoji, setPatienceEmoji] = useState('');
  const [showPatienceEmoji, setShowPatienceEmoji] = useState(false);
  const [chatFinished, setChatFinished] = useState(false);
  const [closeAgreed, setCloseAgreed] = useState(false);
  const [outcomeType, setOutcomeType] = useState(null);
  const lastPatienceRef = useRef(100);

  // Типы результатов переговоров (соответствуют OutcomeType в backend)
  const OUTCOME_TYPES = {
    PENDING: 'pending',
    ACCEPTED_PLAYER_CHANGE: 'accepted_changed',
    CLAUSE_EXCLUDED: 'clause_excluded',
    ACCEPTED_COUNTERPARTY: 'accepted_counterparty',
    KEPT_ORIGINAL: 'kept_original',
    CLOSED_NO_AGREEMENT: 'closed_no_agreement',
    ESCALATED: 'escalated',
  };

  // Сообщения и стили для разных типов результатов
  const OUTCOME_CONFIG = {
    [OUTCOME_TYPES.ACCEPTED_PLAYER_CHANGE]: {
      message: 'Пункт согласован. Ваша редакция принята.',
      backgroundColor: '#d1fae5',
      color: '#065f46',
    },
    [OUTCOME_TYPES.CLAUSE_EXCLUDED]: {
      message: 'Пункт исключён из договора по соглашению сторон.',
      backgroundColor: '#d1fae5',
      color: '#065f46',
    },
    [OUTCOME_TYPES.ACCEPTED_COUNTERPARTY]: {
      message: 'Пункт остается в редакции контрагента',
      backgroundColor: '#fde8e8',
      color: '#9f1239',
    },
    [OUTCOME_TYPES.KEPT_ORIGINAL]: {
      message: 'Пункт оставлен без изменений.',
      backgroundColor: '#e5e7eb',
      color: '#374151',
    },
    [OUTCOME_TYPES.CLOSED_NO_AGREEMENT]: {
      message:
        'Терпение контрагента закончилось.\nПункт остается в редакции контрагента.',
      backgroundColor: '#fef3c7',
      color: '#92400e',
    },
    [OUTCOME_TYPES.ESCALATED]: {
      message: 'Пункт требует эскалации.',
      backgroundColor: '#fee2e2',
      color: '#991b1b',
    },
  };
  const emojiTimeoutRef = useRef(null);

  const historyKey = `simcon:chat:${negotiationSessionId}:${clauseId}`;

  const nowTime = () =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const scrollToBottom = useCallback(() => {
    if (messagesEndRef.current) {
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({
              behavior: 'smooth',
              block: 'end',
            });
          }
        }, 50);
      });
    }
  }, []);

  // Обновление терпения с выбором смайлика в зависимости от падения
  const applyPatienceUpdate = useCallback((value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return;
    }
    const clamped = Math.max(0, Math.min(100, value));
    const prev = lastPatienceRef.current;
    lastPatienceRef.current = clamped;
    setPatience(clamped);

    const drop = prev - clamped;
    if (drop <= 0) {
      return;
    }

    let emoji = '🙂';
    if (drop > 20) {
      emoji = '😡';
    } else if (drop > 10) {
      emoji = '😠';
    }

    setPatienceEmoji(emoji);
    setShowPatienceEmoji(true);

    if (emojiTimeoutRef.current) {
      clearTimeout(emojiTimeoutRef.current);
    }
    emojiTimeoutRef.current = setTimeout(() => {
      setShowPatienceEmoji(false);
    }, 900);
  }, []);

  useEffect(() => {
    if (onPatienceChange) onPatienceChange(patience);
  }, [patience, onPatienceChange]);

  /** Число терпения из ответа API (корень или botResponse; строки из JSON тоже). */
  const pickPatienceFromResponse = useCallback((data) => {
    if (!data || typeof data !== 'object') return null;
    const raw = data.patience ?? data.botResponse?.patience;
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }, []);

  /** Терпение из history_json.patience (после F5) — ключи id и/или номер пункта. */
  const pickPatienceFromHistoryMap = useCallback((patienceMap, cid, clause) => {
    if (!patienceMap || typeof patienceMap !== 'object') return null;
    const keys = [];
    if (cid != null && String(cid).trim()) keys.push(String(cid).trim(), cid);
    if (clause?.id != null && String(clause.id).trim()) {
      keys.push(String(clause.id).trim(), clause.id);
    }
    if (clause?.number != null && String(clause.number).trim()) {
      keys.push(String(clause.number).trim());
    }
    const seen = new Set();
    for (const k of keys) {
      if (k == null || k === '' || seen.has(k)) continue;
      seen.add(k);
      const raw = patienceMap[k];
      if (raw == null || raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }, []);

  /** Синхронизация текста пункта в документе: замена, исключение или сброс оверлея (ред. контрагента). */
  const shouldSyncClauseDocument = useCallback((data) => {
    if (!data || typeof data !== 'object') return false;
    const hasRepl =
      data.replacementText != null && String(data.replacementText).trim();
    if (hasRepl || data.clauseExcluded) return true;
    const outcome = data.outcomeType || data.botResponse?.outcomeType;
    return !!(
      data.chatComplete &&
      (outcome === OUTCOME_TYPES.ACCEPTED_COUNTERPARTY ||
        outcome === OUTCOME_TYPES.KEPT_ORIGINAL ||
        outcome === OUTCOME_TYPES.CLOSED_NO_AGREEMENT)
    );
  }, []);

  useEffect(() => {
    return () => {
      if (emojiTimeoutRef.current) {
        clearTimeout(emojiTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (messages.length > 0 || isBotTyping) {
      scrollToBottom();
    }
  }, [messages.length, isBotTyping, scrollToBottom]);

  const loadStoredMessages = useCallback(() => {
    try {
      const raw = sessionStorage.getItem(historyKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setMessages(parsed);
        }
      }
    } catch {
      /* ignore */
    }
  }, [historyKey]);

  const persistMessages = useCallback(
    (msgs) => {
      try {
        sessionStorage.setItem(historyKey, JSON.stringify(msgs));
      } catch {
        /* ignore */
      }
    },
    [historyKey]
  );

  useEffect(() => {
    if (action) {
      setCurrentAction(action);
    } else if (!action && isActive) {
      setCurrentAction(null);
    }
  }, [action, isActive]);

  /**
   * Смена пункта / сессии: подтягиваем историю с сервера (chat_history_by_clause), синхронизируем sessionStorage,
   * затем activate('discuss') для опций и терпения. Режим history — только локальный снимок + мета с сервера.
   * Для change/reject/insist с панели документа автозапуск здесь не выполняется (ветка action).
   */
  useEffect(() => {
    if (!clauseId) {
      setMessages([]);
      setChatData(null);
      setError(null);
      setCurrentAction(null);
      setCurrentStep(null);
      setRequiresJustification(false);
      setPlayerExplanationProposalInput('');
      setPlayerRevisionInput('');
      setSavedReasonIndex(null);
      setSavedChoiceIndex(null);
      setIsBotTyping(false);
      setPatience(100);
      lastPatienceRef.current = 100;
      setShowPatienceEmoji(false);
      setChatFinished(false);
      setCloseAgreed(false);
      setOutcomeType(null);
      return undefined;
    }

    if (!negotiationSessionId) return undefined;

    if (action === 'history') {
      setShowActionButtons(false);
      setCurrentStep(null);
      setChatData(null);
      loadStoredMessages();
      chatAPI
        .getHistory(negotiationSessionId)
        .then((data) => {
          if (data.lawyer_name) setLawyerName(data.lawyer_name);
          if (data.lawyer_company) setLawyerCompany(data.lawyer_company);
          const ph = pickPatienceFromHistoryMap(data?.patience, clauseId, selectedClause);
          if (ph != null) applyPatienceUpdate(ph);
        })
        .catch(() => {});
      return undefined;
    }

    if (!isActive) return undefined;

    if (action && action !== 'discuss') {
      return undefined;
    }

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      setRequiresJustification(false);
      setPlayerExplanationProposalInput('');
      setPlayerRevisionInput('');
      setSavedReasonIndex(null);
      setSavedChoiceIndex(null);
      setIsBotTyping(false);
      setShowPatienceEmoji(false);
      setChatFinished(false);
      setCloseAgreed(false);
      setOutcomeType(null);
      setMessages([]);
      setChatData(null);
      setCurrentAction(null);
      setCurrentStep(null);

      try {
        let fullHist = null;
        try {
          fullHist = await chatAPI.getHistory(negotiationSessionId);
        } catch (_) {
          fullHist = null;
        }
        if (cancelled) return;
        if (fullHist?.lawyer_name) setLawyerName(fullHist.lawyer_name);
        if (fullHist?.lawyer_company) setLawyerCompany(fullHist.lawyer_company);

        const rawList = pickClauseHistoryEntries(fullHist, clauseId, selectedClause);
        const restored = rawList.map((m) => negotiationServerMsgToUi(m, nowTime));

        const data = await chatAPI.activate(negotiationSessionId, clauseId, 'discuss');
        if (cancelled) return;
        setChatData(data);
        if (data.lawyerName) setLawyerName(data.lawyerName);
        if (data.lawyerCompany) setLawyerCompany(data.lawyerCompany);

        const fromHist = pickPatienceFromHistoryMap(fullHist?.patience, clauseId, selectedClause);
        const fromActivate = pickPatienceFromResponse(data);
        const pResolved =
          fromHist != null
            ? fromHist
            : fromActivate != null
              ? fromActivate
              : typeof data.maxPatience === 'number'
                ? data.maxPatience
                : null;
        if (pResolved != null) applyPatienceUpdate(pResolved);

        const terminalBoot = data.chatComplete === true || data.clauseTerminal === true;

        if (restored.length > 0) {
          setMessages(restored);
          persistMessages(restored);
          setShowActionButtons(false);
          if (terminalBoot) {
            setChatFinished(true);
            setRequiresJustification(false);
            setCurrentStep(null);
          } else if (aiModeEnabled) {
            // Повторный activate('change') не нужен, если уже есть реплика игрока (в т.ч. старый шаблон из истории).
            const alreadyKicked = restored.some(
              (m) => m.owner === 'player' && String(m.text || '').trim()
            );
            if (alreadyKicked) {
              setCurrentAction('change');
              setRequiresJustification(true);
              setCurrentStep('aiFreeForm');
            } else {
              const changeData = await chatAPI.activate(negotiationSessionId, clauseId, 'change');
              if (cancelled) return;
              setChatData(changeData);
              setCurrentAction('change');
              setRequiresJustification(true);
              setCurrentStep('aiFreeForm');
              const pCh = pickPatienceFromResponse(changeData);
              const fromHistCh = pickPatienceFromHistoryMap(
                fullHist?.patience,
                clauseId,
                selectedClause
              );
              if (fromHistCh != null) applyPatienceUpdate(fromHistCh);
              else if (pCh != null) applyPatienceUpdate(pCh);
            }
          } else {
            setCurrentStep('selectDiscussionOption');
          }
        } else {
          const initial = [];
          if (!aiModeEnabled) {
            const counterpartObjection =
              selectedClause?.counterpartObjection ||
              selectedClause?.counterpartReasoning ||
              selectedClause?.guide_summary ||
              '';
            const botSuggested =
              selectedClause?.botSuggested || selectedClause?.botSuggestedText || '';
            if (counterpartObjection || botSuggested) {
              let text = counterpartObjection || '';
              if (botSuggested) {
                text += (text ? '\n\n' : '') + `Предлагаемая формулировка: ${botSuggested}`;
              }
              initial.push({ owner: 'bot', text, time: nowTime() });
            }
          }
          setMessages(initial);
          persistMessages(initial);
          if (terminalBoot) {
            setChatFinished(true);
            setRequiresJustification(false);
            setCurrentStep(null);
          } else if (aiModeEnabled) {
            const changeData = await chatAPI.activate(negotiationSessionId, clauseId, 'change');
            if (cancelled) return;
            setChatData(changeData);
            setCurrentAction('change');
            setRequiresJustification(true);
            setCurrentStep('aiFreeForm');
            const pCh = pickPatienceFromResponse(changeData);
            const fromHistCh = pickPatienceFromHistoryMap(
              fullHist?.patience,
              clauseId,
              selectedClause
            );
            if (fromHistCh != null) applyPatienceUpdate(fromHistCh);
            else if (pCh != null) applyPatienceUpdate(pCh);
          } else {
            setCurrentStep('selectDiscussionOption');
          }
          setShowActionButtons(false);
        }
      } catch (err) {
        setError(
          'Ошибка загрузки переговоров: ' +
            (err?.detail || err?.error || err?.message || 'Неизвестная ошибка')
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    clauseId,
    negotiationSessionId,
    isActive,
    action,
    aiModeEnabled,
    selectedClause?.id,
    selectedClause?.number,
    historyKey,
    loadStoredMessages,
    persistMessages,
    applyPatienceUpdate,
    pickPatienceFromResponse,
    pickPatienceFromHistoryMap,
  ]);

  const getAvailableOptions = () => {
    if (!chatData?.options) return [];
    const actionToUse = currentAction || action;
    if (actionToUse === 'reject' || actionToUse === 'insist') {
      const reasons = chatData.options.reasons || [];
      return reasons
        .map((r) => (typeof r === 'object' ? r.text : r) || '')
        .filter(Boolean);
    }
    if (actionToUse === 'change') {
      if (currentStep === 'selectFormulation') {
        const formulations = chatData.options.formulations?.[selectedOption] || [];
        return formulations
          .map((f) => (typeof f === 'object' ? f.text : f) || '')
          .filter(Boolean);
      }
      const reasons = chatData.options.reasons || [];
      return reasons
        .map((r) => (typeof r === 'object' ? r.text : r) || '')
        .filter(Boolean);
    }
    return [];
  };

  const getMessageText = (index, isReason = false) => {
    if (!chatData?.options) return '';
    const actionToUse = currentAction || action;
    if (actionToUse === 'reject' || actionToUse === 'insist') {
      const reasons = chatData.options.reasons || [];
      const reason = reasons[index];
      const text = typeof reason === 'object' ? reason.text : reason;
      return `Причина: ${text || ''}`;
    }
    if (actionToUse === 'change') {
      if (isReason || currentStep === 'selectReason') {
        const reasons = chatData.options.reasons || [];
        const reason = reasons[index];
        const text = typeof reason === 'object' ? reason.text : reason;
        return `Причина: ${text || ''}`;
      }
      const formulations = chatData.options.formulations?.[selectedOption] || [];
      const formulation = formulations[index];
      const text = typeof formulation === 'object' ? formulation.text : formulation;
      return `Предлагаемый вариант: ${text || ''}`;
    }
    return '';
  };

  const handleDiscussionOptionSelect = async (discussionAction) => {
    try {
      setLoading(true);
      setError(null);
      const data = await chatAPI.activate(
        negotiationSessionId,
        clauseId,
        discussionAction
      );
      setChatData(data);
      if (data.lawyerName) setLawyerName(data.lawyerName);
      if (data.lawyerCompany) setLawyerCompany(data.lawyerCompany);

      setShowActionButtons(false);
      // В простом режиме продолжаем старую механику выбора причины/формулировки,
      // в ИИ‑режиме сразу переходим к свободному вводу + оправданию.
      if (aiModeEnabled) {
        setCurrentAction(discussionAction);
        setRequiresJustification(true);
        setCurrentStep('aiFreeForm');
        // Для "Предложить изменения" — оставляем поле пустым, пользователь вводит свою формулировку.
        // Для "Настоять на своей редакции" — подставляем текущий текст (мы на нём настаиваем).
        const baseText =
          selectedClause?.replacementText ||
          selectedClause?.text ||
          selectedClause?.botSuggested ||
          selectedClause?.botSuggestedText ||
          '';
        setPlayerRevisionInput(discussionAction === 'insist' ? baseText : '');
      } else {
        const newStep = 'selectReason';
        setCurrentStep(newStep);
        setCurrentAction(discussionAction);
      }
      const playerText = (data.playerMessage && String(data.playerMessage).trim()) || '';
      if (playerText) {
        setMessages((prev) => {
          const next = [...prev, { text: playerText, owner: 'player', time: nowTime() }];
          persistMessages(next);
          return next;
        });
      }
      {
        const pDisc = pickPatienceFromResponse(data);
        if (pDisc != null) applyPatienceUpdate(pDisc);
      }
      if (onPropose) {
        onPropose(discussionAction);
      }
    } catch (err) {
      const msg =
        err?.detail || err?.error || err?.message || 'Не удалось загрузить опции';
      setError('Ошибка: ' + msg);
      setShowActionButtons(true);
      setCurrentStep('selectAction');
      setChatData(null);
      setCurrentAction(null);
    } finally {
      setLoading(false);
    }
  };

  const handleOptionSelect = async (index) => {
    const actionToUse = currentAction || action;
    try {
      setLoading(true);
      if (actionToUse === 'change') {
        if (currentStep === 'selectReason') {
          setSelectedOption(index);
          const reasonText = getMessageText(index, true);
          setMessages((prev) => [
            ...prev,
            { text: reasonText, owner: 'player', time: nowTime() },
          ]);
          setCurrentStep('selectFormulation');
          setLoading(false);
          return;
        }
        if (currentStep === 'selectFormulation') {
          const messageData = {
            action: actionToUse,
            reasonIndex: selectedOption,
            choiceIndex: index,
          };
          setIsBotTyping(true);
          const data = await chatAPI.sendMessage(
            negotiationSessionId,
            clauseId,
            messageData
          );
          setIsBotTyping(false);
          const botMsg = {
            text: data.botResponse.message,
            owner: 'bot',
            time: nowTime(),
          };
          if (data.botResponse.convincingScore !== undefined) {
            botMsg.convincingScore = data.botResponse.convincingScore;
          }
          const playerText = getMessageText(index);
          setMessages((prev) => {
            const next = [
              ...prev,
              { text: playerText, owner: 'player', time: nowTime() },
              botMsg,
            ];
            persistMessages(next);
            return next;
          });
          if (typeof onTutorEvent === 'function') {
            onTutorEvent('stage_chat_message', { text: playerText });
          }
          {
            const pForm = pickPatienceFromResponse(data);
            if (pForm != null) applyPatienceUpdate(pForm);
          }
          if (data.botResponse?.requiresJustification) {
            setSavedReasonIndex(selectedOption);
            setSavedChoiceIndex(index);
            setRequiresJustification(true);
            setCurrentStep('justification');
            setLoading(false);
            return;
          }
          if (data.chatComplete) {
            if (onChatComplete) onChatComplete();
            if (onStatusUpdate) onStatusUpdate();
            if (onClauseAgreed && clauseId && shouldSyncClauseDocument(data)) {
              onClauseAgreed(clauseId, data.replacementText || '', {
                clauseExcluded: !!data.clauseExcluded,
              });
            }
            setCurrentStep(null);
            const outcomeForm = data.outcomeType || data.botResponse?.outcomeType;
            if (outcomeForm) {
              setOutcomeType(outcomeForm);
              setCloseAgreed(
                outcomeForm === OUTCOME_TYPES.ACCEPTED_PLAYER_CHANGE ||
                outcomeForm === OUTCOME_TYPES.CLAUSE_EXCLUDED ||
                outcomeForm === OUTCOME_TYPES.ACCEPTED_COUNTERPARTY ||
                outcomeForm === OUTCOME_TYPES.KEPT_ORIGINAL
              );
            } else {
              setCloseAgreed(!!(data.replacementText || data.clauseExcluded || data.botResponse?.agrees));
            }
            setChatFinished(true);
          }
          setLoading(false);
          return;
        }
      }

      if (actionToUse === 'reject' || actionToUse === 'insist') {
        setIsBotTyping(true);
        const messageData = { action: actionToUse, reasonIndex: index };
        const data = await chatAPI.sendMessage(
          negotiationSessionId,
          clauseId,
          messageData
        );
        setIsBotTyping(false);
        const botMsg = {
          text: data.botResponse.message,
          owner: 'bot',
          time: nowTime(),
        };
        if (data.botResponse.convincingScore !== undefined) {
          botMsg.convincingScore = data.botResponse.convincingScore;
        }
        const playerTextReject = getMessageText(index);
        setMessages((prev) => {
          const next = [
            ...prev,
            { text: playerTextReject, owner: 'player', time: nowTime() },
            botMsg,
          ];
          persistMessages(next);
          return next;
        });
        if (typeof onTutorEvent === 'function') {
          onTutorEvent('stage_chat_message', { text: playerTextReject });
        }
        {
          const pRej = pickPatienceFromResponse(data);
          if (pRej != null) applyPatienceUpdate(pRej);
        }

        if (data.botResponse?.requiresJustification) {
          setSavedReasonIndex(index);
          setSavedChoiceIndex(null);
          setRequiresJustification(true);
          setCurrentStep('justification');
          setLoading(false);
          return;
        }
        if (data.chatComplete) {
          if (onChatComplete) onChatComplete();
          if (onStatusUpdate) onStatusUpdate();
          if (onClauseAgreed && clauseId && shouldSyncClauseDocument(data)) {
            onClauseAgreed(clauseId, data.replacementText || '', {
              clauseExcluded: !!data.clauseExcluded,
            });
          }
          // Используем явный outcomeType из API, если есть
          const outcome = data.outcomeType || data.botResponse?.outcomeType;
          if (outcome) {
            setOutcomeType(outcome);
            setCloseAgreed(
              outcome === OUTCOME_TYPES.ACCEPTED_PLAYER_CHANGE ||
              outcome === OUTCOME_TYPES.CLAUSE_EXCLUDED ||
              outcome === OUTCOME_TYPES.ACCEPTED_COUNTERPARTY ||
              outcome === OUTCOME_TYPES.KEPT_ORIGINAL
            );
          } else {
            // Fallback на старую логику
            setCloseAgreed(!!(data.replacementText || data.botResponse?.agrees));
          }
          setCurrentStep(null);
          setChatFinished(true);
        }
      }
    } catch (err) {
      setError(
        'Ошибка отправки сообщения: ' +
          (err?.error || err?.message || 'Неизвестная ошибка')
      );
      setIsBotTyping(false);
    } finally {
      setLoading(false);
    }
  };

  const handleJustificationSubmit = async () => {
    const rawRevision = (playerRevisionInput || '').trim();
    const revision = revisionLooksUnset(playerRevisionInput) ? '' : rawRevision;
    const explanation = (playerExplanationProposalInput || '').trim();
    if (!revision && !explanation) {
      setError(
        'Заполните «Ваше пояснение и предложение» и/или новую редакцию пункта'
      );
      return;
    }
    let playerMessage;
    if (revision && explanation) {
      playerMessage = `${explanation}\n\nВаша предлагаемая редакция «${revision}»`;
    } else if (revision) {
      playerMessage = `Ваша предлагаемая редакция «${revision}»`;
    } else {
      playerMessage = explanation;
    }

    const actionToUse = currentAction || action;
    const messageData = {
      action: actionToUse,
      reasonIndex: savedReasonIndex ?? undefined,
      choiceIndex:
        actionToUse === 'change' && savedChoiceIndex !== null
          ? savedChoiceIndex
          : undefined,
      formulationText: revision || undefined,
      explanationText: explanation || undefined,
    };

    const optimisticPlayer = {
      text: playerMessage,
      owner: 'player',
      time: nowTime(),
    };

    try {
      setLoading(true);
      setError(null);
      setMessages((prev) => {
        const next = [...prev, optimisticPlayer];
        persistMessages(next);
        return next;
      });

      setIsBotTyping(true);
      const data = await chatAPI.sendMessage(
        negotiationSessionId,
        clauseId,
        messageData
      );
      setIsBotTyping(false);

      const botMsg = {
        text: data.botResponse.message,
        owner: 'bot',
        time: nowTime(),
      };
      if (data.botResponse.convincingScore !== undefined) {
        botMsg.convincingScore = data.botResponse.convincingScore;
      }
      setMessages((prev) => {
        const next = [...prev, botMsg];
        persistMessages(next);
        return next;
      });
      if (typeof onTutorEvent === 'function') {
        onTutorEvent('stage_chat_message', { text: playerMessage.slice(0, 500) });
      }
      {
        const pJust = pickPatienceFromResponse(data);
        if (pJust != null) applyPatienceUpdate(pJust);
      }

      const isComplete =
        data.chatComplete ||
        !!data.clauseExcluded ||
        data.botResponse?.agrees === true ||
        (!aiModeEnabled && data.botResponse?.agrees !== undefined);

      if (isComplete) {
        if (onChatComplete) onChatComplete();
        if (onStatusUpdate) onStatusUpdate();
        const outcomeJust = data.outcomeType || data.botResponse?.outcomeType;
        let replForDoc =
          data.replacementText != null && String(data.replacementText).trim()
            ? String(data.replacementText).trim()
            : '';
        if (
          !replForDoc &&
          !data.clauseExcluded &&
          outcomeJust === OUTCOME_TYPES.ACCEPTED_PLAYER_CHANGE &&
          rawRevision &&
          rawRevision.trim().length >= 3 &&
          !revisionLooksUnset(playerRevisionInput)
        ) {
          replForDoc = rawRevision.trim();
        }
        const syncDoc =
          !!replForDoc ||
          !!data.clauseExcluded ||
          (data.chatComplete &&
            (outcomeJust === OUTCOME_TYPES.ACCEPTED_COUNTERPARTY ||
              outcomeJust === OUTCOME_TYPES.KEPT_ORIGINAL ||
              outcomeJust === OUTCOME_TYPES.CLOSED_NO_AGREEMENT));
        if (onClauseAgreed && clauseId && syncDoc) {
          onClauseAgreed(clauseId, replForDoc, {
            clauseExcluded: !!data.clauseExcluded,
          });
        }
        const outcome = outcomeJust;
        if (outcome) {
          setOutcomeType(outcome);
          setCloseAgreed(
            outcome === OUTCOME_TYPES.ACCEPTED_PLAYER_CHANGE ||
            outcome === OUTCOME_TYPES.CLAUSE_EXCLUDED ||
            outcome === OUTCOME_TYPES.ACCEPTED_COUNTERPARTY ||
            outcome === OUTCOME_TYPES.KEPT_ORIGINAL
          );
        } else {
          setCloseAgreed(!!(data.replacementText || data.clauseExcluded || data.botResponse?.agrees));
        }
        setRequiresJustification(false);
        setPlayerExplanationProposalInput('');
        setPlayerRevisionInput('');
        setSavedReasonIndex(null);
        setSavedChoiceIndex(null);
        setCurrentStep(null);
        setChatFinished(true);
      } else {
        // Пояснение сбрасываем после хода; текст новой редакции оставляем до смены игроком или конца переговоров по пункту.
        setPlayerExplanationProposalInput('');
        if (aiModeEnabled) {
          setCurrentStep('aiFreeForm');
          setRequiresJustification(true);
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.owner === 'player' &&
          last.text === playerMessage
        ) {
          const next = prev.slice(0, -1);
          persistMessages(next);
          return next;
        }
        return prev;
      });
      setError(
        'Ошибка отправки обоснования: ' +
          (err?.error || err?.message || 'Неизвестная ошибка')
      );
      setIsBotTyping(false);
    } finally {
      setLoading(false);
    }
  };

  const canSendJustification =
    !!playerExplanationProposalInput.trim() ||
    (!!playerRevisionInput.trim() && !revisionLooksUnset(playerRevisionInput));

  const handleComposerTextareaKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!loading && canSendJustification) {
        handleJustificationSubmit();
      }
    }
  };

  const handleRevisionInputKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!loading && canSendJustification) {
        handleJustificationSubmit();
      }
    }
  };

  const adjustRevisionTextareaHeight = useCallback(() => {
    const el = revisionTextareaRef.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const maxH = parseFloat(cs.maxHeight);
    const cap = Number.isFinite(maxH) && maxH > 0 ? maxH : 448;
    el.style.height = 'auto';
    const minH = 44;
    const sh = el.scrollHeight;
    el.style.height = `${Math.min(Math.max(minH, sh), cap)}px`;
  }, []);

  useLayoutEffect(() => {
    adjustRevisionTextareaHeight();
  }, [
    playerRevisionInput,
    currentStep,
    aiModeEnabled,
    requiresJustification,
    adjustRevisionTextareaHeight,
  ]);

  if (!isActive || !selectedClause) {
    return (
      <div className="chat-frame card">
        <div
          className="chat-messages"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            color: '#6b7280',
            fontSize: '14px',
            lineHeight: '1.6',
            background: '#ebeae6',
          }}
        >
          <div>
            <p style={{ margin: 0 }}>
              Здесь появится чат с контрагентом. Начни переговоры, кликнув на один из выделенных пунктов договора
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-frame card">
      <div className="chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div className="lawyer-avatar">
            <img
              src={`${process.env.PUBLIC_URL || ''}/images/ivan.png`}
              alt=""
              width={52}
              height={52}
              style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover', objectPosition: 'center 20%' }}
            />
          </div>
          <div>
            <h3 style={{ margin: 0 }}>
              <span style={{ display: 'block' }}>{lawyerName}</span>
              {lawyerCompany ? <span style={{ display: 'block' }}>{lawyerCompany}</span> : null}
            </h3>
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: '#4b5563',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>Терпение контрагента:</span>
                  <div
                    style={{
                      flex: 1,
                      height: 6,
                      borderRadius: 9999,
                      background: '#e5e7eb',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.max(0, Math.min(100, patience))}%`,
                        height: '100%',
                        background:
                          patience > 60
                            ? '#10b981'
                            : patience > 30
                            ? '#fbbf24'
                            : '#ef4444',
                        transition: 'width 0.25s ease-out',
                      }}
                    />
                  </div>
                  <span>{Math.max(0, Math.min(100, patience))}</span>
                  <span
                    style={{
                      minWidth: 20,
                      textAlign: 'center',
                      opacity: showPatienceEmoji ? 1 : 0,
                      transform: showPatienceEmoji ? 'scale(1.2)' : 'scale(0.8)',
                      transition: 'opacity 0.15s ease-out, transform 0.15s ease-out',
                    }}
                  >
                    {patienceEmoji}
                  </span>
                </div>
            </div>
          </div>
        </div>
        <button className="chat-close" onClick={onClose} aria-label="Закрыть чат">
          ✕
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="chat-messages">
        {messages.length === 0 &&
          !aiModeEnabled &&
          (selectedClause?.counterpartObjection ||
            selectedClause?.counterpartReasoning ||
            selectedClause?.botSuggested ||
            selectedClause?.botSuggestedText) && (
            <div className="message message-bot">
              <div className="message-bubble">
                <div className="message-text">
                  {selectedClause?.counterpartObjection ||
                  selectedClause?.counterpartReasoning ? (
                    <>
                      <div style={{ marginBottom: '12px' }}>
                        {selectedClause.counterpartObjection ||
                          selectedClause.counterpartReasoning}
                      </div>
                      {(selectedClause?.botSuggested ||
                        selectedClause?.botSuggestedText) && (
                        <div>
                          <strong>Предлагаемая формулировка:</strong>{' '}
                          {selectedClause.botSuggested || selectedClause.botSuggestedText}
                        </div>
                      )}
                    </>
                  ) : (selectedClause?.botSuggested ||
                      selectedClause?.botSuggestedText) ? (
                    <div>
                      <strong>Предлагаемая формулировка:</strong>{' '}
                      {selectedClause.botSuggested || selectedClause.botSuggestedText}
                    </div>
                  ) : null}
                </div>
                <div className="message-meta">{nowTime()}</div>
              </div>
            </div>
          )}

        {messages.map((msg, idx) => (
          <div key={idx} className={`message message-${msg.owner}`}>
            <div className="message-bubble">
              <div className="message-text">{msg.text}</div>
              <div className="message-meta">{msg.time || ''}</div>
            </div>
          </div>
        ))}

        {isBotTyping && (
          <div className="message message-bot">
            <div className="message-bubble typing-bubble">
              <div className="message-text bot-typing-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span>Печатает</span>
                <span className="simugram-typing-dots">
                  <span className="simugram-typing-dot" />
                  <span className="simugram-typing-dot" />
                  <span className="simugram-typing-dot" />
                </span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} style={{ height: '1px' }} />
      </div>

      {/* Нижняя панель */}
      <div className="chat-input">
        {!chatFinished &&
          currentStep &&
          currentStep !== 'complete' &&
          action !== 'history' && (
            <div className="options-list">
              {currentStep === 'selectDiscussionOption' && !aiModeEnabled ? (
                <>
                  <p className="options-label">Выберите вариант обсуждения:</p>
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
                  >
                    <button
                      className="btn btn-secondary"
                      style={{ width: '100%' }}
                      onClick={() => handleDiscussionOptionSelect('change')}
                      disabled={loading}
                    >
                      Предложить изменения
                    </button>
                    <button
                      className="btn btn-primary"
                      style={{ width: '100%' }}
                      onClick={() => handleDiscussionOptionSelect('insist')}
                      disabled={loading}
                    >
                      Настоять на своей редакции
                    </button>
                  </div>
                </>
              ) : (currentStep === 'selectReason' || currentStep === 'selectFormulation') &&
                (currentAction === 'reject' ||
                  currentAction === 'change' ||
                  currentAction === 'insist') ? (
                <>
                  <p className="options-label">
                    {currentAction === 'reject'
                      ? 'Выберите причину отклонения:'
                      : currentAction === 'insist'
                      ? 'Выберите причину для настаивания:'
                      : currentStep === 'selectFormulation'
                      ? 'Выберите вариант формулировки:'
                      : 'Выберите причину изменения:'}
                  </p>
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
                  >
                    {(() => {
                      if (!chatData || !chatData.options) {
                        return (
                          <div className="error">
                            Опции не загружены. Пункт может быть уже обработан или сессия
                            завершена.
                          </div>
                        );
                      }
                      const options = getAvailableOptions();
                      if (!options.length) {
                        return (
                          <div className="error">
                            Причины не загружены. Проверьте консоль для отладки.
                          </div>
                        );
                      }
                      return options.map((opt, idx) => (
                        <button
                          key={idx}
                          className="btn btn-secondary"
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            whiteSpace: 'normal',
                            wordWrap: 'break-word',
                          }}
                          onClick={() => handleOptionSelect(idx)}
                          disabled={loading}
                        >
                          {opt}
                        </button>
                      ));
                    })()}
                  </div>
                </>
              ) : null}
            </div>
          )}

        {((aiModeEnabled && currentStep === 'aiFreeForm') ||
          (!aiModeEnabled && currentStep === 'justification' && requiresJustification)) && (
          <div
            className="negotiation-chat-composer options-list options-list-compact"
            style={{ overflow: 'visible' }}
          >
            <span className="negotiation-input-hint">Ваше пояснение и предложение</span>
            <textarea
              value={playerExplanationProposalInput}
              onChange={(e) => setPlayerExplanationProposalInput(e.target.value)}
              onKeyDown={handleComposerTextareaKeyDown}
              placeholder={EXPLANATION_PROPOSAL_PLACEHOLDER}
              className="chat-textarea chat-textarea-negotiation-main"
              disabled={loading}
              rows={3}
            />
            <span className="negotiation-input-hint">Ваша предлагаемая редакция</span>
            <div className="negotiation-revision-inline negotiation-revision-inline--multiline">
              <div className="negotiation-revision-editor-row">
                <span className="negotiation-revision-prefix" aria-hidden={true}>
                  «
                </span>
                <textarea
                  ref={revisionTextareaRef}
                  rows={1}
                  className={`negotiation-revision-input negotiation-revision-textarea${
                    revisionLooksUnset(playerRevisionInput)
                      ? ' negotiation-revision-input--default-prompt'
                      : ''
                  }`}
                  value={playerRevisionInput}
                  onChange={(e) => setPlayerRevisionInput(e.target.value)}
                  onKeyDown={handleRevisionInputKeyDown}
                  placeholder={REVISION_DEFAULT_PROMPT}
                  disabled={loading}
                  aria-label="Текст новой редакции пункта между кавычками"
                />
              </div>
              <div className="negotiation-revision-suffix-row">
                <span className="negotiation-revision-suffix" aria-hidden={true}>
                  »
                </span>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary negotiation-send-full"
              onClick={handleJustificationSubmit}
              disabled={loading || !canSendJustification}
            >
              Отправить
            </button>
          </div>
        )}

        {chatFinished && (() => {
          // Получаем конфигурацию для текущего типа результата
          const config = outcomeType && OUTCOME_CONFIG[outcomeType]
            ? OUTCOME_CONFIG[outcomeType]
            : closeAgreed
              ? {
                  message: 'Пункт согласован. Можно перейти к следующему.',
                  backgroundColor: '#d1fae5',
                  color: '#065f46',
                }
              : {
                  message:
                    'Терпение контрагента закончилось.\nПункт остается в редакции контрагента.',
                  backgroundColor: '#e5e7eb',
                  color: '#374151',
                };
          return (
            <div
              style={{
                marginTop: 10,
                padding: '8px 10px',
                borderRadius: 6,
                backgroundColor: config.backgroundColor,
                color: config.color,
                fontSize: 12,
                textAlign: 'center',
                whiteSpace: 'pre-line',
              }}
            >
              {config.message}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

