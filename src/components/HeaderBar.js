import React, { useState, useEffect, useRef } from 'react';
import logoMinimal from '../assets/logo_minimal.png';
import FinishCaseConfirm from './FinishCaseConfirm';

/**
 * Одна полоса в режиме симуляции: слева этап + почта + документы (+ кредиты), по центру таймер (если включён),
 * справа наставник, завершение кейса, бургер с глобальной навигацией.
 *
 * variant="minimal" — только логотип и бургер (для обычного пользователя); справка и действия в кейсе — в меню бургера.
 */
export default function HeaderBar({
  onFinishCase,
  stageTitle = null,
  timeRemaining = null,
  points = 0,
  /** Показывать секундомер по центру (когда в кейсе задан time_budget этапа) */
  showStageTimer = false,
  onEmailClick,
  unreadEmailCount = 0,
  showCredits = true,
  showFinishButton = true,
  showBriefButton = false,
  briefButtonLabel = '📂 Документы',
  onBriefClick = null,
  onTutorToggle = null,
  tutorUnreadCount = 0,
  /** Меню приложения (бургер справа). Если null — кнопка меню не показывается. */
  gameMenu = null,
  /** Свернуть панель (режим симуляции): компактный HUD */
  onCollapse = null,
  /** full — обычная полоса; minimal — логотип слева, бургер справа */
  variant = 'full',
}) {
  const [showConfirmFinish, setShowConfirmFinish] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const burgerBtnRef = useRef(null);

  const formatTime = (seconds) => {
    if (seconds === null || seconds === undefined) return '';
    const s = Math.max(0, Number(seconds) || 0);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      if (menuRef.current?.contains(e.target) || burgerBtnRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const handleFinishClick = () => {
    setShowConfirmFinish(true);
  };

  const confirmFinish = () => {
    setShowConfirmFinish(false);
    if (onFinishCase) {
      onFinishCase();
    }
  };

  const roleSuffix =
    gameMenu?.role === 'superuser'
      ? ' (суперюзер)'
      : gameMenu?.role === 'admin'
        ? ' (админ)'
        : '';

  const timerVisible =
    showStageTimer && timeRemaining !== null && timeRemaining !== undefined;

  const barShellStyle = {
    position: 'sticky',
    top: 0,
    zIndex: 1000,
    background: 'white',
    borderBottom: '2px solid #e5e7eb',
    padding: '10px 16px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.08)',
  };

  const menuDivider = (
    <div
      style={{
        borderTop: '1px solid #e5e7eb',
        margin: '8px 0',
      }}
    />
  );

  const renderBurgerDropdown = () => (
    <div
      ref={menuRef}
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: '6px',
        minWidth: '240px',
        background: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        boxShadow: '0 10px 25px rgba(0,0,0,0.12)',
        padding: '8px 0',
        zIndex: 1100,
      }}
    >
      <button
        type="button"
        onClick={() => {
          gameMenu.onNavigate('game');
          setMenuOpen(false);
        }}
        style={menuItemStyle(gameMenu.activeView === 'game')}
      >
        Симулятор
      </button>
      <button
        type="button"
        onClick={() => {
          gameMenu.onNavigate('my-reports');
          setMenuOpen(false);
        }}
        style={menuItemStyle(gameMenu.activeView === 'my-reports')}
      >
        Мои отчёты
      </button>
      {gameMenu.isAdmin && (
        <button
          type="button"
          onClick={() => {
            gameMenu.onNavigate('admin');
            setMenuOpen(false);
          }}
          style={menuItemStyle(gameMenu.activeView === 'admin')}
        >
          Админпанель
        </button>
      )}
      {variant === 'minimal' &&
        (onTutorToggle || (showFinishButton && onFinishCase) || showCredits) && (
          <>
            {menuDivider}
            {onTutorToggle && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onTutorToggle();
                }}
                style={menuItemStyle(false)}
              >
                💬 Наставник
                {tutorUnreadCount > 0 ? ` (${tutorUnreadCount > 9 ? '9+' : tutorUnreadCount})` : ''}
              </button>
            )}
            {showFinishButton && onFinishCase && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  handleFinishClick();
                }}
                style={{ ...menuItemStyle(false), color: '#b91c1c', fontWeight: 600 }}
              >
                Завершить кейс
              </button>
            )}
            {showCredits && (
              <div
                style={{ padding: '8px 16px', fontSize: '13px', color: '#6b7280' }}
                data-tutor-highlight="credits"
              >
                Кредиты: <strong style={{ color: '#3b82f6' }}>{points}</strong>
              </div>
            )}
          </>
        )}
      {menuDivider}
      <div style={{ padding: '8px 16px', fontSize: '13px', color: '#6b7280' }}>
        {gameMenu.username}
        {roleSuffix}
      </div>
      <button
        type="button"
        onClick={() => {
          setMenuOpen(false);
          gameMenu.onLogout();
        }}
        style={{
          ...menuItemStyle(false),
          color: '#b91c1c',
          marginTop: '4px',
        }}
      >
        Выход
      </button>
    </div>
  );

  if (variant === 'minimal') {
    return (
      <>
        <div style={barShellStyle}>
          <img
            src={logoMinimal}
            alt="СИМУЛЕКС"
            style={{ height: 28, objectFit: 'contain', display: 'block', flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }} />
          {gameMenu && (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                ref={burgerBtnRef}
                type="button"
                aria-expanded={menuOpen}
                aria-label="Меню"
                onClick={() => setMenuOpen((o) => !o)}
                style={{
                  padding: '8px 10px',
                  background: menuOpen ? '#e5e7eb' : '#f3f4f6',
                  border: '1px solid #e5e7eb',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '18px',
                  lineHeight: 1,
                  color: '#374151',
                }}
              >
                ☰
              </button>
              {menuOpen && renderBurgerDropdown()}
            </div>
          )}
        </div>
        {showConfirmFinish && (
          <FinishCaseConfirm
            onDismiss={() => setShowConfirmFinish(false)}
            onConfirm={confirmFinish}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div style={barShellStyle}>
        {/* Левая зона */}
        <div
          style={{
            flex: '1 1 0%',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            minWidth: 0,
            flexWrap: 'nowrap',
          }}
        >
          <div
            style={{
              flex: '1 1 0%',
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                fontSize: '15px',
                fontWeight: 700,
                color: '#374151',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={stageTitle || undefined}
            >
              {stageTitle || 'Прохождение кейса'}
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexShrink: 0,
            }}
          >
          {onEmailClick && (
            <button
              type="button"
              data-tutor-highlight="mail"
              onClick={onEmailClick}
              style={{
                padding: '7px 12px',
                background: '#f3f4f6',
                color: '#374151',
                border: '1px solid #e5e7eb',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                position: 'relative',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#e5e7eb';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#f3f4f6';
              }}
            >
              📧 Почта
              {unreadEmailCount > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: '-5px',
                    right: '-5px',
                    background: '#ef4444',
                    color: 'white',
                    borderRadius: '50%',
                    width: '18px',
                    height: '18px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '10px',
                    fontWeight: 'bold',
                  }}
                >
                  {unreadEmailCount > 9 ? '9+' : unreadEmailCount}
                </span>
              )}
            </button>
          )}
          {showBriefButton && onBriefClick && (
            <button
              type="button"
              onClick={onBriefClick}
              style={{
                padding: '7px 12px',
                background: '#f3f4f6',
                color: '#374151',
                border: '1px solid #e5e7eb',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#e5e7eb';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#f3f4f6';
              }}
            >
              {briefButtonLabel}
            </button>
          )}
          {showCredits && (
            <div
              data-tutor-highlight="credits"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
            >
              <span style={{ fontSize: '12px', color: '#9ca3af' }}>кредиты:</span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: '#3b82f6' }}>{points}</span>
            </div>
          )}
          </div>
        </div>

        {/* Центр — таймер */}
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minWidth: timerVisible ? 88 : 0,
          }}
        >
          {timerVisible && (
            <div data-tutor-highlight="timer" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  fontSize: '15px',
                  fontFamily: "'Montserrat', sans-serif",
                  color: timeRemaining < 60 ? '#ef4444' : 'var(--simulex-navy)',
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                ⏱️ {formatTime(timeRemaining)}
              </span>
            </div>
          )}
        </div>

        {/* Правая зона */}
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          {onTutorToggle && (
            <button
              type="button"
              onClick={onTutorToggle}
              title="ИИ-наставник — Сергей Павлович"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 10px',
                background: '#1e3a5f',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                position: 'relative',
              }}
            >
              <span aria-hidden>💬</span>
              <span>Наставник</span>
              {tutorUnreadCount > 0 && (
                <span
                  style={{
                    minWidth: '16px',
                    height: '16px',
                    borderRadius: '999px',
                    backgroundColor: '#f97316',
                    color: '#fff',
                    fontSize: '10px',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 4px',
                  }}
                >
                  {tutorUnreadCount > 9 ? '9+' : tutorUnreadCount}
                </span>
              )}
            </button>
          )}
          {showFinishButton && onFinishCase && (
            <button
              type="button"
              onClick={handleFinishClick}
              style={{
                padding: '7px 12px',
                background: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
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
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              title="Свернуть панель"
              style={{
                padding: '7px 10px',
                background: '#f9fafb',
                color: '#6b7280',
                border: '1px solid #e5e7eb',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                lineHeight: 1,
              }}
            >
              ▲
            </button>
          )}
          {gameMenu && (
            <div style={{ position: 'relative' }}>
              <button
                ref={burgerBtnRef}
                type="button"
                aria-expanded={menuOpen}
                aria-label="Меню"
                onClick={() => setMenuOpen((o) => !o)}
                style={{
                  padding: '8px 10px',
                  background: menuOpen ? '#e5e7eb' : '#f3f4f6',
                  border: '1px solid #e5e7eb',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '18px',
                  lineHeight: 1,
                  color: '#374151',
                }}
              >
                ☰
              </button>
              {menuOpen && renderBurgerDropdown()}
            </div>
          )}
        </div>
      </div>

      {showConfirmFinish && (
        <FinishCaseConfirm onDismiss={() => setShowConfirmFinish(false)} onConfirm={confirmFinish} />
      )}
    </>
  );
}

function menuItemStyle(active) {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '10px 16px',
    border: 'none',
    background: active ? '#eff6ff' : 'transparent',
    color: active ? '#1d4ed8' : '#374151',
    fontSize: '14px',
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  };
}
