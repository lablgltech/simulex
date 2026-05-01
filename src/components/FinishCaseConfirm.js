import React from 'react';

export default function FinishCaseConfirm({ onDismiss, onConfirm }) {
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
        zIndex: 2000,
      }}
      onClick={onDismiss}
    >
      <div
        style={{
          background: 'white',
          padding: '30px',
          borderRadius: '8px',
          maxWidth: '400px',
          boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, marginBottom: '15px' }}>⚠️ Завершить кейс?</h3>
        <p style={{ marginBottom: '20px', color: '#666', lineHeight: '1.6' }}>
          Вы уверены, что хотите завершить кейс? Весь прогресс будет потерян, и вы вернетесь на стартовое окно.
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onDismiss}
            style={{
              padding: '10px 20px',
              background: '#f3f4f6',
              color: '#374151',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              padding: '10px 20px',
              background: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold',
            }}
          >
            Да, завершить
          </button>
        </div>
      </div>
    </div>
  );
}
