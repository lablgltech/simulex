import React, { useEffect, useRef } from 'react';
import { useHighlightRect } from '../hooks/useHighlightRect';

/**
 * Затемнение экрана с подсветкой одного элемента по data-tutor-highlight="id".
 * По клику по overlay или Escape — закрытие.
 */
export default function TutorSpotlightOverlay({ highlightId, onClose }) {
  const rect = useHighlightRect(highlightId);
  const overlayRef = useRef(null);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  if (!highlightId) return null;

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        cursor: 'pointer',
      }}
    >
      {rect && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            borderRadius: 8,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.7)',
            border: '3px solid rgba(59, 130, 246, 0.95)',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
