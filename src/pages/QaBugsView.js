import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getApiUrl, getAuthHeaders } from '../api/config';
import { handleApiError } from '../api/errorHandler';
import { useAuth } from '../context/AuthContext';
import { userCanEditQaBugStatus } from '../config/qaTracker';

const card = {
  background: 'white',
  padding: '20px',
  borderRadius: '8px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  marginBottom: '16px',
};

const labelStyle = { display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '6px' };
const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '14px',
  boxSizing: 'border-box',
};

function getAuthHeadersMultipart() {
  const token = typeof localStorage !== 'undefined' && localStorage.getItem('simulex_auth_token');
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Fetch картинки вложения: при абсолютном REACT_APP_API_URL относительный /api/... иначе ушёл бы не на тот хост. */
function resolveQaFileFetchUrl(relativeOrAbsolute) {
  if (relativeOrAbsolute == null || String(relativeOrAbsolute).trim() === '') return '';
  const s = String(relativeOrAbsolute).trim();
  if (/^https?:\/\//i.test(s)) return s;
  const api = getApiUrl();
  if (api.startsWith('http')) {
    const base = api.replace(/\/api\/?$/i, '');
    return `${base}${s.startsWith('/') ? s : `/${s}`}`;
  }
  return s.startsWith('/') ? s : `/${s}`;
}

function normalizeQaAttachments(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const a = raw[i];
    if (a == null) continue;
    if (typeof a === 'string') {
      const n = a.trim();
      if (n) out.push({ name: n, url: `/api/qa/files/${encodeURIComponent(n)}` });
      continue;
    }
    const name = a.name != null ? String(a.name).trim() : '';
    let url = a.url != null ? String(a.url).trim() : '';
    if (!url && name) url = `/api/qa/files/${encodeURIComponent(name)}`;
    if (name || url) {
      const safeName = name || (url.includes('/') ? url.replace(/^.*\//, '') : url) || `file-${i}`;
      out.push({ name: safeName, url });
    }
  }
  return out;
}

/** Человекочитаемый текст для FastAPI/Pydantic detail (строка, объект или массив ошибок). */
function formatQaApiErrorDetail(detail) {
  if (detail == null) return 'Ошибка сохранения';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((err) => {
      if (err && typeof err === 'object' && err.msg) {
        const loc = Array.isArray(err.loc) ? err.loc.filter(Boolean).join(' → ') : '';
        return loc ? `${loc}: ${err.msg}` : err.msg;
      }
      return JSON.stringify(err);
    });
    return parts.join('; ') || 'Ошибка проверки данных';
  }
  try {
    return JSON.stringify(detail);
  } catch (_) {
    return 'Ошибка сохранения';
  }
}

function textPreview15(s) {
  if (s == null || String(s).trim() === '') return '—';
  const t = String(s).trim();
  const chars = Array.from(t);
  if (chars.length <= 15) return t;
  return `${chars.slice(0, 15).join('')}…`;
}

function textPreview30(s) {
  if (s == null || String(s).trim() === '') return '—';
  const t = String(s).trim();
  const chars = Array.from(t);
  if (chars.length <= 30) return t;
  return `${chars.slice(0, 30).join('')}…`;
}

function severityColor(sev) {
  if (sev === 'высокая') return '#b91c1c';
  if (sev === 'средняя') return '#b45309';
  return '#6b7280';
}

/** Подписи статусов QA (в API и БД — латинские коды). */
const QA_STATUS_LABEL_RU = {
  new: 'Новое',
  triaged: 'Принято',
  in_progress: 'В работе',
  done: 'Готово',
  wontfix: 'Не исправляем',
};

function qaStatusLabelRu(code) {
  if (code == null || String(code).trim() === '') return '—';
  const k = String(code).trim();
  return QA_STATUS_LABEL_RU[k] || k;
}

/** Разбивает текст на фрагменты и делает токены #123 кликабельными ссылками на карточку замечания. */
function renderTextWithHashBugIds(text, openBugById) {
  if (text == null || String(text).trim() === '') return null;
  const s = String(text);
  const parts = s.split(/(#\d+)/g);
  return parts.map((part, i) => {
    const m = part.match(/^#(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      return (
        <button
          key={`hash-bug-${i}-${id}`}
          type="button"
          onClick={() => openBugById(id)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            margin: 0,
            cursor: 'pointer',
            color: '#2563eb',
            textDecoration: 'underline',
            font: 'inherit',
            display: 'inline',
          }}
        >
          {part}
        </button>
      );
    }
    return <span key={`tx-${i}`}>{part}</span>;
  });
}

function qaLastAreaStorageKey(userId) {
  return `simulex_qa_last_area_${userId}`;
}

function readStoredLastArea(userId, allowedAreas) {
  if (userId == null || Number.isNaN(Number(userId)) || !Array.isArray(allowedAreas) || !allowedAreas.length) {
    return null;
  }
  try {
    const raw = localStorage.getItem(qaLastAreaStorageKey(Number(userId)));
    if (raw && allowedAreas.includes(raw)) return raw;
  } catch (_) {}
  return null;
}

function writeStoredLastArea(userId, area) {
  if (userId == null || Number.isNaN(Number(userId)) || !area) return;
  try {
    localStorage.setItem(qaLastAreaStorageKey(Number(userId)), area);
  } catch (_) {}
}

function AuthedQaImage({ urlPath }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [err, setErr] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let created = null;
    setBlobUrl(null);
    setErr(false);
    const resolved = resolveQaFileFetchUrl(urlPath);
    if (!resolved) {
      setErr(true);
      return undefined;
    }
    (async () => {
      try {
        const res = await fetch(resolved, {
          credentials: 'include',
          headers: getAuthHeadersMultipart(),
        });
        if (!res.ok || cancelled) {
          if (!cancelled) setErr(true);
          return;
        }
        const b = await res.blob();
        if (cancelled) return;
        created = URL.createObjectURL(b);
        setBlobUrl(created);
      } catch {
        if (!cancelled) setErr(true);
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [urlPath]);

  useEffect(() => {
    if (!lightbox) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setLightbox(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  if (err) return <span style={{ color: '#dc2626', fontSize: '13px' }}>Не удалось загрузить</span>;
  if (!blobUrl) return <span style={{ color: '#9ca3af', fontSize: '13px' }}>Загрузка…</span>;

  const thumbStyle = {
    display: 'block',
    width: '100%',
    maxWidth: '100%',
    height: 'auto',
    maxHeight: '360px',
    objectFit: 'contain',
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    boxSizing: 'border-box',
    pointerEvents: 'none',
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setLightbox(true)}
        title="Открыть крупнее (клик или Enter; Esc — закрыть просмотр)"
        aria-label="Открыть скриншот крупнее"
        style={{
          display: 'block',
          width: '100%',
          padding: 0,
          margin: 0,
          border: 'none',
          background: 'transparent',
          borderRadius: 8,
          cursor: 'zoom-in',
          textAlign: 'left',
        }}
      >
        <img src={blobUrl} alt="" style={thumbStyle} />
      </button>
      {lightbox
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Просмотр скриншота"
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 5005,
                background: 'rgba(0,0,0,0.9)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px',
                boxSizing: 'border-box',
                cursor: 'zoom-out',
              }}
              onClick={() => setLightbox(false)}
            >
              <button
                type="button"
                aria-label="Закрыть просмотр"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox(false);
                }}
                style={{
                  position: 'absolute',
                  top: 12,
                  right: 12,
                  zIndex: 1,
                  width: 40,
                  height: 40,
                  border: 'none',
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.15)',
                  color: '#fff',
                  fontSize: 22,
                  lineHeight: 1,
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
              <img
                src={blobUrl}
                alt=""
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  width: 'auto',
                  height: 'auto',
                  objectFit: 'contain',
                  borderRadius: 4,
                  boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
                  cursor: 'default',
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <span
                style={{
                  position: 'absolute',
                  bottom: 16,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  color: 'rgba(255,255,255,0.75)',
                  fontSize: 13,
                  pointerEvents: 'none',
                  textAlign: 'center',
                }}
              >
                Клик по затемнению, × или Esc — закрыть
              </span>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export default function QaBugsView({ onBack }) {
  const { isAdmin, user } = useAuth();
  const canEditQaBugStatus = userCanEditQaBugStatus(user);
  const [meta, setMeta] = useState(null);
  const [bugs, setBugs] = useState([]);
  const [bugsLoadError, setBugsLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [formOk, setFormOk] = useState(null);
  const [filterSeverity, setFilterSeverity] = useState('');
  const [filterArea, setFilterArea] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [detail, setDetail] = useState(null);
  const [qaTab, setQaTab] = useState('list');
  const [fileInputKey, setFileInputKey] = useState(0);
  const [attachmentFiles, setAttachmentFiles] = useState([]);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [reportEnvelope, setReportEnvelope] = useState(null);
  const [reportLoadError, setReportLoadError] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportRefreshing, setReportRefreshing] = useState(false);

  const [form, setForm] = useState({
    area: '',
    finding_type: '',
    severity: 'средняя',
    description: '',
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setBugsLoadError(null);

    try {
      const mRes = await fetch(`${getApiUrl()}/qa/bugs/meta`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      if (!mRes.ok) throw new Error('Не удалось загрузить справочники (область, тип)');
      setMeta(await mRes.json());
    } catch (e) {
      handleApiError(e, false);
      setMeta(null);
    }

    try {
      const bRes = await fetch(`${getApiUrl()}/qa/bugs`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      const raw = await bRes.text();
      if (!bRes.ok) {
        let detail = `HTTP ${bRes.status}`;
        try {
          const j = JSON.parse(raw);
          if (j.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
        } catch (_) {
          if (raw.trim()) detail = raw.slice(0, 200);
        }
        throw new Error(detail);
      }
      let b;
      try {
        b = JSON.parse(raw);
      } catch (_) {
        throw new Error('Некорректный ответ сервера');
      }
      setBugs(Array.isArray(b) ? b : []);
    } catch (e) {
      setBugs([]);
      const msg = e?.message || 'Не удалось загрузить список';
      setBugsLoadError(
        `${msg}. Если раздел только подключили к серверу, администратору нужно выполнить миграцию: backend/run_qa_bugs_migration.py`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!meta?.areas?.length) return;
    const uid = user?.id;
    setForm((f) => {
      const allowed = meta.areas;
      const stored = readStoredLastArea(uid, allowed);
      let nextArea = f.area;
      if (!nextArea || !allowed.includes(nextArea)) {
        nextArea = stored || allowed[0];
      }
      const ftAllowed = meta.finding_types || [];
      const nextFinding =
        f.finding_type && ftAllowed.includes(f.finding_type) ? f.finding_type : ftAllowed[0];
      return { ...f, area: nextArea, finding_type: nextFinding };
    });
  }, [meta, user?.id]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const loadAnalyticsReport = useCallback(async () => {
    setReportLoading(true);
    setReportLoadError(null);
    try {
      const r = await fetch(`${getApiUrl()}/qa/analytics-report`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      const text = await r.text();
      if (!r.ok) {
        let detailMsg = text;
        try {
          const j = JSON.parse(text);
          if (j.detail != null) detailMsg = formatQaApiErrorDetail(j.detail);
        } catch (_) {}
        throw new Error(detailMsg || 'Не удалось загрузить отчёт');
      }
      setReportEnvelope(JSON.parse(text));
    } catch (err) {
      setReportLoadError(err?.message || 'Ошибка загрузки отчёта');
      handleApiError(err, false);
    } finally {
      setReportLoading(false);
    }
  }, []);

  const refreshAnalyticsReport = useCallback(async () => {
    setReportRefreshing(true);
    setReportLoadError(null);
    try {
      const r = await fetch(`${getApiUrl()}/qa/analytics-report/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      const text = await r.text();
      if (!r.ok) {
        let detailMsg = text;
        try {
          const j = JSON.parse(text);
          if (j.detail != null) detailMsg = formatQaApiErrorDetail(j.detail);
        } catch (_) {}
        throw new Error(detailMsg || 'Не удалось обновить отчёт');
      }
      setReportEnvelope(JSON.parse(text));
    } catch (err) {
      setReportLoadError(err?.message || 'Ошибка обновления отчёта');
      handleApiError(err, false);
    } finally {
      setReportRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (qaTab !== 'report') return undefined;
    loadAnalyticsReport();
    return undefined;
  }, [qaTab, loadAnalyticsReport]);

  const refreshDetail = useCallback(
    async (id) => {
      if (id == null) return;
      try {
        const r = await fetch(`${getApiUrl()}/qa/bugs/${id}`, {
          credentials: 'include',
          headers: getAuthHeaders(),
        });
        if (r.ok) setDetail(await r.json());
      } catch (_) {}
    },
    []
  );

  const filteredBugs = useMemo(() => {
    return bugs.filter((row) => {
      if (filterSeverity && row.severity !== filterSeverity) return false;
      if (filterArea && row.area !== filterArea) return false;
      if (filterStatus && row.status !== filterStatus) return false;
      return true;
    });
  }, [bugs, filterSeverity, filterArea, filterStatus]);

  const openQaDetail = useCallback((row) => {
    if (!row) return;
    setDetail(row);
    try {
      const base = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', `${base}#qa-${row.id}`);
    } catch (_) {}
  }, []);

  const openBugById = useCallback(
    async (bugId) => {
      const n = Number(bugId);
      if (Number.isNaN(n)) return;
      let row = bugs.find((x) => Number(x.id) === n);
      if (!row) {
        try {
          const r = await fetch(`${getApiUrl()}/qa/bugs/${n}`, {
            credentials: 'include',
            headers: getAuthHeaders(),
          });
          if (r.ok) row = await r.json();
        } catch (_) {}
      }
      if (row) {
        openQaDetail(row);
      }
    },
    [bugs, openQaDetail]
  );

  const closeQaDetail = useCallback(() => {
    setDetail(null);
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!bugs.length) return;
    const m = typeof window !== 'undefined' && window.location.hash.match(/^#qa-(\d+)$/);
    if (!m) return;
    const id = Number(m[1]);
    const b = bugs.find((x) => Number(x.id) === id);
    if (b) setDetail(b);
  }, [bugs]);

  const matrixAreas = useMemo(() => {
    const a = meta?.areas;
    if (!Array.isArray(a) || !a.length) return [];
    return [...a].sort((x, y) => x.localeCompare(y, 'ru'));
  }, [meta]);

  /** Ключ: finding_type|||area|||severity → список замечаний */
  const matrixBuckets = useMemo(() => {
    const map = new Map();
    for (const b of bugs) {
      if (!b?.finding_type || !b?.area || !b?.severity) continue;
      const k = `${b.finding_type}|||${b.area}|||${b.severity}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(b);
    }
    for (const arr of map.values()) {
      arr.sort((a, c) => Number(c.id) - Number(a.id));
    }
    return map;
  }, [bugs]);

  const matrixFindingTypes = useMemo(() => {
    const t = meta?.finding_types;
    if (!Array.isArray(t) || !t.length) return [];
    return [...t].sort((x, y) => x.localeCompare(y, 'ru'));
  }, [meta]);

  const tabBtnStyle = (active) => ({
    padding: '8px 14px',
    fontSize: '14px',
    fontWeight: active ? 600 : 400,
    border: '1px solid',
    borderColor: active ? '#2563eb' : '#d1d5db',
    borderRadius: '6px',
    background: active ? '#eff6ff' : '#fff',
    color: active ? '#1d4ed8' : '#374151',
    cursor: 'pointer',
  });

  const submitBug = async (e) => {
    e.preventDefault();
    setFormError(null);
    setFormOk(null);
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('area', form.area);
      fd.append('finding_type', form.finding_type);
      fd.append('severity', form.severity);
      fd.append('description', form.description.trim());
      attachmentFiles.forEach((f) => fd.append('files', f));

      const res = await fetch(`${getApiUrl()}/qa/bugs`, {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeadersMultipart(),
        body: fd,
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 413) {
          throw new Error(
            'Сервер отклонил размер загрузки (413). До 5 скринов по 5 МБ каждый; уменьшите файлы или число файлов. Если всё равно ошибка — лимит nginx, пишите админу.'
          );
        }
        let detailMsg = text;
        try {
          const j = JSON.parse(text);
          if (j.detail != null) detailMsg = formatQaApiErrorDetail(j.detail);
        } catch (_) {}
        throw new Error(detailMsg || 'Ошибка сохранения');
      }
      setFormOk('Замечание сохранено.');
      if (user?.id != null) writeStoredLastArea(Number(user.id), form.area);
      setForm((f) => ({ ...f, description: '' }));
      setAttachmentFiles([]);
      setFileInputKey((k) => k + 1);
      await loadAll();
    } catch (err) {
      setFormError(err?.message || 'Ошибка');
      handleApiError(err, false);
    } finally {
      setSubmitting(false);
    }
  };

  const patchBug = async (id, payload) => {
    try {
      const res = await fetch(`${getApiUrl()}/qa/bugs/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      await loadAll();
      await refreshDetail(id);
    } catch (e) {
      handleApiError(e, false);
    }
  };

  const deleteBug = async () => {
    if (!detail) return;
    const ok = window.confirm(
      'Удалить это замечание безвозвратно?\n\nТекст и прикреплённые скриншоты будут удалены. Отменить действие будет нельзя.'
    );
    if (!ok) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`${getApiUrl()}/qa/bugs/${detail.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || 'Не удалось удалить');
      }
      closeQaDetail();
      await loadAll();
    } catch (e) {
      handleApiError(e, false);
    } finally {
      setDeleteLoading(false);
    }
  };

  const severities = meta?.severities || ['высокая', 'средняя', 'низкая'];
  const canDeleteDetail =
    detail &&
    user &&
    (Number(detail.reporter_id) === Number(user.id) || isAdmin);

  const detailAttachmentList = useMemo(
    () => normalizeQaAttachments(detail?.attachments),
    [detail]
  );

  return (
    <div style={{ minHeight: '100vh', background: '#f3f4f6', padding: '20px' }}>
      <div
        style={{
          maxWidth:
            qaTab === 'matrix' ? 'min(100%, 1680px)' : qaTab === 'report' ? 'min(100%, 960px)' : '1100px',
          margin: '0 auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '20px',
            flexWrap: 'wrap',
            justifyContent: 'flex-start',
          }}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              style={{
                padding: '8px 16px',
                background: '#6b7280',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              ← Назад
            </button>
          )}
          <h1 style={{ margin: 0, fontSize: '22px', color: '#111827' }}>Замечания тестирования</h1>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginLeft: 'auto' }}>
            <button type="button" onClick={() => setQaTab('list')} style={tabBtnStyle(qaTab === 'list')}>
              Ввод и список
            </button>
            <button type="button" onClick={() => setQaTab('matrix')} style={tabBtnStyle(qaTab === 'matrix')}>
              Матрица покрытия
            </button>
            <button type="button" onClick={() => setQaTab('report')} style={tabBtnStyle(qaTab === 'report')}>
              Отчёт по замечаниям
            </button>
          </div>
        </div>

        {qaTab === 'list' && (
        <>
        <div style={card}>
          <h2 style={{ margin: '0 0 16px 0', fontSize: '16px' }}>Новое замечание</h2>
          <form onSubmit={submitBug}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
              <div>
                <label style={labelStyle}>Область</label>
                <select
                  style={inputStyle}
                  value={form.area}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((f) => ({ ...f, area: v }));
                    if (user?.id != null) writeStoredLastArea(Number(user.id), v);
                  }}
                  required
                >
                  {(meta?.areas || []).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Тип</label>
                <select
                  style={inputStyle}
                  value={form.finding_type}
                  onChange={(e) => setForm((f) => ({ ...f, finding_type: e.target.value }))}
                  required
                >
                  {(meta?.finding_types || []).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Критичность</label>
                <select
                  style={inputStyle}
                  value={form.severity}
                  onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
                  required
                >
                  {severities.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ marginTop: '12px' }}>
              <label style={labelStyle}>Описание (суть и шаги воспроизведения)</label>
              <textarea
                style={{ ...inputStyle, minHeight: '120px', resize: 'vertical' }}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                required
                minLength={3}
                placeholder="Кратко, что не так, и как воспроизвести"
              />
            </div>
            <div style={{ marginTop: '12px' }}>
              <label style={labelStyle}>Скриншоты (до 5 файлов, png / jpg / webp / gif, до 5 МБ каждый)</label>
              <input
                key={fileInputKey}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                multiple
                style={{ fontSize: '14px' }}
                onChange={(e) => {
                  const picked = Array.from(e.target.files || []).slice(0, 5);
                  setAttachmentFiles(picked);
                }}
              />
              {attachmentFiles.length > 0 && (
                <div style={{ marginTop: '8px', fontSize: '13px', color: '#6b7280' }}>
                  Выбрано файлов: {attachmentFiles.length}
                </div>
              )}
            </div>
            {formError && <div style={{ color: '#b91c1c', fontSize: '14px', marginTop: '10px' }}>{formError}</div>}
            {formOk && <div style={{ color: '#15803d', fontSize: '14px', marginTop: '10px' }}>{formOk}</div>}
            <button
              type="submit"
              disabled={submitting || !meta}
              style={{
                marginTop: '14px',
                padding: '10px 20px',
                background: submitting ? '#9ca3af' : '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: submitting ? 'default' : 'pointer',
                fontWeight: 600,
              }}
            >
              {submitting ? 'Отправка…' : 'Отправить замечание'}
            </button>
          </form>
        </div>

        <div style={card}>
          <h2 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>Список</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>Фильтры:</span>
            <select
              style={{ ...inputStyle, width: 'auto', minWidth: '120px' }}
              value={filterSeverity}
              onChange={(e) => setFilterSeverity(e.target.value)}
            >
              <option value="">Все уровни</option>
              {severities.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              style={{ ...inputStyle, width: 'auto', minWidth: '160px' }}
              value={filterArea}
              onChange={(e) => setFilterArea(e.target.value)}
            >
              <option value="">Все области</option>
              {(meta?.areas || []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              style={{ ...inputStyle, width: 'auto', minWidth: '140px' }}
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="">Все статусы</option>
              {(meta?.statuses || []).map((s) => (
                <option key={s} value={s}>
                  {qaStatusLabelRu(s)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={loadAll}
              style={{ padding: '8px 12px', fontSize: '13px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}
            >
              Обновить
            </button>
          </div>

          {bugsLoadError && (
            <p style={{ color: '#b45309', fontSize: '13px', marginBottom: '12px', lineHeight: 1.45 }}>
              {bugsLoadError}
            </p>
          )}
          {loading ? (
            <p style={{ color: '#6b7280' }}>Загрузка…</p>
          ) : bugsLoadError ? null : filteredBugs.length === 0 ? (
            <p style={{ color: '#6b7280' }}>Пока нет записей по выбранным фильтрам.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '2px solid #e5e7eb' }}>
                    <th style={{ padding: '8px 6px' }}>#</th>
                    <th style={{ padding: '8px 6px' }}>Дата</th>
                    <th style={{ padding: '8px 6px' }}>Автор</th>
                    <th style={{ padding: '8px 6px' }}>Уровень</th>
                    <th style={{ padding: '8px 6px' }}>Область</th>
                    <th style={{ padding: '8px 6px' }}>Тип</th>
                    <th style={{ padding: '8px 6px' }}>Текст</th>
                    <th style={{ padding: '8px 6px' }}>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBugs.map((row) => (
                    <tr
                      key={row.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openQaDetail(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openQaDetail(row);
                        }
                      }}
                      style={{
                        borderBottom: '1px solid #f3f4f6',
                        verticalAlign: 'top',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = '#f9fafb';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <td style={{ padding: '10px 6px', whiteSpace: 'nowrap' }}>{row.id}</td>
                      <td style={{ padding: '10px 6px', whiteSpace: 'nowrap', color: '#6b7280' }}>
                        {row.created_at ? row.created_at.slice(0, 10) : '—'}
                      </td>
                      <td style={{ padding: '10px 6px' }}>{row.reporter_username}</td>
                      <td style={{ padding: '10px 6px', fontWeight: 700, color: severityColor(row.severity) }}>{row.severity}</td>
                      <td style={{ padding: '10px 6px' }}>{row.area}</td>
                      <td style={{ padding: '10px 6px' }}>{row.finding_type}</td>
                      <td style={{ padding: '10px 6px', maxWidth: '200px', color: '#374151' }}>{textPreview15(row.description)}</td>
                      <td style={{ padding: '10px 6px', color: '#4b5563' }}>{qaStatusLabelRu(row.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </>
        )}

        {qaTab === 'matrix' && (
          <div style={card}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '12px', marginBottom: '12px' }}>
              <h2 style={{ margin: 0, fontSize: '16px' }}>Матрица покрытия</h2>
              <span style={{ fontSize: '13px', color: '#6b7280' }}>
                Строки — тип замечания, столбцы — область. Внутри ячейки — только уровни критичности, по которым есть замечания;
                в каждом блоке — превью текста и ссылка на карточку (хэш #qa-id для копирования).
              </span>
              <button
                type="button"
                onClick={loadAll}
                style={{
                  padding: '8px 12px',
                  fontSize: '13px',
                  borderRadius: '6px',
                  border: '1px solid #d1d5db',
                  background: '#fff',
                  cursor: 'pointer',
                  marginLeft: 'auto',
                }}
              >
                Обновить
              </button>
            </div>
            {bugsLoadError && (
              <p style={{ color: '#b45309', fontSize: '13px', marginBottom: '12px', lineHeight: 1.45 }}>{bugsLoadError}</p>
            )}
            {loading ? (
              <p style={{ color: '#6b7280' }}>Загрузка…</p>
            ) : !meta?.areas?.length || !matrixFindingTypes.length ? (
              <p style={{ color: '#6b7280' }}>Нет справочника областей или типов замечаний.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '12px',
                    minWidth: matrixAreas.length * 120 + 168,
                  }}
                >
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        style={{
                          position: 'sticky',
                          left: 0,
                          zIndex: 2,
                          background: '#f9fafb',
                          borderBottom: '2px solid #e5e7eb',
                          borderRight: '1px solid #e5e7eb',
                          padding: '10px 8px',
                          textAlign: 'left',
                          minWidth: 148,
                          maxWidth: 220,
                          boxShadow: '4px 0 8px -4px rgba(0,0,0,0.08)',
                        }}
                      >
                        Тип / область
                      </th>
                      {matrixAreas.map((area) => (
                        <th
                          key={area}
                          scope="col"
                          style={{
                            borderBottom: '2px solid #e5e7eb',
                            padding: '10px 8px',
                            textAlign: 'left',
                            verticalAlign: 'bottom',
                            fontWeight: 600,
                            color: '#374151',
                            maxWidth: 200,
                            lineHeight: 1.35,
                          }}
                        >
                          {area}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrixFindingTypes.map((ft) => (
                      <tr key={ft}>
                        <th
                          scope="row"
                          style={{
                            position: 'sticky',
                            left: 0,
                            zIndex: 1,
                            background: '#fff',
                            borderRight: '1px solid #e5e7eb',
                            borderBottom: '1px solid #f3f4f6',
                            padding: '10px 8px',
                            textAlign: 'left',
                            fontWeight: 600,
                            color: '#111827',
                            lineHeight: 1.35,
                            maxWidth: 220,
                            boxShadow: '4px 0 8px -4px rgba(0,0,0,0.06)',
                          }}
                        >
                          {ft}
                        </th>
                        {matrixAreas.map((area) => {
                          const presentSeverities = severities.filter(
                            (sev) => (matrixBuckets.get(`${ft}|||${area}|||${sev}`) || []).length > 0
                          );
                          const hasAny = presentSeverities.length > 0;
                          return (
                            <td
                              key={`${ft}-${area}`}
                              style={{
                                borderBottom: '1px solid #f3f4f6',
                                padding: '8px',
                                verticalAlign: 'top',
                                background: hasAny ? '#fafafa' : 'transparent',
                              }}
                            >
                              {!hasAny ? (
                                <span style={{ color: '#e5e7eb' }}>·</span>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                  {presentSeverities.map((sev) => {
                                    const list = matrixBuckets.get(`${ft}|||${area}|||${sev}`) || [];
                                    return (
                                      <div
                                        key={sev}
                                        style={{
                                          borderLeft: `3px solid ${severityColor(sev)}`,
                                          paddingLeft: '8px',
                                          margin: 0,
                                        }}
                                      >
                                        <div
                                          style={{
                                            fontSize: '11px',
                                            fontWeight: 700,
                                            color: severityColor(sev),
                                            marginBottom: '4px',
                                            letterSpacing: '0.02em',
                                          }}
                                        >
                                          {sev}
                                        </div>
                                        <ul style={{ margin: 0, paddingLeft: '16px', lineHeight: 1.45 }}>
                                          {list.map((b) => (
                                            <li key={b.id} style={{ marginBottom: '6px' }}>
                                              <a
                                                href={`#qa-${b.id}`}
                                                title={(b.description || '').trim() || `Замечание #${b.id}`}
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  openQaDetail(b);
                                                }}
                                                style={{
                                                  color: '#2563eb',
                                                  textDecoration: 'underline',
                                                  wordBreak: 'break-word',
                                                  fontSize: '12px',
                                                }}
                                              >
                                                {textPreview30(b.description)}
                                                <span style={{ color: '#6b7280', fontWeight: 500 }}> (#{b.id})</span>
                                              </a>
                                              {(b.reporter_username || '').trim() ? (
                                                <div
                                                  style={{
                                                    fontSize: '10px',
                                                    color: '#b0b5bd',
                                                    marginTop: '2px',
                                                    lineHeight: 1.25,
                                                    letterSpacing: '0.01em',
                                                  }}
                                                >
                                                  {b.reporter_username}
                                                </div>
                                              ) : null}
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {qaTab === 'report' && (
          <div style={card}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '12px', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '16px' }}>Автоматический отчёт по замечаниям</h2>
              <span style={{ fontSize: '13px', color: '#6b7280', lineHeight: 1.45, flex: '1 1 220px' }}>
                В отчёт входят только замечания в статусе «Новое».                 Сводка по полям дополняется анализом <strong>текстов</strong> и при наличии файлов —{' '}
                <strong>скриншотов вложений</strong>. Подключение к провайдеру ИИ то же, что у остального приложения
                (ключи и URL в .env, таймаут <code style={{ fontSize: '12px' }}>OPENAI_TIMEOUT</code> и т.д.); модель —
                как для нарратива отчёта участника: настройка <strong>report</strong> /{' '}
                <code style={{ fontSize: '12px' }}>report_model</code> в админке или{' '}
                <code style={{ fontSize: '12px' }}>data/ai_model_config.json</code>. Только для этого отчёта: отключить
                анализ — <code style={{ fontSize: '12px' }}>QA_REPORT_LLM=0</code>; без картинок в запросе —{' '}
                <code style={{ fontSize: '12px' }}>QA_REPORT_LLM_VISION=0</code>; лимиты вложений —{' '}
                <code style={{ fontSize: '12px' }}>QA_REPORT_LLM_MAX_IMAGES_TOTAL</code>,{' '}
                <code style={{ fontSize: '12px' }}>QA_REPORT_LLM_MAX_IMAGES_PER_BUG</code>.
              </span>
              <button
                type="button"
                disabled={reportRefreshing}
                onClick={refreshAnalyticsReport}
                style={{
                  padding: '8px 14px',
                  fontSize: '13px',
                  borderRadius: '6px',
                  border: '1px solid #2563eb',
                  background: reportRefreshing ? '#e5e7eb' : '#2563eb',
                  color: reportRefreshing ? '#6b7280' : '#fff',
                  cursor: reportRefreshing ? 'default' : 'pointer',
                  fontWeight: 600,
                  marginLeft: 'auto',
                }}
              >
                {reportRefreshing ? 'Обновление…' : 'Обновить отчёт'}
              </button>
            </div>

            {reportLoadError && (
              <p style={{ color: '#b45309', fontSize: '13px', marginBottom: '12px', lineHeight: 1.45 }}>
                {reportLoadError}
                {' '}
                <span style={{ color: '#6b7280' }}>
                  На сервере должна быть применена миграция: <code style={{ fontSize: '12px' }}>cd backend &amp;&amp; python run_qa_bugs_migration.py</code>
                </span>
              </p>
            )}

            {reportLoading ? (
              <p style={{ color: '#6b7280' }}>Загрузка отчёта…</p>
            ) : reportEnvelope?.payload ? (
              <>
                {reportEnvelope.stored_at && (
                  <p style={{ fontSize: '12px', color: '#6b7280', margin: '0 0 16px 0' }}>
                    Сохранено на сервере: {String(reportEnvelope.stored_at).slice(0, 19).replace('T', ' ')}
                    {reportEnvelope.from_cache ? ' · из кэша' : ' · только что сформировано'}
                  </p>
                )}

                {reportEnvelope.payload.llm?.ok && (
                  <p style={{ fontSize: '12px', color: '#15803d', margin: '0 0 12px 0' }}>
                    Анализ содержания выполнен (ИИ).
                    {reportEnvelope.payload.llm.model ? ` Модель: ${reportEnvelope.payload.llm.model}.` : ''}
                    {Number(reportEnvelope.payload.llm.images_sent) > 0
                      ? ` В запрос передано изображений вложений: ${reportEnvelope.payload.llm.images_sent} (остальные только в карточках или из‑за лимитов).`
                      : ' Скриншоты в LLM не передавались (нет файлов, отключено vision или лимит 0).'}
                  </p>
                )}
                {reportEnvelope.payload.llm?.skipped && reportEnvelope.payload.llm?.reason === 'disabled' && (
                  <p style={{ fontSize: '12px', color: '#6b7280', margin: '0 0 12px 0' }}>
                    Анализ текстов отключён (QA_REPORT_LLM=0). Показаны только агрегаты и шаблонные рекомендации.
                  </p>
                )}
                {reportEnvelope.payload.llm?.ok === false &&
                  reportEnvelope.payload.llm?.error &&
                  (reportEnvelope.payload.stats?.total ?? 0) > 0 && (
                    <p style={{ fontSize: '12px', color: '#b45309', margin: '0 0 12px 0' }}>
                      Не удалось выполнить анализ текстов через ИИ: {reportEnvelope.payload.llm.error}. Ниже — статистика и
                      эвристические рекомендации.
                    </p>
                  )}

                {reportEnvelope.payload.content_overview ? (
                  <div
                    style={{
                      marginBottom: '20px',
                      padding: '14px 16px',
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: '8px',
                    }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: '#1e293b' }}>
                      Общая картина по содержанию замечаний (ИИ)
                    </div>
                    <div style={{ fontSize: '14px', lineHeight: 1.55, color: '#334155' }}>
                      {renderTextWithHashBugIds(reportEnvelope.payload.content_overview, openBugById)}
                    </div>
                  </div>
                ) : null}

                <h3 style={{ fontSize: '15px', margin: '0 0 10px 0', color: '#111827' }}>Статистика</h3>
                <p style={{ margin: '0 0 8px 0', fontSize: '14px' }}>
                  <strong>Всего замечаний:</strong> {reportEnvelope.payload.stats?.total ?? 0}
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px', marginBottom: '22px' }}>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', background: '#fafafa' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: '#374151' }}>По критичности</div>
                    <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: 1.6 }}>
                      {['высокая', 'средняя', 'низкая'].map((s) => (
                        <li key={s}>
                          <span style={{ fontWeight: 600, color: severityColor(s) }}>{s}</span>
                          {' — '}
                          {reportEnvelope.payload.stats?.by_severity?.[s] ?? 0}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', background: '#fafafa' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: '#374151' }}>По типам</div>
                    <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: 1.6 }}>
                      {(meta?.finding_types || []).map((t) => (
                        <li key={t}>
                          {t} — {reportEnvelope.payload.stats?.by_finding_type?.[t] ?? 0}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', background: '#fafafa', gridColumn: '1 / -1' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: '#374151' }}>По областям</div>
                    <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: 1.6, columns: '2 220px', columnGap: '16px' }}>
                      {(meta?.areas || []).map((a) => {
                        const c = reportEnvelope.payload.stats?.by_area?.[a] ?? 0;
                        if (!c) return null;
                        return (
                          <li key={a} style={{ breakInside: 'avoid' }}>
                            {a} — {c}
                          </li>
                        );
                      })}
                    </ul>
                    {!(meta?.areas || []).some((a) => (reportEnvelope.payload.stats?.by_area?.[a] ?? 0) > 0) && (
                      <span style={{ fontSize: '13px', color: '#9ca3af' }}>Нет распределения по областям.</span>
                    )}
                  </div>
                </div>

                <h3 style={{ fontSize: '15px', margin: '0 0 12px 0', color: '#111827' }}>По областям: выводы и ссылки</h3>
                {(!reportEnvelope.payload.areas || reportEnvelope.payload.areas.length === 0) && (
                  <p style={{ color: '#6b7280', fontSize: '14px' }}>Замечаний пока нет — отчёт пустой.</p>
                )}

                {(reportEnvelope.payload.areas || []).map((block) => (
                  <div
                    key={block.area}
                    style={{
                      marginBottom: '24px',
                      paddingBottom: '20px',
                      borderBottom: '1px solid #e5e7eb',
                    }}
                  >
                    <h4 style={{ margin: '0 0 10px 0', fontSize: '15px', color: '#1e3a8a' }}>
                      {block.area_label_ru || block.area}
                    </h4>
                    {block.content_narrative ? (
                      <div
                        style={{
                          marginBottom: '14px',
                          padding: '12px 14px',
                          background: '#fefce8',
                          border: '1px solid #fde047',
                          borderRadius: '8px',
                        }}
                      >
                        <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: '#854d0e' }}>
                          Анализ текстов в этой области (ИИ)
                        </div>
                        <div style={{ fontSize: '14px', lineHeight: 1.55, color: '#422006' }}>
                          {renderTextWithHashBugIds(block.content_narrative, openBugById)}
                        </div>
                      </div>
                    ) : null}
                    {(block.content_themes || []).length > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: '#374151' }}>
                          Выделенные темы по содержанию
                        </div>
                        <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', lineHeight: 1.5, color: '#374151' }}>
                          {(block.content_themes || []).map((th, ti) => (
                            <li key={`${block.area}-th-${ti}`} style={{ marginBottom: '8px' }}>
                              <strong>{th.title || '—'}</strong>
                              {th.explanation ? <div style={{ marginTop: '4px' }}>{th.explanation}</div> : null}
                              {(th.bug_ids || []).length > 0 && (
                                <div style={{ marginTop: '4px', fontSize: '12px', color: '#6b7280' }}>
                                  Замечания:{' '}
                                  {(th.bug_ids || []).map((bid) => (
                                    <button
                                      key={`${block.area}-th-${ti}-b-${bid}`}
                                      type="button"
                                      onClick={() => openBugById(bid)}
                                      style={{
                                        background: 'none',
                                        border: 'none',
                                        padding: 0,
                                        marginRight: '6px',
                                        cursor: 'pointer',
                                        color: '#2563eb',
                                        textDecoration: 'underline',
                                        font: 'inherit',
                                      }}
                                    >
                                      #{bid}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div style={{ fontSize: '12px', fontWeight: 600, margin: '0 0 6px 0', color: '#6b7280' }}>
                      Кратко по меткам (область / тип / критичность)
                    </div>
                    {(block.summary || []).map((para, i) => (
                      <p key={`s-${i}`} style={{ margin: '0 0 8px 0', fontSize: '14px', lineHeight: 1.55, color: '#374151' }}>
                        {para}
                      </p>
                    ))}
                    <div style={{ fontSize: '13px', fontWeight: 600, margin: '12px 0 6px 0', color: '#111827' }}>
                      Замечания (ссылка открывает карточку)
                    </div>
                    <ul style={{ margin: '0 0 14px 0', paddingLeft: '20px', fontSize: '13px', lineHeight: 1.55 }}>
                      {(block.bugs || []).map((b) => (
                        <li key={b.id} style={{ marginBottom: '6px' }}>
                          <button
                            type="button"
                            onClick={() => openBugById(b.id)}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              margin: 0,
                              cursor: 'pointer',
                              color: '#2563eb',
                              textDecoration: 'underline',
                              textAlign: 'left',
                              fontSize: 'inherit',
                              fontFamily: 'inherit',
                            }}
                          >
                            #{b.id}
                          </button>
                          {' — '}
                          <span style={{ fontWeight: 600, color: severityColor(b.severity) }}>{b.severity}</span>
                          {', '}
                          {b.finding_type_label_ru || b.finding_type}
                          {', '}
                          {qaStatusLabelRu(b.status)}
                          {b.created_at ? ` · ${String(b.created_at).slice(0, 10)}` : ''}
                          {Number(b.attachment_count) > 0 ? ` · вложений: ${b.attachment_count}` : ''}
                          <div style={{ color: '#6b7280', marginTop: '2px' }}>{b.description_preview || '—'}</div>
                          <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>
                            Хэш для копирования:{' '}
                            <code style={{ fontSize: '11px' }}>#qa-{b.id}</code>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px 0', color: '#065f46' }}>
                      Предложения по работе с проблемами
                      {block.recommendations?.some((r) => r.source === 'llm') ? ' (с учётом текстов замечаний, ИИ)' : ''}
                    </div>
                    {(block.recommendations || []).length === 0 ? (
                      <p style={{ fontSize: '13px', color: '#6b7280' }}>Нет автоматических рекомендаций для этой области.</p>
                    ) : (
                      <ol style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', lineHeight: 1.55, color: '#374151' }}>
                        {(block.recommendations || []).map((rec, j) => (
                          <li key={`${block.area}-r-${j}`} style={{ marginBottom: '10px' }}>
                            <strong>{rec.title}</strong>
                            <div style={{ marginTop: '4px' }}>{rec.body}</div>
                            <div style={{ marginTop: '4px', fontSize: '12px', color: '#6b7280' }}>
                              <em>Обоснование:</em> {rec.rationale}
                            </div>
                            {(rec.bug_ids || []).length > 0 && (
                              <div style={{ marginTop: '6px', fontSize: '12px', color: '#6b7280' }}>
                                Связанные замечания:{' '}
                                {(rec.bug_ids || []).map((bid) => (
                                  <button
                                    key={`${block.area}-r-${j}-b-${bid}`}
                                    type="button"
                                    onClick={() => openBugById(bid)}
                                    style={{
                                      background: 'none',
                                      border: 'none',
                                      padding: 0,
                                      marginRight: '6px',
                                      cursor: 'pointer',
                                      color: '#2563eb',
                                      textDecoration: 'underline',
                                      font: 'inherit',
                                    }}
                                  >
                                    #{bid}
                                  </button>
                                ))}
                              </div>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </>
            ) : !reportLoadError ? (
              <p style={{ color: '#6b7280' }}>Нет данных отчёта.</p>
            ) : null}
          </div>
        )}
      </div>

      {detail && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 4000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            boxSizing: 'border-box',
          }}
          onClick={closeQaDetail}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              background: 'white',
              borderRadius: '12px',
              maxWidth: '640px',
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              padding: '24px',
              boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
              <h2 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>Замечание #{detail.id}</h2>
              <button
                type="button"
                onClick={closeQaDetail}
                style={{
                  flexShrink: 0,
                  border: 'none',
                  background: '#f3f4f6',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Закрыть
              </button>
            </div>
            <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#6b7280' }}>
              {detail.created_at ? detail.created_at.slice(0, 19).replace('T', ' ') : ''} · {detail.reporter_username} ·{' '}
              <span style={{ fontWeight: 700, color: severityColor(detail.severity) }}>{detail.severity}</span> · {detail.area} ·{' '}
              {detail.finding_type}
            </p>
            <pre
              style={{
                margin: '0 0 16px 0',
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                fontSize: '14px',
                lineHeight: 1.5,
                color: '#111827',
              }}
            >
              {detail.description || '—'}
            </pre>
            {detailAttachmentList.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ ...labelStyle, marginBottom: '8px' }}>Вложения</div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    width: '100%',
                    alignItems: 'stretch',
                  }}
                >
                  {detailAttachmentList.map((a, idx) => (
                    <div
                      key={`qa-${detail.id}-att-${idx}-${a.name}`}
                      style={{ width: '100%', minWidth: 0, flexShrink: 0 }}
                    >
                      <AuthedQaImage urlPath={a.url} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {detail.admin_note ? (
              <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#7c3aed' }}>
                <strong>Методист:</strong> {detail.admin_note}
              </p>
            ) : null}
            {canEditQaBugStatus && (
              <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
                <label style={labelStyle}>Статус</label>
                <select
                  style={{ ...inputStyle, maxWidth: '280px' }}
                  value={detail.status}
                  onChange={(e) => patchBug(detail.id, { status: e.target.value })}
                >
                  {(meta?.statuses || []).map((s) => (
                    <option key={s} value={s}>
                      {qaStatusLabelRu(s)}
                    </option>
                  ))}
                </select>
                <label style={{ ...labelStyle, marginTop: '12px' }}>Заметка методиста</label>
                <textarea
                  key={`${detail.id}-${detail.updated_at || ''}-modal-note`}
                  style={{ ...inputStyle, minHeight: '72px' }}
                  placeholder="Комментарий для команды"
                  defaultValue={detail.admin_note || ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== (detail.admin_note || '').trim()) patchBug(detail.id, { admin_note: v });
                  }}
                />
              </div>
            )}
            {canDeleteDetail && (
              <div style={{ borderTop: '1px solid #fee2e2', marginTop: '16px', paddingTop: '16px' }}>
                <button
                  type="button"
                  disabled={deleteLoading}
                  onClick={deleteBug}
                  style={{
                    padding: '10px 16px',
                    fontSize: '14px',
                    fontWeight: 600,
                    color: '#b91c1c',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '8px',
                    cursor: deleteLoading ? 'default' : 'pointer',
                    opacity: deleteLoading ? 0.7 : 1,
                  }}
                >
                  {deleteLoading ? 'Удаление…' : 'Удалить замечание'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
