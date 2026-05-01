import React, { useState } from 'react';

export default function ActionPanel({ action, onAction }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-lg overflow-hidden hover:shadow-md transition-shadow">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white p-4 flex justify-between items-center text-left"
      >
        <span className="font-semibold">{action.text}</span>
        <span className="text-xl">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="p-4 bg-gray-50 border-t">
          <div className="space-y-3 mb-4">
            {/* Impact Description */}
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Последствия:</p>
              <p className="text-gray-600 text-sm">{action.consequence}</p>
            </div>

            {/* Resources Impact */}
            {action.impact.resources !== 0 && (
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-1">Затраты ресурсов:</p>
                <p className={`text-sm ${action.impact.resources < 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {action.impact.resources < 0 ? '−' : '+'} {Math.abs(action.impact.resources)} единиц
                </p>
              </div>
            )}

            {/* LEXIC Impact */}
            {Object.keys(action.impact.lexic || {}).length > 0 && (
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">Влияние на LEXIC:</p>
                <div className="space-y-1">
                  {action.impact.lexic?.confidence > 0 && (
                    <p className="text-sm text-green-600">
                      ↑ Уверенность +{action.impact.lexic.confidence}
                    </p>
                  )}
                  {action.impact.lexic?.integrity > 0 && (
                    <p className="text-sm text-green-600">
                      ↑ Соответствие +{action.impact.lexic.integrity}
                    </p>
                  )}
                  {action.impact.lexic?.efficiency > 0 && (
                    <p className="text-sm text-green-600">
                      ↑ Эффективность +{action.impact.lexic.efficiency}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={onAction}
            className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded transition-colors"
          >
            ✓ Выполнить действие
          </button>
        </div>
      )}
    </div>
  );
}
