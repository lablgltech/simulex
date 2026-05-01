import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { tutorAPI } from '../../../api/tutorApi';
import { useSimugram, CONTACT_IDS } from '../../../context/SimugramContext';
import { readTutorChatLocal, writeTutorChatLocal } from '../../../utils/tutorChatStorage';

/** React StrictMode: эффект истории может отработать дважды до записи чата в localStorage */
const tutorSyntheticWelcomeUnreadBumped = new Set();

/** Приветствие при первом заходе на этап 1 (история с API пуста) */
const STAGE1_TUTOR_WELCOME_TEXT =
  'Здравствуйте! Я — ИИ-наставник Сергей Павлович. Если на этапе что-то станет непонятно, я всегда на связи — пишите в любой момент.';

function parseHighlightLinks(text) {
  if (!text || typeof text !== 'string') return [{ type: 'text', value: text || '' }];
  const parts = [];
  const re = /\[\[highlight:(\w+)\]\]([\s\S]*?)\[\[\/highlight\]\]/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push({ type: 'text', value: text.slice(lastIndex, m.index) });
    parts.push({ type: 'highlight', id: m[1], value: m[2] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', value: text.slice(lastIndex) });
  return parts.length ? parts : [{ type: 'text', value: text }];
}

export default function useTutorAdapter({
  sessionId,
  caseId,
  currentStage,
  isOpen,
  activeContact,
  /** На этапе 1 показываем приветствие, пока в истории наставника нет сообщений с сервера */
  isStage1Context = false,
  /** id пользователя БД — дублирование чата наставника в localStorage на всю сессию симуляции */
  persistUserId = null,
}) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const { setLastMessage, incrementUnread, incrementUnreadBy } = useSimugram();
  const isViewingThisChat = isOpen && activeContact === CONTACT_IDS.TUTOR;
  /** После `await` нельзя брать isViewingThisChat из замыкания sendMessage — пользователь мог переключить контакт. */
  const isViewingThisChatRef = useRef(isViewingThisChat);
  isViewingThisChatRef.current = isViewingThisChat;
  /** Одноразово помечаем непрочитанным приветствие наставника на этапе 1 (не дублируем при повторном открытии панели). */
  const tutorWelcomeUnreadSentRef = useRef(false);

  useEffect(() => {
    tutorWelcomeUnreadSentRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    // На этапе 1 поднимаем приветствие и непрочитанное даже при закрытой панели (иначе бейдж на «…» не появится).
    // На остальных этапах историю подгружаем при открытии Симуграма.
    if (!isOpen && !isStage1Context) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await tutorAPI.getHistory(sessionId);
        if (cancelled) return;
        const fromApi = Array.isArray(data?.messages)
          ? data.messages.map((m, i) => ({
              id: `th-${i}`,
              role: m.role === 'assistant' ? 'tutor' : 'user',
              content: m.content || '',
              time: null,
            }))
          : [];
        const persistedRaw = readTutorChatLocal(persistUserId, sessionId);
        const fromLocal = Array.isArray(persistedRaw)
          ? persistedRaw.map((m, i) => ({
              id: m.id || `tl-${i}-${m.time || 0}`,
              role: m.role === 'assistant' ? 'tutor' : m.role === 'user' ? 'user' : 'tutor',
              content: m.content || '',
              time: m.time != null ? m.time : null,
            }))
          : [];

        let next = [];
        if (fromApi.length > 0) {
          next = fromApi;
        } else if (fromLocal.length > 0) {
          next = fromLocal;
        } else if (isStage1Context) {
          next = [
            {
              id: 'tutor-s1-welcome',
              role: 'tutor',
              content: STAGE1_TUTOR_WELCOME_TEXT,
              time: Date.now(),
            },
          ];
        }

        setMessages(next);
        if (next.length > 0) {
          const last = next[next.length - 1];
          setLastMessage(CONTACT_IDS.TUTOR, last.content, last.time ?? Date.now());
        }
        // Непрочитанное только при первом показе синтетического приветствия. После F5 история
        // подтягивается из localStorage — снова bumpать нельзя (счётчик в памяти уже сброшен).
        const isPureSyntheticWelcome =
          fromApi.length === 0 &&
          fromLocal.length === 0 &&
          next.length === 1 &&
          next[0]?.id === 'tutor-s1-welcome';
        if (isPureSyntheticWelcome && !tutorWelcomeUnreadSentRef.current) {
          const sid = String(sessionId);
          if (tutorSyntheticWelcomeUnreadBumped.has(sid)) {
            tutorWelcomeUnreadSentRef.current = true;
          } else {
            tutorSyntheticWelcomeUnreadBumped.add(sid);
            tutorWelcomeUnreadSentRef.current = true;
            if (!isViewingThisChatRef.current) {
              incrementUnreadBy(CONTACT_IDS.TUTOR, 1);
            }
          }
        }
        if (fromApi.length > 0 && persistUserId != null) {
          writeTutorChatLocal(persistUserId, sessionId, fromApi);
        }
      } catch (_) {
        if (!cancelled) {
          const fallback = readTutorChatLocal(persistUserId, sessionId);
          if (fallback?.length) {
            const next = fallback.map((m, i) => ({
              id: m.id || `tl-${i}-${m.time || 0}`,
              role: m.role === 'assistant' ? 'tutor' : m.role === 'user' ? 'user' : 'tutor',
              content: m.content || '',
              time: m.time != null ? m.time : null,
            }));
            setMessages(next);
            const last = next[next.length - 1];
            setLastMessage(CONTACT_IDS.TUTOR, last.content, last.time ?? Date.now());
            // fallback = только localStorage — не дублируем непрочитанное для приветствия
          } else {
            setMessages([]);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, sessionId, setLastMessage, isStage1Context, persistUserId, incrementUnreadBy]);

  useEffect(() => {
    if (!sessionId || persistUserId == null || Number.isNaN(Number(persistUserId))) return;
    if (!messages.length) return;
    writeTutorChatLocal(persistUserId, sessionId, messages);
  }, [messages, sessionId, persistUserId]);

  const sendMessage = useCallback(
    async (text) => {
      if (!text.trim() || loading) return;
      const userMsg = { id: `tu-${Date.now()}`, role: 'user', content: text, time: Date.now() };
      setMessages((prev) => [...prev, userMsg]);
      setLastMessage(CONTACT_IDS.TUTOR, text, Date.now());
      setLoading(true);
      try {
        const data = await tutorAPI.chat({
          message: text,
          sessionId: sessionId ?? undefined,
          caseId: caseId ?? undefined,
          currentStage: currentStage ?? undefined,
        });
        const reply = data?.reply ?? '';
        const botMsg = { id: `tb-${Date.now()}`, role: 'tutor', content: reply, time: Date.now() };
        setMessages((prev) => [...prev, botMsg]);
        setLastMessage(CONTACT_IDS.TUTOR, reply, Date.now());
        if (!isViewingThisChatRef.current) incrementUnread(CONTACT_IDS.TUTOR);
      } catch (_) {
        const errMsg = {
          id: `te-${Date.now()}`,
          role: 'tutor',
          content: 'Не удалось отправить сообщение. Попробуйте снова.',
          time: Date.now(),
        };
        setMessages((prev) => [...prev, errMsg]);
      } finally {
        setLoading(false);
      }
    },
    [loading, sessionId, caseId, currentStage, setLastMessage, incrementUnread]
  );

  const appendExternalMessage = useCallback(
    (text) => {
      if (!text || !String(text).trim()) return;
      const msg = { id: `tx-${Date.now()}`, role: 'tutor', content: String(text).trim(), time: Date.now() };
      setMessages((prev) => [...prev, msg]);
      setLastMessage(CONTACT_IDS.TUTOR, msg.content, msg.time);
      if (!isViewingThisChatRef.current) incrementUnread(CONTACT_IDS.TUTOR);
    },
    [setLastMessage, incrementUnread]
  );

  const renderMessageContent = useCallback((text) => {
    const parts = parseHighlightLinks(text);
    return parts.map((p, i) =>
      p.type === 'text' ? (
        <span key={i}>{p.value}</span>
      ) : (
        <button
          key={i}
          type="button"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: '#1e40af',
            textDecoration: 'underline',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          {p.value}
        </button>
      )
    );
  }, []);

  const composerProps = useMemo(
    () => ({
      onSend: sendMessage,
      disabled: loading,
      placeholder: 'Спросить наставника…',
    }),
    [sendMessage, loading]
  );

  const normalizedMessages = useMemo(
    () => messages.map((m) => ({ ...m, role: m.role === 'tutor' ? 'contact' : 'user' })),
    [messages]
  );

  return {
    messages: normalizedMessages,
    composerType: 'simple',
    composerProps,
    headerExtra: null,
    loading,
    appendExternalMessage,
    renderMessageContent,
    onSaveAsNote: null,
    onDocumentClick: null,
    onActionButton: null,
  };
}
