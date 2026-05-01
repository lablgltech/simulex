import React, { useState, useRef, useEffect } from 'react';
import '../simugram.css';

export default function SimpleComposer({ onSend, disabled, placeholder }) {
  const [value, setValue] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!disabled) {
      ref.current?.focus({ preventScroll: true });
    }
  }, [disabled]);

  const handleSend = () => {
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    setValue('');
    ref.current?.focus();
  };

  const hasText = value.trim().length > 0;

  return (
    <div className="simugram-composer">
      <textarea
        ref={ref}
        data-simugram-primary-input="true"
        className="simugram-composer-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder={placeholder || 'Сообщение…'}
        disabled={disabled}
        autoFocus
        rows={1}
        onInput={(e) => {
          e.target.style.height = 'auto';
          e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
        }}
      />
      <button
        type="button"
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        className={`simugram-composer-send${hasText ? ' simugram-composer-send--has-text' : ''}`}
        title="Отправить"
      >
        ➤
      </button>
    </div>
  );
}
