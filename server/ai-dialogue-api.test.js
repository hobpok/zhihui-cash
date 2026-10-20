import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../app/model.js';
import { createApi } from './api.js';
import { createAiService } from './ai-service.js';
import { seed, sqliteD1 } from './test-support/sqlite-d1.js';
import { RESET_RELEASE } from '../app/release-version.js';

const origin = 'https://workspace.local.test';
const request = (requestId, documentRevision = 1, message = '请解释头寸') =>
  ({ requestId, message, runDocumentId: 'current', documentRevision });
const reply = {
  text: '根据当前运行测算。', simulated: false,
  usage: { inputTokens: 9, outputTokens: 6 },
  dialogue: { status: 'answered', answer: '根据当前运行测算。', references: [], evidence: [] },
};
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup({ dialogueInvoke = async () => reply, invoke = async () => reply,
  toolsFactory = (saved, context) => ({ saved, context }), limit = 30 } = {}) {
  const { sqlite, db } = sqliteD1();
  for (const id of ['u1', 'u2']) {
    seed(sqlite, id, `${id}@example.test`);
    sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
      .run(id, id, 'salt', 'hash', 100000);
  }
  const env = { APP_ORIGIN: origin, DB: db, AI_KEY_TEST: 'synthetic-test-placeholder',
    AI_ACCOUNT_CONFIG_JSON: JSON.stringify(Object.fromEntries(['u1', 'u2'].map(id => [id,
      { mode: 'real', provider: 'deepseek', model: 'deepseek-flash', keyBinding: 'AI_KEY_TEST', dailyLimit: limit, timeoutMs: 1000 }]))) };
  const authenticate = async req => ({ memberId: req.headers.get('x-test-member') });
  const ai = createAiService({ dialogueInvoke, invoke, toolsFactory, pollIntervalMs: 10 });
  const api = createApi({ ai, authenticate });
  async function call(user, path, method = 'GET', body) {
    const response = await api(new Request(`${origin}${path}`, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Test-Member': user,
        'X-Workspace-User': user, 'X-App-Release': RESET_RELEASE },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: response.status, body: await response.json() };
  }
  const model = createModel();
  model.startFromTemplate();
  const saved = JSON.parse(model.serialize());
  async function put(user = 'u1', expectedRevision = 0, value = saved) {
    return call(user, '/api/documents/run/current', 'PUT',
      { expectedRevision, mutationId: `mutation-${user}-${expectedRevision}-${Date.now()}`, value });
  }
  return { sqlite, db, env, ai, call, put, saved };
}

test('dialogue uses owned run and profile notes, saves result for replay, and GET exposes metadata only', async () => {
  let calls = 0;
  const ctx = setup({ dialogueInvoke: async ({ message, resolved, tools }) => {
    calls++;
    assert.equal(message, '请解释头寸');
    assert.equal(resolved.state, 'real_ready');
    assert.equal(tools.context.notes, '仅为个人备注');
    assert.equal(tools.context.documentRevision, 1);
    assert.deepEqual(tools.saved, ctx.saved);
    return reply;
  } });
  try {
    assert.equal((await ctx.put()).status, 200);
    assert.equal((await ctx.call('u1', '/api/documents/settings/profile', 'PUT',
      { expectedRevision: 0, mutationId: 'notes-mutation-01', value: { preferences: { notes: '仅为个人备注' } } })).status, 200);
    const first = await ctx.call('u1', '/api/ai/dialogue', 'POST', request('dialogue-01'));
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'completed');
    assert.deepEqual(first.body.dialogue, reply.dialogue);
    assert.equal(first.body.text, reply.text);
    assert.equal(first.body.simulated, false);
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('dialogue-01'))).body.dialogue.answer,
      reply.dialogue.answer);
    assert.equal(calls, 1);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.usage.used, 1);
    const metadata = await ctx.call('u1', '/api/ai/requests/dialogue-01');
    assert.equal(metadata.body.status, 'completed');
    assert.equal(Object.hasOwn(metadata.body, 'text'), false);
    assert.equal(Object.hasOwn(metadata.body, 'dialogue'), false);
    assert.equal((await ctx.call('u2', '/api/ai/requests/dialogue-01')).status, 404);
    const row = ctx.sqlite.prepare('SELECT operation,result_json FROM ai_requests WHERE request_id=?').get('dialogue-01');
    assert.equal(row.operation, 'dialogue');
    assert.deepEqual(JSON.parse(row.result_json).dialogue, reply.dialogue);
  } finally { ctx.sqlite.close(); }
});

