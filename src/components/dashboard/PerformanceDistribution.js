import React, { useMemo } from 'react';
import { Card, Text, Badge, Flex } from '@tremor/react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  ScatterChart, Scatter, ZAxis, ReferenceLine,
} from 'recharts';
import { SECTION_IDS, PARAMS, PARAM_META, to10Scale } from './constants';

const TIER_COLORS = { poor: '#ef4444', fair: '#f59e0b', good: '#3b82f6', excellent: '#10b981' };
const Q_SPLIT = to10Scale(60);

function BoxPlotSvg({ data }) {
  if (!data) return null;
  const { min, q1, median, q3, max, mean } = data;
  const W = 300, H = 80, pad = 40;
  const range = (max - min) || 1;
  const x = (v) => pad + ((v - min) / range) * (W - pad * 2);

  return (
    <svg width={W} height={H} style={{ display: 'block', margin: '0 auto' }}>
      {/* whisker line */}
      <line x1={x(min)} y1={H / 2} x2={x(max)} y2={H / 2} stroke="#94a3b8" strokeWidth={1} />
      {/* whisker ends */}
      <line x1={x(min)} y1={H / 2 - 10} x2={x(min)} y2={H / 2 + 10} stroke="#94a3b8" strokeWidth={2} />
      <line x1={x(max)} y1={H / 2 - 10} x2={x(max)} y2={H / 2 + 10} stroke="#94a3b8" strokeWidth={2} />
      {/* box */}
      <rect x={x(q1)} y={H / 2 - 16} width={x(q3) - x(q1)} height={32} fill="#dbeafe" stroke="#3b82f6" strokeWidth={1.5} rx={4} />
      {/* median */}
      <line x1={x(median)} y1={H / 2 - 16} x2={x(median)} y2={H / 2 + 16} stroke="#1d4ed8" strokeWidth={2.5} />
      {/* mean diamond */}
      <circle cx={x(mean)} cy={H / 2} r={4} fill="#ef4444" />
      {/* labels */}
      <text x={x(min)} y={H / 2 + 28} textAnchor="middle" fontSize="10" fill="#64748b">{min.toFixed(1)}</text>
      <text x={x(q1)} y={H / 2 - 22} textAnchor="middle" fontSize="10" fill="#64748b">Q1:{q1.toFixed(1)}</text>
      <text x={x(median)} y={H / 2 - 22} textAnchor="middle" fontSize="10" fill="#1d4ed8">Мед:{median.toFixed(1)}</text>
      <text x={x(q3)} y={H / 2 + 28} textAnchor="middle" fontSize="10" fill="#64748b">Q3:{q3.toFixed(1)}</text>
      <text x={x(max)} y={H / 2 + 28} textAnchor="middle" fontSize="10" fill="#64748b">{max.toFixed(1)}</text>
    </svg>
  );
}

