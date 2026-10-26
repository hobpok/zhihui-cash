import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, validateSaved } from './model.js';
import { createLegacySyntheticInitialTemplate } from './initial-data.js';
import { createWorkspaceSync } from './workspace-sync.js';
import { createApi } from '../server/api.js';
import { sqliteD1, seed } from '../server/test-support/sqlite-d1.js';
import { APP_RELEASE } from './release-version.js';

function acceptedBond() {
  const template = createLegacySyntheticInitialTemplate();
  const bond = template.draftPlans.find(p => p.businessType === 'bond_buy');
  template.draftPlans = [{ ...bond, targetYuan: 17000000, settlementDate: template.businessDate }];
  const model = createModel(); model.startFromTemplate(template);
  model.generateProposal(); model.approveProposal();
  const id = model.sendBatch().results[0].instructionId;
  return { model, id, saved: JSON.parse(model.serialize()) };
}
const fill = (model, id, amount) => model.simulateEvent('fill', { instructionId: id, nominalYuan: amount });

test('same-run load accepts appended execution even after more independent local revisions', () => {
  const { saved, id } = acceptedBond();
  const local = createModel(saved), remote = createModel(saved);
  for (let i = 0; i < 3; i++) local.markSnapshotStale();
  fill(remote, id, 6000000);
  assert.ok(local.getState().revision > remote.getState().revision);
  local.load(remote.serialize());
  assert.equal(local.getState().execution.instructions[id].filledYuan, 6000000);
  assert.equal(local.getState().execution.requiresReapproval, true);
  assert.equal(local.getState().execution.requiresRefresh, true);
});

test('same-run load rejects shorter and divergent execution journals without changing current facts', () => {
  const { saved, id } = acceptedBond();
  const local = createModel(saved), fork = createModel(saved);
  fill(local, id, 6000000); fill(fork, id, 4000000);
  const before = local.serialize();
  for (const incoming of [saved, JSON.parse(fork.serialize())]) {
    incoming.revision += 100;
    assert.equal(validateSaved(incoming).ok, true);
    assert.throws(() => local.load(incoming), /执行事实/);
    assert.equal(local.serialize(), before);
  }
});

test('same-run load keeps queued receipt facts when the incoming archive resolves their gap', () => {
  const { model, id } = acceptedBond();
  const sequence = model.getState().execution.sourceSequence;
  model.recordEvent({ eventId: 'QUEUED-FILL', sourceSequence: sequence + 2,
    type: 'fill', instructionId: id, fillId: 'QUEUED-FILL-ID', nominalYuan: 4000000 });
  const remote = createModel(model.serialize());
  remote.recordEvent({ eventId: 'MISSING-FILL', sourceSequence: sequence + 1,
    type: 'fill', instructionId: id, fillId: 'MISSING-FILL-ID', nominalYuan: 6000000 });
  model.load(remote.serialize());
  assert.equal(model.getState().execution.instructions[id].filledYuan, 10000000);
  assert.deepEqual(model.getState().execution.pending, {});
});

test('same-run load cannot erase or rewrite a pending receipt through an otherwise valid archive', () => {
  const { model, id } = acceptedBond();
  model.recordEvent({ eventId: 'PENDING-FACT', sourceSequence: model.getState().execution.sourceSequence + 2,
    type: 'fill', instructionId: id, fillId: 'PENDING-TRADE', nominalYuan: 4000000 });
  const before = model.serialize();
  for (const erase of [true, false]) {
    const incoming = JSON.parse(before), sequence = Object.keys(incoming.execution.pending)[0];
    if (erase) { incoming.execution.pending = {}; delete incoming.execution.seen['PENDING-FACT']; }
    else { incoming.execution.pending[sequence].nominalYuan = 5000000;
      incoming.execution.seen['PENDING-FACT'].nominalYuan = 5000000; }
    assert.equal(validateSaved(incoming).ok, true);
    assert.throws(() => model.load(incoming), /执行事实/);
    assert.equal(model.serialize(), before);
  }
});

