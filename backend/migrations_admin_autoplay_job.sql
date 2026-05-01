-- Статус фонового ИИ-прогона (админка): общее хранилище для нескольких gunicorn-воркеров.
CREATE TABLE IF NOT EXISTS admin_autoplay_job (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
  case_id TEXT,
  user_id INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  result_json JSONB,
  error_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_autoplay_job_started ON admin_autoplay_job (started_at DESC);
