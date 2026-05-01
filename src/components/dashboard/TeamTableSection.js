import React, { useState, useMemo } from 'react';
import { Card, Text, Badge, Flex } from '@tremor/react';
import { SECTION_IDS, PARAMS, PARAM_META, to10Scale, scoreColor10 } from './constants';

function SparkLine({ data, width = 60, height = 20 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  const improving = data[data.length - 1] > data[0];
  return (
    <svg width={width} height={height} style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      <polyline points={points} fill="none" stroke={improving ? '#10b981' : '#ef4444'} strokeWidth={1.5} />
    </svg>
  );
}

function formatTime(seconds) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

export default function TeamTableSection({ participants, onDrill, showCaseColumn, caseTitles }) {
  const [sortBy, setSortBy] = useState('total_score');
  const [sortDir, setSortDir] = useState('desc');
  const [filterStatus, setFilterStatus] = useState('all');

  const filtered = useMemo(() => {
    let list = [...participants];
    if (filterStatus === 'completed') list = list.filter((p) => p.status === 'completed');
    if (filterStatus === 'in_progress') list = list.filter((p) => p.status !== 'completed');
    if (filterStatus === 'risk') list = list.filter((p) => p.risk);
    if (filterStatus === 'leader') list = list.filter((p) => p.leader);
    return list;
  }, [participants, filterStatus]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortBy] ?? -1;
      const bv = b[sortBy] ?? -1;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [filtered, sortBy, sortDir]);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('desc'); }
  };

  const sortIcon = (col) => {
    if (sortBy !== col) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  const thStyle = { padding: '8px', fontWeight: 600, fontSize: '12px', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' };

  return (
    <section id={SECTION_IDS.team} style={{ marginBottom: '32px', scrollMarginTop: '60px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1f2937', marginBottom: '16px' }}>
        Команда
      </h2>

      <Card>
        <Flex className="items-center gap-3 mb-4 flex-wrap">
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
            {[
              { id: 'all', label: 'Все' },
              { id: 'completed', label: 'Завершены' },
              { id: 'risk', label: 'Риск' },
              { id: 'leader', label: 'Лидеры' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setFilterStatus(f.id)}
                style={{
                  padding: '4px 10px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  border: '1px solid #e5e7eb',
                  background: filterStatus === f.id ? '#1e293b' : 'white',
                  color: filterStatus === f.id ? 'white' : '#6b7280',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </Flex>

        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Участник</th>
                  {showCaseColumn && <th style={{ ...thStyle, textAlign: 'left' }}>Кейс</th>}
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => handleSort('total_score')}>Балл (/10){sortIcon('total_score')}</th>
                  {PARAMS.map((p) => (
                    <th key={p} style={{ ...thStyle, textAlign: 'right', color: PARAM_META[p].color }} onClick={() => handleSort(p)}>
                      {p}{sortIcon(p)}
                    </th>
                  ))}
                  <th style={{ ...thStyle, textAlign: 'center' }}>Динамика</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => handleSort('attempts_count')}>Попыток{sortIcon('attempts_count')}</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Время</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>Статус</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr><td colSpan={10 + (showCaseColumn ? 1 : 0)} style={{ padding: '16px', textAlign: 'center', color: '#9ca3af' }}>Нет данных</td></tr>
                ) : sorted.map((p, i) => (
                  <tr
                    key={p.row_key || p.session_id || i}
                    onClick={() => onDrill?.(p.session_id)}
                    style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer', transition: 'background 0.1s' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f8fafc'}
                    onMouseLeave={(e) => e.currentTarget.style.background = ''}
                  >
                    <td style={{ padding: '8px', fontWeight: 500 }}>
                      {p.risk && <span title="Группа риска">⚠️ </span>}
                      {p.leader && <span title="Лидер">⭐ </span>}
                      {p.name || '—'}
                    </td>
                    {showCaseColumn && <td style={{ padding: '8px', color: '#6b7280', fontSize: '12px' }}>{(caseTitles && caseTitles[p.case_code]) || p.case_code || '—'}</td>}
                    <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700, color: p.total_score != null ? scoreColor10(to10Scale(p.total_score)) : undefined }}>
                      {p.total_score != null ? to10Scale(p.total_score).toFixed(1) : '—'}
                    </td>
                    {PARAMS.map((param) => (
                      <td key={param} style={{ padding: '8px', textAlign: 'right', color: p[param] != null ? scoreColor10(to10Scale(p[param])) : undefined }}>
                        {p[param] != null ? to10Scale(p[param]).toFixed(1) : '—'}
                      </td>
                    ))}
                    <td style={{ padding: '8px', textAlign: 'center' }}>
                      <SparkLine data={p.spark_data} />
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', color: '#6b7280' }}>{p.attempts_count ?? '—'}</td>
                    <td style={{ padding: '8px', textAlign: 'right', color: '#6b7280', fontSize: '12px' }}>{formatTime(p.time_spent_seconds)}</td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>
                      <Badge color={p.status === 'completed' ? 'emerald' : 'amber'} size="xs">
                        {p.status === 'completed' ? 'Завершён' : 'В процессе'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        <Text className="text-xs text-gray-400 mt-3">
          Строка = лучшая попытка на пару «участник × кейс». Баллы по шкале 0–10. Клик — полный отчёт.
        </Text>
      </Card>
    </section>
  );
}
