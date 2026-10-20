import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceSync } from './workspace-sync.js';

function memoryStorage() {
  const map = new Map(); return { get length() { return map.size; }, key: i => [...map.keys()][i],
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function fixture(storage = memoryStorage()) {
  const docs = new Map(), receipts = new Map(), calls = [];
  let offline = false, barrier = null, lostResponse = false, authChanged = false;
  const api = async (path, options) => {
    const user = options.headers['X-Workspace-User']; calls.push({ user, path, ...options });
    if (authChanged) throw fail(409, 'SESSION_CHANGED');
    if (offline) throw new TypeError('offline');
    const [, , , kind, id, history] = path.split('/'); const key = `${user}/${kind}/${id}`;
    if (history) return { history: docs.get(key)?.deleted ? [docs.get(key)] : [] };
    if (options.method === 'GET') {
      const d = docs.get(key); if (!d || d.deleted) throw fail(404, 'NOT_FOUND'); return { document: structuredClone(d) };
    }
    if (barrier) { const waiting = barrier; barrier = null; await waiting.promise; }
    const body = options.body, receiptKey = `${user}/${body.mutationId}`;
    if (receipts.has(receiptKey)) return { document: { ...receipts.get(receiptKey), replayed: true } };
    if ((docs.get(key)?.revision ?? 0) !== body.expectedRevision) throw fail(409, 'REVISION_CONFLICT');
    const d = { id, kind, revision: body.expectedRevision + 1, value: structuredClone(body.value) };
    docs.set(key, d); receipts.set(receiptKey, d);
    if (lostResponse) { lostResponse = false; throw new TypeError('response lost'); }
    return { document: structuredClone(d) };
  };
  const sync = createWorkspaceSync({ api, storage, debounceMs: 60000 });
  return { sync, api, storage, docs, calls, offline: v => offline = v, block: () => barrier = gate(),
    lose: () => lostResponse = true, changeAuth: () => authChanged = true };
}
async function start(f, user = 'one') { f.sync.connect(user); return f.sync.open('settings', 'profile'); }
const entry = f => f.sync.snapshot().documents[0];

test('empty account read never uploads anonymous values; writes carry server-bound user id', async () => {
  const f = fixture(); await start(f); assert.equal(entry(f).status, 'empty'); assert.equal(f.docs.size, 0);
  f.sync.stage('settings', 'profile', { displayName: '一' }); await f.sync.flush();
  assert.equal(entry(f).status, 'ready'); assert.equal(f.docs.get('one/settings/profile').value.displayName, '一');
  assert.ok(f.calls.every(c => c.headers['X-Workspace-User'] === 'one')); f.sync.disconnect();
});
test('editing during an in-flight save drains the latest value in sequence', async () => {
  const f = fixture(); await start(f); const hold = f.block();
  f.sync.stage('settings', 'profile', { displayName: 'first' }); const flush = f.sync.flush();
  f.sync.stage('settings', 'profile', { displayName: 'latest' }); hold.resolve(); await flush;
  assert.equal(entry(f).revision, 2); assert.equal(f.docs.get('one/settings/profile').value.displayName, 'latest'); f.sync.disconnect();
});
test('response loss retries the identical mutation, then verifies current remote revision', async () => {
  const f = fixture(); await start(f); f.lose();
  f.sync.stage('settings', 'profile', { displayName: 'lost' }); await f.sync.flush();
  assert.equal(entry(f).status, 'offline'); await f.sync.flush();
  const writes = f.calls.filter(c => c.method === 'PUT'); assert.equal(writes[0].body.mutationId, writes[1].body.mutationId);
  assert.equal(entry(f).revision, 1); assert.equal(entry(f).status, 'ready'); f.sync.disconnect();
});
test('offline draft survives refresh and needs explicit recovery choice', async () => {
  const f = fixture(); await start(f); f.offline(true);
  f.sync.stage('settings', 'profile', { displayName: '离线' }); await f.sync.flush(); f.sync.disconnect();
  f.offline(false); await start(f); assert.equal(entry(f).status, 'recovery'); assert.equal(f.docs.size, 0);
  await f.sync.resolve('settings', 'profile', 'recovery'); await f.sync.flush();
  assert.equal(f.docs.get('one/settings/profile').value.displayName, '离线'); f.sync.disconnect();
});
test('cross-device stale save preserves both sides; explicit local resolution uses fresh CAS', async () => {
  const f = fixture(); await start(f);
  f.docs.set('one/settings/profile', { kind: 'settings', id: 'profile', revision: 1, value: { displayName: 'remote' } });
  f.sync.stage('settings', 'profile', { displayName: 'local' }); await f.sync.flush();
  assert.equal(entry(f).status, 'conflict'); assert.equal(entry(f).remote.value.displayName, 'remote'); assert.equal(entry(f).value.displayName, 'local');
  await f.sync.resolve('settings', 'profile', 'local'); await f.sync.flush();
  assert.equal(entry(f).revision, 2); assert.equal(f.docs.get('one/settings/profile').value.displayName, 'local'); f.sync.disconnect();
});
test('remote resolution discards only the explicitly selected local pending data', async () => {
  const f = fixture(); await start(f); f.sync.stage('settings', 'profile', { displayName: 'local' });
  f.docs.set('one/settings/profile', { kind: 'settings', id: 'profile', revision: 1, value: { displayName: 'remote' } });
  await f.sync.flush(); await f.sync.resolve('settings', 'profile', 'remote');
  assert.equal(entry(f).status, 'ready'); assert.equal(entry(f).value.displayName, 'remote'); assert.equal(f.storage.length, 0); f.sync.disconnect();
});
test('account switch ignores late response and never exposes former account backup', async () => {
  const f = fixture(); await start(f); const hold = f.block(); f.sync.stage('settings', 'profile', { displayName: 'private-one' });
  const old = f.sync.flush(); await start(f, 'two'); hold.resolve(); await old;
  assert.equal(f.sync.snapshot().userId, 'two'); assert.equal(entry(f).status, 'empty'); assert.equal(entry(f).value, null);
  assert.equal(f.docs.has('two/settings/profile'), false); f.sync.disconnect();
});
test('changed cookie identity fails closed and retains pending backup for its owner', async () => {
  const f = fixture(); await start(f); f.sync.stage('settings', 'profile', { displayName: 'keep' }); f.changeAuth(); await f.sync.flush();
  assert.equal(f.sync.snapshot().userId, null); assert.equal(f.sync.snapshot().error, 'REAUTH_REQUIRED'); assert.equal(f.storage.length, 1);
});
test('failed initial read cannot be mistaken for a new empty account', async () => {
  const f = fixture(); f.offline(true); await start(f); assert.equal(entry(f).loaded, false);
  assert.throws(() => f.sync.stage('settings', 'profile', { displayName: 'bad' }), /RESOLVE/);
  await f.sync.flush(); assert.equal(f.docs.size, 0); f.sync.disconnect();
});
test('deleted remote document revision is used for explicit recreation', async () => {
  const f = fixture(); f.docs.set('one/settings/profile', { kind: 'settings', id: 'profile', revision: 4, deleted: true });
  await start(f); assert.equal(entry(f).revision, 4);
  f.sync.stage('settings', 'profile', { displayName: 'restored' }); await f.sync.flush(); assert.equal(entry(f).revision, 5); f.sync.disconnect();
});
test('two tabs keep independent local recovery copies', async () => {
  const f = fixture(), second = createWorkspaceSync({ api: f.api, storage: f.storage, debounceMs: 60000 });
  await start(f); second.connect('one'); await second.open('settings', 'profile');
  f.offline(true); f.sync.stage('settings', 'profile', { displayName: 'tab1' }); second.stage('settings', 'profile', { displayName: 'tab2' });
  await f.sync.flush(); await second.flush(); assert.equal(f.storage.length, 2);
  second.disconnect(); f.sync.disconnect(); f.offline(false); await start(f); assert.equal(entry(f).recoveries.length, 2); f.sync.disconnect();
});

test('a late replay receipt cannot roll back a newer remote revision', async () => {
  const f = fixture(); await start(f); f.lose(); f.sync.stage('settings', 'profile', { displayName: 'old' }); await f.sync.flush();
  f.docs.set('one/settings/profile', { id: 'profile', kind: 'settings', revision: 2, value: { displayName: 'new-device' } });
  await f.sync.flush(); assert.equal(entry(f).status, 'conflict'); assert.equal(entry(f).remote.revision, 2); f.sync.disconnect();
});
test('quota failure retains local content and never says saved', async () => {
  const storage = memoryStorage();
  const sync = createWorkspaceSync({ storage, debounceMs: 60000, api: async (path, o) => {
    if (o.method === 'PUT') throw fail(409, 'STORAGE_QUOTA_EXCEEDED');
    if (path.endsWith('/history')) return { history: [] };
    throw fail(404, 'NOT_FOUND');
  }});
  sync.connect('one'); await sync.open('settings', 'profile'); sync.stage('settings', 'profile', { displayName: 'preserved' }); await sync.flush();
  assert.equal(sync.snapshot().documents[0].status, 'error'); assert.equal(storage.length, 1); sync.disconnect();
});
test('local storage unavailable is surfaced without claiming local backup protection', async () => {
  const storage = { ...memoryStorage(), setItem: () => { throw new Error('quota'); } };
  const f = fixture(storage); await start(f); f.offline(true); f.sync.stage('settings', 'profile', { displayName: 'unsaved' }); await f.sync.flush();
  assert.equal(entry(f).localBackupError, true); assert.equal(entry(f).status, 'offline'); f.sync.disconnect();
});

test('remote changes after conflict review require a second explicit decision', async () => {
  const f = fixture(); await start(f);
  f.docs.set('one/settings/profile', { kind: 'settings', id: 'profile', revision: 1, value: { displayName: 'reviewed' } });
  f.sync.stage('settings', 'profile', { displayName: 'mine' }); await f.sync.flush();
  f.docs.set('one/settings/profile', { kind: 'settings', id: 'profile', revision: 2, value: { displayName: 'unseen' } });
  await f.sync.resolve('settings', 'profile', 'local'); assert.equal(entry(f).status, 'conflict');
  assert.equal(entry(f).remote.revision, 2); assert.equal(f.docs.get('one/settings/profile').value.displayName, 'unseen');
  await f.sync.resolve('settings', 'profile', 'local'); await f.sync.flush(); assert.equal(entry(f).revision, 3); f.sync.disconnect();
});
