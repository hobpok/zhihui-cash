import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore, StoreError } from './storage.js';
import { sqliteD1, seed } from './test-support/sqlite-d1.js';

async function code(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof StoreError, String(error));
    assert.equal(error.code, expected);
    return true;
  });
}

test('invitation binds once to trusted issuer and subject; disabled and unknown identities fail closed', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'One@Example.com');
    seed(sqlite, 'u2', 'two@example.com', 'disabled');
    const store = createStore(db);
    const member = await store.getMember('trusted-issuer', 'subject-1', 'ONE@example.com');
    assert.equal(member.id, 'u1');
    assert.equal(member.role, 'member');
    assert.equal((await store.getMember('trusted-issuer', 'subject-1', 'one@example.com')).id, 'u1');
    await code(store.getMember('trusted-issuer', 'subject-1', 'changed@example.com'), 'MEMBER_IDENTITY_CONFLICT');
    assert.equal(await store.getMember('trusted-issuer', 'uninvited', 'none@example.com'), null);
    await code(store.getMember('trusted-issuer', 'subject-2', 'one@example.com'), 'MEMBER_IDENTITY_CONFLICT');
    await code(store.getMember('trusted-issuer', 'subject-2', 'two@example.com'), 'MEMBER_DISABLED');
    sqlite.prepare("UPDATE members SET status = 'disabled' WHERE id = 'u1'").run();
    await code(store.getMember('trusted-issuer', 'subject-1', 'one@example.com'), 'MEMBER_DISABLED');
    await code(store.getMember('trusted-issuer', 'subject-3', 'one@example.com'), 'MEMBER_DISABLED');
  } finally { sqlite.close(); }
});

test('database enforces five active seats for insert and reactivation', () => {
  const { sqlite } = sqliteD1();
  try {
    for (let n = 1; n <= 5; n++) seed(sqlite, `u${n}`, `u${n}@example.com`);
    assert.throws(() => seed(sqlite, 'u6', 'u6@example.com'), /active_member_limit/);
    seed(sqlite, 'u6', 'u6@example.com', 'disabled');
    assert.throws(() => sqlite.prepare("UPDATE members SET status = 'active' WHERE id = 'u6'").run(), /active_member_limit/);
    sqlite.prepare("UPDATE members SET status = 'disabled' WHERE id = 'u5'").run();
    sqlite.prepare("UPDATE members SET status = 'active' WHERE id = 'u6'").run();
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM members WHERE status = 'active'").get().n, 5);
  } finally { sqlite.close(); }
});

test('documents isolate all three kinds and all five owners', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    const store = createStore(db);
    for (let n = 1; n <= 5; n++) seed(sqlite, `u${n}`, `u${n}@example.com`);
    for (let n = 1; n <= 5; n++) {
      for (const kind of ['settings', 'template', 'run']) {
        const saved = await store.putDocument(`u${n}`, kind, 'shared-id', {
          expectedRevision: 0, mutationId: `${kind}-${n}`, value: { owner: n, kind },
        });
        assert.equal(saved.revision, 1);
        assert.equal(saved.replayed, false);
      }
    }
    for (let n = 1; n <= 5; n++) {
      for (const kind of ['settings', 'template', 'run']) {
        assert.deepEqual((await store.readDocument(`u${n}`, kind, 'shared-id')).value, { kind, owner: n });
        const listed = await store.listDocuments(`u${n}`, kind);
        assert.equal(listed.length, 1);
        assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'kind', 'revision', 'updatedAt'].sort());
        assert.equal(listed[0].revision, 1);
      }
    }
    await code(store.readDocument('unknown', 'run', 'shared-id'), 'MEMBER_NOT_FOUND');
    await code(store.readDocument('u1', 'other', 'shared-id'), 'INVALID_INPUT');
  } finally { sqlite.close(); }
});

