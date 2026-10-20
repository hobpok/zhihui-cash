import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from './storage.js';
import { sqliteD1, seed, applyMigrations } from './test-support/sqlite-d1.js';

const put = (store, revision, value = { revision }, mutationId = `save-${revision}`) =>
  store.putDocument('u1', 'run', 'current', { expectedRevision: revision, mutationId, value });
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
function snapshot(sqlite) {
  return ['documents', 'document_history', 'document_mutations', 'document_receipts']
    .map(table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('history keeps newest ten revisions including deletion; pruned receipt still retries exactly', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.test');
    const store = createStore(db);
    const first = await put(store, 0, { b: 2, a: 1 });
    for (let i = 1; i <= 12; i++) await put(store, i);
    const deleted = await store.deleteDocument('u1', 'run', 'current', { expectedRevision: 13, mutationId: 'delete-last' });
    const history = await store.listHistory('u1', 'run', 'current');
    assert.deepEqual(history.history.map(row => row.revision), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
    assert.equal(history.currentRevision, 14);
    assert.equal(history.deleted, true);
    assert.deepEqual(history.history[0], { revision: 14, deleted: true, updatedAt: deleted.updatedAt });
    assert.deepEqual(await store.readHistory('u1', 'run', 'current', 14), {
      id: 'current', kind: 'run', revision: 14, value: null, deleted: true, updatedAt: deleted.updatedAt,
    });
    assert.deepEqual((await store.readHistory('u1', 'run', 'current', 13)).value, { revision: 12 });
    assert.equal(await store.readHistory('u1', 'run', 'current', 1), null);
    assert.deepEqual(await put(store, 0, { a: 1, b: 2 }), { ...first, replayed: true });
    await rejected(put(store, 0, { a: 7, b: 2 }), 'MUTATION_CONFLICT');
    assert.equal(await store.readDocument('u1', 'run', 'current'), null);
    const usage = await store.getUsage('u1');
    assert.equal(usage.usage.historyVersions, 10);
    assert.equal(usage.usage.receipts, 14);
    assert.equal(usage.limits.receiptRetentionDays, 7);
    assert.equal(usage.limits.historyVersionsPerDocument, 10);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM document_receipts WHERE value_json IS NOT NULL').get().n, 0);
    assert.match(sqlite.prepare('SELECT command_hash FROM document_receipts LIMIT 1').get().command_hash, /^[a-f0-9]{64}$/);
  } finally { sqlite.close(); }
});

test('an expired receipt cannot replay or bypass CAS, including retries after tombstone', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.test');
    const store = createStore(db);
    await put(store, 0);
    await store.deleteDocument('u1', 'run', 'current', { expectedRevision: 1, mutationId: 'delete-last' });
    sqlite.prepare("UPDATE document_receipts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days')").run();
    const before = snapshot(sqlite);
    await rejected(put(store, 0), 'REVISION_CONFLICT');
    await rejected(store.deleteDocument('u1', 'run', 'current', { expectedRevision: 1, mutationId: 'delete-last' }), 'REVISION_CONFLICT');
    assert.deepEqual(snapshot(sqlite), before, 'failed CAS rolls back cleanup and all data changes');
    await put(store, 2, { restored: true }, 'restore-now');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM document_receipts').get().n, 1);
    assert.equal((await store.listHistory('u1', 'run', 'current')).history.length, 3);
    await rejected(put(store, 0), 'REVISION_CONFLICT');
    assert.deepEqual((await store.readDocument('u1', 'run', 'current')).value, { restored: true });
  } finally { sqlite.close(); }
});

test('receipt retention protects recent exact outcomes, recycles only aged keys at capacity', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.test');
    const store = createStore(db);
    for (let i = 0; i < 1000; i++) await put(store, i);
    await rejected(put(store, 1000), 'STORAGE_QUOTA_EXCEEDED');
    assert.equal((await put(store, 0)).revision, 1);
    sqlite.prepare("UPDATE document_receipts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days') WHERE mutation_id <> 'save-999'").run();
    await rejected(put(store, 0), 'REVISION_CONFLICT');
    await put(store, 1000);
    assert.equal((await store.getUsage('u1')).usage.receipts, 2);
    assert.equal((await put(store, 999)).revision, 1000);
    assert.equal((await put(store, 1000)).revision, 1001);
    assert.equal((await store.listHistory('u1', 'run', 'current')).history.length, 10);
  } finally { sqlite.close(); }
});

test('history quota applies after pruning instead of accumulating every autosave body', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.test');
    const store = createStore(db);
    const value = { text: 'x'.repeat(1_400_000) };
    for (let i = 0; i < 20; i++) await put(store, i, value);
    const usage = await store.getUsage('u1');
    assert.equal(usage.usage.historyVersions, 10);
    assert.equal(usage.usage.historyBytes, Buffer.byteLength(JSON.stringify(value)) * 10);
    assert.equal(usage.usage.receipts, 20);
    assert.equal((await put(store, 0, value)).revision, 1);
    assert.equal((await store.readDocument('u1', 'run', 'current')).revision, 20);
  } finally { sqlite.close(); }
});

