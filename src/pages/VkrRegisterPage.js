import React, { useState, useCallback } from 'react';
import logoMinimal from '../assets/logo_minimal.png';
import { getApiUrl, LOCAL_DEV_BACKEND_ORIGIN } from '../api/config';

export default function VkrRegisterPage({ login, onNavigateLogin }) {
  const [promoCode, setPromoCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [data, setData] = useState(null);

  const doRegister = useCallback(
    async (e) => {
      e.preventDefault();
      setError('');
      setSubmitting(true);
      setData(null);
      try {
        const res = await fetch(`${getApiUrl()}/auth/register-vkr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ promo_code: promoCode.trim() }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const d = err.detail;
          const errMsg = typeof d === 'string' ? d : d ? JSON.stringify(d) : res.statusText;
          throw new Error(errMsg || `Ошибка (HTTP ${res.status})`);
        }
        setData(await res.json());
      } catch (err) {
        const msg = err && err.message;
        if (msg === 'Load failed' || msg === 'Failed to fetch' || msg === 'NetworkError when attempting to fetch resource') {
          setError(
            `Не удалось подключиться к серверу. Запустите бэкенд (например: npm run backend:dev) — API ${LOCAL_DEV_BACKEND_ORIGIN}.`,
          );
        } else {
          setError(msg || 'Ошибка регистрации');
        }
      } finally {
        setSubmitting(false);
      }
    },
    [promoCode],
  );

  const doLogin = useCallback(async () => {
    if (!data) return;
    setError('');
    setSubmitting(true);
    try {
      await login(data.username, data.password);
    } catch (err) {
      setError(err.message || 'Ошибка входа');
    } finally {
      setSubmitting(false);
    }
  }, [data, login]);

  if (data) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-gradient-to-br from-amber-50 to-indigo-100">
        <div className="max-w-md w-full space-y-6">
          <div className="text-center">
            <img src={logoMinimal} alt="Симулекс" className="mx-auto mb-2 max-h-16 w-auto object-contain" />
            <p className="text-lg font-semibold text-gray-800">Учётная запись создана</p>
          </div>

          <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 text-amber-950 text-sm space-y-2">
            <p className="font-medium">Сохраните логин и пароль (например, в менеджере паролей).</p>
            <p className="text-amber-900/90">Восстановить сгенерированный пароль через эту форму нельзя. Сейчас он показан на экране — после ухода со страницы повторно его не увидеть.</p>
            {data.message && <p className="pt-1 text-amber-900/80">{data.message}</p>}
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>
          )}

          <div className="bg-white rounded-xl shadow-lg p-8 space-y-4">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Логин</p>
              <div className="flex gap-2 flex-wrap">
                <code className="flex-1 min-w-0 break-all rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-900">
                  {data.username}
                </code>
                <button
                  type="button"
                  className="shrink-0 px-3 py-2 text-sm font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50"
                  onClick={() => navigator.clipboard.writeText(data.username).catch(() => {})}
                >
                  Копировать
                </button>
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Пароль</p>
              <div className="flex gap-2 flex-wrap">
                <code className="flex-1 min-w-0 break-all rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-900">
                  {data.password}
                </code>
                <button
                  type="button"
                  className="shrink-0 px-3 py-2 text-sm font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50"
                  onClick={() => navigator.clipboard.writeText(data.password).catch(() => {})}
                >
                  Копировать
                </button>
              </div>
            </div>

            <button
              type="button"
              disabled={submitting}
              onClick={doLogin}
              className="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {submitting ? 'Вход…' : 'Сохранил(а) данные — войти'}
            </button>
          </div>

          <p className="text-center text-sm text-gray-600">
            <button
              type="button"
              className="text-indigo-600 hover:underline"
              onClick={() => onNavigateLogin && onNavigateLogin()}
            >
              К форме входа
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <img src={logoMinimal} alt="Симулекс" className="mx-auto mb-2 max-h-16 w-auto object-contain" />
          <p className="text-gray-600">Регистрация по промо-коду</p>
        </div>

        <form onSubmit={doRegister} className="bg-white rounded-xl shadow-lg p-8 space-y-6">
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>
          )}
          <div>
            <label htmlFor="promo" className="block text-sm font-medium text-gray-700 mb-1">
              Промо-код
            </label>
            <input
              id="promo"
              type="text"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value)}
              autoComplete="off"
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              placeholder="Введите промо-код"
            />
            <p className="mt-1 text-xs text-gray-500">Логин и пароль сгенерируются автоматически.</p>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {submitting ? 'Создание…' : 'Создать учётную запись'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-600 mt-4">
          <button type="button" className="text-indigo-600 hover:underline" onClick={() => onNavigateLogin && onNavigateLogin()}>
            Уже есть аккаунт — войти
          </button>
        </p>
      </div>
    </div>
  );
}
