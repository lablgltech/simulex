import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getAdminApiUrl, getAdminHeaders } from '../api/config';
import { handleApiError } from '../api/errorHandler';

/**
 * Визуальный редактор графа сущностей RAG.
 * Использует простую canvas-визуализацию с возможностью редактирования.
 */
export default function GraphEditor({ caseCode, stageCode }) {
  const [entities, setEntities] = useState([]);
  const [edges, setEdges] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [showCreateEntity, setShowCreateEntity] = useState(false);
  const [showCreateEdge, setShowCreateEdge] = useState(false);
  const [newEntity, setNewEntity] = useState({ entity_type: 'risk', name: '', description: '', case_code: caseCode || '', stage_code: stageCode || '' });
  const [newEdge, setNewEdge] = useState({ from_entity_id: '', to_entity_id: '', edge_type: 'relates_to', weight: 1.0 });
  const canvasRef = useRef(null);
  const [positions, setPositions] = useState({}); // {entity_id: {x, y}}
  const [dragging, setDragging] = useState(null);
  const [filterEntityType, setFilterEntityType] = useState(''); // Фильтр по типу сущности
  const [groupByType, setGroupByType] = useState(true); // Группировать по типам
  const [showUniqueOnly, setShowUniqueOnly] = useState(true); // Показывать только уникальные названия

  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (caseCode) params.append('case_code', caseCode);
      if (stageCode) params.append('stage_code', stageCode);
      
      const [entitiesRes, edgesRes] = await Promise.all([
        fetch(`${getAdminApiUrl()}/rag/graph/entities?${params}`, { credentials: 'include', headers: getAdminHeaders() }),
        fetch(`${getAdminApiUrl()}/rag/graph/edges?${params}`, { credentials: 'include', headers: getAdminHeaders() }),
      ]);
      
      if (!entitiesRes.ok) throw new Error(await entitiesRes.text());
      if (!edgesRes.ok) throw new Error(await edgesRes.text());
      
      const entitiesData = await entitiesRes.json();
      const edgesData = await edgesRes.json();
      
      // Фильтруем и дедуплицируем сущности
      let filteredEntities = entitiesData.entities || [];
      
      // Фильтр по типу
      if (filterEntityType) {
        filteredEntities = filteredEntities.filter(e => e.entity_type === filterEntityType);
      }
      
      // Дедупликация по названию (показываем только уникальные)
      if (showUniqueOnly) {
        const seen = new Set();
        filteredEntities = filteredEntities.filter(e => {
          const key = `${e.entity_type}:${e.name.toLowerCase().trim()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      
      setEntities(filteredEntities);
      setEdges(edgesData.edges || []);
      
      // Инициализируем позиции для новых сущностей с группировкой по типам
      const newPositions = { ...positions };
      
      // Группируем сущности по типам
      const entitiesByType = {};
      entitiesData.entities?.forEach((entity) => {
        if (!entitiesByType[entity.entity_type]) {
          entitiesByType[entity.entity_type] = [];
        }
        entitiesByType[entity.entity_type].push(entity);
      });
      
      // Располагаем группы по секторам
      const typeOrder = ['risk', 'clause', 'obligation', 'consequence', 'action'];
      const typeColors = {
        risk: '#dc2626',
        clause: '#3b82f6',
        consequence: '#f59e0b',
        obligation: '#8b5cf6',
        action: '#10b981',
      };
      
      let globalIdx = 0;
      Object.keys(entitiesByType).forEach((entityType, typeIdx) => {
        const typeEntities = entitiesByType[entityType];
        const typePos = typeOrder.indexOf(entityType);
        const sectorAngle = (2 * Math.PI) / Math.max(typeOrder.length, Object.keys(entitiesByType).length);
        const startAngle = typePos >= 0 ? typePos * sectorAngle : typeIdx * sectorAngle;
        
        typeEntities.forEach((entity, idx) => {
          if (!newPositions[entity.id]) {
            // Располагаем в секторе для этого типа
            const angleInSector = (idx / typeEntities.length) * sectorAngle * 0.7; // 70% сектора
            const angle = startAngle + angleInSector + sectorAngle * 0.15; // Центрируем в секторе
            const radius = 180 + (idx % 3) * 40; // Несколько концентрических кругов
            newPositions[entity.id] = {
              x: 400 + radius * Math.cos(angle),
              y: 300 + radius * Math.sin(angle),
            };
          }
          globalIdx++;
        });
      });
      
      setPositions(newPositions);
    } catch (err) {
      handleApiError(err, false);
    } finally {
      setLoading(false);
    }
  }, [caseCode, stageCode, filterEntityType, showUniqueOnly]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const handleCreateEntity = useCallback(async () => {
    try {
      const res = await fetch(`${getAdminApiUrl()}/rag/graph/entities`, {
        method: 'POST',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify(newEntity),
      });
      
      if (!res.ok) throw new Error(await res.text());
      await loadGraph();
      setShowCreateEntity(false);
      setNewEntity({ entity_type: 'risk', name: '', description: '', case_code: caseCode || '', stage_code: stageCode || '' });
    } catch (err) {
      handleApiError(err, false);
    }
  }, [newEntity, caseCode, stageCode, loadGraph]);

  const handleCreateEdge = useCallback(async () => {
    try {
      const res = await fetch(`${getAdminApiUrl()}/rag/graph/edges`, {
        method: 'POST',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify(newEdge),
      });
      
      if (!res.ok) throw new Error(await res.text());
      await loadGraph();
      setShowCreateEdge(false);
      setNewEdge({ from_entity_id: '', to_entity_id: '', edge_type: 'relates_to', weight: 1.0 });
    } catch (err) {
      handleApiError(err, false);
    }
  }, [newEdge, loadGraph]);

  const handleDeleteEntity = useCallback(async (entityId) => {
    if (!confirm('Удалить сущность? Все связанные связи также будут удалены.')) return;
    
    try {
      const res = await fetch(`${getAdminApiUrl()}/rag/graph/entities/${entityId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: getAdminHeaders(),
      });
      
      if (!res.ok) throw new Error(await res.text());
      await loadGraph();
      setSelectedEntity(null);
    } catch (err) {
      handleApiError(err, false);
    }
  }, [loadGraph]);

  const handleDeleteEdge = useCallback(async (edgeId) => {
    try {
      const res = await fetch(`${getAdminApiUrl()}/rag/graph/edges/${edgeId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: getAdminHeaders(),
      });
      
      if (!res.ok) throw new Error(await res.text());
      await loadGraph();
      setSelectedEdge(null);
    } catch (err) {
      handleApiError(err, false);
    }
  }, [loadGraph]);

  const drawGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Рисуем сетку для ориентира
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i < canvas.width; i += 50) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, canvas.height);
      ctx.stroke();
    }
    for (let i = 0; i < canvas.height; i += 50) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(canvas.width, i);
      ctx.stroke();
    }
    
    // Рисуем связи (стрелки)
    edges.forEach((edge) => {
      const fromPos = positions[edge.from_entity_id];
      const toPos = positions[edge.to_entity_id];
      if (!fromPos || !toPos) return;
      
      // Пропускаем связи для сущностей, которых нет в текущем отображении
      if (!entities.find(e => e.id === edge.from_entity_id) || 
          !entities.find(e => e.id === edge.to_entity_id)) {
        return;
      }
      
      ctx.strokeStyle = edge.edge_type === 'causes' ? '#dc2626' : 
                       edge.edge_type === 'mitigates' ? '#10b981' : '#6b7280';
      ctx.lineWidth = Math.max(1, edge.weight || 1);
      ctx.beginPath();
      ctx.moveTo(fromPos.x, fromPos.y);
      ctx.lineTo(toPos.x, toPos.y);
      ctx.stroke();
      
      // Стрелка
      const angle = Math.atan2(toPos.y - fromPos.y, toPos.x - fromPos.x);
      const arrowLength = 8;
      const arrowAngle = Math.PI / 6;
      
      ctx.beginPath();
      ctx.moveTo(toPos.x, toPos.y);
      ctx.lineTo(
        toPos.x - arrowLength * Math.cos(angle - arrowAngle),
        toPos.y - arrowLength * Math.sin(angle - arrowAngle)
      );
      ctx.moveTo(toPos.x, toPos.y);
      ctx.lineTo(
        toPos.x - arrowLength * Math.cos(angle + arrowAngle),
        toPos.y - arrowLength * Math.sin(angle + arrowAngle)
      );
      ctx.stroke();
      
      // Подпись типа связи (только для важных типов)
      if (edge.edge_type !== 'relates_to') {
        const midX = (fromPos.x + toPos.x) / 2;
        const midY = (fromPos.y + toPos.y) / 2;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillRect(midX - 25, midY - 8, 50, 14);
        ctx.fillStyle = '#374151';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        const labels = {
          causes: '→',
          mitigates: '↓',
          requires: '→',
        };
        ctx.fillText(labels[edge.edge_type] || edge.edge_type, midX, midY + 3);
      }
    });
    
    // Рисуем сущности
    entities.forEach((entity) => {
      const pos = positions[entity.id];
      if (!pos) return;
      
      const isSelected = selectedEntity?.id === entity.id;
      const colors = {
        risk: '#dc2626',
        clause: '#3b82f6',
        consequence: '#f59e0b',
        obligation: '#8b5cf6',
        action: '#10b981',
      };
      
      ctx.fillStyle = colors[entity.entity_type] || '#6b7280';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, isSelected ? 18 : 15, 0, 2 * Math.PI);
      ctx.fill();
      
      if (isSelected) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      
      // Подпись (только если название не слишком длинное или уникальное)
      const displayName = entity.name.length > 20 
        ? entity.name.substring(0, 17) + '...' 
        : entity.name;
      
      // Фон для текста для читаемости
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(pos.x - 40, pos.y + 18, 80, 14);
      
      ctx.fillStyle = '#000';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(displayName, pos.x, pos.y + 28);
    });
  }, [entities, edges, positions, selectedEntity]);

  useEffect(() => {
    drawGraph();
  }, [drawGraph]);

  const handleCanvasMouseDown = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Проверяем клик по сущности
    for (const entity of entities) {
      const pos = positions[entity.id];
      if (!pos) continue;
      
      const dist = Math.sqrt((x - pos.x) ** 2 + (y - pos.y) ** 2);
      if (dist <= 18) {
        setSelectedEntity(entity);
        setDragging(entity.id);
        return;
      }
    }
    
    setSelectedEntity(null);
    setSelectedEdge(null);
  };

  const handleCanvasMouseMove = (e) => {
    if (!dragging) return;
    
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setPositions((prev) => ({
      ...prev,
      [dragging]: { x, y },
    }));
  };

  const handleCanvasMouseUp = () => {
    setDragging(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 style={{ margin: 0 }}>Граф сущностей</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setShowCreateEntity(true)}
            style={{ padding: '6px 12px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
          >
            + Сущность
          </button>
          <button
            onClick={() => setShowCreateEdge(true)}
            disabled={entities.length < 2}
            style={{ padding: '6px 12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: entities.length < 2 ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: entities.length < 2 ? 0.5 : 1 }}
          >
            + Связь
          </button>
          <button
            onClick={loadGraph}
            disabled={loading}
            style={{ padding: '6px 12px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '4px', cursor: loading ? 'not-allowed' : 'pointer', fontSize: '13px' }}
          >
            {loading ? 'Загрузка...' : 'Обновить'}
          </button>
        </div>
      </div>

      {/* Фильтры и настройки */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '12px', padding: '12px', background: '#f3f4f6', borderRadius: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', fontWeight: '500' }}>Фильтр по типу:</label>
          <select
            value={filterEntityType}
            onChange={(e) => setFilterEntityType(e.target.value)}
            style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px' }}
          >
            <option value="">Все типы</option>
            <option value="risk">Риск</option>
            <option value="clause">Пункт договора</option>
            <option value="consequence">Последствие</option>
            <option value="obligation">Обязательство</option>
            <option value="action">Действие</option>
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input
            type="checkbox"
            id="uniqueOnly"
            checked={showUniqueOnly}
            onChange={(e) => setShowUniqueOnly(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          <label htmlFor="uniqueOnly" style={{ fontSize: '13px', cursor: 'pointer' }}>
            Только уникальные названия
          </label>
        </div>
        <div style={{ fontSize: '13px', color: '#6b7280', marginLeft: 'auto' }}>
          Показано: {entities.length} сущностей
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '16px', flex: 1 }}>
        <div style={{ position: 'relative', border: '1px solid #e5e7eb', borderRadius: '8px', background: '#f9fafb' }}>
          <canvas
            ref={canvasRef}
            width={800}
            height={600}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            style={{ cursor: dragging ? 'grabbing' : 'grab', width: '100%', height: '100%' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {selectedEntity && (
            <div style={{ background: 'white', padding: '12px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ margin: 0, fontSize: '14px' }}>Сущность</h4>
                <button
                  onClick={() => handleDeleteEntity(selectedEntity.id)}
                  style={{ padding: '4px 8px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
                >
                  Удалить
                </button>
              </div>
              <div style={{ fontSize: '12px', color: '#374151' }}>
                <div><strong>Тип:</strong> {selectedEntity.entity_type}</div>
                <div><strong>Название:</strong> {selectedEntity.name}</div>
                {selectedEntity.description && <div><strong>Описание:</strong> {selectedEntity.description.substring(0, 100)}</div>}
                {selectedEntity.case_code && <div><strong>Кейс:</strong> {selectedEntity.case_code}</div>}
                {selectedEntity.stage_code && <div><strong>Этап:</strong> {selectedEntity.stage_code}</div>}
              </div>
            </div>
          )}

          <div style={{ background: 'white', padding: '12px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Легенда</h4>
            <div style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#dc2626' }} />
                <span>Риск ({entities.filter(e => e.entity_type === 'risk').length})</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#3b82f6' }} />
                <span>Пункт договора ({entities.filter(e => e.entity_type === 'clause').length})</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#f59e0b' }} />
                <span>Последствие ({entities.filter(e => e.entity_type === 'consequence').length})</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#8b5cf6' }} />
                <span>Обязательство ({entities.filter(e => e.entity_type === 'obligation').length})</span>
              </div>
              {entities.filter(e => e.entity_type === 'action').length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#10b981' }} />
                  <span>Действие ({entities.filter(e => e.entity_type === 'action').length})</span>
                </div>
              )}
            </div>
          </div>
          
          {/* Статистика */}
          <div style={{ background: 'white', padding: '12px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Статистика</h4>
            <div style={{ fontSize: '12px', color: '#374151', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div>Всего сущностей: <strong>{entities.length}</strong></div>
              <div>Связей: <strong>{edges.length}</strong></div>
              {caseCode && <div>Кейс: <strong>{caseCode}</strong></div>}
              {stageCode && <div>Этап: <strong>{stageCode}</strong></div>}
            </div>
          </div>
        </div>
      </div>

      {showCreateEntity && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', maxWidth: '500px', width: '90%' }}>
            <h3 style={{ marginTop: 0 }}>Создать сущность</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Тип:</label>
                <select
                  value={newEntity.entity_type}
                  onChange={(e) => setNewEntity({ ...newEntity, entity_type: e.target.value })}
                  style={{ width: '100%', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                >
                  <option value="risk">Риск</option>
                  <option value="clause">Пункт договора</option>
                  <option value="consequence">Последствие</option>
                  <option value="obligation">Обязательство</option>
                  <option value="action">Действие</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Название:</label>
                <input
                  type="text"
                  value={newEntity.name}
                  onChange={(e) => setNewEntity({ ...newEntity, name: e.target.value })}
                  style={{ width: '100%', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Описание:</label>
                <textarea
                  value={newEntity.description}
                  onChange={(e) => setNewEntity({ ...newEntity, description: e.target.value })}
                  rows={3}
                  style={{ width: '100%', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowCreateEntity(false)} style={{ padding: '6px 12px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                  Отмена
                </button>
                <button onClick={handleCreateEntity} disabled={!newEntity.name.trim()} style={{ padding: '6px 12px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: !newEntity.name.trim() ? 'not-allowed' : 'pointer' }}>
                  Создать
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCreateEdge && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', maxWidth: '500px', width: '90%' }}>
            <h3 style={{ marginTop: 0 }}>Создать связь</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>От сущности:</label>
                <select
                  value={newEdge.from_entity_id}
                  onChange={(e) => setNewEdge({ ...newEdge, from_entity_id: e.target.value })}
                  style={{ width: '100%', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                >
                  <option value="">Выберите...</option>
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} ({e.entity_type})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>К сущности:</label>
                <select
                  value={newEdge.to_entity_id}
                  onChange={(e) => setNewEdge({ ...newEdge, to_entity_id: e.target.value })}
                  style={{ width: '100%', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                >
                  <option value="">Выберите...</option>
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} ({e.entity_type})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Тип связи:</label>
                <select
                  value={newEdge.edge_type}
                  onChange={(e) => setNewEdge({ ...newEdge, edge_type: e.target.value })}
                  style={{ width: '100%', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                >
                  <option value="relates_to">Связано с</option>
                  <option value="causes">Вызывает</option>
                  <option value="mitigates">Смягчает</option>
                  <option value="references">Ссылается на</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Вес:</label>
                <input
                  type="number"
                  value={newEdge.weight}
                  onChange={(e) => setNewEdge({ ...newEdge, weight: parseFloat(e.target.value) || 1.0 })}
                  min="0"
                  max="10"
                  step="0.1"
                  style={{ width: '100%', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowCreateEdge(false)} style={{ padding: '6px 12px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                  Отмена
                </button>
                <button
                  onClick={handleCreateEdge}
                  disabled={!newEdge.from_entity_id || !newEdge.to_entity_id || newEdge.from_entity_id === newEdge.to_entity_id}
                  style={{ padding: '6px 12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: !newEdge.from_entity_id || !newEdge.to_entity_id || newEdge.from_entity_id === newEdge.to_entity_id ? 'not-allowed' : 'pointer' }}
                >
                  Создать
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
