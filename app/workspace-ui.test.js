import assert from 'node:assert/strict';
import test from 'node:test';
import { aiProbeQuota } from './workspace-ui.js';

test('AI connection panel presents unlimited usage and keeps testing available', () => {
  assert.deepEqual(aiProbeQuota({ limits: { dailyRequests: null }, usage: { used: 35, remaining: null } }),
    { text: '今日已受理 35 次；每日次数不限。', available: true });
  assert.deepEqual(aiProbeQuota({ limits: { dailyRequests: 30 }, usage: { used: 30, remaining: 0 } }),
    { text: '今日已受理 30 / 30 次，剩余 0 次；每日按UTC重置。', available: false });
  assert.deepEqual(aiProbeQuota({ limits: { dailyRequests: 30 }, usage: { used: 2, remaining: 28 } }),
    { text: '今日已受理 2 / 30 次，剩余 28 次；每日按UTC重置。', available: true });
});
