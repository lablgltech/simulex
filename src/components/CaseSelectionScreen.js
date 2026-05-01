import React, { useState, useEffect } from 'react';
import { API_URL } from '../api/config';
import { handleApiError } from '../api/errorHandler';

/**
 * Обложка карточки кейса: `data/case*.json` → поле `case.cover_image`.
 * Значение:
 * - полный URL (http/https) — как есть;
 * - `cases/<case_code>/cover` — файл data/cases/<case_code>/cover.png через GET /api/cases/<case_code>/cover;
 * - иначе путь к файлу из `public/` (например `moks/1etap.png`).
 */
function getCaseCoverSrc(caseItem) {
  const publicBase = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const raw = caseItem?.cover_image;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return t;
  const apiBase = (API_URL || '').replace(/\/$/, '');
  if (/^cases\/case-[a-zA-Z0-9_-]+\/cover$/i.test(t)) {
    const seg = t.replace(/^\/+/, '');
    return `${apiBase}/${seg}`;
  }
  const path = t.startsWith('/') ? t : `/${t.replace(/^\/+/, '')}`;
  return `${publicBase}${path}`;
}

/** Минимальная высота карточки кейса и gap сетки — без вертикальной прокрутки экрана на типичном ноутбуке. */
const CASE_CARD_MIN_HEIGHT_PX = 256;
const CASE_GRID_GAP_PX = 14;

/** «Кейс: Договор — полный цикл» — по умолчанию выбран, если есть в ответе API. */
const DEFAULT_CASE_ID = 'case-001';

function CaseCoverPlaceholder() {
  return (
    <div
      aria-label="Обложка не задана"
      title="Обложка не задана"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundImage:
          'repeating-linear-gradient(-45deg, transparent, transparent 6px, rgba(255,255,255,0.22) 6px, rgba(255,255,255,0.22) 12px), linear-gradient(155deg, #e5e7eb 0%, #d1d5db 42%, #cbd5e1 100%)',
      }}
    >
      <span style={{ fontSize: 40, lineHeight: 1, opacity: 0.22, userSelect: 'none' }}>📄</span>
    </div>
  );
}

