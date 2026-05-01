-- QA: вложения-скрины, критичность словами (миграция с P0–P3).

ALTER TABLE qa_bug_report ADD COLUMN IF NOT EXISTS attachments_json JSONB DEFAULT '[]'::jsonb;

UPDATE qa_bug_report
SET severity = CASE trim(severity)
  WHEN 'P0' THEN 'высокая'
  WHEN 'P1' THEN 'высокая'
  WHEN 'P2' THEN 'средняя'
  WHEN 'P3' THEN 'низкая'
  ELSE trim(severity)
END
WHERE trim(severity) IN ('P0', 'P1', 'P2', 'P3');