test('CAS rejects stale writes, and retries reuse the exact recorded outcome', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.com');
    const store = createStore(db);
    const first = await store.putDocument('u1', 'run', 'r1', {
      expectedRevision: 0, mutationId: 'm1', value: { b: 2, a: 1 },
    });
    assert.equal(first.revision, 1);
    const retry = await store.putDocument('u1', 'run', 'r1', {
      expectedRevision: 0, mutationId: 'm1', value: { a: 1, b: 2 },
    });
    assert.equal(retry.replayed, true);
    assert.equal(retry.revision, 1);
    await code(store.putDocument('u1', 'run', 'r1', {
      expectedRevision: 0, mutationId: 'm1', value: { a: 9, b: 2 },
    }), 'MUTATION_CONFLICT');
    await code(store.deleteDocument('u1', 'run', 'r1', {
      expectedRevision: 0, mutationId: 'm1',
    }), 'MUTATION_CONFLICT');
    await code(store.putDocument('u1', 'run', 'another-id', {
      expectedRevision: 0, mutationId: 'm1', value: { a: 1, b: 2 },
    }), 'MUTATION_CONFLICT');
    await code(store.putDocument('u1', 'run', 'r1', {
      expectedRevision: 0, mutationId: 'stale', value: { a: 3 },
    }), 'REVISION_CONFLICT');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM document_receipts WHERE mutation_id = 'stale'").get().n, 0);
    const next = await store.putDocument('u1', 'run', 'r1', {
      expectedRevision: 1, mutationId: 'm2', value: { a: 2 },
    });
    assert.equal(next.revision, 2);
    const lateRetry = await store.putDocument('u1', 'run', 'r1', {
      expectedRevision: 0, mutationId: 'm1', value: { a: 1, b: 2 },
    });
    assert.equal(lateRetry.revision, 1);
    assert.equal(lateRetry.replayed, true);
    assert.equal((await store.readDocument('u1', 'run', 'r1')).revision, 2);
  } finally { sqlite.close(); }
});

test('delete leaves a tombstone; old writes cannot recreate, current revision can', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.com');
    const store = createStore(db);
    await store.putDocument('u1', 'template', 't1', {
      expectedRevision: 0, mutationId: 'create', value: { name: 'first' },
    });
    const deleted = await store.deleteDocument('u1', 'template', 't1', {
      expectedRevision: 1, mutationId: 'delete',
    });
    assert.equal(deleted.revision, 2);
    assert.equal(deleted.deleted, true);
    assert.equal(await store.readDocument('u1', 'template', 't1'), null);
    assert.deepEqual(await store.listDocuments('u1', 'template'), []);
    assert.equal((await store.deleteDocument('u1', 'template', 't1', {
      expectedRevision: 1, mutationId: 'delete',
    })).replayed, true);
    await code(store.putDocument('u1', 'template', 't1', {
      expectedRevision: 0, mutationId: 'stale-create', value: { name: 'bad' },
    }), 'REVISION_CONFLICT');
    await code(store.putDocument('u1', 'template', 't1', {
      expectedRevision: 1, mutationId: 'stale-edit', value: { name: 'bad' },
    }), 'REVISION_CONFLICT');
    assert.equal((await store.putDocument('u1', 'template', 't1', {
      expectedRevision: 2, mutationId: 'restore', value: { name: 'restored' },
    })).revision, 3);
  } finally { sqlite.close(); }
});

test('simultaneous saves with the same expected revision have one winner', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.com');
    const store = createStore(db);
    const results = await Promise.allSettled([
      store.putDocument('u1', 'settings', 'profile', { expectedRevision: 0, mutationId: 'm-a', value: { n: 1 } }),
      store.putDocument('u1', 'settings', 'profile', { expectedRevision: 0, mutationId: 'm-b', value: { n: 2 } }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'REVISION_CONFLICT').length, 1);
    assert.equal((await store.readDocument('u1', 'settings', 'profile')).revision, 1);
    sqlite.prepare("UPDATE members SET status = 'disabled' WHERE id = 'u1'").run();
    await code(store.readDocument('u1', 'settings', 'profile'), 'MEMBER_DISABLED');
    await code(store.putDocument('u1', 'settings', 'profile', {
      expectedRevision: 1, mutationId: 'after-disable', value: { n: 3 },
    }), 'MEMBER_DISABLED');
  } finally { sqlite.close(); }
});

