import React, { useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useHighlightRect } from '../hooks/useHighlightRect';
import MarkdownContent from './MarkdownContent';

const MONT = "'Montserrat', system-ui, -apple-system, sans-serif";

/** Макс. ширина карточки шага тура на широком экране (на узких — см. min с 100vw). */
const TOUR_CARD_MAX_WIDTH_PX = 560;

function clampAxis(val, min, max) {
  return Math.min(Math.max(min, val), max);
}

/** useHighlightRect отдаёт только top/left/width/height — не DOMRect с .right/.bottom */
function rectRight(r) {
  if (!r || typeof r.left !== 'number' || typeof r.width !== 'number') return NaN;
  return r.left + r.width;
}

/**
 * Стартовая позиция карточки тура для пресетов этапа 1 (по макету).
 * @param {string} placement
 * @param {{ top: number, left: number, width: number, height: number }} rect — подсветка шага
 * @param {{ top: number, left: number, width: number, height: number } | null} ar — tourCardAnchor (колонка документов)
 */
function computeTourCardBaseByPlacement(placement, rect, ar, vw, vh, cardW, cardMaxH, pad) {
  const LEFT_INSET = 48;
  const GAP = 14;
  switch (placement) {
    case 'stage1_viewport_left': {
      const left = clampAxis(LEFT_INSET, pad, vw - cardW - pad);
      const vMid = rect.top + rect.height / 2;
      let top = vMid - cardMaxH / 2;
      top = clampAxis(top, pad, vh - cardMaxH - pad);
      return { left, top };
    }
    case 'stage1_main_column_center': {
      if (!ar || ar.width <= 0) return null;
      let left = ar.left + ar.width / 2 - cardW / 2;
      const vMid = ar.top + ar.height / 2;
      let top = vMid - cardMaxH / 2;
      return {
        left: clampAxis(left, pad, vw - cardW - pad),
        top: clampAxis(top, pad, vh - cardMaxH - pad),
      };
    }
    case 'stage1_gap_doc_attributes': {
      if (!ar || ar.width <= 0) return null;
      let left = rectRight(ar) + GAP;
      left = clampAxis(left, pad, vw - cardW - pad);
      const vMid = rect.top + rect.height / 2;
      let top = vMid - cardMaxH / 2;
      top = clampAxis(top, pad, vh - cardMaxH - pad);
      return { left, top };
    }
    case 'stage1_right_of_brief': {
      let left = rectRight(rect) + GAP;
      left = clampAxis(left, pad, vw - cardW - pad);
      const vMid = rect.top + rect.height / 2;
      let top = vMid - cardMaxH / 2;
      top = clampAxis(top, pad, vh - cardMaxH - pad);
      return { left, top };
    }
    default:
      return null;
  }
}

function SpotlightCutout({ rect }) {
  if (!rect) return null;
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: rect.top - 6,
        left: rect.left - 6,
        width: rect.width + 12,
        height: rect.height + 12,
        borderRadius: 8,
        boxShadow: '0 0 0 9999px rgba(0,0,0,0.72)',
        border: '3px solid rgba(59, 130, 246, 0.95)',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  );
}

/**
 * Шаг тура: подсветка по highlightId и карточка с текстом. Клик по затемнению не закрывает.
 */
