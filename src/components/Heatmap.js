import React, { useMemo, useState } from 'react';

/**
 * Тепловая карта LEXIC: матрица участники × параметры.
 *
 * Props:
 *   data       Array<{name, L, E, X, I, C, total_score, session_id, case_code?, attempts_count?, user_id?}>
 *   onRowClick  (session_id) => void — drill-down по участнику
 *   showCaseColumn  показывать колонку «Кейс»
 *   showAttempts    показывать число попыток по этому кейсу
 *   groupByUser     при true и нескольких кейсах — одна строка на участника, детали по кейсам под «+»
 */

const PARAMS = ['L', 'E', 'X', 'I', 'C'];
const PARAM_META = {
  L: { label: 'Легитимность', icon: '⚖️' },
  E: { label: 'Эффективность', icon: '⚡' },
  X: { label: 'Экспертиза', icon: '🔍' },
  I: { label: 'Интересы', icon: '🛡️' },
  C: { label: 'Ясность', icon: '💡' },
};

const getCellColor = (value) => {
  if (value == null) return '#f3f4f6';
  if (value >= 85) return '#d1fae5';
  if (value >= 70) return '#bfdbfe';
  if (value >= 50) return '#fef9c3';
  if (value >= 30) return '#fed7aa';
  return '#fee2e2';
};

const getCellTextColor = (value) => {
  if (value == null) return '#9ca3af';
  if (value >= 85) return '#065f46';
  if (value >= 70) return '#1e40af';
  if (value >= 50) return '#854d0e';
  if (value >= 30) return '#7c2d12';
  return '#991b1b';
};

