-- Материализованный обогащённый контент кейса (без чтения md на каждый запрос).
-- Заполняется при force_reseed / синхронизации и при save_case_to_fs.

ALTER TABLE "case" ADD COLUMN IF NOT EXISTS case_content_json JSONB;
ALTER TABLE "case" ADD COLUMN IF NOT EXISTS case_content_synced_at TIMESTAMPTZ;
