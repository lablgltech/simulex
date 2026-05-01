import React, { useState, useEffect, useRef } from 'react';

/**
 * Компактная панель LEXIC для HeaderBar.
 * Справа — кнопка тьютора с бейджем непрочитанных (если переданы onTutorClick и tutorUnreadCount).
 */
export default function CompactLexicBar({ lexic, previousLexic = null, showChanges = false, onTutorClick = null, tutorUnreadCount = 0 }) {
  const [displayedLexic, setDisplayedLexic] = useState(lexic || {});
  const [animating, setAnimating] = useState(false);
  const animationRef = useRef(null);

  // Анимация изменения значений
  useEffect(() => {
    if (!previousLexic || !showChanges || !lexic) {
      setDisplayedLexic(lexic || {});
      return;
    }

    setAnimating(true);
    const duration = 600;
    const steps = 20;
    const stepDuration = duration / steps;
    let currentStep = 0;

    const animate = () => {
      currentStep++;
      const progress = currentStep / steps;
      const easeProgress = 1 - Math.pow(1 - progress, 3);

      const newLexic = {};
      ['L', 'E', 'X', 'I', 'C'].forEach(key => {
        const start = previousLexic[key] || 0;
        const end = lexic[key] || 0;
        newLexic[key] = Math.round(start + (end - start) * easeProgress);
      });

      setDisplayedLexic(newLexic);

      if (currentStep < steps) {
        animationRef.current = setTimeout(animate, stepDuration);
      } else {
        setDisplayedLexic(lexic);
        setAnimating(false);
      }
    };

    animate();

    return () => {
      if (animationRef.current) {
        clearTimeout(animationRef.current);
      }
    };
  }, [lexic, previousLexic, showChanges]);

  if (!lexic) return null;

  const getParameterColor = (value) => {
    if (value >= 70) return '#10b981';
    if (value >= 40) return '#f59e0b';
    return '#ef4444';
  };

  const getChangeIndicator = (key) => {
    if (!previousLexic || !showChanges || !animating) return null;
    const change = lexic[key] - previousLexic[key];
    if (change === 0) return null;
    
    return (
      <span style={{
        fontSize: '10px',
        fontWeight: 'bold',
        color: change > 0 ? '#10b981' : '#ef4444',
        marginLeft: '4px',
        opacity: animating ? 1 : 0.7
      }}>
        {change > 0 ? '↑' : '↓'}
      </span>
    );
  };

  const parameters = [
    { key: 'L', label: 'L', icon: '⚖️', name: 'Легитимность' },
    { key: 'E', label: 'E', icon: '⚡', name: 'Эффективность' },
    { key: 'X', label: 'X', icon: '🔍', name: 'Экспертиза' },
    { key: 'I', label: 'I', icon: '🛡️', name: 'Интересы' },
    { key: 'C', label: 'C', icon: '💡', name: 'Ясность' }
  ];

  return (
    <div
      data-tutor-highlight="lexic"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '8px 16px',
        background: '#f9fafb',
        borderTop: '1px solid #e5e7eb',
        fontSize: '12px',
      }}
    >
      <div style={{
        color: '#6b7280',
        fontWeight: '500',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px'
      }}>
        LEXIC:
      </div>

      {parameters.map((param, index) => {
        const value = displayedLexic[param.key] || 0;
        const color = getParameterColor(value);
        
        return (
          <div
            key={param.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              position: 'relative'
            }}
            title={`${param.name}: ${value}%`}
          >
            <span style={{ fontSize: '14px' }}>{param.icon}</span>
            <span style={{
              fontWeight: '600',
              color: '#374151',
              minWidth: '20px',
              textAlign: 'right'
            }}>
              {value}
            </span>
            {/* Мини-прогресс бар */}
            <div style={{
              width: '30px',
              height: '4px',
              background: '#e5e7eb',
              borderRadius: '2px',
              overflow: 'hidden',
              position: 'relative'
            }}>
              <div style={{
                width: `${value}%`,
                height: '100%',
                background: color,
                borderRadius: '2px',
                transition: animating ? 'width 0.1s ease-out' : 'none'
              }} />
            </div>
            {getChangeIndicator(param.key)}
            {index < parameters.length - 1 && (
              <div style={{
                width: '1px',
                height: '16px',
                background: '#e5e7eb',
                marginLeft: '8px'
              }} />
            )}
          </div>
        );
      })}

      {onTutorClick && (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            onClick={onTutorClick}
            title="ИИ-наставник — Сергей Павлович"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              background: '#1e3a5f',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              position: 'relative',
              boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
            }}
          >
            <span role="img" aria-label="ИИ-наставник">💬</span>
            <span>ИИ-наставник</span>
            {tutorUnreadCount > 0 && (
              <span
                style={{
                  minWidth: '18px',
                  height: '18px',
                  borderRadius: '999px',
                  backgroundColor: '#f97316',
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 4px',
                }}
              >
                {tutorUnreadCount > 9 ? '9+' : tutorUnreadCount}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
