import React, { forwardRef, useImperativeHandle, useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useSimugram, CONTACT_IDS, CONTACT_META } from '../../context/SimugramContext';
import SimugramContactList from './SimugramContactList';
import SimugramChatView from './SimugramChatView';
import NegotiationChatFrame from '../NegotiationChatFrame';

import useTutorAdapter from './adapters/TutorAdapter';
import useBossAdapter from './adapters/BossAdapter';
import usePMAdapter from './adapters/PMAdapter';
import useLawyerAdapter from './adapters/LawyerAdapter';
import './simugram.css';

const LOGO = 'Симуграм';

const SimugramPanel = forwardRef(function SimugramPanel(
  {
    isOpen,
    onToggle,
    sessionId,
    caseId,
    currentStage,
    currentStageObj,
    caseData,
    session,
    getDeadlinePlaceholderBaseDate,
    stage1Props,
    stage3Props,
    onAction,
    /** id пользователя — для сохранения чата наставника в localStorage */
    tutorPersistUserId = null,
  },
  ref
) {
  const ctx = useSimugram();
  const { activeContact, setActiveContact, unreadCounts, lastMessages, clearUnread } = ctx;

  const tutorAvatarUrl = `${process.env.PUBLIC_URL || ''}/images/tutor-character.png`;
  /** BOSS — письма stage_enter от Ирины Петровны. */
  const bossAvatarUrl = `${process.env.PUBLIC_URL || ''}/images/avatar_irinapetrovna.png`;
  /** PM — чат руководителя проекта (Михаил). */
  const pmAvatarUrl = `${process.env.PUBLIC_URL || ''}/images/avatar-mikhail.png`;
  const lawyerAvatarUrl = `${process.env.PUBLIC_URL || ''}/images/ivan.png`;

  const isStage1Active = currentStageObj && (currentStageObj.id === 'stage-1' || currentStageObj.type === 'context');
  const isStage3Negotiation =
    currentStageObj &&
    (currentStageObj.id === 'stage-3' || currentStageObj.type === 'negotiation');

  const tutor = useTutorAdapter({
    sessionId,
    caseId,
    currentStage,
    isOpen,
    activeContact,
    isStage1Context: isStage1Active,
    persistUserId: tutorPersistUserId,
  });
  const boss = useBossAdapter({ caseData, currentStage, session, getDeadlinePlaceholderBaseDate });
  const pm = usePMAdapter({
    isOpen,
    activeContact,
    stageComplete: !isStage1Active,
    ...(stage1Props || {}),
    stageSessionId: stage1Props?.stageSessionId ?? null,
  });
  const lawyer = useLawyerAdapter({ isOpen, activeContact, ...(stage3Props || {}) });

  const adapters = useMemo(
    () => ({
      [CONTACT_IDS.TUTOR]: tutor,
      [CONTACT_IDS.BOSS]: boss,
      [CONTACT_IDS.PM]: pm,
      [CONTACT_IDS.LAWYER]: lawyer,
    }),
    [tutor, boss, pm, lawyer]
  );

  useImperativeHandle(
    ref,
    () => ({
      appendTutorMessage(text) {
        tutor.appendExternalMessage?.(text);
      },
      pushBossEmail(email) {
        boss.pushEmail?.(email);
      },
      pushBossPoll(poll) {
        boss.pushPoll?.(poll);
      },
      markBossPollDone(pollId) {
        boss.markPollDone?.(pollId);
      },
      openContact(contactId) {
        setActiveContact(contactId);
        clearUnread(contactId);
      },
    }),
    [tutor, boss, setActiveContact, clearUnread]
  );

  const [lawyerPatience, setLawyerPatience] = useState(100);
  const lastLawyerPatienceRef = useRef(100);
  const [lawyerPatienceEmoji, setLawyerPatienceEmoji] = useState('');
  const [showLawyerEmoji, setShowLawyerEmoji] = useState(false);
  const lawyerEmojiTimerRef = useRef(null);

  const handleLawyerPatienceChange = useCallback((val) => {
    setLawyerPatience((prev) => {
      const clamped = Math.max(0, Math.min(100, val));
      const prevVal = lastLawyerPatienceRef.current;
      lastLawyerPatienceRef.current = clamped;
      const drop = prevVal - clamped;
      if (drop > 0) {
        const emoji = drop > 20 ? '😡' : drop > 10 ? '😠' : '🙂';
        setLawyerPatienceEmoji(emoji);
        setShowLawyerEmoji(true);
        if (lawyerEmojiTimerRef.current) clearTimeout(lawyerEmojiTimerRef.current);
        lawyerEmojiTimerRef.current = setTimeout(() => setShowLawyerEmoji(false), 900);
      }
      return clamped;
    });
  }, []);

  const lp = Math.max(0, Math.min(100, lawyerPatience));
  const lawyerSubHeader = (
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
              width: `${lp}%`,
              height: '100%',
              background: lp > 60 ? '#10b981' : lp > 30 ? '#fbbf24' : '#ef4444',
              transition: 'width 0.25s ease-out',
            }} />
          </div>
          <span>{lp}</span>
          <span style={{
            minWidth: 20,
            textAlign: 'center',
            opacity: showLawyerEmoji ? 1 : 0,
            transform: showLawyerEmoji ? 'scale(1.2)' : 'scale(0.8)',
            transition: 'opacity 0.15s ease-out, transform 0.15s ease-out',
          }}>
            {lawyerPatienceEmoji}
          </span>
        </div>
      </div>
    </div>
  );

  const availableContacts = useMemo(() => {
    const list = [CONTACT_IDS.BOSS, CONTACT_IDS.TUTOR];
    if (isStage1Active) list.push(CONTACT_IDS.PM);
    const stageObj = currentStageObj || {};
    const isStage3 = stageObj.id === 'stage-3' || stageObj.type === 'negotiation';
    if (isStage3) list.push(CONTACT_IDS.LAWYER);
    return list;
  }, [isStage1Active, currentStageObj]);

  /** Скрытый контакт не в списке — не держать для него непрочитанное (иначе бейдж на «Симуграм» без строки в списке). */
  const allContactIds = useMemo(
    () => [CONTACT_IDS.BOSS, CONTACT_IDS.TUTOR, CONTACT_IDS.PM, CONTACT_IDS.LAWYER],
    []
  );
  useEffect(() => {
    for (const id of allContactIds) {
      if (!availableContacts.includes(id)) clearUnread(id);
    }
  }, [availableContacts, allContactIds, clearUnread]);

  /** При первом монтировании (в т.ч. после F5) не сбрасывать контакт: иначе затирается восстановление из снимка. */
  const prevStageRef = useRef(null);
  useEffect(() => {
    const stage = currentStage ?? 0;
    if (prevStageRef.current === null) {
      prevStageRef.current = stage;
      return;
    }
    if (prevStageRef.current !== stage) {
      prevStageRef.current = stage;
      setActiveContact(CONTACT_IDS.BOSS);
      clearUnread(CONTACT_IDS.BOSS);
    }
  }, [currentStage, setActiveContact, clearUnread]);

  useEffect(() => {
    if (activeContact && !availableContacts.includes(activeContact)) {
      setActiveContact(CONTACT_IDS.BOSS);
      clearUnread(CONTACT_IDS.BOSS);
    }
  }, [activeContact, availableContacts, setActiveContact, clearUnread]);

  const handleSelectContact = useCallback(
    (id) => {
      setActiveContact(id);
      clearUnread(id);
    },
    [setActiveContact, clearUnread]
  );

  const stage3OnClose = stage3Props?.onClose;
  const handleBack = useCallback(() => {
    if (activeContact === CONTACT_IDS.LAWYER && typeof stage3OnClose === 'function') {
      try {
        stage3OnClose();
      } catch {
        /* ignore */
      }
    }
    setActiveContact(null);
  }, [activeContact, stage3OnClose, setActiveContact]);

  const handlePanelClick = useCallback((e) => {
    const contactLink = e.target.closest('[data-simugram-contact]');
    if (contactLink) {
      const contactId = contactLink.dataset.simugramContact;
      if (contactId && availableContacts.includes(contactId)) {
        e.preventDefault();
        setActiveContact(contactId);
        clearUnread(contactId);
      }
      return;
    }
    const actionLink = e.target.closest('[data-simugram-action]');
    if (actionLink) {
      e.preventDefault();
      onAction?.(actionLink.dataset.simugramAction, actionLink.dataset.simugramPayload);
    }
  }, [availableContacts, setActiveContact, clearUnread, onAction]);

  if (!isOpen) return null;

  const adapter = activeContact ? adapters[activeContact] : null;
  const contactMeta = activeContact ? CONTACT_META[activeContact] : null;

  const avatarUrls = {
    [CONTACT_IDS.BOSS]: bossAvatarUrl,
    [CONTACT_IDS.TUTOR]: tutorAvatarUrl,
    [CONTACT_IDS.PM]: pmAvatarUrl,
    [CONTACT_IDS.LAWYER]: lawyerAvatarUrl,
  };

  let panelBody;
  if (!activeContact) {
    panelBody = (
      <>
        <div className="simugram-header">
          <span className="simugram-header-title">{LOGO}</span>
          <button type="button" onClick={onToggle} className="simugram-header-close" title="Закрыть">×</button>
        </div>
        <SimugramContactList
          availableContacts={availableContacts}
          unreadCounts={unreadCounts}
          lastMessages={lastMessages}
          onSelect={handleSelectContact}
          avatarUrls={avatarUrls}
        />
      </>
    );
  } else if (activeContact === CONTACT_IDS.LAWYER && stage3Props) {
    panelBody = (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div className="simugram-chat-header">
          <button type="button" onClick={handleBack} className="simugram-chat-header-back" title="Назад к контактам">←</button>
          {avatarUrls[CONTACT_IDS.LAWYER] ? (
            <div className="simugram-avatar" style={{ background: contactMeta.color, fontSize: 0 }}>
              <img src={avatarUrls[CONTACT_IDS.LAWYER]} alt="" />
            </div>
          ) : (
            <div className="simugram-avatar" style={{ background: contactMeta.color }}>
              {contactMeta.avatar || contactMeta.name.charAt(0)}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="simugram-chat-header-name">{contactMeta.name}</div>
            <div className="simugram-chat-header-subtitle">
              {stage3Props.clauseTitle || contactMeta.subtitle}
            </div>
          </div>
        </div>
        {lawyerSubHeader}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <NegotiationChatFrame
            negotiationSessionId={stage3Props.negotiationSessionId}
            clauseId={stage3Props.clauseId}
            action={stage3Props.chatAction}
            onClose={stage3Props.onClose}
            onStatusUpdate={stage3Props.onStatusUpdate}
            onChatComplete={stage3Props.onChatComplete}
            onClauseAgreed={stage3Props.onClauseAgreed}
            isActive={stage3Props.isActive}
            selectedClause={stage3Props.selectedClause}
            onAccept={stage3Props.onAccept}
            onPropose={stage3Props.onPropose}
            aiModeEnabled
            onTutorEvent={stage3Props.onTutorEvent}
            onPatienceChange={handleLawyerPatienceChange}
          />
        </div>
      </div>
    );
  } else {
    panelBody = (
      <SimugramChatView
        contact={contactMeta}
        messages={adapter?.messages || []}
        composerType={adapter?.composerType || 'none'}
        composerProps={adapter?.composerProps || {}}
        headerExtra={adapter?.headerExtra || null}
        subHeader={adapter?.subHeader || null}
        onBack={handleBack}
        onSaveAsNote={adapter?.onSaveAsNote}
        onDocumentClick={adapter?.onDocumentClick}
        onActionButton={adapter?.onActionButton}
        loading={adapter?.loading || false}
        renderMessageContent={adapter?.renderMessageContent}
        avatarUrl={avatarUrls[activeContact]}
      />
    );
  }

  return (
    <div
      className={`simugram-panel${isStage3Negotiation ? ' simugram-panel--stage3' : ''}`}
      onClick={handlePanelClick}
    >
      {panelBody}
    </div>
  );
});

export default SimugramPanel;
