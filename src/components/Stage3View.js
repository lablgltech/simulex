/**
 * Этап 3: Согласование — фронтенд-ядро переговорного модуля.
 *
 * Этот компонент — единственная "официальная" точка входа во фронтовую
 * механику этапа 3. Всё, что связано с документом и чатом на этом этапе,
 * стекается сюда:
 *
 * 1) Инициализация сессии переговоров:
 *    - при монтировании `Stage3View` вызывает
 *      `negotiationSessionAPI.start(session, 'dogovor_PO')`;
 *    - backend по этому запросу создаёт/находит:
 *        * общую сессию игрока (game_session, уже создана ранее);
 *        * сессию этапа 3 (stage_session с stage_code="stage-3");
 *        * "сессию переговоров" (negotiation_session), в которой живут:
 *          история чата, статусы пунктов, замены текста.
 *    - в ответ приходит `negotiation_session_id`, который мы храним в состоянии
 *      и передаём дальше в дочерние компоненты.
 *
 * 2) Документ (левая колонка):
 *    - `NegotiationDocumentFrame`:
 *        * ходит в `/api/document/session/{negotiation_session_id}/clauses`;
 *        * показывает пункты договора (gameData из dogovor_PO / software);
 *        * подсвечивает статусы (AVAILABLE/SELECTED/NO_EDITS/...);
 *        * считает прогресс обсуждения и зовёт `onProgressUpdate`.
 *
 * 3) Чат (правая колонка):
 *    - `NegotiationChatFrame`:
 *        * использует `/api/chat/session/{id}/...` для:
 *            - активации чата по пункту (`activate`);
 *            - отправки выбора игрока/оправдания (`message`);
 *            - загрузки истории (`history`);
 *        * хранит историю сообщений и отображает ответы бота / ИИ.
 *
 * 4) Управление этапом:
 *    - `Stage3View`:
 *        * решает, какой пункт выбран (`selectedClause`);
 *        * управляет состоянием чата (`chatActive`, `chatAction`, `chatComplete`);
 *        * считает прогресс по согласованным пунктам и показывает кнопку
 *          "Завершить этап" (общая механика Симулекса).
 *    - Согласованная редакция в договоре на бэкенде очищается от разговорных вводных
 *      («Хорошо, давайте укажем, что …») — в подстановку попадает только нормативный текст.
 *    - Сброс прогресса переговоров на бэкенде: POST /api/session/negotiation/{id}/reset-progress
 *      (исходные формулировки и пустой чат) — без кнопки в панели этапа.
 *    - После «Завершить этап» сбрасывается локальный кэш id переговоров; следующий заход на этап 3
 *      (без кэша) снова подтягивает исходный договор через negotiation/start с resetContractToInitial.
 *    - «Документы» (бриф, гайд, матрица рисков) — общий `DocumentsModal` в `GameView`, кнопка в HUD.
 *
 * Если вы хотите понять фронтовую механику переговоров, начинайте с этого файла
 * и далее смотрите:
 *    - `src/components/NegotiationDocumentFrame.js`
 *    - `src/components/NegotiationChatFrame.js`
 *    - `src/api/negotiationApi.js`
 */

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import NegotiationDocumentFrame from './NegotiationDocumentFrame';
import NegotiationChatFrame from './NegotiationChatFrame';
import {
  negotiationSessionAPI,
  chatAPI,
  checkBackendHealth,
  parseNegotiationSessionId,
} from '../api/negotiationApi';
import { getNetworkErrorHint } from '../api/errorHandler';
import { readStageDraft, writeStageDraft, clearStageDraft } from '../utils/stageDraftStorage';

const STAGE3_CACHE_PREFIX = 'simulex:stage3:negotiationSession';
const STAGE3_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

function getStage3CacheKey(simulexSessionId, caseCode) {
  return `${STAGE3_CACHE_PREFIX}:${simulexSessionId}:${caseCode}`;
}

function readCachedNegotiationSession(cacheKey) {
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const id = parseNegotiationSessionId(parsed?.negotiationSessionId);
    const updatedAt = Number(parsed?.updatedAt || 0);
    if (id == null) {
      try {
        sessionStorage.removeItem(cacheKey);
      } catch {
        /* ignore */
      }
      return null;
    }
    if (!updatedAt) return null;
    if (Date.now() - updatedAt > STAGE3_CACHE_TTL_MS) return null;
    return id;
  } catch {
    return null;
  }
}

function writeCachedNegotiationSession(cacheKey, negotiationSessionId) {
  try {
    if (parseNegotiationSessionId(negotiationSessionId) == null) return;
    sessionStorage.setItem(
      cacheKey,
      JSON.stringify({
        negotiationSessionId,
        updatedAt: Date.now(),
      })
    );
  } catch {
    // ignore storage errors
  }
}

function removeCachedNegotiationSession(cacheKey) {
  try {
    sessionStorage.removeItem(cacheKey);
  } catch {
    // ignore storage errors
  }
}

