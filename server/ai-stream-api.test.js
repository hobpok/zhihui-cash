import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './api.js';
import { createAiService } from './ai-service.js';
import { createStore } from './storage.js';
import { seed, sqliteD1 } from './test-support/sqlite-d1.js';
import { createModel } from '../app/model.js';
import { dialogueStreamResponse } from './dialogue-stream-response.js';
const origin = 'https://workspace.local.test';
const reply = { text: '核算完成。', simulated: false, usage: { inputTokens: 9, outputTokens: 6 },
  dialogue: { status: 'answer', answer: '核算完成。', narrative: '核算完成。', references: [], evidence: [] } };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function setup(dialogueInvoke, observation = null) {
  const { sqlite, db } = sqliteD1();
  seed(sqlite, 'u1', 'synthetic@example.test'); seed(sqlite, 'u2', 'synthetic2@example.test');
  for (const id of ['u1', 'u2']) sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
    .run(id, id, 'synthetic-salt', 'synthetic-hash', 100000);
  const env = { DB: db, APP_ORIGIN: origin, AI_KEY_TEST: 'synthetic-test-only',
    AI_ACCOUNT_CONFIG_JSON: JSON.stringify({ u1: { mode: 'real', provider: 'deepseek', model: 'deepseek-flash',
      keyBinding: 'AI_KEY_TEST', dailyLimit: 30, timeoutMs: 1000 } }) };
  const model = createModel(); model.startFromTemplate();
  const store = createStore(db);
  const saved = JSON.parse(model.serialize());
  await store.putDocument('u1', 'run', 'current', { expectedRevision: 0, mutationId: 'stream-seed-0001', value: saved });
  const service = createAiService({ dialogueInvoke, pollIntervalMs: 5 });
  const api = createApi({ ai: service, authenticate: async request => ({ memberId: request.headers.get('x-test-user') }),
    observabilityFactory: observation ? () => observation : () => null });
  const body = { requestId: 'stream-request-0001', message: '当前头寸如何？', runDocumentId: 'current', documentRevision: 1 };
  const call = (path = '/api/ai/dialogue', { user = 'u1', owner = user, method = 'POST', data = body, stream = true, context } = {}) =>
    api(new Request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json',
      'X-Test-User': user, 'X-Workspace-User': owner, ...(stream ? { Accept: 'text/event-stream' } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(data) }) }), env, context);
  return { sqlite, db, env, saved, store, service, body, call };
}
const frames = text => text.split(/\r?\n\r?\n/).filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]));
test('stream returns a real preview before the service finishes and only then emits the durable result', async () => {
  const gate = deferred(); let calls = 0;
  const ctx = await setup(async ({ onProgress }) => {
    calls++; onProgress({ type: 'phase', phase: 'generating' });
    onProgress({ type: 'preview', text: '未校验文字', round: 0, forbidden: 'must-not-leak' });
    await gate.promise; return reply;
  });
  try {
    const response = await ctx.call(); assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(response.headers.get('cache-control'), /no-store.*no-transform/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let text = '';
    while (!text.includes('未校验文字')) text += decoder.decode((await reader.read()).value);
    assert.ok(!text.includes('complete')); assert.ok(!text.includes('must-not-leak'));
    assert.equal(ctx.sqlite.prepare('SELECT status,result_text FROM ai_requests').get().status, 'processing');
    gate.resolve(); while (true) { const row = await reader.read(); if (row.done) break; text += decoder.decode(row.value); }
    const events = frames(text); assert.ok(events.every(event => event.requestId === ctx.body.requestId));
    assert.equal(events.at(-1).type, 'complete'); assert.equal(events.at(-1).value.status, 'completed');
    assert.deepEqual(events.at(-1).value.dialogue, reply.dialogue);
    const stored = ctx.sqlite.prepare('SELECT result_json FROM ai_requests').get().result_json;
    assert.ok(!stored.includes('未校验文字'));
    const replay = await ctx.call(undefined, { stream: false }); assert.equal((await replay.json()).status, 'completed');
    assert.equal(calls, 1); assert.equal((await ctx.service.status(ctx.db, ctx.env, 'u1')).usage.used, 1);
  } finally { gate.resolve(); ctx.sqlite.close(); }
});
test('streaming preserves stale document rejection after an already visible preview', async () => {
  const gate = deferred(); const started = deferred();
  const ctx = await setup(async ({ onProgress }) => {
    onProgress({ type: 'preview', text: '旧依据预览', round: 0 }); started.resolve(); await gate.promise; return reply;
  });
  try {
    const response = await ctx.call(); await started.promise;
    await ctx.store.putDocument('u1', 'run', 'current', { expectedRevision: 1, mutationId: 'stream-change-0001', value: ctx.saved });
    gate.resolve(); const events = frames(await response.text());
    assert.equal(events.at(-1).value.status, 'failed'); assert.equal(events.at(-1).value.errorCode, 'AI_DOCUMENT_STALE');
    assert.equal(events.at(-1).value.dialogue, undefined);
    assert.ok(!ctx.sqlite.prepare('SELECT result_json FROM ai_requests').get().result_json.includes('旧依据预览'));
  } finally { gate.resolve(); ctx.sqlite.close(); }
});
test('cancellation stops preview callbacks and never publishes the later adapter answer', async () => {
  const started = deferred(); const gate = deferred(); let signal, progress;
  const ctx = await setup(async input => {
    signal = input.signal; progress = input.onProgress;
    progress({ type: 'preview', text: '取消前', round: 0 }); started.resolve(); await gate.promise;
    progress({ type: 'preview', text: '取消后的迟到文字', round: 0 }); return reply;
  });
  try {
    const response = await ctx.call(); await started.promise;
    const cancel = await ctx.call('/api/ai/requests/' + ctx.body.requestId + '/cancel', { stream: false, data: {} });
    assert.equal((await cancel.json()).status, 'cancelled');
    const events = frames(await response.text()); assert.equal(events.at(-1).value.status, 'cancelled');
    assert.equal(signal.aborted, true); gate.resolve();
    assert.ok(!JSON.stringify(events).includes('取消后的迟到文字'));
    assert.equal(ctx.sqlite.prepare('SELECT result_text FROM ai_requests').get().result_text, null);
  } finally { gate.resolve(); await Promise.resolve(); ctx.sqlite.close(); }
});
test('connection cancellation keeps the original request recoverable without a second generation', async () => {
  const gate = deferred(); const finished = deferred(); let calls = 0;
  const ctx = await setup(async ({ onProgress }) => { calls++; onProgress({ type: 'preview', text: '部分文字', round: 0 }); await gate.promise; return reply; });
  try {
    const response = await ctx.call(undefined, { context: { waitUntil: task => task.then(finished.resolve) } });
    const reader = response.body.getReader(); await reader.read(); await reader.cancel(); gate.resolve(); await finished.promise;
    const status = await ctx.call('/api/ai/requests/' + ctx.body.requestId, { method: 'GET' });
    assert.equal((await status.json()).status, 'completed');
    const replay = frames(await (await ctx.call()).text()); assert.equal(replay.at(-1).value.status, 'completed');
    assert.equal(calls, 1);
  } finally { gate.resolve(); ctx.sqlite.close(); }
});
test('streaming has the same owner and document validation and never leaks internal exceptions', async () => {
  let calls = 0; const ctx = await setup(async () => { calls++; throw Error('PRIVATE-EXCEPTION'); });
  try {
    assert.equal((await ctx.call(undefined, { owner: 'u2' })).status, 409);
    const denied = frames(await (await ctx.call(undefined, { user: 'u2' })).text());
    assert.equal(denied.at(-1).error, 'NOT_FOUND'); assert.equal(calls, 0);
    const invalid = frames(await (await ctx.call(undefined, { data: { ...ctx.body, documentRevision: 2 } })).text());
    assert.equal(invalid.at(-1).error, 'AI_DOCUMENT_STALE'); assert.equal(calls, 0);
    const failed = frames(await (await ctx.call()).text());
    assert.equal(failed.at(-1).value.status, 'failed'); assert.equal(failed.at(-1).value.errorCode, 'AI_FAILED');
    assert.ok(!JSON.stringify(failed).includes('PRIVATE-EXCEPTION'));
  } finally { ctx.sqlite.close(); }
});
test('stream observation finishes after generation and logs no preview content', async () => {
  const gate = deferred(); const finished = deferred(); let observed = 0;
  const observation = { wrapDb: db => db, streamHeaders: response => response.headers.set('X-Trace-Id', 'stream-trace'),
    recordAiGeneration() {}, recordAiResult() {}, finish() { observed++; finished.resolve(); } };
  const ctx = await setup(async ({ onProgress }) => { onProgress({ type: 'preview', text: '预览', round: 0 }); await gate.promise; return reply; }, observation);
  try {
    const response = await ctx.call(); assert.equal(response.headers.get('x-trace-id'), 'stream-trace');
    assert.equal(observed, 0); gate.resolve(); await response.text(); await finished.promise; assert.equal(observed, 1);
  } finally { gate.resolve(); ctx.sqlite.close(); }
});
test('preview output is bounded, allowlisted and cannot consume the final frame budget', async () => {
  const { response, task } = dialogueStreamResponse({ requestId: 'bounded-request-01', run: async emit => {
    emit({ type: 'evidence', secret: 'PRIVATE' }); emit({ type: 'phase', phase: 'PRIVATE' });
    for (let i = 0; i < 2000; i++) emit({ type: 'preview', text: (i % 2 ? '字' : '文').repeat(3000), round: 0 });
    emit({ type: 'preview', text: '', round: 1 });
    emit({ type: 'phase', phase: 'validating' });
    return { httpStatus: 200, value: { status: 'completed' } };
  } });
  const text = await response.text(); await task;
  assert.ok(new TextEncoder().encode(text).length < 2 * 1024 * 1024 + 1024);
  assert.ok(!text.includes('PRIVATE')); assert.equal(frames(text).at(-1).type, 'complete');
  assert.deepEqual(frames(text).slice(-3, -1).map(event => [event.type, event.text ?? event.phase]),
    [['preview', ''], ['phase', 'validating']]);
});

test('a 3000-character answer and repaired replacement both stream to their ends within the preview budget', async () => {
  const { response, task } = dialogueStreamResponse({ requestId: 'long-stream-0001', run: async emit => {
    for (const round of [0, 1]) {
      emit({ type: 'preview', text: '', round });
      for (let i = 1; i <= 3000; i++) emit({ type: 'preview', text: '字'.repeat(i), round });
      emit({ type: 'phase', phase: 'validating' });
    }
    return { httpStatus: 200, value: { status: 'completed' } };
  } });
  const text = await response.text(); await task;
  const events = frames(text);
  for (const round of [0, 1]) assert.equal(events.filter(event => event.type === 'preview' && event.round === round).at(-1).text.length, 3000);
  assert.equal(events.filter(event => event.type === 'preview' && event.text).length < 400, true);
  assert.ok(new TextEncoder().encode(text).length < 2 * 1024 * 1024);
});
