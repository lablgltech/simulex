import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useSimugram, CONTACT_IDS } from '../../../context/SimugramContext';

export default function useLawyerAdapter({
  isOpen,
  activeContact,
  negotiationSessionId,
  clauseId,
  clauseTitle,
  chatMessages,
  currentStep,
  chatData,
  patience,
  loading: externalLoading,
  onSelectAction,
  onSelectOption,
  onJustificationSubmit,
  explanationValue,
  onExplanationChange,
  revisionValue,
  onRevisionChange,
  requiresJustification,
  aiModeEnabled,
  chatFinished,
}) {
  const { setLastMessage, incrementUnread } = useSimugram();
  const isViewingThisChat = isOpen && activeContact === CONTACT_IDS.LAWYER;
  const prevLenRef = useRef(0);

  const messages = useMemo(() => {
    if (!chatMessages) return [];
    return chatMessages.map((m, i) => ({
      id: m.id || `lw-${i}`,
      role: m.role === 'user' || m.role === 'player' ? 'user' : 'contact',
      type: m.type || 'text',
      content: m.content || m.text || '',
      time: m.time || null,
      buttons: m.buttons || null,
      noteSaved: false,
    }));
  }, [chatMessages]);

  useEffect(() => {
    if (messages.length > prevLenRef.current && messages.length > 0) {
      const last = messages[messages.length - 1];
      setLastMessage(CONTACT_IDS.LAWYER, last.content?.slice(0, 60), last.time);
      if (!isViewingThisChat && prevLenRef.current > 0 && last.role === 'contact') {
        incrementUnread(CONTACT_IDS.LAWYER);
      }
    }
    prevLenRef.current = messages.length;
  }, [messages, isViewingThisChat, setLastMessage, incrementUnread]);

  const showDualComposer =
    !chatFinished &&
    ((aiModeEnabled && currentStep === 'aiFreeForm') ||
      (!aiModeEnabled && currentStep === 'justification' && requiresJustification));

  const composerType = showDualComposer ? 'dual' : chatFinished ? 'readonly' : 'none';

  const composerProps = useMemo(() => {
    if (composerType !== 'dual') return {};
    return {
      explanationValue: explanationValue || '',
      onExplanationChange: onExplanationChange || (() => {}),
      revisionValue: revisionValue || '',
      onRevisionChange: onRevisionChange || (() => {}),
      onSend: onJustificationSubmit || (() => {}),
      disabled: externalLoading || false,
    };
  }, [
    composerType,
    explanationValue,
    onExplanationChange,
    revisionValue,
    onRevisionChange,
    onJustificationSubmit,
    externalLoading,
  ]);

  const patienceLabel = patience != null ? `Терпение: ${patience}` : null;

  const headerExtra = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {clauseTitle && (
        <div
          style={{
            fontSize: 10,
            color: '#64748b',
            maxWidth: 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={clauseTitle}
        >
          {clauseTitle}
        </div>
      )}
      {patienceLabel && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: patience <= 1 ? '#ef4444' : patience <= 3 ? '#f59e0b' : '#22c55e',
            background: patience <= 1 ? '#fef2f2' : patience <= 3 ? '#fffbeb' : '#f0fdf4',
            padding: '3px 8px',
            borderRadius: 999,
          }}
        >
          {patienceLabel}
        </div>
      )}
    </div>
  );

  const handleActionButton = useCallback(
    (btn) => {
      if (btn.actionType === 'selectAction' && onSelectAction) {
        onSelectAction(btn.value);
      } else if (btn.actionType === 'selectOption' && onSelectOption) {
        onSelectOption(btn.index, btn.value);
      }
    },
    [onSelectAction, onSelectOption]
  );

  return {
    messages,
    composerType,
    composerProps,
    headerExtra,
    loading: externalLoading || false,
    onSaveAsNote: null,
    onDocumentClick: null,
    onActionButton: handleActionButton,
    renderMessageContent: null,
  };
}
