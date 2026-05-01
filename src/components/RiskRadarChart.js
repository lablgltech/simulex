import React, { useState, useRef, useEffect } from 'react';

/**
 * Радар рисков: круг разделён на 4 зоны. Цвета и легенда по референсу, приглушённые тона.
 * Порядок на круге: верх = Юридические, право = Финансовые, низ = Репутационные, лево = Операционные.
 */
const ZONES = [
  { id: 'legal', label: 'Юридические', color: '#8b89a8' },
  { id: 'financial', label: 'Финансовые', color: '#7a9f7e' },
  { id: 'reputational', label: 'Репутационные', color: '#b8956e' },
  { id: 'operational', label: 'Операционные', color: '#7a9bb5' },
];

function polarToCart(cx, cy, angle, distance) {
  return {
    x: cx + distance * Math.cos(angle),
    y: cy + distance * Math.sin(angle),
  };
}

function cartToPolar(cx, cy, x, y) {
  const dx = x - cx;
  const dy = y - cy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  return { angle, distance };
}

/** Угол в [-PI, PI] → id зоны. Верх = legal, право = financial, низ = reputational, лево = operational */
function angleToZoneId(angle) {
  if (angle >= -Math.PI / 2 && angle < 0) return 'legal';
  if (angle >= 0 && angle < Math.PI / 2) return 'financial';
  if (angle >= Math.PI / 2 && angle < Math.PI) return 'reputational';
  return 'operational';
}

/** Убирает символы markdown */
function stripMarkdown(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/_([^_]*)_/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .trim();
}

