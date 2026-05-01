import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

const CONTACT_IDS = {
  BOSS: 'boss',
  TUTOR: 'tutor',
  PM: 'pm',
  LAWYER: 'lawyer',
};

const CONTACT_META = {
  [CONTACT_IDS.BOSS]: {
    name: 'Ирина Петровна',
    subtitle: 'Начальница юр. отдела',
    avatar: '👔',
    color: '#6366f1',
  },
  [CONTACT_IDS.TUTOR]: {
    name: 'Сергей Павлович',
    subtitle: 'ИИ-наставник',
    avatar: null,
    color: '#1e3a5f',
  },
  [CONTACT_IDS.PM]: {
    name: 'Михаил',
    subtitle: 'Руководитель проекта',
    avatar: '👤',
    color: '#0891b2',
  },
  [CONTACT_IDS.LAWYER]: {
    name: 'Иван Кузнецов',
    subtitle: 'Юрист контрагента',
    avatar: null,
    color: '#dc2626',
  },
};

const SimugramContext = createContext(null);

export function SimugramProvider({ children }) {
  const [activeContact, setActiveContact] = useState(null);
  const [unreadCounts, setUnreadCounts] = useState({
    [CONTACT_IDS.BOSS]: 0,
    [CONTACT_IDS.TUTOR]: 0,
    [CONTACT_IDS.PM]: 0,
    [CONTACT_IDS.LAWYER]: 0,
  });
  const [lastMessages, setLastMessages] = useState({});
  const listenersRef = useRef({});

  const incrementUnread = useCallback((contactId) => {
    setUnreadCounts((prev) => ({ ...prev, [contactId]: (prev[contactId] || 0) + 1 }));
  }, []);

  const incrementUnreadBy = useCallback((contactId, delta) => {
    const d = Math.max(0, Math.floor(Number(delta) || 0));
    if (!d) return;
    setUnreadCounts((prev) => ({ ...prev, [contactId]: (prev[contactId] || 0) + d }));
  }, []);

  const clearUnread = useCallback((contactId) => {
    setUnreadCounts((prev) => ({ ...prev, [contactId]: 0 }));
  }, []);

  const setLastMessage = useCallback((contactId, text, time) => {
    setLastMessages((prev) => ({ ...prev, [contactId]: { text, time: time || Date.now() } }));
  }, []);

  const onNewMessage = useCallback((contactId, handler) => {
    if (!listenersRef.current[contactId]) listenersRef.current[contactId] = [];
    listenersRef.current[contactId].push(handler);
    return () => {
      listenersRef.current[contactId] = (listenersRef.current[contactId] || []).filter(
        (h) => h !== handler
      );
    };
  }, []);

  const pushMessage = useCallback(
    (contactId, message) => {
      setLastMessage(contactId, message.text || message.content || '', message.time);
      (listenersRef.current[contactId] || []).forEach((h) => h(message));
    },
    [setLastMessage]
  );

  /** Для вкладки в HUD: сколько чатов имеют непрочитанное, а не сумма сообщений (1+2 → 2, не 3). */
  const totalUnread = Object.values(unreadCounts).filter((n) => (n || 0) > 0).length;

  const value = {
    CONTACT_IDS,
    CONTACT_META,
    activeContact,
    setActiveContact,
    unreadCounts,
    incrementUnread,
    incrementUnreadBy,
    clearUnread,
    lastMessages,
    setLastMessage,
    totalUnread,
    onNewMessage,
    pushMessage,
  };

  return <SimugramContext.Provider value={value}>{children}</SimugramContext.Provider>;
}

export function useSimugram() {
  const ctx = useContext(SimugramContext);
  if (!ctx) throw new Error('useSimugram must be used within SimugramProvider');
  return ctx;
}

export { CONTACT_IDS, CONTACT_META };
