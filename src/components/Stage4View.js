/**
 * Этап 4: Кризис и последствия.
 * Контент из data/cases/<case_id>/ по CASE_FILES.md: сценарии кризисов, письмо Дока, договор; выбор кризиса по выборам по договору; таймлайн по сценарию.
 * v2: письмо при входе, Док аватар, второй кризис (7/9/11 мес), исход noChange, всегда «вернуться / принять», скролл вверх при смене фазы.
 * Справочные документы кейса — `DocumentsModal` в GameView (кнопка «Документы» в HUD), как на этапах 1 и 3.
 */
import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { API_URL, getAuthHeaders } from '../api/config';
import { documentAPI, negotiationSessionAPI } from '../api/negotiationApi';
import { readStageDraft, writeStageDraft, clearStageDraft } from '../utils/stageDraftStorage';
import { canonicalCaseCode } from '../utils/caseId';
import MarkdownContent from './MarkdownContent';

// --- Второй кризис и таймлайн «продолжение» (зеркало правил выбора на бэкенде) ---
const STAGE4_RUS_MONTH_NUM = {
  январь: 1,
  февраль: 2,
  март: 3,
  апрель: 4,
  май: 5,
  июнь: 6,
  июль: 7,
  август: 8,
  сентябрь: 9,
  октябрь: 10,
  ноябрь: 11,
  декабрь: 12
};

/** Подсказка перед стартом анимации катсцены (первый клик по экрану) */
const STAGE4_CUTSCENE_CLICK_HINT = 'Кликни, чтобы запустить исполнение договора';

function stage4MonthLabelRu(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'месяц';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'месяца';
  return 'месяцев';
}

