import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiProxy, AI_PROBE_TEXT } from './ai-proxy.js';

const config = { status: 'mock_ready', simulated: true, provider: 'mock', model: 'mock-v1',
  limits: { dailyRequests: 30, timeoutMs: 10000, maxPromptChars: 2000 }, usage: { day: '2026-10-05', used: 0, remaining: 30 }, activeRequestId: null };
const ok = body => Response.json(body);
const result = { requestId: 'request-id-01', status: 'completed', simulated: true, text: '模拟连通测试，无真实AI。' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function ready(fetchImpl, options = {}) {
  const proxy = createAiProxy({ fetchImpl, makeId: () => 'request-id-01', ...options });
  proxy.setUser('u1'); await proxy.refresh(); return proxy;
}

test('probe sends fixed text and account context without saved state or model selection', async () => {
  const requests = [];
  const proxy = await ready(async (path, init) => {
    if (path.endsWith('/status')) return ok(config);
    requests.push({ path, init }); return ok(result);
  });
  await proxy.run();
  assert.equal(proxy.snapshot().phase, 'completed');
  assert.deepEqual(JSON.parse(requests[0].init.body), { requestId: 'request-id-01', prompt: AI_PROBE_TEXT });
  assert.equal(requests[0].init.headers['X-Workspace-User'], 'u1');
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.deepEqual(proxy.snapshot().result, { text: result.text, simulated: true });
});

test('double click makes one request; confirmed cancellation discards even an uncooperative late result', async () => {
  const wait = deferred(); let calls = 0;
  const proxy = await ready(async path => {
    if (path.endsWith('/status')) return ok(config);
    if (path.endsWith('/cancel')) return ok({ requestId: 'request-id-01', status: 'cancelled' });
    calls++; return wait.promise;
  });
  const pending = proxy.run(); await proxy.run(); assert.equal(calls, 1);
  await proxy.cancel(); assert.equal(proxy.snapshot().phase, 'cancelled');
  wait.resolve(ok(result)); await pending;
  assert.equal(proxy.snapshot().phase, 'cancelled'); assert.equal(proxy.snapshot().result, null);
});

test('failed cancellation never claims the request was stopped', async () => {
  const wait = deferred();
  const proxy = await ready(async path => {
    if (path.endsWith('/status')) return ok(config);
    if (path.endsWith('/cancel')) throw new TypeError('offline');
    return wait.promise;
  });
  const pending = proxy.run(); await proxy.cancel();
  assert.equal(proxy.snapshot().phase, 'running'); assert.match(proxy.snapshot().cancelError, /取消尚未确认/);
  wait.resolve(ok(result)); await pending;
  assert.equal(proxy.snapshot().phase, 'completed');
});

test('account change drops former result and cancels using former owner header', async () => {
  const wait = deferred(); const cancelled = [];
  const proxy = await ready(async (path, init) => {
    if (path.endsWith('/status')) return ok(config);
    if (path.endsWith('/cancel')) { cancelled.push(init.headers['X-Workspace-User']); return ok({ requestId: 'request-id-01', status: 'cancelled' }); }
    return wait.promise;
  });
  const pending = proxy.run(); proxy.setUser('u2');
  wait.resolve(ok(result)); await pending;
  assert.equal(proxy.snapshot().userId, 'u2'); assert.equal(proxy.snapshot().result, null);
  assert.equal(proxy.snapshot().phase, 'idle'); assert.deepEqual(cancelled, ['u1']);
});

test('unconfigured service cannot start; quota error shows safe text and never retries', async () => {
  let readyConfig = false, calls = 0;
  const proxy = await ready(async path => {
    if (path.endsWith('/status')) return ok({ ...config, status: readyConfig ? 'mock_ready' : 'unconfigured' });
    calls++; return Response.json({ error: 'AI_DAILY_LIMIT', detail: 'must-not-show' }, { status: 429 });
  });
  await proxy.run(); assert.equal(calls, 0);
  readyConfig = true; await proxy.refresh(); await proxy.run();
  assert.equal(calls, 1); assert.equal(proxy.snapshot().phase, 'error');
  assert.match(proxy.snapshot().error, /次数已用完/); assert.doesNotMatch(JSON.stringify(proxy.snapshot()), /must-not-show/);
});

test('unexpected real or malformed results are not displayed as a successful mock', async () => {
  const proxy = await ready(async path => path.endsWith('/status') ? ok(config) : ok({ ...result, simulated: false, text: '<img onerror=attack()>' }));
  await proxy.run(); assert.equal(proxy.snapshot().phase, 'error'); assert.equal(proxy.snapshot().result, null);
});

test('real-ready probe sends only fixed text and accepts a real result', async () => {
  const realConfig = { ...config, status: 'real_ready', simulated: false, provider: 'deepseek', model: 'deepseek-chat' };
  const requests = [];
  const proxy = await ready(async (path, init) => {
    if (path.endsWith('/status')) return ok(realConfig);
    requests.push({ path, init });
    return ok({ ...result, simulated: false, text: '连接测试成功' });
  });
  await proxy.run();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), { requestId: 'request-id-01', prompt: AI_PROBE_TEXT });
  assert.deepEqual(proxy.snapshot().result, { text: '连接测试成功', simulated: false });
});

test('result type is checked against mode captured when request starts', async () => {
  let currentConfig = { ...config, status: 'real_ready', simulated: false };
  const wait = deferred();
  const proxy = await ready(async path => path.endsWith('/status') ? ok(currentConfig) : wait.promise);
  const pending = proxy.run();
  assert.equal(proxy.snapshot().requestMode, 'real_ready');
  currentConfig = config;
  await proxy.refresh();
  wait.resolve(ok(result));
  await pending;
  assert.equal(proxy.snapshot().phase, 'error');
  assert.equal(proxy.snapshot().result, null);
});

test('mock result cannot be mislabeled as real', async () => {
  const proxy = await ready(async path => path.endsWith('/status') ?
    ok({ ...config, status: 'real_ready', simulated: false }) : ok(result));
  await proxy.run();
  assert.equal(proxy.snapshot().phase, 'error');
  assert.equal(proxy.snapshot().result, null);
});

test('authentication failure notifies workspace and never falls back to anonymous AI', async () => {
  let rejected = 0;
  const proxy = createAiProxy({ fetchImpl: async () => Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 }), onAuthError: () => rejected++ });
  proxy.setUser('u1'); await proxy.refresh();
  assert.equal(rejected, 1); assert.equal(proxy.snapshot().config, null); assert.match(proxy.snapshot().error, /重新登录/);
});

test('server timeout is distinguished from invalid output without retrying the charged attempt', async () => {
  let calls = 0;
  const proxy = await ready(async path => {
    if (path.endsWith('/status')) return ok(config);
    calls++; return ok({ requestId: 'request-id-01', status: 'timed_out', simulated: true, errorCode: 'AI_TIMEOUT' });
  });
  await proxy.run(); assert.equal(calls, 1); assert.equal(proxy.snapshot().phase, 'error');
  assert.match(proxy.snapshot().error, /请求超时/); assert.equal(proxy.snapshot().result, null);
});