export default function CaseSelectionScreen({
  onCaseSelect,
  onBack,
  /** Показывать пути к файлам, LEXIC и служебные метки (роль admin/superuser) */
  showTechnicalMetadata = false,
}) {
  const [cases, setCases] = useState([]);
  const [selectedCase, setSelectedCase] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stackLayout, setStackLayout] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches,
  );

  useEffect(() => {
    loadCases();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const onChange = () => setStackLayout(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const loadCases = async () => {
    try {
      const response = await fetch(`${API_URL}/cases`, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const casesList = await response.json();
      
      console.log('📂 Загружено кейсов:', casesList.length);
      console.log('📄 Кейсы:', casesList.map(c => ({ id: c.id, title: c.title })));
      
      // Добавляем дополнительные поля для UI
      const enrichedCases = casesList.map((caseItem) => ({
        ...caseItem,
        completed: false,
      }));
      
      setCases(enrichedCases);
      if (enrichedCases.length > 0) {
        setSelectedCase(
          enrichedCases.find((c) => c.id === DEFAULT_CASE_ID) || enrichedCases[0],
        );
      }
      setLoading(false);
    } catch (error) {
      console.error('❌ Ошибка загрузки кейсов:', error);
      handleApiError(error, false);
      setLoading(false);
    }
  };

  const getCaseColor = (index, caseItem) => {
    if (caseItem.completed) return '#fbbf24'; // Желтый - пройденные
    if (index === 0) return '#10b981'; // Зеленый - кейс 1
    if (index === 1) return '#8b5cf6'; // Фиолетовый - кейс 2
    if (index === 2) return '#fbbf24'; // Желтый - кейс 3
    return '#6b7280'; // Серый - остальные
  };

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          minHeight: 0,
          background: '#f9fafb',
        }}
      >
        <p>Загрузка кейсов...</p>
      </div>
    );
  }

  const detailCoverSrc = selectedCase ? getCaseCoverSrc(selectedCase) : null;

  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: '#f9fafb',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          padding: '16px 24px 12px',
          maxWidth: '1400px',
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <h1 style={{ margin: '0 0 10px 0', fontSize: '26px', fontWeight: 'bold', flexShrink: 0 }}>
          Выбор кейса
        </h1>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: stackLayout ? 'minmax(0, 1fr)' : 'minmax(0, 2fr) minmax(0, 1fr)',
          /* Десктоп: без прокрутки; много карточек — одна прокрутка сетки. */
          gridTemplateRows: stackLayout ? 'auto auto' : 'auto',
          gap: '16px',
          flex: 1,
          minHeight: 0,
          alignContent: 'stretch',
          alignItems: 'start',
          overflowX: 'hidden',
          overflowY:
            stackLayout || (!stackLayout && cases.length > 9) ? 'auto' : 'hidden',
          WebkitOverflowScrolling: stackLayout || cases.length > 9 ? 'touch' : undefined,
        }}
      >
        {/* Main Content - Case List */}
        <div
          style={{
            minWidth: 0,
            minHeight: 0,
            overflow: 'visible',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: `${CASE_GRID_GAP_PX}px`,
            }}
          >
            {cases.map((caseItem, index) => {
              const isSelected = selectedCase?.id === caseItem.id;
              const borderColor = getCaseColor(index, caseItem);
              const coverSrc = getCaseCoverSrc(caseItem);

              return (
                <div
                  key={caseItem.id}
                  onClick={() => setSelectedCase(caseItem)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedCase(caseItem);
                    }
                  }}
                  style={{
                    border: `3px solid ${borderColor}`,
                    borderRadius: '14px',
                    background: isSelected ? '#f8fafc' : '#fff',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'box-shadow 0.2s, transform 0.2s',
                    boxShadow: isSelected
                      ? '0 10px 28px rgba(15, 23, 42, 0.12)'
                      : '0 2px 10px rgba(15, 23, 42, 0.06)',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: `${CASE_CARD_MIN_HEIGHT_PX}px`,
                    overflow: 'hidden',
                    outline: 'none',
                  }}
                >
                  {isSelected && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '10px',
                        left: '10px',
                        zIndex: 3,
                        width: '28px',
                        height: '28px',
                        background: '#10b981',
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'white',
                        fontWeight: 'bold',
                        fontSize: '14px',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                      }}
                    >
                      ✓
                    </div>
                  )}
                  <div
                    style={{
                      position: 'relative',
                      height: '128px',
                      flexShrink: 0,
                      background: '#e2e8f0',
                    }}
                  >
                    {coverSrc ? (
                      <>
                        <img
                          src={coverSrc}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            objectPosition: 'center',
                            display: 'block',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            background:
                              'linear-gradient(to top, rgba(15,23,42,0.55) 0%, rgba(15,23,42,0.08) 45%, transparent 100%)',
                            pointerEvents: 'none',
                          }}
                        />
                      </>
                    ) : (
                      <CaseCoverPlaceholder />
                    )}
                  </div>
                  <div
                    style={{
                      padding: '14px 16px 16px',
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-start',
                      gap: '10px',
                      minHeight: 0,
                    }}
                  >
                    <h3
                      style={{
                        margin: 0,
                        fontSize: '16px',
                        fontWeight: 700,
                        color: '#0f172a',
                        lineHeight: 1.35,
                        wordBreak: 'break-word',
                      }}
                    >
                      {caseItem.title}
                    </h3>
                    <div style={{ marginTop: 'auto' }}>
                      {showTechnicalMetadata && caseItem.data_folder && (
                        <div
                          style={{
                            fontSize: '10px',
                            color: '#94a3b8',
                            fontFamily: 'monospace',
                            marginBottom: '6px',
                            wordBreak: 'break-all',
                          }}
                          title={caseItem.config_file}
                        >
                          📁 {caseItem.data_folder}
                        </div>
                      )}
                      {caseItem.stages_count != null && caseItem.stages_count !== '' && (
                        <div
                          style={{
                            fontSize: '12px',
                            color: '#2563eb',
                            fontWeight: 600,
                            fontFamily: "'Montserrat', sans-serif",
                          }}
                        >
                          Этапов: {caseItem.stages_count}
                        </div>
                      )}
                      {showTechnicalMetadata && isSelected && caseItem.lexic_initial && (
                        <div style={{ marginTop: '8px', fontSize: '11px', color: '#64748b' }}>
                          <strong>L.E.X.I.C:</strong>{' '}
                          {caseItem.lexic_initial.L}.{caseItem.lexic_initial.E}.{caseItem.lexic_initial.X}.
                          {caseItem.lexic_initial.I}.{caseItem.lexic_initial.C}
                        </div>
                      )}
                      {showTechnicalMetadata && index > 0 && (
                        <div style={{ marginTop: '8px', display: 'flex', gap: '5px', fontSize: '10px', color: '#93c5fd' }}>
                          <span>×</span>
                          <span>×</span>
                          <span>×</span>
                          <span>→</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {cases.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
              <p>Кейсы не найдены. Проверьте подключение к серверу.</p>
            </div>
          )}
        </div>

        {/* Right Sidebar: скролл только у текста; кнопка «Начать» всегда в зоне видимости */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            minWidth: 0,
            minHeight: 0,
            alignSelf: 'stretch',
            ...(stackLayout ? {} : { width: '100%', maxHeight: 'calc(100vh - 200px)' }),
          }}
        >
          {/* Case Details */}
          {selectedCase && (
            <div
              style={{
                background: 'white',
                borderRadius: '14px',
                boxShadow: '0 4px 20px rgba(15, 23, 42, 0.08)',
                overflow: 'hidden',
                border: '1px solid #e2e8f0',
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                minHeight: 0,
                ...(stackLayout ? {} : { maxHeight: '100%' }),
              }}
            >
              <div style={{ position: 'relative', height: '112px', background: '#e2e8f0', flexShrink: 0 }}>
                {detailCoverSrc ? (
                  <>
                    <img
                      src={detailCoverSrc}
                      alt=""
                      loading="eager"
                      decoding="async"
                      fetchPriority="high"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        objectPosition: 'center',
                        display: 'block',
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'linear-gradient(to top, rgba(15,23,42,0.65) 0%, transparent 55%)',
                        pointerEvents: 'none',
                      }}
                    />
                  </>
                ) : (
                  <CaseCoverPlaceholder />
                )}
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                    WebkitOverflowScrolling: 'touch',
                    padding: '12px 14px 8px',
                  }}
                >
                  <h3 style={{ marginTop: 0, marginBottom: '8px', fontSize: '16px', lineHeight: 1.3, color: '#0f172a' }}>
                    {selectedCase.title}
                  </h3>

                  <p
                    className="simulex-content"
                    style={{
                      fontSize: '13px',
                      lineHeight: 1.5,
                      color: '#475569',
                      marginBottom: '10px',
                      marginTop: 0,
                      overflowWrap: 'break-word',
                      wordBreak: 'break-word',
                    }}
                  >
                    {selectedCase.description || 'Описание кейса появится после настройки в админке.'}
                  </p>

                  {showTechnicalMetadata && (selectedCase.config_file || selectedCase.data_folder) && (
                    <div style={{ marginBottom: '10px', fontSize: '12px' }}>
                      <strong style={{ color: '#374151' }}>Папки и конфиг</strong>
                      <div
                        title={[selectedCase.config_file, selectedCase.data_folder].filter(Boolean).join('\n')}
                        style={{
                          marginTop: '4px',
                          padding: '8px',
                          background: '#f8fafc',
                          borderRadius: '6px',
                          fontFamily: 'monospace',
                          fontSize: '10px',
                          lineHeight: 1.35,
                          maxHeight: '4.2em',
                          overflow: 'hidden',
                          wordBreak: 'break-all',
                        }}
                      >
                        {selectedCase.config_file && (
                          <div style={{ marginBottom: '2px' }}>
                            <span style={{ color: '#64748b' }}>Конфиг:</span> {selectedCase.config_file}
                          </div>
                        )}
                        {selectedCase.data_folder && (
                          <div>
                            <span style={{ color: '#64748b' }}>Папка:</span> {selectedCase.data_folder}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {selectedCase.stages_count > 0 && (
                    <div style={{ marginBottom: '10px' }}>
                      <strong style={{ fontSize: '12px', color: '#374151' }}>Этапы ({selectedCase.stages_count})</strong>
                      <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {(selectedCase.stages && selectedCase.stages.length > 0
                          ? selectedCase.stages
                          : [
                              { id: 'stage-1', title: 'Этап 1: Выявление контекста' },
                              { id: 'stage-2', title: 'Этап 2: Формирование позиции' },
                              { id: 'stage-3', title: 'Этап 3: Согласование' },
                              { id: 'stage-4', title: 'Этап 4: Кризис' },
                            ].slice(0, selectedCase.stages_count)
                        ).map((stage, idx) => {
                          const icons = { 'stage-1': '📋', 'stage-2': '🎯', 'stage-3': '🤝', 'stage-4': '⚠️' };
                          const name = stage.title || stage.name || `Этап ${idx + 1}`;
                          return (
                            <div
                              key={stage.id || idx}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '6px 10px',
                                background: '#f0fdf4',
                                borderRadius: '6px',
                                border: '1px solid #bbf7d0',
                              }}
                            >
                              <span style={{ fontSize: '14px' }}>{icons[stage.id] || '📄'}</span>
                              <span style={{ fontSize: '12px', color: '#166534', lineHeight: 1.3 }}>{name}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {showTechnicalMetadata && selectedCase.lexic_initial && (
                    <div style={{ marginBottom: '0', padding: '6px 8px', background: '#f0f9ff', borderRadius: '6px' }}>
                      <strong style={{ fontSize: '10px', color: '#334155' }}>LEXIC (старт)</strong>
                      <div style={{ marginTop: '2px', fontSize: '11px', lineHeight: 1.35, fontFamily: 'monospace' }}>
                        L:{selectedCase.lexic_initial.L} E:{selectedCase.lexic_initial.E} X:{selectedCase.lexic_initial.X}{' '}
                        I:{selectedCase.lexic_initial.I} C:{selectedCase.lexic_initial.C}
                      </div>
                    </div>
                  )}
                </div>

                <div
                  style={{
                    flexShrink: 0,
                    padding: '10px 14px 14px',
                    borderTop: '1px solid #f1f5f9',
                    background: '#fff',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      console.log('🚀 Запуск кейса:', selectedCase.id || selectedCase);
                      onCaseSelect(selectedCase.id || selectedCase);
                    }}
                    style={{
                      width: '100%',
                      padding: '12px',
                      background: '#10b981',
                      color: 'white',
                      border: 'none',
                      borderRadius: '10px',
                      cursor: 'pointer',
                      fontSize: '16px',
                      fontWeight: 'bold',
                      transition: 'background 0.2s',
                      fontFamily: "'Montserrat', sans-serif",
                    }}
                    onMouseEnter={(e) => {
                      e.target.style.background = '#059669';
                    }}
                    onMouseLeave={(e) => {
                      e.target.style.background = '#10b981';
                    }}
                  >
                    🚀 Начать
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
