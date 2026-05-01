import React from 'react';

export default function ReadonlyComposer({ message }) {
  return (
    <div
      style={{
        borderTop: '1px solid #e2e8f0',
        background: '#f8fafc',
        padding: '10px 14px',
        textAlign: 'center',
        fontSize: 12,
        color: '#94a3b8',
        fontStyle: 'italic',
      }}
    >
      {message || 'Входящие сообщения'}
    </div>
  );
}
