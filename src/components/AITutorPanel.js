import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { tutorAPI } from '../api/tutorApi';
import TutorSpotlightOverlay from './TutorSpotlightOverlay';

/** Разбивает текст на части: обычный текст и [[highlight:id]]текст[[/highlight]] для клика (если ответ API содержит разметку). */
function parseHighlightLinks(text) {
  if (!text || typeof text !== 'string') return [{ type: 'text', value: text || '' }];
  const parts = [];
  const re = /\[\[highlight:(\w+)\]\]([\s\S]*?)\[\[\/highlight\]\]/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, m.index) });
    }
    parts.push({ type: 'highlight', id: m[1], value: m[2] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return parts.length ? parts : [{ type: 'text', value: text }];
}

function MessageContent({ text, onHighlightClick }) {
  const parts = parseHighlightLinks(text);
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <span key={i}>{p.value}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onHighlightClick?.(p.id);
            }}
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
      )}
    </>
  );
}

const AITutorPanel = forwardRef(function AITutorPanel(
  {
    isOpen,
    onToggle,
    sessionId = null,
    caseId = null,
    currentStage = null,
    inline = false,
  },
  ref
) {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!isOpen || !sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await tutorAPI.getHistory(sessionId);
        if (cancelled) return;
        const list = Array.isArray(data?.messages)
          ? data.messages.map((m) => ({
              role: m.role === 'assistant' ? 'tutor' : 'user',
              content: m.content || '',
            }))
          : [];
        setMessages(list);
      } catch (_) {
        if (!cancelled) setMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId, currentStage]);

  useImperativeHandle(
    ref,
    () => ({
      appendTutorMessage(text) {
        if (!text || !String(text).trim()) return;
        setMessages((prev) => [...prev, { role: 'tutor', content: String(text).trim() }]);
      },
    }),
    []
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const handleSend = async () => {
    const text = (inputValue || '').trim();
    if (!text || loading) return;
    setInputValue('');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setLoading(true);
    try {
      const data = await tutorAPI.chat({
        message: text,
        sessionId: sessionId ?? undefined,
        caseId: caseId ?? undefined,
        currentStage: currentStage ?? undefined,
      });
      const reply = data?.reply ?? '';
      setMessages((prev) => [...prev, { role: 'tutor', content: reply }]);
    } catch (_) {
      setMessages((prev) => [
        ...prev,
        { role: 'tutor', content: 'Не удалось отправить сообщение. Проверьте подключение и попробуйте снова.' },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const characterImgUrl = `${process.env.PUBLIC_URL || ''}/images/tutor-character.png`;

  if (!isOpen) {
    return <TutorSpotlightOverlay highlightId={highlightId} onClose={() => setHighlightId(null)} />;
  }

  const panelContainerStyle = {
    width: '320px',
    maxWidth: inline ? '100%' : 'calc(95vw - 24px)',
    background: 'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)',
    boxShadow: inline ? 'none' : '-4px 0 16px rgba(0,0,0,0.12)',
    zIndex: 999,
    display: 'flex',
    flexDirection: 'column',
    borderRadius: inline ? 0 : '8px 0 0 0',
    ...(inline
      ? { flex: 1, minHeight: 0, width: '100%', maxWidth: '100%' }
      : { position: 'fixed', right: '12px', top: '60px', height: 'calc(100vh - 60px)' }),
  };

  return (
    <>
      <div style={panelContainerStyle}>
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            padding: '8px 16px',
            background: '#ffffff',
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
            <div style={{ flexShrink: 0 }}>
              <img
                src={characterImgUrl}
                alt=""
                width={52}
                height={52}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: '50%',
                  objectFit: 'cover',
                  objectPosition: 'center 20%',
                  display: 'block',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
                }}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: 18,
                  fontWeight: 700,
                  color: '#1a1a1a',
                  lineHeight: 1.25,
                }}
              >
                <span style={{ display: 'block' }}>Сергей Павлович</span>
              </h3>
              <div style={{ marginTop: 4, fontSize: 12, color: '#4b5563', lineHeight: 1.3 }}>ИИ-наставник</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggle}
            style={{
              width: 28,
              height: 28,
              padding: 0,
              flexShrink: 0,
              border: 'none',
              borderRadius: '50%',
              background: 'rgba(0, 0, 0, 0.1)',
              color: '#1a1a1a',
              cursor: 'pointer',
              fontSize: 18,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
            title="Закрыть"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(0, 0, 0, 0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(0, 0, 0, 0.1)';
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          {messages.length === 0 && (
            <div
              className="simulex-content"
              style={{
                fontSize: '13px',
                color: '#64748b',
                lineHeight: 1.5,
                padding: '8px 4px',
              }}
            >
              Задавайте вопросы по ситуации в кейсе, рискам и формулировкам. Сергей Павлович с удовольствием направит и подскажет, но пройти этот кейс за вас не сможет — решения и ответственность остаются за вами.
            </div>
          )}
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className="simulex-content"
              style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '95%',
                padding: '10px 14px',
                borderRadius: 12,
                background: msg.role === 'user' ? '#e0e7ff' : '#fff',
                borderLeft: msg.role === 'tutor' ? '4px solid #1e3a5f' : 'none',
                boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                fontSize: '13px',
                lineHeight: 1.5,
                color: '#334155',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {msg.role === 'tutor' ? (
                <MessageContent text={msg.content} onHighlightClick={setHighlightId} />
              ) : (
                msg.content
              )}
            </div>
          ))}
          {loading && (
            <div style={{ alignSelf: 'flex-start', padding: '8px 12px', color: '#64748b', fontSize: '13px' }}>
              Сергей Павлович печатает…
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div style={{ padding: '12px', borderTop: '1px solid #e2e8f0', background: '#fff', flexShrink: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Спросить наставника…"
              disabled={loading}
              rows={4}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                minWidth: 0,
                minHeight: 88,
                padding: '12px 12px',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                fontSize: 14,
                fontFamily: 'inherit',
                lineHeight: 1.45,
                resize: 'vertical',
              }}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={loading || !inputValue.trim()}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 16px',
                background: '#1e3a5f',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              Отправить
            </button>
          </div>
        </div>
      </div>
      <TutorSpotlightOverlay highlightId={highlightId} onClose={() => setHighlightId(null)} />
    </>
  );
});

export default AITutorPanel;
