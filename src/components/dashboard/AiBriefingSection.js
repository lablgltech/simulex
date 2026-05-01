import React from 'react';
import { Card, Metric, Text, Grid } from '@tremor/react';
import { SECTION_IDS, PARAM_META, to10Scale } from './constants';

function formatBriefingInstant(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return String(iso);
  }
}

function KpiCard({ label, value, sub, color }) {
  return (
    <Card className="p-4" decoration="top" decorationColor={color || 'blue'}>
      <Text className="text-xs uppercase tracking-wide text-gray-500">{label}</Text>
      <Metric className="mt-1" style={{ color: color || '#1f2937' }}>{value ?? '—'}</Metric>
      {sub && <Text className="mt-1 text-xs text-gray-400">{sub}</Text>}
    </Card>
  );
}

export default function AiBriefingSection({
  briefingData,
  overview,
  caseMetrics,
  loading,
  onRequestBriefing,
  aiBriefingStale = false,
  contextSessionsCount,
}) {
  const gp = caseMetrics?.group_profile;
  const worst = caseMetrics?.worst_param;
  const worstAvg = worst && gp ? to10Scale(gp[worst] ?? 0) : null;

  const hasBriefingPayload = briefingData != null;
  const noSessionsInScope = contextSessionsCount === 0;
  const briefingButtonDisabled = loading || noSessionsInScope;
  const briefingButtonLabel = hasBriefingPayload ? 'Обновить ИИ-брифинг' : 'Сформировать ИИ-брифинг';

  return (
    <section id={SECTION_IDS.briefing} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '16px',
        }}
      >
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', margin: 0 }}>
          AI-брифинг руководителя
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
          {hasBriefingPayload && briefingData.generated_at && (
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              Сформирован: {formatBriefingInstant(briefingData.generated_at)}
            </span>
          )}
          {hasBriefingPayload && !aiBriefingStale && briefingData.data_latest_session_updated_at && (
            <span style={{ fontSize: '12px', color: '#059669', fontWeight: 600 }}>
              Актуален относительно сессий (нет правок после снимка данных)
            </span>
          )}
          {hasBriefingPayload && aiBriefingStale && (
            <span style={{ fontSize: '12px', color: '#b45309', fontWeight: 600 }}>
              Есть новые или изменённые сессии после последнего брифинга — обновите
            </span>
          )}
          <button
            type="button"
            onClick={() => onRequestBriefing?.()}
            disabled={briefingButtonDisabled || typeof onRequestBriefing !== 'function'}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
              background: briefingButtonDisabled ? '#f1f5f9' : '#1e293b',
              color: briefingButtonDisabled ? '#94a3b8' : '#fff',
              cursor: briefingButtonDisabled ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 600,
            }}
          >
            {loading ? 'Запрос к модели…' : briefingButtonLabel}
          </button>
        </div>
      </div>

      {!hasBriefingPayload && !loading && (
        <Card className="mb-4" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
          <Text className="text-sm text-slate-600" style={{ lineHeight: 1.6 }}>
            Текст брифинга и связанные с ним блоки ниже не запрашиваются автоматически: это отдельный запрос к
            языковой модели. Сначала подгружаются таблицы и метрики; брифинг — по кнопке.
            {noSessionsInScope && ' В текущих фильтрах нет сессий — сформировать брифинг не из чего.'}
          </Text>
        </Card>
      )}
      {!hasBriefingPayload && loading && (
        <Card className="mb-4">
          <Text className="text-gray-500">Запрашиваем ИИ-брифинг — это может занять несколько секунд.</Text>
        </Card>
      )}

      {/* AI briefing text */}
      {briefingData?.briefing_text ? (
        <Card className="mb-4">
          <div style={{ fontSize: '14px', lineHeight: 1.7, color: '#334155', whiteSpace: 'pre-line' }}>
            {briefingData.briefing_text}
          </div>
        </Card>
      ) : hasBriefingPayload ? (
        <Card className="mb-4">
          <Text className="text-gray-400">
            {loading ? 'Формируется аналитический брифинг...' : 'Недостаточно данных для брифинга.'}
          </Text>
        </Card>
      ) : null}

      {/* Alerts */}
      {briefingData?.alerts?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
          {briefingData.alerts.map((a, i) => (
            <div
              key={i}
              style={{
                padding: '10px 16px',
                borderRadius: '8px',
                fontSize: '13px',
                background: a.level === 'warning' ? '#fef3c7' : '#dbeafe',
                color: a.level === 'warning' ? '#92400e' : '#1e40af',
                border: `1px solid ${a.level === 'warning' ? '#fde68a' : '#93c5fd'}`,
              }}
            >
              {a.level === 'warning' ? '⚠️' : 'ℹ️'} {a.text}
            </div>
          ))}
        </div>
      )}

      {/* KPI cards */}
      <Grid numItems={2} numItemsMd={3} numItemsLg={4} className="gap-4">
        {caseMetrics ? (
          <>
            <KpiCard
              label="Участников"
              value={caseMetrics.participants ?? '—'}
              sub={`завершили: ${caseMetrics.completed ?? 0} (${caseMetrics.completion_rate != null ? Math.round(caseMetrics.completion_rate * 100) + '%' : '—'})`}
              color="#3b82f6"
            />
            <KpiCard
              label="Средний балл"
              value={caseMetrics.avg_score != null ? to10Scale(caseMetrics.avg_score).toFixed(1) + ' / 10' : '—'}
              sub={caseMetrics.score_std_dev != null ? `σ = ${caseMetrics.score_std_dev}` : ''}
              color="#f59e0b"
            />
            <KpiCard
              label="Слабая ось"
              value={worst ? `${PARAM_META[worst]?.icon || ''} ${PARAM_META[worst]?.label || worst}` : '—'}
              sub={worstAvg != null ? `среднее: ${worstAvg.toFixed(1)} / 10` : ''}
              color="#ef4444"
            />
            <KpiCard
              label="Группа риска / Лидеры"
              value={`${caseMetrics.risk_count ?? 0} / ${caseMetrics.leader_count ?? 0}`}
              sub="требуют внимания / потенциал"
              color="#8b5cf6"
            />
          </>
        ) : (
          <>
            <KpiCard
              label="Участников"
              value={overview?.unique_users ?? '—'}
              sub="все кейсы"
              color="#3b82f6"
            />
            <KpiCard
              label="Попыток"
              value={overview?.sessions_total ?? '—'}
              sub="сессий"
              color="#6366f1"
            />
            <KpiCard
              label="Средний балл"
              value={overview?.cross_case_avg_score != null ? to10Scale(overview.cross_case_avg_score).toFixed(1) + ' / 10' : '—'}
              sub="взвешено по кейсам"
              color="#f59e0b"
            />
            <KpiCard
              label="Кейсов"
              value={overview?.case_codes?.length ?? '—'}
              color="#8b5cf6"
            />
          </>
        )}
      </Grid>

    </section>
  );
}
