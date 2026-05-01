# Удалённый пайплайн переговоров v1 в `_send_message_inner` (этап 3)

**Дата фиксации:** 2026-04-04  

## Что убрано из продакшен-потока

Из `backend/services/chat_service.py`, функция `_send_message_inner`:

- Ветка с **`evaluate_player_message_with_llm`** (`ai_chat_service`), двухшаговым/одношаговым режимом, **`apply_acceptance_rules`**, семантическими подсказками в этом месте, pre-LLM цепочкой глубины/playbook до основного вызова LLM.
- Переменная окружения **`NEGOTIATION_ENGINE`**: переключатель v1/v2 удалён; при **`is_ai_mode(...)` == True** сразу вызывается **`_send_message_v2`** → `negotiation_v2_runtime`.

ИИ-режим этапа 3 = **только v2** (`negotiation_v2_runtime` + `post_llm_rules` + дальнейшая логика в `chat_service` / `ai_counterpart_rules` там, где она ещё вызывается).

## Что осталось в кодовой базе

- **`evaluate_player_message_with_llm`** в `backend/services/ai_chat_service.py` — для тестов (`tests/backend/test_negotiation_player_questions_limit.py` и др.), бенчмарков/отладки, не как основной путь `send_message` в ИИ-режиме.
- **`ai_counterpart_rules.py`** — постобработка, playbook при частично включённых ветках `chat_service`, simple-режим, эвристики; модуль по-прежнему активно используется.

## Восстановление старого кода

Полная история — в **git**:

```bash
git log -p -S "evaluate_player_message_with_llm" -- backend/services/chat_service.py
```

или коммит непосредственно перед рефакторингом «только v2» для `_send_message_inner`.
