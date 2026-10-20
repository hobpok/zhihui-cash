import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, validateMutation } from './contracts.js';
import { createModel } from '../app/model.js';
import { createDefaultInitialTemplate } from '../app/default-scenario.js';

test('personal settings preserve unknown model configuration without claiming validated API', () => {
  const value = { displayName: '用户一', ai: { provider: null, model: null }, preferences: { notes: '优先保留既有逆回购', sortMode: 'auto' } };
  assert.equal(validateDocument('settings', 'profile', value), value);
});
test('ordinary settings reject credential fields, foreign ownership, URLs and unsupported keys', () => {
  for (const value of [{ apiKey: 'fixture' }, { userId: 'other' }, { ai: { baseUrl: 'http://localhost' } },
    { preferences: { access_token: 'fixture' } }, { role: 'admin' }, { ai: { model: 'x'.repeat(121) } }]) {
    assert.throws(() => validateDocument('settings', 'profile', value));
  }
  assert.throws(() => validateDocument('settings', 'another', {}));
});
test('current synthetic template and current model archive pass unchanged', () => {
  const template = createDefaultInitialTemplate();
  assert.equal(validateDocument('template', 'default', template), template);
  const run = JSON.parse(createModel().serialize());
  assert.equal(validateDocument('run', 'current', run), run);
  assert.throws(() => validateDocument('run', 'current', { ...run, uiVersion: 'simulation-ui-1' }));
  assert.throws(() => validateDocument('run', 'current', { ...run, plans: [{ targetYuan: -1 }] }));
});
test('mutations require exact fields, nonnegative revision and bounded idempotency key', () => {
  const body = { expectedRevision: 0, mutationId: 'unique-0001', value: {} };
  assert.equal(validateMutation(body), body);
  for (const bad of [{ ...body, expectedRevision: -1 }, { ...body, mutationId: '' }, { ...body, userId: 'other' }]) assert.throws(() => validateMutation(bad));
  assert.throws(() => validateMutation(body, true));
});
