import React, { useRef, useEffect } from 'react';
import SimugramMessage from './SimugramMessage';
import SimpleComposer from './composers/SimpleComposer';
import DualComposer from './composers/DualComposer';
import ReadonlyComposer from './composers/ReadonlyComposer';
import './simugram.css';

export default function SimugramChatView({
  contact,
  messages,
  composerType,
  composerProps,
  headerExtra,
  subHeader,
  onBack,
  onSaveAsNote,
  onDocumentClick,
  onActionButton,
  loading,
  renderMessageContent,
  avatarUrl,
}) {
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages?.length]);

  useEffect(() => {
    if (composerType !== 'simple' && composerType !== 'dual') return;
    const root = rootRef.current;
    if (!root) return;
    const input = root.querySelector('[data-simugram-primary-input="true"]');
    if (!input) return;
    const active = document.activeElement;
    const shouldFocus =
      !active ||
      active === document.body ||
      root.contains(active);
    if (shouldFocus) {
      requestAnimationFrame(() => {
        input.focus({ preventScroll: true });
      });
    }
  }, [composerType, messages?.length, loading]);

  const { name, subtitle, avatar, color } = contact;

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="simugram-chat-header">
        <button type="button" onClick={onBack} className="simugram-chat-header-back" title="Назад к контактам">←</button>
        <div
          className="simugram-avatar"
          style={{ background: color || '#94a3b8', ...(avatarUrl ? { fontSize: 0 } : {}) }}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" />
          ) : (
            avatar || name.charAt(0)
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="simugram-chat-header-name">{name}</div>
          <div className="simugram-chat-header-subtitle">{subtitle}</div>
        </div>
        {headerExtra}
      </div>
      {subHeader}

      <div ref={scrollRef} className="simugram-chat-bg">
        {(!messages || messages.length === 0) && (
          <div className="simugram-system-msg" style={{ marginTop: 20 }}>
            Нет сообщений
          </div>
        )}
        {(messages || []).map((msg, i) => (
          <SimugramMessage
            key={msg.id || i}
            message={msg}
            onSaveAsNote={onSaveAsNote}
            onDocumentClick={onDocumentClick}
            onActionButton={onActionButton}
            renderContent={renderMessageContent}
          />
        ))}
        {loading && (
          <div style={{ alignSelf: 'flex-start', padding: '6px 12px', color: '#8696a0', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>Печатает</span>
            <span className="simugram-typing-dots">
              <span className="simugram-typing-dot" />
              <span className="simugram-typing-dot" />
              <span className="simugram-typing-dot" />
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* composer */}
      {composerType === 'simple' && <SimpleComposer {...(composerProps || {})} />}
      {composerType === 'dual' && <DualComposer {...(composerProps || {})} />}
      {composerType === 'readonly' && <ReadonlyComposer {...(composerProps || {})} />}
      {composerType === 'none' && null}
    </div>
  );
}
