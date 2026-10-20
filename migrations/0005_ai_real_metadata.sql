-- Preserve the accepted request's adapter mode and reported token usage.
-- Existing E3C requests were all mock calls, including terminal failures.
ALTER TABLE ai_requests ADD COLUMN simulated INTEGER NOT NULL DEFAULT 1 CHECK (simulated IN (0, 1));
ALTER TABLE ai_requests ADD COLUMN input_tokens INTEGER DEFAULT 0 CHECK (input_tokens IS NULL OR input_tokens >= 0);
ALTER TABLE ai_requests ADD COLUMN output_tokens INTEGER DEFAULT 0 CHECK (output_tokens IS NULL OR output_tokens >= 0);
