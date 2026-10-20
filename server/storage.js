// D1 workspace store. The caller supplies only a verified, server-side userId.
import { createDefaultInitialTemplate } from '../app/default-scenario.js';
import { createModel } from '../app/model.js';
import { RESET_RELEASE } from '../app/release-version.js';
import { validateDocument } from './contracts.js';
const KINDS = new Set(['settings', 'template', 'run']);

const HTTP_STATUS = {
  INVALID_INPUT: 400,
  MEMBER_NOT_FOUND: 403,
  MEMBER_DISABLED: 403,
  MEMBER_IDENTITY_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  MUTATION_CONFLICT: 409,
  ACTIVE_MEMBER_LIMIT: 409,
  STORAGE_QUOTA_EXCEEDED: 409,
  RELEASE_REQUIRED: 409,
};

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = HTTP_STATUS[code] ?? 500;
    this.details = details;
  }
}

function requireText(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new StoreError('INVALID_INPUT', `${name} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

function requireKind(kind) {
  if (!KINDS.has(kind)) throw new StoreError('INVALID_INPUT', 'Unsupported document kind');
  return kind;
}

function requireRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new StoreError('INVALID_INPUT', 'expectedRevision must be a nonnegative safe integer');
  }
  return revision;
}

function stableJson(value) {
  const seen = new Set();
  function encode(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object') throw new StoreError('INVALID_INPUT', 'value must be JSON data');
    if (seen.has(item)) throw new StoreError('INVALID_INPUT', 'value must not contain a cycle');
    seen.add(item);
    let encoded;
    if (Array.isArray(item)) {
      encoded = `[${item.map(encode).join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new StoreError('INVALID_INPUT', 'value must contain only plain objects and arrays');
      }
      encoded = `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
    }
    seen.delete(item);
    return encoded;
  }
  const json = encode(value);
  if (json.length > 2_000_000) throw new StoreError('INVALID_INPUT', 'Document exceeds 2 MB');
  return json;
}

function memberFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    issuer: row.issuer,
    subject: row.subject,
    role: row.role,
    status: row.status,
  };
}

function documentFromRow(row) {
  if (!row || row.deleted) return null;
  return {
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    value: JSON.parse(row.value_json),
    updatedAt: row.updated_at,
  };
}

function mapSqlError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('revision_conflict')) {
    return new StoreError('REVISION_CONFLICT', 'Document revision has changed');
  }
  if (message.includes('mutation_conflict')) {
    return new StoreError('MUTATION_CONFLICT', 'mutationId was already used for a different command');
  }
  if (message.includes('member_inactive')) {
    return new StoreError('MEMBER_DISABLED', 'Member is not active');
  }
  if (message.includes('active_member_limit')) {
    return new StoreError('ACTIVE_MEMBER_LIMIT', 'Only five active members are allowed');
  }
  if (message.includes('storage_quota_exceeded')) {
    return new StoreError('STORAGE_QUOTA_EXCEEDED', 'Workspace storage quota has been reached');
  }
  return error;
}

export function createStore(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new StoreError('INVALID_INPUT', 'A D1-compatible database binding is required');
  }

  async function getMemberById(userId) {
    requireText(userId, 'userId', 256);
    const row = await db.prepare(`SELECT m.*, c.username FROM members m
      JOIN auth_credentials c ON c.member_id = m.id
      WHERE m.id = ? AND m.status = 'active' LIMIT 1`).bind(userId).first();
    return row ? { ...memberFromRow(row), username: row.username } : null;
  }

  async function getMember(issuer, subject, email) {
    requireText(issuer, 'issuer', 1024);
    requireText(subject, 'subject', 1024);
    requireText(email, 'email', 320);
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await db.prepare(
      'SELECT * FROM members WHERE issuer = ? AND subject = ? LIMIT 1',
    ).bind(issuer, subject).first();
    if (existing) {
      if (existing.status !== 'active') throw new StoreError('MEMBER_DISABLED', 'Member is disabled');
      if (existing.email.toLowerCase() !== normalizedEmail) {
        throw new StoreError('MEMBER_IDENTITY_CONFLICT', 'Verified email differs from the invited email');
      }
      return memberFromRow(existing);
    }

    // The conditional UPDATE is the only transition from invited to bound.
    // A stale email or a disabled invitation cannot claim another identity.
    try {
      const result = await db.prepare(`
        UPDATE members SET issuer = ?, subject = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE email = ? COLLATE NOCASE AND issuer IS NULL AND subject IS NULL
          AND status = 'active'
          AND NOT EXISTS (SELECT 1 FROM members WHERE issuer = ? AND subject = ?)
        RETURNING id, email, issuer, subject, role, status
      `).bind(issuer, subject, normalizedEmail, issuer, subject).run();
      if (result.results?.[0]) return memberFromRow(result.results[0]);
    } catch (error) {
      // Another request may have bound the same subject first. Resolve from
      // the unique identity index before deciding whether access is denied.
      const winner = await db.prepare(
        'SELECT * FROM members WHERE issuer = ? AND subject = ? LIMIT 1',
      ).bind(issuer, subject).first();
      if (winner) {
        if (winner.status !== 'active') throw new StoreError('MEMBER_DISABLED', 'Member is disabled');
        if (winner.email.toLowerCase() !== normalizedEmail) {
          throw new StoreError('MEMBER_IDENTITY_CONFLICT', 'Verified email differs from the invited email');
        }
        return memberFromRow(winner);
      }
      throw mapSqlError(error);
    }

    const bound = await db.prepare(
      'SELECT * FROM members WHERE issuer = ? AND subject = ? LIMIT 1',
    ).bind(issuer, subject).first();
    if (bound) {
      if (bound.status !== 'active') throw new StoreError('MEMBER_DISABLED', 'Member is disabled');
      if (bound.email.toLowerCase() !== normalizedEmail) {
        throw new StoreError('MEMBER_IDENTITY_CONFLICT', 'Verified email differs from the invited email');
      }
      return memberFromRow(bound);
    }
    const invitation = await db.prepare('SELECT * FROM members WHERE email = ? COLLATE NOCASE LIMIT 1')
      .bind(normalizedEmail).first();
    if (invitation?.status === 'disabled') throw new StoreError('MEMBER_DISABLED', 'Member is disabled');
    if (invitation?.issuer !== null && invitation?.issuer !== undefined) {
      throw new StoreError('MEMBER_IDENTITY_CONFLICT', 'Email is already bound to another identity');
    }
    return null;
  }

  async function assertActive(userId) {
    requireText(userId, 'userId', 256);
    const member = await db.prepare('SELECT status FROM members WHERE id = ? LIMIT 1')
      .bind(userId).first();
    if (!member) throw new StoreError('MEMBER_NOT_FOUND', 'Member is not found');
    if (member.status !== 'active') throw new StoreError('MEMBER_DISABLED', 'Member is disabled');
  }

  async function readDocument(userId, kind, id) {
    requireKind(kind);
    requireText(id, 'id', 256);
    await assertActive(userId);
    const row = await db.prepare(`
      SELECT id, kind, revision, value_json, deleted, updated_at
      FROM documents WHERE owner_id = ? AND kind = ? AND id = ?
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')
      LIMIT 1
    `).bind(userId, kind, id, userId).first();
    return documentFromRow(row);
  }

  async function listDocuments(userId, kind) {
    requireKind(kind);
    await assertActive(userId);
    const result = await db.prepare(`
      SELECT id, kind, revision, updated_at
      FROM documents WHERE owner_id = ? AND kind = ? AND deleted = 0
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')
      ORDER BY updated_at DESC, id LIMIT 100
    `).bind(userId, kind, userId).all();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      revision: row.revision,
      updatedAt: row.updated_at,
    }));
  }

  async function listHistory(userId, kind, id) {
    requireKind(kind);
    requireText(id, 'id', 256);
    await assertActive(userId);
    const [current, rows] = await Promise.all([
      db.prepare(`SELECT revision, deleted FROM documents WHERE owner_id = ? AND kind = ? AND id = ?
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')`)
        .bind(userId, kind, id, userId).first(),
      db.prepare(`SELECT revision, deleted, updated_at FROM document_history
        WHERE owner_id = ? AND kind = ? AND document_id = ?
          AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')
        ORDER BY revision DESC LIMIT 10`).bind(userId, kind, id, userId).all(),
    ]);
    await assertActive(userId);
    return {
      currentRevision: current?.revision ?? 0,
      deleted: Boolean(current?.deleted),
      history: (rows.results ?? []).map((row) => ({
        revision: row.revision, deleted: Boolean(row.deleted), updatedAt: row.updated_at,
      })),
    };
  }

  async function readHistory(userId, kind, id, revision) {
    requireKind(kind);
    requireText(id, 'id', 256);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new StoreError('INVALID_INPUT', 'revision must be a positive safe integer');
    }
    await assertActive(userId);
    const row = await db.prepare(`SELECT revision, value_json, deleted, updated_at
      FROM document_history WHERE owner_id = ? AND kind = ? AND document_id = ? AND revision = ?
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')`)
      .bind(userId, kind, id, revision, userId).first();
    await assertActive(userId);
    if (!row) return null;
    return { id, kind, revision: row.revision, deleted: Boolean(row.deleted),
      value: row.deleted ? null : JSON.parse(row.value_json), updatedAt: row.updated_at };
  }

  async function getUsage(userId) {
    await assertActive(userId);
    const row = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM documents WHERE owner_id = ?) AS documents,
      (SELECT COUNT(*) FROM document_mutations WHERE owner_id = ?) +
      (SELECT COUNT(*) FROM document_receipts WHERE owner_id = ?) AS receipts,
      (SELECT COUNT(*) FROM document_history WHERE owner_id = ?) AS history_versions,
      (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0)
         FROM document_history WHERE owner_id = ?) AS history_bytes
      WHERE EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')`)
      .bind(userId, userId, userId, userId, userId, userId).first();
    await assertActive(userId);
    return { usage: { documents: row.documents, receipts: row.receipts,
      historyVersions: row.history_versions, historyBytes: row.history_bytes },
      limits: { documents: 100, receipts: 1000, historyVersionsPerDocument: 10,
        historyBytes: 16777216, receiptRetentionDays: 7 } };
  }

  async function listReleaseBackups(userId) {
    await assertActive(userId);
    const rows = await db.prepare(`SELECT release, run_revision, created_at
      FROM release_run_backups WHERE owner_id = ?
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')
      ORDER BY created_at DESC, release DESC LIMIT 100`).bind(userId, userId).all();
    return (rows.results ?? []).map(row => ({ release: row.release,
      runRevision: row.run_revision, createdAt: row.created_at }));
  }

  async function readReleaseBackup(userId, release) {
    requireText(release, 'release', 80);
    await assertActive(userId);
    const row = await db.prepare(`SELECT release, run_revision, run_json, run_updated_at, created_at
      FROM release_run_backups WHERE owner_id = ? AND release = ?
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')
      LIMIT 1`).bind(userId, release, userId).first();
    if (!row) return null;
    return { release: row.release, createdAt: row.created_at,
      document: { id: 'current', kind: 'run', revision: row.run_revision,
        value: JSON.parse(row.run_json), updatedAt: row.run_updated_at } };
  }

  async function upgradeRelease(userId, { expectedRunRevision, expectedTemplateRevision }) {
    requireRevision(expectedRunRevision);
    requireRevision(expectedTemplateRevision);
    await assertActive(userId);
    async function result(upgraded) {
      const [runDocument, templateDocument] = await Promise.all([
        readDocument(userId, 'run', 'current'), readDocument(userId, 'template', 'default'),
      ]);
      return { upgraded, release: RESET_RELEASE, run: runDocument, template: templateDocument };
    }
    const existing = await db.prepare(`SELECT release FROM release_upgrades
      WHERE owner_id = ? AND release = ? LIMIT 1`).bind(userId, RESET_RELEASE).first();
    if (existing) return result(false);
    const template = createDefaultInitialTemplate();
    const model = createModel();
    model.startFromTemplate(template);
    const run = JSON.parse(model.serialize());
    validateDocument('template', 'default', template);
    validateDocument('run', 'current', run);
    const templateJson = stableJson(template);
    const runJson = stableJson(run);
    let inserted = false;
    try {
      const result = await db.prepare(`INSERT INTO release_upgrades
        (owner_id, release, expected_run_revision, expected_template_revision,
         default_run_json, default_template_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, release) DO NOTHING RETURNING release`)
        .bind(userId, RESET_RELEASE, expectedRunRevision, expectedTemplateRevision,
          runJson, templateJson).run();
      inserted = Boolean(result.results?.length);
    } catch (error) { throw mapSqlError(error); }
    const marker = await db.prepare(`SELECT run_revision, template_revision
      FROM release_upgrades WHERE owner_id = ? AND release = ?`).bind(userId, RESET_RELEASE).first();
    if (!marker || !Number.isSafeInteger(marker.run_revision) ||
        !Number.isSafeInteger(marker.template_revision)) {
      throw new Error('Committed release marker was not found');
    }
    await assertActive(userId);
    return result(inserted);
  }

  async function commandHash(kind, id, operation, expectedRevision, valueJson) {
    const source = JSON.stringify([kind, id, operation, expectedRevision, valueJson]);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function mutate(userId, kind, id, operation, options) {
    requireKind(kind);
    requireText(id, 'id', 256);
    if (!options || typeof options !== 'object') {
      throw new StoreError('INVALID_INPUT', 'Mutation options are required');
    }
    const expectedRevision = requireRevision(options.expectedRevision);
    const mutationId = requireText(options.mutationId, 'mutationId', 256);
    const valueJson = operation === 'put' ? stableJson(options.value) : null;
    await assertActive(userId);

    const hash = await commandHash(kind, id, operation, expectedRevision, valueJson);
    // E3A receipts remain readable until they reach the seven-day cleanup age.
    const legacy = await db.prepare(`SELECT kind, document_id, operation, expected_revision,
      value_json, result_revision, result_updated_at FROM document_mutations
      WHERE owner_id = ? AND mutation_id = ?
        AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')
      LIMIT 1`).bind(userId, mutationId, userId).first();
    let inserted = false;
    let record = legacy;
    try {
      if (!record) {
        // Trigger applies CAS, cleanup, history pruning and both quotas in one
        // SQLite statement. Any rejected check rolls back every side effect.
        const result = await db.prepare(`INSERT INTO document_receipts
          (owner_id, kind, document_id, mutation_id, operation, expected_revision, command_hash, value_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_id, mutation_id) DO NOTHING RETURNING mutation_id`)
          .bind(userId, kind, id, mutationId, operation, expectedRevision, hash, valueJson).run();
        inserted = Boolean(result.results?.length);
        record = await db.prepare(`SELECT kind, document_id, operation, expected_revision,
          command_hash, result_revision, result_updated_at FROM document_receipts
          WHERE owner_id = ? AND mutation_id = ? LIMIT 1`).bind(userId, mutationId).first();
      }
    } catch (error) {
      throw mapSqlError(error);
    }
    await assertActive(userId);
    if (!record) throw new Error('Committed mutation record was not found');
    if (record.kind !== kind || record.document_id !== id ||
        record.operation !== operation || record.expected_revision !== expectedRevision ||
        (legacy ? record.value_json !== valueJson : record.command_hash !== hash)) {
      throw new StoreError('MUTATION_CONFLICT', 'mutationId was already used for a different command');
    }
    return {
      id,
      kind,
      revision: record.result_revision,
      ...(operation === 'put' ? { value: JSON.parse(valueJson) } : { deleted: true }),
      updatedAt: record.result_updated_at,
      replayed: !inserted,
    };
  }

  return {
    getMemberById,
    getMember,
    readDocument,
    listDocuments,
    listHistory,
    readHistory,
    getUsage,
    listReleaseBackups,
    readReleaseBackup,
    upgradeRelease,
    putDocument: (userId, kind, id, options) => mutate(userId, kind, id, 'put', options),
    deleteDocument: (userId, kind, id, options) => mutate(userId, kind, id, 'delete', options),
  };
}