export default function RiskRadarChart({
  clauses = [],
  placementsByZone = {},
  onPlacementChange,
  onDone,
  size = 420,
  readOnly = false,
  processDropRef: processDropRefProp,
  onDragStart: onDragStartProp,
}) {
  const [draggingClauseId, setDraggingClauseId] = useState(null);
  const [selectedClauseId, setSelectedClauseId] = useState(null);
  const selectedClauseIdRef = useRef(null);
  const draggingClauseRef = useRef(null);
  const radarRef = useRef(null);
  const dropZoneRef = useRef(null);
  selectedClauseIdRef.current = selectedClauseId;

  const padding = 80;
  const chartW = size + 2 * padding;
  const radius = (size / 2) * 0.9;
  const cx = size / 2;
  const cy = size / 2;

  const propsRef = useRef({ onPlacementChange, size, padding, radius });
  propsRef.current = { onPlacementChange, size, padding, radius };

  /** По координатам клика возвращает zoneId, если точка внутри круга, иначе null */
  const getZoneFromClientCoords = React.useCallback((clientX, clientY) => {
    const el = dropZoneRef.current || radarRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return null;
    const x = clientX - rect.left - padding;
    const y = clientY - rect.top - padding;
    const centerX = size / 2;
    const centerY = size / 2;
    const { angle, distance } = cartToPolar(centerX, centerY, x, y);
    if (distance > radius) return null;
    return angleToZoneId(angle);
  }, [padding, size, radius]);

  const processDrop = React.useCallback((clientX, clientY) => {
    const clauseId = draggingClauseRef.current;
    if (clauseId == null) return;
    const { onPlacementChange: onPlace, size: sz, padding: pad, radius: r } = propsRef.current;
    if (!onPlace) return;
    const el = dropZoneRef.current || radarRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const x = clientX - rect.left - pad;
    const y = clientY - rect.top - pad;
    const centerX = sz / 2;
    const centerY = sz / 2;
    const { angle, distance } = cartToPolar(centerX, centerY, x, y);
    if (distance <= r) {
      const zoneId = angleToZoneId(angle);
      onPlace(clauseId, zoneId);
      setSelectedClauseId(null);
    }
    draggingClauseRef.current = null;
    setDraggingClauseId(null);
  }, []);

  useEffect(() => {
    if (processDropRefProp) processDropRefProp.current = processDrop;
    return () => {
      if (processDropRefProp) processDropRefProp.current = null;
    };
  }, [processDrop, processDropRefProp]);

  const handleClauseMouseDown = (e, clauseId) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const id = clauseId != null ? String(clauseId) : null;
    draggingClauseRef.current = id;
    setDraggingClauseId(clauseId);
    setSelectedClauseId(clauseId);
    if (onDragStartProp) onDragStartProp(clauseId);
    // Всегда вешаем свой mouseup: не полагаемся на родителя — иначе после Светофора drop не срабатывает
    const handler = (upEvent) => {
      document.removeEventListener('mouseup', handler, true);
      if (draggingClauseRef.current == null) return;
      processDrop(upEvent.clientX, upEvent.clientY);
    };
    document.addEventListener('mouseup', handler, true);
  };

  const handleRadarMouseUp = (e) => {
    if (draggingClauseRef.current != null) {
      processDrop(e.clientX, e.clientY);
      return;
    }
    const sel = selectedClauseIdRef.current;
    if (sel && onPlacementChange) {
      const zoneId = getZoneFromClientCoords(e.clientX, e.clientY);
      if (zoneId) {
        onPlacementChange(sel, zoneId);
        setSelectedClauseId(null);
      }
    }
  };

  /** Клик по пункту — выбор для размещения */
  const handleClauseClick = (e, clauseId) => {
    if (readOnly) return;
    e.stopPropagation();
    setSelectedClauseId((prev) => (prev === clauseId ? null : clauseId));
  };

  /** Клик по кругу радара — разместить выбранный пункт в зону (работает всегда) */
  const handleRadarZoneClick = (e) => {
    if (readOnly || !selectedClauseId || !onPlacementChange) return;
    e.preventDefault();
    e.stopPropagation();
    const zoneId = getZoneFromClientCoords(e.clientX, e.clientY);
    if (zoneId) {
      onPlacementChange(selectedClauseId, zoneId);
      setSelectedClauseId(null);
    }
  };

  const handleDragStart = (e, clauseId) => {
    if (readOnly) return;
    const id = String(clauseId);
    draggingClauseRef.current = id;
    setDraggingClauseId(id);
    try {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'copy';
    } catch (_) {}
  };

  const handleDragEnd = () => {
    draggingClauseRef.current = null;
    setDraggingClauseId(null);
  };

  const handleRadarDragOver = (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const handleRadarDragEnter = (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const handleRadarDrop = (e) => {
    e.preventDefault();
    let clauseId = draggingClauseRef.current;
    if (!clauseId && e.dataTransfer) clauseId = e.dataTransfer.getData('text/plain');
    if (!clauseId || !onPlacementChange) {
      draggingClauseRef.current = null;
      setDraggingClauseId(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - padding;
    const y = e.clientY - rect.top - padding;
    const { angle, distance } = cartToPolar(cx, cy, x, y);
    if (distance <= radius) {
      const zoneId = angleToZoneId(angle);
      onPlacementChange(clauseId, zoneId);
    }
    draggingClauseRef.current = null;
    setDraggingClauseId(null);
  };

  // Сектора: угол начала для каждой зоны (верх = -90°, по часовой)
  const sectorStartAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
  const sectorAngles = ZONES.map((z, i) => ({
    ...z,
    startAngle: sectorStartAngles[i],
    endAngle: sectorStartAngles[(i + 1) % 4] + (i === 3 ? 2 * Math.PI : 0),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'row', width: '100%', gap: 32, alignItems: 'flex-start', minHeight: 0 }}>
        <div style={{ flex: '0 0 280px', minWidth: 0, maxWidth: 360 }}>
          <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10, fontWeight: 600 }}>Пункты договора</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 520, overflowY: 'auto' }}>
            {clauses.map(({ clauseId, clauseLabel }) => (
              <div
                key={clauseId}
                role="button"
                tabIndex={0}
                draggable={!readOnly}
                onClick={(e) => handleClauseClick(e, clauseId)}
                onMouseDown={(e) => handleClauseMouseDown(e, clauseId)}
                onDragStart={(e) => handleDragStart(e, clauseId)}
                onDragEnd={handleDragEnd}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClauseClick(e, clauseId); } }}
                style={{
                  padding: '12px 16px',
                  background: selectedClauseId === clauseId ? '#dbeafe' : draggingClauseId === clauseId ? '#dbeafe' : '#f1f5f9',
                  border: `2px solid ${selectedClauseId === clauseId ? '#2563eb' : '#94a3b8'}`,
                  borderRadius: 10,
                  cursor: readOnly ? 'default' : 'grab',
                  fontWeight: 500,
                  fontSize: 14,
                  color: '#334155',
                  userSelect: 'none',
                  lineHeight: 1.4,
                  wordBreak: 'break-word',
                  whiteSpace: 'normal',
                }}
              >
                {stripMarkdown(clauseLabel) || clauseId}
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'center', minWidth: 0 }}>
          <div
            ref={radarRef}
            style={{
              position: 'relative',
              width: chartW,
              height: chartW,
              flexShrink: 0,
              cursor: draggingClauseId ? 'copy' : 'default',
            }}
          >
            <svg
              width={chartW}
              height={chartW}
              viewBox={`0 0 ${chartW} ${chartW}`}
              style={{ display: 'block', overflow: 'visible', pointerEvents: 'none' }}
            >
              <defs>
                <filter id="radarZoneShadow" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="1" stdDeviation="1" floodOpacity="0.15" />
                </filter>
              </defs>
              <g transform={`translate(${padding}, ${padding})`}>
                {sectorAngles.map((zone, i) => {
                  const start = sectorStartAngles[i];
                  const end = sectorStartAngles[(i + 1) % 4];
                  const endAngle = i === 3 ? end + 2 * Math.PI : end;
                  const largeArc = endAngle - start >= Math.PI ? 1 : 0;
                  const x1 = cx + radius * Math.cos(start);
                  const y1 = cy + radius * Math.sin(start);
                  const x2 = cx + radius * Math.cos(endAngle);
                  const y2 = cy + radius * Math.sin(endAngle);
                  const d = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
                  const clauseIds = placementsByZone[zone.id] || [];
                  const midAngle = start + (endAngle - start) / 2;
                  const numbersDist = radius * 0.4;
                  const numbersX = cx + numbersDist * Math.cos(midAngle);
                  const numbersY = cy + numbersDist * Math.sin(midAngle);
                  return (
                    <g key={zone.id}>
                      <path
                        d={d}
                        fill={`${zone.color}44`}
                        stroke="none"
                        filter="url(#radarZoneShadow)"
                      />
                      <text
                        x={numbersX}
                        y={numbersY}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={14}
                        fill="#1f2937"
                        fontWeight={700}
                      >
                        {clauseIds.length > 0 ? clauseIds.join(', ') : ''}
                      </text>
                    </g>
                  );
                })}
                <circle cx={cx} cy={cy} r={8} fill="#64748b" stroke="#fff" strokeWidth={2} />
              </g>
            </svg>
            {/* Слой поверх SVG — клик по зоне размещает выбранный пункт; также drop и mouseup для перетаскивания */}
            <div
              ref={dropZoneRef}
              role="button"
              tabIndex={0}
              data-radar-drop-zone
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 10,
                pointerEvents: 'auto',
                cursor: selectedClauseId ? 'pointer' : 'default',
              }}
              onClick={handleRadarZoneClick}
              onMouseUp={handleRadarMouseUp}
              onDragEnter={handleRadarDragEnter}
              onDragOver={handleRadarDragOver}
              onDrop={handleRadarDrop}
            />
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 24,
              marginTop: 16,
              flexWrap: 'wrap',
            }}
          >
            {ZONES.map((zone) => (
              <div
                key={zone.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 2,
                    backgroundColor: zone.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 14, color: '#334155', fontWeight: 500 }}>
                  {zone.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {!readOnly && onDone && (
        <div style={{ marginTop: 24 }}>
          <button
            type="button"
            onClick={onDone}
            style={{
              padding: '12px 32px',
              fontSize: 16,
              border: '2px solid #16a34a',
              background: '#dcfce7',
              color: '#15803d',
              borderRadius: 10,
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            Передать боссу!
          </button>
        </div>
      )}
    </div>
  );
}

export { ZONES };
