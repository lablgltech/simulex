import React from 'react';

/**
 * Компонент модального окна для отображения нового письма
 * Появляется по центру экрана при получении нового письма
 * Поддерживает очередь писем с счетчиком
 */
export default function NewEmailModal({ email, onClose, onMarkAsRead, currentIndex, totalCount }) {
  if (!email) return null;

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const avatarLetter = (email.from || '?').charAt(0).toUpperCase();

  const handleClose = () => {
    if (!email.read && onMarkAsRead) {
      onMarkAsRead(email.id);
    }
    if (onClose) {
      onClose();
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 3000,
        animation: 'fadeIn 0.3s ease-in-out'
      }}
      onClick={handleClose}
    >
      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes slideUp {
          from {
            transform: translateY(20px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
      `}</style>
      <div
        style={{
          background: 'white',
          width: '90%',
          maxWidth: '600px',
          borderRadius: '12px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '80vh',
          overflow: 'hidden',
          animation: 'slideUp 0.3s ease-out',
          position: 'relative'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Верхняя строка: тег «Входящее» и кнопка закрытия */}
        <div
          style={{
            padding: '16px 20px 0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <span
            style={{
              display: 'inline-block',
              padding: '6px 12px',
              border: '1px solid #93c5fd',
              borderRadius: '6px',
              background: 'white',
              color: '#374151',
              fontSize: '14px',
              fontWeight: 500
            }}
          >
            Входящее
          </span>
          <button
            onClick={handleClose}
            style={{
              background: 'transparent',
              border: 'none',
              width: '32px',
              height: '32px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '20px',
              color: '#6b7280',
              transition: 'color 0.2s'
            }}
            onMouseEnter={(e) => {
              e.target.style.color = '#111';
            }}
            onMouseLeave={(e) => {
              e.target.style.color = '#6b7280';
            }}
          >
            ×
          </button>
        </div>

        {/* Тема письма */}
        <div
          style={{
            padding: '16px 20px',
            fontSize: '20px',
            fontWeight: 'bold',
            color: '#111827',
            lineHeight: '1.3'
          }}
        >
          {email.subject}
          {totalCount > 1 && (
            <span
              style={{
                marginLeft: '8px',
                fontSize: '13px',
                fontWeight: 500,
                color: '#6b7280'
              }}
            >
              ({currentIndex} из {totalCount})
            </span>
          )}
        </div>

        <div style={{ height: '1px', background: '#e5e7eb', margin: '0 20px' }} />

        {/* Отправитель: аватар, имя, время, «Кому: мне» */}
        <div
          style={{
            padding: '16px 20px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px'
          }}
        >
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              background: '#3b82f6',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '18px',
              fontWeight: 'bold',
              flexShrink: 0
            }}
          >
            {avatarLetter}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 'bold', color: '#111827', fontSize: '15px' }}>
                {email.from}
              </span>
              {email.timestamp && (
                <span style={{ fontSize: '14px', color: '#6b7280' }}>
                  {formatTime(email.timestamp)}
                </span>
              )}
            </div>
            <div style={{ fontSize: '14px', color: '#6b7280', marginTop: '2px' }}>
              Кому: мне
            </div>
          </div>
        </div>

        <div style={{ height: '1px', background: '#e5e7eb', margin: '0 20px' }} />

        {/* Текст письма */}
        <div
          className="simulex-content"
          style={{
            padding: '20px',
            overflowY: 'auto',
            flex: 1,
            whiteSpace: 'pre-wrap',
            lineHeight: '1.6',
            color: '#374151',
            fontSize: '15px'
          }}
        >
          {email.body}
        </div>

        {/* Кнопка «Закрыть» */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid #e5e7eb',
            display: 'flex',
            justifyContent: 'flex-end',
            background: 'white'
          }}
        >
          <button
            onClick={handleClose}
            style={{
              padding: '10px 24px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 500,
              transition: 'background 0.2s'
            }}
            onMouseEnter={(e) => {
              e.target.style.background = '#2563eb';
            }}
            onMouseLeave={(e) => {
              e.target.style.background = '#3b82f6';
            }}
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
