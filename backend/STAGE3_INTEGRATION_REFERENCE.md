# Stage 3 Negotiation — Integration Reference

This file documents ALL variables, fields, and contracts that Stage 3 shares
with the frontend, Stage 4 bridge, reports, and session storage.
Any new negotiation engine (v2) MUST preserve these interfaces.

---

## 1. HTTP API (frontend ↔ backend)

### POST /api/chat/session/{session_id}/clause/{clause_id}/activate
Request: `{ "action": "reject" | "change" | "discuss" | "insist" }`
Response: `{ action, clauseId, clauseData, playerMessage, options, chatActive, lawyerName, lawyerCompany, patience, maxPatience }`

### POST /api/chat/session/{session_id}/clause/{clause_id}/message
Request (SendMessageRequest):
- `action`: Optional[str]
- `choiceIndex`: Optional[int]
- `reasonIndex`: Optional[int]
- `justificationText`: Optional[str]
- `formulationText`: Optional[str]
- `explanationText`: Optional[str]
- `newClauseText`: Optional[str]

Response (_finalize_response):
```json
{
  "botResponse": {
    "message": "str",
    "agrees": "bool",
    "requiresJustification": "bool",
    "objection": "bool",
    "objectionNumber": "int",
    "convincingScore": "float (0-100)",
    "outcomeType": "str (OutcomeType.value)",
    "patience": "int",
    "awaitingJustification": "bool"
  },
  "clauseStatus": "int (ClauseStatus value)",
  "points": 0,
  "chatComplete": "bool",
  "patience": "int",
  "replacementText": "str | null",
  "clauseExcluded": "bool",
  "outcomeType": "str (OutcomeType.value)"
}
```

### GET /api/chat/session/{session_id}/history
### POST /api/chat/session/{session_id}/ai-mode  `{ "enabled": bool }`
### POST /api/chat/session/{session_id}/reset-progress

---

## 2. ClauseStatus (document_service.py)

| Key                    | Value |
|------------------------|-------|
| NOT_EDITABLE           | 1     |
| AVAILABLE              | 2     |
| SELECTED               | 3     |
| NO_EDITS               | 4     |
| ACCEPTED_BOT           | 5     |
| CHANGED                | 6     |
| NOT_AGREED_ESCALATION  | 7     |
| KEPT_COUNTERPARTY      | 8     |
| EXCLUDED               | 9     |

Used by chat_service: SELECTED (3), CHANGED (6), EXCLUDED (9), KEPT_COUNTERPARTY (8)

---

## 3. OutcomeType (negotiation_models.py)

| Member                  | Value                |
|-------------------------|----------------------|
| PENDING                 | "pending"            |
| ACCEPTED_PLAYER_CHANGE  | "accepted_changed"   |
| CLAUSE_EXCLUDED         | "clause_excluded"    |
| ACCEPTED_COUNTERPARTY   | "accepted_counterparty" |
| KEPT_ORIGINAL           | "kept_original"      |
| CLOSED_NO_AGREEMENT     | "closed_no_agreement"|
| ESCALATED               | "escalated"          |

---

## 4. Frontend fields read (NegotiationChatFrame.js)

From sendMessage response:
- `data.botResponse.message`
- `data.botResponse.convincingScore`
- `data.botResponse.requiresJustification`
- `data.botResponse.agrees`
- `data.botResponse.outcomeType`
- `data.botResponse.patience`
- `data.chatComplete`
- `data.replacementText`
- `data.clauseExcluded`
- `data.outcomeType`
- `data.patience`

From activate response:
- `lawyerName`, `lawyerCompany`, `playerMessage`, `options`, `patience`, `maxPatience`

---

## 5. history_json keys (negotiation_session_service.py)

Always present:
- `chat_history_by_clause`: dict[str, list]
- `chat_history`: list (flattened)
- `clause_status`: dict[str, int]
- `clause_replacements`: dict[str, str]
- `total_points`: int
- `patience`: dict[str, int]
- `max_patience`: int
- `mode`: str ("ai" | "simple")
- `ai`: dict (enabled, max_objections_per_item)
- `ai_lessons_by_clause`: dict

