CREATE TABLE IF NOT EXISTS session_lexic_stage (
  id                  BIGSERIAL PRIMARY KEY,
  session_external_id TEXT NOT NULL,
  stage_code          TEXT NOT NULL,
  stage_order         INTEGER NOT NULL,
  lexic_before        JSONB NOT NULL,
  lexic_after         JSONB NOT NULL,
  raw_deltas          JSONB NOT NULL,
  normalized_scores   JSONB,
  weight              FLOAT DEFAULT 0.25,
  completed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_external_id, stage_code)
);

CREATE INDEX IF NOT EXISTS idx_session_lexic_stage_session
  ON session_lexic_stage(session_external_id);

CREATE INDEX IF NOT EXISTS idx_session_lexic_stage_stage
  ON session_lexic_stage(stage_code);

CREATE TABLE IF NOT EXISTS report_cache (
  id                  BIGSERIAL PRIMARY KEY,
  session_external_id TEXT NOT NULL,
  report_type         TEXT NOT NULL,
  report_json         JSONB NOT NULL,
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  UNIQUE(session_external_id, report_type)
);

ALTER TABLE game_session ADD COLUMN IF NOT EXISTS total_score_normalized FLOAT;

ALTER TABLE game_session ADD COLUMN IF NOT EXISTS lexic_l_normalized FLOAT;

ALTER TABLE game_session ADD COLUMN IF NOT EXISTS lexic_e_normalized FLOAT;

ALTER TABLE game_session ADD COLUMN IF NOT EXISTS lexic_x_normalized FLOAT;

ALTER TABLE game_session ADD COLUMN IF NOT EXISTS lexic_i_normalized FLOAT;

ALTER TABLE game_session ADD COLUMN IF NOT EXISTS lexic_c_normalized FLOAT;

CREATE INDEX IF NOT EXISTS idx_game_session_total_score_norm
  ON game_session(total_score_normalized DESC NULLS LAST);
