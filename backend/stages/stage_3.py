"""
Этап 3: Согласование и переговоры — ядро механики переговоров.

Этот модуль — главная точка входа для всего, что связано с этапом 3 на бекенде.
Если вы ищете, как устроены переговоры, смотрите сюда в первую очередь.

Архитектурно этап 3 состоит из трёх уровней:

1) **Уровень этапа (Stage API)** — этот файл:
   - класс `Stage3(BaseStage)`:
     - описывает метаданные этапа (`get_stage_info`);
     - управляет завершением этапа (`can_complete`, `on_complete`, кризис);
     - подключён через `stage_factory` и используется общим сервисом этапов.

2) **Уровень сессий и документа (переговорный модуль)**:
   - `services/negotiation_session_service.py`
       * `get_or_create_stage_and_negotiation_session(...)`
         — создаёт/находит запись `stage_session` (сессия этапа 3)
           и связанную `negotiation_session` (состояние переговоров);
       * `get_negotiation_history(...)`, `save_negotiation_history(...)`
         — читают/пишут историю переговоров (`history_json`).
   - `services/document_service.py`
       * `ClauseStatus` — единый enum статусов пунктов договора;
       * `get_contract_clauses_for_session(...)`
         — возвращает структуру документа (пункты + статусы) для `negotiation_session`;
       * `update_clause_status_for_session(...)`
         — обновляет статус/замещающий текст пункта в истории.

3) **Уровень чата и ИИ‑бота**:
   - `services/chat_service.py`
       * `activate_chat(...)` — старт диалога по пункту договора;
       * `send_message(...)` — обработка выбора игрока и (опционально) оправдания,
         вычисление ответа бота и нового статуса пункта.
   - `services/bot_logic.py`
       * содержит детальную логику простого бота (без ИИ) по мотивам прототипа.
   - `services/ai_chat_service.py`
       * `evaluate_justification_with_ai(...)` — обращение к OpenAI API для оценки
         текстового оправдания игрока (используется внутри `chat_service`).

Маршруты HTTP, которые используют эту механику:
   - `backend/routers/sessions.py` — `/api/session/negotiation/start`
       * создаёт/получает `stage_session` + `negotiation_session` через
         `get_or_create_stage_and_negotiation_session`;
   - `backend/routers/document.py` — `/api/document/session/{id}/clauses`
       * отдаёт структуру договора через `get_contract_clauses_for_session`;
   - `backend/routers/chat.py`
       * `/api/chat/session/{id}/clause/{clause_id}/activate` → `chat_service.activate_chat`;
       * `/api/chat/session/{id}/clause/{clause_id}/message` → `chat_service.send_message`;
       * `/api/chat/session/{id}/history` → история чата.

Всё, что выше, — инфраструктура для механики, а сам этап 3
остаётся сконцентрирован в этом файле (`Stage3`) и на фронтенде
в компоненте `src/components/Stage3View.js`.
"""

from typing import Dict, Any, List, Optional
from stages.base_stage import BaseStage
from stages import STAGE_EXTRA_ROUTERS
from services.action_service import execute_action, validate_action_prerequisites, validate_action_mutex
from services.case_service import get_case
from utils.crisis import check_crisis
from config import DATA_DIR
from routers import document, chat, ai_chat

# Регистрируем все "внешние" роутеры, относящиеся к этапу 3, в общем реестре.
# Это позволяет видеть всю механику этапа 3 (включая HTTP-интерфейсы)
# по одному файлу: backend/stages/stage_3.py.
STAGE_EXTRA_ROUTERS["stage-3"] = [
    document.router,
    chat.router,
    ai_chat.router,
]