Optional:
- `lawyer_name`: str
- `lawyer_company`: str
- `clause_dialogue_started_at`: dict[str, str]
- `clause_dialogue_summaries`: dict[str, dict]
- `excluded_clause_ids`: list[str]
- `awaiting_justification`: dict[str, bool]
- `stage3_patience_off_topic_count`: dict[str, int]

Chat message entry:
- `text`: str
- `owner`: "player" | "bot"
- `timestamp`: ISO string
- `clauseId`: str
- `action`: str (player only)
- `agrees`: bool (bot only)
- `convincingScore`: float (bot only)

---

## 6. Stage 4 bridge (stage4_bridge_service.py, stage4_contract_resolve.py)

Reads from each Stage 3 clause:
- `id`: str — primary index
- `number`: str — secondary index
- `status`: int — compared to ACCEPTED_BOT (5) and CHANGED (6)
- `replacementText`: str | None — preferred negotiated text
- `text`: str — fallback if replacementText empty
- `contract_text`: str — second fallback

Produces per Stage 4 clause:
- `agreed_text` = replacementText or text or contract_text
- `negotiation_correct` = status in (5, 6)
- `negotiation_exclusion` = excluded clause detection
- `negotiation_fix_kind` = "exclusion" | "replacement" | "incorrect"

---

## 7. Report service (report_service.py)

Reads:
- `get_negotiation_session_by_simulex_session` → session object
- `get_negotiation_history` → clause_status, total_points, chat_history_by_clause
- `get_contract_clauses_for_session` → clause list with titles
- `compute_stage3_lexic_deltas` → history["chat_history_by_clause"]

Produces stage_details["stage-3"]:
- `agreed_count`, `not_discussed_count`, `in_progress_count`
- `total_points`
- `chat_formulation_insights` (strong, weak, etc.)

---

## 8. Functions to preserve (chat_service.py)

- `activate_chat` — unchanged
- `_finalize_response` — unchanged (API contract)
- `_persist_clause_outcome` — unchanged
- `save_chat_history` — unchanged
- `_append_to_clause_history` — unchanged
- `_persist_clause_dialogue_summary` — unchanged
- `get_clause_data` — unchanged
- `get_clause_options` — unchanged

---

## 9. Environment variables

- **ИИ-переговоры этапа 3** идут только через `negotiation_v2_runtime` (вызывается из `chat_service._send_message_v2`). Переключателя движка v1/v2 нет.
- `DISABLE_BOT_PATIENCE`: set to `1`/`true`/`yes` to disable patience drain
- **Model for stage 3:** `get_model_for_consumer("stage3")` — `backend/config/ai_model_config.json` and/or `OPENAI_MODEL` (not `STAGE3_MODEL`; that name is not used in code)

**Переговоры (v2 / `negotiation_v2_runtime`):**

- `NEGOTIATION_V2_MAX_TOKENS` (default 800), `NEGOTIATION_V2_TEMPERATURE` (default 0.3)
- Inconsistent JSON and near-duplicate bot replies are fixed deterministically (no extra LLM round-trips); etalon proximity from the evaluate step is reused in `post_llm_rules` when the anchor text matches.

**Legacy / вспомогательные (часть влияет на `evaluate_player_message_with_llm` в тестах или старые скрипты, не на основной `send_message` в ИИ-режиме):** `NEGOTIATION_LLM_TWO_STEP`, `NEGOTIATION_STRUCT_*`, `NEGOTIATION_REPLY_*`, `NEGOTIATION_ONESTEP_*`, `NEGOTIATION_QUESTION_*`, `NEGOTIATION_ALLOW_SIMPLE_MODE`, `NEGOTIATION_SEMANTIC_*` — см. `backend/.env.example`.