/**
 * Манифест фронтенд-компонентов этапа 3.
 *
 * Если к этапу 3 добавляются новые специализированные компоненты
 * (виджеты документа, панели чата, доп. панели статистики и т.п.),
 * их следует перечислять здесь, чтобы по одному месту было видно,
 * какие React-компоненты относятся к механике этапа 3.
 */
export const STAGE3_COMPONENTS = {
  DocumentFrame: NegotiationDocumentFrame,
  ChatFrame: NegotiationChatFrame,
};

const STAGE3_CSS = `
/* Общий вид как на этапе 1: фон, сетка, карточки */
.stage3-layout {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 100%;
  overflow: hidden;
  box-sizing: border-box;
  background: #f5f5f5;
}

.stage3-columns {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  gap: 16px;
  padding: 0 16px 16px 16px;
  width: 100%;
}

.stage3-doc-column {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #ffffff;
  padding: 0;
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.stage3-chat-column {
  flex: 0 0 460px;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f5f5f5;
  padding: 0;
  border-radius: 10px;
  box-shadow: none;
}

/* Чат в стиле этапа 1: рамка, сообщения, поля ввода */
.stage3-negotiation-chat .chat-frame {
  display: flex;
  flex-direction: column;
  max-height: none;
  flex: 1;
  min-height: 0;
  background: #ebeae6;
  padding: 0;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.stage3-negotiation-chat .chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 16px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
}

.stage3-negotiation-chat .chat-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #1a1a1a;
}

.stage3-negotiation-chat .chat-close {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.1);
  color: #1a1a1a;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 18px;
  font-weight: 600;
  transition: all 0.2s ease;
}

.stage3-negotiation-chat .chat-close:hover {
  background: rgba(0, 0, 0, 0.2);
}

.stage3-negotiation-chat .chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  background-color: #ebeae6;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 120px;
}

.stage3-negotiation-chat .message {
  display: flex;
}

.stage3-negotiation-chat .message-player {
  justify-content: flex-end;
}

.stage3-negotiation-chat .message-bot {
  justify-content: flex-start;
}

.stage3-negotiation-chat .message-bubble {
  display: inline-block;
  width: fit-content;
  max-width: 95%;
  padding: 10px 14px;
  border-radius: 16px;
  word-wrap: break-word;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.stage3-negotiation-chat .message-player .message-bubble {
  text-align: left;
  background-color: #d6d3cb;
  color: #1f1e1a;
  border-bottom-right-radius: 4px;
}

.stage3-negotiation-chat .message-bot .message-bubble {
  background-color: #ffffff;
  color: #1f1e1a;
  border: 1px solid #e5e7eb;
  border-bottom-left-radius: 4px;
}

.stage3-negotiation-chat .message-text {
  display: inline-block;
  max-width: 100%;
  white-space: pre-wrap;
  line-height: 1.5;
}

.stage3-negotiation-chat .message-bubble.typing-bubble {
  font-size: inherit;
  max-width: calc(95% / 1.5);
  padding-left: calc(14px / 1.5);
  padding-right: calc(14px / 1.5);
}

.stage3-negotiation-chat .typing-bubble .message-text.bot-typing-hint {
  font-style: italic;
  font-size: calc(1em / 1.5);
  line-height: 1.45;
}

.stage3-negotiation-chat .message-meta {
  font-size: 12px;
  font-weight: 400;
  color: #6b7280;
  margin-top: 4px;
}

.stage3-negotiation-chat .chat-input {
  flex-shrink: 0;
  border-top: 1px solid #e5e7eb;
  padding: 8px 16px 16px 16px;
  background-color: #ffffff;
}

.stage3-negotiation-chat .chat-input .options-list-compact {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.stage3-negotiation-chat .chat-input .options-list-compact .btn-primary {
  align-self: flex-start;
  margin-bottom: 4px;
}

.stage3-negotiation-chat .options-label {
  font-size: 12px;
  font-weight: 400;
  margin-bottom: 6px;
  color: #1f2937;
}

.stage3-negotiation-chat .chat-textarea {
  width: 100%;
  min-height: 64px;
  padding: 10px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 400;
  resize: vertical;
  box-sizing: border-box;
}

.stage3-negotiation-chat .negotiation-chat-composer .chat-textarea-negotiation-main {
  min-height: 72px;
  max-height: 140px;
  line-height: 1.45;
}

/* Как у placeholder в поле пояснения — тот же цвет для подсказки в строке редакции */
.stage3-negotiation-chat .negotiation-chat-composer .chat-textarea-negotiation-main::placeholder {
  color: #9ca3af;
  opacity: 1;
  font-weight: 400;
}

.stage3-negotiation-chat .negotiation-chat-composer .negotiation-input-hint {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: #6b7280;
  margin: 0 0 6px 0;
  line-height: 1.35;
}

.stage3-negotiation-chat .negotiation-chat-composer .chat-textarea + .negotiation-input-hint {
  margin-top: 14px;
}

.stage3-negotiation-chat .negotiation-revision-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0;
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 4px;
}

.stage3-negotiation-chat .negotiation-revision-inline.negotiation-revision-inline--multiline {
  flex-direction: column;
  align-items: stretch;
  flex-wrap: nowrap;
  width: 100%;
}

.stage3-negotiation-chat .negotiation-revision-editor-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
}

.stage3-negotiation-chat .negotiation-revision-editor-row .negotiation-revision-prefix {
  flex-shrink: 0;
  padding-top: 7px;
  line-height: 1.5;
}

.stage3-negotiation-chat .negotiation-revision-suffix-row {
  display: flex;
  justify-content: flex-end;
  width: 100%;
  padding-right: 2px;
  margin-top: 2px;
}

.stage3-negotiation-chat .negotiation-revision-prefix,
.stage3-negotiation-chat .negotiation-revision-suffix {
  color: #9ca3af;
  font-weight: 400;
  white-space: nowrap;
}

.stage3-negotiation-chat .negotiation-revision-input {
  flex: 1 1 120px;
  min-width: 80px;
  border: none;
  background: transparent;
  border-bottom: 1px dashed #9ca3af;
  border-radius: 0;
  padding: 2px 4px 4px 4px;
  font-size: 14px;
  font-weight: 400;
  color: #1f2937;
  outline: none;
  box-shadow: none;
}

.stage3-negotiation-chat textarea.negotiation-revision-input.negotiation-revision-textarea {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  min-height: 44px;
  max-height: min(70vh, 28rem);
  padding: 6px 4px 8px 0;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
  font-family: inherit;
  box-sizing: border-box;
}

.stage3-negotiation-chat .negotiation-revision-input.negotiation-revision-input--default-prompt {
  color: #9ca3af;
  font-weight: 400;
}

.stage3-negotiation-chat .negotiation-revision-input::placeholder {
  color: #9ca3af;
  opacity: 1;
  font-weight: 400;
}

.stage3-negotiation-chat .negotiation-revision-input:focus {
  border-bottom-color: #10b981;
}

.stage3-negotiation-chat .negotiation-chat-composer .btn-primary.negotiation-send-full {
  width: 100%;
  align-self: stretch;
  margin-top: 12px;
}

.stage3-negotiation-chat .btn-primary {
  background-color: #10b981;
  color: #fff;
  border-color: #10b981;
}

.stage3-negotiation-chat .btn-primary:hover:not(:disabled) {
  background-color: #059669;
  border-color: #059669;
}

.stage3-negotiation-chat .btn-secondary {
  background-color: #e5e7eb;
  color: #374151;
  border-color: #e5e7eb;
}

.stage3-negotiation-chat .btn-secondary:hover {
  background-color: #d1d5db;
  border-color: #d1d5db;
}

.card {
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  background: #ffffff;
}

/* Документ (упрощенная версия из DocumentFrame.css) */
.stage3-doc-column .document-frame {
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  background: #ffffff;
  padding: 0;
}

.document-frame {
  flex: 1;
  max-height: 80vh;
  overflow-y: auto;
  background: #ffffff;
  padding: 0;
}

.document-header {
  padding: 20px 24px 8px 24px;
  border-bottom: 1px solid #e5e7eb;
}

.document-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
}

.document-subtitle {
  margin: 6px 0 0 0;
  font-size: 12px;
  color: #6b7280;
}

.clauses-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 10px 18px 10px 18px;
}

.clause {
  padding: 2px 14px 2px 14px;
  border-radius: 0;
  border: none;
  border-left: 4px solid transparent;
  transition: background-color 0.2s ease, border-left-color 0.2s ease, opacity 0.15s ease;
  background: #ffffff;
  position: relative;
  margin: 0;
  cursor: default;
}

.clause:not(:last-child) {
  margin-bottom: 4px;
}

.clause-content-inline {
  display: flex;
  align-items: baseline;
  gap: 6px;
  line-height: 1.2;
  width: 100%;
}

.clause-number {
  font-weight: 700;
  font-size: 12pt;
  color: #1a1a1a;
  flex-shrink: 0;
}

.clause-text {
  margin: 0;
  line-height: 1.2;
  color: #1a1a1a;
  font-size: 12pt;
}

.clause-comment {
  margin-top: 2px;
  padding: 4px 8px;
  background-color: #efe7dd;
  border-left: 4px solid #c88c5b;
  border-radius: 4px;
  font-size: 12pt;
  color: #4a3c30;
}

.clause-status-text {
  display: none;
}

/* Пункты вне переговоров (readonly из MD или NOT_EDITABLE) — без заливки и полосы */
.clause-status-1,
.clause.clause--readonly {
  background-color: #ffffff;
  border-left: none;
  padding-left: 2px;
}

.clause-status-1::before,
.clause.clause--readonly::before {
  display: none;
  content: none;
}

/* Статусы пунктов (совместимы с DocumentFrame) — мягкая подсветка доступных / в работе */
.clause-status-2,
.clause-status-3 {
  padding-left: 14px;
  position: relative;
  background-color: rgba(14, 165, 233, 0.09);
}

.clause-status-2::before,
.clause-status-3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background-color: #7dd3fc;
}

.clause-status-4,
.clause-status-5,
.clause-status-6,
.clause-status-7 {
  padding-left: 14px;
  background-color: #d4edda;
}

/* Редакция контрагента сохранена (не зелёный «успех игрока») */
.clause-status-8 {
  padding-left: 14px;
  background-color: #fde8e8;
}

.clause-status-2.clause--focused,
.clause-status-3.clause--focused {
  background-color: rgba(14, 165, 233, 0.16);
}

.clause-status-2:hover,
.clause-status-3:hover {
  background-color: rgba(14, 165, 233, 0.14);
  cursor: pointer;
}

.stage3-negotiation-chat .lawyer-avatar {
  flex-shrink: 0;
}

/* Кнопки (глобальные для этапа 3) */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.btn-primary {
  background-color: #3b82f6;
  border-color: #3b82f6;
  color: #ffffff;
}

.btn-primary:hover {
  background-color: #2563eb;
  border-color: #2563eb;
}

.btn-secondary {
  background-color: #ffffff;
  color: #1a1a1a;
  border-color: #e5e7eb;
}

.btn-secondary:hover {
  background-color: #f3f4f6;
}

.btn-green {
  background-color: #10b981;
  border-color: #10b981;
  color: #ffffff;
}

.btn-green:hover {
  background-color: #059669;
  border-color: #059669;
}

.btn-blue {
  background-color: #3b82f6;
  border-color: #3b82f6;
  color: #ffffff;
}

.btn-blue:hover {
  background-color: #2563eb;
  border-color: #2563eb;
}

.btn-yellow {
  background-color: #fbbf24;
  border-color: #fbbf24;
  color: #1f1e1a;
}

.btn-yellow:hover {
  background-color: #f59e0b;
  border-color: #f59e0b;
}

.btn-purple {
  background-color: #764ba2;
  border-color: #764ba2;
  color: #ffffff;
}

.btn-purple:hover {
  background-color: #5d3a7e;
  border-color: #5d3a7e;
}

/* Прогресс внизу чата */
.stage3-progress {
  margin-top: 16px;
  border-top: 1px solid #e5e7eb;
  padding: 16px;
}

.stage3-progress-message {
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: 6px;
  background-color: #d4edda;
  color: #155724;
  font-size: 13px;
  text-align: center;
  font-weight: 500;
}

.stage3-progress-top-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.stage3-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  flex-shrink: 0;
}

.stage3-progress-bar {
  height: 8px;
  background: #e5e7eb;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 12px;
}

.stage3-progress-fill {
  height: 100%;
  background: #10b981;
  width: 0;
  transition: width 0.3s;
}

.stage3-complete-btn {
  width: 100%;
  padding: 10px 12px;
  border-radius: 6px;
  border: none;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background-color: #10b981;
  color: #ffffff;
}

.stage3-complete-btn[disabled] {
  background-color: #9ca3af;
  cursor: not-allowed;
}

.stage3-complete-btn[disabled][aria-busy='true'] {
  background-color: #6ee7b7;
  color: #ffffff;
  cursor: wait;
  opacity: 0.92;
}

/* Полная победа на этапе 3: салют + поздравление (~15 с яркого фейерверка) */
.stage3-perfect-win-overlay {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: radial-gradient(ellipse 120% 100% at 50% 40%, rgba(15, 23, 42, 0.55) 0%, rgba(15, 23, 42, 0.72) 100%);
  animation: stage3-perfect-win-fade-in 0.35s ease-out;
  pointer-events: auto;
}

@keyframes stage3-perfect-win-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.stage3-perfect-win-fireworks {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.stage3-perfect-win-particle {
  position: absolute;
  border-radius: 50%;
  opacity: 0;
  will-change: transform, opacity, filter;
  animation-name: stage3-fw-burst;
  animation-timing-function: cubic-bezier(0.22, 0.82, 0.35, 1);
  animation-fill-mode: forwards;
  filter: brightness(1.35) saturate(1.35);
  box-shadow:
    0 0 10px 2px rgba(255, 255, 255, 0.95),
    0 0 22px 6px var(--glow, rgba(255, 255, 255, 0.55));
}

@keyframes stage3-fw-burst {
  0% {
    transform: translate(0, 0) scale(1);
    opacity: 1;
    filter: brightness(1.6) saturate(1.5);
  }
  35% {
    opacity: 1;
    filter: brightness(1.45) saturate(1.4);
  }
  100% {
    transform: translate(var(--dx), var(--dy)) scale(0.08);
    opacity: 0;
    filter: brightness(1) saturate(1);
  }
}

.stage3-perfect-win-card {
  position: relative;
  z-index: 1;
  max-width: 420px;
  width: 100%;
  padding: 28px 24px;
  border-radius: 16px;
  background: linear-gradient(165deg, #fffdf8 0%, #f0fdf4 55%, #ecfeff 100%);
  box-shadow:
    0 25px 50px -12px rgba(0, 0, 0, 0.35),
    0 0 0 1px rgba(255, 255, 255, 0.6) inset;
  text-align: center;
}

.stage3-perfect-win-text {
  margin: 0 0 22px 0;
  font-size: 18px;
  line-height: 1.45;
  color: #0f172a;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.stage3-perfect-win-btn {
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  background: linear-gradient(180deg, #10b981 0%, #059669 100%);
  color: #ffffff;
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.45);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.stage3-perfect-win-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(16, 185, 129, 0.5);
}
`;

