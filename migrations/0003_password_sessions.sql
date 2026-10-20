-- Five fixed local accounts. Existing member IDs and document ownership remain intact.
CREATE TABLE auth_credentials (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK (iterations >= 100000),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX auth_sessions_member ON auth_sessions(member_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at_ms);
CREATE TABLE auth_failures (
  key_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start_ms INTEGER NOT NULL,
  locked_until_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX auth_failures_expiry ON auth_failures(locked_until_ms);
