import React, { useState, useEffect, useCallback } from 'react';
import { getApiUrl, getAuthHeaders } from '../api/config';
import { handleApiError } from '../api/errorHandler';
import ReportView from '../components/ReportView';
import { useAuth } from '../context/AuthContext';

export default function MyReportsView({ onBack }) {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${getApiUrl()}/report/my-sessions`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(await res.text());
      const list = await res.json();
      setSessions(Array.isArray(list) ? list : []);
    } catch (err) {
      handleApiError(err, false);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const openReport = async (sessionId) => {
    setSelectedSessionId(sessionId);
    setReport(null);
    setReportError(null);
    setReportLoading(true);
    try {
      // Один запрос: сервер читает актуальный payload из БД, подмешивает report_snapshot, без повторного LLM при уже зафиксированном нарративе.
      const reportRes = await fetch(`${getApiUrl()}/report/participant/${encodeURIComponent(sessionId)}`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      if (!reportRes.ok) {
        const msg = await reportRes.text();
        throw new Error(msg || 'Не удалось загрузить отчёт');
      }
      const reportData = await reportRes.json();
      setReport(reportData);
    } catch (err) {
      setReportError(err?.message || 'Ошибка загрузки отчёта');
      handleApiError(err, false);
    } finally {
      setReportLoading(false);
    }
  };

  const closeReport = () => {
    setSelectedSessionId(null);
    setReport(null);
    setReportError(null);
  };

  if (selectedSessionId !== null) {
    return (
      <div style={{ minHeight: '100vh', background: '#f3f4f6', padding: '20px' }}>
        <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
          <button
            onClick={closeReport}
            style={{
              marginBottom: '16px',
              padding: '8px 16px',
              background: '#6b7280',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            ← К списку сессий
          </button>
          {reportLoading && (
            <div style={{ textAlign: 'center', padding: '48px 24px', color: '#6b7280' }}>
              <div style={{ fontSize: '18px' }}>Загрузка отчёта…</div>
            </div>
          )}
          {!reportLoading && reportError && (
            <div style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              padding: '20px',
              color: '#b91c1c',
              marginTop: '16px',
            }}>
              <strong>Не удалось загрузить отчёт.</strong>
              <p style={{ margin: '8px 0 0', fontSize: '14px' }}>{reportError}</p>
              <button
                type="button"
                onClick={() => { setReportError(null); openReport(selectedSessionId); }}
                style={{ marginTop: '12px', padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
              >
                Повторить
              </button>
            </div>
          )}
          {!reportLoading && report && (
            <ReportView
              report={report}
              viewerUser={user}
              caseData={{
                case: {
                  title: report.case_title || 'Кейс',
                  stages: (report.stages_info || []).map((s) => ({
                    id: s.stage_id,
                    title: s.stage_title,
                  })),
                },
              }}
              showRestart={false}
              onRestart={() => {}}
              onBackToStart={closeReport}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #f3f4f6 0%, #e0e7ff 100%)', padding: '24px' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <h1 style={{ margin: 0, fontSize: '24px', color: '#1f2937' }}>Мои отчёты</h1>
          <button
            onClick={onBack}
            style={{
              padding: '8px 16px',
              background: '#6b7280',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            ← Назад
          </button>
        </div>

        {loading && <p style={{ color: '#6b7280' }}>Загрузка списка сессий…</p>}

        {!loading && sessions.length === 0 && (
          <div
            style={{
              background: 'white',
              padding: '32px',
              borderRadius: '12px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
              textAlign: 'center',
              color: '#6b7280',
            }}
          >
            <p>У вас пока нет завершённых сессий с отчётами.</p>
            <p style={{ marginTop: '8px', fontSize: '14px' }}>Проходите кейсы в симуляторе — после завершения кейса отчёты появятся здесь.</p>
          </div>
        )}

        {!loading && sessions.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {sessions.map((s) => (
              <li
                key={s.session_id}
                style={{
                  background: 'white',
                  marginBottom: '12px',
                  padding: '16px 20px',
                  borderRadius: '8px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: '#1f2937' }}>
                    {s.case_title || s.case_code || s.case_id || 'Кейс'}
                  </div>
                  <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '4px' }}>
                    Этап {s.current_stage || '—'} · {s.created_at ? new Date(s.created_at).toLocaleString('ru-RU') : ''}
                  </div>
                </div>
                <button
                  onClick={() => openReport(s.session_id)}
                  style={{
                    padding: '8px 16px',
                    background: '#3b82f6',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  Открыть отчёт
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
