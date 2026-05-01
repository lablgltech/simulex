import React from 'react';
import { stageDependencyGroup } from './stageDependencyGroup';
import { missingFilesCountForStage } from './stageMissingCount';

const nodeBase = {
  borderRadius: '10px',
  padding: '10px 14px',
  fontSize: '12px',
  textAlign: 'left',
  cursor: 'pointer',
  border: '2px solid transparent',
  minWidth: '100px',
  maxWidth: '160px',
};

/**
 * Визуальная «дорожка» кейса: этапы по порядку + якоря обложка / договор / кризис / методичка.
 */
export default function CaseOverviewMap({
  selectedCase,
  depItems,
  selectedStageId,
  onSelectStage,
  onOpenMethodology,
  onOpenCover,
  onOpenContract,
}) {
  const stages = selectedCase?.stages || [];
  const hasCrisis = Boolean(selectedCase?.crisis);
  const hasContract = Boolean(selectedCase?.contract);

  const pill = (active, hasIssue, clickable = true) => ({
    ...nodeBase,
    cursor: clickable ? 'pointer' : 'default',
    borderColor: active ? '#2563eb' : hasIssue ? '#f97316' : '#e5e7eb',
    background: active ? '#dbeafe' : hasIssue ? '#fff7ed' : '#f9fafb',
    boxShadow: active ? '0 0 0 1px #93c5fd' : 'none',
  });

  return (
    <section
      style={{
        marginBottom: '20px',
        padding: '16px',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        background: 'linear-gradient(180deg, #f8fafc 0%, #fff 100%)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', color: '#0f172a' }}>Карта кейса</h3>
        <span style={{ fontSize: '11px', color: '#64748b' }}>Клик по этапу — фильтр файлов ниже</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: '10px' }}>
        <button
          type="button"
          onClick={onOpenCover}
          style={pill(false, false)}
          title="Обложка в зависимостях"
        >
          <div style={{ fontWeight: 700, color: '#475569' }}>Обложка</div>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>cover</div>
        </button>
        {hasContract && (
          <button type="button" onClick={onOpenContract} style={pill(false, false)} title="Пути договора в JSON">
            <div style={{ fontWeight: 700, color: '#475569' }}>Договор</div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>{selectedCase.contract.code || 'contract'}</div>
          </button>
        )}
        {hasCrisis && (
          <div style={pill(false, false, false)} title="Настройки кризиса в JSON кейса">
            <div style={{ fontWeight: 700, color: '#475569' }}>Кризис</div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>{selectedCase.crisis.conditions?.length ?? 0} усл.</div>
          </div>
        )}
        <button type="button" onClick={onOpenMethodology} style={pill(false, false)}>
          <div style={{ fontWeight: 700, color: '#475569' }}>Методичка</div>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>.md</div>
        </button>

        {stages.map((s, idx) => {
          const miss = missingFilesCountForStage(s, depItems);
          const active = selectedStageId === s.id;
          return (
            <React.Fragment key={s.id}>
              {idx > 0 && (
                <div style={{ alignSelf: 'center', color: '#cbd5e1', fontSize: '18px', padding: '0 2px' }} aria-hidden>
                  →
                </div>
              )}
              <button
                type="button"
                onClick={() => onSelectStage(s.id)}
                style={pill(active, miss > 0)}
                title={stageDependencyGroup(s)}
              >
                <div style={{ fontWeight: 700, color: '#1e293b' }}>{s.id}</div>
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px', lineHeight: 1.3, maxHeight: '32px', overflow: 'hidden' }}>
                  {(s.title || '').slice(0, 42)}
                  {(s.title || '').length > 42 ? '…' : ''}
                </div>
                <div style={{ fontSize: '10px', marginTop: '6px', color: miss > 0 ? '#c2410c' : '#059669' }}>
                  {miss > 0 ? `нет файлов: ${miss}` : 'файлы ок'}
                </div>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </section>
  );
}
