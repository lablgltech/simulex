import React from 'react';
import { Card, Text, Badge, Flex, Grid } from '@tremor/react';
import { SECTION_IDS, translateNegotiationStyle, translateSignal } from './constants';

const SWOT_STYLES = {
  strengths: { title: 'Сильные стороны', bg: '#ecfdf5', border: '#a7f3d0', icon: '💪', color: '#065f46' },
  weaknesses: { title: 'Слабые стороны', bg: '#fef2f2', border: '#fecaca', icon: '📉', color: '#991b1b' },
  opportunities: { title: 'Возможности', bg: '#eff6ff', border: '#bfdbfe', icon: '🚀', color: '#1e40af' },
  threats: { title: 'Угрозы', bg: '#fffbeb', border: '#fde68a', icon: '⚠️', color: '#92400e' },
};

export default function ActionPlanSection({ briefingData, behaviorData, prioritiesData, onDrill }) {
  const swot = briefingData?.swot || {};
  const actionItems = briefingData?.action_items || [];
  const priorities = prioritiesData?.items || [];
  const criticalCount = prioritiesData?.critical_count ?? 0;

  const negStyles = behaviorData?.behavior?.negotiation_styles || [];
  const avgArg = behaviorData?.behavior?.avg_argumentation_level;
  const avgRisk = behaviorData?.behavior?.avg_risk_aversion;
  const avgRefl = behaviorData?.behavior?.avg_self_reflection;

  const downloadReport = () => {
    const lines = ['АНАЛИТИЧЕСКИЙ ОТЧЁТ РУКОВОДИТЕЛЯ', '='.repeat(40), ''];
    if (briefingData?.briefing_text) {
      lines.push('БРИФИНГ:', briefingData.briefing_text, '');
    }
    for (const [key, style] of Object.entries(SWOT_STYLES)) {
      const items = swot[key] || [];
      if (items.length) {
        lines.push(`${style.title.toUpperCase()}:`);
        items.forEach((item) => lines.push(`  - ${item}`));
        lines.push('');
      }
    }
    if (actionItems.length) {
      lines.push('ПЛАН ДЕЙСТВИЙ:');
      actionItems.forEach((item, i) => lines.push(`  ${i + 1}. ${item}`));
      lines.push('');
    }
    if (priorities.length) {
      lines.push('ПРИОРИТЕТЫ ВМЕШАТЕЛЬСТВА:');
      priorities.forEach((p) => {
        lines.push(`  [${p.priority}] ${p.name} (${p.case_code || '—'}): ${p.suggested_action}`);
      });
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `analytics_report_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section id={SECTION_IDS.actions} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
      <Flex className="items-center justify-between mb-4">
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', margin: 0 }}>
          Рекомендации и план действий
        </h2>
        <button
          type="button"
          onClick={downloadReport}
          style={{
            padding: '6px 14px', borderRadius: '8px', border: '1px solid #e5e7eb',
            background: 'white', cursor: 'pointer', fontSize: '13px', color: '#374151',
          }}
        >
          Скачать отчёт
        </button>
      </Flex>

      {/* SWOT — compact 2×2 */}
      <Grid numItems={2} className="gap-3 mb-4">
        {Object.entries(SWOT_STYLES).map(([key, style]) => {
          const items = swot[key] || [];
          return (
            <Card key={key} style={{ background: style.bg, border: `1px solid ${style.border}` }} className="p-3">
              <Text className="font-bold mb-1" style={{ color: style.color, fontSize: '13px' }}>
                {style.icon} {style.title}
              </Text>
              {items.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: '#334155', lineHeight: 1.5 }}>
                  {items.slice(0, 3).map((item, i) => <li key={i}>{item}</li>)}
                  {items.length > 3 && <li style={{ color: '#9ca3af' }}>+{items.length - 3} ещё</li>}
                </ul>
              ) : (
                <Text className="text-xs text-gray-400">—</Text>
              )}
            </Card>
          );
        })}
      </Grid>

      {/* Priorities table */}
      {priorities.length > 0 && (
        <Card className="mb-4">
          <Flex className="items-center gap-2 mb-3">
            <Text className="font-semibold">Кому уделить внимание</Text>
            {criticalCount > 0 && <Badge color="red" size="xs">{criticalCount} срочных</Badge>}
          </Flex>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600 }}>Участник</th>
                  <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600 }}>Сигналы</th>
                  <th style={{ textAlign: 'center', padding: '8px', fontWeight: 600 }}>Приоритет</th>
                  <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600 }}>Рекомендация</th>
                  <th style={{ padding: '8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {priorities.slice(0, 8).map((p, i) => (
                  <tr key={p.session_id || i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px', fontWeight: 500 }}>{p.name}</td>
                    <td style={{ padding: '8px', fontSize: '12px', color: '#475569' }}>{(p.signals || []).map(translateSignal).join(', ')}</td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>
                      <Badge color={p.priority === 'high' ? 'red' : 'amber'} size="xs">
                        {p.priority === 'high' ? 'высокий' : 'средний'}
                      </Badge>
                    </td>
                    <td style={{ padding: '8px', maxWidth: '280px', lineHeight: 1.4, fontSize: '12px' }}>{p.suggested_action}</td>
                    <td style={{ padding: '8px' }}>
                      <button
                        onClick={() => onDrill?.(p.session_id)}
                        style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid #cbd5e1', background: 'white', fontSize: '12px', cursor: 'pointer' }}
                      >
                        Отчёт
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Soft skills — compact inline */}
      {(avgArg != null || negStyles.length > 0) && (
        <Card className="p-3">
          <Flex className="items-center gap-4 flex-wrap">
            <Text className="font-semibold text-sm">Soft Skills:</Text>
            {avgArg != null && <Text className="text-sm">Аргументация <strong>{Math.round(avgArg * 100)}%</strong></Text>}
            {avgRisk != null && <Text className="text-sm">Риски <strong>{Math.round(avgRisk * 100)}%</strong></Text>}
            {avgRefl != null && <Text className="text-sm">Рефлексия <strong>{Math.round(avgRefl * 100)}%</strong></Text>}
            {negStyles.length > 0 && negStyles.map((s) => (
              <Badge key={s.style} color="indigo" size="xs">{translateNegotiationStyle(s.style)}: {s.count}</Badge>
            ))}
          </Flex>
        </Card>
      )}
    </section>
  );
}
