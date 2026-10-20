-- Per-member release reset. One INSERT commits the backup, both new documents,
-- their normal history entries, and the release marker, or none of them.
CREATE TABLE release_upgrades (
  owner_id TEXT NOT NULL REFERENCES members(id),
  release TEXT NOT NULL,
  expected_run_revision INTEGER NOT NULL CHECK (expected_run_revision >= 0),
  expected_template_revision INTEGER NOT NULL CHECK (expected_template_revision >= 0),
  default_run_json TEXT NOT NULL,
  default_template_json TEXT NOT NULL,
  run_revision INTEGER,
  template_revision INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner_id, release)
);

-- Retained beyond the normal ten-version document history limit.
CREATE TABLE release_run_backups (
  owner_id TEXT NOT NULL REFERENCES members(id),
  release TEXT NOT NULL,
  run_revision INTEGER NOT NULL,
  run_json TEXT NOT NULL,
  run_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner_id, release),
  FOREIGN KEY (owner_id, release) REFERENCES release_upgrades(owner_id, release)
);

CREATE TRIGGER apply_release_upgrade
AFTER INSERT ON release_upgrades
BEGIN
  SELECT RAISE(ABORT, 'member_inactive')
  WHERE NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.owner_id AND status = 'active');
  SELECT RAISE(ABORT, 'revision_conflict')
  WHERE COALESCE((SELECT revision FROM documents
    WHERE owner_id = NEW.owner_id AND kind = 'run' AND id = 'current'), 0) <> NEW.expected_run_revision
    OR COALESCE((SELECT revision FROM documents
    WHERE owner_id = NEW.owner_id AND kind = 'template' AND id = 'default'), 0) <> NEW.expected_template_revision;

  INSERT INTO release_run_backups(owner_id, release, run_revision, run_json, run_updated_at)
  SELECT NEW.owner_id, NEW.release, revision, value_json, updated_at
  FROM documents WHERE owner_id = NEW.owner_id AND kind = 'run'
    AND id = 'current' AND deleted = 0;

  -- The E3B receipt triggers apply CAS, normal history, and quotas. A failure
  -- in either nested insertion rolls back this entire release upgrade.
  INSERT INTO document_receipts(owner_id, kind, document_id, mutation_id,
    operation, expected_revision, command_hash, value_json)
  VALUES (NEW.owner_id, 'template', 'default', 'release:' || NEW.release || ':template',
    'put', NEW.expected_template_revision, 'release:' || NEW.release || ':template',
    NEW.default_template_json);
  INSERT INTO document_receipts(owner_id, kind, document_id, mutation_id,
    operation, expected_revision, command_hash, value_json)
  VALUES (NEW.owner_id, 'run', 'current', 'release:' || NEW.release || ':run',
    'put', NEW.expected_run_revision, 'release:' || NEW.release || ':run',
    NEW.default_run_json);
  UPDATE release_upgrades SET
    run_revision = NEW.expected_run_revision + 1,
    template_revision = NEW.expected_template_revision + 1,
    default_run_json = '', default_template_json = ''
  WHERE owner_id = NEW.owner_id AND release = NEW.release;
END;
