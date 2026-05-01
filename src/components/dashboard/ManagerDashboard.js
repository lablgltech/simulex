import React, { useState, useEffect, useCallback, useMemo } from 'react';
import ParticipantReport from '../ParticipantReport';
import DashboardNav from './DashboardNav';
import DashboardFilters from './DashboardFilters';
import AiBriefingSection from './AiBriefingSection';
import TeamCompetencySection from './TeamCompetencySection';
import TeamTableSection from './TeamTableSection';
import ActionPlanSection from './ActionPlanSection';
import { DEFAULT_DASHBOARD_CASE_CODE } from './constants';

export default function ManagerDashboard({ apiBase = '', caseCode = '', token = '' }) {
  const [overview, setOverview] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedCase, setSelectedCase] = useState(() => caseCode || DEFAULT_DASHBOARD_CASE_CODE);
  const [selectedUserId, setSelectedUserId] = useState('');

  const [briefingData, setBriefingData] = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [aiBriefingContext, setAiBriefingContext] = useState(null);
  const [behaviorData, setBehaviorData] = useState(null);
  const [prioritiesData, setPrioritiesData] = useState(null);

  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [drillReport, setDrillReport] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    setSelectedCase(caseCode || DEFAULT_DASHBOARD_CASE_CODE);
  }, [caseCode]);

  useEffect(() => {
    const codes = overview?.case_codes;
    if (!codes?.length) return;
    setSelectedCase((prev) => {
      if (codes.includes(prev)) return prev;
      if (codes.includes(DEFAULT_DASHBOARD_CASE_CODE)) return DEFAULT_DASHBOARD_CASE_CODE;
      return codes[0];
    });
  }, [overview]);

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
      const data = await res.json();
      setOverview(data);
      if (data.ai_briefing_context) setAiBriefingContext(data.ai_briefing_context);
      else setAiBriefingContext(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [apiBase, token, qsCaseUser]);

  const fetchParticipants = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/dashboard/participants${qsCaseUser()}`, { headers });
      if (res.ok) setParticipants(await res.json());
    } catch (_) {}
  }, [apiBase, qsCaseUser, token]);

  const fetchBriefing = useCallback(async () => {
    setBriefingLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/dashboard/ai-briefing${qsCaseUser()}`, { headers });
      const payload = res.ok ? await res.json() : null;
      setBriefingData(payload);
      if (res.ok && payload?.data_latest_session_updated_at != null) {
        setAiBriefingContext((prev) => ({
          ...(prev || {}),
          latest_session_updated_at: payload.data_latest_session_updated_at,
          sessions_count: prev?.sessions_count ?? 0,
          case_code: prev?.case_code,
          filter_user_id: prev?.filter_user_id,
        }));
      }
    } catch (_) { setBriefingData(null); }
    finally { setBriefingLoading(false); }
  }, [apiBase, qsCaseUser, token]);

  const fetchInsights = useCallback(async () => {
    const q = qsCaseUser();
    const base = `${apiBase}/api/dashboard`;
    try {
      const [b, p] = await Promise.all([
        fetch(`${base}/behavior${q}`, { headers }),
        fetch(`${base}/priorities${q}`, { headers }),
      ]);
      setBehaviorData(b.ok ? await b.json() : null);
      setPrioritiesData(p.ok ? await p.json() : null);
    } catch (_) {
      setBehaviorData(null); setPrioritiesData(null);
    }
  }, [apiBase, qsCaseUser, token]);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);
  useEffect(() => {
    fetchParticipants();
    fetchInsights();
  }, [fetchParticipants, fetchInsights]);

  useEffect(() => {
    setBriefingData(null);
  }, [selectedCase, selectedUserId]);

  const refreshAll = () => {
    fetchOverview();
    fetchParticipants();
    fetchInsights();
  };

  const caseMetrics = useMemo(() => {
    if (!overview?.by_case) return null;
    if (selectedCase) return overview.by_case[selectedCase] || null;
    if (overview.case_codes?.length === 1) return overview.by_case[overview.case_codes[0]] || null;
    return null;
  }, [overview, selectedCase]);

  const aiBriefingStale = useMemo(() => {
    const wl = briefingData?.data_latest_session_updated_at;
    const ctx = aiBriefingContext?.latest_session_updated_at;
    if (!wl || !ctx) return false;
    return ctx > wl;
  }, [briefingData, aiBriefingContext]);

  const showCaseColumn = false;

  const drillDown = async (sessionId) => {
    if (!sessionId) return;
    setSelectedSessionId(sessionId);
    setDrillLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/dashboard/participant/${sessionId}/detail`, { headers });
      if (res.ok) setDrillReport(await res.json());
    } catch (_) {}
    setDrillLoading(false);
  };

  const closeDrill = () => { setSelectedSessionId(null); setDrillReport(null); };

  const downloadParticipantsCsv = useCallback(() => {
    const cols = ['name', 'case_code', 'total_score', 'L', 'E', 'X', 'I', 'C', 'status', 'attempts_count', 'time_spent_seconds', 'session_id'];
    const esc = (v) => { if (v == null) return ''; const s = String(v); if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`; return s; };
    const lines = [cols.join(',')];
    for (const row of participants) lines.push(cols.map((c) => esc(row[c])).join(','));
    const blob = new Blob(['\ufeff', lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dashboard_${selectedCase}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [participants, selectedCase]);

  if (drillReport || drillLoading) {
    return (
      <div>
        <button
          type="button"
          onClick={closeDrill}
          style={{ margin: '16px', padding: '8px 16px', borderRadius: '8px', border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: '14px' }}
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
    <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '16px 24px' }}>
      <DashboardFilters
        overview={overview}
        selectedCase={selectedCase}
        setSelectedCase={setSelectedCase}
        selectedUserId={selectedUserId}
        setSelectedUserId={setSelectedUserId}
        onRefresh={refreshAll}
        onDownloadCsv={downloadParticipantsCsv}
        participantsCount={participants.length}
      />

      {error && (
        <div style={{ padding: '12px 16px', background: '#fee2e2', borderRadius: '8px', color: '#991b1b', marginBottom: '16px', fontSize: '13px' }}>
          Ошибка: {error}
        </div>
      )}

      <DashboardNav />

      {loading ? (
        <div style={{ padding: '60px', textAlign: 'center', color: '#9ca3af' }}>Загрузка данных...</div>
      ) : (
        <>
          <AiBriefingSection
            briefingData={briefingData}
            overview={overview}
            caseMetrics={caseMetrics}
            loading={briefingLoading}
            onRequestBriefing={fetchBriefing}
            aiBriefingStale={aiBriefingStale}
            contextSessionsCount={aiBriefingContext?.sessions_count}
          />

          <TeamCompetencySection
            overview={overview}
            caseMetrics={caseMetrics}
          />

          <TeamTableSection
            participants={participants}
            onDrill={drillDown}
            showCaseColumn={showCaseColumn}
            caseTitles={overview?.case_titles}
          />

          <ActionPlanSection
            briefingData={briefingData}
            behaviorData={behaviorData}
            prioritiesData={prioritiesData}
            onDrill={drillDown}
          />
        </>
      )}
    </div>
  );
}
