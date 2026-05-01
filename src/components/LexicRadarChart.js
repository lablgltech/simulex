import React, { useState } from 'react';
import { getSummaryGrade } from '../utils/reportSummaryGrade';

/**
 * Компонент карты компетенций LEXIC (Radar Chart)
 * Поддерживает наложение слоёв: участник, эталон, группа.
 * 
 * Props:
 *   lexic          {L,E,X,I,C}  — профиль участника (0-100)
 *   referenceProfile {L,E,X,I,C} — эталонный профиль (опционально)
 *   groupProfile  {L,E,X,I,C}  — средний профиль группы (опционально)
 *   industryProfile {L,E,X,I,C} — внешний ориентир из конфига (опционально)
 *   normalizedLexic {L,E,X,I,C} — нормализованные значения (предпочтение при наличии)
 *   size          number         — размер SVG (px)
 *   showLegend    boolean        — показать легенду
 *   showLevels    boolean        — показать цветовые уровни
 *   axisValueDisplay 'percent'|'grade'|'number' — подпись в легенде под диаграммой: %, словесный уровень или целое 0–100
 *   hideTitle — не рендерить заголовок «Карта компетенций» (встроенный блок)
 *   groupLayerLegendLabel — подпись для пунктира «группа» в легенде слоёв
 */
