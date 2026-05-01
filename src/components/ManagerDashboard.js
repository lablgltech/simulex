import React, { useState, useEffect, useCallback, useMemo } from 'react';
import LexicRadarChart from './LexicRadarChart';
import LexicTrendsLineChart from './LexicTrendsLineChart';
import Heatmap from './Heatmap';
import ParticipantReport from './ParticipantReport';

/**
 * Интерактивный дашборд руководителя.
 * 
 * Props:
 *   apiBase   string    — базовый URL API (напр. '')
 *   caseCode  string    — фильтр по кейсу (опционально)
 *   token     string    — Bearer токен авторизации
 */

const PARAMS = ['L', 'E', 'X', 'I', 'C'];
const PARAM_META = {
  L: { label: 'Легитимность', icon: '⚖️', color: '#3b82f6' },
  E: { label: 'Эффективность', icon: '⚡', color: '#10b981' },
  X: { label: 'Экспертиза', icon: '🔍', color: '#f59e0b' },
  I: { label: 'Интересы', icon: '🛡️', color: '#ef4444' },
  C: { label: 'Ясность', icon: '💡', color: '#8b5cf6' },
};

// Эталонные значения по умолчанию
const DEFAULT_REFERENCE = { L: 75, E: 75, X: 75, I: 75, C: 75 };

const _NEG_STYLE_RU = {
  collaborative: '🤝 Win-Win',
  competitive: '⚔️ Конкурентный',
  avoidant: '🏃 Избегающий',
  mixed: '🔄 Смешанный',
  accommodating: '🤲 Уступчивый',
};
const _translateNegStyle = (s) => _NEG_STYLE_RU[s] || s;

const getLevelColor = (value) => {
  if (value == null) return '#9ca3af';
  if (value >= 85) return '#10b981';
  if (value >= 70) return '#3b82f6';
  if (value >= 50) return '#f59e0b';
  if (value >= 30) return '#f97316';
  return '#ef4444';
};