class Stage3(BaseStage):
    """Этап 3: Согласование и переговоры - имеет механику переговоров с пунктами договора"""
    def get_stage_info(self) -> Dict[str, Any]:
        return {
            "title": "Этап 3: Согласование и переговоры",
            "intro": "Проведите переговоры",
            "type": "negotiation",
            "points_budget": self.stage_config.get("points_budget", 8),
            "crisis_check": self.stage_config.get("crisis_check", False),
            "custom_mechanics": ["negotiation", "clauses", "chat"]
        }
    def get_actions(self) -> List[Dict[str, Any]]:
        return self.stage_config.get("actions", [])
    def validate_action(self, action_id: str, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        action = next((a for a in self.get_actions() if a.get("id") == action_id), None)
        if not action and session.get("crisis_actions"):
            action = next((a for a in session["crisis_actions"] if a.get("id") == action_id), None)
        if not action: return False, "Действие не найдено"
        is_valid, error_msg = validate_action_prerequisites(action, session)
        if not is_valid: return False, error_msg
        case_id = session.get("case_id", "").replace("case-", "") if session.get("case_id") else None
        case_data = get_case(DATA_DIR, case_id)
        is_valid, error_msg = validate_action_mutex(action, case_data, session)
        if not is_valid: return False, error_msg
        return True, None
    def execute_action(self, action_id: str, session: Dict[str, Any]) -> Dict[str, Any]:
        action = next((a for a in self.get_actions() if a.get("id") == action_id), None)
        if not action and session.get("crisis_actions"):
            action = next((a for a in session["crisis_actions"] if a.get("id") == action_id), None)
        if not action: raise ValueError("Действие не найдено")
        return execute_action(action, session)
    def can_complete(self, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        """
        Для этапа 3 (переговоры) разрешаем завершение без проверки обязательных действий.
        Завершение контролируется самим игроком и логикой переговоров на фронтенде.
        """
        return True, None
    def on_complete(self, session: Dict[str, Any]) -> Dict[str, Any]:
        updated_session = dict(session)
        if self.stage_config.get("crisis_check") and not session.get("crisis_injected"):
            crisis_injects = check_crisis(self.case_data, session["lexic"])
            if crisis_injects:
                print(f"🔴 Кризис активирован! Инжектировано {len(crisis_injects)} действий")
                updated_session["crisis_actions"] = crisis_injects
                updated_session["crisis_injected"] = True

        # Поклаузальная оценка LEXIC (по документации разработчика)
        try:
            from services.stage3_lexic_service import compute_stage3_lexic_deltas
            from services.negotiation_session_service import get_negotiation_session_by_simulex_session
            from services.negotiation_session_service import get_negotiation_history
            from services.document_service import get_contract_clauses_for_session
            from utils.validators import clamp

            session_id = session.get("id") or session.get("session_id")
            if session_id:
                neg_id, _ = get_negotiation_session_by_simulex_session(str(session_id))
                if neg_id:
                    neg_history = get_negotiation_history(neg_id)
                    try:
                        doc = get_contract_clauses_for_session(int(neg_id))
                        clause_list = (doc or {}).get("clauses") or []
                    except Exception:
                        clause_list = []
                    result = compute_stage3_lexic_deltas(
                        neg_history or {},
                        clause_list,
                        include_details=True,
                    )
                    deltas = result.get("deltas") or {}
                    penalties = result.get("semantic_penalties") or {}
                    lexic = dict(updated_session.get("lexic") or {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50})
                    for p in ("L", "E", "X", "I", "C"):
                        d = float(deltas.get(p, 0) or 0)
                        pen = float(penalties.get(p, 0) or 0)
                        step = int(round(d + pen))
                        if step:
                            lexic[p] = clamp(lexic[p] + step, 0, 100)
                    updated_session["lexic"] = lexic
                    updated_session["stage3_lexic_breakdown"] = result
                    print(
                        f"📊 Этап 3: LEXIC дельты={deltas}, смысловые штрафы={penalties}"
                    )
        except Exception as _e:
            print(f"⚠️ stage_3.on_complete: ошибка поклаузальной LEXIC-оценки: {_e}")

        return updated_session
    def get_custom_data(self) -> Dict[str, Any]:
        return {"clauses": [{"id": 1, "text": "Пункт 1.1"}, {"id": 2, "text": "Пункт 2.3"}]}
