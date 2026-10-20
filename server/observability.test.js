import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestObservability, routeCategory } from './observability.js';
import { createApi } from './api.js';
import { createAiService } from './ai-service.js';
import { seed, sqliteD1 } from './test-support/sqlite-d1.js';

const origin = 'https://workspace.local.test';
const request = path => new Request(`${origin}${path}`);

test('disabled observation has no headers, logs, or D1 wrapper', () => {
  assert.equal(createRequestObservability({}, request('/api/me')), null);
  assert.equal(createRequestObservability({ PERF_OBSERVABILITY: 'TRUE' }, request('/api/me')), null);
});

test('fixed route labels never retain caller paths or identifiers', () => {
  assert.equal(routeCategory('/api/ai/requests/secret-request-01'), 'ai_request');
  assert.equal(routeCategory('/api/ai/requests/secret-request-01/cancel'), 'ai_cancel');
  assert.equal(routeCategory('/api/documents/run/secret-document-01'), 'documents');
  assert.equal(routeCategory('/other/secret-document-01'), 'other');
});

test('D1 wrapper preserves receiver, binding, batch, metadata and original errors', async () => {
  const records = [];
  let time = 0;
  class Statement {
    #value;
    constructor(value) { this.#value = value; }
    bind(value) { return new Statement(value); }
    async first() { return { value: this.#value }; }
    async run() { return { meta: { rows_read: 2, rows_written: 1 } }; }
    async raw() { throw failure; }
  }
  class Database {
    #brand = true;
    prepare() { assert.equal(this.#brand, true); return new Statement(null); }
    async batch(statements) {
      assert.equal(this.#brand, true);
      assert.ok(statements.every(statement => statement instanceof Statement));
      return [{ meta: { rows_read: 3, rows_written: 0 } }, { meta: { rows_read: 4, rows_written: 2 } }];
    }
    async exec() { assert.equal(this.#brand, true); return { meta: { rows_written: 1 } }; }
  }
  const failure = new Error('private SQL and payload');
  const obs = createRequestObservability({ PERF_OBSERVABILITY: 'true' }, request('/api/documents/run/private-id'), {
    clock: () => ++time, traceId: () => '12345678-1234-4123-8123-123456789abc', log: row => records.push(row),
  });
  const db = obs.wrapDb(new Database());
  assert.deepEqual(await db.prepare('private SQL').bind('private value').first(), { value: 'private value' });
  await db.prepare('private SQL').bind('private value').run();
  await db.batch([db.prepare('private SQL').bind(1), db.prepare('private SQL').bind(2)]);
  await db.exec('private SQL');
  await assert.rejects(db.prepare('private SQL').bind('private value').raw(), error => error === failure);
  const response = obs.finish(new Response('{}', { status: 200 }));
  assert.equal(response.headers.get('x-trace-id'), '12345678-1234-4123-8123-123456789abc');
  assert.match(response.headers.get('server-timing'), /^app;dur=\d+, d1;dur=\d+$/);
  assert.equal(records.length, 1);
  assert.equal(records[0].d1Executions, 6);
  assert.equal(records[0].d1KnownRowsRead, 9);
  assert.equal(records[0].d1KnownRowsWritten, 4);
  assert.equal(records[0].d1RowsReadMetaCount, 3);
  assert.equal(records[0].d1RowsWrittenMetaCount, 4);
  assert.equal(records[0].route, 'documents');
  assert.equal(JSON.stringify(records[0]).includes('private'), false);
  assert.equal(JSON.stringify(records[0]).includes('secret'), false);
});

test('API emits only allowlisted performance fields and leaves normal responses unchanged', async () => {
  const { sqlite, db } = sqliteD1();
  const records = [];
  seed(sqlite, 'secret-user-id', 'private@example.test');
  sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
    .run('secret-user-id', 'private-user', 'test-salt', 'test-hash', 100000);
  const authenticate = async () => ({ memberId: 'secret-user-id' });
  const observabilityFactory = (env, req) => createRequestObservability(env, req, { log: row => records.push(row) });
  const api = createApi({ authenticate, observabilityFactory });
  const req = request('/api/documents/run/private-document-id');
  req.headers.set('X-Workspace-User', 'secret-user-id');
  try {
    const off = await api(req, { APP_ORIGIN: origin, DB: db });
    assert.equal(off.status, 404);
    assert.equal(off.headers.get('server-timing'), null);
    assert.equal(records.length, 0);
    const on = await api(req, { APP_ORIGIN: origin, DB: db, PERF_OBSERVABILITY: 'true' });
    assert.equal(on.status, off.status);
    assert.deepEqual(await on.json(), await off.json());
    assert.equal(records.length, 1);
    assert.equal(records[0].route, 'documents');
    assert.ok(records[0].d1Executions >= 1);
    assert.equal(records[0].d1KnownRowsRead, null);
    assert.equal(records[0].d1RowsReadMetaCount, 0);
    const serialized = JSON.stringify(records[0]);
    for (const forbidden of ['secret-user-id', 'private-document-id', 'private@example.test', 'SELECT ', 'WHERE ']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally { sqlite.close(); }
});

test('clock and logger failures cannot stop D1 calls or replace a D1 exception', async () => {
  const originalFailure = new Error('private database failure');
  const db = { prepare() { return { bind() { return this; },
    async first() { throw originalFailure; }, async run() { return { meta: { rows_read: 5 } }; } }; } };
  const obs = createRequestObservability({ PERF_OBSERVABILITY: 'true' }, request('/api/me'), {
    clock: () => { throw new Error('clock failed'); },
    log: () => { throw new Error('logger failed'); },
    traceId: () => { throw new Error('trace failed'); },
  });
  await obs.wrapDb(db).prepare('private SQL').bind('private value').run();
  await assert.rejects(obs.wrapDb(db).prepare('private SQL').bind('private value').first(),
    error => error === originalFailure);
  const result = new Response('{}', { status: 503 });
  assert.equal(obs.finish(result), result);
  assert.equal(result.headers.get('server-timing'), null);
  assert.equal(result.headers.get('x-trace-id'), null);
  assert.equal(obs.finish(Response.redirect(`${origin}/app/`)).status, 302);
});

test('factory, DB wrapper, and finish failures leave the original API response intact', async () => {
  const { sqlite, db } = sqliteD1();
  seed(sqlite, 'u1', 'private@example.test');
  sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
    .run('u1', 'private-user', 'test-salt', 'test-hash', 100000);
  const env = { APP_ORIGIN: origin, DB: db };
  const req = request('/api/me');
  const authenticate = async () => ({ memberId: 'u1' });
  const factories = [
    () => { throw new Error('factory failed'); },
    () => ({ wrapDb() { throw new Error('wrapper failed'); } }),
    () => ({ wrapDb: value => value, finish() { throw new Error('finish failed'); } }),
  ];
  try {
    for (const observabilityFactory of factories) {
      const api = createApi({ authenticate, observabilityFactory });
      const result = await api(req, env);
      assert.equal(result.status, 200);
      assert.equal((await result.json()).user.id, 'u1');
    }
  } finally { sqlite.close(); }
});

test('AI request GET and cancel record allowed result states without generation timing', async () => {
  const { sqlite, db } = sqliteD1();
  const records = [];
  seed(sqlite, 'u1', 'private@example.test');
  sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
    .run('u1', 'private-user', 'test-salt', 'test-hash', 100000);
  const ai = { async getRequest() { return { status: 'processing' }; },
    async cancel() { return { status: 'cancelled' }; } };
  const api = createApi({ authenticate: async () => ({ memberId: 'u1' }), ai,
    observabilityFactory: (env, req) => createRequestObservability(env, req, { log: row => records.push(row) }) });
  const env = { APP_ORIGIN: origin, DB: db, PERF_OBSERVABILITY: 'true' };
  try {
    const get = await api(new Request(`${origin}/api/ai/requests/private-01`,
      { headers: { 'X-Workspace-User': 'u1' } }), env);
    const cancel = await api(new Request(`${origin}/api/ai/requests/private-01/cancel`,
      { method: 'POST', headers: { Origin: origin, 'X-Workspace-User': 'u1' } }), env);
    assert.equal(get.status, 200);
    assert.equal(cancel.status, 200);
    assert.deepEqual(records.map(row => [row.route, row.aiResult, row.aiGenerationMs]),
      [['ai_request', 'processing', null], ['ai_cancel', 'cancelled', null]]);
    assert.equal(JSON.stringify(records).includes('private-01'), false);
  } finally { sqlite.close(); }
});

test('AI generation is measured once; idempotent replay does not become generation', async () => {
  const { sqlite, db } = sqliteD1();
  seed(sqlite, 'u1', 'private@example.test');
  const env = { AI_ACCOUNT_CONFIG_JSON: JSON.stringify({ u1: { mode: 'mock', provider: 'mock', timeoutMs: 1000 } }) };
  const service = createAiService({ invoke: async () => ({ text: 'private answer', simulated: true,
    usage: { inputTokens: 0, outputTokens: 0 } }) });
  const generations = [];
  const observation = { recordAiGeneration: (status, elapsed) => generations.push({ status, elapsed }) };
  const body = { requestId: 'observe-ai-01', prompt: 'private question' };
  try {
    assert.equal((await service.submit(db, env, 'u1', body, observation)).value.status, 'completed');
    assert.equal((await service.submit(db, env, 'u1', body, observation)).value.status, 'completed');
    assert.equal(generations.length, 1);
    assert.equal(generations[0].status, 'completed');
    assert.ok(generations[0].elapsed >= 0);
  } finally { sqlite.close(); }
});

test('AI API records result and generation wall time without prompt or answer', async () => {
  const { sqlite, db } = sqliteD1();
  const records = [];
  seed(sqlite, 'u1', 'private@example.test');
  sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
    .run('u1', 'private-user', 'test-salt', 'test-hash', 100000);
  const ai = { async submit(_db, _env, _memberId, _body, observation) {
    observation?.recordAiGeneration('completed', 12.345);
    return { httpStatus: 200, value: { status: 'completed', text: 'private answer' } };
  } };
  const api = createApi({ authenticate: async () => ({ memberId: 'u1' }), ai,
    observabilityFactory: (env, req) => createRequestObservability(env, req, { log: row => records.push(row) }) });
  try {
    const response = await api(new Request(`${origin}/api/ai/requests`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Workspace-User': 'u1' },
      body: JSON.stringify({ requestId: 'private-request', prompt: 'private question' }) }),
    { APP_ORIGIN: origin, DB: db, PERF_OBSERVABILITY: 'true' });
    assert.equal(response.status, 200);
    assert.equal(records.length, 1);
    assert.equal(records[0].route, 'ai_probe');
    assert.equal(records[0].aiResult, 'completed');
    assert.equal(records[0].aiGenerationMs, 12.3);
    const serialized = JSON.stringify(records[0]);
    for (const forbidden of ['private', 'question', 'answer', 'request']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally { sqlite.close(); }
});
