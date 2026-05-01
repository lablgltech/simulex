import React from 'react';
import CaseDependencyPanel from '../CaseDependencyPanel';
import MarkdownContent from '../MarkdownContent';

/** Классический редактор кейса (формы и этапы). */
export default function CaseEditorClassic({
  selectedCase,
  validationErrors,
  updateCase,
  updateStage,
  expandedStages,
  toggleStage,
  openFileModal,
  methodologyDoc,
  onOpenStageSelector,
  dependencyRefreshKey,
}) {
  return (
    <>
      {validationErrors.length > 0 && (
        <ul style={{ background: '#fef2f2', padding: '12px 20px', borderRadius: '6px', marginBottom: '16px', color: '#b91c1c' }}>
          {validationErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <CaseDependencyPanel caseId={selectedCase.id} onOpenFile={openFileModal} refreshKey={dependencyRefreshKey} />

      <section style={{ marginBottom: '24px' }}>
        <h4 style={{ margin: '0 0 12px 0' }}>Общие поля</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Название</label>
            <input type="text" value={selectedCase.title || ''} onChange={(e) => updateCase({ title: e.target.value })} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Статус</label>
            <select value={selectedCase.status || 'draft'} onChange={(e) => updateCase({ status: e.target.value })} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}>
              <option value="draft">draft</option>
              <option value="published">published</option>
              <option value="archived">archived</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: '12px' }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Описание</label>
          <textarea value={selectedCase.description || ''} onChange={(e) => updateCase({ description: e.target.value })} rows={3} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '12px' }}>
          <div>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Интро</label>
            <textarea value={selectedCase.intro ?? ''} onChange={(e) => updateCase({ intro: e.target.value })} rows={2} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Аутро</label>
            <textarea value={selectedCase.outro ?? ''} onChange={(e) => updateCase({ outro: e.target.value })} rows={2} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
          </div>
        </div>
        <div style={{ marginTop: '12px' }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>LEXIC (начальные значения)</label>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {['L', 'E', 'X', 'I', 'C'].map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span>{k}:</span>
                <input type="number" min={0} max={100} value={selectedCase.lexic_initial?.[k] ?? 50} onChange={(e) => updateCase({ lexic_initial: { ...selectedCase.lexic_initial, [k]: Number(e.target.value) || 0 } })} style={{ width: '56px', padding: '4px' }} />
              </label>
            ))}
          </div>
        </div>
        {selectedCase.contract && (
          <div style={{ marginTop: '12px', padding: '12px', background: '#f9fafb', borderRadius: '6px' }}>
            <strong>Договор (этап 3):</strong> {selectedCase.contract.code} — {selectedCase.contract.description}
            <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>md_path: {selectedCase.contract.md_path}; gamedata_path: {selectedCase.contract.gamedata_path}</div>
          </div>
        )}
        {selectedCase.crisis && (
          <div style={{ marginTop: '12px', padding: '12px', background: '#f9fafb', borderRadius: '6px' }}>
            <strong>Кризис:</strong> check_after: {selectedCase.crisis.check_after}; условий: {selectedCase.crisis.conditions?.length ?? 0}
          </div>
        )}
      </section>

      <section style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          <h4 style={{ margin: 0 }}>Методичка по кейсу</h4>
          <button type="button" onClick={() => openFileModal('documentation.md')} style={{ padding: '6px 12px', background: '#0ea5e9', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>
            Редактировать documentation.md
          </button>
        </div>
        <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#6b7280' }}>
          Ключи этапов и описание для методиста. Файл лежит в каталоге кейса: <code style={{ fontSize: '12px' }}>documentation.md</code>
        </p>
        {methodologyDoc.status === 'loading' && <p style={{ color: '#6b7280' }}>Загрузка методички…</p>}
        {methodologyDoc.status === 'empty' && (
          <div style={{ padding: '14px 16px', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: '8px', color: '#64748b', fontSize: '14px' }}>
            Файл ещё не создан. Он появится после сохранения кейса из мастера генерации или откройте «Редактировать documentation.md» и сохраните текст вручную.
          </div>
        )}
        {methodologyDoc.status === 'error' && (
          <div style={{ padding: '12px', background: '#fef2f2', borderRadius: '6px', color: '#b91c1c', fontSize: '14px' }}>
            {methodologyDoc.error}
          </div>
        )}
        {methodologyDoc.status === 'ok' && methodologyDoc.text && (
          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              padding: '16px 20px',
              maxHeight: 'min(520px, 55vh)',
              overflow: 'auto',
              background: '#fafafa',
              fontSize: '14px',
            }}
          >
            <MarkdownContent content={methodologyDoc.text} />
          </div>
        )}
        {methodologyDoc.status === 'ok' && !methodologyDoc.text && (
          <p style={{ color: '#6b7280', fontSize: '14px' }}>Файл пустой.</p>
        )}
      </section>

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h4 style={{ margin: 0 }}>Этапы ({selectedCase.stages?.length ?? 0})</h4>
          <button type="button" onClick={onOpenStageSelector} style={{ padding: '6px 12px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>
            Изменить этапы
          </button>
        </div>
        {(selectedCase.stages || []).map((stage, idx) => (
          <div key={stage.id} style={{ border: '1px solid #e5e7eb', borderRadius: '6px', marginBottom: '8px', overflow: 'hidden' }}>
            <button type="button" onClick={() => toggleStage(stage.id)} style={{ width: '100%', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f9fafb', border: 'none', cursor: 'pointer', textAlign: 'left', fontWeight: 600 }}>
              <span>{stage.title || stage.id} ({stage.type})</span>
              <span>{expandedStages[stage.id] ? '▼' : '▶'}</span>
            </button>
            {expandedStages[stage.id] && (
              <div style={{ padding: '16px', background: 'white' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                  <div>
                    <label style={{ fontSize: '12px', color: '#6b7280' }}>Интро</label>
                    <textarea value={stage.intro ?? ''} onChange={(e) => updateStage(idx, { intro: e.target.value })} rows={2} style={{ width: '100%', padding: '6px', fontSize: '13px', border: '1px solid #e5e7eb', borderRadius: '4px' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', color: '#6b7280' }}>points_budget</label>
                    <input type="number" min={0} value={stage.points_budget ?? 0} onChange={(e) => updateStage(idx, { points_budget: Number(e.target.value) || 0 })} style={{ width: '100%', padding: '6px' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', color: '#6b7280' }}>time_budget</label>
                    <input type="number" min={0} value={stage.time_budget ?? ''} onChange={(e) => updateStage(idx, { time_budget: e.target.value === '' ? undefined : Number(e.target.value) })} style={{ width: '100%', padding: '6px' }} />
                  </div>
                </div>

                {stage.id === 'stage-1' && (
                  <div style={{ marginTop: '12px' }}>
                    <strong>Документы</strong> ({stage.documents?.length ?? 0})
                    <ul style={{ margin: '4px 0', paddingLeft: '20px', fontSize: '13px' }}>
                      {(stage.documents || []).map((doc, i) => (
                        <li key={doc.id || i}>
                          {doc.id}: {doc.title} ({doc.type}, time_cost: {doc.time_cost})
                          <button type="button" onClick={() => { const docs = [...(stage.documents || [])]; docs.splice(i, 1); updateStage(idx, { documents: docs }); }} style={{ marginLeft: '8px', fontSize: '11px', color: '#dc2626' }}>Удалить</button>
                        </li>
                      ))}
                    </ul>
                    <button type="button" onClick={() => updateStage(idx, { documents: [...(stage.documents || []), { id: `doc-${(stage.documents?.length ?? 0) + 1}`, title: 'Новый документ', type: 'simple', time_cost: 5 }] })} style={{ padding: '4px 8px', fontSize: '12px', background: '#e0e7ff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>+ Документ</button>
                    <strong style={{ display: 'block', marginTop: '12px' }}>Атрибуты</strong> ({stage.attributes?.length ?? 0})
                    <ul style={{ margin: '4px 0', paddingLeft: '20px', fontSize: '13px' }}>
                      {(stage.attributes || []).map((attr, i) => (
                        <li key={attr.id || i}>
                          {attr.id}: {attr.title} — ориентиров в кейсе (reference_insights): {Array.isArray(attr.reference_insights) ? attr.reference_insights.length : 0}
                          <button type="button" onClick={() => { const attrs = [...(stage.attributes || [])]; attrs.splice(i, 1); updateStage(idx, { attributes: attrs }); }} style={{ marginLeft: '8px', fontSize: '11px', color: '#dc2626' }}>Удалить</button>
                        </li>
                      ))}
                    </ul>
                    <button type="button" onClick={() => updateStage(idx, { attributes: [...(stage.attributes || []), { id: `attr-${(stage.attributes?.length ?? 0) + 1}`, title: 'Новый атрибут', reference_insights: [] }] })} style={{ padding: '4px 8px', fontSize: '12px', background: '#e0e7ff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>+ Атрибут</button>
                    <div style={{ marginTop: '8px', fontSize: '13px', color: '#6b7280' }}>Действия: {stage.actions?.length ?? 0}</div>
                  </div>
                )}

                {(stage.id === 'stage-2' || stage.id === 'stage-3') && (
                  <div style={{ marginTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {stage.id === 'stage-2' && (
                      <>
                        <button type="button" onClick={() => openFileModal('stage-2/contract.json')} style={{ padding: '6px 12px', background: '#e0e7ff', border: '1px solid #a5b4fc', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>contract.json</button>
                        <button type="button" onClick={() => openFileModal('stage-2/risk_matrix.json')} style={{ padding: '6px 12px', background: '#e0e7ff', border: '1px solid #a5b4fc', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>risk_matrix.json</button>
                        <button type="button" onClick={() => openFileModal('stage-2/game_config.json')} style={{ padding: '6px 12px', background: '#e0e7ff', border: '1px solid #a5b4fc', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>game_config.json</button>
                      </>
                    )}
                    {stage.id === 'stage-3' && stage.resources && (
                      <>
                        {stage.resources.contract_md && <button type="button" onClick={() => openFileModal('stage-3/dogovor_PO.md')} style={{ padding: '6px 12px', background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>Договор (MD)</button>}
                        {stage.resources.gameData_json && <button type="button" onClick={() => openFileModal('stage-3/gameData.json')} style={{ padding: '6px 12px', background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>gameData.json</button>}
                        {stage.resources.ai_negotiation_system_prompt_md && <button type="button" onClick={() => openFileModal('stage-3/ai_negotiation_system_prompt.md')} style={{ padding: '6px 12px', background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>Промпт ИИ</button>}
                      </>
                    )}
                    {stage.id === 'stage-3' && !stage.resources?.contract_md && (
                      <>
                        <button type="button" onClick={() => openFileModal('stage-3/dogovor_PO.md')} style={{ padding: '6px 12px', background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>Договор (MD)</button>
                        <button type="button" onClick={() => openFileModal('stage-3/gameData.json')} style={{ padding: '6px 12px', background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>gameData.json</button>
                        <button type="button" onClick={() => openFileModal('stage-3/ai_negotiation_system_prompt.md')} style={{ padding: '6px 12px', background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>Промпт ИИ</button>
                      </>
                    )}
                  </div>
                )}

                <div style={{ marginTop: '12px' }}>
                  <details style={{ fontSize: '13px' }}>
                    <summary>Действия ({stage.actions?.length ?? 0})</summary>
                    <ul style={{ margin: '4px 0', paddingLeft: '20px' }}>
                      {(stage.actions || []).map((a, i) => (
                        <li key={a.id || i}>{a.id}: {a.title} ({a.type})</li>
                      ))}
                    </ul>
                  </details>
                  <details style={{ fontSize: '13px', marginTop: '6px' }}>
                    <summary>Письма ({stage.emails?.length ?? 0})</summary>
                    <ul style={{ margin: '4px 0', paddingLeft: '20px' }}>
                      {(stage.emails || []).map((e, i) => (
                        <li key={e.id || i}>{e.id}: {e.subject} (trigger: {e.trigger})</li>
                      ))}
                    </ul>
                  </details>
                </div>
              </div>
            )}
          </div>
        ))}
      </section>
    </>
  );
}
