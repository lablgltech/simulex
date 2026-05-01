-- Первичная схема PostgreSQL для Симулекса.
-- Выполнить один раз перед запуском backend, используя psql, например:
--   psql "$POSTGRES_DSN" -f backend/migrations.sql

-- Таблица описаний кейсов (case.json -> БД)
CREATE TABLE IF NOT EXISTS "case" (
  id                SERIAL PRIMARY KEY,
  code              TEXT UNIQUE NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'published',
  lexic_initial     JSONB,
  settings_json     JSONB,
  negotiation_contract_id INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Таблица этапов кейса
CREATE TABLE IF NOT EXISTS case_stage (
  id            SERIAL PRIMARY KEY,
  case_id       INTEGER NOT NULL REFERENCES "case"(id) ON DELETE CASCADE,
  order_index   INTEGER NOT NULL,
  stage_code    TEXT NOT NULL,
  type          TEXT NOT NULL,
  title         TEXT,
  points_budget INTEGER,
  config_json   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_stage_case_id ON case_stage(case_id);

-- Таблица действий этапов
CREATE TABLE IF NOT EXISTS case_stage_action (
  id                SERIAL PRIMARY KEY,
  stage_id          INTEGER NOT NULL REFERENCES case_stage(id) ON DELETE CASCADE,
  code              TEXT NOT NULL,
  title             TEXT NOT NULL,
  type              TEXT NOT NULL,
  is_required       BOOLEAN NOT NULL DEFAULT FALSE,
  costs_json        JSONB,
  lexic_impact_json JSONB,
  prerequisites_json JSONB,
  mutex_group       TEXT,
  payload_json      JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_stage_action_stage_id ON case_stage_action(stage_id);

-- Таблица шаблонов этапов (опционально для админки)
CREATE TABLE IF NOT EXISTS stage_template (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  stage_type  TEXT NOT NULL,
  config_json JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Общая игровая сессия Симулекса
CREATE TABLE IF NOT EXISTS game_session (
  id           BIGSERIAL PRIMARY KEY,
  external_id  TEXT UNIQUE NOT NULL,
  case_code    TEXT NOT NULL,
  payload_json JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_session_external ON game_session(external_id);

-- Договоры переговоров
CREATE TABLE IF NOT EXISTS contract (
  id                 SERIAL PRIMARY KEY,
  code               TEXT UNIQUE,
  description        TEXT,
  link_md            TEXT,
  link_gamedata_json TEXT,
  game_data_json     JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Сессия этапа в рамках общей сессии Симулекса
CREATE TABLE IF NOT EXISTS stage_session (
  id                 BIGSERIAL PRIMARY KEY,
  simulex_session_id TEXT NOT NULL,
  stage_code         TEXT NOT NULL,
  case_code          TEXT NOT NULL,
  payload_json       JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stage_session_simulex ON stage_session(simulex_session_id, stage_code);

-- Сессия переговоров (подсессия этапа 3)
CREATE TABLE IF NOT EXISTS negotiation_session (
  id              BIGSERIAL PRIMARY KEY,
  stage_session_id BIGINT NOT NULL REFERENCES stage_session(id) ON DELETE CASCADE,
  contract_id     INTEGER NOT NULL REFERENCES contract(id) ON DELETE RESTRICT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  history_json    JSONB,
  lexic_snapshot  JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_session_stage ON negotiation_session(stage_session_id);

-- Глобальные «уроки» для ИИ-контрагента (применяются во всех сессиях/кейсах по пункту)
CREATE TABLE IF NOT EXISTS ai_global_lessons (
  id              BIGSERIAL PRIMARY KEY,
  case_code       TEXT NOT NULL,
  clause_id       TEXT NOT NULL,
  lesson_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_global_lessons_case_clause ON ai_global_lessons(case_code, clause_id);

-- Лог событий этапов
CREATE TABLE IF NOT EXISTS stage_event_log (
  id               BIGSERIAL PRIMARY KEY,
  stage_session_id BIGINT NOT NULL REFERENCES stage_session(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_json     JSONB
);

CREATE INDEX IF NOT EXISTS idx_stage_event_log_stage ON stage_event_log(stage_session_id);

-- Расширение pgvector для RAG (векторные представления текста)
CREATE EXTENSION IF NOT EXISTS vector;

-- Документы для RAG (кейсы и база знаний)
CREATE TABLE IF NOT EXISTS rag_document (
  id          BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL,        -- 'case' | 'kb' и т.п.
  case_code   TEXT,                 -- code из таблицы "case" (например, 'case-001')
  stage_code  TEXT,                 -- код этапа (например, 'stage-2'), если применимо
  doc_type    TEXT NOT NULL,        -- 'contract', 'stage_doc', 'resource', 'kb_article', ...
  path        TEXT,                 -- относительный путь к исходному файлу в репо
  title       TEXT,
  full_text   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_document_source_case_stage
  ON rag_document(source_type, case_code, stage_code);

-- Чанки документов для векторного поиска
CREATE TABLE IF NOT EXISTS rag_document_chunk (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES rag_document(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedding   vector(1536),         -- размерность под OpenAI text-embedding-3-small / ada-002
  metadata    JSONB
);

CREATE INDEX IF NOT EXISTS idx_rag_chunk_document
  ON rag_document_chunk(document_id, chunk_index);

-- IVF‑индекс по вектору для ускорения поиска (cosine distance)
CREATE INDEX IF NOT EXISTS idx_rag_chunk_embedding
  ON rag_document_chunk
  USING ivfflat (embedding vector_cosine_ops);

-- Лог действий в рамках игровой сессии (для контекста тьютора и аналитики)
CREATE TABLE IF NOT EXISTS session_action_log (
  id                  BIGSERIAL PRIMARY KEY,
  session_external_id TEXT NOT NULL,   -- строковый ID сессии (session["id"])
  case_code           TEXT,
  stage_code          TEXT,
  action_type         TEXT NOT NULL,   -- 'session_start', 'open_doc', 'select_risk', ...
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_json        JSONB
);

CREATE INDEX IF NOT EXISTS idx_session_action_log_session
  ON session_action_log(session_external_id, created_at);

-- Лог сообщений тьютора (диалог игрока и ИИ)
CREATE TABLE IF NOT EXISTS tutor_message_log (
  id                  BIGSERIAL PRIMARY KEY,
  session_external_id TEXT,            -- может быть NULL до старта кейса
  role                TEXT NOT NULL,   -- 'user' | 'assistant' | 'system'
  content             TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tutor_message_log_session
  ON tutor_message_log(session_external_id, created_at);

-- Краткое summary сессии (для промпта тьютора)
CREATE TABLE IF NOT EXISTS session_summary (
  session_external_id TEXT PRIMARY KEY,
  summary_text        TEXT,
  summary_embedding   vector(1536),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Профиль soft-skills по сессии
CREATE TABLE IF NOT EXISTS session_soft_skills (
  session_external_id TEXT PRIMARY KEY,
  profile_json        JSONB,           -- агрегированный профиль навыков (argumentation_level, risk_aversion, ...)
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Semantic Catalog (описание таблиц аналитики и примеров NL→SQL вопросов)
CREATE TABLE IF NOT EXISTS semantic_table_catalog (
  table_name    TEXT PRIMARY KEY,
  description   TEXT,        -- человекочитаемое описание: что за таблица, какие сущности
  business_facts JSONB,      -- ключевые «факты»: что считается попыткой, что — провалом этапа и т.п.
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS semantic_query_example (
  id            BIGSERIAL PRIMARY KEY,
  category      TEXT,              -- 'sessions', 'stages', 'lexic', ...
  natural_text  TEXT NOT NULL,     -- «Покажи, какие этапы чаще всего проваливаются по L»
  sql_query     TEXT NOT NULL,     -- готовый SQL
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Очередь задач на пересчёт эмбеддингов для RAG
CREATE TABLE IF NOT EXISTS rag_embedding_job (
  id            BIGSERIAL PRIMARY KEY,
  source_id     TEXT NOT NULL,          -- id из vectorizers.yaml (например, 'cases_markdown', 'kb_markdown')
  source_key    TEXT NOT NULL,          -- уникальный ключ документа (относительный путь, id строки и т.п.)
  payload       JSONB,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|error
  attempt_count INT  NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_run_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_embedding_job_status ON rag_embedding_job (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_rag_embedding_job_source ON rag_embedding_job (source_id, source_key);

-- Full-text search по тексту чанков RAG (keyword-поиск для тьютора)
CREATE INDEX IF NOT EXISTS idx_rag_chunk_text_fts
  ON rag_document_chunk
  USING GIN (to_tsvector('russian', text));

-- Лог запросов RAG для анализа качества
CREATE TABLE IF NOT EXISTS rag_query_log (
  id                  BIGSERIAL PRIMARY KEY,
  session_external_id TEXT,
  question            TEXT NOT NULL,
  case_code           TEXT,
  stage_code          TEXT,
  include_kb          BOOLEAN,
  top_k_semantic      INT,
  top_k_keyword       INT,
  max_total           INT,
  chunks_returned     INT,
  chunk_paths         TEXT[],  -- массив путей найденных чанков
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_query_log_session 
  ON rag_query_log(session_external_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rag_query_log_case_stage 
  ON rag_query_log(case_code, stage_code);

-- Сущности в графе знаний
CREATE TABLE IF NOT EXISTS rag_entity (
  id          BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,  -- 'risk', 'clause', 'consequence', 'action', 'document'
  name        TEXT NOT NULL,
  description TEXT,
  case_code   TEXT,
  stage_code  TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_entity_type_case 
  ON rag_entity(entity_type, case_code, stage_code);
CREATE INDEX IF NOT EXISTS idx_rag_entity_name 
  ON rag_entity(name);

-- Связи между сущностями
CREATE TABLE IF NOT EXISTS rag_edge (
  id            BIGSERIAL PRIMARY KEY,
  from_entity_id BIGINT NOT NULL REFERENCES rag_entity(id) ON DELETE CASCADE,
  to_entity_id   BIGINT NOT NULL REFERENCES rag_entity(id) ON DELETE CASCADE,
  edge_type     TEXT NOT NULL,  -- 'relates_to', 'causes', 'mitigates', 'references'
  weight        FLOAT DEFAULT 1.0,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_edge_from ON rag_edge(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_rag_edge_to ON rag_edge(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_rag_edge_type ON rag_edge(edge_type);

-- Связь чанков с сущностями (many-to-many)
CREATE TABLE IF NOT EXISTS rag_chunk_entity (
  chunk_id    BIGINT NOT NULL REFERENCES rag_document_chunk(id) ON DELETE CASCADE,
  entity_id   BIGINT NOT NULL REFERENCES rag_entity(id) ON DELETE CASCADE,
  PRIMARY KEY (chunk_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_chunk_entity_chunk ON rag_chunk_entity(chunk_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunk_entity_entity ON rag_chunk_entity(entity_id);

-- История показанных чанков для персонализации
CREATE TABLE IF NOT EXISTS rag_session_chunk_history (
  session_external_id TEXT NOT NULL,
  chunk_id            BIGINT NOT NULL REFERENCES rag_document_chunk(id) ON DELETE CASCADE,
  shown_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_external_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_session_chunk_history_session 
  ON rag_session_chunk_history(session_external_id, shown_at);

-- Группы пользователей (отчёты/дашборд для admin — только своя группа)
CREATE TABLE IF NOT EXISTS user_group (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Пользователи и роли: superuser, admin, user
CREATE TABLE IF NOT EXISTS "user" (
  id         SERIAL PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  email      TEXT,
  password_hash TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('superuser', 'admin', 'user')),
  group_id   INTEGER REFERENCES user_group(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_username ON "user"(username);
CREATE INDEX IF NOT EXISTS idx_user_role ON "user"(role);
CREATE INDEX IF NOT EXISTS idx_user_group_id ON "user"(group_id);

-- Привязка игровых сессий к пользователю (опционально)
ALTER TABLE game_session ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_game_session_user_id ON game_session(user_id);