test('optional narrative survives the existing dialogue persistence and replay protocol', async () => {
  const withNarrative = { ...reply, dialogue: { ...reply.dialogue,
    narrative: '当前指标只是此刻结果。请先核对未完成交易的执行前提，再刷新测算和审核。' } };
  const ctx = setup({ dialogueInvoke: async () => withNarrative });
  try {
    assert.equal((await ctx.put()).status, 200);
    const first = await ctx.call('u1', '/api/ai/dialogue', 'POST', request('narrative-01'));
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.dialogue, withNarrative.dialogue);
    const replay = await ctx.call('u1', '/api/ai/dialogue', 'POST', request('narrative-01'));
    assert.deepEqual(replay.body.dialogue, withNarrative.dialogue);
    const row = ctx.sqlite.prepare('SELECT result_json FROM ai_requests WHERE request_id=?').get('narrative-01');
    assert.deepEqual(JSON.parse(row.result_json).dialogue, withNarrative.dialogue);
  } finally { ctx.sqlite.close(); }
});

test('a completed dialogue supplies bounded same-run history without exposing private continuity metadata', async () => {
  const invocations = [];
  const ctx = setup({ dialogueInvoke: async ({ message, history }) => {
    invocations.push({ message, history });
    return { ...reply, text: `答复${invocations.length}`, dialogue: { ...reply.dialogue,
      status: 'answer', answer: `答复${invocations.length}`, narrative: `答复${invocations.length}` } };
  } });
  try {
    await ctx.put();
    const first = await ctx.call('u1', '/api/ai/dialogue', 'POST', request('history-first-01', 1, '前一个问题'));
    assert.equal(first.body.status, 'completed');
    assert.equal(Object.hasOwn(first.body.dialogue, 'continuity'), false);
    const secondBody = { ...request('history-second-01', 1, '那接下来呢'), previousRequestId: 'history-first-01' };
    const second = await ctx.call('u1', '/api/ai/dialogue', 'POST', secondBody);
    assert.equal(second.body.status, 'completed');
    assert.deepEqual(invocations[1].history, [{ userMessage: '前一个问题', assistantAnswer: '答复1' }]);
    assert.equal(JSON.stringify(second.body).includes('前一个问题'), false);
    assert.deepEqual((await ctx.call('u1', '/api/ai/dialogue', 'POST', secondBody)).body, second.body);
    assert.equal(invocations.length, 2);
    assert.deepEqual(await ctx.call('u1', '/api/ai/dialogue', 'POST',
      { ...secondBody, previousRequestId: 'history-unrelated-01' }),
    { status: 409, body: { error: 'REQUEST_ID_CONFLICT' } });
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST',
      { ...secondBody, previousRequestId: null })).status, 400);
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST',
      { ...secondBody, previousRequestId: 'history-second-01' })).status, 400);
  } finally { ctx.sqlite.close(); }
});

test('dialogue accepts a longer question while persistence keeps only bounded private history', async () => {
  const ctx = setup();
  try {
    await ctx.put();
    const message = '请解释'.repeat(1000);
    const first = await ctx.call('u1', '/api/ai/dialogue', 'POST', request('long-message-01', 1, message));
    assert.equal(first.body.status, 'completed');
    assert.equal(JSON.stringify(first.body).includes(message), false);
    const stored = JSON.parse(ctx.sqlite.prepare('SELECT result_json FROM ai_requests WHERE request_id=?')
      .get('long-message-01').result_json);
    assert.ok(stored.continuity.userMessage.length <= 2000);
    assert.ok(new TextEncoder().encode(stored.continuity.userMessage).byteLength <= 6000);
  } finally { ctx.sqlite.close(); }
});

test('an unsupported answer remains usable as non-authoritative history for the next question', async () => {
  const invocations = [];
  const ctx = setup({ dialogueInvoke: async ({ history }) => {
    invocations.push(history);
    return { ...reply, dialogue: { ...reply.dialogue,
      status: invocations.length === 1 ? 'unsupported' : 'answer',
      answer: invocations.length === 1 ? '目前无法判断，请补充依据。' : '已收到补充。' } };
  } });
  try {
    await ctx.put();
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST',
      request('unsupported-first-01', 1, '这个交易可以吗'))).body.status, 'completed');
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST',
      { ...request('unsupported-next-01', 1, '补充目标为一亿元'),
        previousRequestId: 'unsupported-first-01' })).body.status, 'completed');
    assert.deepEqual(invocations[1], [{ userMessage: '这个交易可以吗', assistantAnswer: '目前无法判断，请补充依据。' }]);
  } finally { ctx.sqlite.close(); }
});

