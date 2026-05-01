import React, { useState, useEffect } from 'react';

/**
 * Компонент для выбора этапов при создании кейса
 * Позволяет выбрать какие этапы включить (1, 2, 3, 4 или любую комбинацию)
 */
export default function StageSelector({ 
  selectedStages = [], 
  onStagesChange, 
  onCancel, 
  onConfirm 
}) {
  const [templates, setTemplates] = useState(null);
  const [localSelected, setLocalSelected] = useState(selectedStages);
  const [stageConfigs, setStageConfigs] = useState({});

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      // Пытаемся загрузить из public (для продакшена) или data (для разработки)
      let response = await fetch('/stage-templates.json');
      if (!response.ok) {
        // Fallback для разработки
        response = await fetch('/data/stage-templates.json');
      }
      const data = await response.json();
      setTemplates(data.templates);
      
      // Инициализируем конфигурации для выбранных этапов
      const initialConfigs = {};
      selectedStages.forEach(stageId => {
        if (data.templates[stageId]) {
          initialConfigs[stageId] = {
            points_budget: data.templates[stageId].points_budget,
            preserve_lexic: true,
            preserve_resources: false
          };
        }
      });
      setStageConfigs(initialConfigs);
    } catch (error) {
      console.error('Ошибка загрузки шаблонов:', error);
    }
  };

  const availableStages = [
    { id: 'stage-1', name: 'Этап 1: Выявление контекста', type: 'context' },
    { id: 'stage-2', name: 'Этап 2: Формирование позиции и выявление рисков', type: 'position' },
    { id: 'stage-3', name: 'Этап 3: Согласование и переговоры', type: 'negotiation' },
    { id: 'stage-4', name: 'Этап 4: Кризис и последствия', type: 'crisis' }
  ];

  const toggleStage = (stageId) => {
    const newSelected = localSelected.includes(stageId)
      ? localSelected.filter(id => id !== stageId)
      : [...localSelected, stageId].sort();
    
    setLocalSelected(newSelected);
    
    // Добавляем конфигурацию для нового этапа
    if (!localSelected.includes(stageId) && templates?.[stageId]) {
      setStageConfigs(prev => ({
        ...prev,
        [stageId]: {
          points_budget: templates[stageId].points_budget,
          preserve_lexic: true,
          preserve_resources: false
        }
      }));
    } else if (localSelected.includes(stageId)) {
      // Удаляем конфигурацию при снятии выбора
      setStageConfigs(prev => {
        const newConfigs = { ...prev };
        delete newConfigs[stageId];
        return newConfigs;
      });
    }
  };

  const updateStageConfig = (stageId, field, value) => {
    setStageConfigs(prev => ({
      ...prev,
      [stageId]: {
        ...prev[stageId],
        [field]: value
      }
    }));
  };

  const handleConfirm = () => {
    // Создаем массив этапов с правильным порядком
    const orderedStages = localSelected.map((stageId, index) => {
      const template = templates?.[stageId];
      if (!template) return null;
      
      const config = stageConfigs[stageId] || {};
      
      return {
        id: stageId,
        order: index + 1,
        order_index: index + 1,
        type: template.type,
        title: template.title,
        intro: template.intro,
        points_budget: config.points_budget || template.points_budget,
        actions: template.default_actions ? [...template.default_actions] : [],
        preserve_lexic: config.preserve_lexic !== undefined ? config.preserve_lexic : true,
        preserve_resources: config.preserve_resources !== undefined ? config.preserve_resources : false
      };
    }).filter(Boolean);

    onConfirm(orderedStages, stageConfigs);
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000
    }}>
      <div style={{
        background: 'white',
        padding: '30px',
        borderRadius: '8px',
        maxWidth: '800px',
        maxHeight: '90vh',
        overflow: 'auto',
        boxShadow: '0 10px 25px rgba(0,0,0,0.2)'
      }}>
        <h2 style={{ marginTop: 0, marginBottom: '20px' }}>📋 Выбор этапов для кейса</h2>
        
        <p style={{ color: '#666', marginBottom: '20px' }}>
          Выберите этапы, которые будут включены в кейс. Можно выбрать от 1 до 4 этапов в любом порядке.
        </p>

        <div style={{ marginBottom: '20px' }}>
          {availableStages.map(stage => {
            const isSelected = localSelected.includes(stage.id);
            const template = templates?.[stage.id];
            
            return (
              <div key={stage.id} style={{
                marginBottom: '15px',
                padding: '15px',
                border: `2px solid ${isSelected ? '#3b82f6' : '#e5e7eb'}`,
                borderRadius: '8px',
                background: isSelected ? '#eff6ff' : '#f9fafb',
                cursor: 'pointer'
              }}
              onClick={() => toggleStage(stage.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: isSelected ? '10px' : '0' }}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleStage(stage.id)}
                    style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '16px' }}>{stage.name}</div>
                    {template && (
                      <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                        {template.default_actions?.length || 0} действий по умолчанию
                      </div>
                    )}
                  </div>
                </div>

                {isSelected && template && (
                  <div style={{ marginTop: '15px', padding: '15px', background: 'white', borderRadius: '4px' }}>
                    <div style={{ marginBottom: '10px' }}>
                      <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                        Бюджет очков:
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={stageConfigs[stage.id]?.points_budget || template.points_budget}
                        onChange={(e) => updateStageConfig(stage.id, 'points_budget', parseInt(e.target.value) || template.points_budget)}
                        style={{ width: '100px', padding: '5px', border: '1px solid #ccc', borderRadius: '4px' }}
                      />
                    </div>
                    
                    <div style={{ marginBottom: '10px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={stageConfigs[stage.id]?.preserve_lexic !== false}
                          onChange={(e) => updateStageConfig(stage.id, 'preserve_lexic', e.target.checked)}
                        />
                        <span>Сохранить параметры LEXIC из предыдущего этапа</span>
                      </label>
                    </div>
                    
                    <div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={stageConfigs[stage.id]?.preserve_resources === true}
                          onChange={(e) => updateStageConfig(stage.id, 'preserve_resources', e.target.checked)}
                        />
                        <span>Сохранить ресурсы (кредиты и время) из предыдущего этапа</span>
                      </label>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {localSelected.length === 0 && (
          <div style={{ 
            padding: '15px', 
            background: '#fef3c7', 
            borderRadius: '4px', 
            marginBottom: '20px',
            color: '#92400e'
          }}>
            ⚠️ Выберите хотя бы один этап
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '10px 20px',
              background: '#f3f4f6',
              color: '#374151',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            Отмена
          </button>
          <button
            onClick={handleConfirm}
            disabled={localSelected.length === 0}
            style={{
              padding: '10px 20px',
              background: localSelected.length === 0 ? '#d1d5db' : '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: localSelected.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              fontWeight: 'bold'
            }}
          >
            ✅ Подтвердить ({localSelected.length} этапов)
          </button>
        </div>
      </div>
    </div>
  );
}
