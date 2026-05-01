import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { getAdminApiUrl, getAdminHeaders } from '../api/config';

function itemIsProblem(it) {
  if (it.foreign_case) return true;
  if (it.warning) return true;
  if (it.file_rel_path && !it.exists) return true;
  return false;
}

function renderTableRows(visibleItems, handleOpen) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0' }}>Поле</th>
            <th style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0' }}>Путь / файл</th>
            <th style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0' }}>Статус</th>
            <th style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0', width: '100px' }} />
          </tr>
        </thead>
        <tbody>
          {visibleItems.map((item, idx) => {
            const canOpen = Boolean(item.file_rel_path);
            const ok = item.exists;
            return (
              <tr key={`${item.json_pointer}-${idx}`} style={{ background: idx % 2 ? '#fafafa' : '#fff' }}>
                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' }}>{item.label}</td>
                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top', wordBreak: 'break-all' }}>
                  <code style={{ fontSize: '11px' }}>{item.raw_path}</code>
                  {item.file_rel_path && (
                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
                      <code>{item.file_rel_path}</code>
                      {item.foreign_case && item.file_target_case_id && (
                        <span style={{ color: '#b45309' }}> · {item.file_target_case_id}</span>
                      )}
                    </div>
                  )}
                  {item.warning && (
                    <div style={{ fontSize: '11px', color: '#b45309', marginTop: '6px', maxWidth: '420px' }}>{item.warning}</div>
                  )}
                </td>
                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' }}>
                  {!canOpen && <span style={{ color: '#94a3b8' }}>—</span>}
                  {canOpen && ok && <span style={{ color: '#059669' }}>есть</span>}
                  {canOpen && !ok && <span style={{ color: '#dc2626' }}>нет</span>}
                </td>
                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' }}>
                  <button
                    type="button"
                    disabled={!canOpen}
                    onClick={() => handleOpen(item)}
                    style={{
                      padding: '4px 10px',
                      fontSize: '12px',
                      border: '1px solid #cbd5e1',
                      borderRadius: '4px',
                      background: canOpen ? '#fff' : '#f1f5f9',
                      cursor: canOpen ? 'pointer' : 'not-allowed',
                      color: canOpen ? '#1e293b' : '#94a3b8',
                    }}
                  >
                    Открыть
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Карта файловых зависимостей: свой fetch или данные из родителя (externalDeps).
 */
export default function CaseDependencyPanel({
  caseId,
  onOpenFile,
  refreshKey = 0,
  highlightGroup = null,
  externalDeps,
  filterProblemsOnly = false,
  useAccordion = true,
  sectionId,
}) {
  const [internalData, setInternalData] = useState(null);
  const [internalLoading, setInternalLoading] = useState(false);
  const [internalError, setInternalError] = useState(null);

  const controlled = externalDeps !== undefined && externalDeps !== null;
  const data = controlled ? externalDeps.data : internalData;
  const loading = controlled ? Boolean(externalDeps.loading) : internalLoading;
  const fetchError = controlled ? null : internalError;

  useEffect(() => {
    if (controlled || !caseId) return;
    let cancelled = false;
    setInternalLoading(true);
    setInternalError(null);
    const url = `${getAdminApiUrl()}/cases/${encodeURIComponent(caseId)}/dependencies`;
    fetch(url, { credentials: 'include', headers: getAdminHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(`Ошибка ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setInternalData(json);
      })
      .catch((err) => {
        if (!cancelled) setInternalError(err.message || 'Ошибка загрузки');
      })
      .finally(() => {
        if (!cancelled) setInternalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, refreshKey, controlled]);

  const items = data?.items || [];
  const stats = data?.stats;
  const aliases = data?.same_path_aliases || [];
  const configPath = data?.config_path;

  const visibleItems = useMemo(() => {
    let list = items;
    if (highlightGroup) list = list.filter((it) => it.group === highlightGroup);
    if (filterProblemsOnly) list = list.filter(itemIsProblem);
    return list;
  }, [items, highlightGroup, filterProblemsOnly]);

  const grouped = useMemo(() => {
    const m = new Map();
    visibleItems.forEach((it) => {
      const g = it.group || 'Прочее';
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(it);
    });
    return Array.from(m.entries());
  }, [visibleItems]);

  const handleOpen = useCallback(
    (item) => {
      const rel = item.file_rel_path;
      if (!rel || typeof onOpenFile !== 'function') return;
      const target = item.foreign_case ? item.file_target_case_id : undefined;
      onOpenFile(rel, target || undefined);
    },
    [onOpenFile],
  );

  if (!caseId) return null;

  return (
    <section id={sectionId || undefined} style={{ marginBottom: '24px', border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', justifyContent: 'space-between' }}>
        <h4 style={{ margin: 0, fontSize: '15px' }}>Файловые зависимости</h4>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
          {stats && (
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              Всего: {stats.total}
              {typeof stats.missing_files === 'number' && stats.missing_files > 0 && (
                <span style={{ color: '#b91c1c', marginLeft: '8px' }}>· нет: {stats.missing_files}</span>
              )}
              {typeof stats.foreign_references === 'number' && stats.foreign_references > 0 && (
                <span style={{ color: '#b45309', marginLeft: '8px' }}>· чужой кейс: {stats.foreign_references}</span>
              )}
            </span>
          )}
        </div>
      </div>
      {configPath && (
        <div style={{ padding: '8px 16px', fontSize: '12px', color: '#64748b', background: '#fff', borderBottom: '1px solid #f1f5f9' }}>
          Конфиг: <code style={{ fontSize: '11px' }}>{configPath}</code>
        </div>
      )}
      {highlightGroup && (
        <div style={{ padding: '8px 16px', background: '#eff6ff', borderBottom: '1px solid #e5e7eb', fontSize: '13px' }}>
          Этап: <strong>{highlightGroup.replace(/^Этап:\s*/, '')}</strong>
        </div>
      )}
      {filterProblemsOnly && (
        <div style={{ padding: '8px 16px', background: '#fff7ed', borderBottom: '1px solid #fed7aa', fontSize: '13px' }}>
          Показаны только проблемные строки (нет файла, предупреждение, чужой кейс).
        </div>
      )}
      {loading && <p style={{ padding: '16px', margin: 0, color: '#64748b' }}>Загрузка карты зависимостей…</p>}
      {fetchError && (
        <div style={{ padding: '12px 16px', background: '#fef2f2', color: '#b91c1c', fontSize: '14px' }}>{fetchError}</div>
      )}
      {!loading && !fetchError && visibleItems.length === 0 && (
        <p style={{ padding: '16px', margin: 0, color: '#64748b' }}>Нет записей{highlightGroup ? ' для выбранного этапа' : ''}{filterProblemsOnly ? ' с проблемами' : ''}.</p>
      )}
      {!loading && !fetchError && visibleItems.length > 0 && !useAccordion && renderTableRows(visibleItems, handleOpen)}
      {!loading && !fetchError && visibleItems.length > 0 && useAccordion && (
        <div>
          {grouped.map(([groupName, groupItems]) => (
            <details key={groupName} defaultOpen style={{ borderBottom: '1px solid #f1f5f9' }}>
              <summary style={{ padding: '10px 14px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', background: '#fafafa', listStylePosition: 'outside' }}>
                {groupName}
                <span style={{ fontWeight: 400, color: '#64748b', marginLeft: '8px' }}>({groupItems.length})</span>
              </summary>
              <div style={{ padding: '0 8px 12px' }}>{renderTableRows(groupItems, handleOpen)}</div>
            </details>
          ))}
        </div>
      )}
      {!loading && !fetchError && aliases.length > 0 && (
        <details style={{ padding: '12px 16px', background: '#fffbeb', borderTop: '1px solid #fde68a', fontSize: '13px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Один файл на несколько полей ({aliases.length})</summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: '20px', color: '#78350f' }}>
            {aliases.map((a) => (
              <li key={a.raw_path} style={{ marginBottom: '8px' }}>
                <code style={{ fontSize: '11px' }}>{a.raw_path}</code>
                <div style={{ fontSize: '11px', marginTop: '4px' }}>{(a.json_pointers || []).join('; ')}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
