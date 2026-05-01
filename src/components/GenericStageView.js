/**
 * Универсальный компонент для этапов без специального UI
 * Используется для этапов, которые не имеют кастомного компонента
 */
import React from 'react';
import MarkdownContent from './MarkdownContent';

export default function GenericStageView({ 
  session, 
  stage, 
  onAction, 
  onComplete, 
  timeRemaining, 
  onBackToStart, 
  onFinishCase 
}) {
  // КРИТИЧЕСКАЯ ПРОВЕРКА: убеждаемся, что это действительно GenericStageView
  console.log('🎨 GenericStageView рендерится для этапа:', {
    stageId: stage?.id,
    stageType: stage?.type,
    stageTitle: stage?.title,
    actionsCount: stage?.actions?.length || 0
  });
  
  const stageActions = stage.actions?.filter(a => !session.actions_done.includes(a.id)) || [];
  const requiredNotDone = stage.actions?.filter(a => 
    a.is_required && !session.actions_done.includes(a.id)
  ) || [];
  
  console.log('🎨 GenericStageView - доступные действия:', {
    totalActions: stage.actions?.length || 0,
    availableActions: stageActions.length,
    requiredNotDone: requiredNotDone.length,
    actionIds: stageActions.map(a => a.id)
  });

  return (
    <div style={{ 
      padding: '20px 40px', 
      width: '100%',
      minHeight: 'calc(100vh - 140px)',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Stage Title */}
      <div style={{ 
        background: 'white', 
        padding: '15px', 
        borderRadius: '8px', 
        marginBottom: '20px', 
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        borderLeft: `4px solid ${stage.type === 'position' ? '#10b981' : stage.type === 'crisis' ? '#ef4444' : '#3b82f6'}`
      }}>
        <h2 style={{ margin: 0 }}>
          {stage.id && <span style={{ fontSize: '14px', color: '#666', marginRight: '10px' }}>{stage.id}</span>}
          {stage.title}
        </h2>
        {stage.type && (
          <div style={{ fontSize: '12px', color: '#999', marginTop: '5px' }}>
            Тип: {stage.type}
          </div>
        )}
      </div>

      {/* Stage Info */}
      <div style={{ background: '#dbeafe', padding: '20px', borderRadius: '8px', marginBottom: '20px', borderLeft: '4px solid #3b82f6' }}>
        {stage.content_md ? (
          <MarkdownContent content={stage.content_md} />
        ) : (
          <p style={{ margin: 0, color: '#666' }}>{stage.intro}</p>
        )}
        <p style={{ fontSize: '12px', color: '#999', margin: '10px 0 0 0' }}>
          Очки: {session.resources.points} | Требуется действий: {requiredNotDone.length}
        </p>
      </div>

      {/* Main Content */}
      <div style={{ 
        flex: 1, 
        display: 'flex', 
        flexDirection: 'column',
        minHeight: 'calc(100vh - 300px)'
      }}>
        <div style={{ 
          background: 'white', 
          padding: '40px', 
          borderRadius: '8px', 
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: '100%'
        }}>
          <h3 style={{ marginTop: 0 }}>📋 Доступные действия:</h3>
          {stageActions.length === 0 ? (
            <p style={{ color: '#666' }}>✓ Все доступные действия выполнены</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {stageActions.map(action => (
                <button
                  key={action.id}
                  onClick={() => onAction(action.id)}
                  style={{
                    padding: '15px',
                    textAlign: 'left',
                    background: '#3b82f6',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  ✓ {action.title}
                  {action.is_required && (
                    <span style={{ 
                      marginLeft: '10px', 
                      background: 'rgba(255,255,255,0.2)', 
                      padding: '2px 6px', 
                      borderRadius: '3px', 
                      fontSize: '12px' 
                    }}>
                      обязательно
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={onComplete}
            disabled={requiredNotDone.length > 0}
            style={{
              marginTop: '20px',
              padding: '12px 24px',
              background: requiredNotDone.length === 0 ? '#10b981' : '#ccc',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: requiredNotDone.length === 0 ? 'pointer' : 'not-allowed',
              fontWeight: 'bold',
              width: '100%'
            }}
          >
            {requiredNotDone.length > 0 
              ? `⏳ Завершить этап (осталось: ${requiredNotDone.length} обязательных)` 
              : '✅ Завершить этап →'}
          </button>
        </div>
      </div>
    </div>
  );
}
