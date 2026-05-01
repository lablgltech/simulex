import React, { useEffect, useRef } from 'react';

const REVISION_DEFAULT_PROMPT = 'Введите текст новой редакции пункта';

function revisionLooksUnset(raw) {
  const t = (raw || '').trim();
  return t === '' || t === REVISION_DEFAULT_PROMPT;
}

export default function DualComposer({
  explanationValue,
  onExplanationChange,
  revisionValue,
  onRevisionChange,
  onSend,
  disabled,
}) {
  const explanationRef = useRef(null);
  const canSend =
    !!explanationValue?.trim() ||
    (!!revisionValue?.trim() && !revisionLooksUnset(revisionValue));

  useEffect(() => {
    if (!disabled) {
      explanationRef.current?.focus({ preventScroll: true });
    }
  }, [disabled]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (canSend && !disabled) onSend();
    }
  };

  return (
    <div style={{ borderTop: '1px solid #e2e8f0', background: '#fff', padding: '8px 10px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
        Ваше пояснение и предложение
      </div>
      <textarea
        ref={explanationRef}
        data-simugram-primary-input="true"
        value={explanationValue}
        onChange={(e) => onExplanationChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Предлагаем изложить в новой редакции, поскольку..."
        disabled={disabled}
        autoFocus
        rows={2}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'none',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          padding: '6px 10px',
          fontSize: 12,
          fontFamily: 'inherit',
          lineHeight: 1.4,
          outline: 'none',
          marginBottom: 6,
        }}
      />
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
        Предлагаемая редакция
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <span style={{ color: '#94a3b8', fontSize: 18, lineHeight: '24px', userSelect: 'none' }}>«</span>
        <textarea
          value={revisionValue}
          onChange={(e) => onRevisionChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={REVISION_DEFAULT_PROMPT}
          disabled={disabled}
          rows={2}
          style={{
            flex: 1,
            minWidth: 0,
            resize: 'none',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 12,
            fontFamily: 'inherit',
            lineHeight: 1.4,
            outline: 'none',
            fontStyle: revisionLooksUnset(revisionValue) ? 'italic' : 'normal',
          }}
        />
        <span style={{ color: '#94a3b8', fontSize: 18, lineHeight: '24px', userSelect: 'none', alignSelf: 'flex-end' }}>»</span>
      </div>
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || !canSend}
        style={{
          marginTop: 8,
          width: '100%',
          padding: '8px 0',
          borderRadius: 8,
          border: 'none',
          background: canSend && !disabled ? '#1e3a5f' : '#cbd5e1',
          color: '#fff',
          fontSize: 13,
          fontWeight: 600,
          cursor: canSend && !disabled ? 'pointer' : 'default',
          transition: 'background 0.15s',
        }}
      >
        Отправить
      </button>
    </div>
  );
}