function ensureStage3StylesInjected() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('stage3-negotiation-styles')) return;
  const style = document.createElement('style');
  style.id = 'stage3-negotiation-styles';
  style.textContent = STAGE3_CSS;
  document.head.appendChild(style);
}

export default function Stage3View({
  session,
  stage,
  caseData,
  onAction,
  onComplete,
  timeRemaining,
  onBackToStart,
  onFinishCase,
  onTutorEvent,
  /** Отступ сверху у колонки чата под фиксированный GameplayHud (GameView). */
  chatColumnTopInsetPx = 0,
  /** Запрос завершения этапа на сервере — как на этапах 1 и 4 */
  stageCompleteInFlight = false,
  /** Callback для экспорта NegotiationChatFrame в Simugram */
  onChatExpose,
  /** Открыть Симуграм с чатом юриста (этап 3) — при выборе пункта для обсуждения */
  onDiscussClauseOpen,
}) {
  const [negotiationSessionId, setNegotiationSessionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedClause, setSelectedClause] = useState(null);
  const [chatActive, setChatActive] = useState(false);
  const [chatAction, setChatAction] = useState(null);
  const [chatComplete, setChatComplete] = useState(false);
  const [progress, setProgress] = useState({
    total: 0,
    /** Закрытые обсуждения по пункту (любой исход), для шкалы «X из Y». */
    agreed: 0,
    /** Закрытые в пользу игрока / без «только редакция контрагента» — для салюта «идеально». */
    favorableAgreed: 0,
    disputed: 0,
    percentage: 0,
  });
  /** null: ещё не было осмысленного прогресса; false: были несогласованные пункты; true: уже «идеально» */
  const prevPerfectWinRef = useRef(null);
  const [perfectWinVisible, setPerfectWinVisible] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [agreedReplacement, setAgreedReplacement] = useState(null);
  const [s3DraftHydrated, setS3DraftHydrated] = useState(false);
  /** Блок «прогресс + завершить этап» — для выравнивания композера Симуграма с низом карточки договора. */
  const stage3ProgressBlockRef = useRef(null);

  const simulexSessionIdStable =
    session?.id || session?.sessionId || session?.session_id;

  useLayoutEffect(() => {
    setS3DraftHydrated(false);
  }, [simulexSessionIdStable]);

  useEffect(() => {
    // Глобально инжектим CSS этапа 3 один раз при первом монтировании
    ensureStage3StylesInjected();
  }, []);

  // Не вызываем chatAPI.setAiMode здесь: на бэкенде set_ai_mode сбрасывает чат, clause_status и
  // clause_replacements — это стирает прогресс переговоров и ломает связку с этапом 4 при повторном
  // заходе на этап 3. Режим «только ИИ» обеспечивается в chat_service.is_ai_mode без записи в историю.

  useEffect(() => {
    // Избегаем бесконечных перезапусков: завязываемся только на стабильные примитивы
    const simulexSessionId = session?.id || session?.sessionId || session?.session_id;
    const caseCode = session?.case_id || session?.case_code || 'case-001';

    if (!simulexSessionId || !caseCode) {
      return;
    }

    const bootstrapSession = async () => {
      try {
        setLoading(true);
        setError(null);

        // 0) Проверка доступности бэкенда (CRA :3000 → API :5000 через setupProxy)
        const backendOk = await checkBackendHealth();
        if (!backendOk) {
          setError(getNetworkErrorHint());
          return;
        }

        const cacheKey = getStage3CacheKey(simulexSessionId, caseCode);

        // 1) Пробуем использовать кэшированный negotiation_session_id
        const cachedNegotiationSessionId = readCachedNegotiationSession(cacheKey);
        if (cachedNegotiationSessionId) {
          try {
            // Валидация кэша: если сессия существует на backend, используем её.
            await chatAPI.getHistory(cachedNegotiationSessionId);
            setNegotiationSessionId(cachedNegotiationSessionId);
            return;
          } catch {
            removeCachedNegotiationSession(cacheKey);
          }
        }

        // 2) Если кэша нет или он невалиден — стартуем/получаем сессию у backend.
        // Без кэша: сбрасываем подстановки в договоре к исходным (повторный «заход» с начала условий).
        const data = await negotiationSessionAPI.start(
          {
            ...session,
            id: simulexSessionId,
            case_id: caseCode,
          },
          'dogovor_PO',
          { resetContractToInitial: true }
        );
        const nextNegotiationSessionId =
          data.negotiation_session_id || data.negotiationSessionId;
        setNegotiationSessionId(nextNegotiationSessionId);
        writeCachedNegotiationSession(cacheKey, nextNegotiationSessionId);
      } catch (err) {
        setError(
          'Не удалось инициализировать сессию переговоров: ' +
            (err?.detail || err?.error || err?.message || 'Неизвестная ошибка')
        );
      } finally {
        setLoading(false);
      }
    };

    bootstrapSession();
    // Зависим только от идентификаторов, а не от всего объекта session/stage
  }, [session?.id, session?.sessionId, session?.session_id, session?.case_id, session?.case_code]);

  const handleStage3ClausesLoaded = useCallback(
    (loadedClauses) => {
      const simId = session?.id || session?.sessionId || session?.session_id;
      if (!simId) {
        setS3DraftHydrated(true);
        return;
      }
      const draft = readStageDraft(simId, 3);
      if (draft?.version === 1 && draft.selectedClauseId != null) {
        const idStr = String(draft.selectedClauseId).trim();
        const c = (loadedClauses || []).find(
          (x) => String(x.id) === idStr || String(x.number) === idStr
        );
        if (c) {
          const st = c.status;
          if (st === 2 || st === 3) {
            setSelectedClause(c);
            setChatActive(draft.chatActive !== false);
            setChatAction(draft.chatAction != null ? draft.chatAction : null);
            setChatComplete(!!draft.chatComplete);
          } else if ([4, 5, 6, 7, 8, 9].includes(st)) {
            setSelectedClause(c);
            setChatAction(
              draft.chatAction === 'history' || draft.chatAction
                ? draft.chatAction
                : 'history'
            );
            setChatActive(true);
            setChatComplete(true);
          }
        }
      }
      if (draft?.version === 1 && draft.agreedReplacement && typeof draft.agreedReplacement === 'object') {
        setAgreedReplacement(draft.agreedReplacement);
      }
      setS3DraftHydrated(true);
    },
    [session?.id, session?.sessionId, session?.session_id]
  );

  useEffect(() => {
    if (!s3DraftHydrated || !simulexSessionIdStable || !negotiationSessionId) return;
    writeStageDraft(simulexSessionIdStable, 3, {
      version: 1,
      savedAt: Date.now(),
      selectedClauseId: selectedClause?.id ?? null,
      chatActive,
      chatAction,
      chatComplete,
      agreedReplacement,
    });
  }, [
    s3DraftHydrated,
    simulexSessionIdStable,
    negotiationSessionId,
    selectedClause,
    chatActive,
    chatAction,
    chatComplete,
    agreedReplacement,
  ]);

  const handleClauseSelect = (clause) => {
    if (!clause) {
      setSelectedClause(null);
      setChatActive(false);
      setChatAction(null);
      setChatComplete(false);
      return;
    }

    if (clause.status === 2 || clause.status === 3) {
      // Разрешаем переключаться между пунктами в любой момент; история по каждому пункту — на сервере и в NegotiationChatFrame.
      if (!selectedClause || selectedClause.id !== clause.id) {
        setChatAction(null);
        setChatComplete(false);
      }
      setSelectedClause(clause);
      setChatActive(true);
      onDiscussClauseOpen?.();
    } else if (
      clause.status === 4 ||
      clause.status === 5 ||
      clause.status === 6 ||
      clause.status === 7 ||
      clause.status === 8 ||
      clause.status === 9
    ) {
      setSelectedClause(clause);
      setChatAction('history');
      setChatActive(true);
      setChatComplete(true);
      onDiscussClauseOpen?.();
    }
  };

  const handleClauseAction = (action) => {
    if (action !== 'history' && (!selectedClause || !selectedClause.id)) {
      setError('Пункт не выбран');
      return;
    }
    if (action === 'reject' || action === 'change' || action === 'insist') {
      setChatAction(action);
    } else {
      setChatAction(action || 'discuss');
    }
    setChatActive(true);
  };

  const handleChatClose = () => {
    setChatActive(false);
    setSelectedClause(null);
    setChatAction(null);
    setChatComplete(false);
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleChatComplete = () => {
    setChatComplete(true);
  };

  const refreshClauses = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleClauseAgreed = (agreedClauseId, replacementText, options) => {
    const clauseExcluded = options?.clauseExcluded;
    const hasRepl =
      replacementText != null && String(replacementText).trim().length > 0;
    if (!agreedClauseId) {
      setAgreedReplacement(null);
      return;
    }
    if (clauseExcluded) {
      setAgreedReplacement({
        clauseId: agreedClauseId,
        replacementText: '',
        clauseExcluded: true,
      });
      return;
    }
    if (hasRepl) {
      setAgreedReplacement({
        clauseId: agreedClauseId,
        replacementText: String(replacementText).trim(),
        clauseExcluded: false,
      });
      return;
    }
    // Согласие с редакцией контрагента / закрытие без новой текстовой замены — снимаем оверлей.
    setAgreedReplacement(null);
  };

  const handleAcceptFromChat = async () => {
    // Приём пункта теперь обрабатывается на backend через documentAPI.acceptClause,
    // но для текущей интеграции просто триггерим обновление документа.
    refreshClauses();
    setChatComplete(true);
  };

  /** Завершение этапа: синхронизация с бэкендом (в т.ч. договор для этапа 4), затем сброс кэша id переговоров — при следующем заходе на этап 3 договор снова с исходными пунктами. */
  const handleCompleteStage = async () => {
    if (stageCompleteInFlight) return;
    if (typeof onComplete === 'function') {
      await onComplete();
    }
    const simulexSessionId = session?.id || session?.sessionId || session?.session_id;
    const caseCode = session?.case_id || session?.case_code || 'case-001';
    if (simulexSessionId && caseCode) {
      removeCachedNegotiationSession(getStage3CacheKey(simulexSessionId, caseCode));
    }
    if (simulexSessionId) clearStageDraft(simulexSessionId, 3);
  };

  const allClausesDiscussed = progress.total > 0 && progress.disputed === 0;

  useLayoutEffect(() => {
    const clearVar = () => {
      try {
        document.documentElement.style.removeProperty('--simulex-stage3-progress-block-height');
      } catch {
        /* ignore */
      }
    };
    if (loading || !negotiationSessionId) {
      clearVar();
      return undefined;
    }
    const el = stage3ProgressBlockRef.current;
    if (!el) {
      return clearVar;
    }
    const apply = () => {
      try {
        const h = Math.ceil(el.getBoundingClientRect().height);
        document.documentElement.style.setProperty(
          '--simulex-stage3-progress-block-height',
          `${h}px`
        );
      } catch {
        /* ignore */
      }
    };
    apply();
    let ro;
    try {
      ro = new ResizeObserver(() => apply());
      ro.observe(el);
    } catch {
      return clearVar;
    }
    return () => {
      try {
        ro?.disconnect();
      } catch {
        /* ignore */
      }
      clearVar();
    };
  }, [
    loading,
    negotiationSessionId,
    progress.total,
    progress.agreed,
    progress.disputed,
    progress.percentage,
    progress.favorableAgreed,
    allClausesDiscussed,
    stageCompleteInFlight,
  ]);

  useEffect(() => {
    if (typeof onChatExpose !== 'function') return;
    if (!negotiationSessionId) return;
    onChatExpose({
      negotiationSessionId,
      clauseId: selectedClause?.id || null,
      clauseTitle: selectedClause?.title || selectedClause?.id || null,
      chatAction,
      onClose: handleChatClose,
      onStatusUpdate: refreshClauses,
      onChatComplete: handleChatComplete,
      onClauseAgreed: handleClauseAgreed,
      isActive: !!(selectedClause && selectedClause.id),
      selectedClause,
      onAccept: handleAcceptFromChat,
      onPropose: (actionName) => handleClauseAction(actionName || 'discuss'),
      onTutorEvent,
      progress,
      allClausesDiscussed,
      handleCompleteStage,
      stageCompleteInFlight,
    });
  }, [negotiationSessionId, selectedClause, chatAction, progress, allClausesDiscussed, stageCompleteInFlight, onChatExpose]);

  useEffect(() => {
    if (progress.total === 0) {
      prevPerfectWinRef.current = null;
      setPerfectWinVisible(false);
      return;
    }
    const isPerfectWin =
      progress.disputed === 0 &&
      (progress.favorableAgreed ?? 0) === progress.total &&
      progress.total > 0;
    const prev = prevPerfectWinRef.current;
    if (isPerfectWin) {
      if (prev === false) {
        setPerfectWinVisible(true);
      }
      prevPerfectWinRef.current = true;
    } else {
      prevPerfectWinRef.current = false;
    }
  }, [progress.total, progress.favorableAgreed, progress.disputed]);

  useEffect(() => {
    if (!perfectWinVisible) return undefined;
    const t = setTimeout(() => setPerfectWinVisible(false), 10000);
    return () => clearTimeout(t);
  }, [perfectWinVisible]);

  if (loading) {
    return (
      <div className="stage3-layout">
        <div className="loading">Загрузка этапа 3...</div>
      </div>
    );
  }

  if (error || !negotiationSessionId) {
    const isNetworkError = error && (
      (error.message || '').includes('подключиться к серверу') ||
      (error.message || '').includes('бэкенд запущен')
    );
    return (
      <div className="stage3-layout">
        <div className="error">
          {error || 'Сессия переговоров не инициализирована.'}
          {isNetworkError && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setError(null);
                  setLoading(true);
                  const simulexSessionId = session?.id || session?.sessionId || session?.session_id;
                  const caseCode = session?.case_id || session?.case_code || 'case-001';
                  if (!simulexSessionId || !caseCode) return;
                  negotiationSessionAPI
                    .start(
                      { ...session, id: simulexSessionId, case_id: caseCode },
                      'dogovor_PO'
                    )
                    .then((data) => {
                      const nextId = data.negotiation_session_id || data.negotiationSessionId;
                      setNegotiationSessionId(nextId);
                      writeCachedNegotiationSession(
                        getStage3CacheKey(simulexSessionId, caseCode),
                        nextId
                      );
                    })
                    .catch((err) => {
                      setError(
                        err?.message ||
                          err?.detail ||
                          err?.error ||
                          'Не удалось инициализировать сессию переговоров.'
                      );
                    })
                    .finally(() => setLoading(false));
                }}
              >
                Повторить
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const perfectWinParticles = Array.from({ length: 160 }, (_, i) => {
    const angle = (i / 160) * Math.PI * 2 + (i % 7) * 0.42 + (i % 2) * 0.18;
    const dist = 85 + (i % 12) * 19;
    const dx = Math.round(Math.cos(angle) * dist);
    const dy = Math.round(Math.sin(angle) * dist);
    const left = 3 + ((i * 47) % 94);
    const top = 2 + ((i * 61) % 90);
    /* Волны залпов на всём интервале ~15 с */
    const delay = (i / 160) * 14.4;
    const durationSec = 1.05 + (i % 11) * 0.065;
    const sizePx = 7 + (i % 7) * 2;
    const colors = [
      '#ff2d95',
      '#fff01f',
      '#00f5ff',
      '#ff6b2d',
      '#c56fff',
      '#39ff14',
      '#ff1744',
      '#ffea00',
      '#00e5ff',
      '#ffa726',
    ];
    const color = colors[i % colors.length];
    return {
      key: i,
      left,
      top,
      dx,
      dy,
      delay,
      durationSec,
      sizePx,
      color,
      glow: `${color}99`,
    };
  });

  return (
    <div className="stage3-layout">
      <div className="stage3-columns">
        <div className="stage3-doc-column" data-tutor-highlight="stage3_document_frame" style={{ flex: 1 }}>
          <NegotiationDocumentFrame
            negotiationSessionId={negotiationSessionId}
            onClauseSelect={handleClauseSelect}
            selectedClause={selectedClause}
            onClauseAction={handleClauseAction}
            refreshTrigger={refreshTrigger}
            agreedReplacement={agreedReplacement}
            onProgressUpdate={setProgress}
            chatComplete={chatComplete}
            onClausesLoaded={handleStage3ClausesLoaded}
          />
        </div>
        {/* Чат переговоров перенесён в Simugram */}
      </div>

      {/* Прогресс и кнопка завершения — внизу (высота → --simulex-stage3-progress-block-height для колонки Симуграма) */}
      <div
        ref={stage3ProgressBlockRef}
        className="stage3-progress"
        data-tutor-highlight="stage3_progress_block"
        style={{ padding: '12px 16px', borderTop: '1px solid #e5e7eb' }}
      >
        {allClausesDiscussed && (
          <div className="stage3-progress-message">
            ✓ Обсуждение всех пунктов завершено. Можно переходить к следующему этапу.
          </div>
        )}
        <div className="stage3-progress-top-row">
          <div className="stage3-progress-header">
            <span>Прогресс обсуждения:</span>
            <span>
              <strong>
                {progress.agreed} из {progress.total}
              </strong>
            </span>
          </div>
        </div>
        <div className="stage3-progress-bar">
          <div
            className="stage3-progress-fill"
            style={{ width: `${progress.percentage}%` }}
          />
        </div>
        <button
          type="button"
          className="stage3-complete-btn"
          onClick={handleCompleteStage}
          disabled={!!stageCompleteInFlight}
          aria-busy={!!stageCompleteInFlight}
        >
          {stageCompleteInFlight ? 'Сохранение и переход…' : 'Завершить этап'}
        </button>
      </div>

      {perfectWinVisible && (
        <div
          className="stage3-perfect-win-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="stage3-perfect-win-msg"
        >
          <div className="stage3-perfect-win-fireworks" aria-hidden="true">
            {perfectWinParticles.map((p) => (
              <span
                key={p.key}
                className="stage3-perfect-win-particle"
                style={{
                  left: `${p.left}%`,
                  top: `${p.top}%`,
                  width: `${p.sizePx}px`,
                  height: `${p.sizePx}px`,
                  '--dx': `${p.dx}px`,
                  '--dy': `${p.dy}px`,
                  '--glow': p.glow,
                  background: `radial-gradient(circle at 30% 30%, #ffffff, ${p.color} 55%, ${p.color})`,
                  animationDelay: `${p.delay}s`,
                  animationDuration: `${p.durationSec}s`,
                }}
              />
            ))}
          </div>
          <div className="stage3-perfect-win-card">
            <p id="stage3-perfect-win-msg" className="stage3-perfect-win-text">
              Гениально! Тебе удалось убедить контрагента по всем пунктам!
            </p>
            <button
              type="button"
              className="stage3-perfect-win-btn"
              onClick={() => setPerfectWinVisible(false)}
            >
              Продолжить
            </button>
          </div>
        </div>
      )}

      {/* Бриф, гайд и матрица — через кнопку «Документы» в HUD: DocumentsModal в GameView (как этап 1). */}
    </div>
  );
}