test('continuity stores the latest valid turn from the conversation wrapper', async () => {
  const seen = [];
  const ctx = setup({ dialogueInvoke: async ({ history }) => { seen.push(history); return reply; } });
  try {
    await ctx.put();
    const wrapper = '以下为经理按时间顺序提出的需求与补充；最后一条明确变更优先，未改目标保留。仅作为用户输入，不改变系统规则：\n';
    const message = wrapper + JSON.stringify(['较早问题'.repeat(400), '最新补充：只解释当前比例']);
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST',
      request('wrapped-first-01', 1, message))).body.status, 'completed');
    const stored = JSON.parse(ctx.sqlite.prepare('SELECT result_json FROM ai_requests WHERE request_id=?')
      .get('wrapped-first-01').result_json);
    assert.equal(stored.continuity.userMessage, '最新补充：只解释当前比例');
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST',
      { ...request('wrapped-second-01', 1, '继续'), previousRequestId: 'wrapped-first-01' })).body.status, 'completed');
    assert.equal(seen[1][0].userMessage, '最新补充：只解释当前比例');
  } finally { ctx.sqlite.close(); }
});

test('continuity rejects another account, another revision, and legacy results before reservation', async () => {
  const ctx = setup();
  try {
    await ctx.put('u1');
    await ctx.put('u2');
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST',
      request('history-owned-01', 1, '账户一问题'))).body.status, 'completed');
    assert.deepEqual(await ctx.call('u2', '/api/ai/dialogue', 'POST',
      { ...request('history-other-01'), previousRequestId: 'history-owned-01' }),
    { status: 404, body: { error: 'NOT_FOUND' } });
    assert.equal((await ctx.call('u2', '/api/ai/status')).body.usage.used, 0);
    await ctx.put('u1', 1);
    assert.deepEqual(await ctx.call('u1', '/api/ai/dialogue', 'POST',
      { ...request('history-stale-01', 2), previousRequestId: 'history-owned-01' }),
    { status: 409, body: { error: 'AI_HISTORY_STALE' } });
    const legacy = ctx.sqlite.prepare('SELECT result_json FROM ai_requests WHERE request_id=?').get('history-owned-01');
    ctx.sqlite.prepare('UPDATE ai_requests SET result_json=? WHERE request_id=?')
      .run(JSON.stringify(JSON.parse(legacy.result_json).dialogue), 'history-owned-01');
    assert.deepEqual(await ctx.call('u1', '/api/ai/dialogue', 'POST',
      { ...request('history-legacy-01', 2), previousRequestId: 'history-owned-01' }),
    { status: 409, body: { error: 'AI_HISTORY_UNAVAILABLE' } });
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM ai_requests WHERE request_id LIKE ?').get('history-%').n, 1);
  } finally { ctx.sqlite.close(); }
});

test('strict body, ownership, revision, and real-only mode reject before quota', async () => {
  const ctx = setup();
  try {
    assert.equal((await ctx.put('u2')).status, 200);
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('not-owned-01'))).status, 404);
    assert.equal((await ctx.put('u1')).status, 200);
    for (const body of [
      { ...request('invalid-01'), saved: ctx.saved },
      { ...request('invalid-02'), toolResult: {} },
      request('invalid-03', 0), request('invalid-04', 2),
      request('invalid-05', 1, 'x'.repeat(8001)),
    ]) assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', body)).status,
      body.documentRevision === 2 ? 409 : 400);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM ai_requests').get().n, 0);
    ctx.env.AI_ACCOUNT_CONFIG_JSON = JSON.stringify({ u1: { mode: 'mock', provider: 'mock' } });
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('mock-denied-01'))).status, 503);
  } finally { ctx.sqlite.close(); }
});

