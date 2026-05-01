-- Группы пользователей: изоляция отчётов и дашборда для роли admin.
-- Суперюзер создаёт группы и назначает их при создании admin/user.
-- Запуск: psql $POSTGRES_DSN -f migrations_user_groups.sql

CREATE TABLE IF NOT EXISTS user_group (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES user_group(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_user_group_id ON "user"(group_id);

-- Одна группа по умолчанию для уже существующих admin/user без группы
INSERT INTO user_group (name)
SELECT 'По умолчанию'
WHERE NOT EXISTS (SELECT 1 FROM user_group LIMIT 1);

UPDATE "user" u
SET group_id = (SELECT id FROM user_group ORDER BY id LIMIT 1)
WHERE u.group_id IS NULL AND u.role IN ('admin', 'user');
