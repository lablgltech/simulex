import React from 'react';
import ProgressBar from './ProgressBar';
import ResourcePanel from './ResourcePanel';
import LexicPanel from './LexicPanel';
import ActionPanel from './ActionPanel';

export default function GameplayScreen({
  caseData,
  currentStage,
  currentPhase,
  resources,
  lexic,
  onAction,
  onLogout
}) {
  if (!caseData) return null;

  const stage = caseData.stages[currentStage - 1];
  const phase = stage.phases[currentPhase - 1];

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-800">{caseData.title}</h1>
            <p className="text-gray-600 mt-1">{caseData.description}</p>
          </div>
          <button
            onClick={onLogout}
            className="bg-red-600 text-white px-6 py-2 rounded-lg hover:bg-red-700"
          >
            Выход
          </button>
        </div>

        {/* Progress */}
        <ProgressBar
          currentStage={currentStage}
          totalStages={caseData.stages.length}
          currentPhase={currentPhase}
          totalPhases={stage.phases.length}
        />

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 my-8">
          {/* Main Content */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg shadow p-6">
              <div className="mb-6">
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Этап {currentStage}: {stage.title}
                </h2>
                <p className="text-gray-600 mb-4">{stage.description}</p>
              </div>

              <div className="bg-blue-50 border-l-4 border-blue-600 p-4 mb-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-2">
                  Фаза {currentPhase}: {phase.title}
                </h3>
                <p className="text-gray-700">{phase.description}</p>
              </div>

              {/* Actions */}
              <div className="space-y-3">
                <h4 className="font-semibold text-gray-800">Возможные действия:</h4>
                {phase.actions.map(action => (
                  <ActionPanel
                    key={action.id}
                    action={action}
                    onAction={() => onAction(action.id, action.text)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Side Panels */}
          <div className="lg:col-span-2 space-y-6">
            <ResourcePanel resources={resources} />
            <LexicPanel lexic={lexic} />
          </div>
        </div>
      </div>
    </div>
  );
}