function stage4MonthOrderRelative(monthStr) {
  const m = String(monthStr || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function stage4ChronoKey(monthStr) {
  if (!monthStr) return 0;
  const s = String(monthStr).trim().toLowerCase().replace(/ё/g, 'е');
  const cm = s.match(/^через\s+(\d+)/i);
  if (cm) return parseInt(cm[1], 10);
  const m = s.match(/^([а-я]+)\s+(\d{4})\s*$/);
  if (m) {
    const w = m[1];
    const y = parseInt(m[2], 10);
    const mi = STAGE4_RUS_MONTH_NUM[w];
    if (mi) return y * 12 + mi;
  }
  const mo = s.match(/(\d+)/);
  return mo ? parseInt(mo[1], 10) : 0;
}

function stage4MaxChronoFromTimeline(events) {
  if (!events?.length) return 0;
  const keys = events
    .filter((e) => (e.month || '').trim())
    .map((e) => stage4ChronoKey(e.month));
  return keys.length ? Math.max(...keys) : 0;
}

function stage4EnrichCrisisRowLabel(ev, crisis) {
  const e = { ...ev };
  const lab = (e.label || '').trim();
  if (e.crisis && lab === 'Кризис' && crisis) {
    const desc = (crisis.crisis_description || '').trim();
    if (desc) {
      let frag = desc.split('.')[0].trim();
      if (frag.length > 200) frag = `${frag.slice(0, 197)}...`;
      e.label = `Кризис (${frag})`;
    }
  }
  return e;
}

function stage4StripTrailingDuplicateCrisis(events) {
  const out = [...events];
  while (out.length >= 2 && out[out.length - 1]?.crisis && out[out.length - 2]?.crisis) {
    out.pop();
  }
  return out;
}

function stage4DedupeCrisisTail(events) {
  if (!Array.isArray(events) || events.length < 2) return events || [];
  const last = events[events.length - 1];
  const prev = events[events.length - 2];
  if (last?.crisis && prev?.crisis) return events.slice(0, -1);
  return events;
}

function stage4CrisisScenarioChrono(scenario) {
  let best = 1e9;
  for (const e of scenario?.timeline_events || []) {
    if (e.crisis) {
      const k = stage4ChronoKey(e.month || '');
      if (k && k < best) best = k;
    }
  }
  return best < 1e9 ? best : 1e9;
}

function stage4PickScenarioLatestCrisis(candidates) {
  if (!candidates?.length) return null;
  const chronos = candidates.map((s) => stage4CrisisScenarioChrono(s));
  const m = Math.max(...chronos);
  const tied = candidates.filter((_, i) => chronos[i] === m);
  return tied[Math.floor(Math.random() * tied.length)];
}

function stage4FirstCrisisChronoKey(firstCrisisId, scenarios) {
  const s = scenarios.find((x) => x.crisis_id === firstCrisisId);
  return s ? stage4CrisisScenarioChrono(s) : 0;
}

const STAGE4_FIRST_CRISIS_FORBIDS_TERM_ACTS_SECOND = new Set(['crisis-documents-001', 'crisis-liability-001']);
const STAGE4_SECOND_TERM_ACTS_CRISIS_IDS = new Set(['crisis-term-001', 'crisis-acts-001']);

function stage4FilterSecondCrisisNoTermActsAfterDocsOrLiability(candidates, firstCrisisId) {
  if (!STAGE4_FIRST_CRISIS_FORBIDS_TERM_ACTS_SECOND.has(firstCrisisId)) return candidates || [];
  return (candidates || []).filter((s) => !STAGE4_SECOND_TERM_ACTS_CRISIS_IDS.has(s.crisis_id));
}

function stage4PickLatestAfterFirstOrExternal(candidates, firstCrisisId, scenarios) {
  if (!candidates?.length) return null;
  let pool = stage4FilterSecondCrisisNoTermActsAfterDocsOrLiability(candidates, firstCrisisId);
  if (!pool.length) {
    const ext = scenarios.filter(
      (s) =>
        (s.crisis_type === 'external' || (s.crisis_id || '').startsWith('crisis-external')) &&
        s.crisis_id !== firstCrisisId
    );
    if (ext.length) return stage4PickScenarioLatestCrisis(ext);
    return null;
  }
  const t0 = stage4FirstCrisisChronoKey(firstCrisisId, scenarios);
  const later = pool.filter((s) => stage4CrisisScenarioChrono(s) > t0);
  if (later.length) return stage4PickScenarioLatestCrisis(later);
  const ext = scenarios.filter(
    (s) =>
      (s.crisis_type === 'external' || (s.crisis_id || '').startsWith('crisis-external')) &&
      s.crisis_id !== firstCrisisId
  );
  if (ext.length) return stage4PickScenarioLatestCrisis(ext);
  return stage4PickScenarioLatestCrisis(pool);
}

function stage4FilterSecondTimelineByFirst(crisisEvents, firstTimeline) {
  const ce = crisisEvents.map((e) => ({ ...e }));
  const firstKeys = new Set();
  for (const e of firstTimeline || []) {
    const mo = (e.month || '').trim();
    const lab = (e.label || '').trim();
    if (mo) firstKeys.add(`${mo}\t${lab}`);
  }
  const cutoff = stage4MaxChronoFromTimeline(firstTimeline);
  let out = [];
  if (cutoff > 0) {
    for (const e of ce) {
      const k = stage4ChronoKey(e.month || '');
      if (k <= cutoff) continue;
      const mo = (e.month || '').trim();
      const lab = (e.label || '').trim();
      const tup = `${mo}\t${lab}`;
      if (firstKeys.has(tup)) continue;
      out.push(e);
      firstKeys.add(tup);
    }
  }
  if (out.length) {
    out.sort((a, b) => {
      const ka = stage4ChronoKey(a.month || '');
      const kb = stage4ChronoKey(b.month || '');
      if (ka !== kb) return ka - kb;
      return String(a.label || '').localeCompare(String(b.label || ''));
    });
    return out;
  }
  out = [];
  for (const e of ce) {
    const mo = (e.month || '').trim();
    const lab = (e.label || '').trim();
    const tup = `${mo}\t${lab}`;
    if (firstKeys.has(tup)) continue;
    out.push(e);
    firstKeys.add(tup);
  }
  out.sort((a, b) => {
    const ka = stage4ChronoKey(a.month || '');
    const kb = stage4ChronoKey(b.month || '');
    if (ka !== kb) return ka - kb;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });
  return out.length ? out : ce;
}

function stage4GetTrapCrisisTypes(contractClauses) {
  const types = [];
  for (const c of contractClauses || []) {
    if (c?.clause_id && c?.risk_profile?.related_crisis_type) {
      types.push(c.risk_profile.related_crisis_type);
    }
  }
  return types;
}

function stage4GetCorrectTrapVariantId(clause) {
  const ids = clause?.correct_variant_ids;
  if (Array.isArray(ids) && ids.length > 0) return ids[0];
  return clause?.correct_variant_id ?? 'C';
}

function stage4AllTrapsFixed(contractClauses, contractSelections, negotiationBaseline, session) {
  const trapTypes = stage4GetTrapCrisisTypes(contractClauses);
  if (!trapTypes.length) return true;
  for (const c of contractClauses || []) {
    if (!c.clause_id || !c.risk_profile?.related_crisis_type) continue;
    if (clauseOmittedFromStage4ContractScreen(c, negotiationBaseline, session)) continue;
    const correctId = stage4GetCorrectTrapVariantId(c);
    if ((contractSelections || {})[c.clause_id] !== correctId) return false;
  }
  return true;
}

function stage4SelectSecondCrisis({
  firstCrisisId,
  firstOutcome,
  contractClauses,
  contractSelections,
  negotiationBaseline,
  scenarios,
  session
}) {
  if (!scenarios?.length) return null;
  let external = scenarios.filter((s) => s.crisis_type === 'external');
  if (!external.length) {
    external = scenarios.filter((s) => (s.crisis_id || '').startsWith('crisis-external'));
  }

  const trapTypes = stage4GetTrapCrisisTypes(contractClauses);
  const clausesById = Object.fromEntries(
    (contractClauses || []).filter((c) => c.clause_id).map((c) => [c.clause_id, c])
  );

  console.log('[stage4] selectSecondCrisis called', {
    firstCrisisId,
    firstOutcome,
    contractSelectionsKeys: Object.keys(contractSelections ?? {}),
    contractSelections,
    trapTypes,
    clausesByIdKeys: Object.keys(clausesById),
  });

  if (firstOutcome === 'fixed') {
    if (
      stage4AllTrapsFixed(contractClauses, contractSelections, negotiationBaseline, session) &&
      external.length
    ) {
      return stage4PickLatestAfterFirstOrExternal(external, firstCrisisId, scenarios);
    }
    // Есть ошибки в договоре — ищем кризис по конкретным unfixed клаузам
    const fixedUnfixedTypes = new Set();
    for (const [clauseId, choice] of Object.entries(contractSelections ?? {})) {
      const cl = clausesById[clauseId];
      if (!cl?.risk_profile) continue;
      if (clauseOmittedFromStage4ContractScreen(cl, negotiationBaseline, session)) continue;
      const correctId = stage4GetCorrectTrapVariantId(cl);
      if (choice && choice !== correctId) {
        const t = cl.risk_profile.related_crisis_type;
        if (t) fixedUnfixedTypes.add(t);
      }
    }
    if (fixedUnfixedTypes.size) {
      const corresponding = scenarios.filter(
        (s) => fixedUnfixedTypes.has(s.crisis_type) && s.crisis_id !== firstCrisisId
      );
      if (corresponding.length) {
        return stage4PickLatestAfterFirstOrExternal(corresponding, firstCrisisId, scenarios);
      }
    }
    // Рассинхрон: всё исправлено, но allTrapsFixed дал false → external
    if (external.length) {
      return stage4PickLatestAfterFirstOrExternal(external, firstCrisisId, scenarios);
    }
  }

  if (firstOutcome === 'noChange' && trapTypes.length) {
    const corresponding = scenarios.filter(
      (s) => trapTypes.includes(s.crisis_type) && s.crisis_id !== firstCrisisId
    );
    if (corresponding.length) return stage4PickLatestAfterFirstOrExternal(corresponding, firstCrisisId, scenarios);
  }

  if (firstOutcome === 'repeat') {
    const unfixedTypes = new Set();
    for (const [clauseId, choice] of Object.entries(contractSelections || {})) {
      const cl = clausesById[clauseId];
      if (!cl?.risk_profile) continue;
      if (clauseOmittedFromStage4ContractScreen(cl, negotiationBaseline, session)) continue;
      const correctId = stage4GetCorrectTrapVariantId(cl);
      if (choice && choice !== correctId) {
        const t = cl.risk_profile.related_crisis_type;
        if (t) unfixedTypes.add(t);
      }
    }
    console.log('[stage4] repeat unfixedTypes', [...unfixedTypes], {
      contractSelections,
      clauseChecks: Object.entries(contractSelections ?? {}).map(([cid, choice]) => {
        const cl = clausesById[cid];
        const correctId = cl ? stage4GetCorrectTrapVariantId(cl) : 'NO_CLAUSE';
        const omitted = cl ? clauseOmittedFromStage4ContractScreen(cl, negotiationBaseline, session) : null;
        return {
          cid,
          choice,
          correctId,
          match: choice === correctId,
          omitted,
          type: cl?.risk_profile?.related_crisis_type,
        };
      }),
    });
    if (unfixedTypes.size) {
      const corresponding = scenarios.filter(
        (s) => unfixedTypes.has(s.crisis_type) && s.crisis_id !== firstCrisisId
      );
      if (corresponding.length) return stage4PickLatestAfterFirstOrExternal(corresponding, firstCrisisId, scenarios);
    }
  }

  let others = scenarios.filter((s) => s.crisis_id !== firstCrisisId && !external.includes(s));
  if (!others.length) others = scenarios.filter((s) => s.crisis_id !== firstCrisisId);
  if (others.length) return stage4PickLatestAfterFirstOrExternal(others, firstCrisisId, scenarios);
  return scenarios[Math.floor(Math.random() * scenarios.length)] || null;
}

function stage4BuildSecondTimelineFromScenario(selectedCrisis, firstTimelineEvents) {
  const crisisEvents = selectedCrisis?.timeline_events;
  if (!Array.isArray(crisisEvents) || !crisisEvents.length) return null;
  let base = stage4FilterSecondTimelineByFirst(
    crisisEvents.map((e) => ({ ...e })),
    firstTimelineEvents
  );
  const lastRel = Math.max(0, ...base.map((e) => stage4MonthOrderRelative(e.month)));
  const crisisMonthStr = lastRel ? `Через ${lastRel} ${stage4MonthLabelRu(lastRel)}` : 'Через 6 месяцев';
  if (!base.length || !base[base.length - 1].crisis) {
    base.push({ month: crisisMonthStr, label: 'Кризис', status: 'fail', crisis: true });
  }
  base = base.map((row) => (row.crisis ? stage4EnrichCrisisRowLabel({ ...row }, selectedCrisis) : { ...row }));
  return stage4StripTrailingDuplicateCrisis(base);
}

function stage4MergeSecondTimelineFromApi(apiEvents, selectedCrisis, firstTimelineEvents) {
  const built = stage4BuildSecondTimelineFromScenario(selectedCrisis, firstTimelineEvents);
  if (built) return stage4DedupeCrisisTail(built);
  return stage4DedupeCrisisTail(apiEvents || []);
}

function stage4FilterSecondTimelineAfterFixedReturn(secondEvents, firstTimeline, firstCrisis) {
  if (!Array.isArray(secondEvents) || secondEvents.length === 0) return secondEvents;
  if (!Array.isArray(firstTimeline) || firstTimeline.length === 0) return secondEvents;
  const firstKeys = new Set(
    firstTimeline.map((e) => `${String(e.month || '').trim()}\t${String(e.label || '').trim()}`)
  );
  const resLab = String(firstCrisis?.resolution_label || '').trim();
  const filtered = secondEvents.filter((e) => {
    const tup = `${String(e.month || '').trim()}\t${String(e.label || '').trim()}`;
    if (firstKeys.has(tup)) return false;
    if (resLab && String(e.label || '').trim() === resLab) return false;
    return true;
  });
  return filtered.length > 0 ? filtered : secondEvents;
}

/** Как на этапе 3: ключ sessionStorage для negotiation_session_id */
const STAGE3_NEG_CACHE_PREFIX = 'simulex:stage3:negotiationSession';
const STAGE3_NEG_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Статусы пункта после переговоров (как backend document_service.ClauseStatus). */
const NEG_STATUS = {
  NO_EDITS: 4,
  ACCEPTED_BOT: 5,
  CHANGED: 6,
  KEPT_COUNTERPARTY: 8,
  EXCLUDED: 9
};

/** Как services.stage4_contract_resolve._stage3_clause_status_is_success_for_baseline */
function stage3StatusIsNegotiationSuccess(st) {
  return (
    st === NEG_STATUS.NO_EDITS ||
    st === NEG_STATUS.ACCEPTED_BOT ||
    st === NEG_STATUS.CHANGED ||
    st === NEG_STATUS.KEPT_COUNTERPARTY ||
    st === NEG_STATUS.EXCLUDED
  );
}

function readCachedNegotiationSessionIdForStage4(cacheKey) {
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const id = parsed?.negotiationSessionId;
    const updatedAt = Number(parsed?.updatedAt || 0);
    if (!id || !updatedAt) return null;
    if (Date.now() - updatedAt > STAGE3_NEG_CACHE_TTL_MS) return null;
    return id;
  } catch {
    return null;
  }
}

/** Если в sessionStorage нет id переговоров этапа 3 — тот же вызов, что этап 3: POST /session/negotiation/start (без новых роутов). */
async function resolveNegotiationSessionIdForStage4(simId, caseId) {
  const cacheKey = `${STAGE3_NEG_CACHE_PREFIX}:${simId}:${caseId}`;
  const cached = readCachedNegotiationSessionIdForStage4(cacheKey);
  if (cached) return cached;
  try {
    const body = await negotiationSessionAPI.start(
      { id: String(simId), case_id: caseId },
      'dogovor_PO',
      { resetContractToInitial: false }
    );
    const raw = body?.negotiation_session_id;
    if (raw == null) return null;
    const id = String(raw);
    try {
      sessionStorage.setItem(
        cacheKey,
        JSON.stringify({ negotiationSessionId: id, updatedAt: Date.now() })
      );
    } catch {
      /* ignore */
    }
    return id;
  } catch {
    return null;
  }
}

/** Согласованный текст на этапе 3 содержит исключение пункта (не просто другую правильную замену). */
function negotiationTextImpliesExclusion(agreedText, markers) {
  if (!agreedText || !markers?.length) return false;
  const low = String(agreedText).toLowerCase().replace(/\s+/g, ' ');
  return markers.some((m) => low.includes(String(m || '').toLowerCase().trim()));
}

/** В contract.json stage3_clause_id может быть «4.1_acts», в ответе clauses — id/number «4.1». */
function resolveStage3ClauseForBaseline(byId, s3key) {
  if (!s3key) return undefined;
  const direct = byId[s3key];
  if (direct) return direct;
  const u = String(s3key).trim();
  const idx = u.indexOf('_');
  if (idx <= 0) return undefined;
  const prefix = u.slice(0, idx).trim();
  return prefix ? byId[prefix] : undefined;
}

/**
 * Baseline для резолва договора этапа 4 без изменений backend: GET /document/session/{id}/clauses
 * + маппинг stage3_clause_id в contract.json этапа 4.
 * negotiation_fix_kind: exclusion | replacement | incorrect — для ловушек и UI (скрытие исключённого пункта).
 */
function buildNegotiationBaselineFromDocumentClauses(s3Clauses, rawStage4Clauses) {
  const byId = {};
  for (const c of s3Clauses || []) {
    const id = String(c.id || '').trim();
    if (id) byId[id] = c;
    const num = c.number != null ? String(c.number).trim() : '';
    if (num && !byId[num]) byId[num] = c;
  }
  const clauses = {};
  for (const fc of rawStage4Clauses || []) {
    const s3key = String(fc.stage3_clause_id || '').trim();
    const s4id = fc.clause_id;
    if (!s3key || !s4id) continue;
    const s3 = resolveStage3ClauseForBaseline(byId, s3key);
    if (!s3) continue;
    const repl = (s3.replacementText || '').trim();
    const base = (s3.text || s3.contract_text || '').trim();
    let agreed = repl || base;
    const st = Number(s3.status);
    // Как stage4_contract_resolve.build_negotiation_baseline: исключение пункта (9) — всегда exclusion для hide_if.
    if (!agreed && st !== NEG_STATUS.EXCLUDED) continue;
    if (!agreed && st === NEG_STATUS.EXCLUDED) {
      agreed = base || '[исключён]';
    }
    const negotiation_correct = stage3StatusIsNegotiationSuccess(st);
    const markers = fc.negotiation_exclusion_markers;
    const negotiation_exclusion =
      st === NEG_STATUS.EXCLUDED
        ? true
        : negotiation_correct && negotiationTextImpliesExclusion(agreed, markers);
    const negotiation_fix_kind = negotiation_correct
      ? negotiation_exclusion
        ? 'exclusion'
        : 'replacement'
      : 'incorrect';
    clauses[s4id] = {
      agreed_text: agreed,
      negotiation_correct,
      negotiation_exclusion: !!negotiation_exclusion,
      negotiation_fix_kind
    };
  }
  return {
    has_negotiation_data: Object.keys(clauses).length > 0,
    clauses
  };
}

/** На этапе 1 игрок запрашивал авторизационное письмо — пункт «Документы партнёра» на экране договора этапа 4 не показываем. */
function sessionRequestedStage1AuthorizationLetter(session) {
  const docs = session?.stage1_requested_documents;
  if (!Array.isArray(docs)) return false;
  return docs.some((d) => {
    if (!d || typeof d !== 'object') return false;
    if (d.id === 'auth-letter') return true;
    const t = String(d.title || '').toLowerCase();
    return t.includes('авторизационн');
  });
}

/** Пункт не показываем на экране правки договора этапа 4: на этапе 3 пункт исключён из договора — выбирать нечего. */
function clauseOmittedFromStage4ContractScreen(clause, negotiationBaseline, session) {
  if (!clause?.clause_id || !negotiationBaseline?.clauses) return false;
  if (!clause.stage4_hide_if_negotiation_exclusion) return false;
  const e = negotiationBaseline.clauses[clause.clause_id];
  return !!(e?.negotiation_correct && e?.negotiation_exclusion);
}
import './Stage4View.css';

const RUS_MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** Первое число текущего календарного месяца — «сейчас» для таймлайна; «Через N» отсчитывается от этой даты. */
function getTimelineSigningAnchorDate() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function stage4RuMonthYearToAbs(monthStr) {
  const s = String(monthStr || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');
  const m = s.match(/^([а-я]+)\s+(\d{4})\s*$/);
  if (!m) return null;
  const mi = STAGE4_RUS_MONTH_NUM[m[1]];
  if (!mi) return null;
  const y = parseInt(m[2], 10);
  return y * 12 + (mi - 1);
}

function stage4AbsToRuMonthYear(abs) {
  const y = Math.floor(abs / 12);
  const m0 = abs % 12;
  return `${RUS_MONTHS[m0]} ${y}`;
}

/** Абсолютный месяц (abs = год*12 + месяц0..11) для сортировки и вставки «пустых» месяцев. */
function stage4MonthStrToAbsKey(monthStr, anchor) {
  if (!monthStr) return null;
  if (monthStr === '__stage4_signing_prep__') {
    return anchor.getFullYear() * 12 + anchor.getMonth();
  }
  const rel = String(monthStr).match(/^\s*через\s+(\d+)\s+месяц/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const d = new Date(anchor.getFullYear(), anchor.getMonth() + n, 1);
    return d.getFullYear() * 12 + d.getMonth();
  }
  return stage4RuMonthYearToAbs(monthStr);
}

function stage4AbsMinusMonths(abs, n) {
  const d = new Date(Math.floor(abs / 12), abs % 12, 1);
  d.setMonth(d.getMonth() - n);
  return d.getFullYear() * 12 + d.getMonth();
}

function stage4AbsPlusMonths(abs, n) {
  const d = new Date(Math.floor(abs / 12), abs % 12, 1);
  d.setMonth(d.getMonth() + n);
  return d.getFullYear() * 12 + d.getMonth();
}

/**
 * Один месяц перед первым событием — общая веха «Договор подписан» (если не «последние правки перед подписанием»);
 * два пустых месяца после последнего — только для разрядки шкалы. Между событиями пропуски не заполняем.
 */
function stage4ExpandTimelineMonthGaps(events, anchor) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const prepared = events
    .map((e, origIdx) => ({
      e,
      origIdx,
      abs: stage4MonthStrToAbsKey(e.month, anchor)
    }))
    .filter((x) => x.abs != null);
  if (!prepared.length) return [...events];

  prepared.sort((a, b) => a.abs - b.abs || a.origIdx - b.origIdx);

  const out = [];
  /** Пустые хвостовые месяцы — timelineFiller (приглушённая точка в CSS). Веха с текстом — обычный шаг done. */
  const pushFiller = (abs, label = '') => {
    const lab = (label || '').trim();
    out.push({
      month: stage4AbsToRuMonthYear(abs),
      label: lab,
      status: 'done',
      crisis: false,
      timelineFiller: !lab
    });
  };

  let prevAbs = null;
  for (const { e, abs } of prepared) {
    if (prevAbs === null) {
      // На экране «Возврат к договору» первой идёт «Последние правки…» — без месяца слева,
      // чтобы отмотка к radioMinOffsetPx попадала именно на эту точку.
      const signingPrepFirst = e.signingPrep || e.month === '__stage4_signing_prep__';
      if (!signingPrepFirst) {
        pushFiller(stage4AbsMinusMonths(abs, 1), 'Договор подписан');
      }
    }
    out.push(e);
    prevAbs = abs;
  }

  const trailing = 2;
  if (prevAbs != null) {
    for (let j = 1; j <= trailing; j += 1) {
      pushFiller(stage4AbsPlusMonths(prevAbs, j));
    }
  }

  return out;
}

function stage4BuildDisplayTimeline(rawEvents, { includeSigningPrep, anchorDate }) {
  const anchor = anchorDate || getTimelineSigningAnchorDate();
  const list = dedupeCrisisTimeline(Array.isArray(rawEvents) ? [...rawEvents] : []);
  const withPrep = includeSigningPrep
    ? [
        {
          month: '__stage4_signing_prep__',
          label: 'Последние правки перед подписанием',
          status: 'done',
          crisis: false,
          signingPrep: true
        },
        ...list
      ]
    : list;
  return stage4ExpandTimelineMonthGaps(withPrep, anchor);
}

/** Преобразует «Через N месяц(а/ев)» в «май 2026» от якоря; маркер подписания; иначе строка как есть. */
function formatTimelineDate(monthStr, anchorDate) {
  if (!monthStr || typeof monthStr !== 'string') return monthStr || '';
  if (monthStr === '__stage4_signing_prep__') {
    const a = anchorDate || getTimelineSigningAnchorDate();
    return `${RUS_MONTHS[a.getMonth()]} ${a.getFullYear()}`;
  }
  const m = monthStr.match(/Через\s+(\d+)\s+месяц/i);
  if (m) {
    const offset = parseInt(m[1], 10);
    const a = anchorDate || getTimelineSigningAnchorDate();
    const date = new Date(a.getFullYear(), a.getMonth() + offset, 1);
    return `${RUS_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  }
  return monthStr;
}

/** Убирает дубликат события «Кризис» в конце таймлайна (бэкенд может добавлять его поверх сценария, где кризис уже последний). Зона Фариды: не трогаем роутер. */
function dedupeCrisisTimeline(events) {
  if (!Array.isArray(events) || events.length < 2) return events || [];
  const last = events[events.length - 1];
  const prev = events[events.length - 2];
  if (last && last.crisis && prev && prev.crisis) return events.slice(0, -1);
  return events;
}

/** Событие сценария → полоска горизонтального таймлайна (дата, подпись, статус, флаг кризиса). */
function mapTimelineEventToStrip(e) {
  if (!e) return { month: '', label: '', status: 'done', crisis: false };
  return {
    month: e.month || '',
    label: e.label || '',
    status: e.status || 'done',
    crisis: !!e.crisis,
    timelineFiller: !!e.timelineFiller,
    signingPrep: !!e.signingPrep
  };
}

/** Вторая волна после успешного возврата: только первый сегмент таймлайна — warn (не кризис) → зелёный; второй сегмент как в данных. */
function softenWarnStripFirstSegmentAfterFixed(strip, firstOutcomeKey) {
  if (firstOutcomeKey !== 'fixed' || !strip || strip.crisis) return strip;
  if (strip.status === 'warn') return { ...strip, status: 'done' };
  return strip;
}

/** Текст в скобках после «Кризис» (вложенные скобки учитываются). */
function extractCrisisDetailFromLabel(label) {
  const s = (label || '').trim();
  // В JS \b учитывает только [A-Za-z0-9_]; кириллица не «словесная», поэтому /^Кризис\b/ не срабатывает после «Кризис» перед пробелом/скобкой.
  if (!/^Кризис(?:\s|\(|$)/i.test(s)) return null;
  const open = s.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) return s.slice(open + 1, i).trim();
    }
  }
  return null;
}

const GENERIC_DIAGNOSTIC_TITLE_RE = /^Вы\s+не\s+возвращались/i;

/** Подпись на дате «вместо кризиса» при успешном возврате (не resolution_label — это исход уже разыгранного кризиса). */
const FIXED_RETURN_TIMELINE_DOT_LABEL = 'Кризис не возникает';

/** Веха на месте устранённого кризиса на экране «Продолжение» (вторая волна); месяц намеренно пустой — дата не показывается. */
const STAGE4_COULD_HAVE_BEEN_CRISIS_LABEL = 'Тут мог быть кризис';

/**
 * Текст карточки разрешения после fixed: убираем абзац, совпадающий с заголовком, и вводную «Кризис не возникает.»,
 * чтобы не было «Вы вернулись… Вы вернулись… Кризис не возникает» в одном блоке.
 */
function sanitizeFixedReturnOutcomeText(rawText, title) {
  const titleTrim = (title || '').replace(/^Исход \d+\.\s*/i, '').trim();
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const parts = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\n+/)
    .map((p) => norm(p))
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (titleTrim && p === norm(titleTrim)) continue;
    if (/^Кризис не возникает\.?$/i.test(p)) continue;
    let chunk = p.replace(/^Кризис не возникает\.\s*/i, '').trim();
    if (titleTrim && chunk.startsWith(norm(titleTrim))) {
      chunk = chunk.slice(norm(titleTrim).length).trim();
      chunk = chunk.replace(/^[.:;\s—-]+/, '').trim();
      chunk = chunk.replace(/^Кризис не возникает\.\s*/i, '').trim();
    }
    if (titleTrim && norm(`${titleTrim} Кризис не возникает.`) === p) continue;
    if (chunk) out.push(chunk);
  }
  if (out.length) return out.join('\n\n');
  return 'При возврате вы привели договор в соответствие; исполнение идёт в рамках скорректированных условий, оснований для претензий и доначислений нет.';
}

/** Первое содержательное предложение из текста исхода (пропускает абзацы-заголовки «Вы не возвращались…»). */
function firstNarrativeSentenceFromOutcomeText(text) {
  const raw = (text || '').trim();
  if (!raw) return '';
  const parts = raw.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (GENERIC_DIAGNOSTIC_TITLE_RE.test(p)) continue;
    const line = p.replace(/\s*\n\s*/g, ' ').trim();
    const m = line.match(/^(.+?[.!?])(\s|$)/);
    const sent = (m ? m[1] : line).trim();
    if (sent) return sent.length > 200 ? `${sent.slice(0, 197)}…` : sent;
  }
  const fallback = (parts[0] || raw).replace(/\s*\n\s*/g, ' ').trim();
  const m2 = fallback.match(/^(.+?[.!?])(\s|$)/);
  const s = (m2 ? m2[1] : fallback).trim();
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

/**
 * Подпись финальной полосы таймлайна после Q3: приоритет outcome_strip_label из колонки «Таймлайн кризиса» (ветки correct/viable/wrong);
 * иначе resolution_label для позитива; иначе timeline_label / первое предложение текста (без заголовков «Вы не возвращались…»).
 */
function outcomeTimelineEventLabel(crisis, specificOutcome) {
  if (!specificOutcome || !crisis) return '';
  const stripCol = (specificOutcome.outcome_strip_label || '').trim();
  if (stripCol) {
    return stripCol.length > 220 ? `${stripCol.slice(0, 217)}…` : stripCol;
  }
  if (specificOutcome.type === 'positive') {
    return (crisis.resolution_label || '').trim();
  }
  const tl = (specificOutcome.timeline_label || '').trim();
  if (tl && !GENERIC_DIAGNOSTIC_TITLE_RE.test(tl)) {
    return tl.length > 220 ? `${tl.slice(0, 217)}…` : tl;
  }
  return firstNarrativeSentenceFromOutcomeText(specificOutcome.text);
}

/** До исхода: на точке кризиса только подпись «Кризис», без длинного пояснения из таблицы. */
function timelineMaskCrisisFirstView(ev) {
  if (!ev || !ev.crisis) return ev;
  if (extractCrisisDetailFromLabel(ev.label) == null) return ev;
  return { ...ev, label: 'Кризис' };
}

const STAGE4_RADIO_STEP_PX = 220;
/** Центр колонки 0 под иглой: pad = ширина/2 − step/2. Отрицательный radioMinOffset — только для старта кат-сцены «с правого края». */
const STAGE4_RADIO_OFFSET_COLUMN0_CENTERED = 0;

function computeStage4RadioBounds(shellWidth, flatRowCount) {
  const step = STAGE4_RADIO_STEP_PX;
  const halfShell = shellWidth / 2;
  const halfStep = step / 2;
  const pad = Math.max(0, Math.round(halfShell - halfStep));
  const minOffset = -Math.round(pad * 0.85);
  const n = Math.max(0, flatRowCount);
  const maxOffset =
    n <= 1
      ? Math.max(minOffset, 0)
      : Math.max(minOffset, pad + (n - 1) * step + halfStep - halfShell);
  return { step, pad, minOffset, maxOffset };
}

/**
 * Несколько фаз рендерят свой `.stage4-radio-shell`; ref может указывать на скрытый узел (offsetParent === null),
 * т.к. при display:none колбэк ref не всегда сбрасывается. Берём видимый shell из активной секции.
 */
function resolveVisibleStage4RadioShell(radioRef) {
  const refEl = radioRef?.current;
  if (refEl?.offsetParent != null) return refEl;
  if (typeof document === 'undefined') return null;
  return document.querySelector('.stage4-app section.phase.active .stage4-radio-shell');
}

/**
 * Исходный текст пункта для этапа 4. П. clause-documents в contract.md нет (сценарный пункт).
 * clause-term-customization: при флаге sublicensing (этап 2 — тег «право на сублицензирование») — original_text_alternate.
 * clause-documents: при partner_within_rights или authletter (этап 1 — письмо) — original_text_alternate; иначе original_text.
 */
function effectiveOriginalTextForStage4(clause, stage2Flags) {
  const f = stage2Flags || {};
  const alt = clause.original_text_alternate?.trim();
  if (alt && clause.clause_id === 'clause-term-customization' && f.sublicensing) return alt;
  if (alt && clause.clause_id === 'clause-documents' && (f.partner_within_rights || f.authletter)) return alt;
  return clause.original_text || '';
}

/** Нейтральная подпись для альтернатив исходной редакции (без «правильно/неправильно»). */
const CONTRACT_ALT_OPTION_LABEL = 'Предлагаемая редакция';

function poolPick(arr) {
  if (!arr?.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickTwoDistinctWrongs(wrongPool) {
  const wp = wrongPool || [];
  if (wp.length < 2) return [wp[0], wp[0]];
  let i = Math.floor(Math.random() * wp.length);
  let j = Math.floor(Math.random() * wp.length);
  let guard = 0;
  while (j === i && guard < 20) {
    j = Math.floor(Math.random() * wp.length);
    guard++;
  }
  if (j === i) j = (i + 1) % wp.length;
  return [wp[i], wp[j]];
}

/**
 * Три слота без id; correctSlotIndex 0..2 — верный ответ. Перемешивание → буквы A/B/C и фактический correct_variant_id.
 */
function shuffleContractOptionSlots(slots, correctSlotIndex) {
  const tagged = slots.map((s, i) => ({ ...s, __ok: i === correctSlotIndex }));
  const a = [...tagged];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const letters = ['A', 'B', 'C'];
  let correct_variant_id = 'A';
  const variants = a.map((v, idx) => {
    const id = letters[idx];
    if (v.__ok) correct_variant_id = id;
    const { __ok, ...rest } = v;
    return { id, ...rest };
  });
  return { variants, correct_variant_id };
}

/**
 * Сборка трёх вариантов для этапа 4; верный ответ после shuffle может оказаться на A, B или C.
 * Без baseline: слоты [исходная, правильная из пула, неправильная из пула], верный — индекс 1.
 * Без baseline, но этап 2 уже дал верную редакцию (сублицензия в п. 1.7 или заверения в «Документах»):
 *   [исходная, неверный, неверный], верный — 0 (оба альтернативных из wrong_pool).
 * С baseline и negotiation_correct: [согласованный текст, неверный, неверный], верный — 0.
 * С baseline и не correct: [согласованный (ошибочный), правильная из пула, неправильная из пула], верный — 1.
 */
function resolveClauseForStage4Client(clause, negotiationBaseline, session) {
  if (clause.variant_mode !== 'random_pools' || !clause.unchanged_variant) return clause;
  const cp = clause.correct_pool || [];
  const wp = clause.wrong_pool || [];
  if (!Array.isArray(cp) || !Array.isArray(wp)) return clause;

  const flags = session?.stage_4_stage2_flags;
  const eff = effectiveOriginalTextForStage4(clause, flags);
  const usesDocumentsStage2Alternate =
    clause.clause_id === 'clause-documents' &&
    flags?.partner_within_rights &&
    clause.original_text_alternate?.trim() &&
    eff === clause.original_text_alternate.trim();
  const unchangedEffect =
    usesDocumentsStage2Alternate && clause.unchanged_variant_alternate?.effect
      ? clause.unchanged_variant_alternate.effect
      : clause.unchanged_variant.effect;
  let c = {
    ...clause,
    original_text: eff || clause.original_text,
    unchanged_variant: {
      ...clause.unchanged_variant,
      text: eff || clause.unchanged_variant.text,
      effect: unchangedEffect
    }
  };

  const byCid = negotiationBaseline?.has_negotiation_data ? (negotiationBaseline.clauses || {}) : {};
  const entry = byCid[c.clause_id];
  const agreed = (entry?.agreed_text || '').trim();
  const hasBaseline = !!agreed;
  const ok = entry?.negotiation_correct === true;
  const u = c.unchanged_variant;

  const stripPools = (x) => {
    const {
      unchanged_variant: _u,
      unchanged_variant_alternate: _uva,
      correct_pool: _cp,
      wrong_pool: _wp,
      variant_mode: _m,
      original_text_alternate: _oa,
      ...rest
    } = x;
    return rest;
  };

  if (!hasBaseline) {
    const onlyUnchangedCorrect =
      (c.clause_id === 'clause-term-customization' &&
        flags?.sublicensing &&
        (clause.original_text_alternate || '').trim()) ||
      usesDocumentsStage2Alternate;
    if (onlyUnchangedCorrect && wp.length >= 2) {
      const [w1, w2] = pickTwoDistinctWrongs(wp);
      const shuffled = shuffleContractOptionSlots(
        [
          { label: 'Оставить без изменений', text: u.text, effect: u.effect },
          { label: CONTRACT_ALT_OPTION_LABEL, text: w1.text, effect: w1.effect },
          { label: CONTRACT_ALT_OPTION_LABEL, text: w2.text, effect: w2.effect }
        ],
        0
      );
      return stripPools({ ...c, ...shuffled });
    }
    if (!cp.length || !wp.length) return clause;
    const correct = poolPick(cp);
    const wrong = poolPick(wp);
    const shuffled = shuffleContractOptionSlots(
      [
        { label: 'Оставить без изменений', text: u.text, effect: u.effect },
        { label: CONTRACT_ALT_OPTION_LABEL, text: correct.text, effect: correct.effect },
        { label: CONTRACT_ALT_OPTION_LABEL, text: wrong.text, effect: wrong.effect }
      ],
      1
    );
    return stripPools({ ...c, ...shuffled });
  }

  c = { ...c, original_text: agreed, unchanged_variant: { ...u, text: agreed } };

  if (ok) {
    if (!wp.length) return clause;
    const [w1, w2] = pickTwoDistinctWrongs(wp);
    const shuffled = shuffleContractOptionSlots(
      [
        { label: 'Оставить без изменений', text: agreed, effect: u.effect },
        { label: CONTRACT_ALT_OPTION_LABEL, text: w1.text, effect: w1.effect },
        { label: CONTRACT_ALT_OPTION_LABEL, text: w2.text, effect: w2.effect }
      ],
      0
    );
    return stripPools({ ...c, ...shuffled });
  }

  if (!cp.length || !wp.length) return clause;
  const correct = poolPick(cp);
  const wrong = poolPick(wp);
  const shuffled = shuffleContractOptionSlots(
    [
      { label: 'Оставить без изменений', text: agreed, effect: u.effect },
      { label: CONTRACT_ALT_OPTION_LABEL, text: correct.text, effect: correct.effect },
      { label: CONTRACT_ALT_OPTION_LABEL, text: wrong.text, effect: wrong.effect }
    ],
    1
  );
  return stripPools({ ...c, ...shuffled });
}

/** Точные строки из облака этапа 2 (`Stage2View` MISSING_CONDITIONS_TAGS / `stage_2.py` MISSING_CONDITIONS_CORRECT). */
const STAGE2_PARTNER_WITHIN_RIGHTS_PHRASE = 'контрагент действует в пределах предоставленных прав';
const STAGE2_SUBLICENSE_PHRASE = 'право на сублицензирование';

/** Дополняет session.stage_4_stage2_flags из stage2_missing_conditions_selected и stage1_result.questions (quality_hint=document). */
function mergeSessionStage2FlagsForStage4(session) {
  if (!session || typeof session !== 'object') return session;
  const prev =
    session.stage_4_stage2_flags && typeof session.stage_4_stage2_flags === 'object'
      ? session.stage_4_stage2_flags
      : {};
  const derived = {};
  const sel = session.stage2_missing_conditions_selected;
  if (Array.isArray(sel)) {
    const hasPartner = sel.some((s) => String(s).trim() === STAGE2_PARTNER_WITHIN_RIGHTS_PHRASE);
    const hasSublicense = sel.some((s) => String(s).trim() === STAGE2_SUBLICENSE_PHRASE);
    if (hasPartner) derived.partner_within_rights = true;
    if (hasSublicense) derived.sublicensing = true;
  }
  const questions = session?.stage1_result?.questions ?? [];
  const authRequested = questions.some(
    (q) => q && String(q.quality_hint ?? '').trim().toLowerCase() === 'document'
  );
  if (authRequested) derived.authletter = true;
  if (!derived.partner_within_rights && !derived.sublicensing && !derived.authletter) return session;
  return { ...session, stage_4_stage2_flags: { ...prev, ...derived } };
}

/** Подставляет согласованный на этапе 3 текст в статические пункты (A/B/C без random_pools). */
function applyStaticNegotiationBaselineToClause(clause, negotiationBaseline) {
  if (!clause || !negotiationBaseline?.has_negotiation_data) return clause;
  const entry = negotiationBaseline.clauses?.[clause.clause_id];
  const agreed = (entry?.agreed_text || '').trim();
  if (!agreed) return clause;
  const next = { ...clause, original_text: agreed };
  if (next.unchanged_variant && typeof next.unchanged_variant === 'object') {
    next.unchanged_variant = { ...next.unchanged_variant, text: agreed };
  }
  if (Array.isArray(next.variants)) {
    next.variants = next.variants.map((v) => {
      if ((v.label || '').includes('Оставить без изменений')) {
        return { ...v, text: agreed };
      }
      return v;
    });
  }
  return next;
}

/** Сервер в /stage4/init уже отдаёт resolved; иначе собираем на клиенте (демо без бэкенда). */
function ensureResolvedContractClauses(clauses, negotiationBaseline, session) {
  if (!Array.isArray(clauses)) return clauses;
  if (clauses.length > 0 && clauses.every((c) => c && c.stage4_server_resolved)) {
    const flags = mergeSessionStage2FlagsForStage4(session || {}).stage_4_stage2_flags || {};
    return clauses.map((cl) => {
      let resolved = negotiationBaseline?.has_negotiation_data
        ? applyStaticNegotiationBaselineToClause(cl, negotiationBaseline)
        : { ...cl };
      if (
        resolved.clause_id === 'clause-documents' &&
        (flags.partner_within_rights || flags.authletter) &&
        resolved.original_text_alternate?.trim()
      ) {
        const alt = resolved.original_text_alternate.trim();
        resolved = {
          ...resolved,
          original_text: alt,
          unchanged_variant: resolved.unchanged_variant
            ? { ...resolved.unchanged_variant, text: alt }
            : resolved.unchanged_variant,
        };
      }
      return resolved;
    });
  }
  const s = mergeSessionStage2FlagsForStage4(session);
  return clauses.map((cl) => {
    const pre =
      cl.variant_mode === 'random_pools'
        ? cl
        : applyStaticNegotiationBaselineToClause(cl, negotiationBaseline);
    return resolveClauseForStage4Client(pre, negotiationBaseline, s);
  });
}

/** Id варианта «Оставить без изменений» (исходная формулировка) для пункта договора. В данных id может быть A, B или C. */
function getOriginalVariantId(clause) {
  if (!clause?.variants?.length) return 'A';
  const v = clause.variants.find((x) => (x.label || '').includes('Оставить без изменений'));
  return v?.id ?? 'A';
}

/** После init original_text уже с учётом этапов 2–3 и резолвера. */
function getContractClauseOriginalText(clause) {
  return clause.original_text || '';
}

/** Текст выбранного варианта так же, как на экране редактирования договора. */
function displayVariantTextForDocuments(clause, v) {
  if (!v) return getContractClauseOriginalText(clause);
  const shownOriginal = getContractClauseOriginalText(clause);
  if (v.label && String(v.label).includes('Оставить без изменений') && shownOriginal) {
    return shownOriginal;
  }
  return (v.text || shownOriginal || '').trim();
}

/** Номер подпункта из заголовка пункта этапа 4: «(п. 1.4.1)», «п.4.1». */
function extractParagraphRefFromClauseTitle(title) {
  const t = String(title || '');
  const re = /п\.\s*([0-9]+(?:\.[0-9]+)*)/gi;
  const m = re.exec(t);
  return m ? m[1] : null;
}

/**
 * Если в title нет «п. N.N.N» (напр. «раздел 4»), подставляем номер строки в contract.md.
 */
const STAGE4_FINAL_CONTRACT_PARAGRAPH_FALLBACK = {
  'clause-acts': '4.1',
  'clause-territory': '1.4.1',
  'clause-term-dates': '1.4.2',
  'clause-term-customization': '1.7',
  'clause-liability': '6.3'
};

function paragraphRefForStage4FinalContract(clause) {
  if (!clause) return null;
  return (
    extractParagraphRefFromClauseTitle(clause.title) ||
    STAGE4_FINAL_CONTRACT_PARAGRAPH_FALLBACK[clause.clause_id] ||
    null
  );
}

/** Одна строка вида «1.4.1. Текст…» в полном договоре (contract.md). */
function replaceContractShellParagraphLine(md, paragraphRef, newBody) {
  const ref = String(paragraphRef || '').trim();
  const body = String(newBody || '').trim().replace(/\s+/g, ' ');
  if (!ref || !body) return md;
  const escaped = ref.replace(/\./g, '\\.');
  const re = new RegExp(`^([ \\t]*)(${escaped})\\.\\s+.*$`, 'm');
  if (!re.test(md)) return md;
  return md.replace(re, (_, indent, num) => `${indent}${num}. ${body}`);
}

function buildStage4FinalContractMarkdownFallback(contractTitleShort, visibleClauses, contractSelections) {
  if (!visibleClauses?.length) return '';
  const title = (contractTitleShort || 'Договор').trim();
  const lines = [
    '## Финальная версия договора',
    '',
    'Редакция, с которой вы вступили в исполнение на этом этапе (выбранные варианты по пунктам).',
    '',
    `**${title}**`,
    ''
  ];
  for (const clause of visibleClauses) {
    const cid = clause.clause_id;
    const variants = clause.variants || [];
    const sel = contractSelections?.[cid];
    const v = variants.find((x) => x.id === sel) || null;
    lines.push(`### ${clause.title || cid || 'Пункт'}`);
    lines.push('');
    if (v) {
      lines.push(`**${v.id}.** ${v.label || 'Вариант'}`);
      lines.push('');
      lines.push(displayVariantTextForDocuments(clause, v));
    } else {
      lines.push(getContractClauseOriginalText(clause) || '—');
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * Полный договор (contract.md с бэкенда) + подстановка выбранных A/B/C в строки «N.N.N. …».
 */
function buildStage4FinalContractMarkdown(
  contractTitleShort,
  visibleClauses,
  contractSelections,
  fullShellMd
) {
  const shell = typeof fullShellMd === 'string' ? fullShellMd.trim() : '';
  if (!shell) {
    return buildStage4FinalContractMarkdownFallback(
      contractTitleShort,
      visibleClauses,
      contractSelections
    );
  }
  let md = shell;
  const shortTitle = (contractTitleShort || '').trim();
  if (shortTitle) {
    md = md.replace(/^#[^\n]*/m, `# ${shortTitle}`);
  }

  const rows = (visibleClauses || []).map((clause) => {
    const variants = clause.variants || [];
    const sel = contractSelections?.[clause.clause_id];
    const v = variants.find((x) => x.id === sel) || null;
    const text = v
      ? displayVariantTextForDocuments(clause, v)
      : getContractClauseOriginalText(clause);
    const flat = String(text || '').trim().replace(/\s+/g, ' ');
    return {
      ref: paragraphRefForStage4FinalContract(clause),
      title: clause.title || clause.clause_id || 'Пункт',
      text: flat
    };
  });

  const sorted = [...rows].sort((a, b) => {
    const ra = a.ref || '';
    const rb = b.ref || '';
    if (ra && rb) return rb.length - ra.length;
    if (ra && !rb) return -1;
    if (!ra && rb) return 1;
    return 0;
  });

  const appendBlocks = [];
  for (const { ref, title, text } of sorted) {
    if (!text) continue;
    if (ref) {
      const next = replaceContractShellParagraphLine(md, ref, text);
      if (next === md) appendBlocks.push({ title, text });
      else md = next;
    } else {
      appendBlocks.push({ title, text });
    }
  }

  if (appendBlocks.length) {
    const blockBody = appendBlocks.map((b) => `**${b.title}**\n\n${b.text}`).join('\n\n');
    const re12 = /\n##\s*12[\s.]/;
    if (re12.test(md)) {
      md = md.replace(re12, (m) => `\n\n## Положения по согласованию (дополнительно)\n\n${blockBody}\n${m}`);
    } else {
      md = `${md}\n\n## Положения по согласованию (дополнительно)\n\n${blockBody}`;
    }
  }

  return md.trim();
}

/** Перемешать массив (копия, без мутации). Используется для вариантов ответов диагностики. */
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Убрать служебные метки из текста варианта (игрок их не видит). */
function stripDiagnosticMarkerText(text) {
  return (text || '')
    .replace(/\s*\(\s*correct\s*\)\s*\.?\s*$/i, '')
    .replace(/\s*\(\s*ocrrect\s*\)\s*\.?\s*$/i, '')
    .replace(/\s*\(\s*wrong\s*\)\s*\.?\s*$/i, '')
    .replace(/\s*\(\s*bad\s*\)\s*\.?\s*$/i, '')
    .replace(/\s*\(\s*viable\s*\)\s*\.?\s*$/i, '')
    .trim();
}

function inferLegalCorrectFromRaw(raw) {
  if (/\(\s*correct\s*\)/i.test(raw) || /\(\s*ocrrect\s*\)/i.test(raw)) return true;
  if (/\(\s*(wrong|bad)\s*\)/i.test(raw)) return false;
  return undefined;
}

/** Нормализация пункта Q2: чистый текст + поле correct для логики. */
function normalizeLegalBasisOption(opt) {
  const raw = opt.text || '';
  const text = stripDiagnosticMarkerText(raw);
  let correct = opt.correct;
  if (correct === undefined) correct = inferLegalCorrectFromRaw(raw);
  return { ...opt, text, correct };
}

/**
 * Из полного набора правовых вариантов выбрать ровно три: хотя бы один верный и хотя бы один неверный
 * (2+1 или 1+2 по возможности).
 */
function pickThreeLegalBasisOptions(rawOpts) {
  const normalized = rawOpts.map(normalizeLegalBasisOption);
  if (normalized.length <= 3) return normalized;

  const correct = normalized.filter((o) => o.correct === true);
  const wrong = normalized.filter((o) => o.correct === false);
  const neutral = normalized.filter((o) => o.correct !== true && o.correct !== false);

  if (correct.length >= 1 && wrong.length >= 1) {
    const canTwoOne = correct.length >= 2 && wrong.length >= 1;
    const canOneTwo = correct.length >= 1 && wrong.length >= 2;

    if (canTwoOne && canOneTwo) {
      if (Math.random() < 0.5) {
        return shuffleArray([
          ...shuffleArray(correct).slice(0, 2),
          ...shuffleArray(wrong).slice(0, 1)
        ]);
      }
      return shuffleArray([
        ...shuffleArray(correct).slice(0, 1),
        ...shuffleArray(wrong).slice(0, 2)
      ]);
    }
    if (canTwoOne) {
      return shuffleArray([
        ...shuffleArray(correct).slice(0, 2),
        ...shuffleArray(wrong).slice(0, 1)
      ]);
    }
    if (canOneTwo) {
      return shuffleArray([
        ...shuffleArray(correct).slice(0, 1),
        ...shuffleArray(wrong).slice(0, 2)
      ]);
    }
    // Ровно один верный и один неверный — третий из нейтральных
    return shuffleArray([
      ...shuffleArray(correct).slice(0, 1),
      ...shuffleArray(wrong).slice(0, 1),
      ...shuffleArray(neutral).slice(0, 1)
    ]);
  }

  if (correct.length >= 1 && neutral.length >= 2) {
    return shuffleArray([...shuffleArray(correct).slice(0, 1), ...shuffleArray(neutral).slice(0, 2)]);
  }
  if (wrong.length >= 1 && neutral.length >= 2) {
    return shuffleArray([...shuffleArray(wrong).slice(0, 1), ...shuffleArray(neutral).slice(0, 2)]);
  }
  return shuffleArray(normalized).slice(0, 3);
}

/** Как _enrich_diagnostic_questions на бэкенде: подставить options из сценария, если в JSON пусто. */
const DEFAULT_DIAGNOSTIC_OPTIONS_STAGE4 = {
  risk_assessment: [
    { id: 'non_critical', text: 'Некритичная' },
    { id: 'significant', text: 'Значимая' },
    { id: 'critical', text: 'Критичная' }
  ],
  legal_basis: [
    { id: 'rights', text: 'Недостаточно чёткое регулирование прав на доработки' },
    { id: 'vague', text: 'Размытые обязательства по результату доработок' },
    { id: 'vendor', text: 'Недобросовестность вендора' },
    { id: 'market', text: 'Общая ситуация на рынке' }
  ],
  immediate_action: [
    { id: 'harsh', text: 'Срочно принимать жёсткие меры (претензии, суд)' },
    { id: 'wait', text: 'Ничего не делать, ждать' },
    { id: 'assess', text: 'Оценить возможность изменения условий до подписания' }
  ]
};

function enrichDiagnosticQuestionsFromCrisis(crisis) {
  if (!crisis) return [];
  const questions = [...(crisis.diagnostic_questions || [])];
  return questions.map((q) => {
    const question = { ...q };
    const qType = question.type || 'risk_assessment';
    const opts = question.options;
    if (Array.isArray(opts) && opts.length > 0) return question;
    if (qType === 'legal_basis' && crisis.legal_basis_options?.length) {
      question.options = crisis.legal_basis_options.map((o) => ({ ...o }));
    } else if (qType === 'immediate_action' && crisis.immediate_action_options?.length) {
      question.options = crisis.immediate_action_options.map((o) => ({ ...o }));
    } else if (DEFAULT_DIAGNOSTIC_OPTIONS_STAGE4[qType]) {
      question.options = DEFAULT_DIAGNOSTIC_OPTIONS_STAGE4[qType].map((o) => ({ ...o }));
    }
    return question;
  });
}

/** Вернуть копию списка вопросов: без меток в UI, для Q2 при >3 вариантов — ровно три с балансом верных/неверных. */
function prepareDiagnosticQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map((q) => {
    const question = { ...q };
    if (!Array.isArray(question.options) || question.options.length === 0) return question;

    if (question.type === 'legal_basis') {
      let opts = pickThreeLegalBasisOptions(question.options);
      question.options = shuffleArray(opts);
      return question;
    }

    if (question.type === 'immediate_action') {
      question.options = shuffleArray(
        question.options.map((o) => ({ ...o, text: stripDiagnosticMarkerText(o.text || '') }))
      );
      return question;
    }

    question.options = shuffleArray(
      question.options.map((o) => ({ ...o, text: stripDiagnosticMarkerText(o.text || '') }))
    );
    return question;
  });
}

const OUTCOMES = {
  failed: {
    subtitle: 'Результат диагностики',
    timeline: [{ month: 'Через 6 месяцев', label: 'Кризис сохраняется', status: 'fail' }],
    title: 'Диагностика не позволила предложить возврат',
    text: 'Кризис сохраняется. Рекомендуется пересмотреть оценку степени угрозы, причин и вариант действий — оценка возможности изменения условий до подписания даёт доступ к опции возврата.',
    lexic: '—'
  },
  accept: {
    subtitle: 'Принятие последствий',
    timeline: [
      { month: 'Через 6 месяцев', label: 'Кризис', status: 'fail' },
      { month: '', label: 'Компания осознанно идёт в переговоры / доплату. Решение управляемое.', status: 'done' }
    ],
    title: 'Исход 1. Вы не возвращались, но верно оценили ситуацию',
    text: 'Кризис есть. Компания осознанно идёт в переговоры или к доплате. Решение управляемое.',
    lexic: 'X+, E+, I+'
  },
  repeat: {
    subtitle: 'Исполнение после возврата к договору',
    timeline: [
      { month: 'Через 5 месяцев', label: 'Рост зависимости от вендора', status: 'warn' },
      { month: 'Через 6 месяцев', label: 'Кризис повторяется', status: 'fail' },
      { month: '', label: 'Причина не устранена — лечили симптом.', status: 'warn' }
    ],
    title: 'Исход 2. Вы вернулись, но не устранили причину',
    text: 'Кризис реализуется, исход зависит от принятой меры.',
    lexic: 'X±, C−, E−'
  },
  fixed: {
    subtitle: 'Исполнение после возврата к договору',
    timeline: [
      { month: 'Через 5 месяцев', label: 'Завершение доработок', status: 'done' },
      { month: 'Через 6 месяцев', label: 'Вендор передаёт код и документацию', status: 'done' },
      { month: '', label: 'Кризис не возникает. Возможны вторичные бизнес-трения.', status: 'warn' }
    ],
    title: 'Исход 3. Вы вернулись и устранили причину',
    text: 'Кризис не возникает. Вендор обязан передать код. Возможны вторичные бизнес-трения (экономика сделки, отношения).',
    lexic: 'X+, L+, C+, E±'
  },
  noChange: {
    subtitle: 'Исполнение после возврата к договору',
    timeline: [
      { month: 'Через 4 месяца', label: 'Исполнение договора без изменений', status: 'done' },
      { month: 'Через 5 месяцев', label: 'Новый кризис', status: 'fail' },
      { month: '', label: 'Вы вернулись к договору, но не внесли правок — наступает другой кризис.', status: 'warn' }
    ],
    title: 'Исход 4. Вы вернулись, но не изменили договор',
    text: 'Поскольку вы не внесли изменений в пункты договора, наступает другой кризис (по иному основанию или сценарию). Возврат был использован впустую.',
    lexic: 'X−, E−, I−'
  }
};

const NO_CHANGE_WARN_STRIP = {
  month: '',
  label: 'Вы вернулись к договору, но не внесли правок — возможны последствия',
  status: 'warn',
  crisis: false
};

/** Прокрутка радио-таймлайна: быстрый старт, плавное замедление у точки. */
function stage4RadioEaseOutCubic(u) {
  const t = Math.min(1, Math.max(0, u));
  return 1 - (1 - t) ** 3;
}

export default function Stage4View({
  session,
  stage,
  onAction,
  onComplete,
  timeRemaining,
  onBackToStart,
  onFinishCase,
  onSessionUpdate,
  stage4EmailModalCloseNonce = 0, // legacy, не используется — катсцена запускается кликом
  /** id шага локального тура — переключение фазы, чтобы подсветка видела нужный экран */
  simulatorTourStepId = null,
  /** Запрос завершения этапа на сервере — явная обратная связь на всех кнопках «Завершить этап» */
  stageCompleteInFlight = false,
  /** Текст финального договора для модалки «Документы» в GameView (markdown) */
  onFinalContractForDocumentsChange = undefined,
  /** Секунды таймера правок договора → GameplayHud (как этапный таймер на этапе 2); `null` — скрыть */
  onContractHudTimerSeconds = undefined,
}) {
  const onCompleteStage = () => {
    if (stageCompleteInFlight) return;
    const sid = session?.id || session?.session_id || session?.sessionId;
    if (sid) clearStageDraft(sid, 4);
    onComplete?.();
  };

  const [stage4Data, setStage4Data] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [phase, setPhase] = useState('phaseCutscene');
  const phaseBeforeSimulatorTourRef = useRef(null);

  useEffect(() => {
    const m = {
      's4-intro': 'phaseCutscene',
      's4-timeline': 'phaseCutscene',
      's4-diagnostic': 'phaseDiagnostic',
      's4-choice': 'phaseChoice',
      's4-contract': 'phaseContract',
    };
    const p = simulatorTourStepId ? m[simulatorTourStepId] : null;
    if (p) {
      if (phaseBeforeSimulatorTourRef.current === null) {
        phaseBeforeSimulatorTourRef.current = phase;
      }
      setPhase(p);
      return;
    }
    if (!simulatorTourStepId && phaseBeforeSimulatorTourRef.current !== null) {
      const saved = phaseBeforeSimulatorTourRef.current;
      phaseBeforeSimulatorTourRef.current = null;
      setPhase(saved);
    }
  }, [simulatorTourStepId, phase]);

  const [cutsceneAwaitingClick, setCutsceneAwaitingClick] = useState(true);
  const [cutsceneVisible, setCutsceneVisible] = useState([]);
  /** Последняя полоса исхода (после разрешения) — появляется с задержкой, как шаги кат-сцены */
  const [outcomeLastRowVisible, setOutcomeLastRowVisible] = useState(false);
  /** Карточка с текстом разрешения — после последней полосы таймлайна (как текст кризиса после событий) */
  const [outcomeResolutionCardVisible, setOutcomeResolutionCardVisible] = useState(false);
  /** Итоговая полоса после диагностики второго кризиса */
  const [secondOutcomeStripVisible, setSecondOutcomeStripVisible] = useState(false);
  const [secondOutcomeResolutionCardVisible, setSecondOutcomeResolutionCardVisible] = useState(false);
  const [firstDiagnosticContentVisible, setFirstDiagnosticContentVisible] = useState(false);
  const [secondDiagnosticContentVisible, setSecondDiagnosticContentVisible] = useState(false);
  const [crisisVisible, setCrisisVisible] = useState(false);
  const [showNextBtn, setShowNextBtn] = useState(false);
  const [diagnosisAnswers, setDiagnosisAnswers] = useState({});
  const [outcomeData, setOutcomeData] = useState(null);
  const [contractSelections, setContractSelections] = useState({});
  const [contractTimerSec, setContractTimerSec] = useState(10 * 60); // 10 минут
  const [docImageError, setDocImageError] = useState(false);
  const cutsceneDone = useRef(false);
  const contractTimerExpiredHandled = useRef(false);
  const contractEditStartRecorded = useRef(false);
  // Второй кризис (всегда после первого исхода)
  const [firstOutcomeKey, setFirstOutcomeKey] = useState(null);
  const [secondCrisis, setSecondCrisis] = useState(null);
  const [secondTimelineEvents, setSecondTimelineEvents] = useState([]);
  const [secondCutsceneVisible, setSecondCutsceneVisible] = useState([]);
  const [secondCrisisVisible, setSecondCrisisVisible] = useState(false);
  const [secondShowNextBtn, setSecondShowNextBtn] = useState(false);
  const [secondDiagnosisAnswers, setSecondDiagnosisAnswers] = useState({});
  const [secondDiagnosisCorrect, setSecondDiagnosisCorrect] = useState(null);
  const [secondOutcomeViable, setSecondOutcomeViable] = useState(false);
  const [secondOutcomeData, setSecondOutcomeData] = useState(null);
  const [loadingSecond, setLoadingSecond] = useState(false);
  const [secondCrisisLoadError, setSecondCrisisLoadError] = useState(null);
  const secondCutsceneDone = useRef(false);
  const [radioActiveIdx, setRadioActiveIdx] = useState(0);
  const [radioOffsetPx, setRadioOffsetPx] = useState(0);
  const [radioSidePadPx, setRadioSidePadPx] = useState(0);
  const [radioStepPx, setRadioStepPx] = useState(STAGE4_RADIO_STEP_PX);
  const [radioMinOffsetPx, setRadioMinOffsetPx] = useState(0);
  const [radioMaxOffsetPx, setRadioMaxOffsetPx] = useState(0);
  const radioTimelineRef = useRef(null);
  const radioAutoRafRef = useRef(null);
  const radioUserInteractedRef = useRef(false);
  const radioDragRef = useRef({ active: false, startX: 0, startOffset: 0 });
  /** Актуальный offset до useEffect автопрокрутки (для отмотки в phaseContract без лишних зависимостей). */
  const radioOffsetRef = useRef(0);
  /** Первый кадр «Показать исход» — сбрасываем user-interacted, чтобы DOM-центрирование могло сдвинуть ленту. */
  const prevShouldCenterLastGateRef = useRef(false);
  const prevSecondOutcomeCenterGateRef = useRef(false);
  const outcomeRevealAfterScrollTimeoutsRef = useRef([]);
  const secondOutcomeRevealTimersRef = useRef([]);
  /** Положение ленты (radioOffsetPx), запоминается на этапе диагностики — на «Разрешении» докручиваем от него до точки разрешения. */
  const radioOffsetDiagnosticSnapshotRef = useRef(null);
  /** То же для второго кризиса: от диагностики до экрана итога. */
  const radioOffsetSecondDiagnosticSnapshotRef = useRef(null);
  const setRadioTimelineEl = useCallback((node) => {
    radioTimelineRef.current = node;
  }, []);

  const [outcomeKey, setOutcomeKey] = useState(null);

  // Визуальный эффект после возврата в договор: воспроизведение таймлайна, мигание точки кризиса, конфетти и Док Браун при успехе
  const [returnReplayRevealed, setReturnReplayRevealed] = useState([]);
  const [returnReplayPhase, setReturnReplayPhase] = useState('timeline'); // timeline | blinking | settled | outcome | resolution | celebration | done
  const [returnReplayBlinkColor, setReturnReplayBlinkColor] = useState('red'); // red | green — для мигания
  const [returnReplaySettledColor, setReturnReplaySettledColor] = useState(null); // green | red
  const [showConfetti, setShowConfetti] = useState(false);
  const [showDocBrown, setShowDocBrown] = useState(false);
  const [docBrownAtCenter, setDocBrownAtCenter] = useState(false);
  const [docBrownGreeting, setDocBrownGreeting] = useState(false);
  const returnReplayStartedRef = useRef(false);
  const prevPhaseRef = useRef(phase);

  const s4DraftRestoredRef = useRef(false);
  const [s4DraftHydrated, setS4DraftHydrated] = useState(false);
  const stage4CaseIdForDraft = useMemo(() => {
    const raw = session?.case_id || stage?.case_id || 'case-stage-4';
    return canonicalCaseCode(raw);
  }, [session?.case_id, stage?.case_id]);

  useLayoutEffect(() => {
    s4DraftRestoredRef.current = false;
    setS4DraftHydrated(false);
  }, [session?.id, session?.sessionId, session?.session_id]);

  useLayoutEffect(() => {
    if (simulatorTourStepId || loading || loadError || !stage4Data) return;
    const sid = session?.id || session?.session_id || session?.sessionId;
    if (!sid) return;
    if (s4DraftRestoredRef.current) return;
    s4DraftRestoredRef.current = true;

    const draft = readStageDraft(sid, 4);
    if (draft?.version === 1 && draft.caseId === stage4CaseIdForDraft) {
      if (typeof draft.phase === 'string') setPhase(draft.phase);
      if (typeof draft.cutsceneAwaitingClick === 'boolean') {
        setCutsceneAwaitingClick(draft.cutsceneAwaitingClick);
      }
      if (Array.isArray(draft.cutsceneVisible)) setCutsceneVisible(draft.cutsceneVisible);
      if (typeof draft.outcomeLastRowVisible === 'boolean') {
        setOutcomeLastRowVisible(draft.outcomeLastRowVisible);
      }
      if (typeof draft.outcomeResolutionCardVisible === 'boolean') {
        setOutcomeResolutionCardVisible(draft.outcomeResolutionCardVisible);
      }
      if (typeof draft.secondOutcomeStripVisible === 'boolean') {
        setSecondOutcomeStripVisible(draft.secondOutcomeStripVisible);
      }
      if (typeof draft.secondOutcomeResolutionCardVisible === 'boolean') {
        setSecondOutcomeResolutionCardVisible(draft.secondOutcomeResolutionCardVisible);
      }
      if (typeof draft.firstDiagnosticContentVisible === 'boolean') {
        setFirstDiagnosticContentVisible(draft.firstDiagnosticContentVisible);
      }
      if (typeof draft.secondDiagnosticContentVisible === 'boolean') {
        setSecondDiagnosticContentVisible(draft.secondDiagnosticContentVisible);
      }
      if (typeof draft.crisisVisible === 'boolean') setCrisisVisible(draft.crisisVisible);
      if (typeof draft.showNextBtn === 'boolean') setShowNextBtn(draft.showNextBtn);
      if (draft.diagnosisAnswers && typeof draft.diagnosisAnswers === 'object') {
        setDiagnosisAnswers(draft.diagnosisAnswers);
      }
      if (draft.outcomeData !== undefined) setOutcomeData(draft.outcomeData);
      if (draft.contractSelections && typeof draft.contractSelections === 'object') {
        setContractSelections(draft.contractSelections);
      }
      if (typeof draft.contractTimerSec === 'number') setContractTimerSec(draft.contractTimerSec);
      if (typeof draft.docImageError === 'boolean') setDocImageError(draft.docImageError);
      if (draft.firstOutcomeKey !== undefined) setFirstOutcomeKey(draft.firstOutcomeKey);
      if (draft.secondCrisis !== undefined) setSecondCrisis(draft.secondCrisis);
      if (Array.isArray(draft.secondTimelineEvents)) {
        setSecondTimelineEvents(draft.secondTimelineEvents);
      }
      if (Array.isArray(draft.secondCutsceneVisible)) {
        setSecondCutsceneVisible(draft.secondCutsceneVisible);
      }
      if (typeof draft.secondCrisisVisible === 'boolean') {
        setSecondCrisisVisible(draft.secondCrisisVisible);
      }
      if (typeof draft.secondShowNextBtn === 'boolean') {
        setSecondShowNextBtn(draft.secondShowNextBtn);
      }
      if (draft.secondDiagnosisAnswers && typeof draft.secondDiagnosisAnswers === 'object') {
        setSecondDiagnosisAnswers(draft.secondDiagnosisAnswers);
      }
      if (draft.secondDiagnosisCorrect !== undefined) {
        setSecondDiagnosisCorrect(draft.secondDiagnosisCorrect);
      }
      if (typeof draft.secondOutcomeViable === 'boolean') {
        setSecondOutcomeViable(draft.secondOutcomeViable);
      }
      if (draft.secondOutcomeData !== undefined) setSecondOutcomeData(draft.secondOutcomeData);
      if (typeof draft.loadingSecond === 'boolean') setLoadingSecond(draft.loadingSecond);
      if (draft.secondCrisisLoadError !== undefined) {
        setSecondCrisisLoadError(draft.secondCrisisLoadError);
      }
      if (typeof draft.radioActiveIdx === 'number') setRadioActiveIdx(draft.radioActiveIdx);
      if (typeof draft.radioOffsetPx === 'number') setRadioOffsetPx(draft.radioOffsetPx);
      if (typeof draft.radioSidePadPx === 'number') setRadioSidePadPx(draft.radioSidePadPx);
      if (typeof draft.radioStepPx === 'number') setRadioStepPx(draft.radioStepPx);
      if (typeof draft.radioMinOffsetPx === 'number') setRadioMinOffsetPx(draft.radioMinOffsetPx);
      if (typeof draft.radioMaxOffsetPx === 'number') setRadioMaxOffsetPx(draft.radioMaxOffsetPx);
      if (draft.outcomeKey !== undefined) setOutcomeKey(draft.outcomeKey);
      if (Array.isArray(draft.returnReplayRevealed)) {
        setReturnReplayRevealed(draft.returnReplayRevealed);
      }
      if (typeof draft.returnReplayPhase === 'string') {
        setReturnReplayPhase(draft.returnReplayPhase);
      }
      if (typeof draft.returnReplayBlinkColor === 'string') {
        setReturnReplayBlinkColor(draft.returnReplayBlinkColor);
      }
      if (draft.returnReplaySettledColor !== undefined) {
        setReturnReplaySettledColor(draft.returnReplaySettledColor);
      }
      if (typeof draft.showConfetti === 'boolean') setShowConfetti(draft.showConfetti);
      if (typeof draft.showDocBrown === 'boolean') setShowDocBrown(draft.showDocBrown);
      if (typeof draft.docBrownAtCenter === 'boolean') setDocBrownAtCenter(draft.docBrownAtCenter);
      if (typeof draft.docBrownGreeting === 'boolean') setDocBrownGreeting(draft.docBrownGreeting);
      if (draft.cutsceneDone != null) cutsceneDone.current = !!draft.cutsceneDone;
      if (draft.secondCutsceneDone != null) {
        secondCutsceneDone.current = !!draft.secondCutsceneDone;
      }
      if (draft.contractEditStartRecorded != null) {
        contractEditStartRecorded.current = !!draft.contractEditStartRecorded;
      }
      if (draft.returnReplayStarted != null) {
        returnReplayStartedRef.current = !!draft.returnReplayStarted;
      }
      if (typeof draft.contractTimerSec === 'number' && draft.phase === 'phaseContract') {
        const sec = draft.contractTimerSec;
        queueMicrotask(() => setContractTimerSec(Math.max(0, sec)));
      }
    }
    setS4DraftHydrated(true);
  }, [
    simulatorTourStepId,
    loading,
    loadError,
    stage4Data,
    session?.id,
    session?.sessionId,
    session?.session_id,
    stage4CaseIdForDraft,
  ]);

  const timelineItems = useMemo(
    () => dedupeCrisisTimeline(stage4Data?.timeline_events || []),
    [stage4Data?.timeline_events]
  );

  const timelineItemsCrisisTitleOnly = useMemo(
    () => timelineItems.map((ev) => timelineMaskCrisisFirstView(ev)),
    [timelineItems]
  );

  const timelineDisplayBundle = useMemo(() => {
    const anchor = getTimelineSigningAnchorDate();
    const masked = timelineItems.map((ev) => timelineMaskCrisisFirstView(ev));
    return {
      anchor,
      cutscene: stage4BuildDisplayTimeline(masked, { includeSigningPrep: false, anchorDate: anchor }),
      contract: stage4BuildDisplayTimeline(masked, { includeSigningPrep: true, anchorDate: anchor })
    };
  }, [timelineItems]);

  const timelineAnchorDate = timelineDisplayBundle.anchor;
  const timelineDisplayCutscene = timelineDisplayBundle.cutscene;
  const timelineDisplayContract = timelineDisplayBundle.contract;

  // Сброс состояния «возврата» только при входе в phaseFinal (fixed/repeat)
  useEffect(() => {
    const isReturnOutcome = firstOutcomeKey === 'fixed' || firstOutcomeKey === 'repeat';
    const justEntered = prevPhaseRef.current !== 'phaseFinal' && phase === 'phaseFinal';
    prevPhaseRef.current = phase;
    if (!justEntered || !isReturnOutcome) return;
    setReturnReplayRevealed([]);
    setReturnReplayPhase('timeline');
    setReturnReplayBlinkColor('red');
    setReturnReplaySettledColor(null);
    setShowConfetti(false);
    setShowDocBrown(false);
    setDocBrownAtCenter(false);
    setDocBrownGreeting(false);
    returnReplayStartedRef.current = false;
  }, [phase, firstOutcomeKey]);

  // Индекс точки кризиса в таймлайне
  const crisisIndex = useMemo(() => {
    const items = timelineItems || [];
    const idx = items.findIndex((e) => e.crisis);
    return idx >= 0 ? idx : Math.max(0, items.length - 1);
  }, [timelineItems]);

  const confettiPieces = useMemo(() => {
    if (!showConfetti) return [];
    return Array.from({ length: 72 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.6,
      color: ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899'][Math.floor(Math.random() * 6)],
      duration: 2.2 + Math.random() * 1.2
    }));
  }, [showConfetti]);

  // Воспроизведение таймлайна после возврата: появление точек, мигание кризиса, исход, при успехе — конфетти и Док Браун
  useEffect(() => {
    if (phase !== 'phaseFinal' || (firstOutcomeKey !== 'fixed' && firstOutcomeKey !== 'repeat')) return;
    if (returnReplayStartedRef.current) return;
    const items = timelineItems || [];
    if (!items.length) return;

    returnReplayStartedRef.current = true;
    const isFixed = firstOutcomeKey === 'fixed';
    const delay = 500;

    const stepMs = 550;
    const blinkStartAt = delay + crisisIndex * stepMs + 600;
    const blinkDuration = 2400; // 6 переключений по 400 мс
    const blinkEnd = blinkStartAt + blinkDuration;

    // Без пошагового проявления: все вехи видны сразу (прокрутка ленты и дальнейшая драматургия — как раньше).
    setReturnReplayRevealed(items.map((_, i) => i));

    // Мигание красный/зелёный начинается после «остановки» на точке кризиса (тот же момент по времени, что и при пошаговом появлении)
    let blinkTimer;
    const startBlink = setTimeout(() => {
      setReturnReplayPhase('blinking');
      let count = 0;
      blinkTimer = setInterval(() => {
        setReturnReplayBlinkColor((c) => (c === 'red' ? 'green' : 'red'));
        count++;
        if (count >= 6) clearInterval(blinkTimer);
      }, 400);
    }, blinkStartAt);

    const RETURN_REPLAY_CRISIS_HOLD_MS = 600;
    const RETURN_REPLAY_OUTCOME_TO_RESOLUTION_MS = 600;
    const RETURN_REPLAY_RESOLUTION_TO_CELEBRATION_MS = 800;
    const afterOutcomeMs = blinkEnd + RETURN_REPLAY_CRISIS_HOLD_MS;
    const afterResolutionMs = afterOutcomeMs + RETURN_REPLAY_OUTCOME_TO_RESOLUTION_MS;

    const timers = [];

    timers.push(
      setTimeout(() => {
        clearInterval(blinkTimer);
        setReturnReplayPhase('settled');
        setReturnReplaySettledColor(isFixed ? 'green' : 'red');
        setReturnReplayBlinkColor(isFixed ? 'green' : 'red');
      }, blinkEnd)
    );

    timers.push(setTimeout(() => setReturnReplayPhase('outcome'), afterOutcomeMs));
    timers.push(setTimeout(() => setReturnReplayPhase('resolution'), afterResolutionMs));

    if (isFixed) {
      const celebrationAt = afterResolutionMs + RETURN_REPLAY_RESOLUTION_TO_CELEBRATION_MS;
      timers.push(
        setTimeout(() => {
          setReturnReplayPhase('celebration');
          setShowConfetti(true);
        }, celebrationAt)
      );
      const docShowAt = celebrationAt + 1800;
      timers.push(
        setTimeout(() => {
          setShowDocBrown(true);
          requestAnimationFrame(() => setDocBrownAtCenter(true));
        }, docShowAt)
      );
      timers.push(setTimeout(() => setDocBrownGreeting(true), docShowAt + 2400));
      timers.push(setTimeout(() => setReturnReplayPhase('done'), celebrationAt + 6000));
    } else {
      timers.push(setTimeout(() => setReturnReplayPhase('done'), afterResolutionMs + 400));
    }

    return () => {
      clearTimeout(startBlink);
      clearInterval(blinkTimer);
      timers.forEach((id) => clearTimeout(id));
      returnReplayStartedRef.current = false;
    };
  }, [phase, firstOutcomeKey, timelineItems, crisisIndex]);

  // case_id как на этапах 1–3: из сессии или этапа; по CASE_FILES.md контент в data/cases/<case_id>/
  const rawCaseId = session?.case_id || stage?.case_id || 'case-stage-4';
  const caseId = canonicalCaseCode(rawCaseId);

  // Загрузка этапа: content → init с дефолтными выборами (все A). Алгоритм без изменений: письмо → таймлайн → кризис → диагностика → …
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(`${API_URL}/stage4/content?case_id=${encodeURIComponent(caseId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText || 'Ошибка загрузки');
        return res.json();
      })
      .then((content) => {
        if (cancelled) return content;
        const clauses = content.contract_clauses || [];
        const defaultSelections = {};
        clauses.forEach((c) => { if (c.clause_id) defaultSelections[c.clause_id] = 'A'; });
        const simulexSessionId = session?.id || session?.sessionId || session?.session_id;
        return fetch(`${API_URL}/stage4/init`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            case_id: caseId,
            session: session || {},
            simulex_session_id: simulexSessionId || undefined,
            contract_selections: defaultSelections
          })
        })
          .then((res) => { if (!res.ok) throw new Error(res.statusText || 'Ошибка init'); return res.json(); })
          .then((initData) => ({ ...content, ...initData }));
      })
      .then(async (data) => {
        if (cancelled) return;
        let rawClauses = data.contract_clauses || [];
        if (sessionRequestedStage1AuthorizationLetter(session)) {
          rawClauses = rawClauses.filter((c) => c.clause_id !== 'clause-documents');
        }
        let baseline = { has_negotiation_data: false, clauses: {} };
        if (session?.stage_4_negotiation_baseline?.has_negotiation_data) {
          baseline = session.stage_4_negotiation_baseline;
        } else {
          const simId = session?.id || session?.sessionId || session?.session_id;
          if (simId) {
            const negId = await resolveNegotiationSessionIdForStage4(simId, caseId);
            if (negId) {
              try {
                const doc = await documentAPI.getClauses(negId);
                const s3 = doc.clauses || [];
                baseline = buildNegotiationBaselineFromDocumentClauses(s3, rawClauses);
              } catch {
                /* нет данных переговоров — только дефолтные пулы */
              }
            }
          }
        }
        const resolvedClauses = ensureResolvedContractClauses(rawClauses, baseline, session);
        if (!cancelled) {
          setStage4Data({ ...data, contract_clauses: resolvedClauses, negotiation_baseline: baseline });
          if (data.contract_selections && typeof data.contract_selections === 'object') {
            setContractSelections({ ...data.contract_selections });
          }
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err.message || 'Не удалось загрузить контент этапа');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [
    caseId,
    session?.id,
    session?.session_id,
    session?.sessionId,
    session?.stage_4_negotiation_baseline,
    session?.stage_4_stage2_flags,
    session?.stage2_missing_conditions_selected,
    session?.stage1_requested_documents
  ]);

  // При переходе на новую фазу — прокрутка в начало экрана после отрисовки (чтобы диагностика и др. открывались сверху)
  useEffect(() => {
    const run = () => {
    window.scrollTo(0, 0);
    if (typeof document !== 'undefined') {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
      const activeEl = document.getElementById(phase);
      if (activeEl) activeEl.scrollIntoView({ behavior: 'auto', block: 'start' });
    };
    run();
    const t = setTimeout(run, 50);
    const t2 = setTimeout(run, 150);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [phase]);

  const showPhase = (id) => setPhase(id);

  const crisis = stage4Data?.selected_crisis || {};
  /** Кнопка «Продолжить» ко второму кризису — только если был сценарий с возвратом в договор; иначе исход единственный и финальный. */
  const canContinueToSecondCrisis = crisis?.offers_time_travel !== false;
  const crisisDescription =
    crisis.crisis_description?.trim() || 'Произошла кризисная ситуация.';
  const docLetterText = stage4Data?.doc_letter_text || '';
  const base = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
  const publicPath = `${base}${process.env.PUBLIC_URL || ''}`;
  const docAvatarUrl = `${publicPath}/images/doc-brown.png`;
  const docLetterAvatarUrl = `${publicPath}/images/doc-brown-letter.png`;
  const contractClauses = stage4Data?.contract_clauses || [];
  const negotiationBaseline = stage4Data?.negotiation_baseline;
  const visibleContractClauses = useMemo(
    () =>
      contractClauses.filter(
        (c) => !clauseOmittedFromStage4ContractScreen(c, negotiationBaseline, session)
      ),
    [contractClauses, negotiationBaseline, session?.stage1_requested_documents]
  );
  const contractTitle = stage4Data?.contract_title || 'Договор';
  const contractTitleShort = (contractTitle || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || contractTitle;

  useEffect(() => {
    if (!onFinalContractForDocumentsChange) return undefined;
    if (!stage4Data || loading || loadError) {
      onFinalContractForDocumentsChange(null);
      return undefined;
    }
    const md = buildStage4FinalContractMarkdown(
      contractTitleShort,
      visibleContractClauses,
      contractSelections,
      stage4Data.full_contract_document_md
    );
    onFinalContractForDocumentsChange(md || null);
    return () => {
      onFinalContractForDocumentsChange(null);
    };
  }, [
    onFinalContractForDocumentsChange,
    stage4Data,
    loading,
    loadError,
    contractTitleShort,
    visibleContractClauses,
    contractSelections,
    stage4Data?.full_contract_document_md,
  ]);

  const diagnosticQuestions = useMemo(
    () => prepareDiagnosticQuestions(crisis.diagnostic_questions || []),
    [crisis?.crisis_id, crisis?.diagnostic_questions]
  );

  const canSubmitDiagnostic = diagnosticQuestions.every((q) => {
    const key = q.question_id || q.type;
    const val = diagnosisAnswers[key];
    if (q.type === 'legal_basis') return Array.isArray(val) ? val.length > 0 : !!val;
    return val != null && val !== '';
  });

  const diagnosisFullyFailed = () => {
    const risk = diagnosisAnswers['q1-risk'] || diagnosisAnswers.risk_assessment;
    const legal = diagnosisAnswers['q2-legal'] || diagnosisAnswers.legal_basis;
    const act = diagnosisAnswers['q3-action'] || diagnosisAnswers.immediate_action;
    const legalOpts = crisis.legal_basis_options || [];
    const legalIds = Array.isArray(legal) ? legal : legal != null && legal !== '' ? [legal] : [];
    const adequateRisk = (crisis.correct_risk_ids || []).includes(risk);
    const pickedCorrectLegal = legalIds.some((id) => {
      const o = legalOpts.find((x) => x.id === id);
      return o && o.correct === true;
    });
    const actOutcome = crisis.immediate_action_outcomes?.[act];
    const worstAction = actOutcome?.type === 'bad';
    return !adequateRisk && !pickedCorrectLegal && worstAction;
  };

  const handleDiagnosticSubmit = (e) => {
    e.preventDefault();
    // Запись в сессию для последующего расчёта LEXIC
    if (session && typeof onSessionUpdate === 'function') {
      const nextState = {
        ...(session.stage_4_state || {}),
        diagnosis_answers_first: diagnosisAnswers,
        selected_crisis_id_first: crisis?.crisis_id ?? crisis?.id,
      };
      onSessionUpdate({ ...session, stage_4_state: nextState });
    }
    if (crisis?.offers_time_travel === false) {
      setFinalOutcome('accept');
      return;
    }
    // После первого кризиса игроку предлагается выбор: вернуться в договор или принять последствия
    showPhase('phaseChoice');
  };

  const setFinalOutcome = (key, opt) => {
    const o = OUTCOMES[key];
    if (!o) return;
    setFirstOutcomeKey(key);
    // Запись в сессию для LEXIC только при «Принять последствия» (исход после возврата пишет handleContractDone)
    if (key === 'accept' && session && typeof onSessionUpdate === 'function') {
      const nextState = {
        ...(session.stage_4_state || {}),
        first_outcome_key: key,
        time_travel_choice: 'ignore',
      };
      onSessionUpdate({ ...session, stage_4_state: nextState });
    }
    let viable = false;
    let firstOutcomeStatus = null;
    let sub = o.subtitle;
    if (key === 'repeat' && opt) sub = 'Исполнение после возврата к договору';
    let title = (o.title || '').replace(/^Исход \d+\.\s*/i, '').trim();
    let timeline = o.timeline;
    let text = o.text;
    if (key === 'fixed' && crisis) {
      const base = (timelineItems || []).map((ev) => {
        const s = mapTimelineEventToStrip(ev);
        if (s.crisis) {
          return { ...s, label: FIXED_RETURN_TIMELINE_DOT_LABEL, status: 'done', crisis: false };
        }
        return s;
      });
      timeline = base;
      const variants = crisis.fixed_outcome_variants;
      if (Array.isArray(variants) && variants.length > 0) {
        text = sanitizeFixedReturnOutcomeText(
          variants[Math.floor(Math.random() * variants.length)].text,
          title
        );
      } else {
        text = sanitizeFixedReturnOutcomeText(
          'Кризис не возникает. При возврате вы привели договор в соответствие; исполнение идёт в рамках скорректированных условий, оснований для претензий и доначислений нет.',
          title
        );
      }
    }
    if ((key === 'repeat' || key === 'accept') && crisis) {
      const rawItems = (timelineItems || []).filter(Boolean);
      const base = rawItems.map(mapTimelineEventToStrip);
      const crisisIdx = base.findIndex((x) => x.crisis);
      const rawCrisisLabel = crisisIdx >= 0 ? (rawItems[crisisIdx]?.label || base[crisisIdx].label) : '';
      const actionId = diagnosisAnswers['q3-action'] || diagnosisAnswers.immediate_action;
      const actionOutcomes = (crisis.immediate_action_outcomes || {});
      const specificOutcome = actionId && actionOutcomes[actionId] ? actionOutcomes[actionId] : null;

      if (crisisIdx >= 0) {
        if (specificOutcome?.type === 'positive') {
          const crisisDetail = extractCrisisDetailFromLabel(rawCrisisLabel);
          // Точка на дате кризиса — момент угрозы (красная); благоприятный исход — в следующей полосе (resolution_label).
          base[crisisIdx] = {
            ...base[crisisIdx],
            label: crisisDetail || base[crisisIdx].label,
            status: 'fail',
            crisis: true
          };
        } else {
          const detail = extractCrisisDetailFromLabel(rawCrisisLabel);
          let rowStatus = base[crisisIdx].status;
          if (specificOutcome?.type === 'bad') rowStatus = 'fail';
          else if (specificOutcome?.type === 'viable') rowStatus = 'warn';
          base[crisisIdx] = {
            ...base[crisisIdx],
            label: detail || base[crisisIdx].label,
            status: rowStatus,
            crisis: true
          };
        }
      }

      let label = crisis.resolution_label || o.timeline?.[1]?.label || '';
      let status = 'done';
      if (specificOutcome) {
        const strip = outcomeTimelineEventLabel(crisis, specificOutcome);
        if (strip) label = strip;
      }
      if (specificOutcome?.status) {
        status = specificOutcome.status;
      }
      if (specificOutcome?.type === 'bad') {
        status = 'fail';
      }
      if (specificOutcome?.type === 'viable') {
        status = 'warn';
      }
      if (specificOutcome?.type === 'positive') {
        status = 'done';
      }

      const rawDefault = crisis.resolution_text || o.text;
      if (specificOutcome?.text) {
        text = specificOutcome.text;
      } else {
        text = (rawDefault || '').replace(/^Кризис не возникает\.\s*/i, '') || o.text;
      }

      // repeat = вернулся, но не изменил нужный пункт → угроза реализуется; текст по выбранной мере
      if (key === 'repeat') {
        const prefix = 'Кризис реализуется, исход зависит от принятой меры. ';
        if (specificOutcome && (specificOutcome.type === 'bad' || specificOutcome.type === 'viable' || specificOutcome.type === 'positive')) {
          text = prefix + (specificOutcome.text || '');
        } else {
          label = 'Угроза реализуется';
          status = 'fail';
          text = prefix.slice(0, -1); // «Кризис реализуется, исход зависит от принятой меры»
        }
      }

      if (key === 'accept') {
        const noContractReturn = crisis?.offers_time_travel === false;
        if (specificOutcome?.type === 'viable') {
          title = noContractReturn
            ? (specificOutcome.second_crisis_title || '').trim() || 'Ваша стратегия спорная'
            : 'Вы не возвращались, но ваша стратегия спорная';
        } else if (specificOutcome?.type === 'bad') {
          title = noContractReturn
            ? (specificOutcome.second_crisis_title || '').trim() || 'Угроза реализовалась'
            : 'Вы не возвращались, и угроза реализовалась';
        } else if (specificOutcome?.type === 'positive') {
          title = noContractReturn
            ? (specificOutcome.second_crisis_title || '').trim() ||
                (specificOutcome.timeline_label || '').replace(/^Исход \d+\.\s*/i, '').trim() ||
                o.title
            : (specificOutcome.timeline_label || '').replace(/^Исход \d+\.\s*/i, '').trim() || o.title;
        }
      }
      if (specificOutcome?.type === 'viable') viable = true;
      firstOutcomeStatus = status;

      timeline = [...base, { month: '', label, status, crisis: false }];
    }
    if (key === 'noChange' && crisis && timelineItems?.length) {
      const rawItems = timelineItems.filter(Boolean);
      const base = rawItems.map(mapTimelineEventToStrip);
      const crisisIdx = base.findIndex((x) => x.crisis);
      if (crisisIdx >= 0) {
        const detail = extractCrisisDetailFromLabel(rawItems[crisisIdx]?.label || '');
        if (detail) {
          base[crisisIdx] = { ...base[crisisIdx], label: detail, status: 'fail', crisis: true };
        }
      }
      timeline = [...base, { ...NO_CHANGE_WARN_STRIP }];
    }
    if (key === 'fixed') firstOutcomeStatus = 'done';
    if (key === 'noChange') firstOutcomeStatus = 'warn';
    setOutcomeData({ ...o, subtitle: sub, title: title || o.title, timeline, text, viable, firstOutcomeStatus });
    showPhase('phaseFinal');
  };

  const startSecondCrisis = () => {
    const crisis = stage4Data?.selected_crisis;
    const firstCrisisId = crisis?.crisis_id ?? crisis?.id;
    // Если firstOutcomeKey не попал в state (например, после гидрации), выводим из outcomeData
    let outcomeKeyToSend = firstOutcomeKey;
    if (!outcomeKeyToSend && outcomeData?.title) {
      const normalized = (outcomeData.title || '').trim();
      const match = Object.entries(OUTCOMES).find(([key, o]) => {
        if (!o?.title) return false;
        const oTitle = o.title.replace(/^Исход \d+\.\s*/i, '').trim();
        return oTitle === normalized || normalized.includes(oTitle) || oTitle.includes(normalized);
      });
      if (match) outcomeKeyToSend = match[0];
    }
    if (!firstCrisisId || !outcomeKeyToSend) {
      setSecondCrisisLoadError('Не удалось определить данные для следующего кризиса. Обновите страницу и пройдите этап заново.');
      return;
    }
    setSecondCrisisLoadError(null);
    setLoadingSecond(true);
    const simulexSessionId = session?.id || session?.sessionId || session?.session_id;
    fetch(`${API_URL}/stage4/second-crisis`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        case_id: caseId,
        first_crisis_id: firstCrisisId,
        first_outcome: outcomeKeyToSend,
        contract_selections: contractSelections || {},
        simulex_session_id: simulexSessionId || undefined,
        session: session || {}
      })
    })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(res.statusText || String(res.status))))
      .then((data) => {
        const scenarios = stage4Data?.crisis_scenarios || [];
        const clauses = stage4Data?.contract_clauses || [];
        const rawSecond = data.second_crisis
          ? { ...data.second_crisis }
          : stage4SelectSecondCrisis({
              firstCrisisId,
              firstOutcome: outcomeKeyToSend,
              contractClauses: clauses,
              contractSelections: contractSelections || {},
              negotiationBaseline: stage4Data?.negotiation_baseline,
              scenarios,
              session
            }) || null;
        const secondCrisisPayload = {
          ...rawSecond,
          diagnostic_questions: enrichDiagnosticQuestionsFromCrisis(rawSecond)
        };
        const firstTl = outcomeData?.timeline?.length
          ? outcomeData.timeline
          : (stage4Data?.timeline_events || []);
        const secondTl = stage4MergeSecondTimelineFromApi(
          data.second_timeline_events || [],
          secondCrisisPayload,
          firstTl
        );
        const secondDeduped = dedupeCrisisTimeline(secondTl);
        const secondFiltered =
          outcomeKeyToSend === 'fixed'
            ? stage4FilterSecondTimelineAfterFixedReturn(secondDeduped, firstTl, crisis)
            : secondDeduped;
        setSecondCrisis(secondCrisisPayload);
        setSecondTimelineEvents(secondFiltered);
        setSecondCutsceneVisible([]);
        setSecondCrisisVisible(false);
        setSecondShowNextBtn(false);
        secondCutsceneDone.current = false;
        setLoadingSecond(false);
        setSecondCrisisLoadError(null);
        showPhase('phaseSecondTimeline');
      })
      .catch((err) => {
        setLoadingSecond(false);
        setSecondCrisisLoadError(err?.message || 'Не удалось загрузить следующий кризис. Проверьте подключение и попробуйте снова.');
      });
  };

  const secondDiagnosticQuestions = useMemo(
    () => prepareDiagnosticQuestions(secondCrisis?.diagnostic_questions || []),
    [secondCrisis?.crisis_id, secondCrisis?.diagnostic_questions]
  );
  const canSubmitSecondDiagnostic = secondDiagnosticQuestions.every((q) => {
    const key = q.question_id || q.type;
    const val = secondDiagnosisAnswers[key];
    if (q.type === 'legal_basis') return Array.isArray(val) ? val.length > 0 : !!val;
    return val != null && val !== '';
  });

  const isSecondDiagnosisCorrect = () => {
    const risk = secondDiagnosisAnswers['q1-risk'] || secondDiagnosisAnswers.risk_assessment;
    const act = secondDiagnosisAnswers['q3-action'] || secondDiagnosisAnswers.immediate_action;
    const didNotUnderestimate = risk === 'significant' || risk === 'critical';
    const tookAction = act && act !== 'wait';
    return didNotUnderestimate && tookAction;
  };

  const handleSecondDiagnosticSubmit = (e) => {
    e.preventDefault();
    const actionId = secondDiagnosisAnswers['q3-action'] || secondDiagnosisAnswers.immediate_action;
    const outcome = secondCrisis?.immediate_action_outcomes?.[actionId];
    const correct =
      outcome != null
        ? outcome.type !== 'bad'
        : (actionId != null && actionId !== 'wait')
          ? true
          : isSecondDiagnosisCorrect();
    const viable = outcome?.type === 'viable';
    setSecondDiagnosisCorrect(correct);
    setSecondOutcomeViable(!!viable);
    // Запись в сессию для последующего расчёта LEXIC (второй кризис)
    if (session && typeof onSessionUpdate === 'function') {
      const nextState = {
        ...(session.stage_4_state || {}),
        diagnosis_answers_second: secondDiagnosisAnswers,
        selected_crisis_id_second: secondCrisis?.crisis_id ?? secondCrisis?.id,
      };
      onSessionUpdate({ ...session, stage_4_state: nextState });
    }
    showPhase('phaseSecondOutcome');
  };


  /** Текст и подпись исхода второго кризиса — по тем же правилам, что после первого (resolution_text / immediate_action_outcomes). Спорная (viable) → оранжевая точка. */
  const getSecondOutcomeContent = () => {
    const crisis = secondCrisis;
    if (!crisis) {
      const status = secondOutcomeViable ? 'warn' : (secondDiagnosisCorrect ? 'done' : 'fail');
      return {
        label: secondOutcomeViable ? 'Стратегия спорная, остаются риски.' : (secondDiagnosisCorrect ? 'Угроза устранена благодаря правильно выбранной мере.' : 'Угроза реализовалась.'),
        status,
        text: secondOutcomeViable ? 'Принятые меры допустимы, но риски сохраняются.' : (secondDiagnosisCorrect ? 'По итогам диагностики были приняты верные решения, угроза устранена.' : 'Принятые меры оказались неверными или недостаточными, компания несёт убытки.'),
        title: ''
      };
    }
    const actionId = secondDiagnosisAnswers['q3-action'] || secondDiagnosisAnswers.immediate_action;
    const actionOutcomes = crisis.immediate_action_outcomes || {};
    const specificOutcome = actionId && actionOutcomes[actionId] ? actionOutcomes[actionId] : null;
    let label =
      crisis.resolution_label ||
      (secondDiagnosisCorrect ? 'Угроза устранена благодаря правильно выбранной мере.' : 'Угроза реализовалась.');
    if (specificOutcome) {
      const strip = outcomeTimelineEventLabel(crisis, specificOutcome);
      if (strip) label = strip;
    }
    const status =
      specificOutcome?.type === 'bad'
        ? 'fail'
        : specificOutcome?.type === 'viable'
          ? 'warn'
          : specificOutcome?.type === 'positive'
            ? 'done'
            : (specificOutcome?.status || 'done');
    const rawText = specificOutcome?.text || (crisis.resolution_text || '');
    const text = rawText ? rawText.replace(/^Кризис не возникает\.\s*/i, '').trim() || (secondDiagnosisCorrect ? 'Угроза устранена.' : 'Угроза реализовалась.') : (secondDiagnosisCorrect ? 'Угроза устранена.' : 'Угроза реализовалась.');
    const title = (specificOutcome?.second_crisis_title || '').trim();
    return { label, status, text, title };
  };

  const setSecondDiagnosisAnswer = (questionId, type, value, isMultiple) => {
    const key = questionId || type;
    if (isMultiple) {
      setSecondDiagnosisAnswers((prev) => {
        const arr = prev[key] || [];
        const next = arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
        return { ...prev, [key]: next };
      });
    } else {
      setSecondDiagnosisAnswers((prev) => ({ ...prev, [key]: value }));
    }
  };

  useEffect(() => {
    if (!stage4Data || phase !== 'phaseCutscene' || cutsceneAwaitingClick || cutsceneDone.current) return;
    cutsceneDone.current = true;
    setCutsceneVisible(timelineDisplayCutscene.map((_, i) => i));
    setCrisisVisible(false);
    setShowNextBtn(false);
  }, [stage4Data, phase, cutsceneAwaitingClick, timelineDisplayCutscene]);

  useEffect(() => {
    if (!secondTimelineEvents.length || phase !== 'phaseSecondTimeline' || secondCutsceneDone.current) return;
    secondCutsceneDone.current = true;
    setSecondCutsceneVisible(secondTimelineEvents.map((_, i) => i));
    setSecondCrisisVisible(false);
    setSecondShowNextBtn(false);
  }, [phase, secondTimelineEvents]);

  const setDiagnosisAnswer = (questionId, type, value, isMultiple) => {
    const key = questionId || type;
    if (isMultiple) {
      setDiagnosisAnswers((prev) => {
        const arr = prev[key] || [];
        const next = arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
        return { ...prev, [key]: next };
      });
    } else {
      setDiagnosisAnswers((prev) => ({ ...prev, [key]: value }));
    }
  };

  const setContractChoice = (clauseId, variantId) => {
    setContractSelections((prev) => ({ ...prev, [clauseId]: variantId }));
  };

  useEffect(() => {
    if (phase !== 'phaseContract') return;
    const t = setInterval(() => {
      setContractTimerSec((s) => {
        if (s <= 1) {
          clearInterval(t);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (typeof onContractHudTimerSeconds !== 'function') return undefined;
    if (phase !== 'phaseContract') {
      onContractHudTimerSeconds(null);
      return undefined;
    }
    onContractHudTimerSeconds(contractTimerSec);
    return () => {
      onContractHudTimerSeconds(null);
    };
  }, [phase, contractTimerSec, onContractHudTimerSeconds]);

  /** Предыдущая фаза — чтобы не сбрасывать таймер договора при каждом обновлении `session` в той же фазе. */
  const prevPhaseForContractRef = useRef(phase);
  useEffect(() => {
    const prev = prevPhaseForContractRef.current;
    prevPhaseForContractRef.current = phase;
    if (phase !== 'phaseContract') return;

    const justEnteredContract = prev !== 'phaseContract';
    if (justEnteredContract) {
      contractTimerExpiredHandled.current = false;
      setContractTimerSec(10 * 60);
    }

    setContractSelections((prev) => {
      const next = { ...prev };
      (contractClauses || []).forEach((c) => {
        if (!c.clause_id) return;
        if (clauseOmittedFromStage4ContractScreen(c, negotiationBaseline, session)) {
          next[c.clause_id] = stage4GetCorrectTrapVariantId(c);
        } else if (next[c.clause_id] == null) {
          next[c.clause_id] = getOriginalVariantId(c);
        }
      });
      return next;
    });
    // Фиксация для LEXIC: старт редактирования — один раз при входе в фазу договора
    if (
      justEnteredContract &&
      session &&
      typeof onSessionUpdate === 'function' &&
      !contractEditStartRecorded.current
    ) {
      contractEditStartRecorded.current = true;
      const nextState = {
        ...(session.stage_4_state || {}),
        time_travel_choice: 'return',
        contract_edit_started_at: new Date().toISOString(),
      };
      onSessionUpdate({ ...session, stage_4_state: nextState });
    }
  }, [phase, contractClauses, negotiationBaseline, session, onSessionUpdate]);

  /** Исправлен ли пункт, соответствующий текущему кризису: по всем пунктам с related_crisis_type === crisisType выбран правильный вариант (correct_variant_id или один из correct_variant_ids). Остальные пункты влияют только на выбор второго кризиса. */
  const trapsFixedForThisCrisis = (clauses, selected, crisisType) => {
    const forCrisis = (clauses || []).filter((c) => c.risk_profile?.related_crisis_type === crisisType);
    if (!forCrisis.length) return true;
    for (const c of forCrisis) {
      if (clauseOmittedFromStage4ContractScreen(c, negotiationBaseline, session)) continue;
      const cid = c.clause_id;
      const chosen = (selected || {})[cid];
      const correctIds = c.correct_variant_ids;
      if (Array.isArray(correctIds) && correctIds.length > 0) {
        if (!correctIds.includes(chosen)) return false;
      } else {
        const correctId = stage4GetCorrectTrapVariantId(c);
        if (chosen !== correctId) return false;
      }
    }
    return true;
  };

  const handleContractDone = () => {
    const clauses = contractClauses || [];
    const selected = contractSelections || {};
    const crisisType = crisis?.crisis_type;
    // «Без изменений» смотрим только по видимым пунктам; скрытые (исключены на этапе 3) в выбор не входят.
    const visibleIds = visibleContractClauses.map((c) => c.clause_id).filter(Boolean);
    const noChanges =
      visibleIds.length > 0 &&
      visibleIds.every((id) => {
        const clause = clauses.find((c) => c.clause_id === id);
        const originalId = getOriginalVariantId(clause);
        return (selected[id] ?? originalId) === originalId;
      });
    // Разрешение кризиса зависит только от пункта, соответствующего этому кризису
    const thisCrisisFixed = trapsFixedForThisCrisis(clauses, selected, crisisType);
    const outcomeKey = noChanges ? 'noChange' : (thisCrisisFixed ? 'fixed' : 'repeat');
    // Фиксация в сессию для LEXIC: исход возврата, выборы по пунктам, время редактирования
    if (session && typeof onSessionUpdate === 'function') {
      const finishedByTimer = contractTimerSec === 0;
      const nextState = {
        ...(session.stage_4_state || {}),
        first_outcome_key: outcomeKey,
        time_travel_choice: 'return',
        contract_selections: selected,
        contract_edit_finished_at: new Date().toISOString(),
        contract_edit_finished_by_timer: finishedByTimer,
      };
      onSessionUpdate({ ...session, stage_4_state: nextState });
    }
    if (noChanges) {
      setFinalOutcome('noChange');
      return;
    }
    const ids = visibleIds.map((id) => selected[id]).filter(Boolean);
    setFinalOutcome(thisCrisisFixed ? 'fixed' : 'repeat', ids[0] || 'A');
  };

  // При истечении таймера на фазе договора — то же, что по нажатию «Готово»
  useEffect(() => {
    if (phase === 'phaseContract' && contractTimerSec === 0 && !contractTimerExpiredHandled.current) {
      contractTimerExpiredHandled.current = true;
      handleContractDone();
    }
  }, [phase, contractTimerSec]);

  const secondWavePhases = ['phaseSecondTimeline', 'phaseSecondDiagnostic', 'phaseSecondOutcome'];
  const inSecondWave = secondTimelineEvents.length > 0 && secondWavePhases.includes(phase);
  const replayActive = phase === 'phaseFinal' && (firstOutcomeKey === 'fixed' || firstOutcomeKey === 'repeat') && returnReplayPhase !== 'done';

  const OUTCOME_LAST_ROW_REVEAL_MS = 600;
  /** Горизонтальное «болтанье» последней точки; синхронно с `.stage4-outcome-last-wiggle` в CSS */
  const OUTCOME_WIGGLE_MS = 900;
  const OUTCOME_CARD_AFTER_WIGGLE_MS = 220;
  /** От появления последней полосы до карточки текста (болтанье + пауза) */
  const OUTCOME_ROW_TO_CARD_MS = OUTCOME_WIGGLE_MS + OUTCOME_CARD_AFTER_WIGGLE_MS;
  /** Скорость докрутки к точке разрешения (как в кат-сцене) */
  const OUTCOME_CRISIS_TO_RESOLVE_PX_PER_SEC = 220;

  useEffect(() => {
    if (phase === 'phaseDiagnostic') {
      radioOffsetDiagnosticSnapshotRef.current = radioOffsetPx;
    }
    if (phase === 'phaseSecondDiagnostic') {
      radioOffsetSecondDiagnosticSnapshotRef.current = radioOffsetPx;
    }
  }, [phase, radioOffsetPx]);

  useEffect(() => {
    if (phase !== 'phaseDiagnostic') return;
    setFirstDiagnosticContentVisible(false);
    const id = setTimeout(() => setFirstDiagnosticContentVisible(true), OUTCOME_LAST_ROW_REVEAL_MS);
    return () => clearTimeout(id);
  }, [phase, crisis?.crisis_id]);

  useEffect(() => {
    if (simulatorTourStepId === 's4-diagnostic' && phase === 'phaseDiagnostic') {
      setFirstDiagnosticContentVisible(true);
    }
  }, [simulatorTourStepId, phase]);

  useEffect(() => {
    if (phase !== 'phaseSecondDiagnostic') return;
    setSecondDiagnosticContentVisible(false);
    const id = setTimeout(() => setSecondDiagnosticContentVisible(true), OUTCOME_LAST_ROW_REVEAL_MS);
    return () => clearTimeout(id);
  }, [phase, secondCrisis?.crisis_id]);

  const makeRow = (key, strip, opts = {}) => {
    const {
      visible = true,
      blinkClass = '',
      settledClass = '',
      segmentStart = false
    } = opts;
    return {
      key,
      item: strip,
      visible,
      blinkClass,
      settledClass,
      segmentStart
    };
  };

  /** Одна полоса или (на второй волне) две отдельные — без одной длинной «ломаной» сетки. */
  const persistentTimelineModel = (() => {
    const rows = [];
    const pushRow = (key, strip, opts = {}) => {
      rows.push(makeRow(key, strip, opts));
    };

    if (inSecondWave) {
      const first = [];
      const second = [];
      const pushFirst = (key, strip, opts) => {
        first.push(makeRow(key, strip, opts));
      };
      const pushSecond = (key, strip, opts) => {
        second.push(makeRow(key, strip, opts));
      };
      /** На «Продолжении» не завязываемся на outcomeLastRowVisible: иначе последняя точка первой полосы (в т.ч. «Тут мог быть кризис») остаётся с opacity 0. */
      const firstWaveRowVisible = true;
      if (firstOutcomeKey === 'noChange') {
        if (outcomeData?.timeline?.length) {
          outcomeData.timeline.forEach((t, i) => {
            const visible = firstWaveRowVisible;
            pushFirst(`p1-${i}`, mapTimelineEventToStrip(t), { visible });
          });
        } else {
          timelineDisplayCutscene.forEach((ev, i) => {
            pushFirst(`p1-${i}`, mapTimelineEventToStrip(ev), { visible: true });
          });
          pushFirst('p1-warn', { ...NO_CHANGE_WARN_STRIP }, { visible: firstWaveRowVisible });
        }
      } else if (outcomeData?.timeline?.length) {
        // На экранах второго кризиса убираем точку-исход первого кризиса (resolution_label) —
        // на «Продолжении исполнения» виден только новый сценарий; экран успешного возврата не трогаем.
        const firstCrisis = stage4Data?.selected_crisis || {};
        const resLab = String(firstCrisis.resolution_label || '').trim();
        let tlFirst = outcomeData.timeline;
        if (firstOutcomeKey === 'fixed') {
          // Успешный возврат: в outcomeData точка кризиса уже «снята» (не crisis). На второй волне на том же слоте — «Тут мог быть кризис».
          // Индекс из исходного timelineItems (crisis: true), без привязки к конкретной подписи-заменителю.
          const rawFirst = timelineItems || [];
          const ot = outcomeData.timeline || [];
          const aligned = rawFirst.length > 0 && ot.length > 0 && rawFirst.length === ot.length;
          tlFirst = aligned
            ? ot
                .map((t, i) => {
                  const lab = String(t.label || '').trim();
                  if (resLab && lab === resLab) return null;
                  if (rawFirst[i]?.crisis) {
                    return {
                      ...t,
                      month: '',
                      label: STAGE4_COULD_HAVE_BEEN_CRISIS_LABEL,
                      status: 'done',
                      crisis: false
                    };
                  }
                  return { ...t };
                })
                .filter(Boolean)
            : ot
                .filter((t) => {
                  const lab = String(t.label || '').trim();
                  if (resLab && lab === resLab) return false;
                  return true;
                })
                .map((t) => {
                  const lab = String(t.label || '').trim();
                  if (lab === FIXED_RETURN_TIMELINE_DOT_LABEL) {
                    return {
                      ...t,
                      month: '',
                      label: STAGE4_COULD_HAVE_BEEN_CRISIS_LABEL,
                      status: 'done',
                      crisis: false
                    };
                  }
                  return t;
                });
        }
        tlFirst.forEach((t, i) => {
          const visible = firstWaveRowVisible;
          const strip = softenWarnStripFirstSegmentAfterFixed(
            mapTimelineEventToStrip(t),
            firstOutcomeKey
          );
          pushFirst(`p1-${i}`, strip, { visible });
        });
      } else {
        timelineDisplayCutscene.forEach((ev, i) => {
          pushFirst(`p1-${i}`, mapTimelineEventToStrip(ev), { visible: true });
        });
      }
      secondTimelineEvents.forEach((ev, j) => {
        const visible = phase === 'phaseSecondTimeline' ? secondCutsceneVisible.includes(j) : true;
        let disp = ev;
        if (ev.crisis) {
          const oc = phase === 'phaseSecondOutcome' && secondCrisis ? getSecondOutcomeContent() : null;
          if (oc) {
            let crisisLine = extractCrisisDetailFromLabel(ev.label || '');
            if (!crisisLine && secondCrisis) {
              const d = (secondCrisis.crisis_description || '').trim();
              if (d) crisisLine = d.split('.')[0].trim() + (d.includes('.') ? '.' : '');
            }
            if (!crisisLine) crisisLine = (ev.label || '').replace(/^Кризис\s*/i, '').trim() || 'Кризис';
            disp = {
              ...ev,
              label: crisisLine,
              status: oc.status === 'done' ? 'fail' : (oc.status === 'fail' ? 'fail' : 'warn'),
              crisis: true
            };
          } else {
            disp = timelineMaskCrisisFirstView(ev);
          }
        } else {
          disp = { ...ev };
        }
        pushSecond(`p2-${j}`, mapTimelineEventToStrip(disp), { visible });
      });
      if (phase === 'phaseSecondOutcome') {
        const oc = getSecondOutcomeContent();
        pushSecond('p2-out', { month: '', label: oc.label, status: oc.status, crisis: false }, { visible: secondOutcomeStripVisible });
      }
      // Во второй волне делаем единый горизонтальный таймлайн (snake-логика работает для flat),
      // без двух карточек/вертикального таймлайна.
      const secondWithBoundary = second.length > 0 ? [{ ...second[0], segmentStart: true }, ...second.slice(1)] : second;
      return { kind: 'flat', rows: [...first, ...secondWithBoundary] };
    }

    if (replayActive) {
      const outcomeTl = outcomeData?.timeline || [];
      const replayFullStrips = ['outcome', 'resolution', 'celebration'].includes(returnReplayPhase);
      timelineItems.forEach((item, i) => {
        const isCrisisPoint = i === crisisIndex;
        const visible = returnReplayRevealed.includes(i);
        const blinkClass = isCrisisPoint && returnReplayPhase === 'blinking'
          ? `crisis-blink crisis-blink-${returnReplayBlinkColor}`
          : '';
        const settledClass = isCrisisPoint && returnReplaySettledColor
          ? `crisis-settled crisis-settled-${returnReplaySettledColor}`
          : '';
        let src;
        if (replayFullStrips && outcomeTl[i]) {
          src = outcomeTl[i];
        } else if (returnReplayPhase === 'settled' && isCrisisPoint && outcomeTl[i]) {
          src = outcomeTl[i];
        } else {
          src = timelineMaskCrisisFirstView(item);
        }
        pushRow(`rp-${i}`, mapTimelineEventToStrip(src), { visible, blinkClass, settledClass });
      });
      const tl = outcomeData?.timeline;
      const extra = tl && tl.length > timelineItems.length ? tl[tl.length - 1] : null;
      const showConsequence = extra && ['outcome', 'resolution', 'celebration'].includes(returnReplayPhase);
      if (extra) {
        pushRow('rp-conseq', mapTimelineEventToStrip(extra), { visible: showConsequence });
      }
      return { kind: 'flat', rows };
    }

    if (phase === 'phaseFinal' && firstOutcomeKey === 'noChange') {
      if (outcomeData?.timeline?.length) {
        const n = outcomeData.timeline.length;
        outcomeData.timeline.forEach((t, i) => {
          const visible = i < n - 1 || outcomeLastRowVisible;
          pushRow(`nc-${i}`, mapTimelineEventToStrip(t), { visible });
        });
      } else {
        timelineItems.forEach((item, i) => {
          const raw = mapTimelineEventToStrip(item);
          let strip = raw;
          if (raw.crisis) {
            const detail = extractCrisisDetailFromLabel(item.label || '');
            if (detail) strip = { ...raw, label: detail, status: 'fail', crisis: true };
          }
          pushRow(`nc-${i}`, strip, { visible: true });
        });
        pushRow('nc-warn', { ...NO_CHANGE_WARN_STRIP }, { visible: outcomeLastRowVisible });
      }
      return { kind: 'flat', rows };
    }

    if (phase === 'phaseFinal' && outcomeData?.timeline?.length) {
      const n = outcomeData.timeline.length;
      const returnReplayFinished =
        (firstOutcomeKey === 'fixed' || firstOutcomeKey === 'repeat') &&
        returnReplayPhase === 'done';
      outcomeData.timeline.forEach((t, i) => {
        const visible = i < n - 1 || outcomeLastRowVisible || returnReplayFinished;
        pushRow(`fo-${i}`, mapTimelineEventToStrip(t), { visible });
      });
      return { kind: 'flat', rows };
    }

    if (phase === 'phaseContract') {
      timelineDisplayContract.forEach((item, i) => {
        pushRow(`tc-${i}`, mapTimelineEventToStrip(item), { visible: true });
      });
      return { kind: 'flat', rows };
    }

    timelineDisplayCutscene.forEach((item, i) => {
      const visible = phase === 'phaseCutscene' ? cutsceneVisible.includes(i) : true;
      pushRow(`t-${i}`, mapTimelineEventToStrip(item), { visible });
    });
    return { kind: 'flat', rows };
  })();

  const persistentTimelineRowCount =
    persistentTimelineModel.kind === 'flat'
      ? persistentTimelineModel.rows.length
      : persistentTimelineModel.first.length + persistentTimelineModel.second.length;

  const showPersistentTimeline =
    phase !== 'phaseIntro' && !loadError && persistentTimelineRowCount > 0;
  const contractTimeTravelVisual = phase === 'phaseContract';

  const flatTimelineRowKey =
    persistentTimelineModel.kind === 'flat'
      ? persistentTimelineModel.rows.map((r) => r.key).join('|')
      : '';
  const flatRows =
    persistentTimelineModel.kind === 'flat'
      ? persistentTimelineModel.rows
      : [];
  const flatRowCount = flatRows.length;
  const radioDialLineWidthPx = radioSidePadPx * 2 + Math.max(0, flatRowCount * radioStepPx);
  const firstCrisisRadioIdx = useMemo(
    () => flatRows.findIndex((r) => r?.item?.crisis),
    [flatTimelineRowKey]
  );
  const secondCrisisRadioIdx = useMemo(
    () => flatRows.findIndex((r) => String(r?.key || '').startsWith('p2-') && r?.item?.crisis),
    [flatTimelineRowKey]
  );

  /** Второй кризис — разрешение: как при accept на phaseFinal, докрутка иглы к последней полосе, болтанье, затем карточка. */
  useEffect(() => {
    const clearSecondTimers = () => {
      secondOutcomeRevealTimersRef.current.forEach((id) => clearTimeout(id));
      secondOutcomeRevealTimersRef.current = [];
    };
    clearSecondTimers();
    if (phase !== 'phaseSecondOutcome') {
      return undefined;
    }
    setSecondOutcomeStripVisible(false);
    setSecondOutcomeResolutionCardVisible(false);

    const needScroll =
      secondCrisisRadioIdx >= 0 &&
      flatRowCount >= 2 &&
      secondCrisisRadioIdx < flatRowCount - 1 &&
      radioMaxOffsetPx > 0;

    const scheduleCard = () => {
      const idCard = setTimeout(() => {
        setSecondOutcomeResolutionCardVisible(true);
      }, OUTCOME_ROW_TO_CARD_MS);
      secondOutcomeRevealTimersRef.current.push(idCard);
    };

    if (!needScroll) {
      setSecondOutcomeStripVisible(true);
      scheduleCard();
      return () => {
        clearSecondTimers();
      };
    }

    radioUserInteractedRef.current = false;
    if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);

    const fallbackOffset = Math.max(
      radioMinOffsetPx,
      Math.min(secondCrisisRadioIdx * radioStepPx, radioMaxOffsetPx)
    );
    const snap = radioOffsetSecondDiagnosticSnapshotRef.current;
    const startOffset = Math.max(
      radioMinOffsetPx,
      Math.min(
        typeof snap === 'number' && !Number.isNaN(snap) ? snap : fallbackOffset,
        radioMaxOffsetPx
      )
    );
    const targetOffset = radioMaxOffsetPx;
    setRadioOffsetPx(startOffset);

    const distance = targetOffset - startOffset;
    if (Math.abs(distance) < 0.5) {
      setRadioOffsetPx(targetOffset);
      setSecondOutcomeStripVisible(true);
      scheduleCard();
      return () => clearSecondTimers();
    }

    let durationMs = Math.round((Math.abs(distance) / OUTCOME_CRISIS_TO_RESOLVE_PX_PER_SEC) * 1000);
    durationMs = Math.max(400, Math.min(4200, durationMs));
    const startedAt = performance.now();
    const tick = (now) => {
      if (radioUserInteractedRef.current) return;
      const rawT = Math.min(1, (now - startedAt) / durationMs);
      const t = stage4RadioEaseOutCubic(rawT);
      setRadioOffsetPx(startOffset + distance * t);
      if (rawT < 1) {
        radioAutoRafRef.current = requestAnimationFrame(tick);
      } else {
        setRadioOffsetPx(targetOffset);
        radioAutoRafRef.current = null;
        setSecondOutcomeStripVisible(true);
        scheduleCard();
      }
    };
    radioAutoRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);
      radioAutoRafRef.current = null;
      clearSecondTimers();
    };
  }, [
    phase,
    secondCrisisRadioIdx,
    flatRowCount,
    flatTimelineRowKey,
    radioMinOffsetPx,
    radioMaxOffsetPx,
    radioStepPx,
    secondCrisis?.crisis_id
  ]);

  /** Разрешение: докрутка от положения ленты на диагностике до центра точки разрешения, болтанье, затем текст исхода. */
  useEffect(() => {
    const clearOutcomeRevealTimers = () => {
      outcomeRevealAfterScrollTimeoutsRef.current.forEach((id) => clearTimeout(id));
      outcomeRevealAfterScrollTimeoutsRef.current = [];
    };
    clearOutcomeRevealTimers();

    if (phase !== 'phaseFinal' || replayActive) {
      return undefined;
    }
    const tl = outcomeData?.timeline;
    const afterReturnReplay = firstOutcomeKey === 'fixed' || firstOutcomeKey === 'repeat';
    if (afterReturnReplay) {
      setOutcomeLastRowVisible(true);
      setOutcomeResolutionCardVisible(true);
      return undefined;
    }
    setOutcomeLastRowVisible(false);
    setOutcomeResolutionCardVisible(false);
    if (!tl?.length) {
      const idCard = setTimeout(
        () => setOutcomeResolutionCardVisible(true),
        OUTCOME_LAST_ROW_REVEAL_MS + OUTCOME_ROW_TO_CARD_MS
      );
      outcomeRevealAfterScrollTimeoutsRef.current.push(idCard);
      return () => clearTimeout(idCard);
    }

    const needsCrisisToResolutionScroll =
      firstOutcomeKey === 'accept' &&
      firstCrisisRadioIdx >= 0 &&
      flatRowCount >= 2 &&
      firstCrisisRadioIdx < flatRowCount - 1 &&
      radioMaxOffsetPx > 0;

    if (!needsCrisisToResolutionScroll) {
      setOutcomeLastRowVisible(true);
      const idCard = setTimeout(
        () => setOutcomeResolutionCardVisible(true),
        OUTCOME_ROW_TO_CARD_MS
      );
      outcomeRevealAfterScrollTimeoutsRef.current.push(idCard);
      return () => clearTimeout(idCard);
    }

    radioUserInteractedRef.current = false;
    if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);

    const fallbackOffset = Math.max(
      radioMinOffsetPx,
      Math.min(firstCrisisRadioIdx * radioStepPx, radioMaxOffsetPx)
    );
    const snap = radioOffsetDiagnosticSnapshotRef.current;
    const startOffset = Math.max(
      radioMinOffsetPx,
      Math.min(
        typeof snap === 'number' && !Number.isNaN(snap) ? snap : fallbackOffset,
        radioMaxOffsetPx
      )
    );
    const targetOffset = radioMaxOffsetPx;
    setRadioOffsetPx(startOffset);

    const distance = targetOffset - startOffset;
    if (Math.abs(distance) < 0.5) {
      setOutcomeLastRowVisible(true);
      const idCard = setTimeout(
        () => setOutcomeResolutionCardVisible(true),
        OUTCOME_ROW_TO_CARD_MS
      );
      outcomeRevealAfterScrollTimeoutsRef.current.push(idCard);
      return () => clearTimeout(idCard);
    }

    let durationMs = Math.round((Math.abs(distance) / OUTCOME_CRISIS_TO_RESOLVE_PX_PER_SEC) * 1000);
    durationMs = Math.max(400, Math.min(4200, durationMs));

    const startedAt = performance.now();
    const tick = (now) => {
      if (radioUserInteractedRef.current) return;
      const rawT = Math.min(1, (now - startedAt) / durationMs);
      const t = stage4RadioEaseOutCubic(rawT);
      setRadioOffsetPx(startOffset + distance * t);
      if (rawT < 1) {
        radioAutoRafRef.current = requestAnimationFrame(tick);
      } else {
        setRadioOffsetPx(targetOffset);
        radioAutoRafRef.current = null;
        setOutcomeLastRowVisible(true);
        const idCard = setTimeout(
          () => setOutcomeResolutionCardVisible(true),
          OUTCOME_ROW_TO_CARD_MS
        );
        outcomeRevealAfterScrollTimeoutsRef.current.push(idCard);
      }
    };
    radioAutoRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);
      radioAutoRafRef.current = null;
      clearOutcomeRevealTimers();
    };
  }, [
    phase,
    replayActive,
    outcomeData?.timeline,
    firstOutcomeKey,
    firstCrisisRadioIdx,
    flatRowCount,
    flatTimelineRowKey,
    radioMinOffsetPx,
    radioMaxOffsetPx,
    radioStepPx
  ]);

  useLayoutEffect(() => {
    if (!showPersistentTimeline || persistentTimelineModel.kind !== 'flat') return;
    const shell = resolveVisibleStage4RadioShell(radioTimelineRef);
    if (!shell) return;
    const headEl = shell.querySelector('.stage4-radio-head');
    const shellWidth = headEl?.clientWidth || shell.clientWidth;
    if (!shellWidth) return;

    const { step, pad, minOffset, maxOffset } = computeStage4RadioBounds(shellWidth, flatRowCount);
    setRadioStepPx(step);
    setRadioSidePadPx(pad);
    setRadioMinOffsetPx(minOffset);
    setRadioMaxOffsetPx(maxOffset);

    const returnReplayFinished =
      (firstOutcomeKey === 'fixed' || firstOutcomeKey === 'repeat') &&
      returnReplayPhase === 'done';
    const shouldCenterLast =
      (outcomeData?.timeline?.length || 0) > 0 &&
      ((replayActive &&
        ['outcome', 'resolution', 'celebration'].includes(returnReplayPhase)) ||
        (!replayActive && (outcomeLastRowVisible || returnReplayFinished)));

    const secondShouldCenterLast =
      phase === 'phaseSecondOutcome' &&
      secondOutcomeStripVisible &&
      !secondOutcomeResolutionCardVisible;

    if (phase !== 'phaseFinal') {
      prevShouldCenterLastGateRef.current = false;
    } else if (shouldCenterLast && !prevShouldCenterLastGateRef.current) {
      radioUserInteractedRef.current = false;
    }
    if (phase === 'phaseFinal') {
      prevShouldCenterLastGateRef.current = shouldCenterLast;
    }

    if (phase !== 'phaseSecondOutcome') {
      prevSecondOutcomeCenterGateRef.current = false;
    } else if (secondShouldCenterLast && !prevSecondOutcomeCenterGateRef.current) {
      radioUserInteractedRef.current = false;
    }
    if (phase === 'phaseSecondOutcome') {
      prevSecondOutcomeCenterGateRef.current = secondShouldCenterLast;
    }

    const applyClamp = (prev) => Math.max(minOffset, Math.min(prev, maxOffset));

    if (
      ((phase === 'phaseFinal' && shouldCenterLast) ||
        (phase === 'phaseSecondOutcome' && secondShouldCenterLast)) &&
      flatRowCount >= 2 &&
      !radioUserInteractedRef.current
    ) {
      const lastEl = shell.querySelector(`[data-timeline-idx="${flatRowCount - 1}"]`);
      if (lastEl) {
        const needleEl = shell.querySelector('.stage4-radio-needle');
        const needleRect = needleEl?.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        const needleX = needleRect
          ? needleRect.left + needleRect.width / 2
          : shellRect.left + shellRect.width / 2;
        const lastRect = lastEl.getBoundingClientRect();
        const lastCenterX = lastRect.left + lastRect.width / 2;
        const delta = lastCenterX - needleX;
        if (Math.abs(delta) >= 1) {
          setRadioOffsetPx((prev) => applyClamp(prev + delta));
          const lastIdx = flatRowCount - 1;
          requestAnimationFrame(() => {
            if (radioUserInteractedRef.current) return;
            const sh = resolveVisibleStage4RadioShell(radioTimelineRef);
            if (!sh) return;
            const head2 = sh.querySelector('.stage4-radio-head');
            const sw = head2?.clientWidth || sh.clientWidth;
            const le2 = sh.querySelector(`[data-timeline-idx="${lastIdx}"]`);
            if (!le2) return;
            const { minOffset: min2, maxOffset: max2 } = computeStage4RadioBounds(sw, lastIdx + 1);
            const ne2 = sh.querySelector('.stage4-radio-needle');
            const nr = ne2?.getBoundingClientRect();
            const sr = sh.getBoundingClientRect();
            const nx = nr ? nr.left + nr.width / 2 : sr.left + sr.width / 2;
            const lr = le2.getBoundingClientRect();
            const lx = lr.left + lr.width / 2;
            const d2 = lx - nx;
            if (Math.abs(d2) >= 1) {
              setRadioOffsetPx((prev) => Math.max(min2, Math.min(prev + d2, max2)));
            }
          });
          return;
        }
      }
    }

    setRadioOffsetPx((prev) => applyClamp(prev));
  }, [
    showPersistentTimeline,
    persistentTimelineModel.kind,
    flatTimelineRowKey,
    flatRowCount,
    phase,
    replayActive,
    returnReplayPhase,
    outcomeLastRowVisible,
    firstOutcomeKey,
    outcomeData?.timeline?.length,
    secondOutcomeStripVisible,
    secondOutcomeResolutionCardVisible
  ]);

  useEffect(() => {
    const onResize = () => {
      const shell = resolveVisibleStage4RadioShell(radioTimelineRef);
      if (!shell) return;
      const headEl = shell.querySelector('.stage4-radio-head');
      const shellWidth = headEl?.clientWidth || shell.clientWidth;
      if (!shellWidth) return;
      const { step, pad, minOffset, maxOffset } = computeStage4RadioBounds(shellWidth, flatRowCount);
      setRadioStepPx(step);
      setRadioSidePadPx(pad);
      setRadioMinOffsetPx(minOffset);
      setRadioMaxOffsetPx(maxOffset);
      setRadioOffsetPx((prev) => Math.max(minOffset, Math.min(prev, maxOffset)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [flatRowCount]);

  useEffect(() => {
    if (!showPersistentTimeline || persistentTimelineModel.kind !== 'flat') return;
    // Активная точка — ближайшая к центру-игле.
    const bounded = Math.max(
      0,
      Math.min(Math.round((radioOffsetPx + 0.0001) / radioStepPx), flatRowCount - 1)
    );
    setRadioActiveIdx(bounded);
  }, [showPersistentTimeline, persistentTimelineModel.kind, flatTimelineRowKey, radioOffsetPx, flatRowCount, radioStepPx]);

  useLayoutEffect(() => {
    radioOffsetRef.current = radioOffsetPx;
  }, [radioOffsetPx]);

  useEffect(() => {
    if (!showPersistentTimeline || persistentTimelineModel.kind !== 'flat') return;
    const forward = phase === 'phaseCutscene' || phase === 'phaseSecondTimeline';
    const rewind = phase === 'phaseContract';
    if (!forward && !rewind) return;
    if (phase === 'phaseCutscene' && cutsceneAwaitingClick) return;
    if (!flatRowCount) return;

    radioUserInteractedRef.current = false;
    if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);

    const rows = persistentTimelineModel.rows || [];
    const rowMatcher = (r) => {
      const label = String(r?.item?.label || '').trim().toLowerCase();
      if (r?.item?.crisis) return true;
      if (label === 'кризис' || label.startsWith('кризис ')) return true;
      if (r?.item?.status === 'fail') return true;
      return false;
    };

    let startOffset;
    let target;

    if (rewind) {
      startOffset = Math.max(radioMinOffsetPx, Math.min(radioOffsetRef.current, radioMaxOffsetPx));
      target = Math.max(
        radioMinOffsetPx,
        Math.min(STAGE4_RADIO_OFFSET_COLUMN0_CENTERED, radioMaxOffsetPx)
      );
    } else {
      let targetIdx = rows.findIndex(rowMatcher);
      if (phase === 'phaseSecondTimeline') {
        const fromSecondWave = rows.findIndex((r) => String(r?.key || '').startsWith('p2-') && rowMatcher(r));
        if (fromSecondWave >= 0) targetIdx = fromSecondWave;
      }
      if (targetIdx < 0 && rows.length) targetIdx = rows.length - 1;
      if (targetIdx < 0) return;
      startOffset = radioMinOffsetPx;
      target = Math.max(radioMinOffsetPx, Math.min(targetIdx * radioStepPx, radioMaxOffsetPx));
    }

    const distance = target - startOffset;
    const absDist = Math.abs(distance);
    if (absDist < 0.5) {
      setRadioOffsetPx(target);
      return;
    }

    setRadioOffsetPx(startOffset);
    const speedPxPerSec = rewind ? 200 : 220;
    let durationMs = Math.round((absDist / speedPxPerSec) * 1000);
    const minDur = 260;
    const maxDur = 4200;
    durationMs = Math.max(minDur, Math.min(maxDur, durationMs));

    const startedAt = performance.now();
    const tick = (now) => {
      if (radioUserInteractedRef.current) return;
      const rawT = Math.min(1, (now - startedAt) / durationMs);
      const t = stage4RadioEaseOutCubic(rawT);
      setRadioOffsetPx(startOffset + distance * t);
      if (rawT < 1) {
        radioAutoRafRef.current = requestAnimationFrame(tick);
      } else {
        setRadioOffsetPx(target);
        radioAutoRafRef.current = null;
      }
    };
    radioAutoRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);
      radioAutoRafRef.current = null;
    };
  }, [phase, cutsceneAwaitingClick, showPersistentTimeline, persistentTimelineModel.kind, flatTimelineRowKey, flatRowCount, radioStepPx, radioMinOffsetPx, radioMaxOffsetPx]);

  /** После возврата в договор: лента «крутится» к точке кризиса с той же длительностью, что пошаговое появление точек (не только visibility без сдвига). */
  useEffect(() => {
    if (!showPersistentTimeline || persistentTimelineModel.kind !== 'flat') return;
    if (phase !== 'phaseFinal' || !replayActive) return;
    if (returnReplayPhase !== 'timeline') return;
    if (!flatRowCount) return;

    radioUserInteractedRef.current = false;
    if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);

    const startOffset = radioMinOffsetPx;
    const target = Math.max(
      radioMinOffsetPx,
      Math.min(crisisIndex * radioStepPx, radioMaxOffsetPx)
    );
    const distance = target - startOffset;
    if (Math.abs(distance) < 0.5) {
      setRadioOffsetPx(target);
      return;
    }

    const delayMs = 500;
    const stepMs = 550;
    const durationMs = delayMs + crisisIndex * stepMs;

    setRadioOffsetPx(startOffset);
    const startedAt = performance.now();

    const tick = (now) => {
      if (radioUserInteractedRef.current) return;
      const elapsed = now - startedAt;
      const rawT = Math.min(1, elapsed / durationMs);
      setRadioOffsetPx(startOffset + distance * rawT);
      if (rawT < 1) {
        radioAutoRafRef.current = requestAnimationFrame(tick);
      } else {
        setRadioOffsetPx(target);
        radioAutoRafRef.current = null;
      }
    };
    radioAutoRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);
      radioAutoRafRef.current = null;
    };
  }, [
    phase,
    replayActive,
    returnReplayPhase,
    showPersistentTimeline,
    persistentTimelineModel.kind,
    flatTimelineRowKey,
    flatRowCount,
    crisisIndex,
    radioStepPx,
    radioMinOffsetPx,
    radioMaxOffsetPx
  ]);

  useEffect(() => {
    if (phase !== 'phaseCutscene') return;
    const reached = firstCrisisRadioIdx >= 0 && radioActiveIdx >= firstCrisisRadioIdx;
    setCrisisVisible(!!reached);
    setShowNextBtn(!!reached);
  }, [phase, radioActiveIdx, firstCrisisRadioIdx]);

  useEffect(() => {
    if (phase !== 'phaseSecondTimeline') return;
    const reached = secondCrisisRadioIdx >= 0 && radioActiveIdx >= secondCrisisRadioIdx;
    setSecondCrisisVisible(!!reached);
    setSecondShowNextBtn(!!reached);
  }, [phase, radioActiveIdx, secondCrisisRadioIdx]);

  useEffect(() => {
    const dropDrag = () => {
      radioDragRef.current.active = false;
    };
    window.addEventListener('mouseup', dropDrag);
    return () => window.removeEventListener('mouseup', dropDrag);
  }, []);

  const getPersistentTimelineCaption = () => {
    if (inSecondWave) {
      if (phase === 'phaseSecondOutcome') return 'Итог этапа';
      return 'Продолжение исполнения';
    }
    if (phase === 'phaseFinal' && outcomeData?.subtitle) return outcomeData.subtitle;
    return 'Исполнение договора';
  };

  const renderPersistentTimelineBlock = (options = {}) => {
    const { withTourHighlight = false } = options;
    if (!showPersistentTimeline) return null;

    const isSingleFlatRow = persistentTimelineModel.kind === 'flat' && persistentTimelineModel.rows.length <= 1;
    const gridInnerClass = `timeline timeline-main-horizontal stage4-persistent-timeline-inner stage4-timeline-persistent stage4-persistent-timeline-inner--grid ${isSingleFlatRow ? 'stage4-persistent-timeline-inner--single' : ''}${replayActive ? ' stage4-return-timeline' : ''}${contractTimeTravelVisual ? ' stage4-timeline-timetravel' : ''}`;

    const renderRow = (r, idx, cellProps = {}) => {
      const { item } = r;
      const { style: cellStyle, withRadioCell = false, wiggleOutcome = false } = cellProps;
      return (
        <div
          key={r.key}
          style={cellStyle}
          className={`timeline-main-horizontal-item ${item.status} ${item.crisis ? 'crisis' : ''} ${r.visible ? 'visible' : ''} ${idx === radioActiveIdx ? 'active' : ''} ${withRadioCell ? 'stage4-radio-item' : ''} ${wiggleOutcome ? 'stage4-outcome-last-wiggle' : ''} ${item.timelineFiller ? 'stage4-timeline-filler' : ''} ${item.signingPrep ? 'stage4-timeline-signing-prep' : ''} ${r.blinkClass || ''} ${r.settledClass || ''} ${r.segmentStart ? 'stage4-timeline-second-segment-start' : ''}`}
          data-status={item.status}
          data-timeline-idx={idx}
        >
          <span className="timeline-horizontal-dot" />
          <div className="stage4-radio-event-card">
            {item.month ? (
              <span className="timeline-main-horizontal-date">{formatTimelineDate(item.month, timelineAnchorDate)}</span>
            ) : null}
            <span className="timeline-main-horizontal-label">{item.label}</span>
          </div>
        </div>
      );
    };

    const renderVerticalRow = (r) => {
      const { item } = r;
      return (
        <div
          key={r.key}
          className={`stage4-timeline-vertical-step ${item.status} ${item.crisis ? 'crisis' : ''} ${r.visible ? 'visible' : ''} ${item.timelineFiller ? 'stage4-timeline-filler' : ''} ${item.signingPrep ? 'stage4-timeline-signing-prep' : ''} ${r.blinkClass || ''} ${r.settledClass || ''}`}
          data-status={item.status}
        >
          <div className="stage4-timeline-vertical-stack">
            <div className="stage4-timeline-vertical-marker">
              <span className="timeline-horizontal-dot" aria-hidden />
            </div>
            {item.month ? (
              <span className="stage4-timeline-vertical-date">{formatTimelineDate(item.month, timelineAnchorDate)}</span>
            ) : null}
            <span className="stage4-timeline-vertical-text">{item.label}</span>
          </div>
        </div>
      );
    };

    return (
      <div
        {...(withTourHighlight ? { 'data-tutor-highlight': 'stage4_timeline_wrap' } : {})}
        className={`stage4-persistent-timeline-wrap${contractTimeTravelVisual ? ' stage4-persistent-timeline-wrap--timetravel' : ''}`}
        aria-label={
          contractTimeTravelVisual
            ? 'Возможное будущее исполнения (ещё не произошло)'
            : 'Таймлайн исполнения договора'
        }
      >
        {contractTimeTravelVisual && (
          <p className="stage4-persistent-timeline-caption-hint">
            Возврат во времени: вы до кризиса — показанные события ещё не свершились.
          </p>
        )}
        <p className="stage4-persistent-timeline-caption">{getPersistentTimelineCaption()}</p>
        {persistentTimelineModel.kind === 'split' ? (
          <div className="stage4-timeline-split">
            <div className="stage4-timeline-segment stage4-timeline-segment--first">
              <p className="stage4-timeline-segment-label">После первого кризиса</p>
              <div className={gridInnerClass}>
                {persistentTimelineModel.first.map((r, idx) => renderRow(r, idx))}
              </div>
            </div>
            <div className="stage4-timeline-segment-gap" role="presentation" aria-hidden />
            <div className="stage4-timeline-segment stage4-timeline-segment--second">
              <p className="stage4-timeline-segment-label">Дальнейшее исполнение</p>
              <div className={gridInnerClass}>
                {persistentTimelineModel.second.map((r, idx) => renderRow(r, idx))}
              </div>
            </div>
          </div>
        ) : (
          <div
            className="stage4-radio-shell"
            ref={setRadioTimelineEl}
            onMouseDown={(e) => {
              radioUserInteractedRef.current = true;
              if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);
              radioDragRef.current = { active: true, startX: e.clientX, startOffset: radioOffsetPx };
            }}
            onMouseMove={(e) => {
              if (!radioDragRef.current.active) return;
              const raw = radioDragRef.current.startOffset - (e.clientX - radioDragRef.current.startX);
              setRadioOffsetPx(Math.max(radioMinOffsetPx, Math.min(raw, radioMaxOffsetPx)));
            }}
            onMouseUp={() => {
              radioDragRef.current.active = false;
            }}
            onMouseLeave={() => {
              radioDragRef.current.active = false;
            }}
            onWheel={(e) => {
              radioUserInteractedRef.current = true;
              if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);
              const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
              const next = radioOffsetPx + delta;
              setRadioOffsetPx(Math.max(radioMinOffsetPx, Math.min(next, radioMaxOffsetPx)));
            }}
            onTouchStart={(e) => {
              const x = e.touches?.[0]?.clientX;
              if (typeof x !== 'number') return;
              radioUserInteractedRef.current = true;
              if (radioAutoRafRef.current) cancelAnimationFrame(radioAutoRafRef.current);
              radioDragRef.current = { active: true, startX: x, startOffset: radioOffsetPx };
            }}
            onTouchMove={(e) => {
              if (!radioDragRef.current.active) return;
              const x = e.touches?.[0]?.clientX;
              if (typeof x !== 'number') return;
              const raw = radioDragRef.current.startOffset - (x - radioDragRef.current.startX);
              setRadioOffsetPx(Math.max(radioMinOffsetPx, Math.min(raw, radioMaxOffsetPx)));
            }}
            onTouchEnd={() => {
              radioDragRef.current.active = false;
            }}
          >
            <div className="stage4-radio-head">
              <div className="stage4-radio-needle" aria-hidden />
              <div className="stage4-radio-track" style={{ transform: `translate3d(${-radioOffsetPx}px, 0, 0)` }}>
                <div className="stage4-radio-dial-line" style={{ width: `${radioDialLineWidthPx}px` }} />
                <div className="stage4-radio-spacer" style={{ width: `${radioSidePadPx}px` }} />
                <div className={gridInnerClass}>
                  {flatRows.map((r, idx) =>
                    renderRow(r, idx, {
                      withRadioCell: true,
                      wiggleOutcome:
                        flatRows.length > 0 &&
                        idx === flatRows.length - 1 &&
                        ((phase === 'phaseFinal' &&
                          !replayActive &&
                          outcomeLastRowVisible &&
                          !outcomeResolutionCardVisible) ||
                          (phase === 'phaseSecondOutcome' &&
                            secondOutcomeStripVisible &&
                            !secondOutcomeResolutionCardVisible))
                    })
                  )}
                </div>
                <div className="stage4-radio-spacer" style={{ width: `${radioSidePadPx}px` }} />
              </div>
            </div>
            <div
              className={`stage4-radio-detail${flatRows[radioActiveIdx]?.item?.crisis ? ' stage4-radio-detail--crisis-active' : ''}`}
            >
              {flatRows[radioActiveIdx]?.item?.month ? (
                <p className="stage4-radio-detail-month">
                  {formatTimelineDate(flatRows[radioActiveIdx].item.month, timelineAnchorDate)}
                </p>
              ) : null}
              <p className="stage4-radio-detail-text">{flatRows[radioActiveIdx]?.item?.label || ''}</p>
            </div>
          </div>
        )}
      </div>
    );
  };

  useEffect(() => {
    const sid = session?.id || session?.session_id || session?.sessionId;
    if (!sid || simulatorTourStepId || loading || loadError || !stage4Data || !s4DraftHydrated) return;
    writeStageDraft(sid, 4, {
      version: 1,
      savedAt: Date.now(),
      caseId: stage4CaseIdForDraft,
      phase,
      cutsceneAwaitingClick,
      cutsceneVisible,
      outcomeLastRowVisible,
      outcomeResolutionCardVisible,
      secondOutcomeStripVisible,
      secondOutcomeResolutionCardVisible,
      firstDiagnosticContentVisible,
      secondDiagnosticContentVisible,
      crisisVisible,
      showNextBtn,
      diagnosisAnswers,
      outcomeData,
      contractSelections,
      contractTimerSec,
      docImageError,
      firstOutcomeKey,
      secondCrisis,
      secondTimelineEvents,
      secondCutsceneVisible,
      secondCrisisVisible,
      secondShowNextBtn,
      secondDiagnosisAnswers,
      secondDiagnosisCorrect,
      secondOutcomeViable,
      secondOutcomeData,
      loadingSecond,
      secondCrisisLoadError,
      radioActiveIdx,
      radioOffsetPx,
      radioSidePadPx,
      radioStepPx,
      radioMinOffsetPx,
      radioMaxOffsetPx,
      outcomeKey,
      returnReplayRevealed,
      returnReplayPhase,
      returnReplayBlinkColor,
      returnReplaySettledColor,
      showConfetti,
      showDocBrown,
      docBrownAtCenter,
      docBrownGreeting,
      cutsceneDone: cutsceneDone.current,
      secondCutsceneDone: secondCutsceneDone.current,
      contractEditStartRecorded: contractEditStartRecorded.current,
      returnReplayStarted: returnReplayStartedRef.current,
    });
  }, [
    simulatorTourStepId,
    session?.id,
    session?.session_id,
    session?.sessionId,
    loading,
    loadError,
    stage4Data,
    s4DraftHydrated,
    stage4CaseIdForDraft,
    phase,
    cutsceneAwaitingClick,
    cutsceneVisible,
    outcomeLastRowVisible,
    outcomeResolutionCardVisible,
    secondOutcomeStripVisible,
    secondOutcomeResolutionCardVisible,
    firstDiagnosticContentVisible,
    secondDiagnosticContentVisible,
    crisisVisible,
    showNextBtn,
    diagnosisAnswers,
    outcomeData,
    contractSelections,
    contractTimerSec,
    docImageError,
    firstOutcomeKey,
    secondCrisis,
    secondTimelineEvents,
    secondCutsceneVisible,
    secondCrisisVisible,
    secondShowNextBtn,
    secondDiagnosisAnswers,
    secondDiagnosisCorrect,
    secondOutcomeViable,
    secondOutcomeData,
    loadingSecond,
    secondCrisisLoadError,
    radioActiveIdx,
    radioOffsetPx,
    radioSidePadPx,
    radioStepPx,
    radioMinOffsetPx,
    radioMaxOffsetPx,
    outcomeKey,
    returnReplayRevealed,
    returnReplayPhase,
    returnReplayBlinkColor,
    returnReplaySettledColor,
    showConfetti,
    showDocBrown,
    docBrownAtCenter,
    docBrownGreeting,
  ]);

  if (loadError) {
    return (
      <div className="stage4-app">
        <div className="stage4-container">
          <h1>Этап 4: Кризис</h1>
          <p className="subtitle" style={{ color: 'var(--stage4-failure)' }}>{loadError}</p>
          <button type="button" className="btn-next" onClick={() => window.location.reload()}>Повторить</button>
        </div>
        <div className="stage4-complete-dock">
          <button
            type="button"
            className="stage4-complete-btn"
            onClick={onCompleteStage}
            disabled={stageCompleteInFlight}
            aria-busy={stageCompleteInFlight}
          >
            {stageCompleteInFlight ? 'Сохранение и переход…' : 'Завершить этап'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stage4-app">
      <div className="stage4-container">
        {/* Пустой экран до закрытия входящего письма этапа (модалка в GameView, кнопка «Закрыть») */}
        <section
          id="phaseIntro"
          className={`phase ${phase === 'phaseIntro' ? 'active' : ''}`}
          aria-hidden={phase !== 'phaseIntro'}
        >
          <div className="stage4-intro-blank" data-tutor-highlight="stage4_intro_area" />
        </section>

        {/* Фаза 1: Кат-сцена — заголовок = договор; подпись над таймлайном = «Исполнение договора» */}
        <section
          id="phaseCutscene"
          className={`phase ${phase === 'phaseCutscene' ? 'active' : ''}`}
          onClick={cutsceneAwaitingClick ? () => setCutsceneAwaitingClick(false) : undefined}
          style={cutsceneAwaitingClick ? { cursor: 'pointer' } : undefined}
        >
          {cutsceneAwaitingClick && (
            <div
              className="cutscene-click-hint"
              role="status"
              aria-live="polite"
              data-stage4-cutscene-hint="1"
            >
              <span className="cutscene-click-hint__text">{STAGE4_CUTSCENE_CLICK_HINT}</span>
            </div>
          )}
          <h1>{contractTitleShort}</h1>
          {renderPersistentTimelineBlock({ withTourHighlight: true })}
          {loading && !stage4Data && (
            <p className="subtitle" style={{ marginBottom: '1rem' }}>Загрузка таймлайна...</p>
          )}
          {loadError && <p className="subtitle" style={{ color: 'var(--stage4-failure, #c00)', marginBottom: '1rem' }}>{loadError}</p>}
          <div className={`timeline-pause ${crisisVisible ? 'visible' : ''}`}>
            {crisisDescription}
          </div>
          {showNextBtn && (
            <p style={{ marginTop: '1.5rem' }}>
              <button type="button" className="btn-next" onClick={() => showPhase('phaseDiagnostic')}>
                Далее
              </button>
            </p>
          )}
        </section>

        {/* Фаза 2: Диагностика кризиса */}
        <section id="phaseDiagnostic" className={`phase ${phase === 'phaseDiagnostic' ? 'active' : ''}`}>
          <h1>Диагностика кризиса</h1>
          {renderPersistentTimelineBlock()}
          <div
            className={`stage4-diagnostic-reveal-wrap stage4-outcome-reveal ${
              firstDiagnosticContentVisible ? 'visible' : ''
            }`}
          >
            <div className="stage4-diagnostic-situation">
              <p className="stage4-diagnostic-situation-label">Оцените ситуацию</p>
              <p className="stage4-diagnostic-situation-text">{crisisDescription}</p>
            </div>
          <form className="diagnostic-block" data-tutor-highlight="stage4_diagnostic_form" onSubmit={handleDiagnosticSubmit}>
            {diagnosticQuestions.map((q) => {
              const key = q.question_id || q.type;
              const value = diagnosisAnswers[key];
              const options = q.options || [];
              const isMultiple = q.type === 'legal_basis';
              return (
                <div key={key} className="diagnostic-q">
                  <h3>{q.text}</h3>
                    <div className="diagnostic-options">
                  {options.map((opt) => {
                    const optId = opt.id || opt.value || opt.text;
                    const optText = opt.text || opt.label || optId;
                    const checked = isMultiple ? (Array.isArray(value) && value.includes(optId)) : value === optId;
                    return (
                          <label key={optId} className={checked ? 'diagnostic-option selected' : 'diagnostic-option'}>
                        <input
                          type={isMultiple ? 'checkbox' : 'radio'}
                          name={key}
                          value={optId}
                          checked={!!checked}
                          onChange={() => setDiagnosisAnswer(key, q.type, optId, isMultiple)}
                        />
                            <span className="diagnostic-option-text">{optText}</span>
                      </label>
                    );
                  })}
                    </div>
                </div>
              );
            })}
            <button type="submit" className="btn-next btn-submit" disabled={!canSubmitDiagnostic}>
              Завершить диагностику
            </button>
          </form>
          </div>
        </section>

        {/* Фаза 3: Письмо Дока — попап в стиле писем этапов */}
        {phase === 'phaseChoice' && (
          <div className="stage4-doc-modal" role="dialog" aria-labelledby="doc-modal-title" aria-modal="true">
            <div className="stage4-doc-modal-backdrop" aria-hidden />
            <div className="stage4-doc-modal-content stage4-email-style" data-tutor-highlight="stage4_doc_choice_modal">
              <div className="stage4-email-header">
                <span className="stage4-email-badge">Входящее</span>
              </div>
              <div className="stage4-email-subject">
                <h1 id="doc-modal-title">Письмо от Дока</h1>
              </div>
              <div className="stage4-email-from">
            {docImageError ? (
                  <div className="stage4-email-avatar stage4-email-avatar-placeholder" aria-hidden>Д</div>
                ) : (
                  <img src={docLetterAvatarUrl} alt="" className="stage4-email-avatar stage4-email-avatar-img" onError={() => setDocImageError(true)} />
                )}
                <div className="stage4-email-from-meta">
                  <span className="stage4-email-from-name">Док Браун</span>
                  <span className="stage4-email-from-time">Кому: мне</span>
                </div>
              </div>
              <div className="stage4-email-body">
                {docLetterText ? (
                  <MarkdownContent
                    content={docLetterText}
                    variant="document"
                    className="stage4-doc-letter-markdown"
                  />
                ) : null}
              </div>
              <div className="stage4-email-footer">
                <button type="button" className="stage4-email-btn stage4-email-btn-secondary" onClick={() => setFinalOutcome('accept')}>
                Принять последствия
              </button>
                <button type="button" className="stage4-email-btn stage4-email-btn-primary" onClick={() => showPhase('phaseContract')}>
                  Вернуться к моменту подписания
              </button>
            </div>
          </div>
          </div>
        )}

        {/* Фаза 4: Редактирование договора (пункты с вариантами A/B/C) */}
        <section id="phaseContract" className={`phase ${phase === 'phaseContract' ? 'active' : ''}`}>
          <h1>Возврат к договору</h1>
          {renderPersistentTimelineBlock()}
          <p className="subtitle">Выберите вариант по каждому пункту.</p>
          {crisisDescription && (
            <div className="contract-crisis-block">
              <p className="contract-crisis-text">{crisisDescription}</p>
            </div>
          )}
          <div data-tutor-highlight="stage4_contract_edit_area">
          {visibleContractClauses.map((clause) => (
            <div key={clause.clause_id} className="contract-block">
              <div className="heading">{clause.title}</div>
              <p className="clause">Исходная формулировка: «{getContractClauseOriginalText(clause)}»</p>
              {(clause.variants || []).map((v) => {
                const shownOriginal = getContractClauseOriginalText(clause);
                return (
                <button
                  key={v.id}
                  type="button"
                  className={`contract-option ${contractSelections[clause.clause_id] === v.id ? 'selected' : ''}`}
                  onClick={() => setContractChoice(clause.clause_id, v.id)}
                >
                  <span className="opt-label">{v.id}. {v.label}</span>
                  {(v.text || shownOriginal) && (
                    <span className="opt-desc">
                      {v.label && v.label.includes('Оставить без изменений') && shownOriginal
                        ? shownOriginal
                        : v.text}
                    </span>
                  )}
                </button>
                );
              })}
            </div>
          ))}
          </div>
          <button type="button" className="btn-next" onClick={handleContractDone}>
            Готово
          </button>
        </section>

        {/* Фаза 5: Разрешение первого кризиса — заголовок всегда «Разрешение» */}
        <section id="phaseFinal" className={`phase ${phase === 'phaseFinal' ? 'active' : ''}`}>
          {firstOutcomeKey === 'noChange' ? (
            <>
              <h1>Разрешение</h1>
              {renderPersistentTimelineBlock()}
              <div
                className={`outcome-block stage4-outcome-reveal ${outcomeResolutionCardVisible ? 'visible' : ''}`}
              >
                <h2>Вы вернулись, но не изменили договор</h2>
                <p className="outcome-text">
                  Возврат был использован впустую. Может наступить новый кризис, но вернуться уже нельзя.
                </p>
                {secondCrisisLoadError && (
                  <p className="subtitle" style={{ marginTop: '0.5rem', color: 'var(--stage4-failure, #c00)' }}>
                    {secondCrisisLoadError}
                  </p>
                )}
                {canContinueToSecondCrisis && (
                  <button type="button" className="btn-next" onClick={startSecondCrisis} disabled={loadingSecond}>
                    {loadingSecond ? 'Загрузка...' : secondCrisisLoadError ? 'Повторить' : 'Продолжить'}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <h1>Разрешение</h1>
              {renderPersistentTimelineBlock()}

              {/* Визуальный эффект после возврата: воспроизведение таймлайна, мигание точки кризиса, исход */}
              {(firstOutcomeKey === 'fixed' || firstOutcomeKey === 'repeat') && returnReplayPhase !== 'done' && (
                <div className="stage4-return-replay">
                  {showConfetti && (
                    <div className="stage4-confetti" aria-hidden>
                      {confettiPieces.map((p) => (
                        <div
                          key={p.id}
                          className="stage4-confetti-piece"
                          style={{
                            left: `${p.left}%`,
                            animationDelay: `${p.delay}s`,
                            animationDuration: `${p.duration}s`,
                            backgroundColor: p.color
                          }}
                        />
                  ))}
                </div>
              )}
                  {showDocBrown && (
                    <div className={`stage4-doc-timemachine ${docBrownAtCenter ? 'stage4-doc-at-center' : ''} ${docBrownGreeting ? 'stage4-doc-greeting' : ''}`}>
                      <div className="stage4-doc-car">
                        {docImageError ? (
                          <div className="stage4-doc-avatar stage4-doc-avatar-placeholder">Д</div>
                        ) : (
                          <img src={docAvatarUrl} alt="" className="stage4-doc-avatar" onError={() => setDocImageError(true)} />
                        )}
                        <span className="stage4-doc-carlabel">Машина времени</span>
                      </div>
                      {docBrownGreeting && (
                        <div className="stage4-doc-speech">
                          Великолепно! Кризис не возник — вы всё исправили!
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Итоговый блок исхода и кнопка «Продолжить» — после завершения replay */}
              {((firstOutcomeKey !== 'fixed' && firstOutcomeKey !== 'repeat')
                || ['resolution', 'celebration', 'done'].includes(returnReplayPhase)) && (
                <>
              {outcomeData && (
                    <div
                      className={`outcome-block stage4-outcome-reveal ${
                        firstOutcomeKey === 'fixed' || firstOutcomeKey === 'repeat'
                          ? (['resolution', 'celebration', 'done'].includes(returnReplayPhase) ? 'visible' : '')
                          : (outcomeResolutionCardVisible ? 'visible' : '')
                      }`}
                    >
                  <h2>{outcomeData.title}</h2>
                  <p className="outcome-text">{outcomeData.text}</p>
                  {secondCrisisLoadError && (
                    <p className="subtitle" style={{ marginTop: '0.5rem', color: 'var(--stage4-failure, #c00)' }}>
                      {secondCrisisLoadError}
                    </p>
                  )}
                  {canContinueToSecondCrisis && (
                    <button type="button" className="btn-next" onClick={startSecondCrisis} disabled={loadingSecond}>
                      {loadingSecond ? 'Загрузка...' : secondCrisisLoadError ? 'Повторить' : 'Продолжить'}
                    </button>
                  )}
                </div>
                  )}
                </>
              )}
            </>
          )}
        </section>

        {/* Фаза 6: Второй таймлайн — продолжение, затем второй кризис */}
        <section id="phaseSecondTimeline" className={`phase ${phase === 'phaseSecondTimeline' ? 'active' : ''}`}>
          <h1>{contractTitle}</h1>
          {renderPersistentTimelineBlock()}
          <div className={`timeline-pause ${secondCrisisVisible ? 'visible' : ''}`}>
            {secondCrisis?.crisis_description?.trim() || 'Кризис'}
          </div>
          {secondShowNextBtn && (
            <p style={{ marginTop: '1.5rem' }}>
              <button type="button" className="btn-next" onClick={() => showPhase('phaseSecondDiagnostic')}>
                Оценить ситуацию
              </button>
            </p>
          )}
        </section>

        {/* Фаза 7: Вторая диагностика кризиса */}
        <section id="phaseSecondDiagnostic" className={`phase ${phase === 'phaseSecondDiagnostic' ? 'active' : ''}`}>
          <h1>Диагностика кризиса</h1>
          {renderPersistentTimelineBlock()}
          <div
            className={`stage4-diagnostic-reveal-wrap stage4-outcome-reveal ${
              secondDiagnosticContentVisible ? 'visible' : ''
            }`}
          >
            <div className="stage4-diagnostic-situation">
              <p className="stage4-diagnostic-situation-label">Оцените ситуацию (второй кризис)</p>
              <p className="stage4-diagnostic-situation-text">{secondCrisis?.crisis_description?.trim() || ''}</p>
            </div>
          <form className="diagnostic-block" onSubmit={handleSecondDiagnosticSubmit}>
            {secondDiagnosticQuestions.map((q) => {
              const key = q.question_id || q.type;
              const value = secondDiagnosisAnswers[key];
              const options = q.options || [];
              const isMultiple = q.type === 'legal_basis';
              return (
                <div key={key} className="diagnostic-q">
                  <h3>{q.text}</h3>
                    <div className="diagnostic-options">
                  {options.map((opt) => {
                    const optId = opt.id || opt.value || opt.text;
                    const optText = opt.text || opt.label || optId;
                    const checked = isMultiple ? (Array.isArray(value) && value.includes(optId)) : value === optId;
                    return (
                          <label key={optId} className={checked ? 'diagnostic-option selected' : 'diagnostic-option'}>
                        <input
                          type={isMultiple ? 'checkbox' : 'radio'}
                          name={key}
                          value={optId}
                          checked={!!checked}
                          onChange={() => setSecondDiagnosisAnswer(key, q.type, optId, isMultiple)}
                        />
                            <span className="diagnostic-option-text">{optText}</span>
                      </label>
                    );
                  })}
                    </div>
                </div>
              );
            })}
            <button type="submit" className="btn-next btn-submit" disabled={!canSubmitSecondDiagnostic}>
              Завершить диагностику
            </button>
          </form>
          </div>
        </section>

        {/* Фаза 8: Итог второй диагностики и завершение этапа — сводный таймлайн + описание */}
        <section id="phaseSecondOutcome" className={`phase ${phase === 'phaseSecondOutcome' ? 'active' : ''}`}>
          <h1>Разрешение</h1>
          {renderPersistentTimelineBlock()}
          <div
            className={`stage4-second-outcome-wrap stage4-outcome-reveal ${
              secondOutcomeResolutionCardVisible ? 'visible' : ''
            }`}
          >
          {(() => {
            const oc = getSecondOutcomeContent();
            return (
              <>
                {!oc.title && (
          <p className="subtitle">
                    {secondOutcomeViable
                      ? 'Диагностика спорная, остаются риски.'
                      : secondDiagnosisCorrect
                        ? 'Диагностика корректна: угроза устранена.'
                        : 'Диагностика некорректна: компания несёт убытки.'}
                  </p>
                )}
                <div className="outcome-block">
                  {oc.title ? <h2>{oc.title}</h2> : null}
                  <p className="outcome-text">{oc.text}</p>
            </div>
              </>
            );
          })()}
          </div>
        </section>
      </div>
      <div className="stage4-complete-dock">
        <button
          type="button"
          className="stage4-complete-btn"
          onClick={onCompleteStage}
          disabled={stageCompleteInFlight}
          aria-busy={stageCompleteInFlight}
        >
          {stageCompleteInFlight ? 'Сохранение и переход…' : 'Завершить этап'}
        </button>
      </div>
    </div>
  );
}
