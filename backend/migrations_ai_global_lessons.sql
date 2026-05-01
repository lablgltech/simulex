-- Таблица ai_global_lessons (глобальные уроки для ИИ-контрагента).
-- Применяется вместе с остальной схемой: python3 run_migrations.py
-- Ручной запуск при необходимости: psql "$POSTGRES_DSN" -f backend/migrations_ai_global_lessons.sql

CREATE TABLE IF NOT EXISTS ai_global_lessons (
  id              BIGSERIAL PRIMARY KEY,
  case_code       TEXT NOT NULL,
  clause_id       TEXT NOT NULL,
  lesson_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_global_lessons_case_clause ON ai_global_lessons(case_code, clause_id);
