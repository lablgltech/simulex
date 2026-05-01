import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useSimugram, CONTACT_IDS } from '../../../context/SimugramContext';

export default function usePMAdapter({
  isOpen,
  activeContact,
  chatHistory,
  pendingQuestion,
  onSendQuestion,
  onSaveInsight,
  onDocumentClick,
  initiatorPatience,
  loading: externalLoading,
  stageComplete,
  /** id сессии симуляции — чтобы не задвоить непрочитанное приветствие в Strict Mode */
  stageSessionId = null,
}) {
  const { setLastMessage, incrementUnreadBy } = useSimugram();
  /** Панель открыта и открыт именно этот чат — иначе (панель закрыта или другой контакт) входящие считаем непрочитанными */
  const isViewingThisChat = isOpen && activeContact === CONTACT_IDS.PM;
  const prevLenRef = useRef(0);
  /** Сессия, для которой уже засчитали непрочитанное приветствие Михаила */
  const pmOpeningUnreadMarkedForRef = useRef(null);
  const [cachedMessages, setCachedMessages] = useState([]);

  useEffect(() => {
    pmOpeningUnreadMarkedForRef.current = null;
  }, [stageSessionId]);

  const freshMessages = useMemo(() => {
    if (!chatHistory) return null;
    const msgs = [];
    chatHistory.forEach((entry, idx) => {
      const hasQuestion = entry.question != null && String(entry.question).trim().length > 0;
      if (hasQuestion) {
        msgs.push({
          id: `pm-q-${idx}`,
          role: 'user',
          type: 'text',
          content: entry.question,
          time: entry.questionTime || null,
        });
      }
      if (entry.bot_response) {
        msgs.push({
          id: `pm-a-${idx}`,
          role: 'contact',
          type: 'text',
          content: entry.bot_response,
          time: entry.responseTime || null,
          noteSaved: entry.insightSaved || false,
          _chatIndex: idx,
        });
      }
      if (entry.documentAttachedId) {
        msgs.push({
          id: `pm-d-${idx}`,
          role: 'contact',
          type: 'document',
          documentId: entry.documentAttachedId,
          documentTitle: entry.documentAttachedTitle || entry.documentAttachedId,
          time: entry.responseTime || null,
        });
      }
    });
    return msgs;
  }, [chatHistory]);

  useEffect(() => {
    if (freshMessages && freshMessages.length > 0) {
      setCachedMessages(freshMessages);
    }
  }, [freshMessages]);

  const baseMessages = freshMessages || cachedMessages;

  const messages = useMemo(() => {
    if (!pendingQuestion) return baseMessages;
    const pendingMsg = {
      id: 'pm-pending',
      role: 'user',
      type: 'text',
      content: pendingQuestion.question,
      time: pendingQuestion.sentAt || null,
    };
    return [...baseMessages, pendingMsg];
  }, [baseMessages, pendingQuestion]);

  useEffect(() => {
    if (messages.length === 0) {
      prevLenRef.current = 0;
      return;
    }
    const prev = prevLenRef.current;
    if (messages.length < prev) {
      prevLenRef.current = messages.length;
      return;
    }
    if (messages.length > prev) {
      const last = messages[messages.length - 1];
      setLastMessage(CONTACT_IDS.PM, last.content?.slice(0, 60) || 'Документ', last.time);
      const added = messages.slice(prev);
      const contactAdds = added.filter((m) => m.role === 'contact').length;
      /** Одно входящее без истории — приветствие Михаила при старте этапа 1 */
      const openingOnlyUnread =
        prev === 0 && messages.length === 1 && added.length === 1 && added[0].role === 'contact';
      if (contactAdds > 0 && !isViewingThisChat && (prev > 0 || openingOnlyUnread)) {
        if (openingOnlyUnread) {
          const sid = stageSessionId != null ? String(stageSessionId) : '';
          if (pmOpeningUnreadMarkedForRef.current !== sid) {
            pmOpeningUnreadMarkedForRef.current = sid;
            incrementUnreadBy(CONTACT_IDS.PM, contactAdds);
          }
        } else {
          incrementUnreadBy(CONTACT_IDS.PM, contactAdds);
        }
      }
    }
    prevLenRef.current = messages.length;
  }, [messages, isViewingThisChat, setLastMessage, incrementUnreadBy, stageSessionId]);

  const sendMessage = useCallback(
    (text) => {
      if (onSendQuestion) onSendQuestion(text);
    },
    [onSendQuestion]
  );

  const handleSaveAsNote = useCallback(
    (text, msg) => {
      if (onSaveInsight && msg?._chatIndex != null) {
        onSaveInsight(text, msg._chatIndex);
      }
    },
    [onSaveInsight]
  );

  const handleDocumentClick = useCallback(
    (docId) => {
      if (onDocumentClick) onDocumentClick(docId);
    },
    [onDocumentClick]
  );

  const lastPatienceRef = useRef(initiatorPatience ?? 100);
  const [patienceEmoji, setPatienceEmoji] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const emojiTimerRef = useRef(null);

  useEffect(() => {
    if (initiatorPatience == null) return;
    const prev = lastPatienceRef.current;
    lastPatienceRef.current = initiatorPatience;
    const drop = prev - initiatorPatience;
    if (drop <= 0) return;
    const emoji = drop > 20 ? '😡' : drop > 10 ? '😠' : '🙂';
    setPatienceEmoji(emoji);
    setShowEmoji(true);
    if (emojiTimerRef.current) clearTimeout(emojiTimerRef.current);
    emojiTimerRef.current = setTimeout(() => setShowEmoji(false), 900);
  }, [initiatorPatience]);

  const p = Math.max(0, Math.min(100, initiatorPatience ?? 0));
  const subHeader = initiatorPatience != null ? (
    <div style={{
      padding: '0 10px',
      background: '#f0f2f5',
      borderBottom: '1px solid #e2e8f0',
      display: 'flex',
      alignItems: 'center',
    }}>
      <div style={{ marginTop: 4, fontSize: 11, color: '#4b5563', display: 'flex', flexDirection: 'column', gap: 4, width: '100%', paddingBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Терпение собеседника:</span>
          <div style={{ flex: 1, height: 6, borderRadius: 9999, background: '#e5e7eb', overflow: 'hidden' }}>
            <div style={{
              width: `${p}%`,
              height: '100%',
              background: p > 60 ? '#10b981' : p > 30 ? '#fbbf24' : '#ef4444',
              transition: 'width 0.25s ease-out',
            }} />
          </div>
          <span>{p}</span>
          <span style={{
            minWidth: 20,
            textAlign: 'center',
            opacity: showEmoji ? 1 : 0,
            transform: showEmoji ? 'scale(1.2)' : 'scale(0.8)',
            transition: 'opacity 0.15s ease-out, transform 0.15s ease-out',
          }}>
            {patienceEmoji}
          </span>
        </div>
      </div>
    </div>
  ) : null;

  const chatBlocked = chatHistory?.some((e) => e.isBlocking);
  const patienceExhausted = initiatorPatience != null && initiatorPatience <= 0;
  const inputDisabled = stageComplete || chatBlocked || patienceExhausted;

  const blockReason = chatBlocked
    ? 'Чат заблокирован за нарушение правил общения'
    : patienceExhausted
      ? 'Терпение собеседника исчерпано — он больше не отвечает'
      : stageComplete
        ? 'Этап завершён'
        : null;

  const composerProps = useMemo(
    () =>
      inputDisabled
        ? { message: blockReason }
        : { onSend: sendMessage, disabled: externalLoading || false, placeholder: 'Задайте вопрос…' },
    [sendMessage, externalLoading, inputDisabled, blockReason]
  );

  return {
    messages,
    composerType: inputDisabled ? 'readonly' : 'simple',
    composerProps,
    headerExtra: null,
    subHeader,
    loading: externalLoading || false,
    onSaveAsNote: inputDisabled ? null : handleSaveAsNote,
    onDocumentClick: handleDocumentClick,
    onActionButton: null,
    renderMessageContent: null,
  };
}
