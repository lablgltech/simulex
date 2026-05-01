import React, { useMemo } from 'react';
import { Card, Text, Metric, Grid, Flex, ProgressBar } from '@tremor/react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  ScatterChart, Scatter, ZAxis, AreaChart, Area,
} from 'recharts';
import { SECTION_IDS, PARAMS, PARAM_META, to10Scale } from './constants';

function MiniKpi({ label, value, sub, color }) {
  return (
    <Card className="p-3" decoration="top" decorationColor={color || 'blue'}>
      <Text className="text-xs text-gray-500">{label}</Text>
      <Metric className="text-lg mt-1">{value ?? '—'}</Metric>
      {sub && <Text className="text-xs text-gray-400 mt-0.5">{sub}</Text>}
    </Card>
  );
}

export default function TrendsAndRoiSection({ trendsData, proxyRoi, correlationsData }) {
  const series = trendsData?.series || [];

  const chartData = useMemo(() => {
    return series.map((s) => ({
      month: s.month?.slice(0, 7) || '—',
      ...Object.fromEntries(PARAMS.map((p) => [p, s[p] != null ? to10Scale(s[p]) : null])),
      total: s.total != null ? to10Scale(s.total) : null,
    }));
  }, [series]);

  const corrAvailable = correlationsData?.available;
  const rawCorrPoints = correlationsData?.points || [];
  const corrPoints = useMemo(() => {
    return rawCorrPoints.map((pt) => ({
      ...pt,
      total_score: pt.total_score != null ? to10Scale(pt.total_score) : 0,
    }));
  }, [rawCorrPoints]);
  const pearson = correlationsData?.pearson_tutor_messages_vs_total;

  return (
    <section id={SECTION_IDS.trends} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', marginBottom: '16px' }}>
        Динамика и эффективность
      </h2>

      {/* ROI proxy KPIs */}
      <Grid numItems={2} numItemsMd={4} className="gap-3 mb-4">
        <MiniKpi
          label="Ср. длительность"
          value={proxyRoi?.avg_session_hours != null ? `${proxyRoi.avg_session_hours} ч` : '—'}
          sub="по лучшей попытке"
          color="indigo"
        />
        <MiniKpi
          label="% завершения"
          value={proxyRoi?.completion_rate != null ? `${Math.round(proxyRoi.completion_rate * 100)}%` : '—'}
          sub="лучшие сессии"
          color="emerald"
        />
        <MiniKpi
          label="Δ между попытками"
          value={proxyRoi?.avg_score_delta_repeats != null ? `±${proxyRoi.avg_score_delta_repeats}` : '—'}
          sub={`пар с повтором: ${proxyRoi?.repeats_with_delta_count ?? 0}`}
          color="amber"
        />
        <MiniKpi
          label="Корреляция тьютор/балл"
          value={pearson != null ? pearson : '—'}
          sub={corrAvailable ? `n=${correlationsData.n}` : `нужно ≥${correlationsData?.min_n ?? 15} точек`}
          color="violet"
        />
      </Grid>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {/* LEXIC trends line chart */}
        <Card>
          <Text className="font-semibold mb-2">Динамика LEXIC по месяцам</Text>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 10]} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} formatter={(val) => typeof val === 'number' ? val.toFixed(1) : val} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                {PARAMS.map((p) => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={p}
                    stroke={PARAM_META[p].color}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    name={PARAM_META[p].label}
                    connectNulls
                  />
                ))}
                <Line type="monotone" dataKey="total" stroke="#1e293b" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3 }} name="Итого" connectNulls />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <Text className="text-gray-400">Нет данных по месяцам (нужны завершённые сессии).</Text>
          )}
        </Card>

        {/* Correlation scatter */}
        <Card>
          <Text className="font-semibold mb-2">Сообщения тьютора vs итоговый балл</Text>
          {corrAvailable && corrPoints.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={230}>
                <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" dataKey="tutor_messages" name="Сообщений" tick={{ fontSize: 10 }}
                    label={{ value: 'Сообщений тьютора →', position: 'bottom', offset: -5, fontSize: 10 }} />
                  <YAxis type="number" dataKey="total_score" name="Балл" domain={[0, 10]} tick={{ fontSize: 10 }} />
                  <ZAxis range={[30, 30]} />
                  <Tooltip
                    content={({ payload }) => {
                      if (!payload?.[0]) return null;
                      const d = payload[0].payload;
                      return (
                        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '6px 10px', fontSize: '11px' }}>
                          <strong>{d.name}</strong>
                          <div>Сообщений: {d.tutor_messages}, Балл: {typeof d.total_score === 'number' ? d.total_score.toFixed(1) : '—'} / 10</div>
                        </div>
                      );
                    }}
                  />
                  <Scatter data={corrPoints.slice(0, 120)} fill="#8b5cf6" fillOpacity={0.6} />
                </ScatterChart>
              </ResponsiveContainer>
              {correlationsData.disclaimer && (
                <Text className="text-xs text-gray-400 mt-1">{correlationsData.disclaimer}</Text>
              )}
            </>
          ) : (
            <Text className="text-gray-400">
              Для корреляции нужно не менее {correlationsData?.min_n ?? 15} точек. Сейчас: {correlationsData?.n ?? 0}.
            </Text>
          )}
        </Card>
      </div>
    </section>
  );
}
