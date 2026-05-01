import React, { useState, useEffect, useCallback } from 'react';

const LEVELS = ['low', 'medium', 'high'];

function parseRiskMatrix(text) {
  const o = JSON.parse(text);
  if (!o || typeof o !== 'object') throw new Error('Корень не объект');
  const risksArr = Array.isArray(o.risks) ? o.risks : [];
  return {
    contract_id: typeof o.contract_id === 'string' ? o.contract_id : '',
    risks: risksArr.map((r) => ({
      clause_id: r?.clause_id != null ? String(r.clause_id) : '',
      has_risk: Boolean(r?.has_risk),
      correct_level: LEVELS.includes(r?.correct_level) ? r.correct_level : 'medium',
      description: r?.description != null ? String(r.description) : '',
    })),
  };
}

function serialize(contractId, risks) {
  const obj = {
    contract_id: contractId,
    risks: risks.filter((r) => r.clause_id.trim() || r.description.trim()),
  };
  return JSON.stringify(obj, null, 2);
}

export default function RiskMatrixFileEditor({ initialText, onChangeSerialized }) {
  const [contractId, setContractId] = useState('');
  const [risks, setRisks] = useState([]);
  const [parseError, setParseError] = useState(null);

  useEffect(() => {
    try {
      const p = parseRiskMatrix(initialText || '{}');
      setContractId(p.contract_id);
      setRisks(p.risks.length ? p.risks : [{ clause_id: '', has_risk: true, correct_level: 'medium', description: '' }]);
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
      setRisks([]);
    }
  }, [initialText]);

  const pushSerialized = useCallback(
    (cid, rsk) => {
      if (parseError) return;
      onChangeSerialized(serialize(cid, rsk));
    },
    [onChangeSerialized, parseError],
  );

  if (parseError) {
    return <div style={{ padding: '12px', background: '#fef2f2', color: '#b91c1c', fontSize: '13px' }}>Не удалось разобрать файл: {parseError}. Откройте «Как JSON».</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <label style={{ fontSize: '13px', color: '#475569' }}>
        contract_id
        <input
          value={contractId}
          onChange={(e) => {
            const v = e.target.value;
            setContractId(v);
            pushSerialized(v, risks);
          }}
          style={{ display: 'block', width: '100%', marginTop: '4px', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}
        />
      </label>
      <div style={{ fontWeight: 600, fontSize: '13px', color: '#334155' }}>Риски по пунктам</div>
      <div style={{ maxHeight: 'min(420px, 50vh)', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
              <th style={{ padding: '8px' }}>clause_id</th>
              <th style={{ padding: '8px' }}>риск</th>
              <th style={{ padding: '8px' }}>уровень</th>
              <th style={{ padding: '8px' }}>описание</th>
              <th style={{ padding: '8px', width: '40px' }} />
            </tr>
          </thead>
          <tbody>
            {risks.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                <td style={{ padding: '6px' }}>
                  <input
                    value={r.clause_id}
                    onChange={(e) => {
                      const n = [...risks];
                      n[i] = { ...n[i], clause_id: e.target.value };
                      setRisks(n);
                      pushSerialized(contractId, n);
                    }}
                    style={{ width: '100%', padding: '4px', border: '1px solid #e5e7eb', borderRadius: '4px' }}
                  />
                </td>
                <td style={{ padding: '6px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={r.has_risk}
                    onChange={(e) => {
                      const n = [...risks];
                      n[i] = { ...n[i], has_risk: e.target.checked };
                      setRisks(n);
                      pushSerialized(contractId, n);
                    }}
                  />
                </td>
                <td style={{ padding: '6px' }}>
                  <select
                    value={r.correct_level}
                    onChange={(e) => {
                      const n = [...risks];
                      n[i] = { ...n[i], correct_level: e.target.value };
                      setRisks(n);
                      pushSerialized(contractId, n);
                    }}
                    style={{ padding: '4px', borderRadius: '4px' }}
                  >
                    {LEVELS.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: '6px' }}>
                  <input
                    value={r.description}
                    onChange={(e) => {
                      const n = [...risks];
                      n[i] = { ...n[i], description: e.target.value };
                      setRisks(n);
                      pushSerialized(contractId, n);
                    }}
                    style={{ width: '100%', padding: '4px', border: '1px solid #e5e7eb', borderRadius: '4px' }}
                  />
                </td>
                <td style={{ padding: '6px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      const n = risks.filter((_, j) => j !== i);
                      setRisks(n.length ? n : [{ clause_id: '', has_risk: true, correct_level: 'medium', description: '' }]);
                      pushSerialized(contractId, n.length ? n : [{ clause_id: '', has_risk: true, correct_level: 'medium', description: '' }]);
                    }}
                    style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer' }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => {
          const n = [...risks, { clause_id: '', has_risk: true, correct_level: 'medium', description: '' }];
          setRisks(n);
          pushSerialized(contractId, n);
        }}
        style={{ alignSelf: 'flex-start', padding: '6px 12px', fontSize: '12px', border: '1px dashed #94a3b8', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}
      >
        + Строка риска
      </button>
    </div>
  );
}
