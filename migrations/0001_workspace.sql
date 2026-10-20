-- E3A: personal workspace. Seed invited members through a trusted admin path only.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  issuer TEXT,
  subject TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((issuer IS NULL AND subject IS NULL) OR (issuer IS NOT NULL AND subject IS NOT NULL)),
  CHECK (issuer IS NULL OR (length(issuer) > 0 AND length(subject) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS members_identity ON members(issuer, subject)
  WHERE issuer IS NOT NULL AND subject IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS members_max_five_insert
BEFORE INSERT ON members WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'active_member_limit')
  WHERE (SELECT COUNT(*) FROM members WHERE status = 'active') >= 5;
END;
CREATE TRIGGER IF NOT EXISTS members_max_five_activate
BEFORE UPDATE OF status ON members
WHEN NEW.status = 'active' AND OLD.status <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'active_member_limit')
  WHERE (SELECT COUNT(*) FROM members WHERE status = 'active') >= 5;
END;

CREATE TABLE IF NOT EXISTS documents (
  owner_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('settings', 'template', 'run')),
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  value_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, kind, id),
  CHECK ((deleted = 1 AND value_json IS NULL) OR (deleted = 0 AND value_json IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS documents_live_by_owner_kind
  ON documents(owner_id, kind, updated_at DESC, id) WHERE deleted = 0;

-- The mutation record is the idempotency key and the write command. Its AFTER
-- trigger performs the CAS and document update in the same SQLite statement.
CREATE TABLE IF NOT EXISTS document_mutations (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('settings', 'template', 'run')),
  document_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  value_json TEXT,
  result_revision INTEGER,
  result_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner_id, mutation_id),
  FOREIGN KEY (owner_id) REFERENCES members(id),
  CHECK ((operation = 'put' AND value_json IS NOT NULL) OR
         (operation = 'delete' AND value_json IS NULL))
);

CREATE TRIGGER IF NOT EXISTS apply_document_mutation
AFTER INSERT ON document_mutations
BEGIN
  SELECT RAISE(ABORT, 'member_inactive')
  WHERE NOT EXISTS (SELECT 1 FROM members
                    WHERE id = NEW.owner_id AND status = 'active');
  SELECT RAISE(ABORT, 'revision_conflict')
  WHERE COALESCE((SELECT revision FROM documents
                  WHERE owner_id = NEW.owner_id AND kind = NEW.kind
                    AND id = NEW.document_id), 0) <> NEW.expected_revision;
  SELECT RAISE(ABORT, 'storage_quota_exceeded')
  WHERE (SELECT COUNT(*) FROM document_mutations
         WHERE owner_id = NEW.owner_id) > 1000
     OR (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0)
         FROM document_mutations WHERE owner_id = NEW.owner_id) > 16777216;
  SELECT RAISE(ABORT, 'storage_quota_exceeded')
  WHERE NOT EXISTS (SELECT 1 FROM documents
                    WHERE owner_id = NEW.owner_id AND kind = NEW.kind
                      AND id = NEW.document_id)
    AND (SELECT COUNT(*) FROM documents
         WHERE owner_id = NEW.owner_id) >= 100;

  INSERT INTO documents(owner_id, kind, id, revision, value_json, deleted, updated_at)
  VALUES (NEW.owner_id, NEW.kind, NEW.document_id, NEW.expected_revision + 1,
          NEW.value_json, CASE WHEN NEW.operation = 'delete' THEN 1 ELSE 0 END,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(owner_id, kind, id) DO UPDATE SET
    revision = excluded.revision,
    value_json = excluded.value_json,
    deleted = excluded.deleted,
    updated_at = excluded.updated_at;

  UPDATE document_mutations SET
    result_revision = NEW.expected_revision + 1,
    result_updated_at = (SELECT updated_at FROM documents
                         WHERE owner_id = NEW.owner_id AND kind = NEW.kind
                           AND id = NEW.document_id)
  WHERE owner_id = NEW.owner_id AND mutation_id = NEW.mutation_id;
END;