test('same-run load cannot rewind execution ID counters despite a valid replayable journal', () => {
  const { model } = acceptedBond(), before = model.serialize();
  for (const key of ['nextInstruction', 'nextLocalEvent']) {
    const incoming = JSON.parse(before); incoming.execution[key] = 1;
    assert.equal(validateSaved(incoming).ok, true);
    assert.throws(() => model.load(incoming), /执行事实/);
    assert.equal(model.serialize(), before);
  }
});

function memoryStorage() {
  const map = new Map();
  return { get length() { return map.size; }, key: i => [...map.keys()][i],
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k),
    contents: () => [...map.entries()] };
}
const error = (status, code) => Object.assign(new Error(code), { status, code });
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const storage = memoryStorage(), docs = new Map(), writes = [];
  let offline = false, holdRead = null;
  const api = async (path, options) => {
    if (options.method === 'GET' && holdRead) { const hold = holdRead; holdRead = null; await hold.promise; }
    if (offline) throw new TypeError('offline');
    const owner = options.headers['X-Workspace-User'];
    const [, , , kind, id, history] = path.split('/'), key = `${owner}/${kind}/${id}`;
    if (history) return { history: [] };
    if (options.method === 'GET') {
      if (!docs.has(key)) throw error(404, 'NOT_FOUND');
      return { document: structuredClone(docs.get(key)) };
    }
    writes.push(structuredClone(options.body));
    if ((docs.get(key)?.revision ?? 0) !== options.body.expectedRevision) throw error(409, 'REVISION_CONFLICT');
    const document = { kind, id, revision: options.body.expectedRevision + 1, value: structuredClone(options.body.value) };
    docs.set(key, document); return { document };
  };
  const sync = createWorkspaceSync({ api, storage, debounceMs: 60000 });
  const remote = (revision, value = { displayName: `remote-${revision}` }) => docs.set('one/settings/profile',
    { kind: 'settings', id: 'profile', revision, value: structuredClone(value) });
  return { sync, storage, docs, writes, remote, offline: value => { offline = value; },
    holdRead: () => { holdRead = gate(); return holdRead; } };
}
const row = f => f.sync.snapshot().documents[0];
async function conflict(f) {
  f.sync.connect('one'); await f.sync.open('settings', 'profile');
  f.remote(1); f.sync.stage('settings', 'profile', { displayName: 'mine' }); await f.sync.flush();
  assert.equal(row(f).status, 'conflict');
}

test('resolution applies before accepting the cloud baseline or removing local backups', async () => {
  const f = fixture();
  try {
    await conflict(f); const backups = f.storage.contents(); let calls = 0;
    const selected = await f.sync.resolve('settings', 'profile', 'remote', { apply(value) {
      calls++; assert.equal(value.displayName, 'remote-1'); assert.equal(row(f).revision, 0);
      assert.equal(row(f).status, 'conflict'); assert.deepEqual(f.storage.contents(), backups);
      assert.throws(() => f.sync.stage('settings', 'profile', { displayName: 'race' }), /RESOLVE/);
    } });
    assert.equal(calls, 1); assert.equal(selected.revision, 1); assert.equal(selected.status, 'ready');
    assert.equal(f.storage.length, 0);
  } finally { f.sync.disconnect(); }
});

test('failed model application preserves conflict baseline, backups and blocks later save', async () => {
  const f = fixture();
  try {
    await conflict(f); const before = row(f), backups = f.storage.contents(), writes = f.writes.length;
    const selected = await f.sync.resolve('settings', 'profile', 'remote', { apply() { throw new Error('MODEL_REJECTED'); } });
    assert.equal(selected.status, 'conflict'); assert.equal(selected.error, 'MODEL_REJECTED');
    assert.equal(selected.revision, before.revision); assert.deepEqual(selected.value, before.value);
    assert.deepEqual(selected.remote, before.remote); assert.deepEqual(f.storage.contents(), backups);
    assert.throws(() => f.sync.stage('settings', 'profile', { displayName: 'stale-model' }), /RESOLVE/);
    await f.sync.flush(); assert.equal(f.writes.length, writes);
    const retried = await f.sync.resolve('settings', 'profile', 'remote', { apply() {} });
    assert.equal(retried.status, 'ready');
  } finally { f.sync.disconnect(); }
});

