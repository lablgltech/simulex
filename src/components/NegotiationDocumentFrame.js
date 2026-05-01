import React, { useState, useEffect, useCallback, memo, useRef } from 'react';
import { documentAPI } from '../api/negotiationApi';

// Статусы пунктов договора (визуальные) — синхронны backend ClauseStatus
const ClauseStatus = {
  NOT_EDITABLE: 1,
  AVAILABLE: 2,
  SELECTED: 3,
  NO_EDITS: 4,
  ACCEPTED_BOT: 5,
  CHANGED: 6,
  NOT_AGREED_ESCALATION: 7, // не согласовано, эскалация
  KEPT_COUNTERPARTY: 8, // закрыт, в договоре остаётся редакция контрагента
  EXCLUDED: 9, // пункт исключён из текста договора по соглашению
};

/** «1. ПРЕДМЕТ…», «12. РЕКВИЗИТЫ…» — не подпункт «1.1. …». */
function isContractSectionTitleLine(line) {
  const t = (line || '').trim();
  if (!t) return false;
  if (!/^\d+\.\s+\S/.test(t)) return false;
  if (/^\d+\.\d/.test(t)) return false;
  return true;
}

/** Одинаковые размер/жирность/отступ с `.clause` (2×14px по горизонтали внутри списка). */
const CONTRACT_SECTION_TITLE_STYLE = {
  boxSizing: 'border-box',
  whiteSpace: 'pre-wrap',
  padding: '6px 14px 4px 14px',
  fontWeight: 700,
  fontSize: '12pt',
  lineHeight: 1.2,
  color: '#1a1a1a',
};

/** Заголовок раздела внутри readonly-блока: горизонтальный отступ уже у родителя `.clause`. */
const CONTRACT_SECTION_TITLE_IN_READONLY = {
  ...CONTRACT_SECTION_TITLE_STYLE,
  padding: '6px 0 4px 0',
};

const BODY_TEXT_IN_CONTRACT = {
  whiteSpace: 'pre-wrap',
  fontSize: '12pt',
  lineHeight: 1.35,
  color: '#1a1a1a',
};

/** Разбивает многострочный text-item: преамбула обычным 12pt, строки разделов — единым стилем заголовка. */
function renderContractTextBlock(id, rawText) {
  const lines = (rawText || '').split(/\r?\n/);
  const nodes = [];
  let buf = [];

  const flush = (key) => {
    if (buf.length === 0) return;
    const chunk = buf.join('\n');
    if (chunk.trim()) {
      nodes.push(
        <div key={key} style={BODY_TEXT_IN_CONTRACT}>
          {chunk}
        </div>
      );
    }
    buf = [];
  };

  lines.forEach((line, i) => {
    if (isContractSectionTitleLine(line)) {
      flush(`t-${id}-${i}`);
      nodes.push(
        <div key={`s-${id}-${i}`} className="contract-section-header" style={CONTRACT_SECTION_TITLE_STYLE}>
          {line.trim()}
        </div>
      );
    } else {
      buf.push(line);
    }
  });
  flush(`t-${id}-end`);

  return (
    <div key={id} className="contract-text-block" style={{ padding: '0.5em 0' }}>
      {nodes}
    </div>
  );
}

const ClauseRow = memo(
  React.forwardRef(function ClauseRow(
    { clause, isSelected, canInteract, onClick, getStatusText, chatComplete },
    ref
  ) {
    const shouldDim = isSelected === false && !chatComplete;
    const displayNum = clause.displayNumber || clause.number;
    const numForStrip = clause.number || '';

    return (
      <div
        ref={ref}
        tabIndex={-1}
        className={`clause clause-status-${clause.status} ${isSelected ? 'clause--focused' : ''}`}
        onClick={() => onClick(clause)}
        style={{
          cursor: canInteract ? 'pointer' : 'not-allowed',
          opacity: shouldDim ? 0.5 : 1,
        }}
      >
        <div className="clause-content-inline">
          <span className="clause-number">{displayNum}</span>
          <span className="clause-text">
            {(clause.replacementText || clause.text || clause.contract_text || '')
              .replace(/^\s*\n+/, ' ')
              .replace(new RegExp(`^\\s*${numForStrip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?\\s*`), '')}
          </span>
        </div>
      </div>
    );
  })
);

