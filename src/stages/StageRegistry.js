/**
 * Реестр компонентов этапов
 * Позволяет каждому этапу иметь свой UI компонент
 */
import Stage1View from '../components/Stage1View';
import Stage2View from '../components/Stage2View';
import Stage3View, { STAGE3_COMPONENTS } from '../components/Stage3View';
import Stage4View from '../components/Stage4View';
import GenericStageView from '../components/GenericStageView';

/**
 * Реестр компонентов этапов
 * Ключ: stage.id или stage.type
 * Значение: React компонент
 */
const STAGE_COMPONENTS = {
  // По ID этапа
  'stage-1': Stage1View,      // Лена
  'stage-2': Stage2View,      // Женя
  'stage-3': Stage3View,      // Даша
  'stage-4': Stage4View,      // Фарида
  
  // По типу этапа
  'context': Stage1View,
  'position': Stage2View,
  'negotiation': Stage3View,
  'crisis': Stage4View,
  /** Каркас платформы: простой этап без контента кейса */
  shell: GenericStageView,
};

/**
 * Дополнительные компоненты, привязанные к конкретным этапам.
 * Ключ: ID этапа, значение: объект-манифест (см. Stage3View.STAGE3_COMPONENTS).
 *
 * Используется как единая "точка правды" о всех UI-сущностях этапа.
 */
export const STAGE_EXTRA_COMPONENTS = {
  'stage-3': STAGE3_COMPONENTS,
};

/**
 * Получить компонент для этапа
 * @param {Object} stage - Данные этапа
 * @returns {React.Component} Компонент этапа
 */
export function getStageComponent(stage) {
  if (!stage) {
    console.warn('⚠️ getStageComponent: stage is null/undefined');
    return GenericStageView;
  }
  
  // Сначала проверяем по ID (приоритет выше)
  if (stage.id && STAGE_COMPONENTS[stage.id]) {
    return STAGE_COMPONENTS[stage.id];
  }
  // Затем по типу
  if (stage.type && STAGE_COMPONENTS[stage.type]) {
    return STAGE_COMPONENTS[stage.type];
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`⚠️ Компонент не найден для stage.id="${stage.id}", stage.type="${stage.type}", используем GenericStageView`);
  }
  return GenericStageView;
}

/**
 * Зарегистрировать новый компонент этапа
 * @param {string} key - ID этапа или тип этапа
 * @param {React.Component} component - React компонент
 */
export function registerStageComponent(key, component) {
  STAGE_COMPONENTS[key] = component;
}

/**
 * Получить список всех зарегистрированных этапов
 * @returns {Array<string>} Список ключей
 */
export function getRegisteredStages() {
  return Object.keys(STAGE_COMPONENTS);
}

export default {
  getStageComponent,
  registerStageComponent,
  getRegisteredStages,
};
