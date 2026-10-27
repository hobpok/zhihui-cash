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
import { instructionChanges, instructionConfirmLabel, executionConditionText } from './ai-ui.js';

const names = {
  record: id => id === 'existing' ? { targetYuan: 10e8, businessType: 'interbank_repo_financing', repoTerms: {tenorDays: 1} } : undefined,
  plan: id => id === 'existing' ? '银行间正回购10亿1天' : '相关计划',
  asset: () => '广州银行存单', security: () => ({remainingTradingDays: 90}),
};
test('confirmation lists every actual addition including corrective sale with amount and tenor', () => {
  const projected = {deltas: [
    {kind:'add',businessType:'cd_sell',securityId:'CD-GZ',targetYuan:2e8,tenorDays:null},
    {kind:'add',businessType:'interbank_repo_financing',targetYuan:34e8,tenorDays:1},
  ]};
  const rows=instructionChanges(projected,names);
  assert.deepEqual(rows.map(x=>x.kind),['add','add']);
  assert.match(rows[0].text,/卖出存单.*广州银行存单.*2 亿元.*剩余90天/);
  assert.match(rows[1].text,/正回购.*34 亿元.*1天/);
  assert.equal(instructionConfirmLabel(projected),'确认新增以上2笔指令');
  const local={deltas:[{kind:'add',plan:{businessType:'cd_sell',securityId:'CD-GZ',targetYuan:2e8}},
    {kind:'add',plan:{businessType:'interbank_repo_financing',targetYuan:34e8,repoTerms:{tenorDays:1}}}]};
  assert.deepEqual(instructionChanges(local,names),rows);
});
test('existing modifications and deletions are distinct from additions',()=>{
  const rows=instructionChanges({deltas:[{kind:'update',planId:'existing',targetYuan:12e8},{kind:'delete',planId:'existing'}]},names);
  assert.match(rows[0].text,/10 亿元 → 12 亿元.*1天/);
  assert.equal(rows[1].kind,'delete');
  assert.match(rows[1].text,/10 亿元.*1天/);
  assert.equal(instructionConfirmLabel({deltas:[{kind:'update'}]}),'确认以上指令变更');
});
test('path conditions replace exact plan IDs and yuan amounts without rounding or altering dates and ratios',()=>{
  const candidate={executionPath:[{planId:'DRAFT-abc-123-P-1',planLabel:'广州银行存单卖出2亿90天'}]};
  const value=executionConditionText('DRAFT-abc-123-P-1须成交200000000元，差额1元，头寸-500000000元；2026-10-27、5%、20亿元',candidate,names);
  assert.equal(value,'广州银行存单卖出2亿90天须成交2 亿元，差额0.00000001 亿元，头寸−5 亿元；2026-10-27、5%、20亿元');
});