test('failed resolution read keeps the reviewed conflict blocked without consuming recovery data', async () => {
  const f = fixture();
  try {
    await conflict(f); const backups = f.storage.contents(), writes = f.writes.length; f.offline(true);
    const selected = await f.sync.resolve('settings', 'profile', 'remote', { apply() { assert.fail('must not apply'); } });
    assert.equal(selected.status, 'conflict'); assert.equal(selected.revision, 0);
    assert.deepEqual(f.storage.contents(), backups); await f.sync.flush(); assert.equal(f.writes.length, writes);
  } finally { f.sync.disconnect(); }
});

test('failed recovery application keeps the selected recovery and all other backups', async () => {
  const f = fixture();
  try {
    f.sync.connect('one'); await f.sync.open('settings', 'profile'); f.offline(true);
    f.sync.stage('settings', 'profile', { displayName: 'offline-recovery' }); await f.sync.flush();
    f.sync.disconnect(); f.offline(false); f.remote(1); f.sync.connect('one'); await f.sync.open('settings', 'profile');
    assert.equal(row(f).status, 'recovery'); const before = row(f), backups = f.storage.contents();
    await f.sync.resolve('settings', 'profile', 'recovery', { apply() { throw new Error('RECOVERY_REJECTED'); } });
    assert.equal(row(f).status, 'recovery'); assert.deepEqual(row(f).recovery, before.recovery);
    assert.deepEqual(row(f).recoveries, before.recoveries); assert.deepEqual(f.storage.contents(), backups);
  } finally { f.sync.disconnect(); }
});

test('even choosing remote requires reviewing again when cloud changed after export', async () => {
  const f = fixture();
  try {
    await conflict(f); const backups = f.storage.contents(); f.remote(2); let calls = 0;
    const changed = await f.sync.resolve('settings', 'profile', 'remote', { apply() { calls++; } });
    assert.equal(changed.status, 'conflict'); assert.equal(changed.error, 'REMOTE_CHANGED_AGAIN');
    assert.equal(changed.revision, 0); assert.equal(changed.remote.revision, 2);
    assert.equal(changed.value.displayName, 'mine'); assert.equal(calls, 0); assert.deepEqual(f.storage.contents(), backups);
    f.remote(3);
    await f.sync.resolve('settings', 'profile', 'remote', { apply() { calls++; } });
    assert.equal(row(f).status, 'conflict'); assert.equal(row(f).remote.revision, 3); assert.equal(calls, 0);
    await f.sync.resolve('settings', 'profile', 'remote', { apply() { calls++; } });
    assert.equal(row(f).status, 'ready'); assert.equal(row(f).revision, 3); assert.equal(calls, 1);
  } finally { f.sync.disconnect(); }
});

test('account switch while resolving ignores late read without applying or deleting former backups', async () => {
  const f = fixture();
  try {
    await conflict(f); const backups = f.storage.contents(), hold = f.holdRead(); let calls = 0;
    const resolving = f.sync.resolve('settings', 'profile', 'remote', { apply() { calls++; } });
    f.sync.connect('two'); await f.sync.open('settings', 'profile'); hold.resolve();
    assert.equal(await resolving, null); assert.equal(calls, 0); assert.equal(f.sync.snapshot().userId, 'two');
    assert.equal(row(f).value, null); assert.deepEqual(f.storage.contents(), backups);
  } finally { f.sync.disconnect(); }
});

test('a second concurrent resolution and edits cannot enter the resolution transaction', async () => {
  const f = fixture();
  try {
    await conflict(f); const hold = f.holdRead(); let calls = 0;
    const resolving = f.sync.resolve('settings', 'profile', 'remote', { apply() { calls++; } });
    await assert.rejects(f.sync.resolve('settings', 'profile', 'remote'), /INVALID_RESOLUTION/);
    assert.throws(() => f.sync.stage('settings', 'profile', { displayName: 'race' }), /RESOLVE/);
    await f.sync.flush(); hold.resolve(); await resolving; assert.equal(calls, 1); assert.equal(row(f).status, 'ready');
  } finally { f.sync.disconnect(); }
});