test('history-byte quota rejection rolls back cleanup, document CAS, new version and pruning', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.test');
    const store = createStore(db);
    for (let i = 0; i < 10; i++) await put(store, i, { text: 'x'.repeat(1_600_000) });
    sqlite.prepare("UPDATE document_receipts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days')").run();
    await store.putDocument('u1', 'run', 'other', { expectedRevision: 0, mutationId: 'other-small', value: { text: 'y'.repeat(600_000) } });
    // Make one receipt reclaimable so rollback includes age cleanup.
    sqlite.prepare("UPDATE document_receipts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days')").run();
    const before = snapshot(sqlite);
    await rejected(put(store, 10, { text: 'z'.repeat(1_800_000) }), 'STORAGE_QUOTA_EXCEEDED');
    assert.deepEqual(snapshot(sqlite), before);
    assert.equal((await store.readDocument('u1', 'run', 'current')).revision, 10);
    assert.equal((await store.readHistory('u1', 'run', 'current', 1)).revision, 1);
    assert.equal(await store.readHistory('u1', 'run', 'current', 11), null);
  } finally { sqlite.close(); }
});

test('0001 upgrade preserves old retry outcomes and newest history; old code fails closed', async () => {
  const { sqlite, db } = sqliteD1({ through: '0001_workspace.sql' });
  try {
    seed(sqlite, 'u1', 'one@example.test');
    const legacyWrite = sqlite.prepare(`INSERT INTO document_mutations
      (owner_id, kind, document_id, mutation_id, operation, expected_revision, value_json)
      VALUES ('u1', 'run', 'current', ?, 'put', ?, ?)`);
    for (let i = 0; i < 12; i++) legacyWrite.run(`legacy-${i}`, i, JSON.stringify({ revision: i }));
    const oldTime = sqlite.prepare("SELECT result_updated_at FROM document_mutations WHERE mutation_id = 'legacy-0'").get().result_updated_at;
    applyMigrations(sqlite, { after: '0001_workspace.sql' });
    const store = createStore(db);
    const retry = await put(store, 0, { revision: 0 }, 'legacy-0');
    assert.deepEqual(retry, { id: 'current', kind: 'run', revision: 1, value: { revision: 0 }, replayed: true, updatedAt: oldTime });
    await rejected(put(store, 0, { revision: 9 }, 'legacy-0'), 'MUTATION_CONFLICT');
    assert.throws(() => legacyWrite.run('old-code', 12, '{}'), /upgrade_required/);
    assert.deepEqual((await store.listHistory('u1', 'run', 'current')).history.map(row => row.revision), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    await put(store, 12);
    assert.equal((await store.getUsage('u1')).usage.receipts, 13);
    sqlite.prepare("UPDATE document_mutations SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days')").run();
    await rejected(put(store, 0, { revision: 0 }, 'legacy-0'), 'REVISION_CONFLICT');
    await put(store, 13);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM document_mutations').get().n, 0);
    assert.equal((await store.getUsage('u1')).usage.receipts, 2);
    assert.equal((await store.readDocument('u1', 'run', 'current')).revision, 14);
  } finally { sqlite.close(); }
});

test('history and usage are isolated across owners and denied to disabled members', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.test');
    seed(sqlite, 'u2', 'two@example.test');
    const store = createStore(db);
    await put(store, 0);
    assert.deepEqual((await store.listHistory('u2', 'run', 'current')).history, []);
    assert.equal(await store.readHistory('u2', 'run', 'current', 1), null);
    assert.deepEqual((await store.getUsage('u2')).usage, { documents: 0, receipts: 0, historyVersions: 0, historyBytes: 0 });
    sqlite.prepare("UPDATE members SET status = 'disabled' WHERE id = 'u1'").run();
    await rejected(store.listHistory('u1', 'run', 'current'), 'MEMBER_DISABLED');
    await rejected(store.readHistory('u1', 'run', 'current', 1), 'MEMBER_DISABLED');
    await rejected(store.getUsage('u1'), 'MEMBER_DISABLED');
    await rejected(put(store, 0), 'MEMBER_DISABLED');
  } finally { sqlite.close(); }
});

test('database rejects disable-after-auth writes and store suppresses history/usage from a revoked read', async () => {
  for (const operation of ['write', 'history', 'version', 'usage', 'legacy-replay']) {
    const { sqlite, db } = sqliteD1({ through: operation === 'legacy-replay' ? '0001_workspace.sql' : undefined });
    try {
      seed(sqlite, 'u1', 'one@example.test');
      if (operation === 'legacy-replay') {
        sqlite.prepare(`INSERT INTO document_mutations
          (owner_id, kind, document_id, mutation_id, operation, expected_revision, value_json)
          VALUES ('u1', 'run', 'current', 'save-0', 'put', 0, '{"revision":0}')`).run();
        applyMigrations(sqlite, { after: '0001_workspace.sql' });
      } else {
        await put(createStore(db), 0);
      }
      const triggerQuery = operation === 'write' ? /INSERT INTO document_receipts/
        : operation === 'legacy-replay' ? /FROM document_mutations/
          : operation === 'usage' ? /AS history_bytes/ : /FROM document_history/;
      let revoked = false;
      const guarded = { prepare(sql) {
        if (!revoked && triggerQuery.test(sql)) {
          revoked = true;
          sqlite.prepare("UPDATE members SET status = 'disabled' WHERE id = 'u1'").run();
        }
        return db.prepare(sql);
      } };
      const store = createStore(guarded);
      const action = operation === 'write' ? put(store, 1)
        : operation === 'legacy-replay' ? put(store, 0)
          : operation === 'usage' ? store.getUsage('u1')
            : operation === 'version' ? store.readHistory('u1', 'run', 'current', 1)
              : store.listHistory('u1', 'run', 'current');
      await rejected(action, 'MEMBER_DISABLED');
      assert.equal(sqlite.prepare('SELECT revision FROM documents').get().revision, 1);
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM document_history').get().n, 1);
    } finally { sqlite.close(); }
  }
});