export default function ManagerDashboard({ apiBase = '', caseCode = '', token = '' }) {
  const [overview, setOverview] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('total_score');
  const [sortDir, setSortDir] = useState('desc');
  const [filterParam, setFilterParam] = useState('total_score');
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [drillReport, setDrillReport] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('kpi'); // kpi | team | stages
  /** '' = все кейсы; иначе код кейса (лучшая попытка на пару участник×кейс) */
  const [selectedCase, setSelectedCase] = useState(caseCode || '');
  /** '' = все сотрудники группы; иначе user_id */
  const [selectedUserId, setSelectedUserId] = useState('');
  /** Внутри вкладки «Команда»: таблица | тепловая карта | рейтинг */
  const [teamView, setTeamView] = useState('table');
  const [behaviorData, setBehaviorData] = useState(null);
  const [systemGaps, setSystemGaps] = useState(null);
  const [prioritiesData, setPrioritiesData] = useState(null);
  const [trendsData, setTrendsData] = useState(null);
  const [proxyRoi, setProxyRoi] = useState(null);
  const [correlationsData, setCorrelationsData] = useState(null);

  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    setSelectedCase(caseCode || '');
  }, [caseCode]);

  const qsCaseUser = useCallback(() => {
    const p = new URLSearchParams();
    if (selectedCase) p.set('case_code', selectedCase);
    if (selectedUserId) p.set('user_id', String(selectedUserId));
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [selectedCase, selectedUserId]);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/dashboard/overview${qsCaseUser()}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOverview(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiBase, token, qsCaseUser]);

  const fetchParticipants = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/dashboard/participants${qsCaseUser()}`, { headers });
      if (!res.ok) return;
      setParticipants(await res.json());
    } catch (_e) {}
  }, [apiBase, qsCaseUser, token]);

  const fetchBehavior = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/dashboard/behavior${qsCaseUser()}`, { headers });
      if (!res.ok) {
        setBehaviorData(null);
        return;
      }
      setBehaviorData(await res.json());
    } catch (_e) {
      setBehaviorData(null);
    }
  }, [apiBase, qsCaseUser, token]);

  const fetchInsights = useCallback(async () => {
    const q = qsCaseUser();
    const base = `${apiBase}/api/dashboard`;
    try {
      const [g, p, t, r, c] = await Promise.all([
        fetch(`${base}/system-gaps${q}`, { headers }),
        fetch(`${base}/priorities${q}`, { headers }),
        fetch(`${base}/trends${q}`, { headers }),
        fetch(`${base}/proxy-roi${q}`, { headers }),
        fetch(`${base}/correlations${q}`, { headers }),
      ]);
      setSystemGaps(g.ok ? await g.json() : null);
      setPrioritiesData(p.ok ? await p.json() : null);
      setTrendsData(t.ok ? await t.json() : null);
      setProxyRoi(r.ok ? await r.json() : null);
      setCorrelationsData(c.ok ? await c.json() : null);
    } catch (_e) {
      setSystemGaps(null);
      setPrioritiesData(null);
      setTrendsData(null);
      setProxyRoi(null);
      setCorrelationsData(null);
    }
  }, [apiBase, qsCaseUser, token]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  useEffect(() => {
    fetchParticipants();
    fetchBehavior();
    fetchInsights();
  }, [fetchParticipants, fetchBehavior, fetchInsights]);

  const downloadParticipantsCsv = useCallback(() => {
    const cols = [
      'name',
      'case_code',
      'total_score',
      'L',
      'E',
      'X',
      'I',
      'C',
      'status',
      'attempts_count',
      'stage2_missed_risks',
      'session_id',
    ];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [cols.join(',')];
    for (const row of participants) {
      lines.push(cols.map((c) => esc(row[c])).join(','));
    }
    const blob = new Blob(['\ufeff', lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dashboard_participants_${selectedCase || 'all'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [participants, selectedCase]);

  const drillDown = async (sessionId) => {
    if (!sessionId) return;
    setSelectedSessionId(sessionId);
    setDrillLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/dashboard/participant/${sessionId}/detail`, { headers });
      if (res.ok) {
        setDrillReport(await res.json());
      }
    } catch (_e) {}
    setDrillLoading(false);
  };

  const closeDrill = () => {
    setSelectedSessionId(null);
    setDrillReport(null);
  };

  const caseMetrics = useMemo(() => {
    if (!overview?.by_case) return null;
    if (selectedCase) return overview.by_case[selectedCase] || null;
    if (overview.case_codes?.length === 1) return overview.by_case[overview.case_codes[0]] || null;
    return null;
  }, [overview, selectedCase]);

  // Сортировка строк (участник × кейс, лучшая попытка)
  const sortedParticipants = [...participants].sort((a, b) => {
    const av = a[sortBy] ?? 0;
    const bv = b[sortBy] ?? 0;
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  /** Профиль для радара только по одному кейсу (без смешивания разных кейсов). */
  const groupProfile = caseMetrics?.group_profile ?? null;

  const worstParam = caseMetrics?.worst_param ?? null;

  const riskParticipants = participants.filter((p) => p.risk);
  const leaderParticipants = participants.filter((p) => p.leader);

  const showCaseColumn = !selectedCase && (overview?.case_codes?.length ?? 0) > 1;
  const showAttemptsCol = useMemo(
    () => participants.some((p) => (p.attempts_count ?? 0) > 1),
    [participants]
  );

  const ratingByCase = useMemo(() => {
    const m = new Map();
    for (const p of participants) {
      const cc = p.case_code || '—';
      if (!m.has(cc)) m.set(cc, []);
      m.get(cc).push(p);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  }, [participants]);

  const sumAcrossCases = (field) =>
    overview?.by_case
      ? Object.values(overview.by_case).reduce((s, b) => s + (b[field] ?? 0), 0)
      : 0;

  const tabs = [
    { id: 'kpi', label: '📊 KPI' },
    { id: 'team', label: '👥 Команда' },
    { id: 'stages', label: '📅 Прогресс' },
  ];

  if (drillReport || drillLoading) {
    return (
      <div>
        <button
          onClick={closeDrill}
          style={{
            margin: '16px',
            padding: '8px 16px',
            borderRadius: '8px',
            border: '1px solid #e5e7eb',
            background: 'white',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          ← Назад к дашборду
        </button>
        {drillLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Загрузка профиля...</div>
        ) : (
          <ParticipantReport report={drillReport} showParticipantStageTabs />
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', color: '#1f2937' }}>📊 Дашборд руководителя</h1>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={downloadParticipantsCsv}
            disabled={!participants.length}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid #e5e7eb',
              background: participants.length ? 'white' : '#f3f4f6',
              cursor: participants.length ? 'pointer' : 'not-allowed',
              fontSize: '13px',
            }}
          >
            ⬇ CSV участников
          </button>
          <button
            type="button"
            onClick={() => {
              fetchOverview();
              fetchParticipants();
              fetchBehavior();
              fetchInsights();
            }}
            style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: '13px' }}
          >
            🔄 Обновить
          </button>
        </div>
      </div>

      <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: 600 }}>Кейс</span>
        <select
          value={selectedCase}
          onChange={(e) => setSelectedCase(e.target.value)}
          style={{
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid #d1d5db',
            fontSize: '13px',
            minWidth: '220px',
            background: 'white',
          }}
        >
          <option value="">Все кейсы (сводка)</option>
          {(overview?.case_codes || []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: 600 }}>Сотрудник</span>
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          style={{
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid #d1d5db',
            fontSize: '13px',
            minWidth: '200px',
            background: 'white',
          }}
        >
          <option value="">Все сотрудники группы</option>
          {(overview?.team_members || []).map((m) => (
            <option key={m.user_id} value={String(m.user_id)}>
              {m.name} (id {m.user_id})
            </option>
          ))}
        </select>
        {(overview?.case_codes?.length ?? 0) > 1 && !selectedCase && (
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>
            Для радара LEXIC и детальных KPI выберите кейс. В сводке метрики не смешивают разные кейсы.
          </span>
        )}
      </div>
      <p style={{ fontSize: '12px', color: '#64748b', marginTop: '-12px', marginBottom: '16px' }}>
        Soft-skills и текстовые резюме сессий заполняются после завершения кейса (фиксация отчёта). Для сессий в процессе блоки могут быть пустыми.
      </p>

      {error && (
        <div style={{ padding: '12px 16px', background: '#fee2e2', borderRadius: '8px', color: '#991b1b', marginBottom: '16px', fontSize: '13px' }}>
          Ошибка загрузки данных: {error}
        </div>
      )}

      {/* Навигация */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', borderBottom: '2px solid #e5e7eb', paddingBottom: '1px' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: '8px 16px',
              borderRadius: '8px 8px 0 0',
              border: '2px solid',
              borderBottom: 'none',
              borderColor: activeTab === t.id ? '#3b82f6' : 'transparent',
              background: activeTab === t.id ? '#eff6ff' : 'transparent',
              color: activeTab === t.id ? '#1d4ed8' : '#6b7280',
              fontWeight: activeTab === t.id ? '700' : '500',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* KPI-плитки */}
      {activeTab === 'kpi' && (
        <div>
          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Загрузка...</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px', marginBottom: '24px' }}>
                {caseMetrics ? (
                  <>
                    <KPITile
                      label="Участников по кейсу"
                      value={caseMetrics.participants ?? '—'}
                      sub="по лучшей попытке"
                      icon="👥"
                      color="#3b82f6"
                    />
                    <KPITile
                      label="% завершения"
                      value={caseMetrics.completion_rate != null ? `${Math.round(caseMetrics.completion_rate * 100)}%` : '—'}
                      icon="✅"
                      color="#10b981"
                    />
                    <KPITile
                      label="Средний балл"
                      value={caseMetrics.avg_score != null ? Math.round(caseMetrics.avg_score) : '—'}
                      icon="📊"
                      color="#f59e0b"
                    />
                    <KPITile
                      label="Проблемный параметр"
                      value={worstParam ? `${PARAM_META[worstParam].icon} ${worstParam}` : '—'}
                      sub={worstParam && groupProfile ? `ср.: ${Math.round(groupProfile[worstParam] ?? 0)}` : ''}
                      icon="⚠️"
                      color="#ef4444"
                    />
                    <KPITile
                      label="Группа риска"
                      value={caseMetrics.risk_count ?? 0}
                      sub="по лучшему результату"
                      icon="⚠️"
                      color="#f97316"
                    />
                    <KPITile
                      label="Лидерский потенциал"
                      value={caseMetrics.leader_count ?? 0}
                      sub="по лучшему результату"
                      icon="⭐"
                      color="#8b5cf6"
                    />
                  </>
                ) : (
                  <>
                    <KPITile
                      label="Уникальных участников"
                      value={overview?.unique_users ?? '—'}
                      sub="в группе, все кейсы"
                      icon="👥"
                      color="#3b82f6"
                    />
                    <KPITile
                      label="Всего попыток"
                      value={overview?.sessions_total ?? '—'}
                      sub="сессий симуляции"
                      icon="🔄"
                      color="#6366f1"
                    />
                    <KPITile
                      label="Кейсов"
                      value={overview?.case_codes?.length ?? '—'}
                      icon="📁"
                      color="#8b5cf6"
                    />
                    <KPITile
                      label="Средний балл"
                      value={overview?.cross_case_avg_score != null ? Math.round(overview.cross_case_avg_score) : '—'}
                      sub="взвешено по числу участников в кейсе"
                      icon="📊"
                      color="#f59e0b"
                    />
                    <KPITile
                      label="Группа риска (всего)"
                      value={sumAcrossCases('risk_count')}
                      sub="сумма по кейсам · один человек может войти в несколько"
                      icon="⚠️"
                      color="#f97316"
                    />
                    <KPITile
                      label="Лидеры (всего)"
                      value={sumAcrossCases('leader_count')}
                      sub="сумма по кейсам"
                      icon="⭐"
                      color="#10b981"
                    />
                  </>
                )}
              </div>

              <SystemZonesSection data={systemGaps} />
              <QuadrantXeSection
                participants={participants}
                onDrill={drillDown}
                showCaseColumn={showCaseColumn}
              />
              <PrioritiesSection data={prioritiesData} onDrill={drillDown} />

              {!caseMetrics && overview?.by_case && Object.keys(overview.by_case).length > 0 && (
                <div style={{ background: 'white', borderRadius: '12px', padding: '20px', marginBottom: '24px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
                  <h3 style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937', marginBottom: '12px' }}>По кейсам</h3>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ background: '#f9fafb' }}>
                          <th style={{ textAlign: 'left', padding: '8px' }}>Кейс</th>
                          <th style={{ textAlign: 'right', padding: '8px' }}>Участников</th>
                          <th style={{ textAlign: 'right', padding: '8px' }}>Попыток</th>
                          <th style={{ textAlign: 'right', padding: '8px' }}>% заверш.</th>
                          <th style={{ textAlign: 'right', padding: '8px' }}>Средний балл</th>
                          <th style={{ textAlign: 'right', padding: '8px' }}>Риск</th>
                          <th style={{ textAlign: 'right', padding: '8px' }}>Лидеры</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(overview.by_case)
                          .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
                          .map(([cc, b]) => (
                            <tr key={cc} style={{ borderBottom: '1px solid #f3f4f6' }}>
                              <td style={{ padding: '8px', fontWeight: 600 }}>{cc}</td>
                              <td style={{ padding: '8px', textAlign: 'right' }}>{b.participants}</td>
                              <td style={{ padding: '8px', textAlign: 'right' }}>{b.sessions_total}</td>
                              <td style={{ padding: '8px', textAlign: 'right' }}>
                                {b.completion_rate != null ? `${Math.round(b.completion_rate * 100)}%` : '—'}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'right' }}>
                                {b.avg_score != null ? Math.round(b.avg_score) : '—'}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'right' }}>{b.risk_count}</td>
                              <td style={{ padding: '8px', textAlign: 'right' }}>{b.leader_count}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Агрегированный профиль группы */}
              {groupProfile && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                  <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
                    <h3 style={{ fontSize: '16px', fontWeight: '700', color: '#1f2937', marginBottom: '16px' }}>
                      Профиль группы vs Эталон
                      {selectedCase && (
                        <span style={{ fontWeight: 500, color: '#6b7280', marginLeft: '8px', fontSize: '13px' }}>({selectedCase})</span>
                      )}
                      {!selectedCase && overview?.case_codes?.length === 1 && (
                        <span style={{ fontWeight: 500, color: '#6b7280', marginLeft: '8px', fontSize: '13px' }}>
                          ({overview.case_codes[0]})
                        </span>
                      )}
                    </h3>
                    <LexicRadarChart
                      lexic={groupProfile}
                      referenceProfile={DEFAULT_REFERENCE}
                      industryProfile={overview?.industry_reference_profile || null}
                      size={280}
                      showLegend={false}
                    />
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '8px', fontSize: '11px', color: '#6b7280', flexWrap: 'wrap' }}>
                      <span>🔵 Группа</span>
                      <span>⬜ Эталон (75)</span>
                      {overview?.industry_reference_profile ? <span>🟣 Ориентир (конфиг)</span> : null}
                    </div>
                  </div>

                  <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
                    <h3 style={{ fontSize: '16px', fontWeight: '700', color: '#1f2937', marginBottom: '16px' }}>
                      Отклонение от эталона
                    </h3>
                    {PARAMS.map((p) => {
                      const avg = groupProfile[p] ?? 0;
                      const delta = Math.round(avg - DEFAULT_REFERENCE[p]);
                      return (
                        <div key={p} style={{ marginBottom: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '13px' }}>
                            <span style={{ color: '#374151' }}>{PARAM_META[p].icon} {PARAM_META[p].label}</span>
                            <span style={{ fontWeight: '700', color: getLevelColor(avg) }}>{Math.round(avg)}</span>
                          </div>
                          <div style={{ height: '6px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden' }}>
                            <div style={{ width: `${avg}%`, height: '100%', background: getLevelColor(avg) }} />
                          </div>
                          <div style={{ fontSize: '11px', color: delta >= 0 ? '#10b981' : '#ef4444', textAlign: 'right', marginTop: '2px' }}>
                            {delta >= 0 ? '+' : ''}{delta} от эталона
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div
                style={{
                  background: 'white',
                  borderRadius: '12px',
                  padding: '20px',
                  marginTop: '20px',
                  boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
                  border: '1px solid #e5e7eb',
                }}
              >
                <h3 style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937', marginBottom: '12px' }}>
                  Динамика LEXIC по месяцам
                </h3>
                <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>
                  Только завершённые сессии (этап &gt; 4) с сохранённым нормализованным профилем.
                </p>
                <LexicTrendsLineChart series={trendsData?.series || []} width={520} height={220} />
              </div>

              <ProxyRoiSection data={proxyRoi} caseMetrics={caseMetrics} />
              <CorrelationsSection data={correlationsData} />

              <TeamBehaviorPanel data={behaviorData} onDrill={drillDown} />

              {/* Индикаторы риска и лидеров */}
              {(riskParticipants.length > 0 || leaderParticipants.length > 0) && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '16px' }}>
                  {riskParticipants.length > 0 && (
                    <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '10px', padding: '16px' }}>
                      <h4 style={{ color: '#c2410c', marginBottom: '8px', fontSize: '14px', fontWeight: '700' }}>
                        ⚠️ Группа риска ({riskParticipants.length})
                      </h4>
                      {riskParticipants.slice(0, 8).map((p, i) => (
                        <div
                          key={p.row_key || p.session_id || i}
                          style={{ fontSize: '13px', color: '#374151', marginBottom: '4px', cursor: 'pointer' }}
                          onClick={() => drillDown(p.session_id)}
                        >
                          • {p.name || p.username || '—'}
                          {showCaseColumn && p.case_code ? ` · ${p.case_code}` : ''} — {Math.round(p.total_score ?? 0)} баллов
                        </div>
                      ))}
                    </div>
                  )}
                  {leaderParticipants.length > 0 && (
                    <div style={{ background: '#f0fdf4', border: '1px solid #a7f3d0', borderRadius: '10px', padding: '16px' }}>
                      <h4 style={{ color: '#065f46', marginBottom: '8px', fontSize: '14px', fontWeight: '700' }}>
                        ⭐ Лидерский потенциал ({leaderParticipants.length})
                      </h4>
                      {leaderParticipants.slice(0, 8).map((p, i) => (
                        <div
                          key={p.row_key || p.session_id || i}
                          style={{ fontSize: '13px', color: '#374151', marginBottom: '4px', cursor: 'pointer' }}
                          onClick={() => drillDown(p.session_id)}
                        >
                          • {p.name || p.username || '—'}
                          {showCaseColumn && p.case_code ? ` · ${p.case_code}` : ''} — {Math.round(p.total_score ?? 0)} баллов
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Команда: таблица / тепловая карта / рейтинг */}
      {activeTab === 'team' && (
        <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: '#1f2937', margin: 0 }}>Состав команды</h3>
            <span style={{ fontSize: '12px', color: '#6b7280' }}>Вид:</span>
            {[
              { id: 'table', label: 'Таблица' },
              { id: 'heatmap', label: 'Тепловая карта' },
              { id: 'rating', label: 'Рейтинг' },
            ].map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setTeamView(v.id)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '2px solid #e5e7eb',
                  background: teamView === v.id ? '#3b82f6' : 'white',
                  color: teamView === v.id ? 'white' : '#374151',
                }}
              >
                {v.label}
              </button>
            ))}
          </div>

          {selectedUserId ? (
            <EmployeeSessionsStrip participants={sortedParticipants} drillDown={drillDown} />
          ) : null}

          <TeamBehaviorPanel data={behaviorData} onDrill={drillDown} compact />

          <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '16px' }}>
            Строка = лучшая попытка на пару «участник × кейс». Клик по строке — полный отчёт. При «все кейсы» и группировке —
            «+» раскрывает детали по кейсам.
          </p>

          {teamView === 'rating' ? (
            <>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                {['total_score', ...PARAMS].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setFilterParam(p)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '999px',
                      fontSize: '12px',
                      fontWeight: '600',
                      cursor: 'pointer',
                      border: '2px solid #e5e7eb',
                      background: filterParam === p ? '#3b82f6' : 'white',
                      color: filterParam === p ? 'white' : '#374151',
                    }}
                  >
                    {p === 'total_score' ? '📊 Итого' : `${PARAM_META[p].icon} ${p}`}
                  </button>
                ))}
              </div>
              <RatingSections
                showCaseColumn={showCaseColumn}
                ratingByCase={ratingByCase}
                participants={participants}
                filterParam={filterParam}
                drillDown={drillDown}
              />
            </>
          ) : (
            <Heatmap
              data={sortedParticipants}
              onRowClick={drillDown}
              showCaseColumn={showCaseColumn}
              showAttempts={showAttemptsCol}
              groupByUser={showCaseColumn}
              lexicColorize={teamView === 'heatmap'}
            />
          )}
        </div>
      )}

      {/* Матрица прогресса по этапам */}
      {activeTab === 'stages' && (
        <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
          <h3 style={{ fontSize: '16px', fontWeight: '700', color: '#1f2937', marginBottom: '16px' }}>
            📅 Прогресс по этапам
          </h3>
          <StagesMatrix
            participants={sortedParticipants}
            onDrillDown={drillDown}
            showCaseColumn={showCaseColumn}
            showAttempts={showAttemptsCol}
          />
        </div>
      )}
    </div>
  );
}

// --- Вспомогательные компоненты ---

const ZONE_BG = { critical: '#fef2f2', attention: '#fffbeb', strong: '#ecfdf5' };
const ZONE_BORDER = { critical: '#fecaca', attention: '#fde68a', strong: '#a7f3d0' };
const ZONE_LABEL = { critical: 'Критично', attention: 'Внимание', strong: 'Сильная сторона' };

function SystemZonesSection({ data }) {
  if (!data?.stages?.length) return null;
  const heat = data.heatmap || {};
  const stages = ['stage-1', 'stage-2', 'stage-3', 'stage-4'].filter((s) => heat[s]);

  return (
    <div
      style={{
        background: 'white',
        borderRadius: '12px',
        padding: '20px',
        marginTop: '20px',
        boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
        border: '1px solid #e5e7eb',
      }}
    >
      <h3 style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937', marginBottom: '8px' }}>Системные зоны команды</h3>
      <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '16px' }}>
        Средние нормализованные баллы по этапам (лучшая сессия на участника×кейс). Пороги: &lt;{data.thresholds?.low ?? 60} /{' '}
        {data.thresholds?.high ?? 75}.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
        {data.stages.map((st) => (
          <div
            key={st.stage_code}
            style={{
              borderRadius: '10px',
              border: `1px solid ${ZONE_BORDER[st.zone] || '#e5e7eb'}`,
              background: ZONE_BG[st.zone] || '#f9fafb',
              padding: '14px 16px',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <strong style={{ color: '#0f172a' }}>{st.label}</strong>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#475569' }}>
                {ZONE_LABEL[st.zone] || st.zone} · n={st.participant_count}
              </span>
              {st.overall_avg != null && (
                <span style={{ fontSize: '12px', color: '#64748b' }}>среднее по этапу: {st.overall_avg}</span>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '10px', fontSize: '12px' }}>
              {PARAMS.map((p) =>
                st.param_avgs?.[p] != null ? (
                  <span key={p} style={{ color: PARAM_META[p].color, fontWeight: 600 }}>
                    {PARAM_META[p].icon} {p}: {st.param_avgs[p]}
                  </span>
                ) : null
              )}
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: '#334155', lineHeight: 1.5 }}>
              <strong>Что сделать:</strong> {st.recommendation}
            </p>
          </div>
        ))}
      </div>
      {stages.length > 0 && (
        <div>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>Тепловая карта: этап × параметр</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>Этап</th>
                  {PARAMS.map((p) => (
                    <th key={p} style={{ padding: '6px 8px', textAlign: 'center', color: PARAM_META[p].color }}>
                      {p}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stages.map((sc) => (
                  <tr key={sc}>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>{sc.replace('stage-', 'Э')}</td>
                    {PARAMS.map((p) => {
                      const v = heat[sc]?.[p];
                      const bg =
                        v == null ? '#f9fafb' : v < 60 ? '#fee2e2' : v < 75 ? '#fef9c3' : '#d1fae5';
                      return (
                        <td
                          key={p}
                          style={{
                            padding: '8px 12px',
                            textAlign: 'center',
                            background: bg,
                            fontWeight: 600,
                            color: '#0f172a',
                            border: '1px solid #f1f5f9',
                          }}
                        >
                          {v != null ? v : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {data.bar_by_stage?.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>Средний балл по этапам</div>
          {data.bar_by_stage.map((b) => (
            <div key={b.stage_code} style={{ marginBottom: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#64748b', marginBottom: '2px' }}>
                <span>{b.label}</span>
                <span>{b.overall_avg != null ? b.overall_avg : '—'}</span>
              </div>
              <div style={{ height: '8px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.min(100, b.overall_avg ?? 0)}%`,
                    height: '100%',
                    background: getLevelColor(b.overall_avg ?? 0),
                    borderRadius: '999px',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const Q_SPLIT = 60;

function QuadrantXeSection({ participants, onDrill, showCaseColumn }) {
  const pts = useMemo(() => {
    return (participants || [])
      .filter((p) => p.X != null && p.E != null)
      .map((p) => ({ ...p, qx: p.X >= Q_SPLIT ? 1 : 0, qy: p.E >= Q_SPLIT ? 1 : 0 }));
  }, [participants]);

  const quadrants = useMemo(() => {
    const labels = [
      { qx: 1, qy: 1, title: 'Высокая экспертиза, высокая эффективность', sub: 'Сильные исполнители' },
      { qx: 1, qy: 0, title: 'Высокая X, ниже E', sub: 'Усилить вывод в результат' },
      { qx: 0, qy: 1, title: 'Ниже X, высокая E', sub: 'Углубить предметную базу' },
      { qx: 0, qy: 0, title: 'Зона развития', sub: 'Приоритет поддержки' },
    ];
    return labels.map((L) => ({
      ...L,
      people: pts.filter((p) => p.qx === L.qx && p.qy === L.qy),
    }));
  }, [pts]);

  if (!pts.length) return null;

  const W = 340;
  const H = 300;
  const pad = 36;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const toX = (xv) => pad + (xv / 100) * plotW;
  const toY = (ev) => pad + plotH - (ev / 100) * plotH;

  return (
    <div
      style={{
        background: 'white',
        borderRadius: '12px',
        padding: '20px',
        marginTop: '20px',
        boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
        border: '1px solid #e5e7eb',
      }}
    >
      <h3 style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937', marginBottom: '8px' }}>
        Готовность: экспертиза (X) × эффективность (E)
      </h3>
      <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>
        Точка = лучшая сессия в текущем фильтре. Оси делятся по порогу {Q_SPLIT}.
      </p>
      <svg width={W} height={H} style={{ display: 'block', marginBottom: '16px' }}>
        <rect x={pad} y={pad} width={plotW} height={plotH} fill="#f8fafc" stroke="#e2e8f0" />
        <line x1={toX(Q_SPLIT)} y1={pad} x2={toX(Q_SPLIT)} y2={pad + plotH} stroke="#94a3b8" strokeDasharray="4,4" />
        <line x1={pad} y1={toY(Q_SPLIT)} x2={pad + plotW} y2={toY(Q_SPLIT)} stroke="#94a3b8" strokeDasharray="4,4" />
        <text x={pad + plotW / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="#64748b">
          Экспертиза (X) →
        </text>
        <text x={4} y={pad + 8} fontSize="10" fill="#64748b">
          E ↑
        </text>
        {pts.map((p, i) => (
          <g
            key={p.row_key || p.session_id || i}
            style={{ cursor: 'pointer' }}
            onClick={() => onDrill && onDrill(p.session_id)}
          >
            <title>
              {p.name}
              {showCaseColumn && p.case_code ? ` · ${p.case_code}` : ''}: X={Math.round(p.X)}, E={Math.round(p.E)}
            </title>
            <circle
              cx={toX(p.X)}
              cy={toY(p.E)}
              r={7}
              fill="#3b82f6"
              fillOpacity={0.75}
              stroke="white"
              strokeWidth={1.5}
            />
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {quadrants.map((q) => (
          <div key={`${q.qx}-${q.qy}`} style={{ background: '#f9fafb', borderRadius: '8px', padding: '10px 12px' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#1e293b' }}>{q.sub}</div>
            <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px' }}>{q.title}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {q.people.length === 0 ? (
                <span style={{ fontSize: '12px', color: '#94a3b8' }}>—</span>
              ) : (
                q.people.map((p, i) => (
                  <button
                    key={p.row_key || p.session_id || i}
                    type="button"
                    onClick={() => onDrill && onDrill(p.session_id)}
                    style={{
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      background: 'white',
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    {p.name}
                    {showCaseColumn && p.case_code ? ` · ${p.case_code}` : ''}
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PrioritiesSection({ data, onDrill }) {
  const items = data?.items || [];
  if (!items.length) return null;
  const crit = data.critical_count ?? 0;
  return (
    <div
      style={{
        background: 'white',
        borderRadius: '12px',
        padding: '20px',
        marginTop: '20px',
        boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
        border: '1px solid #e5e7eb',
      }}
    >
      <h3 style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937', marginBottom: '8px' }}>
        Кому вмешаться в первую очередь
        {crit > 0 ? (
          <span
            style={{
              marginLeft: '10px',
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: '999px',
              background: '#fee2e2',
              color: '#b91c1c',
            }}
          >
            {crit} высокий приоритет
          </span>
        ) : null}
      </h3>
      <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>
        Эвристики по застою, баллу и этапу 2; без «процентов вероятности».
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ textAlign: 'left', padding: '8px' }}>Участник</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Кейс</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Сигналы</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Приоритет</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Что сделать</th>
              <th style={{ textAlign: 'center', padding: '8px' }}> </th>
            </tr>
          </thead>
          <tbody>
            {items.map((row, i) => (
              <tr key={row.session_id || i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '8px' }}>{row.name}</td>
                <td style={{ padding: '8px', color: '#64748b' }}>{row.case_code || '—'}</td>
                <td style={{ padding: '8px', fontSize: '12px', color: '#475569' }}>{(row.signals || []).join(', ')}</td>
                <td style={{ padding: '8px' }}>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: '6px',
                      background: row.priority === 'high' ? '#fee2e2' : '#fef9c3',
                      color: row.priority === 'high' ? '#991b1b' : '#854d0e',
                    }}
                  >
                    {row.priority === 'high' ? 'высокий' : 'средний'}
                  </span>
                </td>
                <td style={{ padding: '8px', maxWidth: '280px', lineHeight: 1.4 }}>{row.suggested_action}</td>
                <td style={{ padding: '8px' }}>
                  <button
                    type="button"
                    onClick={() => onDrill && onDrill(row.session_id)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      background: 'white',
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    Отчёт
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProxyRoiSection({ data, caseMetrics }) {
  if (!data) return null;
  const hours = data.avg_session_hours;
  const maxBar = 40;
  const barPct = hours != null ? Math.min(100, (hours / maxBar) * 100) : 0;
  const cr = data.completion_rate;
  const crPct = cr != null ? Math.round(cr * 100) : null;
  return (
    <div
      style={{
        background: 'white',
        borderRadius: '12px',
        padding: '20px',
        marginTop: '20px',
        boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
        border: '1px solid #e5e7eb',
      }}
    >
      <h3 style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937', marginBottom: '8px' }}>Прокси эффективности обучения</h3>
      <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '16px' }}>
        Время в симуляторе и повторные попытки; не денежный ROI.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        <KPITile
          label="Ср. длительность сессии"
          value={hours != null ? `${hours} ч` : '—'}
          sub="по лучшей попытке"
          icon="⏱"
          color="#6366f1"
        />
        <KPITile
          label="% завершения (выборка)"
          value={crPct != null ? `${crPct}%` : caseMetrics?.completion_rate != null ? `${Math.round(caseMetrics.completion_rate * 100)}%` : '—'}
          sub="лучшие сессии в фильтре"
          icon="✅"
          color="#10b981"
        />
        <KPITile
          label="Ср. разброс балла"
          value={data.avg_score_delta_repeats != null ? `±${data.avg_score_delta_repeats}` : '—'}
          sub={`пары с 2+ попытками: ${data.repeats_with_delta_count ?? 0}`}
          icon="📈"
          color="#f59e0b"
        />
      </div>
      {hours != null && (
        <div>
          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>Длительность (шкала до {maxBar} ч)</div>
          <div style={{ height: '10px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden' }}>
            <div style={{ width: `${barPct}%`, height: '100%', background: '#6366f1', borderRadius: '999px' }} />
          </div>
        </div>
      )}
    </div>
  );
}

function CorrelationsSection({ data }) {
  if (!data) return null;
  return (
    <div
      style={{
        background: 'white',
        borderRadius: '12px',
        padding: '20px',
        marginTop: '20px',
        boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
        border: '1px solid #e5e7eb',
      }}
    >
      <h3 style={{ fontSize: '15px', fontWeight: '700', color: '#1f2937', marginBottom: '8px' }}>Паттерны поведения: корреляции</h3>
      {!data.available ? (
        <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
          Для оценки связи нужно не менее {data.min_n ?? 15} точек с сообщениями тьютора и итоговым баллом. Сейчас: {data.n ?? 0}.
        </p>
      ) : (
        <>
          <p style={{ fontSize: '13px', color: '#334155', marginBottom: '8px' }}>
            Коэффициент Пирсона (сообщения тьютора vs итог LEXIC):{' '}
            <strong>{data.pearson_tutor_messages_vs_total ?? '—'}</strong>
            <span style={{ color: '#94a3b8', fontSize: '12px', marginLeft: '8px' }}>n={data.n}</span>
          </p>
          {data.disclaimer && <p style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '12px' }}>{data.disclaimer}</p>}
          <CorrelationScatter points={data.points || []} />
        </>
      )}
    </div>
  );
}

function CorrelationScatter({ points }) {
  const W = 400;
  const H = 220;
  const pad = 32;
  if (!points.length) return null;
  const xs = points.map((p) => p.tutor_messages);
  const ys = points.map((p) => p.total_score);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys, 100);
  const spanY = maxY - minY || 1;
  const toX = (x) => pad + (x / maxX) * (W - pad * 2);
  const toY = (y) => pad + (H - pad * 2) * (1 - (y - minY) / spanY);
  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <rect x={pad} y={pad} width={W - pad * 2} height={H - pad * 2} fill="#f8fafc" stroke="#e2e8f0" />
      {points.slice(0, 120).map((p, i) => (
        <circle key={p.session_id || i} cx={toX(p.tutor_messages)} cy={toY(p.total_score)} r={4} fill="#8b5cf6" fillOpacity={0.7} />
      ))}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="#64748b">
        Сообщений тьютора
      </text>
    </svg>
  );
}

function TeamBehaviorPanel({ data, onDrill, compact = false }) {
  if (!data?.behavior) {
    if (compact) return null;
    return (
      <div style={{ fontSize: '13px', color: '#9ca3af', margin: '12px 0' }}>
        Поведенческие агрегаты появятся после накопления завершённых сессий с отчётами.
      </div>
    );
  }
  const b = data.behavior;
  const clusters = data.clusters || {};
  const clusterEntries = Object.entries(clusters);

  const boxStyle = {
    background: 'white',
    borderRadius: '12px',
    padding: compact ? '12px 16px' : '20px',
    marginBottom: compact ? '12px' : '20px',
    boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
    border: '1px solid #e5e7eb',
  };

  const stat = (label, val, sub) => (
    <div key={label} style={{ textAlign: 'center', minWidth: compact ? '72px' : '88px' }}>
      <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: compact ? '16px' : '20px', fontWeight: 700, color: '#1e293b' }}>{val ?? '—'}</div>
      {sub ? <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>{sub}</div> : null}
    </div>
  );

  return (
    <div style={boxStyle}>
      <h4 style={{ margin: '0 0 12px 0', fontSize: compact ? '14px' : '15px', color: '#0f172a' }}>
        {compact ? 'Кратко: стиль и риски' : 'Команда: стиль общения и работа с рисками (лучшие сессии по фильтру)'}
      </h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: compact ? '12px' : '16px', justifyContent: 'flex-start', marginBottom: '12px' }}>
        {stat('Сессий в выборке', b.sessions_count)}
        {stat('С профилем soft-skills', b.with_soft_skills_profile)}
        {stat('С текстовым резюме', b.with_summary)}
        {stat('С нарративом отчёта', b.with_narrative)}
        {stat('Аргументация (ср.)', b.avg_argumentation_level != null ? `${Math.round(b.avg_argumentation_level * 100)}%` : null, '0–1')}
        {stat('Осторожность к риску', b.avg_risk_aversion != null ? `${Math.round(b.avg_risk_aversion * 100)}%` : null, '1 = осторожный')}
        {stat('Рефлексия (ср.)', b.avg_self_reflection != null ? `${Math.round(b.avg_self_reflection * 100)}%` : null)}
        {stat('Пропуски рисков (этап 2)', b.median_missed_risks != null ? b.median_missed_risks : null, 'медиана')}
        {stat('Ложные риски (этап 2)', b.median_false_positives != null ? b.median_false_positives : null, 'медиана')}
      </div>
      {(b.negotiation_styles || []).length > 0 && (
        <div style={{ marginBottom: compact ? '8px' : '12px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Стили переговоров: </span>
          {b.negotiation_styles.map((s) => (
            <span
              key={s.style}
              style={{
                display: 'inline-block',
                margin: '4px 6px 4px 0',
                padding: '4px 10px',
                borderRadius: '999px',
                background: '#e0e7ff',
                fontSize: '12px',
                color: '#3730a3',
              }}
            >
              {_translateNegStyle(s.style)}: {s.count}
            </span>
          ))}
        </div>
      )}
      {!compact && clusterEntries.length > 0 && (
        <div>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>Типы по профилю LEXIC</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {clusterEntries.map(([key, c]) => (
              <div key={key} style={{ background: '#f8fafc', borderRadius: '8px', padding: '10px 12px', fontSize: '13px' }}>
                <strong>{c.label || key}</strong>
                <span style={{ color: '#64748b', marginLeft: '8px' }}>({c.count})</span>
                <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {(c.participants || []).map((p, i) => (
                    <button
                      key={p.session_id || i}
                      type="button"
                      onClick={() => onDrill && onDrill(p.session_id)}
                      style={{
                        border: '1px solid #cbd5e1',
                        borderRadius: '6px',
                        padding: '4px 8px',
                        background: 'white',
                        cursor: 'pointer',
                        fontSize: '12px',
                      }}
                    >
                      {p.name}
                      {p.case_code ? ` · ${p.case_code}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmployeeSessionsStrip({ participants, drillDown }) {
  if (!participants?.length) {
    return <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '16px' }}>Нет строк для выбранного сотрудника.</div>;
  }
  return (
    <div style={{ marginBottom: '20px' }}>
      <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#1f2937', marginBottom: '10px' }}>Лучшие попытки по кейсам</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {participants.map((p) => (
          <div
            key={p.row_key || p.session_id}
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: '10px',
              padding: '12px 14px',
              background: '#fafafa',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <strong style={{ color: '#0f172a' }}>{p.case_code || 'Кейс'}</strong>
              <span style={{ color: '#64748b', fontSize: '13px' }}>LEXIC итого: {p.total_score != null ? Math.round(p.total_score) : '—'}</span>
              {p.stage2_missed_risks != null && (
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px', background: '#fef3c7', color: '#92400e' }}>
                  Этап 2: пропусков рисков {p.stage2_missed_risks}
                </span>
              )}
              {p.negotiation_style && (
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px', background: '#e0e7ff', color: '#3730a3' }}>
                  {_translateNegStyle(p.negotiation_style)}
                </span>
              )}
              <button
                type="button"
                onClick={() => drillDown(p.session_id)}
                style={{
                  marginLeft: 'auto',
                  padding: '6px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: '#3b82f6',
                  color: 'white',
                  fontSize: '12px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Полный отчёт
              </button>
            </div>
            {p.summary_preview ? (
              <p style={{ margin: 0, fontSize: '13px', color: '#475569', lineHeight: 1.5 }}>{p.summary_preview}</p>
            ) : (
              <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>Резюме сессии появится после завершения кейса.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RatingSections({ showCaseColumn, ratingByCase, participants, filterParam, drillDown }) {
  const sortList = (list) =>
    [...list]
      .filter((p) => p[filterParam] != null)
      .sort((a, b) => (b[filterParam] ?? 0) - (a[filterParam] ?? 0));

  const renderRow = (p, i) => {
    const score = Math.round(p[filterParam] ?? 0);
    return (
      <div
        key={p.row_key || p.session_id || i}
        onClick={() => drillDown(p.session_id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '12px 16px',
          background: i < 3 ? (i === 0 ? '#fef9c3' : i === 1 ? '#f3f4f6' : '#fff7ed') : '#f9fafb',
          borderRadius: '10px',
          border: '1px solid #e5e7eb',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            minWidth: '28px',
            fontWeight: 'bold',
            fontSize: '16px',
            color: i < 3 ? ['#f59e0b', '#9ca3af', '#f97316'][i] : '#9ca3af',
          }}
        >
          {i < 3 ? ['🥇', '🥈', '🥉'][i] : `#${i + 1}`}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '14px', fontWeight: '600', color: '#1f2937' }}>
            {p.risk && '⚠️ '}
            {p.leader && '⭐ '}
            {p.name || p.username || '—'}
            {showCaseColumn && p.case_code ? (
              <span style={{ fontWeight: 500, color: '#6b7280', marginLeft: '6px', fontSize: '12px' }}>({p.case_code})</span>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            {PARAMS.map((param) =>
              p[param] != null ? (
                <span key={param} style={{ fontSize: '11px', color: '#6b7280' }}>
                  {param}: <b style={{ color: PARAM_META[param].color }}>{Math.round(p[param])}</b>
                </span>
              ) : null
            )}
          </div>
        </div>
        <div
          style={{
            fontSize: '20px',
            fontWeight: 'bold',
            color: getLevelColor(score),
            minWidth: '40px',
            textAlign: 'right',
          }}
        >
          {score}
        </div>
      </div>
    );
  };

  if (showCaseColumn && ratingByCase.length > 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {ratingByCase.map(([cc, list]) => {
          const sorted = sortList(list);
          return (
            <div key={cc}>
              <h4 style={{ fontSize: '14px', color: '#1f2937', marginBottom: '8px', fontWeight: 700 }}>📁 {cc}</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {sorted.length === 0 ? (
                  <div style={{ fontSize: '13px', color: '#9ca3af' }}>Нет данных по выбранному параметру</div>
                ) : (
                  sorted.map((p, i) => renderRow(p, i))
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const sorted = sortList(participants);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {sorted.length === 0 ? (
        <div style={{ fontSize: '13px', color: '#9ca3af' }}>Нет данных</div>
      ) : (
        sorted.map((p, i) => renderRow(p, i))
      )}
    </div>
  );
}

function KPITile({ label, value, sub, icon, color }) {
  return (
    <div
      style={{
        background: 'white',
        borderRadius: '10px',
        padding: '16px',
        boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
        borderTop: `4px solid ${color}`,
      }}
    >
      <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div style={{ fontSize: '26px', fontWeight: 'bold', color }}>
        {value ?? '—'}
      </div>
      {sub && <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>{sub}</div>}
    </div>
  );
}

function StagesMatrix({ participants, onDrillDown, showCaseColumn = false, showAttempts = false }) {
  if (!participants.length) return <div style={{ color: '#9ca3af', padding: '16px' }}>Нет данных</div>;

  const stages = ['stage-1', 'stage-2', 'stage-3', 'stage-4'];
  const stageLabels = { 'stage-1': 'Этап 1', 'stage-2': 'Этап 2', 'stage-3': 'Этап 3', 'stage-4': 'Этап 4' };

  const getStageColor = (avg) => {
    if (avg == null) return '#f3f4f6';
    if (avg >= 70) return '#d1fae5';
    if (avg >= 50) return '#fef9c3';
    if (avg >= 30) return '#fed7aa';
    return '#fee2e2';
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '12px' }}>
        Строка = лучшая сессия участника по выбранному кейсу (или все кейсы с колонкой «Кейс»).
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ background: '#f9fafb' }}>
            {showCaseColumn && (
              <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '700', color: '#374151' }}>Кейс</th>
            )}
            {showAttempts && (
              <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#374151' }}>Попыток</th>
            )}
            <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '700', color: '#374151' }}>Участник</th>
            {stages.map((s) => (
              <th key={s} style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#374151', minWidth: '80px' }}>
                {stageLabels[s]}
              </th>
            ))}
            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#374151' }}>Итог</th>
          </tr>
        </thead>
        <tbody>
          {participants.map((p, i) => {
            const snapshots = p.stage_snapshots || [];
            const byStage = Object.fromEntries(snapshots.map((s) => [s.stage_code, s]));
            return (
              <tr
                key={p.row_key || p.session_id || i}
                onClick={() => onDrillDown && onDrillDown(p.session_id)}
                style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
              >
                {showCaseColumn && (
                  <td style={{ padding: '8px 12px', fontSize: '12px', color: '#6b7280' }}>{p.case_code || '—'}</td>
                )}
                {showAttempts && (
                  <td style={{ padding: '8px 12px', textAlign: 'center', color: '#374151' }}>
                    {p.attempts_count != null ? p.attempts_count : '—'}
                  </td>
                )}
                <td style={{ padding: '8px 12px', fontWeight: '500', color: '#1f2937' }}>
                  {p.risk && '⚠️ '}{p.leader && '⭐ '}{p.name || p.username || '—'}
                </td>
                {stages.map((s) => {
                  const snap = byStage[s];
                  if (!snap) return (
                    <td key={s} style={{ padding: '8px 12px', textAlign: 'center', background: '#f9fafb', color: '#9ca3af' }}>⚪</td>
                  );
                  const normScores = snap.normalized_scores || {};
                  const vals = Object.values(normScores).filter((v) => v != null);
                  const avg = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
                  return (
                    <td key={s} style={{ padding: '8px 12px', textAlign: 'center', background: getStageColor(avg), fontWeight: '600' }}>
                      {avg != null ? avg : '—'}
                    </td>
                  );
                })}
                <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: '700', color: getLevelColor(p.total_score ?? 0) }}>
                  {p.total_score != null ? Math.round(p.total_score) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
