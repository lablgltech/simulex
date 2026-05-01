import React, { useMemo } from 'react';
import { Card, Text, Badge } from '@tremor/react';
import LexicRadarChart from '../LexicRadarChart';
import { SECTION_IDS, PARAMS, PARAM_META, DEFAULT_REFERENCE, to10Scale } from './constants';

export default function TeamCompetencySection({ overview, caseMetrics }) {
  const groupProfile = caseMetrics?.group_profile ?? null;
  const belowPct = caseMetrics?.below_threshold_pct ?? {};

  const gapData = useMemo(() => {
    if (!groupProfile) return [];
    return PARAMS.map((p) => {
      const avg = to10Scale(groupProfile[p] ?? 0);
      const ref = to10Scale(DEFAULT_REFERENCE[p]);
      const delta = Math.round((avg - ref) * 10) / 10;
      return {
        param: p,
        name: PARAM_META[p].label,
        avg,
        delta,
        below: belowPct[p] != null ? `${Math.round(belowPct[p])}%` : '—',
        priority: delta < -1.5 ? 'high' : delta < -0.5 ? 'medium' : 'low',
      };
    });
  }, [groupProfile, belowPct]);

  if (!groupProfile) {
    return (
      <section id={SECTION_IDS.competency} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', marginBottom: '16px' }}>
          Профиль компетенций
        </h2>
        <Card>
          <Text className="text-gray-400">Выберите кейс для отображения профиля компетенций.</Text>
        </Card>
      </section>
    );
  }

  return (
    <section id={SECTION_IDS.competency} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', marginBottom: '16px' }}>
        Профиль компетенций команды
      </h2>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
          gap: '20px',
          alignItems: 'start',
        }}
      >
        <Card style={{ overflow: 'visible' }}>
          <div style={{ marginBottom: '14px' }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: '#111827', lineHeight: 1.3 }}>
              Карта компетенций LEXIC
            </div>
            <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '6px', lineHeight: 1.35 }}>
              Группа vs эталон
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              width: '100%',
              minHeight: '320px',
              overflow: 'visible',
              padding: '4px 0 8px',
            }}
          >
            <LexicRadarChart
              lexic={groupProfile}
              referenceProfile={DEFAULT_REFERENCE}
              industryProfile={overview?.industry_reference_profile || null}
              size={260}
              showLegend={false}
              hideTitle
            />
          </div>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '4px', fontSize: '11px', color: '#6b7280' }}>
            <span>🔵 Группа</span>
            <span>⬜ Эталон</span>
            {overview?.industry_reference_profile && <span>🟣 Отрасль</span>}
          </div>
        </Card>

        <Card style={{ overflow: 'visible' }}>
          <Text className="font-semibold mb-3">Разрывы компетенций</Text>
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={{ width: '100%', minWidth: '520px', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600, minWidth: '160px' }}>Ось</th>
                  <th style={{ textAlign: 'right', padding: '8px', fontWeight: 600 }}>Среднее</th>
                  <th style={{ textAlign: 'right', padding: '8px', fontWeight: 600 }}>Δ от эталона</th>
                  <th style={{ textAlign: 'right', padding: '8px', fontWeight: 600 }}>% ниже 60</th>
                  <th style={{ textAlign: 'center', padding: '8px', fontWeight: 600 }}>Приоритет</th>
                </tr>
              </thead>
              <tbody>
                {gapData.map((d) => (
                  <tr key={d.param} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td
                      style={{ padding: '8px', fontWeight: 500, whiteSpace: 'nowrap' }}
                      title={`${PARAM_META[d.param]?.icon || ''} ${d.name}`.trim()}
                    >
                      {PARAM_META[d.param]?.icon} {d.name}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', fontWeight: 600, color: d.avg >= 7.5 ? '#10b981' : d.avg >= 5.5 ? '#3b82f6' : '#ef4444' }}>
                      {d.avg.toFixed(1)}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', color: d.delta >= 0 ? '#10b981' : '#ef4444' }}>
                      {d.delta >= 0 ? '+' : ''}{d.delta.toFixed(1)}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', color: '#6b7280' }}>{d.below}</td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>
                      <Badge color={d.priority === 'high' ? 'red' : d.priority === 'medium' ? 'amber' : 'emerald'} size="xs">
                        {d.priority === 'high' ? 'Высокий' : d.priority === 'medium' ? 'Средний' : 'Норма'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </section>
  );
}