export default function PerformanceDistribution({ distData, participants, onDrill }) {
  const scatterData = useMemo(() => {
    return (participants || [])
      .filter((p) => p.X != null && p.E != null)
      .map((p) => ({
        x: to10Scale(p.X),
        y: to10Scale(p.E),
        name: p.name || '—',
        session_id: p.session_id,
        score: to10Scale(p.total_score ?? 0),
      }));
  }, [participants]);

  const histogram = distData?.histogram || [];
  const rawBoxPlot = distData?.box_plot;
  const boxPlot = useMemo(() => {
    if (!rawBoxPlot) return null;
    return {
      min: to10Scale(rawBoxPlot.min),
      q1: to10Scale(rawBoxPlot.q1),
      median: to10Scale(rawBoxPlot.median),
      q3: to10Scale(rawBoxPlot.q3),
      max: to10Scale(rawBoxPlot.max),
      mean: to10Scale(rawBoxPlot.mean),
    };
  }, [rawBoxPlot]);
  const quartileGroups = distData?.quartile_groups || {};
  const tiers = distData?.score_tiers || {};

  return (
    <section id={SECTION_IDS.distribution} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', marginBottom: '16px' }}>
        Распределение результатов
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        {/* Histogram */}
        <Card>
          <Text className="font-semibold mb-2">Распределение баллов</Text>
          {histogram.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={histogram} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
                <Bar dataKey="count" name="Участников" radius={[4, 4, 0, 0]}>
                  {histogram.map((entry, i) => (
                    <Cell key={i} fill={TIER_COLORS[entry.tier] || '#94a3b8'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Text className="text-gray-400">Нет данных</Text>
          )}
          {Object.keys(tiers).length > 0 && (
            <Flex className="mt-2 gap-2 flex-wrap">
              {tiers.excellent > 0 && <Badge color="emerald" size="xs">Отлично: {tiers.excellent}</Badge>}
              {tiers.good > 0 && <Badge color="blue" size="xs">Хорошо: {tiers.good}</Badge>}
              {tiers.fair > 0 && <Badge color="amber" size="xs">Удовл.: {tiers.fair}</Badge>}
              {tiers.poor > 0 && <Badge color="red" size="xs">Слабо: {tiers.poor}</Badge>}
            </Flex>
          )}
        </Card>

        {/* Scatter: X vs E */}
        <Card>
          <Text className="font-semibold mb-2">Экспертиза (X) × Эффективность (E)</Text>
          {scatterData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis type="number" dataKey="x" name="X" domain={[0, 10]} tick={{ fontSize: 11 }} label={{ value: 'Экспертиза →', position: 'bottom', offset: -5, fontSize: 11 }} />
                <YAxis type="number" dataKey="y" name="E" domain={[0, 10]} tick={{ fontSize: 11 }} label={{ value: 'E ↑', position: 'insideTopLeft', offset: 0, fontSize: 11 }} />
                <ZAxis range={[50, 50]} />
                <ReferenceLine x={Q_SPLIT} stroke="#94a3b8" strokeDasharray="4 4" />
                <ReferenceLine y={Q_SPLIT} stroke="#94a3b8" strokeDasharray="4 4" />
                <Tooltip
                  content={({ payload }) => {
                    if (!payload?.[0]) return null;
                    const d = payload[0].payload;
                    return (
                      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '8px 12px', fontSize: '12px' }}>
                        <strong>{d.name}</strong>
                        <div>X: {d.x.toFixed(1)}, E: {d.y.toFixed(1)}</div>
                        <div>Итого: {d.score.toFixed(1)} / 10</div>
                      </div>
                    );
                  }}
                />
                <Scatter
                  data={scatterData}
                  fill="#3b82f6"
                  fillOpacity={0.7}
                  cursor="pointer"
                  onClick={(data) => data?.session_id && onDrill?.(data.session_id)}
                />
              </ScatterChart>
            </ResponsiveContainer>
          ) : (
            <Text className="text-gray-400">Нет данных по X и E</Text>
          )}
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {/* Box plot */}
        <Card>
          <Text className="font-semibold mb-2">Размах баллов (box-plot)</Text>
          {boxPlot ? (
            <>
              <BoxPlotSvg data={boxPlot} />
              <Flex className="mt-2 justify-center gap-3">
                <Text className="text-xs text-gray-500">🔴 Среднее  ▬ Медиана</Text>
              </Flex>
            </>
          ) : (
            <Text className="text-gray-400">Нет данных</Text>
          )}
        </Card>

        {/* Quartile table */}
        <Card>
          <Text className="font-semibold mb-2">Группы по квартилям</Text>
          <div style={{ fontSize: '13px' }}>
            {[
              { key: 'q1', label: 'Q1: Требуют внимания', color: '#fef2f2', border: '#fecaca' },
              { key: 'q2', label: 'Q2: Развиваются', color: '#fffbeb', border: '#fde68a' },
              { key: 'q3', label: 'Q3: Хороший уровень', color: '#eff6ff', border: '#bfdbfe' },
              { key: 'q4', label: 'Q4: Лидеры', color: '#ecfdf5', border: '#a7f3d0' },
            ].map((q) => {
              const list = quartileGroups[q.key] || [];
              return (
                <div key={q.key} style={{ background: q.color, border: `1px solid ${q.border}`, borderRadius: '8px', padding: '8px 12px', marginBottom: '8px' }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '12px' }}>{q.label} ({list.length})</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {list.slice(0, 8).map((p, i) => (
                      <span
                        key={p.session_id || i}
                        onClick={() => onDrill?.(p.session_id)}
                        style={{
                          padding: '2px 8px',
                          background: 'white',
                          borderRadius: '4px',
                          fontSize: '11px',
                          cursor: 'pointer',
                          border: '1px solid #e5e7eb',
                        }}
                      >
                        {p.name}: {to10Scale(p.total_score ?? 0).toFixed(1)}
                      </span>
                    ))}
                    {list.length > 8 && <span style={{ fontSize: '11px', color: '#9ca3af' }}>+{list.length - 8}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </section>
  );
}