export default function SimulatorTourOverlay({
  step,
  stepIndex,
  totalSteps,
  onBack,
  onNext,
  onSkip,
  canBack,
  isLast,
}) {
  const highlightId = step?.highlightId || null;
  const rect = useHighlightRect(highlightId);
  const anchorPlacementRect = useHighlightRect(step?.tourCardAnchor ?? null, { scrollIntoView: false });
  const cardRef = useRef(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const dragSessionRef = useRef(null);
  const cardBasePositionRef = useRef({ left: 0, top: 0 });
  const [dragging, setDragging] = useState(false);
  /** Сдвиг после отрисовки: карточка целиком в viewport (кнопки «Дальше»/«Пропустить» не обрезаются). */
  const [layoutNudge, setLayoutNudge] = useState({ x: 0, y: 0 });

  useEffect(() => {
    dragOffsetRef.current = dragOffset;
  }, [dragOffset]);

  useEffect(() => {
    const z = { x: 0, y: 0 };
    dragOffsetRef.current = z;
    setDragOffset(z);
  }, [stepIndex, highlightId, step?.id, step?.tourCardPlacement]);

  const cardBasePosition = useMemo(() => {
    const pad = 16;
    if (typeof window === 'undefined') {
      return { left: 0, top: 0 };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardW = Math.min(TOUR_CARD_MAX_WIDTH_PX, vw - 32);
    const cardMaxH = Math.min(Math.round(vh * 0.88), 520);
    if (!rect) {
      const top = Math.max(pad, Math.min((vh - cardMaxH) / 2, vh - cardMaxH - pad));
      return { left: (vw - cardW) / 2, top };
    }
    const preset = step?.tourCardPlacement;
    if (preset) {
      const custom = computeTourCardBaseByPlacement(
        preset,
        rect,
        anchorPlacementRect,
        vw,
        vh,
        cardW,
        cardMaxH,
        pad
      );
      if (custom) return custom;
    }
    let top = rect.top + rect.height + 12;
    if (top + cardMaxH > vh - pad) {
      top = rect.top - cardMaxH - 12;
    }
    if (top + cardMaxH > vh - pad) {
      top = Math.max(pad, vh - pad - cardMaxH);
    }
    if (top < pad) top = pad;
    let left = rect.left + rect.width / 2 - cardW / 2;
    if (left < pad) left = pad;
    if (left + cardW > vw - pad) left = vw - cardW - pad;
    return { left, top };
  }, [rect, anchorPlacementRect, step?.tourCardPlacement]);

  useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      const el = cardRef.current;
      if (!el || cancelled) return;
      const r = el.getBoundingClientRect();
      const pad = 12;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nx = 0;
      let ny = 0;
      if (r.right > vw - pad) nx = vw - pad - r.right;
      if (r.left + nx < pad) nx = pad - r.left;
      if (r.bottom > vh - pad) ny = vh - pad - r.bottom;
      if (r.top + ny < pad) ny = pad - r.top;
      setLayoutNudge({ x: nx, y: ny });
    };
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(measure);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [
    stepIndex,
    highlightId,
    step?.id,
    step?.body,
    cardBasePosition.left,
    cardBasePosition.top,
    rect?.top,
    rect?.left,
    rect?.width,
    rect?.height,
    totalSteps,
  ]);

  useEffect(() => {
    const onResize = () => {
      const el = cardRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pad = 12;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nx = 0;
      let ny = 0;
      if (r.right > vw - pad) nx = vw - pad - r.right;
      if (r.left + nx < pad) nx = pad - r.left;
      if (r.bottom > vh - pad) ny = vh - pad - r.bottom;
      if (r.top + ny < pad) ny = pad - r.top;
      setLayoutNudge({ x: nx, y: ny });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const mergedBase = useMemo(
    () => ({
      left: cardBasePosition.left + layoutNudge.x,
      top: cardBasePosition.top + layoutNudge.y,
    }),
    [cardBasePosition.left, cardBasePosition.top, layoutNudge.x, layoutNudge.y]
  );

  cardBasePositionRef.current = mergedBase;

  const clampDragOffset = (dx, dy) => {
    if (typeof window === 'undefined') return { x: dx, y: dy };
    const el = cardRef.current;
    const base = cardBasePositionRef.current;
    const m = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el?.offsetWidth ?? Math.min(TOUR_CARD_MAX_WIDTH_PX, vw - 32);
    const h = el?.offsetHeight ?? 240;
    let l = base.left + dx;
    let t = base.top + dy;
    l = Math.min(Math.max(m, l), vw - w - m);
    t = Math.min(Math.max(m, t), vh - h - m);
    return { x: l - base.left, y: t - base.top };
  };

  useEffect(
    () => () => {
      const s = dragSessionRef.current;
      if (s) {
        window.removeEventListener('pointermove', s.onMove);
        window.removeEventListener('pointerup', s.onUp);
        window.removeEventListener('pointercancel', s.onUp);
        dragSessionRef.current = null;
      }
    },
    []
  );

  const onDragHandlePointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const prev = dragSessionRef.current;
    if (prev) {
      window.removeEventListener('pointermove', prev.onMove);
      window.removeEventListener('pointerup', prev.onUp);
      window.removeEventListener('pointercancel', prev.onUp);
    }
    const o = dragOffsetRef.current;
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev) => {
      const rawX = o.x + (ev.clientX - sx);
      const rawY = o.y + (ev.clientY - sy);
      const next = clampDragOffset(rawX, rawY);
      dragOffsetRef.current = next;
      setDragOffset(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragSessionRef.current = null;
      setDragging(false);
    };
    dragSessionRef.current = { onMove, onUp };
    setDragging(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const cardLeft = mergedBase.left + dragOffset.x;
  const cardTop = mergedBase.top + dragOffset.y;

  const primaryLabel =
    isLast && step?.tourOutro
      ? step.completeButtonLabel || 'Завершить обучение'
      : isLast
        ? 'Готово'
        : 'Далее';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sim-tour-step-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 12000,
        pointerEvents: 'none',
      }}
    >
      {/* Без якоря — полное затемнение. С якорем, но rect ещё нет (узел в «Загрузка…») — то же, иначе пустой экран. */}
      {!highlightId || !rect ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.72)',
            zIndex: 0,
            pointerEvents: 'auto',
          }}
        />
      ) : null}
      {highlightId && rect ? <SpotlightCutout rect={rect} /> : null}
      <div
        ref={cardRef}
        style={{
          position: 'fixed',
          left: cardLeft,
          top: cardTop,
          width: `min(${TOUR_CARD_MAX_WIDTH_PX}px, calc(100vw - 32px))`,
          maxHeight: 'min(85vh, calc(100vh - 24px))',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: '#fff',
          borderRadius: 12,
          padding: 18,
          paddingBottom: 14,
          boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
          zIndex: 2,
          pointerEvents: 'auto',
          fontFamily: MONT,
        }}
      >
        <div
          role="toolbar"
          aria-label="Перетащить подсказку"
          onPointerDown={onDragHandlePointerDown}
          style={{
            flexShrink: 0,
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
            margin: '-4px -4px 0 -4px',
            padding: '4px 4px 8px 4px',
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
            Шаг {stepIndex + 1} из {totalSteps}
          </div>
          <h2 id="sim-tour-step-title" style={{ margin: 0, fontSize: 17, color: '#111827' }}>
            {step?.title}
          </h2>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            paddingRight: 4,
            fontSize: 14,
            color: '#4b5563',
          }}
        >
          <style>{`
            .sim-tour-step-md.simulex-markdown-ui h1 { font-size: 1.125rem !important; margin-top: 0 !important; margin-bottom: 8px !important; }
            .sim-tour-step-md.simulex-markdown-ui h2 { font-size: 1.05rem !important; margin-top: 14px !important; margin-bottom: 8px !important; }
            .sim-tour-step-md.simulex-markdown-ui h2:first-child { margin-top: 0 !important; }
            .sim-tour-step-md.simulex-markdown-ui h3 { font-size: 0.95rem !important; margin-top: 12px !important; margin-bottom: 6px !important; }
            .sim-tour-step-md.simulex-markdown-ui h3:first-child { margin-top: 0 !important; }
            .sim-tour-step-md.simulex-markdown-ui p { margin-bottom: 8px !important; font-size: 14px; color: #4b5563; }
            .sim-tour-step-md.simulex-markdown-ui p:last-child { margin-bottom: 0 !important; }
            .sim-tour-step-md.simulex-markdown-ui ul { margin-bottom: 8px !important; padding-left: 18px !important; font-size: 14px; color: #4b5563; }
            .sim-tour-step-md.simulex-markdown-ui li { margin-bottom: 4px !important; }
          `}</style>
          <MarkdownContent content={step?.body || ''} className="sim-tour-step-md" variant="ui" />
        </div>
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            gap: 8,
            marginTop: 14,
            paddingTop: 12,
            paddingBottom: 'max(0px, env(safe-area-inset-bottom, 0px))',
            borderTop: '1px solid #e5e7eb',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            onClick={onSkip}
            style={{
              padding: '8px 12px',
              background: 'transparent',
              color: '#6b7280',
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Пропустить
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              disabled={!canBack}
              onClick={onBack}
              style={{
                padding: '8px 14px',
                background: canBack ? '#e5e7eb' : '#f3f4f6',
                color: canBack ? '#374151' : '#9ca3af',
                border: 'none',
                borderRadius: 8,
                cursor: canBack ? 'pointer' : 'default',
                fontSize: 14,
              }}
            >
              Назад
            </button>
            <button
              type="button"
              onClick={onNext}
              style={{
                padding: '8px 16px',
                background: '#1e3a5f',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {primaryLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
