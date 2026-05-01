import React, { useState, useEffect, useRef } from 'react';

/**
 * Компонент отображения параметров LEXIC с анимацией
 */
export default function LexicPanel({ lexic, previousLexic = null, showChanges = false }) {
  const [displayedLexic, setDisplayedLexic] = useState(lexic);
  const [animating, setAnimating] = useState(false);
  const animationRef = useRef(null);

  // Анимация изменения значений
  useEffect(() => {
    if (!previousLexic || !showChanges) {
      setDisplayedLexic(lexic);
      return;
    }

    setAnimating(true);
    
    // Анимируем каждое значение от предыдущего к новому
    const duration = 800; // миллисекунды
    const steps = 30;
    const stepDuration = duration / steps;
    let currentStep = 0;

    const animate = () => {
      currentStep++;
      const progress = currentStep / steps;
      const easeProgress = 1 - Math.pow(1 - progress, 3); // easing function

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

  const getParameterColor = (value) => {
    if (value >= 70) return '#10b981'; // green
    if (value >= 40) return '#f59e0b'; // yellow
    return '#ef4444'; // red
  };

  const getParameterLabel = (key) => {
    const labels = {
      'L': { name: 'Легитимность', desc: 'Соблюдение регламентов, процедур, сроков', icon: '⚖️' },
      'E': { name: 'Эффективность', desc: 'Оптимальное использование ресурсов: время, бюджет', icon: '⚡' },
      'X': { name: 'Экспертиза', desc: 'Глубина анализа, качество оценки, работа с рисками', icon: '🔍' },
      'I': { name: 'Интересы', desc: 'Защита компании, баланс рисков, сохранение репутации', icon: '🛡️' },
      'C': { name: 'Ясность', desc: 'Четкость изложения, структурированность, понятность для бизнеса', icon: '💡' }
    };
    return labels[key] || { name: key, desc: '', icon: '' };
  };

  const getChangeIndicator = (key) => {
    if (!previousLexic || !showChanges) return null;
    const change = lexic[key] - previousLexic[key];
    if (change === 0) return null;
    
    const isPositive = change > 0;
    return (
      <span style={{
        fontSize: '12px',
        fontWeight: 'bold',
        color: isPositive ? '#10b981' : '#ef4444',
        marginLeft: '8px',
        animation: animating ? 'pulse 0.5s ease-in-out' : 'none'
      }}>
        {isPositive ? '↑' : '↓'} {Math.abs(change)}
      </span>
    );
  };

  const lexicParams = ['L', 'E', 'X', 'I', 'C'];

  return (
    <div style={{
      background: 'white',
      borderRadius: '8px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      padding: '20px',
      transition: 'all 0.3s ease'
    }}>
      <h3 style={{
        fontSize: '18px',
        fontWeight: 'bold',
        color: '#1f2937',
        marginBottom: '20px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
      }}>
        📊 Параметры LEXIC
      </h3>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {lexicParams.map(key => {
          const value = displayedLexic[key] || 0;
          const label = getParameterLabel(key);
          const color = getParameterColor(value);
          
          return (
            <div key={key} style={{
              transition: 'all 0.3s ease',
              transform: animating ? 'scale(1.02)' : 'scale(1)'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '6px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '16px' }}>{label.icon}</span>
                  <span style={{
                    fontSize: '14px',
                    fontWeight: '600',
                    color: '#374151'
                  }}>
                    {key} - {label.name}
                  </span>
                  {getChangeIndicator(key)}
                </div>
                <span style={{
                  fontSize: '18px',
                  fontWeight: 'bold',
                  color: color,
                  transition: 'color 0.3s ease'
                }}>
                  {value}%
                </span>
              </div>
              
              {/* Прогресс-бар */}
              <div style={{
                width: '100%',
                height: '8px',
                background: '#e5e7eb',
                borderRadius: '4px',
                overflow: 'hidden',
                position: 'relative'
              }}>
                <div
                  style={{
                    height: '100%',
                    background: color,
                    borderRadius: '4px',
                    width: `${Math.min(100, Math.max(0, value))}%`,
                    transition: animating ? 'width 0.8s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.3s ease' : 'width 0.3s ease, background-color 0.3s ease',
                    boxShadow: animating ? `0 0 8px ${color}40` : 'none'
                  }}
                />
              </div>
              
              <p style={{
                fontSize: '11px',
                color: '#6b7280',
                marginTop: '4px',
                marginBottom: 0
              }}>
                {label.desc}
              </p>
            </div>
          );
        })}
      </div>

      {/* Средний балл */}
      <div style={{
        marginTop: '20px',
        padding: '12px',
        background: '#eff6ff',
        borderRadius: '6px',
        border: '1px solid #dbeafe'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{
            fontSize: '14px',
            fontWeight: '600',
            color: '#374151'
          }}>
            Средний балл:
          </span>
          <span style={{
            fontSize: '24px',
            fontWeight: 'bold',
            color: '#3b82f6'
          }}>
            {Math.round(
              (displayedLexic.L + displayedLexic.E + displayedLexic.X + 
               displayedLexic.I + displayedLexic.C) / 5
            )}%
          </span>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