function groupRowsByUser(rows) {
  const m = new Map();
  for (const row of rows) {
    const key = row.user_id != null ? `u:${row.user_id}` : `r:${row.row_key || row.session_id}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(row);
  }
  return [...m.values()];
}

function casesLabel(n) {
  const k = n % 10;
  const k100 = n % 100;
  if (k100 >= 11 && k100 <= 14) return `${n} кейсов`;
  if (k === 1) return `${n} кейс`;
  if (k >= 2 && k <= 4) return `${n} кейса`;
  return `${n} кейсов`;
}

function buildAggregatedParent(children) {
  const sortedChildren = [...children].sort((a, b) =>
    String(a.case_code || '').localeCompare(String(b.case_code || ''), 'ru')
  );
  const first = sortedChildren[0];
  const avgField = (field) => {
    const vals = sortedChildren.map((c) => c[field]).filter((v) => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const bestByScore = [...sortedChildren].sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0))[0];
  const attemptsSum = sortedChildren.reduce((s, c) => s + (Number(c.attempts_count) || 0), 0);
  return {
    ...first,
    L: avgField('L'),
    E: avgField('E'),
    X: avgField('X'),
    I: avgField('I'),
    C: avgField('C'),
    total_score: avgField('total_score'),
    risk: sortedChildren.some((c) => c.risk),
    leader: sortedChildren.some((c) => c.leader),
    case_code: null,
    attempts_count: attemptsSum > 0 ? attemptsSum : null,
    session_id: bestByScore.session_id,
    row_key: `agg:${first.user_id != null ? first.user_id : bestByScore.row_key}`,
    _children: sortedChildren,
    _groupSize: sortedChildren.length,
  };
}

export default function Heatmap({
  data = [],
  onRowClick,
  showCaseColumn = false,
  showAttempts = false,
  groupByUser = false,
  /** false — таблица без цветовой подсветки ячеек LEXIC */
  lexicColorize = true,
}) {
  const [sortBy, setSortBy] = useState('total_score');
  const [sortDir, setSortDir] = useState('desc');
  const [filterMin, setFilterMin] = useState('');
  const [filterMax, setFilterMax] = useState('');
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());

  const handleSort = (col) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const hierarchical = groupByUser && showCaseColumn;

  const tableRows = useMemo(() => {
    if (!hierarchical) return data;
    return groupRowsByUser(data).map((g) => (g.length > 1 ? buildAggregatedParent(g) : g[0]));
  }, [data, hierarchical]);

  const toggleExpand = (key, e) => {
    e.stopPropagation();
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filteredData = tableRows.filter((row) => {
    const score = row.total_score ?? 0;
    const min = filterMin !== '' ? Number(filterMin) : -Infinity;
    const max = filterMax !== '' ? Number(filterMax) : Infinity;
    return score >= min && score <= max;
  });

  const sortedData = [...filteredData].sort((a, b) => {
    if (sortBy === 'name') {
      const an = String(a.name || a.username || '').toLowerCase();
      const bn = String(b.name || b.username || '').toLowerCase();
      const c = an.localeCompare(bn, 'ru');
      return sortDir === 'asc' ? c : -c;
    }
    const av = a[sortBy] ?? 0;
    const bv = b[sortBy] ?? 0;
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  if (!data || data.length === 0) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#9ca3af' }}>
        Нет данных для отображения
      </div>
    );
  }

  return (
    <div>
      {/* Фильтры */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>Фильтр по баллу:</span>
        <input
          type="number"
          placeholder="от"
          value={filterMin}
          onChange={(e) => setFilterMin(e.target.value)}
          style={{ width: '64px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}
        />
        <span style={{ color: '#6b7280' }}>—</span>
        <input
          type="number"
          placeholder="до"
          value={filterMax}
          onChange={(e) => setFilterMax(e.target.value)}
          style={{ width: '64px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}
        />
        <span style={{ fontSize: '12px', color: '#9ca3af' }}>
          Показано: {sortedData.length} / {tableRows.length}
        </span>
      </div>

      {/* Цветовая легенда */}
      {lexicColorize && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', fontSize: '11px' }}>
          {[
            { range: '85+', bg: '#d1fae5', text: '#065f46', label: 'Выдающийся' },
            { range: '70–84', bg: '#bfdbfe', text: '#1e40af', label: 'Хороший' },
            { range: '50–69', bg: '#fef9c3', text: '#854d0e', label: 'Средний' },
            { range: '30–49', bg: '#fed7aa', text: '#7c2d12', label: 'Ниже среднего' },
            { range: '0–29', bg: '#fee2e2', text: '#991b1b', label: 'Критический' },
          ].map((l) => (
            <div key={l.range} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <div style={{ width: '28px', height: '16px', background: l.bg, borderRadius: '3px' }} />
              <span style={{ color: '#6b7280' }}>{l.range}</span>
            </div>
          ))}
        </div>
      )}

      {/* Таблица */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
              {hierarchical && (
                <th style={{ padding: '10px 6px', width: '36px', fontWeight: '700', color: '#374151' }} aria-label="Развернуть" />
              )}
              <th
                style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '700', color: '#374151', whiteSpace: 'nowrap', cursor: 'pointer' }}
                onClick={() => handleSort('name')}
              >
                Участник {sortBy === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              {showCaseColumn && (
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '700', color: '#374151', whiteSpace: 'nowrap' }}>
                  Кейс
                </th>
              )}
              {showAttempts && (
                <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#374151', whiteSpace: 'nowrap' }}>
                  Попыток
                </th>
              )}
              {PARAMS.map((p) => (
                <th
                  key={p}
                  style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#374151', whiteSpace: 'nowrap', cursor: 'pointer', minWidth: '70px' }}
                  onClick={() => handleSort(p)}
                >
                  {PARAM_META[p].icon} {p} {sortBy === p ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
              ))}
              <th
                style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#374151', whiteSpace: 'nowrap', cursor: 'pointer', minWidth: '70px' }}
                onClick={() => handleSort('total_score')}
              >
                Итого {sortBy === 'total_score' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((row, i) => {
              const groupKey = row.row_key || row.session_id || String(i);
              const children = row._children;
              const isParent = hierarchical && children && children.length > 1;
              const expanded = isParent && expandedKeys.has(groupKey);

              const cellBg = (val) => (lexicColorize ? getCellColor(val) : '#f9fafb');
              const cellFg = (val) => (lexicColorize ? getCellTextColor(val) : '#374151');

              const renderMetricCells = (r) => (
                <>
                  {PARAMS.map((p) => {
                    const val = r[p] != null ? Math.round(r[p]) : null;
                    return (
                      <td
                        key={p}
                        style={{
                          padding: '8px 12px',
                          textAlign: 'center',
                          background: cellBg(val),
                          color: cellFg(val),
                          fontWeight: '600',
                          fontSize: '13px',
                        }}
                      >
                        {val != null ? val : '—'}
                      </td>
                    );
                  })}
                  <td
                    style={{
                      padding: '8px 12px',
                      textAlign: 'center',
                      background: cellBg(r.total_score != null ? Math.round(r.total_score) : null),
                      color: cellFg(r.total_score != null ? Math.round(r.total_score) : null),
                      fontWeight: '700',
                      fontSize: '14px',
                    }}
                  >
                    {r.total_score != null ? Math.round(r.total_score) : '—'}
                  </td>
                </>
              );

              const rowBg = i % 2 === 0 ? 'white' : '#fafafa';
              const hoverBg = '#f0f9ff';

              return (
                <React.Fragment key={groupKey}>
                  <tr
                    onClick={() => onRowClick && onRowClick(row.session_id)}
                    style={{
                      borderBottom: '1px solid #f3f4f6',
                      cursor: onRowClick ? 'pointer' : 'default',
                      background: rowBg,
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) => {
                      if (onRowClick) e.currentTarget.style.background = hoverBg;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = rowBg;
                    }}
                  >
                    {hierarchical && (
                      <td style={{ padding: '4px', textAlign: 'center', verticalAlign: 'middle' }}>
                        {isParent ? (
                          <button
                            type="button"
                            title={expanded ? 'Свернуть' : 'Показать кейсы'}
                            onClick={(e) => toggleExpand(groupKey, e)}
                            style={{
                              width: '28px',
                              height: '28px',
                              border: '1px solid #d1d5db',
                              borderRadius: '6px',
                              background: 'white',
                              cursor: 'pointer',
                              fontSize: '16px',
                              lineHeight: 1,
                              color: '#374151',
                            }}
                          >
                            {expanded ? '−' : '+'}
                          </button>
                        ) : null}
                      </td>
                    )}
                    <td style={{ padding: '8px 12px', fontWeight: '500', color: '#1f2937', whiteSpace: 'nowrap' }}>
                      {row.risk && <span title="Группа риска" style={{ marginRight: '4px' }}>⚠️</span>}
                      {row.leader && <span title="Лидерский потенциал" style={{ marginRight: '4px' }}>⭐</span>}
                      {row.name || row.username || '—'}
                      {isParent && (
                        <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: '600', color: '#9ca3af' }}>
                          ({casesLabel(children.length)})
                        </span>
                      )}
                    </td>
                    {showCaseColumn && (
                      <td style={{ padding: '8px 12px', fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {isParent ? 'средн. по кейсам' : row.case_code || '—'}
                      </td>
                    )}
                    {showAttempts && (
                      <td style={{ padding: '8px 12px', textAlign: 'center', fontSize: '13px', color: '#374151' }}>
                        {row.attempts_count != null ? row.attempts_count : '—'}
                      </td>
                    )}
                    {renderMetricCells(row)}
                  </tr>
                  {expanded &&
                    children.map((child, ci) => (
                      <tr
                        key={`${groupKey}-c-${child.row_key || child.session_id || ci}`}
                        onClick={() => onRowClick && onRowClick(child.session_id)}
                        style={{
                          borderBottom: '1px solid #f3f4f6',
                          cursor: onRowClick ? 'pointer' : 'default',
                          background: '#f8fafc',
                        }}
                        onMouseEnter={(e) => onRowClick && (e.currentTarget.style.background = '#eff6ff')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = '#f8fafc')}
                      >
                        {hierarchical && <td />}
                        <td style={{ padding: '8px 12px 8px 28px', fontSize: '12px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                          └
                        </td>
                        {showCaseColumn && (
                          <td style={{ padding: '8px 12px', fontSize: '12px', color: '#475569', whiteSpace: 'nowrap' }}>
                            {child.case_code || '—'}
                          </td>
                        )}
                        {showAttempts && (
                          <td style={{ padding: '8px 12px', textAlign: 'center', fontSize: '13px', color: '#374151' }}>
                            {child.attempts_count != null ? child.attempts_count : '—'}
                          </td>
                        )}
                        {renderMetricCells(child)}
                      </tr>
                    ))}
                </React.Fragment>
              );
            })}
            {/* Строка средних */}
            {sortedData.length > 1 && (
              <tr style={{ background: '#f0f9ff', borderTop: '2px solid #bfdbfe' }}>
                {hierarchical && <td />}
                <td style={{ padding: '8px 12px', fontWeight: '700', color: '#374151' }}>Среднее</td>
                {showCaseColumn && <td />}
                {showAttempts && <td />}
                {PARAMS.map((p) => {
                  const vals = sortedData.map((r) => r[p]).filter((v) => v != null);
                  const avg = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
                  return (
                    <td key={p} style={{ padding: '8px 12px', textAlign: 'center', fontWeight: '700', color: '#374151' }}>
                      {avg != null ? avg : '—'}
                    </td>
                  );
                })}
                <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: '700', color: '#374151' }}>
                  {(() => {
                    const vals = sortedData.map((r) => r.total_score).filter((v) => v != null);
                    return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : '—';
                  })()}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
