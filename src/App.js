import React, { useState, useEffect, useCallback } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import VkrRegisterPage from './pages/VkrRegisterPage';
import GameView from './pages/GameView';
import AdminView from './pages/AdminView';
import MyReportsView from './pages/MyReportsView';
import QaBugsView from './pages/QaBugsView';
import logoMinimal from './assets/logo_minimal.png';
import { userHasQaTrackerAccess } from './config/qaTracker';

function unauthPathFromHash() {
  if (typeof window === 'undefined') return '';
  return (window.location.hash || '').replace(/^#/, '').replace(/^\//, '');
}

function AppContent() {
  const { user, loading, login, logout, isAdmin } = useAuth();
  const showQaBugs = userHasQaTrackerAccess(user);
  const [view, setView] = useState('game'); // 'game' | 'my-reports' | 'qa-bugs' | 'admin'
  const [unauthView, setUnauthView] = useState(() =>
    unauthPathFromHash() === 'vkr-register' ? 'vkr' : 'login',
  );

  const syncUnauthViewFromHash = useCallback(() => {
    setUnauthView(unauthPathFromHash() === 'vkr-register' ? 'vkr' : 'login');
  }, []);

  useEffect(() => {
    if (user) return;
    syncUnauthViewFromHash();
    const onHash = () => syncUnauthViewFromHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [user, syncUnauthViewFromHash]);

  useEffect(() => {
    if (!user) setView('game');
  }, [user]);

  useEffect(() => {
    if (user && !isAdmin && view === 'admin') setView('game');
  }, [user, isAdmin, view]);

  useEffect(() => {
    if (user && view === 'qa-bugs' && !userHasQaTrackerAccess(user)) setView('game');
  }, [user, view]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <p>Загрузка...</p>
      </div>
    );
  }

  if (!user) {
    if (unauthView === 'vkr') {
      return <VkrRegisterPage login={login} onNavigateLogin={() => { window.location.hash = ''; }} />;
    }
    return (
      <LoginPage
        onSuccess={async (username, password) => {
          await login(username, password);
        }}
        onVkrRegister={() => {
          window.location.hash = 'vkr-register';
        }}
      />
    );
  }

  const navStyle = {
    background: 'white',
    borderBottom: '1px solid #e5e7eb',
    padding: '10px 20px',
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flexWrap: 'nowrap',
    flexShrink: 0,
    overflowX: 'auto',
  };
  const linkStyle = (active) => ({
    padding: '8px 14px',
    background: active ? '#eff6ff' : 'transparent',
    color: active ? '#1d4ed8' : '#374151',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #f3f4f6 0%, #e0e7ff 100%)', margin: 0, padding: 0 }}>
      {view !== 'game' && (
        <nav style={navStyle} data-simulex="main-nav">
          <div style={{ display: 'flex', alignItems: 'center', marginRight: '16px', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setView('game')}
              aria-label="СИМУЛЕКС — симулятор, выбор кейса"
              title="Симулятор: выбор кейса"
              style={{
                border: 'none',
                background: 'transparent',
                padding: '4px 6px',
                margin: 0,
                cursor: 'pointer',
                borderRadius: 8,
                display: 'inline-flex',
                alignItems: 'center',
                lineHeight: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#f3f4f6';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <img src={logoMinimal} alt="" aria-hidden style={{ height: 28, objectFit: 'contain', display: 'block' }} />
            </button>
          </div>
          <button type="button" onClick={() => setView('game')} style={linkStyle(view === 'game')}>
            Симулятор
          </button>
          <button type="button" onClick={() => setView('my-reports')} style={linkStyle(view === 'my-reports')}>
            Мои отчёты
          </button>
          {showQaBugs && (
            <button type="button" onClick={() => setView('qa-bugs')} style={linkStyle(view === 'qa-bugs')}>
              Замечания QA
            </button>
          )}
          {isAdmin && (
            <button type="button" onClick={() => setView('admin')} style={linkStyle(view === 'admin')}>
              Админпанель
            </button>
          )}
          <span style={{ marginLeft: 'auto', fontSize: '14px', color: '#6b7280' }}>
            {user.username}
            {user.role === 'superuser' && ' (суперюзер)'}
            {user.role === 'admin' && ' (админ)'}
          </span>
          <button
            type="button"
            onClick={logout}
            style={{
              padding: '8px 14px',
              background: '#fef2f2',
              color: '#b91c1c',
              border: '1px solid #fecaca',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Выход
          </button>
        </nav>
      )}

      {view === 'game' && (
        <div
          style={{
            height: '100vh',
            maxHeight: '100dvh',
            // Иначе длинный отчёт (вкладки + текст ниже) обрезается без прокрутки — кажется, что вкладки «не работают».
            overflowX: 'hidden',
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
          }}
        >
          <GameView
            currentUserId={user.id}
            viewerUser={user}
            onLogout={logout}
            showCaseTechnicalMetadata={isAdmin}
            appMenu={{
              username: user.username,
              role: user.role,
              isAdmin,
              showQaBugs,
              activeView: view,
              onNavigate: setView,
              onLogout: logout,
            }}
          />
        </div>
      )}
      {view === 'my-reports' && <MyReportsView onBack={() => setView('game')} />}
      {view === 'qa-bugs' && showQaBugs && <QaBugsView onBack={() => setView('game')} />}
      {view === 'admin' && <AdminView onLogout={logout} />}
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
