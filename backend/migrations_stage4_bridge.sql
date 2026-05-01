-- Мост этап 3 → этап 4: согласованные тексты и выборы A/B/C на игровую сессию.
-- Запуск: python run_stage4_bridge_migration.py

CREATE TABLE IF NOT EXISTS game_session_stage4_bridge (
  id BIGSERIAL PRIMARY KEY,
  game_session_external_id TEXT NOT NULL,
  case_code TEXT NOT NULL,
  original_text_by_clause_id JSONB NOT NULL DEFAULT '{}'::jsonb,
  contract_selections JSONB NOT NULL DEFAULT '{}'::jsonb,
  selection_source JSONB NOT NULL DEFAULT '{}'::jsonb,
  option_texts_snapshot JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_stage4_bridge_session_case UNIQUE (game_session_external_id, case_code)
);

CREATE INDEX IF NOT EXISTS idx_stage4_bridge_session ON game_session_stage4_bridge (game_session_external_id);
CREATE INDEX IF NOT EXISTS idx_stage4_bridge_case ON game_session_stage4_bridge (case_code);
