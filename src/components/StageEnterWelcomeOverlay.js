import React, { useRef } from 'react';

const MONT = "'Montserrat', system-ui, -apple-system, sans-serif";

/** Полная длительность анимации (мс) — совпадает с keyframes */
const STAGE_ENTER_TOTAL_MS = 3400;

/**
 * Немодальный оверлей: цвет фона по этапу, плашка с названием — плавно появилась, пауза, исчезла.
 */
export default function StageEnterWelcomeOverlay({ heading, theme, onComplete }) {
  const finishedRef = useRef(false);

  const handleOverlayAnimationEnd = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.animationName !== 'simulexStageEnterOverlay') return;
    if (finishedRef.current) return;
    finishedRef.current = true;
    onComplete?.();
  };

  const bg = theme?.background ?? 'linear-gradient(148deg, #334155 0%, #0f172a 100%)';
  const titleColor = theme?.titleColor ?? '#f8fafc';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="simulex-stage-enter-root"
      onAnimationEnd={handleOverlayAnimationEnd}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 11050,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(16px, 4vw, 40px)',
        background: bg,
        animation: `simulexStageEnterOverlay ${STAGE_ENTER_TOTAL_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`,
        fontFamily: MONT,
      }}
    >
      <style>{`
        /* Фон сразу непрозрачный — иначе в начале виден интерфейс этапа «насквозь». Плавность — у заголовка. */
        @keyframes simulexStageEnterOverlay {
          0% { opacity: 1; }
          76% { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes simulexStageEnterTitle {
          0% {
            opacity: 0;
            transform: translateY(22px) scale(0.97);
          }
          14% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
          72% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
          100% {
            opacity: 0;
            transform: translateY(-14px) scale(0.985);
          }
        }
      `}</style>
      <div
        style={{
          maxWidth: 'min(92vw, 720px)',
          textAlign: 'center',
          animation: `simulexStageEnterTitle ${STAGE_ENTER_TOTAL_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 'clamp(1.35rem, 4.2vw, 2.25rem)',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.25,
            color: titleColor,
            textShadow: '0 2px 24px rgba(0,0,0,0.25)',
          }}
        >
          {heading}
        </h1>
      </div>
    </div>
  );
}