test('valid historical run is rejected before reservation and does not use daily quota', async () => {
  const ctx = setup();
  try {
    assert.equal((await ctx.put('u1', 0, JSON.parse(createModel().serialize()))).status, 200);
    const result = await ctx.call('u1', '/api/ai/dialogue', 'POST', request('legacy-run-01'));
    assert.deepEqual(result, { status: 409, body: { error: 'AI_RUN_UNSUPPORTED' } });
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.usage.used, 0);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM ai_requests').get().n, 0);
  } finally { ctx.sqlite.close(); }
});

test('request IDs separate probe and dialogue; changed dialogue input conflicts', async () => {
  const ctx = setup({ invoke: async () => ({ text: 'probe ok', usage: { inputTokens: 1, outputTokens: 1 }, simulated: false }) });
  try {
    await ctx.put();
    assert.equal((await ctx.call('u1', '/api/ai/requests', 'POST',
      { requestId: 'shared-id-01', prompt: 'probe' })).body.status, 'completed');
    assert.deepEqual((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('shared-id-01'))),
      { status: 409, body: { error: 'REQUEST_ID_CONFLICT' } });
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('dialogue-02'))).body.status, 'completed');
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('dialogue-02', 1, '另一个问题'))).status, 409);
    assert.equal((await ctx.call('u1', '/api/ai/requests', 'POST',
      { requestId: 'dialogue-02', prompt: 'probe' })).status, 409);
  } finally { ctx.sqlite.close(); }
});

test('dialogue failure classification survives metadata GET and same-ID POST without private details', async () => {
  const codes = ['AI_BUDGET_EXCEEDED', 'AI_PROVIDER_ERROR', 'AI_DIALOGUE_INVALID', 'AI_TOOL_FAILED'];
  let calls = 0;
  const ctx = setup({ limit: null, dialogueInvoke: async () => {
    throw Object.assign(new Error('SECRET-KEY private model response'), { code: codes[calls++] });
  } });
  try {
    await ctx.put();
    for (const [i, code] of codes.entries()) {
      const input = request(`dialogue-failure-${i}`);
      const first = await ctx.call('u1', '/api/ai/dialogue', 'POST', input);
      assert.equal(first.status, 200);
      assert.equal(first.body.status, 'failed');
      assert.equal(first.body.errorCode, code);
      assert.equal(first.body.text, undefined);
      assert.equal(first.body.dialogue, undefined);
      assert.equal((await ctx.call('u1', `/api/ai/requests/${input.requestId}`)).body.errorCode, code);
      assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', input)).body.errorCode, code);
      assert.equal(calls, i + 1);
      const stored = ctx.sqlite.prepare('SELECT result_text,result_json FROM ai_requests WHERE request_id=?').get(input.requestId);
      assert.equal(stored.result_text, null);
      assert.deepEqual(JSON.parse(stored.result_json), { errorCode: code });
    }
    assert.equal(JSON.stringify(ctx.sqlite.prepare('SELECT result_json FROM ai_requests').all()).includes('SECRET-KEY'), false);
  } finally { ctx.sqlite.close(); }
});

test('revised or deleted run cannot publish or replay old answer', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ dialogueInvoke: async () => { started.resolve(); await gate.promise; return reply; } });
  try {
    await ctx.put();
    const pending = ctx.call('u1', '/api/ai/dialogue', 'POST', request('stale-result-01'));
    await started.promise;
    assert.equal((await ctx.put('u1', 1)).status, 200);
    gate.resolve();
    const result = await pending;
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.errorCode, 'AI_DOCUMENT_STALE');
    assert.equal((await ctx.call('u1', '/api/ai/requests/stale-result-01')).body.errorCode, 'AI_DOCUMENT_STALE');
    assert.equal(Object.hasOwn(result.body, 'dialogue'), false);
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('stale-result-01'))).status, 409);
    assert.deepEqual(JSON.parse(ctx.sqlite.prepare('SELECT result_json FROM ai_requests WHERE request_id=?')
      .get('stale-result-01').result_json), { errorCode: 'AI_DOCUMENT_STALE' });
    assert.equal((await ctx.call('u1', '/api/documents/run/current', 'DELETE',
      { expectedRevision: 2, mutationId: 'delete-run-01' })).status, 200);
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('after-delete-01', 2))).status, 404);
  } finally { ctx.sqlite.close(); }
});

