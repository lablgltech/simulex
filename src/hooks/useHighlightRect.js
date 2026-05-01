import { useEffect, useState } from 'react';

/**
 * Прямоугольник элемента с data-tutor-highlight="highlightId" в координатах viewport.
 * Если узел появляется позже (например, после «Загрузка…» на этапе 2), подписка на DOM
 * перехватывает появление и обновляет rect.
 * @param {string|null|undefined} highlightId
 * @param {{ scrollIntoView?: boolean }} [options]
 */
export function useHighlightRect(highlightId, options = {}) {
  const { scrollIntoView = true } = options;
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (!highlightId) {
      setRect(null);
      return undefined;
    }

    let cancelled = false;
    let resizeObserver = null;
    let attachedEl = null;

    const detach = () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (attachedEl) {
        window.removeEventListener('scroll', onLayoutChange, true);
        attachedEl = null;
      }
    };

    const onLayoutChange = () => {
      if (!attachedEl || cancelled) return;
      const r = attachedEl.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    const attach = (el) => {
      detach();
      attachedEl = el;
      if (scrollIntoView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      onLayoutChange();
      resizeObserver = new ResizeObserver(onLayoutChange);
      resizeObserver.observe(el);
      window.addEventListener('scroll', onLayoutChange, true);
    };

    const tryAttach = () => {
      if (cancelled) return false;
      const el = document.querySelector(`[data-tutor-highlight="${highlightId}"]`);
      if (!el) return false;
      attach(el);
      return true;
    };

    if (tryAttach()) {
      return () => {
        cancelled = true;
        detach();
      };
    }

    const mo = new MutationObserver(() => {
      if (tryAttach()) {
        mo.disconnect();
        if (pollId != null) clearInterval(pollId);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    let pollId = setInterval(() => {
      if (tryAttach()) {
        mo.disconnect();
        if (pollId != null) clearInterval(pollId);
        pollId = null;
      }
    }, 80);

    return () => {
      cancelled = true;
      mo.disconnect();
      if (pollId != null) clearInterval(pollId);
      detach();
    };
  }, [highlightId, scrollIntoView]);

  return rect;
}
