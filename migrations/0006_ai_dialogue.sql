-- Dialogue shares the accepted-attempt quota and lease with connectivity probes.
-- The source document and revision are included in prompt_hash, never persisted as input.
ALTER TABLE ai_requests ADD COLUMN operation TEXT NOT NULL DEFAULT 'probe'
  CHECK (operation IN ('probe', 'dialogue'));
ALTER TABLE ai_requests ADD COLUMN result_json TEXT;
