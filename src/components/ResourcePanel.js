import React from 'react';

export default function ResourcePanel({ resources }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-bold text-gray-800 mb-4">Ресурсы</h3>
      
      <div className="space-y-4">
        {/* Time */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="font-semibold text-gray-700">⏱️ Время</span>
            <span className="text-2xl font-bold text-blue-600">{resources.time || 0}</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all"
              style={{ width: `${Math.min((resources.time / 1000) * 100, 100)}%` }}
            ></div>
          </div>
          <p className="text-xs text-gray-500 mt-1">Часов доступно</p>
        </div>

        {/* Money */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="font-semibold text-gray-700">💰 Бюджет</span>
            <span className="text-2xl font-bold text-green-600">${resources.money || 0}</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-green-500 h-2 rounded-full transition-all"
              style={{ width: `${Math.min((resources.money / 500) * 100, 100)}%` }}
            ></div>
          </div>
          <p className="text-xs text-gray-500 mt-1">Рублей доступно</p>
        </div>
      </div>

      {/* Warning */}
      {(resources.time < 100 || resources.money < 50) && (
        <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded">
          <p className="text-sm text-yellow-800">
            ⚠️ Ресурсы заканчиваются! Планируйте действия тщательнее.
          </p>
        </div>
      )}
    </div>
  );
}
