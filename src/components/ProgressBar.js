import React from 'react';

export default function ProgressBar({ currentStage, totalStages, currentPhase, totalPhases }) {
  const stageProgress = ((currentStage - 1) / totalStages) * 100;

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-semibold text-gray-700">Прогресс кейса</h3>
          <span className="text-sm text-gray-600">
            Этап {currentStage} из {totalStages}
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-3">
          <div
            className="bg-blue-600 h-3 rounded-full transition-all"
            style={{ width: `${stageProgress}%` }}
          ></div>
        </div>
      </div>

      <div className="flex justify-between items-center">
        {Array.from({ length: totalStages }).map((_, idx) => (
          <div key={idx} className="flex flex-col items-center">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center mb-2 ${
                idx + 1 <= currentStage
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-300 text-gray-600'
              }`}
            >
              {idx + 1}
            </div>
            <span className="text-xs text-gray-600 text-center">
              Этап {idx + 1}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 text-center text-sm text-gray-600">
        Фаза {currentPhase} из {totalPhases}
      </div>
    </div>
  );
}