test('resolution refuses async callbacks and returned thenables without advancing the baseline', async () => {
  const f = fixture();
  try {
    await conflict(f); const backups = f.storage.contents(); let calls = 0;
    await assert.rejects(f.sync.resolve('settings', 'profile', 'remote', { async apply() { calls++; } }), /INVALID_RESOLUTION_CALLBACK/);
    assert.equal(calls, 0);
    const result = await f.sync.resolve('settings', 'profile', 'remote', { apply() { return Promise.resolve(); } });
    assert.equal(result.status, 'conflict'); assert.equal(result.error, 'INVALID_RESOLUTION_CALLBACK');
    assert.equal(result.revision, 0); assert.deepEqual(f.storage.contents(), backups);
  } finally { f.sync.disconnect(); }
});

async function cloudFixture() {
  const { model, id, saved } = acceptedBond();
  const { sqlite, db } = sqliteD1(); seed(sqlite, 'audit-owner', 'owner@audit.example');
  const handle = createApi({ authenticate: async () => ({ issuer: 'audit-issuer', subject: 'audit-subject', email: 'owner@audit.example' }),
    observabilityFactory: () => null });
  let mutation = 0;
  const api = async (path, options = {}) => {
    const response = await handle(new Request(`https://audit.example${path}`, {
      method: options.method ?? 'GET', headers: { Origin: 'https://audit.example', 'Content-Type': 'application/json',
        'X-App-Release': APP_RELEASE, 'X-Workspace-User': 'audit-owner' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }), { APP_ORIGIN: 'https://audit.example', DB: db });
    const value = await response.json();
    if (!response.ok) throw error(response.status, value.error);
    return value;
  };
  const put = (value, expectedRevision) => api('/api/documents/run/current', { method: 'PUT',
    body: { value, expectedRevision, mutationId: `cloud-integration-${++mutation}` } });
  await put(saved, 0);
  const local = createModel(saved), sync = createWorkspaceSync({ api, storage: memoryStorage(), debounceMs: 60000 });
  sync.connect('audit-owner'); await sync.open('run', 'current');
  return { sqlite, sync, local, model, id, saved, put, api };
}

test('real API conflict resolution keeps remote appended fills through the next ordinary save', async () => {
  const f = await cloudFixture();
  try {
    fill(f.model, f.id, 6000000); await f.put(JSON.parse(f.model.serialize()), 1);
    for (let i = 0; i < 3; i++) f.local.markSnapshotStale();
    f.sync.stage('run', 'current', JSON.parse(f.local.serialize())); await f.sync.flush();
    assert.equal(f.sync.snapshot().documents[0].status, 'conflict');
    const selected = await f.sync.resolve('run', 'current', 'remote', { apply: value => f.local.load(value) });
    assert.equal(selected.status, 'ready');
    f.sync.stage('run', 'current', JSON.parse(f.local.serialize())); await f.sync.flush();
    const current = (await f.api('/api/documents/run/current')).document;
    assert.equal(current.value.execution.instructions[f.id].filledYuan, 6000000);
    assert.deepEqual(current.value.execution.journal, f.model.getState().execution.journal);
  } finally { f.sync.disconnect(); f.sqlite.close(); }
});

test('real API rejects divergent model application without permitting any subsequent stale cloud write', async () => {
  const f = await cloudFixture();
  try {
    fill(f.local, f.id, 4000000); fill(f.model, f.id, 6000000);
    await f.put(JSON.parse(f.model.serialize()), 1);
    f.sync.stage('run', 'current', JSON.parse(f.local.serialize())); await f.sync.flush();
    const selected = await f.sync.resolve('run', 'current', 'remote', { apply: value => f.local.load(value) });
    assert.equal(selected.status, 'conflict'); assert.match(selected.error, /执行事实/); assert.equal(selected.revision, 1);
    assert.throws(() => f.sync.stage('run', 'current', JSON.parse(f.local.serialize())), /RESOLVE/);
    await f.sync.flush();
    const current = (await f.api('/api/documents/run/current')).document;
    assert.equal(current.revision, 2); assert.equal(current.value.execution.instructions[f.id].filledYuan, 6000000);
    assert.equal(f.local.getState().execution.instructions[f.id].filledYuan, 4000000);
  } finally { f.sync.disconnect(); f.sqlite.close(); }
});
