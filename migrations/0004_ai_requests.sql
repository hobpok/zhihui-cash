-- Accepted AI attempts only. Prompt and credentials are never persisted.
CREATE TABLE ai_requests (
  member_id TEXT NOT NULL REFERENCES members(id),
  request_id TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','completed','failed','timed_out','cancelled','expired')),
  result_text TEXT,
  accepted_day TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (member_id, request_id)
);
CREATE INDEX ai_requests_quota ON ai_requests(member_id, accepted_day);
CREATE INDEX ai_requests_active ON ai_requests(member_id, status, lease_until_ms);
CREATE INDEX ai_requests_expiry ON ai_requests(expires_at_ms);
