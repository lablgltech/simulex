import React, { useState, useEffect, useCallback } from 'react';
import { getAdminApiUrl, getAdminHeaders } from '../api/config';
import RiskMatrixFileEditor from './caseEditor/editors/RiskMatrixFileEditor';
import GameConfigFileEditor from './caseEditor/editors/GameConfigFileEditor';

const STRUCTURED = {
  'stage-2/risk_matrix.json': 'risk_matrix',
  'stage-2/game_config.json': 'game_config',
};

/**
 * Модальное окно редактирования файла ресурса кейса.
 * Для risk_matrix / game_config — форма; остальное — текст; JSON — проверка и форматирование.
 */
export default function AdminFileModal({ caseId, path, onClose, onSaved }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(!!path);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [jsonError, setJsonError] = useState(null);
  const [editorMode, setEditorMode] = useState('auto'); // 'auto' | 'form' | 'text'
  const [loadNonce, setLoadNonce] = useState(0);

  const structuredKind = path && STRUCTURED[path];

  useEffect(() => {
    if (!caseId || !path) return;
    setLoading(true);
    setError(null);
    setJsonError(null);
    setEditorMode('auto');
    const url = `${getAdminApiUrl()}/cases/${encodeURIComponent(caseId)}/file?path=${encodeURIComponent(path)}`;
    fetch(url, { credentials: 'include', headers: getAdminHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Файл не найден' : `Ошибка ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const text = data.content ?? '';
        setContent(text);
        setLoadNonce((n) => n + 1);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [caseId, path]);

  const isJsonPath = path && path.endsWith('.json');

  const validateJsonIfNeeded = useCallback(() => {
    if (!isJsonPath) return true;
    try {
      JSON.parse(content || '{}');
      setJsonError(null);
      return true;
    } catch (e) {
      setJsonError(e.message || 'Невалидный JSON');
      return false;
    }
  }, [content, isJsonPath]);

  const handlePrettyJson = () => {
    if (!isJsonPath) return;
    try {
      const o = JSON.parse(content || '{}');
      setContent(JSON.stringify(o, null, 2));
      setJsonError(null);
    } catch (e) {
      setJsonError(e.message || 'Невалидный JSON');
    }
  };

  const handleSave = () => {
    if (!caseId || !path) return;
    if (isJsonPath && !validateJsonIfNeeded()) return;
    setSaving(true);
    setError(null);
    const url = `${getAdminApiUrl()}/cases/${encodeURIComponent(caseId)}/file`;
    fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: getAdminHeaders(),
      body: JSON.stringify({ path, content }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Ошибка ${res.status}`);
        onSaved?.();
        onClose();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  };

  if (!path) return null;

  const useForm = structuredKind && (editorMode === 'form' || (editorMode === 'auto' && structuredKind));

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}
    onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: 'white', borderRadius: '8px', maxWidth: '90vw', width: structuredKind ? '920px' : '800px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
      }}
      onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <strong>Файл: {path}</strong>
            {caseId && (
              <div style={{ fontSize: '12px', color: '#6b7280', fontWeight: 400, marginTop: '2px' }}>
                Кейс (data/cases/{caseId}/)
              </div>
            )}
            {isJsonPath && (
              <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
                После сохранения карта зависимостей в студии обновится автоматически.
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {structuredKind && (
              <>
                <button type="button" onClick={() => setEditorMode('form')} style={{ padding: '6px 10px', fontSize: '12px', border: editorMode === 'form' || (editorMode === 'auto' && structuredKind) ? '2px solid #3b82f6' : '1px solid #d1d5db', borderRadius: '6px', background: useForm ? '#dbeafe' : '#fff', cursor: 'pointer' }}>
                  Форма
                </button>
                <button type="button" onClick={() => setEditorMode('text')} style={{ padding: '6px 10px', fontSize: '12px', border: editorMode === 'text' ? '2px solid #3b82f6' : '1px solid #d1d5db', borderRadius: '6px', background: editorMode === 'text' ? '#dbeafe' : '#fff', cursor: 'pointer' }}>
                  Как JSON
                </button>
              </>
            )}
            <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px' }}>×</button>
          </div>
        </div>
        {error && (
          <div style={{ padding: '8px 16px', background: '#fee', color: '#c00' }}>{error}</div>
        )}
        {jsonError && (
          <div style={{ padding: '8px 16px', background: '#fef2f2', color: '#b91c1c', fontSize: '13px' }}>JSON: {jsonError}</div>
        )}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
          {loading ? (
            <p>Загрузка…</p>
          ) : useForm && structuredKind === 'risk_matrix' ? (
            <RiskMatrixFileEditor key={loadNonce} initialText={content} onChangeSerialized={setContent} />
          ) : useForm && structuredKind === 'game_config' ? (
            <GameConfigFileEditor key={loadNonce} initialText={content} onChangeSerialized={setContent} />
          ) : (
            <>
              {isJsonPath && (
                <div style={{ marginBottom: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button type="button" onClick={handlePrettyJson} style={{ padding: '6px 12px', fontSize: '12px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#f8fafc', cursor: 'pointer' }}>
                    Форматировать JSON
                  </button>
                </div>
              )}
              <textarea
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setJsonError(null);
                }}
                spellCheck={false}
                style={{
                  width: '100%', minHeight: '400px', fontFamily: isJsonPath ? 'monospace' : 'inherit', fontSize: '13px', padding: '8px', border: '1px solid #ccc', borderRadius: '4px',
                }}
              />
            </>
          )}
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid #eee', display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 16px', background: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Отмена</button>
          <button type="button" onClick={handleSave} disabled={loading || saving} style={{ padding: '8px 16px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: loading || saving ? 'not-allowed' : 'pointer' }}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
