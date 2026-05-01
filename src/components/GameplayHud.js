import React from 'react';

function formatStageTime(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const s = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Одна высота всех кнопок HUD (px) */
const BTN_H = 40;

/**
 * Отступ контента под фиксированный HUD (этап 1/3 — колонка; Симуграм — paddingTop).
 * Если шапка уже в потоке документа (`stackBelowHeader`), не дублируем «полный» отступ от верха viewport
 * (раньше 64+BTN_H+8 давал лишний зазор между HUD и этапом).
 */
export function getGameplayHudClearanceTopPx(stackBelowHeader) {
  if (!stackBelowHeader) return 12 + BTN_H + 8;
  return BTN_H + 12;
}

const hudBtnBase = {
  boxSizing: 'border-box',
  height: BTN_H,
  minHeight: BTN_H,
  maxHeight: BTN_H,
  padding: '0 12px',
  borderRadius: 8,
  border: '1px solid #e5e7eb',
  background: 'rgba(255, 255, 255, 0.95)',
  boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "'Montserrat', sans-serif",
  color: '#374151',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  flexShrink: 0,
  whiteSpace: 'nowrap',
  overflow: 'visible',
};

/**
 * Оверлей в симуляции: таймер, почта, документы, «…» — открыть/закрыть верхнюю навпанель.
 */
export default function GameplayHud({
  showTimer = false,
  timeRemaining = null,
  /** Доп. обратный отсчёт в том же стиле, что этапный таймер (напр. 10 мин на договоре этапа 4) */
  hudExtraCountdownSeconds = null,
  onRestartStage,
  restartStageBusy = false,
  restartStageDisabled = false,
  onDocumentsClick,
  onSimugramToggle,
  simugramUnreadCount = 0,
  onToggleNav,
  navExpanded = false,
  stackBelowHeader = false,
  /** Нижняя граница развёрнутого `<header>` в px — фиксируем HUD сразу под шапкой (иначе зазор ~64px). */
  playHeaderBottomPx = null,
}) {
  const hudTopPx =
    stackBelowHeader &&
    typeof playHeaderBottomPx === 'number' &&
    playHeaderBottomPx > 0
      ? playHeaderBottomPx
      : stackBelowHeader
        ? 64
        : 12;
  const timerVisible =
    showTimer && timeRemaining !== null && timeRemaining !== undefined;
  const urgent = timerVisible && timeRemaining < 60;
  const extraHudVisible =
    hudExtraCountdownSeconds !== null && hudExtraCountdownSeconds !== undefined;
  const extraUrgent = extraHudVisible && hudExtraCountdownSeconds < 60;

  return (
    <div
      style={{
        position: 'fixed',
        top: hudTopPx,
        left: 12,
        right: 12,
        zIndex: 1801,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        flexWrap: 'nowrap',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
          flexWrap: 'nowrap',
          maxWidth: '100%',
          overflowX: 'auto',
          overflowY: 'visible',
          WebkitOverflowScrolling: 'touch',
          pointerEvents: 'auto',
          paddingBottom: 2,
        }}
      >
        {typeof onRestartStage === 'function' && (
          <button
            type="button"
            onClick={onRestartStage}
            disabled={restartStageDisabled || restartStageBusy}
            title="Сбросить прогресс текущего этапа"
            aria-label="Перезапустить этап"
            style={{
              ...hudBtnBase,
              opacity: restartStageDisabled || restartStageBusy ? 0.55 : 1,
              cursor: restartStageDisabled || restartStageBusy ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => {
              if (restartStageDisabled || restartStageBusy) return;
              e.currentTarget.style.background = '#fef3c7';
              e.currentTarget.style.borderColor = '#fcd34d';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.95)';
              e.currentTarget.style.borderColor = '#e5e7eb';
            }}
          >
            {restartStageBusy ? '…' : '↺'} {restartStageBusy ? 'Сброс…' : 'Сброс этапа'}
          </button>
        )}
        {timerVisible && (
          <div
            data-tutor-highlight="timer"
            style={{
              boxSizing: 'border-box',
              height: BTN_H,
              minHeight: BTN_H,
              padding: '0 14px',
              borderRadius: 999,
              background: urgent ? 'rgba(254, 242, 242, 0.95)' : 'rgba(255, 255, 255, 0.92)',
              border: `1px solid ${urgent ? '#fecaca' : '#e5e7eb'}`,
              boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
              fontSize: 14,
              fontWeight: 700,
              fontFamily: "'Montserrat', sans-serif",
              fontVariantNumeric: 'tabular-nums',
              color: urgent ? '#b91c1c' : 'var(--simulex-navy)',
              pointerEvents: 'none',
              userSelect: 'none',
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
            }}
            aria-live="polite"
          >
            ⏱️ {formatStageTime(timeRemaining)}
          </div>
        )}
        {extraHudVisible && (
          <div
            data-tutor-highlight="stage4-contract-timer"
            style={{
              boxSizing: 'border-box',
              height: BTN_H,
              minHeight: BTN_H,
              padding: '0 14px',
              borderRadius: 999,
              background: extraUrgent ? 'rgba(254, 242, 242, 0.95)' : 'rgba(255, 255, 255, 0.92)',
              border: `1px solid ${extraUrgent ? '#fecaca' : '#e5e7eb'}`,
              boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
              fontSize: 14,
              fontWeight: 700,
              fontFamily: "'Montserrat', sans-serif",
              fontVariantNumeric: 'tabular-nums',
              color: extraUrgent ? '#b91c1c' : 'var(--simulex-navy)',
              pointerEvents: 'none',
              userSelect: 'none',
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
            }}
            aria-live="polite"
            aria-label="Таймер правок договора"
          >
            ⏱️ {formatStageTime(hudExtraCountdownSeconds)}
          </div>
        )}
        {onDocumentsClick && (
          <button
            type="button"
            data-tutor-highlight="docs"
            onClick={onDocumentsClick}
            title="Документы кейса"
            aria-label="Документы"
            style={hudBtnBase}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f3f4f6';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.95)';
            }}
          >
            📂 Документы
          </button>
        )}
        {typeof onSimugramToggle === 'function' && (
          <button
            type="button"
            data-tutor-highlight="tutor_nav_btn"
            onClick={onSimugramToggle}
            title="Симуграм — мессенджер"
            aria-label="Симуграм"
            style={{
              ...hudBtnBase,
              background: '#1e3a5f',
              color: '#fff',
              borderColor: '#1e3a5f',
              boxShadow: '0 2px 12px rgba(30, 58, 95, 0.25)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#152a45';
              e.currentTarget.style.borderColor = '#152a45';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#1e3a5f';
              e.currentTarget.style.borderColor = '#1e3a5f';
            }}
          >
            <span aria-hidden>💬</span>
            <span>Симуграм</span>
            {simugramUnreadCount > 0 && (
              <span
                aria-label={`Чатов с непрочитанным в Симуграме: ${simugramUnreadCount}`}
                style={{
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 22,
                  height: 22,
                  padding: '0 6px',
                  borderRadius: 999,
                  background: '#16a34a',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 800,
                  marginLeft: 2,
                  boxShadow: '0 0 0 2px rgba(255,255,255,0.9), 0 2px 8px rgba(22, 163, 74, 0.45)',
                }}
              >
                {simugramUnreadCount > 9 ? '9+' : simugramUnreadCount}
              </span>
            )}
          </button>
        )}
        {typeof onToggleNav === 'function' && (
          <button
            type="button"
            data-tutor-highlight="nav_toggle"
            onClick={onToggleNav}
            aria-expanded={navExpanded}
            aria-label="Показать или скрыть панель навигации"
            title={navExpanded ? 'Скрыть панель навигации' : 'Показать панель навигации'}
            style={{
              ...hudBtnBase,
              minWidth: BTN_H,
              width: BTN_H,
              padding: 0,
              fontSize: 16,
              fontWeight: 700,
              ...(navExpanded
                ? {
                    background: '#1e3a5f',
                    color: '#fff',
                    borderColor: '#1e3a5f',
                    boxShadow: '0 2px 12px rgba(30, 58, 95, 0.35)',
                  }
                : {}),
            }}
            onMouseEnter={(e) => {
              if (navExpanded) {
                e.currentTarget.style.background = '#152a45';
                e.currentTarget.style.borderColor = '#152a45';
              } else {
                e.currentTarget.style.background = '#f3f4f6';
              }
            }}
            onMouseLeave={(e) => {
              if (navExpanded) {
                e.currentTarget.style.background = '#1e3a5f';
                e.currentTarget.style.borderColor = '#1e3a5f';
              } else {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.95)';
              }
            }}
          >
            …
          </button>
        )}
      </div>
    </div>
  );
}
