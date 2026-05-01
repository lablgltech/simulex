import React from 'react';

export default function DashboardFilters({
  overview,
  selectedCase,
  setSelectedCase,
  selectedUserId,
  setSelectedUserId,
  onRefresh,
  onDownloadCsv,
  participantsCount,
}) {
  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 'bold', color: '#1f2937', margin: 0 }}>
          Аналитика команды
        </h1>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onDownloadCsv}
            disabled={!participantsCount}
            style={{
              padding: '7px 14px',
              borderRadius: '8px',
              border: '1px solid #e5e7eb',
              background: participantsCount ? 'white' : '#f3f4f6',
              cursor: participantsCount ? 'pointer' : 'not-allowed',
              fontSize: '13px',
              color: '#374151',
            }}
          >
            CSV
          </button>
          <button
            type="button"
            onClick={onRefresh}
            style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: '13px', color: '#374151' }}
          >
            Обновить
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '13px', color: '#6b7280', fontWeight: 600 }}>Кейс</label>
        <select
          value={selectedCase}
          onChange={(e) => setSelectedCase(e.target.value)}
          disabled={!overview?.case_codes?.length}
          style={{
            padding: '7px 12px',
            borderRadius: '8px',
            border: '1px solid #d1d5db',
            fontSize: '13px',
            minWidth: '200px',
            background: overview?.case_codes?.length ? 'white' : '#f3f4f6',
          }}
        >
          {(overview?.case_codes?.length ? overview.case_codes : selectedCase ? [selectedCase] : []).map((c) => {
            const title = overview?.case_titles?.[c];
            return <option key={c} value={c}>{title || c}</option>;
          })}
        </select>

        <label style={{ fontSize: '13px', color: '#6b7280', fontWeight: 600 }}>Сотрудник</label>
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          style={{
            padding: '7px 12px',
            borderRadius: '8px',
            border: '1px solid #d1d5db',
            fontSize: '13px',
            minWidth: '180px',
            background: 'white',
          }}
        >
          <option value="">Все</option>
          {(overview?.team_members || []).map((m) => (
            <option key={m.user_id} value={String(m.user_id)}>{m.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
