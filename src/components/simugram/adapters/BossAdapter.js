import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSimugram, CONTACT_IDS } from '../../../context/SimugramContext';
import { applyDeadlinePlaceholders } from '../../../utils/casePlaceholders';

function getActualCase(caseData) {
  if (!caseData) return null;
  return caseData?.case || caseData;
}

/** Письма stage_enter только текущего этапа → одно сообщение в чате (вводная от Ирины Петровны). */
function buildBossIntroMessages(caseData, currentStage, baseDate) {
  const actualCase = getActualCase(caseData);
  const stages = actualCase?.stages || [];
  const stage = stages[currentStage];
  if (!stage) return [];
  const enters = (stage.emails || []).filter((e) => e.trigger === 'stage_enter');
  if (enters.length === 0) return [];
  const base = baseDate instanceof Date ? baseDate : new Date();
  const parts = enters.map((e) => {
    const subj = applyDeadlinePlaceholders(e.subject != null ? String(e.subject) : '', base);
    const bod = applyDeadlinePlaceholders(e.body || '', base);
    return subj ? `**${subj}**\n\n${bod}` : bod;
  });
  const content = parts.filter(Boolean).join('\n\n—\n\n');
  const idSuffix = enters.map((e) => e.id).join('-');
  return [
    {
      id: `boss-stage-enter-${currentStage}-${idSuffix}`,
      role: 'contact',
      type: 'text',
      content,
      time: Date.now() - (stages.length - currentStage) * 60000,
      stageIndex: currentStage,
    },
  ];
}

function stageEnterSignature(caseData, currentStage) {
  if (!caseData) return `${currentStage}:nocase`;
  const actualCase = getActualCase(caseData);
  const stage = actualCase?.stages?.[currentStage];
  const enters = (stage?.emails || []).filter((e) => e.trigger === 'stage_enter');
  return `${currentStage}:${enters.map((e) => e.id).join(',')}`;
}

export default function useBossAdapter({ caseData, currentStage, getDeadlinePlaceholderBaseDate }) {
  const [messages, setMessages] = useState([]);
  const { setLastMessage, incrementUnread } = useSimugram();
  const pollCallbacksRef = useRef({});
  const prevBossStageRef = useRef(null);

  const introSig = useMemo(
    () => stageEnterSignature(caseData, currentStage),
    [caseData, currentStage]
  );

  useEffect(() => {
    if (!caseData) return;
    const base =
      typeof getDeadlinePlaceholderBaseDate === 'function'
        ? getDeadlinePlaceholderBaseDate(currentStage + 1)
        : new Date();
    const intro = buildBossIntroMessages(caseData, currentStage, base);
    const stageChanged =
      prevBossStageRef.current !== null && prevBossStageRef.current !== currentStage;
    prevBossStageRef.current = currentStage;
    setMessages((prev) => {
      const runtime = stageChanged ? [] : prev.filter((m) => m._bossRuntime);
      return [...intro, ...runtime];
    });
    if (intro.length > 0) {
      const last = intro[intro.length - 1];
      setLastMessage(CONTACT_IDS.BOSS, last.content?.slice(0, 60), last.time);
    }
  }, [caseData, currentStage, introSig, setLastMessage, getDeadlinePlaceholderBaseDate]);

  const pushEmail = useCallback(
    (email) => {
      if (!email) return;
      const base = new Date(email.timestamp || Date.now());
      const raw = email.subject
        ? `**${email.subject}**\n\n${email.body || ''}`
        : email.body || '';
      const content = applyDeadlinePlaceholders(raw, base);
      const msg = {
        id: email.id || `boss-${Date.now()}`,
        role: 'contact',
        type: 'text',
        content,
        time: email.timestamp || Date.now(),
        _bossRuntime: true,
      };
      setMessages((prev) => [...prev, msg]);
      setLastMessage(CONTACT_IDS.BOSS, msg.content?.slice(0, 60), msg.time);
      incrementUnread(CONTACT_IDS.BOSS);
    },
    [setLastMessage, incrementUnread]
  );

  const pushPoll = useCallback(
    (poll) => {
      if (!poll) return;
      const id = poll.id || `boss-poll-${Date.now()}`;
      if (poll.onSubmit) pollCallbacksRef.current[id] = poll.onSubmit;
      const msg = {
        id,
        role: 'contact',
        type: 'poll',
        content: poll.question,
        time: Date.now(),
        pollOptions: poll.options,
        pollTags: poll.tags || [],
        pollSelected: [],
        pollSubmitted: false,
        pollLoading: false,
        _bossRuntime: true,
      };
      setMessages((prev) => [...prev, msg]);
      setLastMessage(CONTACT_IDS.BOSS, poll.question?.slice(0, 60), msg.time);
      incrementUnread(CONTACT_IDS.BOSS);
    },
    [setLastMessage, incrementUnread]
  );

  const togglePollOption = useCallback((pollId, option) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== pollId || m.type !== 'poll' || m.pollSubmitted) return m;
        const sel = m.pollSelected || [];
        const next = sel.includes(option) ? sel.filter((o) => o !== option) : [...sel, option];
        return { ...m, pollSelected: next };
      })
    );
  }, []);

  const submitPoll = useCallback((pollId) => {
    let selectedOptions = [];
    setMessages((prev) => {
      const msg = prev.find((m) => m.id === pollId);
      if (!msg || msg.type !== 'poll' || msg.pollSubmitted) return prev;
      selectedOptions = msg.pollSelected || [];
      return prev.map((m) =>
        m.id === pollId ? { ...m, pollSubmitted: true, pollLoading: true } : m
      );
    });
    const cb = pollCallbacksRef.current[pollId];
    if (cb) cb(selectedOptions);
  }, []);

  const markPollDone = useCallback((pollId) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === pollId ? { ...m, pollLoading: false, pollSubmitted: true } : m
      )
    );
  }, []);

  const messagesWithHandlers = useMemo(
    () =>
      messages.map((m) => {
        if (m.type !== 'poll' || m.pollSubmitted) return m;
        return {
          ...m,
          onPollToggle: (opt) => togglePollOption(m.id, opt),
          onPollSubmit: () => submitPoll(m.id),
        };
      }),
    [messages, togglePollOption, submitPoll]
  );

  return {
    messages: messagesWithHandlers,
    composerType: 'readonly',
    composerProps: {},
    headerExtra: null,
    loading: false,
    pushEmail,
    pushPoll,
    markPollDone,
    renderMessageContent: null,
    onSaveAsNote: null,
    onDocumentClick: null,
    onActionButton: null,
  };
}
