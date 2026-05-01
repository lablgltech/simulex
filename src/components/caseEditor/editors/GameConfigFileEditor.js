import React, { useState, useEffect, useCallback } from 'react';

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  Object.keys(patch).forEach((k) => {
    if (patch[k] !== null && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], patch[k]);
    } else {
      out[k] = patch[k];
    }
  });
  return out;
}

const defaultShape = () => ({
  scenario_id: '',
  title: '',
  contract_id: '',
  ui_rules: { submit_always_enabled: true, highlight_clauses: true, show_progress_counter: true },
  task_rules: { required_risk_count: 6, allow_more_or_less: true },
  time_limit: { enabled: true, seconds: 1800 },
  scoring: { points: { correct_clause: 10, correct_risk_level: 5, false_positive: 0, missed_risk: -5 } },
  reporting: { show_correct_answers: true, show_explanations: true },
  missing_conditions_tags: [],
});

export default function GameConfigFileEditor({ initialText, onChangeSerialized }) {
  const [form, setForm] = useState(defaultShape);
  const [tagsText, setTagsText] = useState('');
  const [restJson, setRestJson] = useState('{}');
  const [parseError, setParseError] = useState(null);

  useEffect(() => {
    try {
      const raw = JSON.parse(initialText || '{}');
      const d = defaultShape();
      const merged = deepMerge(d, raw);
      setForm({
        scenario_id: merged.scenario_id ?? '',
        title: merged.title ?? '',
        contract_id: merged.contract_id ?? '',
        ui_rules: { ...d.ui_rules, ...merged.ui_rules },
        task_rules: { ...d.task_rules, ...merged.task_rules },
        time_limit: { ...d.time_limit, ...merged.time_limit },
        scoring: { points: { ...d.scoring.points, ...(merged.scoring?.points || {}) } },
        reporting: { ...d.reporting, ...merged.reporting },
        missing_conditions_tags: Array.isArray(merged.missing_conditions_tags) ? merged.missing_conditions_tags : [],
      });
      setTagsText((merged.missing_conditions_tags || []).join('\n'));
      const knownKeys = new Set(['scenario_id', 'title', 'contract_id', 'ui_rules', 'task_rules', 'time_limit', 'scoring', 'reporting', 'missing_conditions_tags']);
      const extra = {};
      Object.keys(raw).forEach((k) => {
        if (!knownKeys.has(k)) extra[k] = raw[k];
      });
      setRestJson(Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '{}');
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
    }
  }, [initialText]);

  const buildFullObject = useCallback((f, tags, rest) => {
    let extra = {};
    try {
      extra = JSON.parse(rest || '{}');
      if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) extra = {};
    } catch {
      extra = {};
    }
    const tagList = tags.split('\n').map((s) => s.trim()).filter(Boolean);
    return {
      ...extra,
      scenario_id: f.scenario_id,
      title: f.title,
      contract_id: f.contract_id,
      ui_rules: f.ui_rules,
      task_rules: f.task_rules,
      time_limit: f.time_limit,
      scoring: f.scoring,
      reporting: f.reporting,
      missing_conditions_tags: tagList,
    };
  }, []);

  const emit = useCallback(
    (f, tags, rest) => {
      if (parseError) return;
      onChangeSerialized(JSON.stringify(buildFullObject(f, tags, rest), null, 2));
    },
    [buildFullObject, onChangeSerialized, parseError],
  );

  if (parseError) {
    return <div style={{ padding: '12px', background: '#fef2f2', color: '#b91c1c', fontSize: '13px' }}>Не удалось разобрать: {parseError}. Откройте «Как JSON».</div>;
  }

  const patchForm = (mutator) => {
    setForm((prev) => {
      const next = mutator(prev);
      emit(next, tagsText, restJson);
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: 'min(520px, 58vh)', overflow: 'auto', paddingRight: '4px' }}>
      <label style={{ display: 'block', fontSize: '12px', color: '#475569', marginBottom: '10px' }}>
        scenario_id
        <input value={form.scenario_id} onChange={(e) => patchForm((f) => ({ ...f, scenario_id: e.target.value }))} style={{ display: 'block', width: '100%', marginTop: '4px', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
      </label>
      <label style={{ display: 'block', fontSize: '12px', color: '#475569', marginBottom: '10px' }}>
        title
        <input value={form.title} onChange={(e) => patchForm((f) => ({ ...f, title: e.target.value }))} style={{ display: 'block', width: '100%', marginTop: '4px', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
      </label>
      <label style={{ display: 'block', fontSize: '12px', color: '#475569', marginBottom: '10px' }}>
        contract_id
        <input value={form.contract_id} onChange={(e) => patchForm((f) => ({ ...f, contract_id: e.target.value }))} style={{ display: 'block', width: '100%', marginTop: '4px', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
      </label>
      <label style={{ display: 'block', fontSize: '12px', color: '#475569', marginBottom: '10px' }}>
        required_risk_count
        <input type="number" min={0} value={form.task_rules.required_risk_count} onChange={(e) => patchForm((f) => ({ ...f, task_rules: { ...f.task_rules, required_risk_count: Number(e.target.value) || 0 } }))} style={{ display: 'block', width: '120px', marginTop: '4px', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
        <input type="checkbox" checked={form.task_rules.allow_more_or_less} onChange={(e) => patchForm((f) => ({ ...f, task_rules: { ...f.task_rules, allow_more_or_less: e.target.checked } }))} />
        allow_more_or_less
      </label>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input type="checkbox" checked={form.time_limit.enabled} onChange={(e) => patchForm((f) => ({ ...f, time_limit: { ...f.time_limit, enabled: e.target.checked } }))} />
          Лимит времени
        </label>
        <input type="number" min={0} value={form.time_limit.seconds} onChange={(e) => patchForm((f) => ({ ...f, time_limit: { ...f.time_limit, seconds: Number(e.target.value) || 0 } }))} style={{ width: '100px', padding: '6px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
        <span style={{ fontSize: '11px', color: '#94a3b8' }}>сек</span>
      </div>
      <div style={{ fontSize: '12px', fontWeight: 600, color: '#334155', marginTop: '6px' }}>Очки (scoring.points)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        {['correct_clause', 'correct_risk_level', 'false_positive', 'missed_risk'].map((k) => (
          <label key={k} style={{ fontSize: '11px', color: '#64748b' }}>
            {k}
            <input
              type="number"
              value={form.scoring.points[k]}
              onChange={(e) => patchForm((f) => ({
                ...f,
                scoring: { points: { ...f.scoring.points, [k]: Number(e.target.value) || 0 } },
              }))}
              style={{ display: 'block', width: '100%', marginTop: '2px', padding: '6px', border: '1px solid #e5e7eb', borderRadius: '4px' }}
            />
          </label>
        ))}
      </div>
      <div style={{ fontSize: '12px', fontWeight: 600, color: '#334155', marginTop: '6px' }}>UI</div>
      {['submit_always_enabled', 'highlight_clauses', 'show_progress_counter'].map((k) => (
        <label key={k} style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" checked={Boolean(form.ui_rules[k])} onChange={(e) => patchForm((f) => ({ ...f, ui_rules: { ...f.ui_rules, [k]: e.target.checked } }))} />
          {k}
        </label>
      ))}
      <div style={{ fontSize: '12px', fontWeight: 600, color: '#334155', marginTop: '6px' }}>Отчёт</div>
      {['show_correct_answers', 'show_explanations'].map((k) => (
        <label key={k} style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" checked={Boolean(form.reporting[k])} onChange={(e) => patchForm((f) => ({ ...f, reporting: { ...f.reporting, [k]: e.target.checked } }))} />
          {k}
        </label>
      ))}
      <label style={{ display: 'block', fontSize: '12px', color: '#475569', marginBottom: '10px' }}>
        missing_conditions_tags (по одному в строке)
        <textarea
          value={tagsText}
          onChange={(e) => {
            const t = e.target.value;
            setTagsText(t);
            emit(form, t, restJson);
          }}
          rows={5}
          style={{ display: 'block', width: '100%', marginTop: '4px', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px', fontFamily: 'inherit', fontSize: '12px' }}
        />
      </label>
      <details style={{ fontSize: '12px', marginTop: '8px' }}>
        <summary style={{ cursor: 'pointer', color: '#64748b' }}>Доп. ключи JSON (слияние с формой)</summary>
        <textarea
          value={restJson}
          onChange={(e) => {
            const r = e.target.value;
            setRestJson(r);
            emit(form, tagsText, r);
          }}
          rows={4}
          spellCheck={false}
          style={{ width: '100%', marginTop: '8px', fontFamily: 'monospace', fontSize: '11px', padding: '8px', border: '1px solid #e5e7eb', borderRadius: '6px' }}
        />
      </details>
    </div>
  );
}
