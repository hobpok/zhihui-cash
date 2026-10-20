import test from 'node:test';
import assert from 'node:assert/strict';
import { canStartNewAiSession, completedAiInput } from './ai-ui.js';

test('new session stays unavailable throughout cancellation even after local send settles', () => {
  assert.equal(canStartNewAiSession({ phase: 'running' }, true, false), false);
  assert.equal(canStartNewAiSession({ phase: 'cancelling' }, false, true), false);
  assert.equal(canStartNewAiSession({ phase: 'cancelling' }, false, false), false);
  assert.equal(canStartNewAiSession({ phase: 'error', recoverable: true }, false, false), true);
});

test('successful response clears only unchanged submitted text, preserving edits made while waiting', () => {
  assert.equal(completedAiInput('原需求', '原需求', 'completed'), '');
  assert.equal(completedAiInput('新补充', '原需求', 'completed'), '新补充');
  assert.equal(completedAiInput('原需求 ', '原需求', 'completed'), '原需求 ');
  assert.equal(completedAiInput('原需求', '原需求', 'error'), '原需求');
  assert.equal(completedAiInput('新补充', null, 'completed'), '新补充');
});
