import assert from 'node:assert/strict';
import test from 'node:test';
import { publicAiStatus, resolveAiConfig } from './ai-config.js';

const env = accounts => ({ AI_ACCOUNT_CONFIG_JSON: JSON.stringify(accounts) });

test('five stable member IDs resolve independently and public state has no key material', () => {
  const accounts = {
    user1: { mode: 'mock', provider: 'mock' },
    user2: { mode: 'real', provider: 'vendor', model: 'm1', keyBinding: 'AI_KEY_USER2' },
    user3: { mode: 'disabled' },
    user4: { mode: 'mock', provider: 'mock', dailyLimit: 7, timeoutMs: 2000 },
    user5: { mode: 'disabled' },
  };
  const base = env(accounts);
  base.AI_KEY_USER2 = 'test-secret-do-not-echo';
  assert.equal(resolveAiConfig(base, 'user1').state, 'mock_ready');
  assert.equal(resolveAiConfig(base, 'user2').state, 'provider_unsupported');
  assert.equal(resolveAiConfig(base, 'user3').state, 'disabled');
  assert.equal(resolveAiConfig(base, 'user4').config.dailyLimit, 7);
  assert.equal(resolveAiConfig(base, 'user5').state, 'disabled');
  assert.equal(resolveAiConfig(base, 'unknown').state, 'unconfigured');
  const resolved = resolveAiConfig(base, 'user2');
  assert.equal(resolved.credential, base.AI_KEY_USER2);
  assert.deepEqual(publicAiStatus(resolved), {
    state: 'provider_unsupported', mode: 'real', provider: 'vendor', model: 'm1', dailyLimit: 30, timeoutMs: 10000,
  });
  assert.ok(!JSON.stringify(resolved).includes(base.AI_KEY_USER2));
  assert.ok(!JSON.stringify(publicAiStatus(resolved)).includes('AI_KEY_USER2'));
  assert.ok(!JSON.stringify(publicAiStatus(resolved)).includes(base.AI_KEY_USER2));
  assert.equal(resolveAiConfig({ ...base, AI_KEY_USER2: undefined }, 'user2').state, 'credential_missing');
});

test('missing, invalid, and out-of-range configuration never silently becomes mock', () => {
  assert.equal(resolveAiConfig({}, 'user1').state, 'unconfigured');
  assert.equal(resolveAiConfig({ AI_ACCOUNT_CONFIG_JSON: '{' }, 'user1').state, 'config_invalid');
  const bad = [
    { mode: 'mock' },
    { mode: 'mock', provider: 'mock', keyBinding: 'AI_KEY_USER1' },
    { mode: 'mock', provider: 'mock', dailyLimit: 0 },
    { mode: 'mock', provider: 'mock', dailyLimit: 'unlimited' },
    { mode: 'mock', provider: 'mock', dailyLimit: 1001 },
    { mode: 'mock', provider: 'mock', timeoutMs: 999 },
    { mode: 'mock', provider: 'mock', timeoutMs: 90001 },
    { mode: 'real', provider: 'vendor', model: 'm', keyBinding: 'SECRET' },
    { mode: 'real', provider: 'vendor', model: 'm' },
    { mode: 'mock', provider: 'mock', apiKey: 'inline-secret' },
    { mode: 'disabled', keyBinding: 'AI_KEY_USER1' },
  ];
  for (const item of bad) assert.equal(resolveAiConfig(env({ user1: item }), 'user1').state, 'config_invalid');
  assert.equal(resolveAiConfig(env({ user1: { mode:'mock', provider:'mock', timeoutMs:90000 } }), 'user1').config.timeoutMs, 90000);
  assert.equal(resolveAiConfig(env({ user1: { mode: 'mock', provider: 'mock' } }), 'user1').state, 'mock_ready');
  assert.equal(resolveAiConfig(env({ user1: { mode: 'real', provider: 'vendor', model: 'm', keyBinding: 'AI_KEY_USER1' } }), 'user1').state, 'credential_missing');
});

test('explicit null removes the daily cap while omitted and numeric limits keep their meaning', () => {
  const unlimited = resolveAiConfig(env({ user1: { mode: 'mock', provider: 'mock', dailyLimit: null } }), 'user1');
  assert.equal(unlimited.state, 'mock_ready');
  assert.equal(unlimited.config.dailyLimit, null);
  assert.equal(publicAiStatus(unlimited).dailyLimit, null);
  assert.equal(resolveAiConfig(env({ user1: { mode: 'mock', provider: 'mock' } }), 'user1').config.dailyLimit, 30);
  assert.equal(resolveAiConfig(env({ user1: { mode: 'mock', provider: 'mock', dailyLimit: 7 } }), 'user1').config.dailyLimit, 7);
});

test('DeepSeek ready state accepts only current models and keeps credential private', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const source = env({ user1: { mode: 'real', provider: 'deepseek', model, keyBinding: 'AI_KEY_USER1' } });
    source.AI_KEY_USER1 = 'test-key-private';
    const resolved = resolveAiConfig(source, 'user1');
    assert.equal(resolved.state, 'real_ready');
    assert.equal(resolved.credential, source.AI_KEY_USER1);
    assert.equal(Object.keys(resolved).includes('credential'), false);
    assert.equal(JSON.stringify(resolved).includes(source.AI_KEY_USER1), false);
    assert.equal(publicAiStatus(resolved).state, 'real_ready');
    assert.equal(JSON.stringify(publicAiStatus(resolved)).includes('AI_KEY_USER1'), false);
  }
  const real = (model, key) => ({ ...env({ user1: {
    mode: 'real', provider: 'deepseek', model, keyBinding: 'AI_KEY_USER1',
  } }), AI_KEY_USER1: key });
  assert.equal(resolveAiConfig(real('deepseek-chat', 'test-key'), 'user1').state, 'config_invalid');
  assert.equal(resolveAiConfig(real('deepseek-flash', ''), 'user1').state, 'credential_missing');
  assert.equal(resolveAiConfig(real('deepseek-flash', 'bad\r\nInjected: true'), 'user1').state, 'config_invalid');
});