test('100-document quota counts tombstones without silently removing data', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.com');
    const store = createStore(db);
    for (let n = 0; n < 100; n++) {
      await store.putDocument('u1', 'template', `t-${n}`, {
        expectedRevision: 0, mutationId: `create-${n}`, value: { n },
      });
    }
    await code(store.putDocument('u1', 'template', 't-100', {
      expectedRevision: 0, mutationId: 'over-doc-quota', value: { n: 100 },
    }), 'STORAGE_QUOTA_EXCEEDED');
    const deleted = await store.deleteDocument('u1', 'template', 't-0', {
      expectedRevision: 1, mutationId: 'delete-0',
    });
    assert.equal(deleted.revision, 2);
    assert.equal((await store.listDocuments('u1', 'template')).length, 99);
    await code(store.putDocument('u1', 'template', 't-100', {
      expectedRevision: 0, mutationId: 'still-over-doc-quota', value: { n: 100 },
    }), 'STORAGE_QUOTA_EXCEEDED');
    const retry = await store.putDocument('u1', 'template', 't-0', {
      expectedRevision: 0, mutationId: 'create-0', value: { n: 0 },
    });
    assert.equal(retry.replayed, true);
    assert.equal(retry.revision, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?').get('u1').n, 100);
  } finally { sqlite.close(); }
});

test('1000-mutation quota rejects the next new command but permits exact retries', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.com');
    const store = createStore(db);
    for (let n = 0; n < 1000; n++) {
      await store.putDocument('u1', 'settings', 'profile', {
        expectedRevision: n, mutationId: `m-${n}`, value: { n },
      });
    }
    await code(store.putDocument('u1', 'settings', 'profile', {
      expectedRevision: 1000, mutationId: 'over-mutations', value: { n: 1000 },
    }), 'STORAGE_QUOTA_EXCEEDED');
    assert.equal((await store.putDocument('u1', 'settings', 'profile', {
      expectedRevision: 0, mutationId: 'm-0', value: { n: 0 },
    })).replayed, true);
    assert.equal((await store.readDocument('u1', 'settings', 'profile')).revision, 1000);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM document_receipts WHERE owner_id = ?').get('u1').n, 1000);
  } finally { sqlite.close(); }
});

test('16 MiB retained history quota counts UTF-8 bytes', async () => {
  const { sqlite, db } = sqliteD1();
  try {
    seed(sqlite, 'u1', 'one@example.com');
    const store = createStore(db);
    const value = '界'.repeat(700_000); // 2.1 million UTF-8 bytes, below the per-document character limit.
    for (let n = 0; n < 7; n++) {
      await store.putDocument('u1', 'run', `r-${n}`, {
        expectedRevision: 0, mutationId: `large-${n}`, value,
      });
    }
    await code(store.putDocument('u1', 'run', 'r-7', {
      expectedRevision: 0, mutationId: 'large-7', value,
    }), 'STORAGE_QUOTA_EXCEEDED');
    const bytes = sqlite.prepare(`
      SELECT SUM(length(CAST(value_json AS BLOB))) AS bytes
      FROM document_history WHERE owner_id = ?
    `).get('u1').bytes;
    assert.ok(bytes < 16 * 1024 * 1024);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM document_receipts WHERE owner_id = ?').get('u1').n, 7);
    assert.equal((await store.putDocument('u1', 'run', 'r-0', {
      expectedRevision: 0, mutationId: 'large-0', value,
    })).replayed, true);
  } finally { sqlite.close(); }
});
