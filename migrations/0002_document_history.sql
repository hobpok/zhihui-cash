-- E3B: bounded history and seven-day idempotency receipts.
-- Apply after 0001_workspace.sql, before deploying the E3B server code.
DROP TRIGGER apply_document_mutation;

-- Old application code must fail closed during a rolling migration.
CREATE TRIGGER reject_legacy_document_mutation
BEFORE INSERT ON document_mutations
BEGIN
  SELECT RAISE(ABORT, 'upgrade_required');
END;

CREATE TABLE document_history (
  owner_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('settings', 'template', 'run')),
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  value_json TEXT,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, kind, document_id, revision),
  CHECK ((deleted = 1 AND value_json IS NULL) OR (deleted = 0 AND value_json IS NOT NULL))
);

-- Preserve the newest ten versions from existing E3A installations.
INSERT INTO document_history(owner_id, kind, document_id, revision, value_json, deleted, updated_at)
SELECT owner_id, kind, document_id, result_revision, value_json,
       CASE WHEN operation = 'delete' THEN 1 ELSE 0 END, result_updated_at
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY owner_id, kind, document_id ORDER BY result_revision DESC
  ) AS version_rank
  FROM document_mutations WHERE result_revision IS NOT NULL
) WHERE version_rank <= 10;

INSERT OR IGNORE INTO document_history(owner_id, kind, document_id, revision, value_json, deleted, updated_at)
SELECT owner_id, kind, id, revision, value_json, deleted, updated_at FROM documents;

DELETE FROM document_history AS older
WHERE revision NOT IN (
  SELECT revision FROM document_history AS newest
  WHERE newest.owner_id = older.owner_id AND newest.kind = older.kind
    AND newest.document_id = older.document_id
  ORDER BY revision DESC LIMIT 10
);

CREATE INDEX document_history_by_owner ON document_history(owner_id, kind, document_id, revision DESC);

CREATE TABLE document_receipts (
  owner_id TEXT NOT NULL REFERENCES members(id),
  mutation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('settings', 'template', 'run')),
  document_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  command_hash TEXT NOT NULL,
  value_json TEXT,
  result_revision INTEGER,
  result_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner_id, mutation_id)
);
CREATE INDEX document_receipts_age ON document_receipts(owner_id, created_at);
CREATE INDEX document_mutations_age ON document_mutations(owner_id, created_at);

-- BEFORE INSERT runs even for ON CONFLICT DO NOTHING. Removing an expired
-- receipt with this same key therefore makes it a new command subject to CAS.
-- A rejected AFTER trigger rolls back this cleanup too.
CREATE TRIGGER expire_document_receipts
BEFORE INSERT ON document_receipts
BEGIN
  SELECT RAISE(ABORT, 'member_inactive')
  WHERE NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.owner_id AND status = 'active');

  -- Age alone permits removal. Never evict a younger receipt merely to free quota.
  DELETE FROM document_mutations
  WHERE owner_id = NEW.owner_id AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days');
  DELETE FROM document_receipts
  WHERE owner_id = NEW.owner_id
    AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days');

  SELECT RAISE(ABORT, 'mutation_conflict')
  WHERE EXISTS (SELECT 1 FROM document_receipts
    WHERE owner_id = NEW.owner_id AND mutation_id = NEW.mutation_id
      AND command_hash <> NEW.command_hash);
END;

CREATE TRIGGER apply_document_receipt
AFTER INSERT ON document_receipts
BEGIN

  SELECT RAISE(ABORT, 'mutation_conflict')
  WHERE EXISTS (SELECT 1 FROM document_mutations
                WHERE owner_id = NEW.owner_id AND mutation_id = NEW.mutation_id);
  SELECT RAISE(ABORT, 'revision_conflict')
  WHERE COALESCE((SELECT revision FROM documents
                  WHERE owner_id = NEW.owner_id AND kind = NEW.kind
                    AND id = NEW.document_id), 0) <> NEW.expected_revision;
  SELECT RAISE(ABORT, 'storage_quota_exceeded')
  WHERE (SELECT COUNT(*) FROM document_mutations WHERE owner_id = NEW.owner_id)
      + (SELECT COUNT(*) FROM document_receipts WHERE owner_id = NEW.owner_id) > 1000;
  SELECT RAISE(ABORT, 'storage_quota_exceeded')
  WHERE NOT EXISTS (SELECT 1 FROM documents
                    WHERE owner_id = NEW.owner_id AND kind = NEW.kind
                      AND id = NEW.document_id)
    AND (SELECT COUNT(*) FROM documents WHERE owner_id = NEW.owner_id) >= 100;

  INSERT INTO documents(owner_id, kind, id, revision, value_json, deleted, updated_at)
  VALUES (NEW.owner_id, NEW.kind, NEW.document_id, NEW.expected_revision + 1,
          NEW.value_json, CASE WHEN NEW.operation = 'delete' THEN 1 ELSE 0 END,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(owner_id, kind, id) DO UPDATE SET
    revision = excluded.revision, value_json = excluded.value_json,
    deleted = excluded.deleted, updated_at = excluded.updated_at;

  INSERT INTO document_history(owner_id, kind, document_id, revision, value_json, deleted, updated_at)
  SELECT owner_id, kind, id, revision, value_json, deleted, updated_at
  FROM documents WHERE owner_id = NEW.owner_id AND kind = NEW.kind AND id = NEW.document_id;
  DELETE FROM document_history
  WHERE owner_id = NEW.owner_id AND kind = NEW.kind AND document_id = NEW.document_id
    AND revision NOT IN (
      SELECT revision FROM document_history
      WHERE owner_id = NEW.owner_id AND kind = NEW.kind AND document_id = NEW.document_id
      ORDER BY revision DESC LIMIT 10
    );
  SELECT RAISE(ABORT, 'storage_quota_exceeded')
  WHERE (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0)
         FROM document_history WHERE owner_id = NEW.owner_id) > 16777216;

  UPDATE document_receipts SET result_revision = NEW.expected_revision + 1,
    result_updated_at = (SELECT updated_at FROM documents
      WHERE owner_id = NEW.owner_id AND kind = NEW.kind AND id = NEW.document_id),
    value_json = NULL
  WHERE owner_id = NEW.owner_id AND mutation_id = NEW.mutation_id;
END;
