import React from 'react';
import { getSummaryGrade } from '../utils/reportSummaryGrade';

export default function ReportScreen({ report, onRestart }) {
  if (!report) return null;

  const calculateScore = (lexic) => {
    const avg = (lexic.confidence + lexic.integrity + lexic.efficiency) / 3;
    return Math.round(avg);
  };

  const score = calculateScore(report.finalLexic);
  const g = getSummaryGrade(score);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="bg-white rounded-lg shadow p-8 mb-6">
          <div className="text-center mb-6">
            <h1 className="text-4xl font-bold text-gray-800 mb-2">
              {report.title}
            </h1>
            <p className="text-xl text-gray-600">{report.caseTitle}</p>
          </div>

          {/* Итог: словесный уровень (число только в расчёте) */}
          <div className="text-center py-8">
            <div
              className="inline-block px-8 py-4 rounded-full text-2xl md:text-3xl font-extrabold mb-2 border-2"
              style={{
                backgroundColor: g.pillBg,
                color: g.pillFg,
                borderColor: g.pillBorder,
              }}
            >
              {g.label}
            </div>
          </div>
        </div>

        {/* Statistics */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Completion Stats */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-bold mb-4">Статистика прохождения</h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span>Завершено этапов:</span>
                <span className="font-semibold">{report.completedStages}/{report.totalStages}</span>
              </div>
              <div className="flex justify-between">
                <span>Выполнено действий:</span>
                <span className="font-semibold">{report.actions}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full"
                  style={{ width: `${(report.completedStages / report.totalStages) * 100}%` }}
                ></div>
              </div>
            </div>
          </div>

          {/* Resources Used */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-bold mb-4">Использованные ресурсы</h2>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between mb-1">
                  <span>Время:</span>
                  <span className="font-semibold">{report.finalResources.time} ч.</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-yellow-500 h-2 rounded-full"
                    style={{ width: '70%' }}
                  ></div>
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span>Бюджет:</span>
                  <span className="font-semibold">${report.finalResources.money}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-green-500 h-2 rounded-full"
                    style={{ width: '60%' }}
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* LEXIC Parameters */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Параметры LEXIC</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Confidence */}
            <div>
              <div className="flex justify-between mb-2">
                <span className="font-semibold">Уверенность</span>
                <span>{report.finalLexic.confidence}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-blue-600 h-3 rounded-full"
                  style={{ width: `${report.finalLexic.confidence}%` }}
                ></div>
              </div>
            </div>

            {/* Integrity */}
            <div>
              <div className="flex justify-between mb-2">
                <span className="font-semibold">Соответствие</span>
                <span>{report.finalLexic.integrity}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-purple-600 h-3 rounded-full"
                  style={{ width: `${report.finalLexic.integrity}%` }}
                ></div>
              </div>
            </div>

            {/* Efficiency */}
            <div>
              <div className="flex justify-between mb-2">
                <span className="font-semibold">Эффективность</span>
                <span>{report.finalLexic.efficiency}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-green-600 h-3 rounded-full"
                  style={{ width: `${report.finalLexic.efficiency}%` }}
                ></div>
              </div>
            </div>
          </div>
        </div>

        {/* Recommendations */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Рекомендации</h2>
          <ul className="space-y-2">
            {report.recommendations.map((rec, idx) => (
              <li key={idx} className="flex items-start">
                <span className="mr-3">💡</span>
                <span>{rec}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Actions */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex gap-4 justify-center">
            <button
              onClick={onRestart}
              className="bg-blue-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-blue-700"
            >
              ← Вернуться в меню
            </button>
            <button
              onClick={() => window.print()}
              className="bg-gray-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-gray-700"
            >
              Печать отчета
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
