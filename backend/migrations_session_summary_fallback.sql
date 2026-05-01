-- Резерв, если в migrations.sql не создалась session_summary: там есть summary_embedding vector(1536),
-- и при отсутствии расширения pgvector весь statement пропускается (см. run_migrations _skip_failed_statement),
-- тогда дашборд падает: load_behavior_batch → session_summary.
-- Эта схема соответствует коду (session_external_id, summary_text, updated_at). Эмбеддинги — опция.

CREATE TABLE IF NOT EXISTS session_summary (
  session_external_id TEXT PRIMARY KEY,
  summary_text        TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
