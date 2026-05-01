import React from 'react';

export default function TutorPanel({ isOpen, onToggle, currentStage, stageTitle, tips = [] }) {
  if (!isOpen) {
    return (
      <div style={{
        position: 'fixed',
        right: 0,
        top: '60px',
        width: '50px',
        height: '50px',
        zIndex: 999
      }}>
        <button
          onClick={onToggle}
          style={{
            width: '100%',
            height: '100%',
            background: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '8px 0 0 8px',
            cursor: 'pointer',
            fontSize: '20px',
            boxShadow: '-2px 0 4px rgba(0,0,0,0.1)'
          }}
          title="Открыть помощник"
        >
          💡
        </button>
      </div>
    );
  }

  // Подсказки по умолчанию для каждого этапа
  const defaultTips = {
    1: [
      'Внимательно изучайте документы - они содержат ключевую информацию',
      'Используйте вопросы по заметкам на карте сделки для уточнения деталей',
      'Не пропускайте важные документы - они могут повлиять на дальнейшие этапы',
      'Карта сделки поможет структурировать собранную информацию'
    ],
    2: [
      'Анализируйте риски перед формированием позиции',
      'Учитывайте все собранные данные из предыдущего этапа',
      'Балансируйте между защитой интересов и гибкостью',
      'Обращайте внимание на LEXIC параметры при выборе действий'
    ],
    3: [
      'Ведите конструктивный диалог с контрагентом',
      'Используйте обоснование для каждого решения',
      'Не принимайте все условия сразу - обсуждайте спорные моменты',
      'Следите за прогрессом согласования пунктов договора'
    ],
    4: [
      'Кризис требует быстрых и обдуманных решений',
      'Проверяйте почту - там может быть важная информация о кризисе',
      'Анализируйте последствия каждого действия',
      'Используйте накопленный опыт из предыдущих этапов'
    ]
  };

  const activeTips = tips.length > 0 ? tips : (defaultTips[currentStage] || []);

  return (
    <div style={{
      position: 'fixed',
      right: 0,
      top: '60px',
      width: '320px',
      height: 'calc(100vh - 60px)',
      background: 'white',
      boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
      zIndex: 999,
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        padding: '15px',
        borderBottom: '2px solid #3b82f6',
        background: '#eff6ff',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#1e40af' }}>
            💡 Помощник
          </div>
          {currentStage && (
            <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>
              Этап {currentStage}: {stageTitle || 'Текущий этап'}
            </div>
          )}
        </div>
        <button
          onClick={onToggle}
          style={{
            padding: '5px 10px',
            background: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px'
          }}
          title="Закрыть помощник"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '20px'
      }}>
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '10px', color: '#374151' }}>
            Подсказки для текущего этапа:
          </h3>
          <ul style={{ margin: 0, paddingLeft: '20px', listStyle: 'none' }}>
            {activeTips.map((tip, index) => (
              <li key={index} style={{
                marginBottom: '12px',
                padding: '10px',
                background: '#f0f9ff',
                borderRadius: '6px',
                borderLeft: '3px solid #3b82f6',
                fontSize: '13px',
                lineHeight: '1.5',
                color: '#374151'
              }}>
                {tip}
              </li>
            ))}
          </ul>
        </div>

        <div style={{
          marginTop: '20px',
          padding: '15px',
          background: '#fef3c7',
          borderRadius: '6px',
          borderLeft: '3px solid #f59e0b'
        }}>
          <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '5px', color: '#92400e' }}>
            💡 Совет
          </div>
          <div style={{ fontSize: '12px', color: '#78350f', lineHeight: '1.5' }}>
            Используйте почту для получения заданий и обратной связи. Следите за ресурсами и временем!
          </div>
        </div>

        {/* LEXIC параметры */}
        <div style={{
          marginTop: '20px',
          padding: '15px',
          background: '#eff6ff',
          borderRadius: '6px',
          borderLeft: '3px solid #3b82f6'
        }}>
          <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '10px', color: '#1e40af' }}>
            📊 Система параметров LEXIC
          </div>
          <div style={{ fontSize: '11px', color: '#1e3a8a', lineHeight: '1.6' }}>
            <div style={{ marginBottom: '6px' }}><strong>L - Легитимность:</strong> Соблюдение регламентов, процедур, сроков</div>
            <div style={{ marginBottom: '6px' }}><strong>E - Эффективность:</strong> Оптимальное использование ресурсов: время, бюджет</div>
            <div style={{ marginBottom: '6px' }}><strong>X - Экспертиза:</strong> Глубина анализа, качество оценки, работа с рисками</div>
            <div style={{ marginBottom: '6px' }}><strong>I - Интересы:</strong> Защита компании, баланс рисков, сохранение репутации</div>
            <div><strong>C - Ясность:</strong> Четкость изложения, структурированность, понятность для бизнеса</div>
          </div>
        </div>
      </div>
    </div>
  );
}
