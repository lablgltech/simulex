import React from 'react';

/**
 * Краткий чеклист готовности для методиста (данные уже с фронта / отчёта зависимостей).
 */
export default function CaseReadinessChecklist({
  stats,
  validationErrors,
  caseDirty,
  onShowProblemsOnly,
  onClearProblemsFilter,
  problemsOnlyActive,
}) {
  const missing = stats?.missing_files ?? 0;
  const foreign = stats?.foreign_references ?? 0;
  const valOk = !validationErrors?.length;

  const row = (ok, label, detail, action) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '8px 0',
        borderBottom: '1px solid #f1f5f9',
        fontSize: '13px',
      }}
    >
      <span style={{ color: ok ? '#059669' : '#dc2626', fontWeight: 700, minWidth: '18px' }}>{ok ? '✓' : '!'}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, color: '#334155' }}>{label}</div>
        {detail && <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>{detail}</div>}
      </div>
      {action}
    </div>
  );

  return (
    <section
      style={{
        marginBottom: '16px',
        padding: '14px 16px',
        borderRadius: '10px',
        border: '1px solid #e2e8f0',
        background: '#fff',
      }}
    >
      <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#0f172a' }}>Готовность к проверке</h4>
      {row(
        missing === 0,
        'Файлы на диске',
        missing > 0 ? `Не найдено файлов: ${missing}` : 'Все пути из отчёта разрешены',
        missing > 0 ? (
          <button
            type="button"
            onClick={() => onShowProblemsOnly?.()}
            style={{ fontSize: '12px', padding: '4px 10px', border: '1px solid #fca5a5', borderRadius: '6px', background: '#fef2f2', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            Только проблемы
          </button>
        ) : null,
      )}
      {row(
        foreign === 0,
        'Ссылки на другие кейсы',
        foreign > 0 ? `Чужие папки: ${foreign} — проверьте шаблоны` : 'Нет ссылок в чужие каталоги',
        null,
      )}
      {row(
        valOk,
        'Валидация структуры кейса',
        valOk ? 'Обязательные поля и этапы заполнены' : `${validationErrors.length} замечаний — см. список выше`,
        null,
      )}
      {row(
        !caseDirty,
        'Сохранение JSON кейса',
        caseDirty ? 'Есть несохранённые правки — нажмите «Сохранить» в шапке' : 'Черновик совпадает с последней загрузкой/сохранением',
        null,
      )}
      {problemsOnlyActive && (
        <div style={{ marginTop: '10px' }}>
          <button
            type="button"
            onClick={() => onClearProblemsFilter?.()}
            style={{ fontSize: '12px', padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#f8fafc', cursor: 'pointer' }}
          >
            Показать все файлы в таблице
          </button>
        </div>
      )}
    </section>
  );
}
