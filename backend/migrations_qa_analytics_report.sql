-- Кэш автоматического аналитического отчёта по замечаниям QA (на область видимости группы или пользователя).
-- Применение: cd backend && python run_qa_bugs_migration.py

CREATE TABLE IF NOT EXISTS qa_analytics_report (
  id BIGSERIAL PRIMARY KEY,
  scope_group_id INTEGER REFERENCES user_group(id) ON DELETE CASCADE,
  scope_user_id INTEGER REFERENCES "user"(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qa_analytics_report_one_scope CHECK (
    (scope_group_id IS NOT NULL AND scope_user_id IS NULL)
    OR (scope_group_id IS NULL AND scope_user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_analytics_scope_group
  ON qa_analytics_report (scope_group_id)
  WHERE scope_group_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_analytics_scope_user
  ON qa_analytics_report (scope_user_id)
  WHERE scope_user_id IS NOT NULL;
