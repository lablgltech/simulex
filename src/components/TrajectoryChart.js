import React, { useState } from 'react';

/**
 * Линейный график динамики LEXIC по этапам.
 * 
 * Props:
 *   stageSnapshots  Array  — массив снимков из lexic_normalized.stages
 *   growthPoints    Array  — точки роста/снижения
 *   width           number
 *   height          number
 */
const PARAM_META = {
  L: { label: 'Легитимность', color: '#3b82f6', icon: '⚖️' },
  E: { label: 'Эффективность', color: '#10b981', icon: '⚡' },
  X: { label: 'Экспертиза', color: '#f59e0b', icon: '🔍' },
  I: { label: 'Интересы', color: '#ef4444', icon: '🛡️' },
  C: { label: 'Ясность', color: '#8b5cf6', icon: '💡' },
};

const PARAMS = ['L', 'E', 'X', 'I', 'C'];

export default function TrajectoryChart({
  stageSnapshots = [],
  growthPoints = [],
  width = 600,
  height = 280,
}) {
  const [visibleParams, setVisibleParams] = useState(new Set(PARAMS));
  const [tooltip, setTooltip] = useState(null);

  if (!stageSnapshots || stageSnapshots.length < 2) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af', fontSize: '14px' }}>
        Данные траектории доступны после прохождения нескольких этапов
      </div>
    );
  }

  const paddingLeft = 48;
  const paddingRight = 24;
  const paddingTop = 20;
  const paddingBottom = 48;
  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  const stageCount = stageSnapshots.length;
  const xStep = chartW / (stageCount - 1);

  const toX = (i) => paddingLeft + i * xStep;
  const toY = (val) => paddingTop + chartH - (val / 100) * chartH;

  const toggleParam = (p) => {
    setVisibleParams((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        if (next.size > 1) next.delete(p); // оставляем хотя бы один
      } else {
        next.add(p);
      }
      return next;
    });
  };

  // Горизонтальные линии сетки: 25, 50, 75, 100
  const gridLines = [25, 50, 75, 100];

  return (
    <div>
      <h3 style={{ fontSize: '18px', fontWeight: 'bold', color: '#1f2937', marginBottom: '12px' }}>
        📈 Динамика по этапам
      </h3>

      {/* Переключатель параметров */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {PARAMS.map((p) => (
          <button
            key={p}
            onClick={() => toggleParam(p)}
            style={{
              padding: '4px 10px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: '600',
              cursor: 'pointer',
              border: `2px solid ${PARAM_META[p].color}`,
              background: visibleParams.has(p) ? PARAM_META[p].color : 'white',
              color: visibleParams.has(p) ? 'white' : PARAM_META[p].color,
              transition: 'all 0.15s',
            }}
          >
            {PARAM_META[p].icon} {p}
          </button>
        ))}
      </div>

      <svg width={width} height={height} style={{ overflow: 'visible' }}>
        {/* Горизонтальные линии сетки */}
        {gridLines.map((v) => (
          <g key={v}>
            <line
              x1={paddingLeft}
              y1={toY(v)}
              x2={paddingLeft + chartW}
              y2={toY(v)}
              stroke="#f3f4f6"
              strokeWidth="1"
              strokeDasharray={v === 50 ? '6,3' : '3,3'}
            />
            <text x={paddingLeft - 6} y={toY(v) + 4} textAnchor="end" fontSize="10" fill="#9ca3af">
              {v}
            </text>
          </g>
        ))}

        {/* Вертикальные линии по этапам */}
        {stageSnapshots.map((snap, i) => (
          <g key={i}>
            <line
              x1={toX(i)}
              y1={paddingTop}
              x2={toX(i)}
              y2={paddingTop + chartH}
              stroke="#f3f4f6"
              strokeWidth="1"
            />
            <text
              x={toX(i)}
              y={paddingTop + chartH + 16}
              textAnchor="middle"
              fontSize="11"
              fill="#6b7280"
            >
              Э{snap.stage_order || i + 1}
            </text>
            <text
              x={toX(i)}
              y={paddingTop + chartH + 28}
              textAnchor="middle"
              fontSize="9"
              fill="#9ca3af"
            >
              {snap.stage_code?.replace('stage-', 'Этап ') || ''}
            </text>
          </g>
        ))}

        {/* Линии и точки по параметрам */}
        {PARAMS.filter((p) => visibleParams.has(p)).map((p) => {
          const dataPoints = stageSnapshots.map((snap, i) => {
            const val = (snap.normalized_scores || {})[p];
            if (val == null) return null;
            return { x: toX(i), y: toY(val), val, i };
          });

          const validPts = dataPoints.filter(Boolean);
          if (validPts.length < 1) return null;

          // SVG path
          let pathD = '';
          validPts.forEach((pt, vi) => {
            pathD += vi === 0 ? `M ${pt.x} ${pt.y}` : ` L ${pt.x} ${pt.y}`;
          });

          return (
            <g key={p}>
              {/* Линия */}
              <path
                d={pathD}
                fill="none"
                stroke={PARAM_META[p].color}
                strokeWidth="2"
                strokeLinejoin="round"
              />
              {/* Точки */}
              {validPts.map((pt) => (
                <circle
                  key={pt.i}
                  cx={pt.x}
                  cy={pt.y}
                  r="5"
                  fill={PARAM_META[p].color}
                  stroke="white"
                  strokeWidth="2"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) =>
                    setTooltip({
                      x: pt.x,
                      y: pt.y,
                      label: `${PARAM_META[p].icon} ${PARAM_META[p].label}: ${Math.round(pt.val)}`,
                      stage: stageSnapshots[pt.i]?.stage_code,
                    })
                  }
                  onMouseLeave={() => setTooltip(null)}
                />
              ))}
            </g>
          );
        })}

        {/* Tooltip */}
        {tooltip && (
          <g>
            <rect
              x={tooltip.x + 8}
              y={tooltip.y - 22}
              width={200}
              height={24}
              rx="4"
              fill="rgba(17,24,39,0.85)"
            />
            <text x={tooltip.x + 14} y={tooltip.y - 6} fontSize="11" fill="white">
              {tooltip.label}
            </text>
          </g>
        )}
      </svg>

      {/* Точки роста/снижения */}
      {growthPoints && growthPoints.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>
            Ключевые моменты:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {growthPoints.slice(0, 6).map((pt, i) => (
              <div
                key={i}
                style={{
                  padding: '4px 10px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  background: pt.type === 'growth' ? '#d1fae5' : '#fee2e2',
                  color: pt.type === 'growth' ? '#065f46' : '#991b1b',
                }}
              >
                {pt.type === 'growth' ? '↑' : '↓'} {PARAM_META[pt.param]?.icon} {pt.param_name} Э
                {pt.stage_order} ({pt.delta > 0 ? '+' : ''}{pt.delta})
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
