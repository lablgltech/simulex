import React from 'react';
import MarkdownContent from '../MarkdownContent';
import './simugram.css';

function formatTime(ts) {
  if (!ts) return '';
  if (typeof ts === 'string' && /^\d{1,2}:\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return typeof ts === 'string' ? ts : '';
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export default function SimugramMessage({
  message,
  onSaveAsNote,
  onDocumentClick,
  onActionButton,
  renderContent,
}) {
  const { role, type, content, text, time, documentId, documentTitle, buttons, noteSaved } =
    message;

  const displayText = content || text || '';

  if (type === 'system') {
    return <div className="simugram-system-msg">{displayText}</div>;
  }

  if (type === 'poll') {
    const { pollOptions, pollSelected, pollSubmitted, pollTags, onPollToggle, onPollSubmit, pollLoading } = message;
    const selected = pollSelected || [];
    return (
      <div className="simugram-bubble simugram-bubble--in">
        <div style={{ marginBottom: 8 }}>
          <MarkdownContent content={displayText} variant="ui" />
        </div>
        {pollTags && pollTags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {pollTags.map((tag) => (
              <span key={tag} style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: '#e0e7ff', color: '#3730a3', border: '1px solid #a5b4fc' }}>
                {tag}
              </span>
            ))}
          </div>
        )}
        {pollSubmitted ? (
          <div style={{ fontSize: 12, color: '#059669', fontWeight: 600, padding: '6px 0' }}>
            ✓ Ответ отправлен ({selected.length})
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(pollOptions || []).map((opt, i) => {
                const isSel = selected.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => onPollToggle?.(opt)}
                    disabled={pollLoading}
                    style={{
                      padding: '9px 12px',
                      borderRadius: 8,
                      border: `1.5px solid ${isSel ? '#2563eb' : '#d1d5db'}`,
                      background: isSel ? '#dbeafe' : '#fff',
                      color: isSel ? '#1e40af' : '#334155',
                      fontWeight: isSel ? 600 : 400,
                      fontSize: 12,
                      cursor: 'pointer',
                      textAlign: 'left',
                      lineHeight: 1.35,
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      transition: 'all 0.12s',
                    }}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                      border: `1.5px solid ${isSel ? '#2563eb' : '#cbd5e1'}`,
                      background: isSel ? '#2563eb' : '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 11, fontWeight: 700, marginTop: 1,
                    }}>
                      {isSel ? '✓' : ''}
                    </span>
                    <span>{opt}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
              {selected.length > 0 && (
                <span style={{ fontSize: 11, color: '#64748b' }}>Выбрано: {selected.length}</span>
              )}
              <button
                type="button"
                onClick={onPollSubmit}
                disabled={pollLoading}
                style={{
                  marginLeft: 'auto',
                  padding: '7px 20px',
                  fontSize: 13,
                  border: 'none',
                  borderRadius: 8,
                  cursor: pollLoading ? 'not-allowed' : 'pointer',
                  fontWeight: 700,
                  background: pollLoading ? '#e5e7eb' : '#25d366',
                  color: pollLoading ? '#9ca3af' : '#fff',
                  transition: 'background 0.15s',
                }}
              >
                {pollLoading ? 'Отправка…' : 'Готово'}
              </button>
            </div>
          </>
        )}
        {time && <div className="simugram-bubble-time">{formatTime(time)}</div>}
      </div>
    );
  }

  if (type === 'document') {
    return (
      <div className="simugram-bubble simugram-bubble--in">
        <button
          type="button"
          onClick={() => onDocumentClick?.(documentId)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: '#f1f5f9',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            padding: '8px 12px',
            cursor: 'pointer',
            width: '100%',
            textAlign: 'left',
            font: 'inherit',
            color: '#1e40af',
          }}
        >
          <span style={{ fontSize: 20 }}>📎</span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{documentTitle || documentId}</span>
        </button>
        {time && <div className="simugram-bubble-time">{formatTime(time)}</div>}
      </div>
    );
  }

  const isOut = role === 'user';

  const showAddToNotes = Boolean(onSaveAsNote && !isOut && !noteSaved && type !== 'document');

  return (
    <div className={`simugram-bubble ${isOut ? 'simugram-bubble--out' : 'simugram-bubble--in'}`}>
      {renderContent ? renderContent(displayText) : <MarkdownContent content={displayText} variant="ui" />}

      {noteSaved && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            fontWeight: 600,
            color: '#059669',
          }}
        >
          ✓ Заметка сохранена
        </div>
      )}

      {showAddToNotes && (
        <button
          type="button"
          className="simugram-bubble-note-link"
          onClick={(e) => {
            e.stopPropagation();
            onSaveAsNote(displayText, message);
          }}
        >
          Добавить в заметки
        </button>
      )}

      {buttons && buttons.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {buttons.map((btn, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onActionButton?.(btn)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                background: '#f8fafc',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                color: '#1e3a5f',
                textAlign: 'left',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#e2e8f0'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
            >
              {btn.label}
            </button>
          ))}
        </div>
      )}

      {time && <div className="simugram-bubble-time">{formatTime(time)}</div>}
    </div>
  );
}
