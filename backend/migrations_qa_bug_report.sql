-- Замечания / баги QA (встроенный простой трекер).
-- Применение: cd backend && python run_qa_bugs_migration.py

CREATE TABLE IF NOT EXISTS qa_bug_report (
  id                  BIGSERIAL PRIMARY KEY,
  reporter_id         INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  reporter_group_id   INTEGER REFERENCES user_group(id) ON DELETE SET NULL,
  area                TEXT NOT NULL,
  finding_type        TEXT NOT NULL,
  severity            TEXT NOT NULL,
  title               TEXT NOT NULL,
  steps               TEXT NOT NULL DEFAULT '',
  expected_text       TEXT NOT NULL DEFAULT '',
  actual_text         TEXT NOT NULL DEFAULT '',
  environment         TEXT NOT NULL DEFAULT '',
  case_code           TEXT,
  session_external_id TEXT,
  attachment_url      TEXT,
  status              TEXT NOT NULL DEFAULT 'new',
  admin_note          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_bug_reporter ON qa_bug_report(reporter_id);
CREATE INDEX IF NOT EXISTS idx_qa_bug_group ON qa_bug_report(reporter_group_id);
CREATE INDEX IF NOT EXISTS idx_qa_bug_status ON qa_bug_report(status);
CREATE INDEX IF NOT EXISTS idx_qa_bug_created ON qa_bug_report(created_at DESC);
