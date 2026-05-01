import React from 'react';

export default function RoleSelector({ onRoleSelect }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="max-w-4xl w-full">
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold text-gray-800 mb-4">
            🎓 Симулекс
          </h1>
          <p className="text-xl text-gray-600">
            Юридический кейс-симулятор
          </p>
          <p className="text-gray-500 mt-2">
            Версия 0.1 MVP
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 mb-12">
          {/* Player Role */}
          <button
            onClick={() => onRoleSelect('player')}
            className="bg-white rounded-lg shadow-lg p-8 hover:shadow-2xl transition-all transform hover:scale-105 text-left"
          >
            <div className="text-center">
              <div className="text-6xl mb-4">⚖️</div>
              <h2 className="text-2xl font-bold text-gray-800 mb-4">
                Участник
              </h2>
              <p className="text-gray-600 mb-6">
                Проходите интерактивные кейсы и развивайте навыки
              </p>
              <div className="flex justify-center">
                <div className="bg-blue-600 text-white px-8 py-3 rounded-lg font-semibold">
                  К симуляции →
                </div>
              </div>
            </div>
          </button>

          {/* Admin Role */}
          <button
            onClick={() => onRoleSelect('admin')}
            className="bg-white rounded-lg shadow-lg p-8 hover:shadow-2xl transition-all transform hover:scale-105 text-left"
          >
            <div className="text-center">
              <div className="text-6xl mb-4">⚙️</div>
              <h2 className="text-2xl font-bold text-gray-800 mb-4">
                Администратор
              </h2>
              <p className="text-gray-600 mb-6">
                Создавайте и редактируйте кейсы
              </p>
              <div className="flex justify-center">
                <div className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold">
                  Открыть админку →
                </div>
              </div>
            </div>
          </button>
        </div>

        <div className="bg-white rounded-lg shadow p-6 text-center text-gray-600">
          <p>
            Версия 0.1 MVP • Дата: 24 января 2026
          </p>
        </div>
      </div>
    </div>
  );
}
