import React from 'react';
import ParticipantReport from './ParticipantReport';

/**
 * Обёртка над единственным форматом отчёта — ParticipantReport.
 */
export default function ReportView({
  report,
  onRestart,
  onBackToStart,
  showRestart = true,
  viewerUser,
  showParticipantStageTabs = false,
}) {
  if (!report) return null;
  return (
    <ParticipantReport
      report={report}
      onRestart={showRestart ? onRestart : undefined}
      onBackToStart={onBackToStart}
      viewerUser={viewerUser}
      showParticipantStageTabs={showParticipantStageTabs}
    />
  );
}
