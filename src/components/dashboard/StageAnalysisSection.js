import React, { useMemo } from 'react';
import { Card, Text, Badge, Flex } from '@tremor/react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { SECTION_IDS, PARAMS, PARAM_META, to10Scale } from './constants';

const ZONE_STYLES = {
  critical: { bg: '#fef2f2', border: '#fecaca', label: 'Критично', badge: 'red' },
  attention: { bg: '#fffbeb', border: '#fde68a', label: 'Внимание', badge: 'amber' },
  strong: { bg: '#ecfdf5', border: '#a7f3d0', label: 'Норма', badge: 'emerald' },
};

function HeatmapCell({ value }) {
  const v10 = value != null ? to10Scale(value) : null;
  const bg = v10 == null ? '#f9fafb' : v10 < 5.2 ? '#fee2e2' : v10 < 7 ? '#fef9c3' : '#d1fae5';
  const color = v10 == null ? '#9ca3af' : '#0f172a';
  return (
    <td style={{ padding: '8px 12px', textAlign: 'center', background: bg, fontWeight: 600, color, border: '1px solid #f1f5f9', fontSize: '13px' }}>
      {v10 != null ? v10.toFixed(1) : '—'}
    </td>
  );
}

export default function StageAnalysisSection({ systemGaps, proxyRoi }) {
  const stages = systemGaps?.stages || [];
  const heatmap = systemGaps?.heatmap || {};
  const heatStages = ['stage-1', 'stage-2', 'stage-3', 'stage-4'].filter((s) => heatmap[s]);

  const stackedData = useMemo(() => {
    return stages.map((s) => {
      const entry = { name: s.label || s.stage_code };
      for (const p of PARAMS) {
        entry[p] = s.param_avgs?.[p] != null ? to10Scale(s.param_avgs[p]) : 0;
      }
      return entry;
    });
  }, [stages]);

  const timeData = useMemo(() => {
    if (!proxyRoi) return [];
    return [
      { label: 'Ср. длительность', value: proxyRoi.avg_session_hours != null ? `${proxyRoi.avg_session_hours} ч` : '—' },
      { label: 'Завершение', value: proxyRoi.completion_rate != null ? `${Math.round(proxyRoi.completion_rate * 100)}%` : '—' },
    ];
  }, [proxyRoi]);

  if (!stages.length && !heatStages.length) {
    return (
      <section id={SECTION_IDS.stages} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', marginBottom: '16px' }}>Анализ по этапам</h2>
        <Card><Text className="text-gray-400">Нет данных по этапам.</Text></Card>
      </section>
    );
  }

  return (
    <section id={SECTION_IDS.stages} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', marginBottom: '16px' }}>
        Анализ по этапам
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        {/* Heatmap */}
        <Card>
          <Text className="font-semibold mb-3">Тепловая карта: этап × параметр</Text>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '13px', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>Этап</th>
                  {PARAMS.map((p) => (
                    <th key={p} style={{ padding: '6px 8px', textAlign: 'center', color: PARAM_META[p].color, fontWeight: 600 }}>{p}</th>
                  ))}
                  <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 600 }}>Ср.</th>
                </tr>
              </thead>
              <tbody>
                {heatStages.map((sc) => {
                  const rawVals = PARAMS.map((p) => heatmap[sc]?.[p]).filter((v) => v != null);
                  const avg = rawVals.length ? rawVals.reduce((s, v) => s + v, 0) / rawVals.length : null;
                  return (
                    <tr key={sc}>
                      <td style={{ padding: '6px 8px', fontWeight: 600, fontSize: '12px' }}>{sc.replace('stage-', 'Э')}</td>
                      {PARAMS.map((p) => <HeatmapCell key={p} value={heatmap[sc]?.[p]} />)}
                      <HeatmapCell value={avg} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Stacked bar */}
        <Card>
          <Text className="font-semibold mb-2">Баллы по этапам (по осям)</Text>
          {stackedData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={stackedData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                {PARAMS.map((p) => (
                  <Bar key={p} dataKey={p} stackId="a" fill={PARAM_META[p].color} name={PARAM_META[p].label} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Text className="text-gray-400">Нет данных</Text>
          )}
        </Card>
      </div>

      {/* Stage zone cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {stages.map((st) => {
          const style = ZONE_STYLES[st.zone] || ZONE_STYLES.attention;
          return (
            <Card key={st.stage_code} style={{ background: style.bg, border: `1px solid ${style.border}` }} className="p-4">
              <Flex className="items-center gap-2 mb-2">
                <Text className="font-bold">{st.label}</Text>
                <Badge color={style.badge} size="xs">{style.label}</Badge>
                <Text className="text-xs text-gray-500">n={st.participant_count}</Text>
                {st.overall_avg != null && <Text className="text-xs text-gray-500">среднее: {to10Scale(st.overall_avg).toFixed(1)}</Text>}
              </Flex>
              <Flex className="gap-3 mb-2 flex-wrap">
                {PARAMS.map((p) =>
                  st.param_avgs?.[p] != null ? (
                    <span key={p} style={{ fontSize: '12px', color: PARAM_META[p].color, fontWeight: 600 }}>
                      {PARAM_META[p].icon} {p}: {to10Scale(st.param_avgs[p]).toFixed(1)}
                    </span>
                  ) : null
                )}
              </Flex>
              <Text className="text-sm text-gray-700"><strong>Рекомендация:</strong> {st.recommendation}</Text>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
