import React, { useState } from 'react';

export default function EmailInbox({ emails = [], onClose, onMarkAsRead }) {
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [filter, setFilter] = useState('all'); // all, unread, read

  const unreadCount = emails.filter(e => !e.read).length;
  const filteredEmails = filter === 'all' 
    ? emails 
    : filter === 'unread' 
      ? emails.filter(e => !e.read)
      : emails.filter(e => e.read);

  const handleEmailClick = (email) => {
    setSelectedEmail(email);
    if (!email.read && onMarkAsRead) {
      onMarkAsRead(email.id);
    }
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'white',
          width: '90%',
          maxWidth: '800px',
          height: '80%',
          maxHeight: '700px',
          borderRadius: '8px',
          boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 'bold' }}>📧 Почтовый ящик</h2>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              background: '#f3f4f6',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            ✕ Закрыть
          </button>
        </div>

        {/* Filters */}
        <div style={{
          padding: '15px 20px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          gap: '10px'
        }}>
          <button
            onClick={() => setFilter('all')}
            style={{
              padding: '6px 12px',
              background: filter === 'all' ? '#3b82f6' : '#f3f4f6',
              color: filter === 'all' ? 'white' : '#374151',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            Все ({emails.length})
          </button>
          <button
            onClick={() => setFilter('unread')}
            style={{
              padding: '6px 12px',
              background: filter === 'unread' ? '#3b82f6' : '#f3f4f6',
              color: filter === 'unread' ? 'white' : '#374151',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            Непрочитанные ({unreadCount})
          </button>
          <button
            onClick={() => setFilter('read')}
            style={{
              padding: '6px 12px',
              background: filter === 'read' ? '#3b82f6' : '#f3f4f6',
              color: filter === 'read' ? 'white' : '#374151',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            Прочитанные ({emails.length - unreadCount})
          </button>
        </div>

        {/* Content */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Email List */}
          <div style={{
            width: '300px',
            borderRight: '1px solid #e5e7eb',
            overflowY: 'auto',
            background: '#f9fafb'
          }}>
            {filteredEmails.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                Нет писем
              </div>
            ) : (
              filteredEmails.map((email) => (
                <div
                  key={email.id}
                  onClick={() => handleEmailClick(email)}
                  style={{
                    padding: '15px',
                    borderBottom: '1px solid #e5e7eb',
                    cursor: 'pointer',
                    background: selectedEmail?.id === email.id ? '#e0f2fe' : email.read ? 'white' : '#fef3c7',
                    borderLeft: selectedEmail?.id === email.id ? '3px solid #3b82f6' : 'none'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '5px' }}>
                    <div style={{ fontWeight: email.read ? 'normal' : 'bold', fontSize: '14px' }}>
                      {email.read ? '✓' : '●'} {email.from}
                    </div>
                    <div style={{ fontSize: '11px', color: '#666' }}>
                      {formatDate(email.timestamp)}
                    </div>
                  </div>
                  <div style={{ fontSize: '13px', color: '#374151', fontWeight: email.read ? 'normal' : 'bold' }}>
                    {email.subject}
                  </div>
                  {email.preview && (
                    <div style={{ fontSize: '12px', color: '#666', marginTop: '5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {email.preview}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Email Content */}
          <div style={{ flex: 1, padding: '20px', overflowY: 'auto' }}>
            {selectedEmail ? (
              <div>
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '5px' }}>
                    От: {selectedEmail.from}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '10px' }}>
                    Дата: {formatDate(selectedEmail.timestamp)}
                  </div>
                  <h3 style={{ margin: '0 0 15px 0', fontSize: '18px', fontWeight: 'bold' }}>
                    {selectedEmail.subject}
                  </h3>
                </div>
                <div
                  className="simulex-content"
                  style={{
                  lineHeight: '1.6',
                  color: '#374151',
                  whiteSpace: 'pre-wrap'
                }}
                >
                  {selectedEmail.body}
                </div>
                {selectedEmail.attachments && selectedEmail.attachments.length > 0 && (
                  <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #e5e7eb' }}>
                    <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '10px' }}>Вложения:</div>
                    {selectedEmail.attachments.map((att, idx) => (
                      <div key={idx} style={{ padding: '8px', background: '#f3f4f6', borderRadius: '4px', marginBottom: '5px' }}>
                        📎 {att.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', paddingTop: '100px', color: '#666' }}>
                Выберите письмо для просмотра
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
