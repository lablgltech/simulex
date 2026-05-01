import React, { useState, useMemo, useEffect, useCallback } from 'react';
import CaseDependencyPanel from '../CaseDependencyPanel';
import MarkdownContent from '../MarkdownContent';
import { stageDependencyGroup } from './stageDependencyGroup';
import CaseOverviewMap from './CaseOverviewMap';
import CaseReadinessChecklist from './CaseReadinessChecklist';
import { getAdminApiUrl, getAdminHeaders } from '../../api/config';

function relFromMdPath(mdPath, caseId) {
  if (!mdPath || !caseId) return null;
  const p = mdPath.replace(/\\/g, '/').trim();
  const want = `data/cases/${caseId}/`;
  if (p.startsWith(want)) return p.slice(want.length);
  const m = p.match(/data\/cases\/[^/]+\/(.+)$/);
  return m ? m[1] : null;
}

/**
 * «Студия»: карта кейса, чеклист, зависимости, компактные поля.
 */
export default function CaseEditorShell({
  selectedCase,
  validationErrors,
  onOpenMethodologyFile,
  openFileModal,
  updateCase,
  dependencyRefreshKey,
  methodologyDoc,
  expandedStages,
  toggleStage,
  updateStage,
  onOpenStageSelector,
  caseDirty,
}) {
  const [stageHighlight, setStageHighlight] = useState(null);
  const [depData, setDepData] = useState(null);
  const [depLoading, setDepLoading] = useState(true);
  const [problemsOnly, setProblemsOnly] = useState(false);

  const stages = selectedCase?.stages || [];
  const caseId = selectedCase?.id;

  const highlightGroup = useMemo(() => {
    if (!stageHighlight) return null;
    const st = stages.find((s) => s.id === stageHighlight);
    return st ? stageDependencyGroup(st) : null;
  }, [stageHighlight, stages]);

  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    setDepLoading(true);
    const url = `${getAdminApiUrl()}/cases/${encodeURIComponent(caseId)}/dependencies`;
    fetch(url, { credentials: 'include', headers: getAdminHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(`Ошибка ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setDepData(json);
      })
      .catch(() => {
        if (!cancelled) setDepData(null);
      })
      .finally(() => {
        if (!cancelled) setDepLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, dependencyRefreshKey]);

  const depItems = depData?.items || [];

  const scrollToDeps = useCallback(() => {
    document.getElementById('case-deps-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const onOpenCover = useCallback(() => {
    setStageHighlight(null);
    setProblemsOnly(false);
    openFileModal('cover.png');
  }, [openFileModal]);

  const onOpenContract = useCallback(() => {
    setStageHighlight(null);
    setProblemsOnly(false);
    const rel = relFromMdPath(selectedCase?.contract?.md_path, caseId);
    if (rel) openFileModal(rel);
    else scrollToDeps();
  }, [selectedCase, caseId, openFileModal, scrollToDeps]);

  return (
    <div>
      {validationErrors.length > 0 && (
        <ul style={{ background: '#fef2f2', padding: '12px 20px', borderRadius: '6px', marginBottom: '16px', color: '#b91c1c' }}>
          {validationErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <CaseReadinessChecklist
        stats={depData?.stats}
        validationErrors={validationErrors}
        caseDirty={caseDirty}
        problemsOnlyActive={problemsOnly}
        onShowProblemsOnly={() => {
          setProblemsOnly(true);
          setStageHighlight(null);
          scrollToDeps();
        }}
        onClearProblemsFilter={() => setProblemsOnly(false)}
      />

      <CaseOverviewMap
        selectedCase={selectedCase}
        depItems={depItems}
        selectedStageId={stageHighlight}
        onSelectStage={(id) => {
          setStageHighlight(id);
          setProblemsOnly(false);
          scrollToDeps();
        }}
        onOpenMethodology={onOpenMethodologyFile}
        onOpenCover={onOpenCover}
        onOpenContract={onOpenContract}
      />

      <div style={{ marginBottom: '12px' }}>
        <button
          type="button"
          onClick={onOpenStageSelector}
          style={{ padding: '6px 12px', fontSize: '12px', background: '#10b981', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
        >
          Изменить набор этапов
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <CaseDependencyPanel
            caseId={selectedCase.id}
            onOpenFile={openFileModal}
            refreshKey={dependencyRefreshKey}
            highlightGroup={highlightGroup}
            externalDeps={{ data: depData, loading: depLoading }}
            filterProblemsOnly={problemsOnly}
            useAccordion
            sectionId="case-deps-panel"
          />
        </div>
        <aside style={{ flex: '0 1 300px', minWidth: '260px' }}>
          <details open style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
            <summary style={{ fontWeight: 600, cursor: 'pointer', marginBottom: '8px' }}>Общие поля</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' }}>
              <label style={{ fontSize: '12px', color: '#64748b' }}>Название</label>
              <input type="text" value={selectedCase.title || ''} onChange={(e) => updateCase({ title: e.target.value })} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
              <label style={{ fontSize: '12px', color: '#64748b' }}>Статус</label>
              <select value={selectedCase.status || 'draft'} onChange={(e) => updateCase({ status: e.target.value })} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}>
                <option value="draft">draft</option>
                <option value="published">published</option>
                <option value="archived">archived</option>
              </select>
              <label style={{ fontSize: '12px', color: '#64748b' }}>Описание</label>
              <textarea value={selectedCase.description || ''} onChange={(e) => updateCase({ description: e.target.value })} rows={3} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
              <label style={{ fontSize: '12px', color: '#64748b' }}>Интро</label>
              <textarea value={selectedCase.intro ?? ''} onChange={(e) => updateCase({ intro: e.target.value })} rows={2} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
              <label style={{ fontSize: '12px', color: '#64748b' }}>Аутро</label>
              <textarea value={selectedCase.outro ?? ''} onChange={(e) => updateCase({ outro: e.target.value })} rows={2} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
              <div>
                <span style={{ fontSize: '12px', color: '#64748b', display: 'block', marginBottom: '6px' }}>LEXIC</span>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {['L', 'E', 'X', 'I', 'C'].map((k) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                      {k}
                      <input type="number" min={0} max={100} value={selectedCase.lexic_initial?.[k] ?? 50} onChange={(e) => updateCase({ lexic_initial: { ...selectedCase.lexic_initial, [k]: Number(e.target.value) || 0 } })} style={{ width: '48px', padding: '4px' }} />
                    </label>
                  ))}
                </div>
              </div>
              {selectedCase.contract && (
                <div style={{ padding: '8px', background: '#f9fafb', borderRadius: '6px', fontSize: '12px' }}>
                  <strong>Договор:</strong> {selectedCase.contract.code}
                  <div style={{ color: '#64748b', marginTop: '4px', wordBreak: 'break-all' }}>{selectedCase.contract.md_path}</div>
                </div>
              )}
              {selectedCase.crisis && (
                <div style={{ padding: '8px', background: '#f9fafb', borderRadius: '6px', fontSize: '12px' }}>
                  <strong>Кризис:</strong> check_after {selectedCase.crisis.check_after}, условий {selectedCase.crisis.conditions?.length ?? 0}
                </div>
              )}
            </div>
          </details>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ fontSize: '14px' }}>Методичка</strong>
              <button type="button" onClick={onOpenMethodologyFile} style={{ padding: '6px 10px', fontSize: '12px', background: '#0ea5e9', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                Файл
              </button>
            </div>
            {methodologyDoc.status === 'loading' && <p style={{ fontSize: '12px', color: '#64748b' }}>Загрузка…</p>}
            {methodologyDoc.status === 'error' && <p style={{ fontSize: '12px', color: '#b91c1c' }}>{methodologyDoc.error}</p>}
            {methodologyDoc.status === 'empty' && <p style={{ fontSize: '12px', color: '#64748b' }}>Файла ещё нет.</p>}
            {methodologyDoc.status === 'ok' && methodologyDoc.text && (
              <div style={{ maxHeight: '220px', overflow: 'auto', fontSize: '12px', border: '1px solid #f1f5f9', borderRadius: '6px', padding: '8px', background: '#fafafa' }}>
                <MarkdownContent content={methodologyDoc.text} />
              </div>
            )}
            {methodologyDoc.status === 'ok' && !methodologyDoc.text && <p style={{ fontSize: '12px', color: '#64748b' }}>Пусто.</p>}
          </div>

          <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>Этапы — кратко (полный список в классическом виде).</div>
          {(stages).map((stage, idx) => (
            <div key={stage.id} style={{ border: '1px solid #e5e7eb', borderRadius: '6px', marginBottom: '8px', overflow: 'hidden' }}>
              <button type="button" onClick={() => toggleStage(stage.id)} style={{ width: '100%', padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f9fafb', border: 'none', cursor: 'pointer', textAlign: 'left', fontWeight: 600, fontSize: '13px' }}>
                <span>{stage.title || stage.id}</span>
                <span>{expandedStages[stage.id] ? '▼' : '▶'}</span>
              </button>
              {expandedStages[stage.id] && (
                <div style={{ padding: '12px', background: 'white' }}>
                  <textarea value={stage.intro ?? ''} onChange={(e) => updateStage(idx, { intro: e.target.value })} rows={2} placeholder="Интро" style={{ width: '100%', padding: '6px', fontSize: '12px', border: '1px solid #e5e7eb', borderRadius: '4px', marginBottom: '8px' }} />
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <label style={{ fontSize: '11px', color: '#64748b' }}>points <input type="number" min={0} value={stage.points_budget ?? 0} onChange={(e) => updateStage(idx, { points_budget: Number(e.target.value) || 0 })} style={{ width: '56px', padding: '4px' }} /></label>
                    <label style={{ fontSize: '11px', color: '#64748b' }}>time <input type="number" min={0} value={stage.time_budget ?? ''} onChange={(e) => updateStage(idx, { time_budget: e.target.value === '' ? undefined : Number(e.target.value) })} style={{ width: '56px', padding: '4px' }} /></label>
                  </div>
                </div>
              )}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
