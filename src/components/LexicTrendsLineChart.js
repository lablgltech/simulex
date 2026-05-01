import React, { useMemo, useState } from 'react';

const PARAMS = ['L', 'E', 'X', 'I', 'C'];
const COLORS = { L: '#3b82f6', E: '#10b981', X: '#f59e0b', I: '#ef4444', C: '#8b5cf6', total: '#64748b' };

/**
 * series: [{ month, L, E, X, I, C, total, sessions }]
 */
export default function LexicTrendsLineChart({ series = [], width = 520, height = 220 }) {
  const [mode, setMode] = useState('lexic');

  const chart = useMemo(() => {
    const padL = 44;
    const padR = 16;
    const padT = 12;
    const padB = 36;
    const w = width - padL - padR;
    const h = height - padT - padB;
    if (!series.length) {
      return { paths: [], xLabels: [], yTicks: [], padL, padT, w, h, height };
    }

    const n = series.length;
    const xAt = (i) => padL + (n <= 1 ? w / 2 : (i / (n - 1)) * w);

    let vmin = 100;
    let vmax = 0;
    for (const row of series) {
      if (mode === 'total') {
        const v = row.total;
        if (v != null) {
          vmin = Math.min(vmin, v);
          vmax = Math.max(vmax, v);
        }
      } else {
        for (const p of PARAMS) {
          const v = row[p];
          if (v != null) {
            vmin = Math.min(vmin, v);
            vmax = Math.max(vmax, v);
          }
        }
      }
    }
    if (vmin >= vmax) {
      vmin = Math.max(0, vmin - 10);
      vmax = Math.min(100, vmax + 10);
    }
    const lo = Math.floor((vmin - 5) / 10) * 10;
    const hi = Math.ceil((vmax + 5) / 10) * 10;
    const y0 = Math.max(0, lo);
    const y1 = Math.min(100, hi);
    const ySpan = y1 - y0 || 1;

    const yAt = (val) => padT + h - ((val - y0) / ySpan) * h;

    const linePath = (key) => {
      const pts = [];
      series.forEach((row, i) => {
        const v = row[key];
        if (v == null) return;
        pts.push({ x: xAt(i), y: yAt(v) });
      });
      if (pts.length < 2) return null;
      return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    };

    const pathList = [];
    if (mode === 'total') {
      const d = linePath('total');
      if (d) pathList.push({ key: 'total', d, color: COLORS.total });
    } else {
      for (const p of PARAMS) {
        const d = linePath(p);
        if (d) pathList.push({ key: p, d, color: COLORS[p] });
      }
    }

    const xLabels = series.map((row, i) => ({
      x: xAt(i),
      text: row.month ? String(row.month).slice(0, 7) : `${i + 1}`,
    }));

    const step = ySpan <= 30 ? 10 : 20;
    const yTicks = [];
    for (let t = y0; t <= y1 + 0.01; t += step) {
      yTicks.push({ v: t, y: yAt(t) });
    }

    return { paths: pathList, xLabels, yTicks, padL, padT, w, h, height };
  }, [series, width, height, mode]);

  if (!series.length) {
    return (
      <div style={{ fontSize: '13px', color: '#94a3b8', padding: '16px' }}>
        Недостаточно завершённых сессий с нормализованным LEXIC для графика по месяцам.
      </div>
    );
  }

  const { paths, xLabels, yTicks, padL, padT, w, h } = chart;

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setMode('lexic')}
          style={{
            padding: '4px 12px',
            borderRadius: '8px',
            border: '2px solid #e5e7eb',
            background: mode === 'lexic' ? '#3b82f6' : 'white',
            color: mode === 'lexic' ? 'white' : '#374151',
            fontSize: '12px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          L, E, X, I, C
        </button>
        <button
          type="button"
          onClick={() => setMode('total')}
          style={{
            padding: '4px 12px',
            borderRadius: '8px',
            border: '2px solid #e5e7eb',
            background: mode === 'total' ? '#3b82f6' : 'white',
            color: mode === 'total' ? 'white' : '#374151',
            fontSize: '12px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Средний итог
        </button>
      </div>
      <svg width={width} height={height} style={{ display: 'block' }}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={padL + w} y2={t.y} stroke="#f1f5f9" strokeWidth="1" />
            <text x={padL - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
              {Math.round(t.v)}
            </text>
          </g>
        ))}
        {paths.map((p) => (
          <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeWidth="2" strokeLinejoin="round" />
        ))}
        {xLabels.map((lb, i) => (
          <text key={i} x={lb.x} y={height - 10} textAnchor="middle" fontSize="9" fill="#64748b">
            {lb.text}
          </text>
        ))}
      </svg>
      {mode === 'lexic' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '8px', fontSize: '11px' }}>
          {PARAMS.map((p) => (
            <span key={p} style={{ color: COLORS[p], fontWeight: 600 }}>
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
