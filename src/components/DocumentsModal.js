import React, { useState, useMemo } from 'react';
import MarkdownContent from './MarkdownContent';

/**
 * Модалка «Документы»: этапы 1, 3, 4 — из GameView (HUD); этап 2 — вложенная копия в Stage2View с матрицей из данных этапа.
 * На этапе 4 GameView может добавить вкладку «Финальная версия договора» (markdown из Stage4View).
 * Левая колонка — список документов, правая — markdown / матрица рисков.
 */
export default function DocumentsModal({
  isOpen,
  onClose,
  docs = [],
  loading = false,
  error = null,
  /** Для тура симулятора: data-tutor-highlight на белой оболочке */
  tutorHighlightShellId = null,
}) {
  const [selectedId, setSelectedId] = useState(null);

  const visibleDocs = Array.isArray(docs) ? docs : docs?.docs || [];

  const selectedDoc = useMemo(() => {
    if (!visibleDocs.length) return null;
    const fallback = visibleDocs[0];
    if (!selectedId) return fallback;
    return visibleDocs.find((d) => d.id === selectedId) || fallback;
  }, [visibleDocs, selectedId]);

  if (!isOpen) return null;

  const renderRiskMatrix = (doc) => {
    const allRisks = (doc?.data?.risks || []).slice();
    const highRisks = allRisks.filter((r) => r.correct_level === 'high');
    const mediumRisks = allRisks.filter((r) => r.correct_level === 'medium');
    const lowRisks = allRisks.filter((r) => r.correct_level === 'low');
    const risks = [...highRisks, ...mediumRisks, ...lowRisks];
    const levelToColor = {
      low: '#22c55e',
      medium: '#facc15',
      high: '#f97373',
    };
    const levelToLabel = {
      low: 'Низкий',
      medium: 'Средний',
      high: 'Высокий',
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: '#111827',
          }}
        >
          Матрица рисков
        </div>
        <div
          style={{
            borderRadius: 16,
            padding: 20,
            background: '#f9fafb',
            boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
              gap: 12,
            }}
          >
            {risks.map((risk) => {
              const color = levelToColor[risk.correct_level] || '#e5e7eb';
              const textColor =
                risk.correct_level === 'low'
                  ? '#064e3b'
                  : risk.correct_level === 'medium'
                  ? '#7c2d12'
                  : '#7f1d1d';
              return (
                <div
                  key={risk.clause_id}
                  style={{
                    borderRadius: 12,
                    padding: '10px 8px',
                    textAlign: 'center',
                    fontSize: 12,
                    fontWeight: 600,
                    background: color,
                    color: textColor,
                    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.12)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 56,
                  }}
                >
                  <span style={{ wordBreak: 'break-word' }}>{risk.description}</span>
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginTop: 16,
              fontSize: 12,
              color: '#4b5563',
            }}
          >
            <span>Риск:</span>
            {['low', 'medium', 'high'].map((level) => (
              <span key={level} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    background: levelToColor[level],
                    display: 'inline-block',
                  }}
                />
                {levelToLabel[level]}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderContent = () => {
    if (loading) {
      return <div style={{ color: '#6b7280', fontSize: 14 }}>Загрузка документов…</div>;
    }
    if (error) {
      return (
        <div style={{ color: '#b91c1c', fontSize: 14 }}>
          Не удалось загрузить документы: {String(error)}
        </div>
      );
    }
    if (!selectedDoc) {
      return (
        <div style={{ color: '#6b7280', fontSize: 14 }}>
          Документы не найдены для этого кейса.
        </div>
      );
    }

    if (selectedDoc.kind === 'risk_matrix') {
      return renderRiskMatrix(selectedDoc);
    }

    return <MarkdownContent content={selectedDoc.content || ''} variant="document" />;
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2600,
      }}
      onClick={onClose}
    >
      <div
        {...(tutorHighlightShellId ? { 'data-tutor-highlight': tutorHighlightShellId } : {})}
        style={{
          background: '#ffffff',
          width: '90%',
          maxWidth: 960,
          height: '80vh',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(15,23,42,0.45)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: '#111827',
            }}
          >
            Документы
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              background: '#f3f4f6',
              borderRadius: 999,
              border: '1px solid #e5e7eb',
              fontSize: 13,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#e5e7eb';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#f3f4f6';
            }}
          >
            ✕ Закрыть
          </button>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left: list */}
          <div
            style={{
              width: 260,
              borderRight: '1px solid #e5e7eb',
              background: '#f9fafb',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {visibleDocs.length === 0 && !loading ? (
              <div
                style={{
                  fontSize: 13,
                  color: '#6b7280',
                  padding: 12,
                }}
              >
                Нет доступных документов.
              </div>
            ) : (
              visibleDocs.map((doc) => {
                const isActive = selectedDoc && selectedDoc.id === doc.id;
                return (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => setSelectedId(doc.id)}
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: 'none',
                      cursor: 'pointer',
                      background: isActive ? '#e0f2fe' : '#ffffff',
                      color: '#111827',
                      fontSize: 13,
                      fontWeight: isActive ? 600 : 500,
                      boxShadow: isActive ? '0 0 0 1px #3b82f6' : '0 1px 2px rgba(15,23,42,0.04)',
                    }}
                  >
                    {doc.title}
                  </button>
                );
              })
            )}
          </div>

          {/* Right: viewer */}
          <div
            style={{
              flex: 1,
              padding: 20,
              overflowY: 'auto',
            }}
          >
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}