export default function LexicRadarChart({
  lexic,
  referenceProfile = null,
  groupProfile = null,
  industryProfile = null,
  normalizedLexic = null,
  size = 300,
  showLegend = true,
  showLevels = false,
  axisValueDisplay = 'percent',
  hideTitle = false,
  groupLayerLegendLabel = 'Группа',
}) {
  const [hoveredParam, setHoveredParam] = useState(null);

  if (!lexic) return null;

  // Используем нормализованные значения если есть, иначе сырые
  const displayLexic = normalizedLexic || lexic;

  const centerX = size / 2;
  const centerY = size / 2;
  const maxValue = 100;
  const radius = size * 0.38;

  const parameters = [
    { key: 'L', label: 'Легитимность', color: '#3b82f6', icon: '⚖️' },
    { key: 'E', label: 'Эффективность', color: '#10b981', icon: '⚡' },
    { key: 'X', label: 'Экспертиза', color: '#f59e0b', icon: '🔍' },
    { key: 'I', label: 'Интересы', color: '#ef4444', icon: '🛡️' },
    { key: 'C', label: 'Ясность', color: '#8b5cf6', icon: '💡' },
  ];

  const angleStep = (2 * Math.PI) / 5;
  const startAngle = -Math.PI / 2;

  // Цветовые уровни по значению
  const getLevelColor = (value) => {
    if (value >= 85) return '#10b981';
    if (value >= 70) return '#3b82f6';
    if (value >= 50) return '#f59e0b';
    if (value >= 30) return '#f97316';
    return '#ef4444';
  };

  const getPoints = (data) =>
    parameters.map((param, index) => {
      const angle = startAngle + index * angleStep;
      const value = (data && data[param.key]) || 0;
      const normalizedValue = value / maxValue;
      const distance = radius * normalizedValue;
      return {
        ...param,
        angle,
        value,
        x: centerX + distance * Math.cos(angle),
        y: centerY + distance * Math.sin(angle),
        distance,
        normalizedValue,
        labelX: centerX + (radius + 28) * Math.cos(angle),
        labelY: centerY + (radius + 28) * Math.sin(angle),
      };
    });

  const getPolygonPath = (pts) =>
    pts.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ') + ' Z';

  const getGridPoints = (scale) =>
    parameters.map((_, i) => {
      const angle = startAngle + i * angleStep;
      return {
        x: centerX + radius * scale * Math.cos(angle),
        y: centerY + radius * scale * Math.sin(angle),
      };
    });

  const playerPoints = getPoints(displayLexic);
  const refPoints = referenceProfile ? getPoints(referenceProfile) : null;
  const groupPoints = groupProfile ? getPoints(groupProfile) : null;
  const industryPoints = industryProfile ? getPoints(industryProfile) : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        maxWidth: '100%',
        overflow: 'visible',
      }}
    >
      {!hideTitle && (
        <h2 style={{ fontSize: '22px', fontWeight: 'bold', marginBottom: '20px', color: '#1f2937' }}>
          Карта компетенций LEXIC
        </h2>
      )}

      <div
        style={{
          position: 'relative',
          width: size + 60,
          height: size + 60,
          maxWidth: '100%',
          padding: '12px',
          boxSizing: 'content-box',
          overflow: 'visible',
        }}
      >
        <svg width={size + 60} height={size + 60} style={{ overflow: 'visible', display: 'block', margin: 0 }}>
          {/* Сетка: концентрические многоугольники */}
          {[0.25, 0.5, 0.75, 1].map((scale, si) => {
            const pts = getGridPoints(scale);
            const path = pts.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ') + ' Z';
            return (
              <path
                key={si}
                d={path}
                fill="none"
                stroke="#e5e7eb"
                strokeWidth="1"
                strokeDasharray={scale < 1 ? '4,4' : 'none'}
              />
            );
          })}

          {/* Оси */}
          {playerPoints.map((p, i) => (
            <line
              key={i}
              x1={centerX}
              y1={centerY}
              x2={centerX + radius * Math.cos(p.angle)}
              y2={centerY + radius * Math.sin(p.angle)}
              stroke="#d1d5db"
              strokeWidth="1"
              strokeDasharray="4,4"
            />
          ))}

          {/* Слой: средний по группе (если есть) */}
          {groupPoints && (
            <path
              d={getPolygonPath(groupPoints)}
              fill="rgba(16,185,129,0.1)"
              stroke="#10b981"
              strokeWidth="1.5"
              strokeDasharray="6,3"
              opacity={0.7}
            />
          )}

          {/* Слой: эталон (если есть) */}
          {refPoints && (
            <path
              d={getPolygonPath(refPoints)}
              fill="rgba(107,114,128,0.08)"
              stroke="#9ca3af"
              strokeWidth="1.5"
              strokeDasharray="4,4"
            />
          )}

          {/* Слой: внешний ориентир (индустрия / конфиг) */}
          {industryPoints && (
            <path
              d={getPolygonPath(industryPoints)}
              fill="rgba(168,85,247,0.06)"
              stroke="#a855f7"
              strokeWidth="1.5"
              strokeDasharray="2,4"
              opacity={0.85}
            />
          )}

          {/* Слой: участник */}
          <path
            d={getPolygonPath(playerPoints)}
            fill="rgba(59,130,246,0.18)"
            stroke="#3b82f6"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />

          {/* Точки участника */}
          {playerPoints.map((p, i) => (
            <g
              key={i}
              onMouseEnter={() => setHoveredParam(p.key)}
              onMouseLeave={() => setHoveredParam(null)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={hoveredParam === p.key ? 9 : 6}
                fill={showLevels ? getLevelColor(p.value) : p.color}
                stroke="white"
                strokeWidth="2"
                style={{ transition: 'r 0.15s' }}
              />
            </g>
          ))}

          {/* Метки параметров */}
          {playerPoints.map((p, i) => {
            const isLeft = p.labelX < centerX - 5;
            const anchor = isLeft ? 'end' : p.labelX > centerX + 5 ? 'start' : 'middle';
            return (
              <g key={`label-${i}`}>
                <text
                  x={p.labelX}
                  y={p.labelY - 6}
                  textAnchor={anchor}
                  fontSize="11"
                  fontWeight="600"
                  fill="#374151"
                >
                  {p.icon} {p.key}
                </text>
                <text
                  x={p.labelX}
                  y={p.labelY + 7}
                  textAnchor={anchor}
                  fontSize="9"
                  fill="#9ca3af"
                >
                  {p.label}
                </text>
              </g>
            );
          })}

          {/* Центральная точка */}
          <circle cx={centerX} cy={centerY} r="3" fill="#3b82f6" />
        </svg>
      </div>

      {/* Легенда слоёв */}
      {(refPoints || groupPoints || industryPoints) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', marginBottom: '12px', fontSize: '11px', color: '#6b7280' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <svg width="20" height="3"><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="#3b82f6" strokeWidth="2.5" /></svg>
            Участник
          </span>
          {refPoints && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <svg width="20" height="3"><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="#9ca3af" strokeWidth="1.5" strokeDasharray="4,4" /></svg>
              Эталон
            </span>
          )}
          {groupPoints && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <svg width="20" height="3"><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="#10b981" strokeWidth="1.5" strokeDasharray="6,3" /></svg>
              {groupLayerLegendLabel}
            </span>
          )}
          {industryPoints && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <svg width="20" height="3"><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="#a855f7" strokeWidth="1.5" strokeDasharray="2,4" /></svg>
              Ориентир
            </span>
          )}
        </div>
      )}

      {/* Легенда параметров */}
      {showLegend && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '8px',
            marginTop: '12px',
            width: '100%',
            maxWidth: '560px',
          }}
        >
          {playerPoints.map((p, i) => (
            <div
              key={i}
              onMouseEnter={() => setHoveredParam(p.key)}
              onMouseLeave={() => setHoveredParam(null)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '8px 4px',
                background: hoveredParam === p.key ? '#f0f9ff' : '#f9fafb',
                borderRadius: '6px',
                border: `1px solid ${hoveredParam === p.key ? '#bfdbfe' : 'transparent'}`,
                cursor: 'default',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontSize: '18px', marginBottom: '2px' }}>{p.icon}</div>
              <div style={{ fontSize: '11px', fontWeight: 'bold', color: showLevels ? getLevelColor(p.value) : p.color }}>
                {p.key}
              </div>
              <div style={{ fontSize: '9px', color: '#9ca3af', textAlign: 'center' }}>{p.label}</div>
              <div
                style={{
                  fontSize: axisValueDisplay === 'grade' ? '9px' : '14px',
                  fontWeight: 'bold',
                  color:
                    axisValueDisplay === 'grade'
                      ? getSummaryGrade(p.value).accent
                      : showLevels
                        ? getLevelColor(p.value)
                        : p.color,
                  marginTop: '2px',
                  lineHeight: axisValueDisplay === 'grade' ? 1.2 : undefined,
                  textAlign: 'center',
                  maxWidth: '100%',
                }}
              >
                {axisValueDisplay === 'grade'
                  ? getSummaryGrade(p.value).label
                  : axisValueDisplay === 'number'
                    ? String(Math.round(p.value))
                    : `${Math.round(p.value)}%`}
              </div>
              {referenceProfile && referenceProfile[p.key] != null && (
                <div style={{ fontSize: '9px', color: '#9ca3af' }}>
                  эт: {referenceProfile[p.key]}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