test('cancellation wins over a late dialogue result and releases request lease', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ dialogueInvoke: async () => { started.resolve(); await gate.promise; return reply; } });
  try {
    await ctx.put();
    const pending = ctx.call('u1', '/api/ai/dialogue', 'POST', request('cancel-dialogue-01'));
    await started.promise;
    const cancel = await ctx.call('u1', '/api/ai/requests/cancel-dialogue-01/cancel', 'POST');
    assert.equal(cancel.body.status, 'cancelled');
    assert.equal((await pending).body.status, 'cancelled');
    gate.resolve();
    assert.equal(ctx.sqlite.prepare('SELECT result_json FROM ai_requests WHERE request_id=?').get('cancel-dialogue-01').result_json, null);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.activeRequestId, null);
  } finally { ctx.sqlite.close(); }
});

test('dialogue and probe share one active slot and daily accepted-attempt limit', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = setup({ limit: 2, dialogueInvoke: async () => {
    started.resolve(); await gate.promise; return reply;
  }, invoke: async () => ({ text: 'probe ok', usage: { inputTokens: 1, outputTokens: 1 }, simulated: false }) });
  try {
    await ctx.put();
    const pending = ctx.call('u1', '/api/ai/dialogue', 'POST', request('slot-dialogue-01'));
    await started.promise;
    assert.deepEqual(await ctx.call('u1', '/api/ai/requests', 'POST',
      { requestId: 'slot-probe-01', prompt: 'probe' }),
    { status: 409, body: { error: 'AI_REQUEST_ACTIVE' } });
    gate.resolve();
    assert.equal((await pending).body.status, 'completed');
    assert.equal((await ctx.call('u1', '/api/ai/requests', 'POST',
      { requestId: 'slot-probe-01', prompt: 'probe' })).body.status, 'completed');
    assert.equal((await ctx.call('u1', '/api/ai/dialogue', 'POST', request('quota-dialogue-01'))).status, 429);
    assert.equal((await ctx.call('u1', '/api/ai/status')).body.usage.used, 2);
  } finally { ctx.sqlite.close(); }
});

test('dialogue and probe share unlimited daily usage without a zero remaining count', async () => {
  const ctx = setup({ limit: null,
    invoke: async () => ({ text: 'probe ok', usage: { inputTokens: 1, outputTokens: 1 }, simulated: false }) });
  try {
    await ctx.put();
    const dialogue = await ctx.call('u1', '/api/ai/dialogue', 'POST', request('unlimited-dialogue-01'));
    assert.equal(dialogue.status, 200);
    assert.equal(dialogue.body.usage.remaining, null);
    const probe = await ctx.call('u1', '/api/ai/requests', 'POST',
      { requestId: 'unlimited-probe-01', prompt: 'probe' });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.usage.remaining, null);
    const status = await ctx.call('u1', '/api/ai/status');
    assert.equal(status.body.limits.dailyRequests, null);
    assert.equal(status.body.usage.used, 2);
    assert.equal(status.body.usage.remaining, null);
  } finally { ctx.sqlite.close(); }
});

test('oversized structured dialogue fails closed without persisting the result', async () => {
  const ctx = setup({ dialogueInvoke: async () => ({ ...reply,
    dialogue: { ...reply.dialogue, evidence: [{ text: 'x'.repeat(125_000) }] } }) });
  try {
    await ctx.put();
    const result = await ctx.call('u1', '/api/ai/dialogue', 'POST', request('large-result-01'));
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.errorCode, 'AI_FAILED');
    assert.deepEqual(JSON.parse(ctx.sqlite.prepare('SELECT result_json FROM ai_requests WHERE request_id=?')
      .get('large-result-01').result_json), { errorCode: 'AI_FAILED' });
  } finally { ctx.sqlite.close(); }
});

test('private continuity metadata does not consume the public dialogue response budget', async () => {
  const largeReply = { ...reply, dialogue: { ...reply.dialogue,
    evidence: [{ text: 'x'.repeat(118_000) }] } };
  const ctx = setup({ dialogueInvoke: async () => largeReply });
  try {
    await ctx.put();
    const result = await ctx.call('u1', '/api/ai/dialogue', 'POST',
      request('near-limit-01', 1, '请解释'.repeat(1000)));
    assert.equal(result.body.status, 'completed');
    assert.equal(result.body.dialogue.evidence[0].text.length, 118_000);
    assert.equal(Object.hasOwn(result.body.dialogue, 'continuity'), false);
  } finally { ctx.sqlite.close(); }
});
