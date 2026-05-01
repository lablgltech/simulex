import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getApiUrl, LOCAL_DEV_BACKEND_ORIGIN } from '../api/config';
import {
  activeGameSessionLocalKey,
  clearObsoleteSimulatorTourSkipKeys,
  LEGACY_ACTIVE_SESSION_LOCAL_KEY,
} from '../config/simulatorTourSteps';

const STORAGE_TOKEN = 'simulex_auth_token';
const STORAGE_USER = 'simulex_auth_user';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(() => localStorage.getItem(STORAGE_TOKEN));
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_USER);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(!!token);

  const setToken = useCallback((newToken) => {
    if (newToken) {
      localStorage.setItem(STORAGE_TOKEN, newToken);
      setTokenState(newToken);
    } else {
      localStorage.removeItem(STORAGE_TOKEN);
      localStorage.removeItem(STORAGE_USER);
      setTokenState(null);
      setUser(null);
    }
  }, []);

  const fetchMe = useCallback(async (authToken) => {
    const res = await fetch(`${getApiUrl()}/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
      credentials: 'include',
    });
    if (!res.ok) return null;
    return res.json();
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const data = await fetchMe(token);
      if (!cancelled && data) {
        setUser(data);
        localStorage.setItem(STORAGE_USER, JSON.stringify(data));
        clearObsoleteSimulatorTourSkipKeys(data.id);
      } else if (!cancelled) {
        setToken(null);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [token, fetchMe, setToken]);

  const login = useCallback(async (username, password) => {
    let res;
    try {
      res = await fetch(`${getApiUrl()}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
    } catch (networkErr) {
      const msg = networkErr && networkErr.message;
      if (msg === 'Load failed' || msg === 'Failed to fetch' || msg === 'NetworkError when attempting to fetch resource') {
        throw new Error(
          `Не удалось подключиться к серверу. Запустите бэкенд (из корня репозитория: npm run backend:dev) — API на ${LOCAL_DEV_BACKEND_ORIGIN}.`
        );
      }
      throw new Error(msg || 'Ошибка сети. Проверьте, что бекенд запущен.');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const d = err.detail;
      let errMsg = typeof d === 'string' ? d : Array.isArray(d) ? (d.map((x) => x.msg || x.loc).join(', ') || '') : (d || '');
      if (!errMsg) {
        errMsg = res.status === 502 || res.status === 504
          ? `Сервер недоступен (${res.status}). Запустите бэкенд: из корня npm run backend:dev (uvicorn на ${LOCAL_DEV_BACKEND_ORIGIN}, см. proxy в package.json).`
          : `Ошибка входа (HTTP ${res.status}). Проверьте логин и пароль; в dev бэкенд должен отвечать на ${LOCAL_DEV_BACKEND_ORIGIN}.`;
      }
      throw new Error(errMsg);
    }
    const data = await res.json();
    setToken(data.access_token);
    setUser(data.user);
    localStorage.setItem(STORAGE_USER, JSON.stringify(data.user));
    try {
      localStorage.removeItem(LEGACY_ACTIVE_SESSION_LOCAL_KEY);
    } catch (_) {}
    clearObsoleteSimulatorTourSkipKeys(data.user?.id);
    return data.user;
  }, [setToken]);

  const logout = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_USER);
      const u = raw ? JSON.parse(raw) : null;
      const uid = u?.id;
      if (uid != null && !Number.isNaN(Number(uid))) {
        localStorage.removeItem(activeGameSessionLocalKey(Number(uid)));
      }
      localStorage.removeItem(LEGACY_ACTIVE_SESSION_LOCAL_KEY);
    } catch (_) {}
    setToken(null);
  }, [setToken]);

  const value = {
    token,
    user,
    loading,
    login,
    logout,
    isAdmin: user && (user.role === 'admin' || user.role === 'superuser'),
    isSuperuser: user && user.role === 'superuser',
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
