import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './api.js';
import { createAiService } from './ai-service.js';
import { applyMigrations, seed, sqliteD1 } from './test-support/sqlite-d1.js';

const origin = 'https://workspace.local.test';
const config = (limit = 30, timeoutMs = 1000) => JSON.stringify(Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [`u${i + 1}`, { mode: 'mock', provider: 'mock', dailyLimit: limit, timeoutMs }])));
function setup({ invoke, limit = 30, timeoutMs = 1000, pollIntervalMs = 10, now } = {}) {
  const { sqlite, db } = sqliteD1();
  for (let i = 1; i <= 5; i++) {
    seed(sqlite, `u${i}`, `user${i}@example.test`);
    sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
      .run(`u${i}`, `user${i}`, 'test-salt', 'test-hash', 100000);
  }
  const env = { APP_ORIGIN: origin, DB: db, AI_ACCOUNT_CONFIG_JSON: config(limit, timeoutMs) };
  const authenticate = async request => ({ memberId: request.headers.get('x-test-member') });
  const ai = createAiService({ invoke, pollIntervalMs, ...(now ? { now } : {}) });
  const api = createApi({ authenticate, ai });
  async function call(user, path, method = 'GET', body, instance = api, headerUser = user) {
    const res = await instance(new Request(`${origin}${path}`, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Test-Member': user, 'X-Workspace-User': headerUser },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: res.status, body: await res.json() };
  }
  return { sqlite, db, env, api, ai, authenticate, call };
}
const body = (id, prompt = '连接测试') => ({ requestId: id, prompt });
const output = text => ({ text, usage: { inputTokens: 0, outputTokens: 0 }, simulated: true });
const realOutput = (text, inputTokens, outputTokens) => ({ text, usage: { inputTokens, outputTokens }, simulated: false });
function enableReal(ctx) {
  ctx.env.AI_ACCOUNT_CONFIG_JSON = JSON.stringify({ u1: { mode: 'real', provider: 'deepseek',
    model: 'deepseek-flash', keyBinding: 'AI_KEY_TEST', dailyLimit: 30, timeoutMs: 1000 } });
  ctx.env.AI_KEY_TEST = 'synthetic-test-placeholder';
}
const submit = (ctx, user, id, prompt, api) => ctx.call(user, '/api/ai/requests', 'POST', body(id, prompt), api);
function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

test('mock calls succeed for five isolated accounts; status and GET never expose prompts', async () => {
  const ctx = setup({ invoke: async ({ prompt }) => output(`reply:${prompt}`) });
  try {
    for (let i = 1; i <= 5; i++) {
      const user = `u${i}`;
      const result = await submit(ctx, user, `request-${i}`, `private prompt ${i}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.status, 'completed');
      assert.equal(result.body.text, `reply:private prompt ${i}`);
      const status = await ctx.call(user, '/api/ai/status');
      assert.equal(status.body.status, 'mock_ready');
      assert.equal(status.body.usage.used, 1);
      assert.equal(status.body.activeRequestId, null);
      const own = await ctx.call(user, `/api/ai/requests/request-${i}`);
      assert.equal(own.body.status, 'completed');
      assert.equal(JSON.stringify(own.body).includes('private prompt'), false);
      const another = await ctx.call('u1', `/api/ai/requests/request-${i}`);
      if (i !== 1) assert.equal(another.status, 404);
    }
    assert.equal((await ctx.call('u1', '/api/ai/status', 'GET', undefined, ctx.api, 'u2')).status, 409);
  } finally { ctx.sqlite.close(); }
});

test('atomic reserve isolates same-user concurrency across API instances and enforces daily quota', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ limit: 2, invoke: async () => { started.resolve(); await gate.promise; return output('done'); } });
  try {
    const otherApi = createApi({ authenticate: ctx.authenticate, ai: createAiService({ invoke: async () => output('other') }) });
    const first = submit(ctx, 'u1', 'parallel-a');
    await started.promise;
    const competing = await submit(ctx, 'u1', 'parallel-b', undefined, otherApi);
    assert.deepEqual(competing, { status: 409, body: { error: 'AI_REQUEST_ACTIVE' } });
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.activeRequestId, 'parallel-a');
    gate.resolve();
    assert.equal((await first).body.status, 'completed');
    assert.equal((await submit(ctx, 'u1', 'parallel-b', undefined, otherApi)).body.status, 'completed');
    assert.equal((await submit(ctx, 'u1', 'parallel-c')).status, 429);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.usage.used, 2);
    assert.equal((await ctx.call('u2', '/api/ai/status')).body.usage.used, 0);
  } finally { ctx.sqlite.close(); }
});

test('null daily limit accepts more than 30 requests and still enforces one active request', async () => {
  const gate = deferred(); const started = deferred();
  let held = false;
  const ctx = setup({ limit: null, invoke: async () => {
    if (held) { started.resolve(); await gate.promise; }
    return output('done');
  } });
  try {
    const initial = await ctx.call('u1', '/api/ai/status');
    assert.equal(initial.body.limits.dailyRequests, null);
    assert.match(initial.body.usage.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(initial.body.usage.used, 0);
    assert.equal(initial.body.usage.remaining, null);
    for (let i = 0; i < 31; i++) {
      const accepted = await submit(ctx, 'u1', `unlimited-${i}`);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(accepted.body.usage.remaining, null);
    }
    held = true;
    const pending = submit(ctx, 'u1', 'unlimited-active');
    await started.promise;
    const otherApi = createApi({ authenticate: ctx.authenticate,
      ai: createAiService({ invoke: async () => output('other') }) });
    const competing = await submit(ctx, 'u1', 'unlimited-compete', undefined, otherApi);
    assert.deepEqual(competing, { status: 409, body: { error: 'AI_REQUEST_ACTIVE' } });
    gate.resolve();
    assert.equal((await pending).body.status, 'completed');
    const final = await ctx.call('u1', '/api/ai/status');
    assert.equal(final.body.usage.used, 32);
    assert.equal(final.body.usage.remaining, null);
    assert.equal(final.body.activeRequestId, null);
  } finally { gate.resolve(); ctx.sqlite.close(); }
});

test('request ID idempotency prevents reinvocation and rejects changed prompt', async () => {
  let calls = 0;
  const ctx = setup({ invoke: async () => { calls++; return output('safe'); } });
  try {
    assert.equal((await submit(ctx, 'u1', 'idempotent-1', 'one')).status, 200);
    assert.equal((await submit(ctx, 'u1', 'idempotent-1', 'one')).body.text, 'safe');
    assert.equal((await submit(ctx, 'u1', 'idempotent-1', 'two')).status, 409);
    assert.equal(calls, 1);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.usage.used, 1);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM ai_requests WHERE member_id=?').get('u1').n, 1);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM ai_requests WHERE prompt_hash LIKE ?').get('%one%').n, 0);
  } finally { ctx.sqlite.close(); }
});

test('real result retains its mode and reported token usage across retries and configuration changes', async () => {
  let calls = 0;
  const ctx = setup({ invoke: async () => { calls++; return realOutput('real answer', 37, 12); } });
  try {
    enableReal(ctx);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.status, 'real_ready');
    const first = await submit(ctx, 'u1', 'real-result-01');
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'completed');
    assert.equal(first.body.simulated, false);
    assert.equal(first.body.text, 'real answer');
    assert.deepEqual(first.body.tokenUsage, { inputTokens: 37, outputTokens: 12 });
    assert.equal(first.body.usage.used, 1);
    assert.deepEqual({ ...ctx.sqlite.prepare('SELECT simulated,input_tokens,output_tokens FROM ai_requests WHERE request_id=?')
      .get('real-result-01') }, { simulated: 0, input_tokens: 37, output_tokens: 12 });
    ctx.env.AI_ACCOUNT_CONFIG_JSON = config();
    const repeat = await submit(ctx, 'u1', 'real-result-01');
    assert.equal(repeat.body.simulated, false);
    assert.deepEqual(repeat.body.tokenUsage, { inputTokens: 37, outputTokens: 12 });
    assert.equal(calls, 1);
    assert.equal((await ctx.call('u1', '/api/ai/requests/real-result-01')).body.simulated, false);
    ctx.env.AI_ACCOUNT_CONFIG_JSON = '';
    assert.equal((await submit(ctx, 'u1', 'real-result-01')).body.simulated, false);
    assert.equal((await submit(ctx, 'u1', 'new-real-request')).status, 503);
  } finally { ctx.sqlite.close(); }
});

test('accepted real request remains real on failure and rejects a wrong-mode adapter result', async () => {
  const ctx = setup({ invoke: async () => output('wrong mode') });
  try {
    enableReal(ctx);
    const result = await submit(ctx, 'u1', 'real-wrong-mode');
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.simulated, false);
    assert.equal(result.body.tokenUsage, null);
    assert.deepEqual({ ...ctx.sqlite.prepare('SELECT simulated,input_tokens,output_tokens FROM ai_requests WHERE request_id=?')
      .get('real-wrong-mode') }, { simulated: 0, input_tokens: null, output_tokens: null });
  } finally { ctx.sqlite.close(); }
});

test('real cancellation and timeout retain unknown upstream token usage', async () => {
  const gate = deferred(); const started = deferred();
  const cancelled = setup({ invoke: async () => { started.resolve(); await gate.promise; return realOutput('late', 5, 6); } });
  try {
    enableReal(cancelled);
    const pending = submit(cancelled, 'u1', 'real-cancel-01');
    await started.promise;
    const cancel = await cancelled.call('u1', '/api/ai/requests/real-cancel-01/cancel', 'POST');
    assert.equal(cancel.body.status, 'cancelled');
    assert.equal(cancel.body.tokenUsage, null);
    assert.equal((await pending).body.tokenUsage, null);
    gate.resolve();
    assert.deepEqual({ ...cancelled.sqlite.prepare('SELECT input_tokens,output_tokens FROM ai_requests WHERE request_id=?')
      .get('real-cancel-01') }, { input_tokens: null, output_tokens: null });
  } finally { cancelled.sqlite.close(); }
  const timed = setup({ invoke: async () => new Promise(() => {}), timeoutMs: 1000 });
  try {
    enableReal(timed);
    const result = await submit(timed, 'u1', 'real-timeout-01');
    assert.equal(result.body.status, 'timed_out');
    assert.equal(result.body.simulated, false);
    assert.equal(result.body.tokenUsage, null);
  } finally { timed.sqlite.close(); }
});

test('migration marks prior E3C requests as mock with zero reported tokens', async () => {
  const { sqlite } = sqliteD1({ through: '0004_ai_requests.sql' });
  try {
    seed(sqlite, 'legacy', 'legacy@example.test');
    sqlite.prepare(`INSERT INTO ai_requests(member_id,request_id,prompt_hash,status,result_text,accepted_day,created_at_ms,lease_until_ms,expires_at_ms)
      VALUES(?,?,?,'completed',?,?,?,0,?)`).run('legacy', 'old-mock-request', 'hash', 'old answer', '2026-10-05', 1, 7 * 86400000);
    applyMigrations(sqlite, { after: '0004_ai_requests.sql' });
    assert.deepEqual({ ...sqlite.prepare('SELECT simulated,input_tokens,output_tokens FROM ai_requests WHERE request_id=?')
      .get('old-mock-request') }, { simulated: 1, input_tokens: 0, output_tokens: 0 });
  } finally { sqlite.close(); }
});

test('cross-instance cancellation releases slot and late adapter reply cannot revive it', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ invoke: async () => { started.resolve(); await gate.promise; return output('late'); } });
  try {
    const otherApi = createApi({ authenticate: ctx.authenticate, ai: createAiService() });
    const pending = submit(ctx, 'u1', 'cancel-me1');
    await started.promise;
    const cancel = await ctx.call('u1', '/api/ai/requests/cancel-me1/cancel', 'POST', undefined, otherApi);
    assert.equal(cancel.body.status, 'cancelled');
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.activeRequestId, 'cancel-me1');
    assert.equal((await submit(ctx, 'u1', 'next-after-cancel', undefined, otherApi)).status, 409);
    assert.equal((await pending).body.status, 'cancelled');
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.activeRequestId, null);
    assert.equal((await submit(ctx, 'u1', 'next-after-cancel', undefined, otherApi)).body.status, 'completed');
    gate.resolve();
    assert.equal((await ctx.call('u1', '/api/ai/requests/cancel-me1')).body.status, 'cancelled');
  } finally { ctx.sqlite.close(); }
});

test('timeout and adapter failure are terminal, counted and sanitized', async () => {
  const hanging = setup({ invoke: async () => new Promise(() => {}), timeoutMs: 1000 });
  try {
    const timed = await submit(hanging, 'u1', 'timeout-01');
    assert.equal(timed.body.status, 'timed_out');
    assert.equal((await hanging.call('u1', '/api/ai/status')).body.usage.used, 1);
  } finally { hanging.sqlite.close(); }
  const failing = setup({ invoke: async () => { throw new Error('SECRET-KEY private backend error'); } });
  try {
    const result = await submit(failing, 'u1', 'failure-01');
    assert.equal(result.body.status, 'failed');
    assert.equal(JSON.stringify(result.body).includes('SECRET-KEY'), false);
    assert.equal((await failing.call('u1', '/api/ai/status')).body.usage.used, 1);
  } finally { failing.sqlite.close(); }
});

test('failure codes are persisted and replayed from a strict public allowlist', async () => {
  let calls = 0;
  const errors = [
    { code: 'AI_PROVIDER_UNAVAILABLE', message: 'SECRET-KEY upstream trace' },
    { code: 'AI_PROVIDER_INVALID', message: 'private response body' },
    { code: 'AI_OUTPUT_INVALID', message: 'private model output' },
    { code: 'AI_TOOL_FAILED', message: 'private tool result' },
    { code: 'AI_BUDGET_EXCEEDED', message: 'private budget details' },
    { code: 'AI_PROVIDER_UNAVAILABLE<script>', message: 'SECRET-KEY forged code' },
    { message: 'AI_BUDGET_EXCEEDED SECRET-KEY message only' },
  ];
  const ctx = setup({ limit: null, invoke: async () => {
    const source = errors[calls++];
    throw Object.assign(new Error(source.message), source.code ? { code: source.code } : {});
  } });
  try {
    for (let i = 0; i < errors.length; i++) {
      const id = `classified-${i}`;
      const expected = i < 5 ? errors[i].code : 'AI_FAILED';
      const first = await submit(ctx, 'u1', id);
      assert.equal(first.body.status, 'failed');
      assert.equal(first.body.errorCode, expected);
      assert.equal(first.body.text, undefined);
      const stored = ctx.sqlite.prepare('SELECT result_text,result_json FROM ai_requests WHERE request_id=?').get(id);
      assert.equal(stored.result_text, null);
      assert.deepEqual(JSON.parse(stored.result_json), { errorCode: expected });
      assert.equal((await ctx.call('u1', `/api/ai/requests/${id}`)).body.errorCode, expected);
      assert.equal((await submit(ctx, 'u1', id)).body.errorCode, expected);
      assert.equal(calls, i + 1);
    }
    assert.equal(JSON.stringify(ctx.sqlite.prepare('SELECT result_json FROM ai_requests').all()).includes('SECRET-KEY'), false);
    ctx.sqlite.prepare('UPDATE ai_requests SET result_json=? WHERE request_id=?')
      .run('{"errorCode":"SECRET-KEY"}', 'classified-0');
    assert.equal((await ctx.call('u1', '/api/ai/requests/classified-0')).body.errorCode, 'AI_FAILED');
    ctx.sqlite.prepare('UPDATE ai_requests SET result_json=NULL WHERE request_id=?').run('classified-1');
    assert.equal((await submit(ctx, 'u1', 'classified-1')).body.errorCode, 'AI_FAILED');
  } finally { ctx.sqlite.close(); }
});

test('request deadline starts at reservation and skips invocation when preparation consumes it', async () => {
  let current = Date.now();
  let invocations = 0;
  const ctx = setup({ now: () => current, invoke: async () => { invocations++; return output('late'); } });
  try {
    const wrappedDb = { prepare(sql) {
      const prepared = ctx.db.prepare(sql);
      if (!sql.includes('INSERT OR IGNORE INTO ai_requests')) return prepared;
      return { bind(...args) {
        const bound = prepared.bind(...args);
        return { async run() {
          const result = await bound.run();
          current += 1001;
          return result;
        } };
      } };
    } };
    const result = await ctx.ai.submit(wrappedDb, ctx.env, 'u1', body('deadline-before-invoke'));
    assert.equal(result.value.status, 'timed_out');
    assert.equal(invocations, 0);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.activeRequestId, null);
  } finally { ctx.sqlite.close(); }
});

test('dialogue failure categories are allowlisted across storage, status and same-ID replay', async () => {
  let calls = 0;
  const ctx = setup({ limit: null, invoke: async () => {
    calls++;
    throw Object.assign(new Error('SECRET provider output'), {
      code: 'AI_DIALOGUE_INVALID', diagnosticReason: 'reference_unknown',
    });
  } });
  try {
    const first = await submit(ctx, 'u1', 'reason-check-01');
    assert.equal(first.body.errorCode, 'AI_DIALOGUE_INVALID');
    assert.equal(first.body.diagnosticReason, 'reference_unknown');
    assert.deepEqual(first.body.diagnostic,{reason:'reference_unknown',recovery:'retry',recovered:false});
    assert.equal(first.body.requestId,'reason-check-01');
    const status = await ctx.call('u1', '/api/ai/requests/reason-check-01');
    assert.equal(status.body.diagnosticReason, 'reference_unknown');
    assert.deepEqual(status.body.diagnostic,first.body.diagnostic);
    assert.equal(status.body.text, undefined);
    const replay = await submit(ctx, 'u1', 'reason-check-01');
    assert.equal(replay.body.diagnosticReason, 'reference_unknown');
    assert.deepEqual(replay.body.diagnostic,first.body.diagnostic);
    assert.equal(calls, 1);
    const row = ctx.sqlite.prepare('SELECT result_json FROM ai_requests WHERE request_id=?').get('reason-check-01');
    assert.deepEqual(JSON.parse(row.result_json), { errorCode: 'AI_DIALOGUE_INVALID', diagnosticReason: 'reference_unknown' });
    for (const payload of [
      { errorCode: 'AI_DIALOGUE_INVALID', diagnosticReason: 'SECRET model body' },
      { errorCode: 'AI_PROVIDER_ERROR', diagnosticReason: 'reference_unknown' },
      { errorCode: 'AI_DIALOGUE_INVALID', diagnosticReason: { raw: 'SECRET' } },
    ]) {
      ctx.sqlite.prepare('UPDATE ai_requests SET result_json=? WHERE request_id=?')
        .run(JSON.stringify(payload), 'reason-check-01');
      const safe = await ctx.call('u1', '/api/ai/requests/reason-check-01');
      assert.equal(safe.body.diagnosticReason, undefined);
      assert.equal(JSON.stringify(safe).includes('SECRET'), false);
    }
  } finally { ctx.sqlite.close(); }
});

test('one transient cancellation-poll read failure does not discard a valid result', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ invoke: async () => { started.resolve(); await gate.promise; return output('completed'); } });
  try {
    let failNextPoll = false;
    let pollFailures = 0;
    const wrappedDb = { prepare(sql) {
      const prepared = ctx.db.prepare(sql);
      if (!sql.startsWith('SELECT request_id,prompt_hash,operation,status')) return prepared;
      return { bind(...args) {
        const bound = prepared.bind(...args);
        return { async first() {
          if (failNextPoll) { failNextPoll = false; pollFailures++; throw Error('temporary D1 read failure'); }
          return bound.first();
        } };
      } };
    } };
    const pending = ctx.ai.submit(wrappedDb, ctx.env, 'u1', body('poll-read-retry'));
    await started.promise;
    failNextPoll = true;
    await new Promise(resolve => setTimeout(resolve, 40));
    gate.resolve();
    const result = await pending;
    assert.equal(pollFailures, 1);
    assert.equal(result.value.status, 'completed');
  } finally { gate.resolve(); ctx.sqlite.close(); }
});

test('one empty cancellation-poll read does not turn a valid result into cancellation', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ invoke: async () => { started.resolve(); await gate.promise; return output('completed'); } });
  try {
    let emptyNextPoll = false;
    let emptyReads = 0;
    const wrappedDb = { prepare(sql) {
      const prepared = ctx.db.prepare(sql);
      if (!sql.startsWith('SELECT request_id,prompt_hash,operation,status')) return prepared;
      return { bind(...args) {
        const bound = prepared.bind(...args);
        return { async first() {
          if (emptyNextPoll) { emptyNextPoll = false; emptyReads++; return null; }
          return bound.first();
        } };
      } };
    } };
    const pending = ctx.ai.submit(wrappedDb, ctx.env, 'u1', body('poll-null-retry'));
    await started.promise;
    emptyNextPoll = true;
    await new Promise(resolve => setTimeout(resolve, 40));
    gate.resolve();
    const result = await pending;
    assert.equal(emptyReads, 1);
    assert.equal(result.value.status, 'completed');
    assert.equal(ctx.sqlite.prepare('SELECT status FROM ai_requests WHERE request_id=?')
      .get('poll-null-retry').status, 'completed');
  } finally { gate.resolve(); ctx.sqlite.close(); }
});

test('slow cancellation polls stay single-flight and ignore a late read after completion', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ pollIntervalMs: 10,
    invoke: async () => { started.resolve(); await gate.promise; return output('completed'); } });
  try {
    let slowPolls = false, active = 0, maxActive = 0, pollReads = 0;
    const wrappedDb = { prepare(sql) {
      const prepared = ctx.db.prepare(sql);
      if (!sql.startsWith('SELECT request_id,prompt_hash,operation,status')) return prepared;
      return { bind(...args) {
        const bound = prepared.bind(...args);
        return { async first() {
          if (slowPolls) {
            active++; pollReads++; maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 60));
            active--;
          }
          return bound.first();
        } };
      } };
    } };
    const pending = ctx.ai.submit(wrappedDb, ctx.env, 'u1', body('poll-single-flight'));
    await started.promise;
    slowPolls = true;
    await new Promise(resolve => setTimeout(resolve, 160));
    slowPolls = false;
    gate.resolve();
    const result = await pending;
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.ok(pollReads >= 2);
    assert.equal(maxActive, 1);
    assert.equal(result.value.status, 'completed');
    assert.equal(ctx.sqlite.prepare('SELECT status FROM ai_requests WHERE request_id=?')
      .get('poll-single-flight').status, 'completed');
  } finally { gate.resolve(); ctx.sqlite.close(); }
});

test('an explicit cancellation is still observed during a slow status poll', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ pollIntervalMs: 10,
    invoke: async () => { started.resolve(); await gate.promise; return output('late'); } });
  try {
    let slowPolls = false;
    const wrappedDb = { prepare(sql) {
      const prepared = ctx.db.prepare(sql);
      if (!sql.startsWith('SELECT request_id,prompt_hash,operation,status')) return prepared;
      return { bind(...args) {
        const bound = prepared.bind(...args);
        return { async first() {
          if (slowPolls) await new Promise(resolve => setTimeout(resolve, 60));
          return bound.first();
        } };
      } };
    } };
    const pending = ctx.ai.submit(wrappedDb, ctx.env, 'u1', body('poll-real-cancel'));
    await started.promise;
    slowPolls = true;
    await new Promise(resolve => setTimeout(resolve, 20));
    const cancelled = await ctx.ai.cancel(ctx.db, ctx.env, 'u1', 'poll-real-cancel');
    assert.equal(cancelled.status, 'cancelled');
    const result = await pending;
    assert.equal(result.value.status, 'cancelled');
  } finally { gate.resolve(); ctx.sqlite.close(); }
});

test('empty pre-invocation status reads cannot start a second paid invocation', async () => {
  const ctx = setup({ invoke: async () => output('unexpected') });
  try {
    let reads = 0, invocations = 0;
    const ai = createAiService({ invoke: async () => {
      invocations++; return output('unexpected');
    }, pollIntervalMs: 10 });
    const wrappedDb = { prepare(sql) {
      const prepared = ctx.db.prepare(sql);
      if (!sql.startsWith('SELECT request_id,prompt_hash,operation,status')) return prepared;
      return { bind(...args) {
        const bound = prepared.bind(...args);
        return { async first() {
          reads++;
          if (reads === 2 || reads === 3) return null;
          return bound.first();
        } };
      } };
    } };
    await assert.rejects(ai.submit(wrappedDb, ctx.env, 'u1', body('before-null-read')),
      error => error.status === 503 && error.code === 'AI_UNAVAILABLE');
    assert.equal(invocations, 0);
    assert.equal(ctx.sqlite.prepare('SELECT status FROM ai_requests WHERE request_id=?')
      .get('before-null-read').status, 'processing');
  } finally { ctx.sqlite.close(); }
});

test('invalid and unconfigured requests do not consume quota or touch documents', async () => {
  const ctx = setup({ invoke: async () => output('ok') });
  try {
    assert.equal((await submit(ctx, 'u1', 'bad', 'hello')).status, 400);
    assert.equal((await submit(ctx, 'u1', 'valid-id1', 'x'.repeat(2001))).status, 400);
    ctx.env.AI_ACCOUNT_CONFIG_JSON = '';
    assert.equal((await submit(ctx, 'u1', 'valid-id1', 'hello')).status, 503);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.usage.used, 0);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM documents').get().n, 0);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM ai_requests').get().n, 0);
    assert.equal((await ctx.call('u1', '/api/documents/settings/profile', 'POST', {})).status, 405);
  } finally { ctx.sqlite.close(); }
});

test('cancellation before adapter start avoids invocation and releases its lease', async () => {
  let invocations = 0;
  const ctx = setup({ invoke: async () => { invocations++; return output('unexpected'); } });
  try {
    let intercepted = false;
    const wrappedDb = { prepare(sql) {
      const prepared = ctx.db.prepare(sql);
      if (!sql.includes('INSERT OR IGNORE INTO ai_requests') || intercepted) return prepared;
      return { bind(...args) {
        const bound = prepared.bind(...args);
        return { async run() {
          const result = await bound.run();
          intercepted = true;
          await ctx.ai.cancel(ctx.db, ctx.env, 'u1', 'before-start1');
          return result;
        } };
      } };
    } };
    const result = await ctx.ai.submit(wrappedDb, ctx.env, 'u1', body('before-start1'));
    assert.equal(result.value.status, 'cancelled');
    assert.equal(invocations, 0);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.activeRequestId, null);
  } finally { ctx.sqlite.close(); }
});

test('disabled member and malformed adapter output cannot publish a successful result', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ invoke: async () => { started.resolve(); await gate.promise; return output('should not publish'); } });
  try {
    const pending = submit(ctx, 'u1', 'disable-midflight');
    await started.promise;
    ctx.sqlite.prepare("UPDATE members SET status='disabled' WHERE id='u1'").run();
    gate.resolve();
    const result = await pending;
    assert.equal(result.body.status, 'cancelled');
    assert.equal(ctx.sqlite.prepare("SELECT result_text FROM ai_requests WHERE request_id='disable-midflight'").get().result_text, null);
  } finally { ctx.sqlite.close(); }
  const invalid = setup({ invoke: async () => ({ text: '<script>secret</script>', usage: { inputTokens: 0, outputTokens: 0 }, simulated: true }) });
  try {
    const result = await submit(invalid, 'u1', 'invalid-output');
    assert.equal(result.body.status, 'failed');
    assert.equal(JSON.stringify(result.body).includes('secret'), false);
  } finally { invalid.sqlite.close(); }
});

test('expired worker lease is reclaimed so a later request is not blocked forever', async () => {
  const ctx = setup({ invoke: async () => output('recovered') });
  try {
    const old = Date.now() - 60_000;
    ctx.sqlite.prepare(`INSERT INTO ai_requests(member_id,request_id,prompt_hash,status,result_text,accepted_day,created_at_ms,lease_until_ms,expires_at_ms)
      VALUES(?,?,?,'processing',NULL,?,?,?,?)`).run('u1', 'orphaned-01', 'abc', new Date().toISOString().slice(0, 10), old, old + 1000, old + 7 * 86400000);
    const result = await submit(ctx, 'u1', 'after-orphan');
    assert.equal(result.body.status, 'completed');
    assert.equal((await ctx.call('u1', '/api/ai/requests/orphaned-01')).body.status, 'expired');
  } finally { ctx.sqlite.close(); }
});
