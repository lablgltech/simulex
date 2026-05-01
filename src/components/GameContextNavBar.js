import React from 'react';
import logoMinimal from '../assets/logo_minimal.png';

const barShell = {
  flexShrink: 0,
  background: 'white',
  borderBottom: '2px solid #e5e7eb',
  padding: '10px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
  rowGap: '8px',
  boxShadow: '0 2px 4px rgba(0, 0, 0, 0.08)',
};

const secondaryBtn = {
  padding: '7px 12px',
  background: '#f3f4f6',
  color: '#374151',
  border: '1px solid #e5e7eb',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const logoBtnReset = {
  border: 'none',
  background: 'transparent',
  padding: '4px 6px',
  margin: 0,
  cursor: 'pointer',
  borderRadius: 8,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  lineHeight: 0,
};

/**
 * Одна верхняя панель GameView.
 * lobby — всегда видна (выбор кейса).
 * playing — только в развёрнутом состоянии (остальное в HUD + кнопка «…»).
 */
export default function GameContextNavBar({
  variant,
  username,
  roleSuffix = '',
  onLogout,
  /** Клик по логотипу — на экран выбора кейса (сброс сессии задаёт родитель). */
  onLogoClick,
  onSimulatorTour,
  onMyReports,
  onQaBugs,
  onAdminPanel,
  onFinishCaseClick,
  lobbySubtitle = null,
  stageTitle = null,
  points = null,
  showCreditsStrip = false,
}) {
  const logoutLabel = `Выход (${username}${roleSuffix})`;

  const logoImg = (
    <img
      src={logoMinimal}
      alt=""
      aria-hidden
      style={{ height: 28, objectFit: 'contain', display: 'block', flexShrink: 0 }}
    />
  );

  return (
    <header style={barShell}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          minWidth: 0,
          flex: '1 1 auto',
        }}
      >
        {variant === 'lobby' && typeof onLogoClick === 'function' && (
          <button
            type="button"
            onClick={onLogoClick}
            aria-label="СИМУЛЕКС — выбор кейса"
            title="На страницу выбора кейса"
            style={logoBtnReset}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f3f4f6';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {logoImg}
          </button>
        )}
        {variant === 'lobby' && typeof onLogoClick !== 'function' && (
          <img
            src={logoMinimal}
            alt="СИМУЛЕКС"
            style={{ height: 28, objectFit: 'contain', display: 'block', flexShrink: 0 }}
          />
        )}
        {variant === 'lobby' && lobbySubtitle && (
          <span
            style={{
              fontSize: '14px',
              fontWeight: 700,
              color: '#374151',
              flexShrink: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={lobbySubtitle}
          >
            {lobbySubtitle}
          </span>
        )}
        {variant === 'playing' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              minWidth: 0,
              flexShrink: 1,
            }}
          >
            {typeof onLogoClick === 'function' && (
              <button
                type="button"
                onClick={onLogoClick}
                aria-label="СИМУЛЕКС — выбор кейса"
                title="На страницу выбора кейса"
                style={logoBtnReset}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                {logoImg}
              </button>
            )}
            {stageTitle != null && (
              <span
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  color: '#374151',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
                title={stageTitle}
              >
                {stageTitle}
              </span>
            )}
            {showCreditsStrip && points != null && (
              <span
                data-tutor-highlight="credits"
                style={{ fontSize: '13px', color: '#6b7280', flexShrink: 0 }}
              >
                кредиты: <strong style={{ color: '#3b82f6' }}>{points}</strong>
              </span>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
          flexShrink: 0,
        }}
      >
      {variant === 'lobby' && onMyReports && (
        <button
          type="button"
          onClick={onMyReports}
          style={secondaryBtn}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#e5e7eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#f3f4f6';
          }}
        >
          Мои отчёты
        </button>
      )}
      {variant === 'lobby' && onQaBugs && (
        <button
          type="button"
          onClick={onQaBugs}
          style={secondaryBtn}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#e5e7eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#f3f4f6';
          }}
        >
          Замечания QA
        </button>
      )}
      {variant === 'lobby' && onAdminPanel && (
        <button
          type="button"
          onClick={onAdminPanel}
          style={secondaryBtn}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#e5e7eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#f3f4f6';
          }}
        >
          Админпанель
        </button>
      )}

      {variant === 'playing' && onQaBugs && (
        <button
          type="button"
          onClick={onQaBugs}
          style={secondaryBtn}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#e5e7eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#f3f4f6';
          }}
        >
          Замечания QA
        </button>
      )}

      {onSimulatorTour && (
        <button
          type="button"
          onClick={onSimulatorTour}
          style={secondaryBtn}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#e5e7eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#f3f4f6';
          }}
        >
          Обучение по интерфейсу
        </button>
      )}

      {variant === 'playing' && onFinishCaseClick && (
        <button
          type="button"
          onClick={onFinishCaseClick}
          style={{
            ...secondaryBtn,
            background: '#ef4444',
            color: 'white',
            border: 'none',
            fontWeight: 600,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#dc2626';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#ef4444';
          }}
        >
          Завершить кейс
        </button>
      )}

      <button
        type="button"
        onClick={onLogout}
        style={{
          ...secondaryBtn,
          color: '#b91c1c',
          background: '#fef2f2',
          border: '1px solid #fecaca',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = '#fee2e2';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = '#fef2f2';
        }}
      >
        {logoutLabel}
      </button>
      </div>
    </header>
  );
}