export default function NegotiationDocumentFrame({
  negotiationSessionId,
  onClauseSelect,
  selectedClause,
  onClauseAction,
  refreshTrigger,
  agreedReplacement,
  onProgressUpdate,
  chatComplete = false,
  /** Первый успешный loadClauses — для восстановления UI этапа 3 после F5 */
  onClausesLoaded,
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [contract, setContract] = useState(null);
  const [clauses, setClauses] = useState([]);
  const clauseRefs = useRef({});
  const listRef = useRef(null);
  const savedScrollTopRef = useRef(0);
  const pendingCenterClauseIdRef = useRef(null);
  const isInitialLoadRef = useRef(true);

  const scrollClauseIntoView = useCallback((clauseId) => {
    if (!clauseId) return;
    const container = listRef.current;
    const el = clauseRefs.current[clauseId];
    if (!container || !el) return;
    const elTop = el.offsetTop;
    const targetTop = Math.max(0, elTop - (container.clientHeight - el.clientHeight) / 2);
    try {
      container.scrollTo({ top: targetTop, behavior: 'smooth' });
    } catch {
      container.scrollTop = targetTop;
    }
  }, []);

  useEffect(() => {
    isInitialLoadRef.current = true;
  }, [negotiationSessionId]);

  useEffect(() => {
    loadClauses();
  }, [negotiationSessionId]);

  useEffect(() => {
    const key = `simcon:scroll:${negotiationSessionId}`;
    const saved = sessionStorage.getItem(key);
    if (listRef.current && saved) {
      listRef.current.scrollTop = parseInt(saved, 10) || 0;
      savedScrollTopRef.current = listRef.current.scrollTop;
    }
  }, [negotiationSessionId]);

  useEffect(() => {
    if (refreshTrigger > 0) {
      const timer = setTimeout(() => {
        if (selectedClause?.id) {
          pendingCenterClauseIdRef.current = selectedClause.id;
        }
        loadClauses();
      }, 100);
      const timer2 = setTimeout(() => {
        loadClauses();
      }, 500);
      return () => {
        clearTimeout(timer);
        clearTimeout(timer2);
      };
    }
  }, [refreshTrigger, selectedClause]);

  useEffect(() => {
    if (!selectedClause) {
      const timer = setTimeout(() => {
        loadClauses();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [selectedClause]);

  useEffect(() => {
    const targetId = pendingCenterClauseIdRef.current;
    if (targetId && selectedClause?.id === targetId) {
      scrollClauseIntoView(targetId);
      pendingCenterClauseIdRef.current = null;
      if (listRef.current) {
        savedScrollTopRef.current = listRef.current.scrollTop;
      }
    }
  }, [selectedClause, clauses, scrollClauseIntoView]);

  const loadClauses = async () => {
    try {
      if (listRef.current) {
        savedScrollTopRef.current = listRef.current.scrollTop;
        try {
          sessionStorage.setItem(
            `simcon:scroll:${negotiationSessionId}`,
            String(savedScrollTopRef.current)
          );
        } catch {
          /* ignore */
        }
      }

      if (isInitialLoadRef.current) {
        setLoading(true);
      }

      const data = await documentAPI.getClauses(negotiationSessionId);
      setContract(data.contract);
      // items = полный договор (текст + интерактивные пункты), clauses = только пункты для обсуждения
      const loadedItems = data.items || data.clauses || [];
      const loadedClauses = data.clauses || [];
      setClauses(loadedItems);

      setTimeout(() => {
        if (listRef.current && !pendingCenterClauseIdRef.current) {
          listRef.current.scrollTop = savedScrollTopRef.current;
        }
      }, 0);

      if (onProgressUpdate) {
        const discussable = loadedClauses.filter(
          (c) => c.type !== 'text' && c.status !== ClauseStatus.NOT_EDITABLE
        );
        const totalDiscussable = discussable.length;
        // «Обсуждено» — пункт закрыт с любым исходом (в т.ч. редакция контрагента KEPT_COUNTERPARTY).
        const discussed = discussable.filter((c) =>
          [
            ClauseStatus.NO_EDITS,
            ClauseStatus.ACCEPTED_BOT,
            ClauseStatus.CHANGED,
            ClauseStatus.NOT_AGREED_ESCALATION,
            ClauseStatus.EXCLUDED,
            ClauseStatus.KEPT_COUNTERPARTY,
          ].includes(c.status)
        ).length;
        // Только для салюта «идеально»: исход в пользу игрока / нейтральный закрытый (без «оставили редакцию контрагента»).
        const favorableAgreed = discussable.filter((c) =>
          [
            ClauseStatus.NO_EDITS,
            ClauseStatus.ACCEPTED_BOT,
            ClauseStatus.CHANGED,
            ClauseStatus.NOT_AGREED_ESCALATION,
            ClauseStatus.EXCLUDED,
          ].includes(c.status)
        ).length;
        const disputed = discussable.filter((c) =>
          [ClauseStatus.AVAILABLE, ClauseStatus.SELECTED].includes(c.status)
        ).length;

        onProgressUpdate({
          total: totalDiscussable,
          agreed: discussed,
          favorableAgreed,
          disputed,
          percentage: totalDiscussable > 0 ? Math.round((discussed / totalDiscussable) * 100) : 0,
        });
      }

      if (isInitialLoadRef.current) {
        setLoading(false);
        isInitialLoadRef.current = false;
        if (typeof onClausesLoaded === 'function') {
          try {
            onClausesLoaded(loadedItems);
          } catch {
            /* ignore draft restore errors */
          }
        }
      }
    } catch (err) {
      setError('Ошибка загрузки документа: ' + (err?.message || String(err)));
      setLoading(false);
    }
  };

  const handleClauseClick = useCallback(
    (clause) => {
      if (!clause) return;

      const isNonEditableElement = clause.type && clause.type !== 'clause';
      if (isNonEditableElement) return;

      const isCompleted =
        clause.status === ClauseStatus.NO_EDITS ||
        clause.status === ClauseStatus.ACCEPTED_BOT ||
        clause.status === ClauseStatus.CHANGED ||
        clause.status === ClauseStatus.EXCLUDED ||
        clause.status === ClauseStatus.NOT_AGREED_ESCALATION ||
        clause.status === ClauseStatus.KEPT_COUNTERPARTY;

      const canInteract =
        clause.status !== ClauseStatus.NOT_EDITABLE &&
        (isCompleted ||
          clause.status === ClauseStatus.AVAILABLE ||
          clause.status === ClauseStatus.SELECTED);

      if (!canInteract) return;

      if (isCompleted) {
        onClauseSelect && onClauseSelect(clause);
        onClauseAction && onClauseAction('history');
        return;
      }

      if (
        clause.status === ClauseStatus.AVAILABLE ||
        clause.status === ClauseStatus.SELECTED
      ) {
        onClauseSelect && onClauseSelect(clause);
      }
    },
    [chatComplete, onClauseAction, onClauseSelect, selectedClause]
  );

  const getStatusText = (status) => {
    const map = {
      [ClauseStatus.NOT_EDITABLE]: '',
      [ClauseStatus.AVAILABLE]: '(доступен для обсуждения)',
      [ClauseStatus.SELECTED]: '(в процессе обсуждения)',
      [ClauseStatus.NO_EDITS]: '(остался без правок)',
      [ClauseStatus.ACCEPTED_BOT]: '(принят в редакции контрагента)',
      [ClauseStatus.CHANGED]: '(изменен на другую редакцию)',
      [ClauseStatus.NOT_AGREED_ESCALATION]: '(не согласовано, эскалация)',
      [ClauseStatus.KEPT_COUNTERPARTY]: '(остаётся в редакции контрагента)',
    };
    return map[status] || '';
  };

  // useMemo должен вызываться до любых условных return (правила хуков React)
  const displayClauses = React.useMemo(() => {
    if (!clauses) return [];
    if (agreedReplacement?.clauseExcluded && agreedReplacement?.clauseId) {
      const exclId = agreedReplacement.clauseId;
      const alreadyGone = !clauses.some(
        (c) =>
          (c.type === 'clause' || c.type === 'clause_readonly') &&
          (c.id === exclId || String(c.number) === String(exclId))
      );
      if (alreadyGone) return clauses;
      const filtered = clauses.filter((item) => {
        if (item.type !== 'clause' && item.type !== 'clause_readonly') return true;
        return item.id !== exclId && String(item.number) !== String(exclId);
      });
      // Client-side renumbering: siblings in the same parent group shift up.
      const exclNum = String(
        clauses.find(
          (c) => c.id === exclId || String(c.number) === String(exclId)
        )?.number || exclId
      );
      const dotParts = exclNum.split('.');
      if (dotParts.length >= 2) {
        const parentPrefix = dotParts.slice(0, -1).join('.') + '.';
        filtered.forEach((item) => {
          if (item.type !== 'clause' && item.type !== 'clause_readonly') return;
          const num = String(item.number || '');
          if (!num.startsWith(parentPrefix)) return;
          const suffix = num.slice(parentPrefix.length);
          if (suffix.includes('.')) return;
          const origIdx = parseInt(suffix, 10);
          const exclIdx = parseInt(dotParts[dotParts.length - 1], 10);
          if (!isNaN(origIdx) && !isNaN(exclIdx) && origIdx > exclIdx) {
            item.displayNumber = parentPrefix + (origIdx - 1);
          }
        });
      }
      return filtered;
    }
    if (!agreedReplacement?.clauseId || !agreedReplacement?.replacementText) return clauses;
    return clauses.map((item) => {
      if (item.type !== 'clause') return item;
      const match =
        item.id === agreedReplacement.clauseId ||
        String(item.number) === String(agreedReplacement.clauseId);
      return match ? { ...item, replacementText: agreedReplacement.replacementText } : item;
    });
  }, [clauses, agreedReplacement]);

  if (loading) {
    return (
      <div className="document-frame card">
        <div className="loading">Загрузка документа...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="document-frame card">
        <div className="error">{error}</div>
      </div>
    );
  }

  return (
    <div className="document-frame card" style={{ backgroundColor: '#ffffff' }}>
      <div
        className="clauses-list simulex-content"
        ref={listRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!displayClauses || displayClauses.length === 0) return;
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const selectable = displayClauses.filter(
            (c) =>
              c.type === 'clause' &&
              (c.status === ClauseStatus.AVAILABLE || c.status === ClauseStatus.SELECTED)
          );
          if (selectable.length === 0) return;
          const currentId = selectedClause?.id;
          const idx = selectable.findIndex((c) => c.id === currentId);
          let next;
          if (e.key === 'ArrowDown') {
            next = selectable[(idx >= 0 ? idx + 1 : 0) % selectable.length];
          } else {
            next = selectable[(idx > 0 ? idx - 1 : selectable.length - 1) % selectable.length];
          }
          if (next && onClauseSelect) {
            onClauseSelect(next);
            setTimeout(() => scrollClauseIntoView(next.id), 0);
          }
        }}
      >
        {displayClauses.map((item) => {
          if (item.type === 'text') {
            const rawText = item.text || '';
            // Блок «12. РЕКВИЗИТЫ И ПОДПИСИ СТОРОН» с таблицей — рендерим как двухколоночную таблицу с линиями
            if (rawText.includes('РЕКВИЗИТЫ И ПОДПИСИ СТОРОН')) {
              const lines = rawText.split(/\r?\n/);
              const titleLine = lines.find((l) => l.includes('РЕКВИЗИТЫ И ПОДПИСИ СТОРОН'));
              const tableLines = lines.filter((l) => /^\s*\|.+\|.+\|\s*$/.test(l) && !/^\s*\|?\s*[-:]+\s*\|/.test(l));
              const rows = tableLines.map((line) =>
                line
                  .split('|')
                  .map((c) => c.trim())
                  .filter((_, i, arr) => i > 0 && i < arr.length - 1)
              );
              if (rows.length > 0) {
                const tableStyle = {
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '12pt',
                  color: '#1a1a1a',
                  marginTop: 8,
                };
                const cellStyle = {
                  padding: '8px 12px 10px 0',
                  borderBottom: '1px solid #cbd5e1',
                  verticalAlign: 'top',
                  width: '50%',
                };
                return (
                  <div key={item.id} className="contract-text-block" style={{ padding: '0.5em 0' }}>
                    {titleLine && (
                      <div className="contract-section-header" style={CONTRACT_SECTION_TITLE_STYLE}>
                        {titleLine.trim()}
                      </div>
                    )}
                    <table style={tableStyle}>
                      <tbody>
                        {rows.map((cells, idx) => (
                          <tr key={idx}>
                            {cells.map((cell, cidx) => (
                              <td key={cidx} style={cellStyle}>
                                {cell.includes('**') ? (
                                  <strong>{cell.replace(/\*\*/g, '')}</strong>
                                ) : cell === '—' || cell === '' ? (
                                  <span style={{ color: '#94a3b8' }}>—</span>
                                ) : (
                                  cell
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              }
            }
            // Строка с датой (г. Москва … 2026 г.) — город слева, дата справа
            const dateLineRe = /^(.+)(г\.\s*Москва)(?:\s*[—\-]\s*)?(.+?\d{4}\s*г\.)(.*)$/s;
            const dateMatch = rawText.match(dateLineRe);
            if (dateMatch) {
              const [, before, cityPart, datePart, after] = dateMatch;
              return (
                <div key={item.id} className="contract-text-block" style={{ whiteSpace: 'pre-wrap', padding: '0.5em 0' }}>
                  {before.trim() ? <div style={{ whiteSpace: 'pre-wrap' }}>{before}</div> : null}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1em', flexWrap: 'wrap' }}>
                    <span>{cityPart.trim()}</span>
                    <span>{datePart.trim()}</span>
                  </div>
                  {after.trim() ? <div style={{ whiteSpace: 'pre-wrap' }}>{after}</div> : null}
                </div>
              );
            }
            return renderContractTextBlock(item.id, rawText);
          }
          // Readonly clause (пункт договора, не подлежащий обсуждению)
          if (item.type === 'clause_readonly') {
            const roDisplayNum = item.displayNumber || item.number;
            // Блок может начинаться с заголовка раздела (например "2. СОПРОВОЖДЕНИЕ"), затем пункт "2.1. Текст"
            const sectionThenClause = item.text.match(/^(\d+\.\s+.+?)\n+(\d+\.\d+\.?\d*\.?)\s*([\s\S]*)$/);
            let sectionHeader = null;
            let clauseBody = item.text;
            const numFromText = sectionThenClause && sectionThenClause[2].replace(/\.$/, '');
            if (sectionThenClause && numFromText === item.number) {
              sectionHeader = sectionThenClause[1];
              clauseBody = sectionThenClause[3];
            } else {
              clauseBody = item.text.replace(/^\d+\.\d+\.?\d*\.?\s*/, '');
            }
            return (
              <div
                key={item.id}
                className="clause clause-status-1 clause--readonly"
                style={{
                  padding: '2px 14px',
                  marginBottom: '4px',
                }}
              >
                {sectionHeader && (
                  <div className="contract-section-header" style={CONTRACT_SECTION_TITLE_IN_READONLY}>
                    {sectionHeader.trim()}
                  </div>
                )}
                <div className="clause-content-inline" style={{ display: 'flex', alignItems: 'baseline', gap: '6px', lineHeight: 1.2 }}>
                  <span className="clause-number" style={{ fontWeight: 700, fontSize: '12pt', color: '#1a1a1a', flexShrink: 0 }}>
                    {roDisplayNum}.
                  </span>
                  <span className="clause-text" style={{ margin: 0, lineHeight: 1.2, color: '#1a1a1a', fontSize: '12pt', whiteSpace: 'pre-wrap' }}>
                    {clauseBody}
                  </span>
                </div>
              </div>
            );
          }
          const isItemCompleted =
            item.status === ClauseStatus.NO_EDITS ||
            item.status === ClauseStatus.ACCEPTED_BOT ||
            item.status === ClauseStatus.CHANGED ||
            item.status === ClauseStatus.EXCLUDED ||
            item.status === ClauseStatus.NOT_AGREED_ESCALATION ||
            item.status === ClauseStatus.KEPT_COUNTERPARTY;
          const canInteract =
            item.status !== ClauseStatus.NOT_EDITABLE &&
            (isItemCompleted ||
              item.status === ClauseStatus.AVAILABLE ||
              item.status === ClauseStatus.SELECTED);
          const isSelected = selectedClause ? selectedClause.id === item.id : undefined;
          return (
            <ClauseRow
              key={item.id}
              clause={item}
              isSelected={isSelected}
              canInteract={canInteract}
              onClick={handleClauseClick}
              getStatusText={getStatusText}
              chatComplete={chatComplete}
              ref={(el) => {
                clauseRefs.current[item.id] = el;
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

