import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeAiAdapter, normalizeAiOutput } from './ai-adapter.js';
import { resolveAiConfig } from './ai-config.js';

const ready = resolveAiConfig({ AI_ACCOUNT_CONFIG_JSON: JSON.stringify({ user1: { mode: 'mock', provider: 'mock' } }) }, 'user1');
const valid = { text: '连通测试', usage: { inputTokens: 2, outputTokens: 3 } };

test('default mock gives fixed simulated text and never a trade action', async () => {
  const answer = await invokeAiAdapter({ prompt: 'hi', resolved: ready, signal: new AbortController().signal });
  assert.equal(answer.simulated, true);
  assert.match(answer.text, /离线响应检查通过，未调用AI服务/);
  assert.ok(!/下达|成交/.test(answer.text));
});

test('code-level adapter injection accepts bounded text, propagates failure and abort', async () => {
  const injected = { mock: async ({ prompt, config, signal }) => {
    assert.equal(prompt, 'ping'); assert.equal(config.mode, 'mock'); assert.equal(signal.aborted, false); return valid;
  } };
  assert.deepEqual(await invokeAiAdapter({ prompt: 'ping', resolved: ready, signal: new AbortController().signal, adapters: injected }),
    { ...valid, simulated: true });
  await assert.rejects(invokeAiAdapter({ prompt: 'ping', resolved: ready,
    adapters: { mock: async () => { throw Error('provider failed'); } } }), /provider failed/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(invokeAiAdapter({ prompt: 'ping', resolved: ready, signal: aborted.signal, adapters: injected }),
    { code: 'AI_ABORTED' });
});

test('invalid output, HTML and action fields are rejected; real mode cannot invoke', async () => {
  const invalid = [
    { ...valid, toolCalls: [] },
    { ...valid, text: '<script>alert(1)</script>' },
    { ...valid, text: '' },
    { ...valid, text: 'x'.repeat(4001) },
    { ...valid, usage: { inputTokens: -1, outputTokens: 1 } },
    { ...valid, usage: { inputTokens: '1', outputTokens: 1 } },
    { ...valid, usage: { inputTokens: 1, outputTokens: 1, cost: 5 } },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeAiOutput(value), { code: 'AI_OUTPUT_INVALID' });
    await assert.rejects(invokeAiAdapter({ prompt: 'ping', resolved: ready, adapters: { mock: async () => value } }),
      { code: 'AI_OUTPUT_INVALID' });
  }
  const real = resolveAiConfig({ AI_ACCOUNT_CONFIG_JSON: JSON.stringify({
    user1: { mode: 'real', provider: 'vendor', model: 'm', keyBinding: 'AI_KEY_USER1' },
  }), AI_KEY_USER1: 'secret' }, 'user1');
  let called = false;
  await assert.rejects(invokeAiAdapter({ prompt: 'ping', resolved: real,
    adapters: { mock: async () => { called = true; return valid; } } }), { code: 'AI_UNAVAILABLE' });
  assert.equal(called, false);
});

const deepseekReady = resolveAiConfig({ AI_ACCOUNT_CONFIG_JSON: JSON.stringify({ user1: {
  mode: 'real', provider: 'deepseek', model: 'deepseek-flash', keyBinding: 'AI_KEY_USER1',
} }), AI_KEY_USER1: 'private-test-key' }, 'user1');
const providerReply = (overrides = {}) => ({ object: 'chat.completion', choices: [{
  finish_reason: 'stop', message: { role: 'assistant', content: ' 已连通 ' },
}], usage: { prompt_tokens: 7, completion_tokens: 5 }, ...overrides });
const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status ?? 200, headers: init.headers ?? { 'content-type': 'application/json' },
});

test('real DeepSeek request uses fixed endpoint, bounded non-streaming output and a private bearer', async () => {
  let calls = 0;
  const answer = await invokeAiAdapter({ prompt: '连通测试', resolved: deepseekReady,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Authorization, 'Bearer private-test-key');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), { model: 'deepseek-flash', messages: [{ role: 'user', content: '连通测试' }],
        thinking: { type: 'disabled' }, stream: false, max_tokens: 1024 });
      return jsonResponse(providerReply());
    } });
  assert.equal(calls, 1);
  assert.deepEqual(answer, { text: '已连通', usage: { inputTokens: 7, outputTokens: 5 }, simulated: false });
});

test('DeepSeek rejects redirects, non-200 errors and malformed or oversized responses without leaking provider text', async () => {
  const cases = [
    [new Response('secret in error body', { status: 401 }), 'AI_PROVIDER_ERROR'],
    [new Response(null, { status: 302, headers: { location: 'https://other.example/' } }), 'AI_PROVIDER_ERROR'],
    [jsonResponse(providerReply({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'cut off' } }] })), 'AI_PROVIDER_INVALID'],
    [jsonResponse(providerReply({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{}] } }] })), 'AI_PROVIDER_INVALID'],
    [jsonResponse(providerReply({ usage: { prompt_tokens: -1, completion_tokens: 5 } })), 'AI_OUTPUT_INVALID'],
    [new Response('x'.repeat(65537)), 'AI_PROVIDER_INVALID'],
    [new Response('{}', { headers: { 'content-length': '65537' } }), 'AI_PROVIDER_INVALID'],
    [new Response('not json with secret'), 'AI_PROVIDER_INVALID'],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(invokeAiAdapter({ prompt: 'ping', resolved: deepseekReady,
      fetchImpl: async () => response }), error => error.code === code && !error.message.includes('secret'));
  }
});

test('DeepSeek reports aborts and network errors with safe codes', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(invokeAiAdapter({ prompt: 'ping', resolved: deepseekReady, signal: controller.signal,
    fetchImpl: async () => { called = true; return jsonResponse(providerReply()); } }), { code: 'AI_ABORTED' });
  assert.equal(called, false);
  await assert.rejects(invokeAiAdapter({ prompt: 'ping', resolved: deepseekReady,
    fetchImpl: async () => { throw new Error('private test secret'); } }),
  error => error.code === 'AI_PROVIDER_UNAVAILABLE' && !error.message.includes('secret'));
  const during = new AbortController();
  await assert.rejects(invokeAiAdapter({ prompt: 'ping', resolved: deepseekReady, signal: during.signal,
    fetchImpl: async () => { during.abort(); throw new Error('private test secret'); } }), { code: 'AI_ABORTED' });
});
