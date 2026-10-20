import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, validateSaved } from './model.js';

const yi = 100000000;
const s10 = () => {
  const model = createModel();
  model.reset('S10');
  model.generateProposal();
  return model;
};

test('custom partial dispatch reserves only the selected amount and preserves the full target', () => {
  const m = s10();
  assert.equal(m.previewDispatchBatch([{stepId:'I-A',nominalYuan:yi}],{skipReview:true}).ready,true);
  const sent = m.sendCustomBatch([{stepId:'I-A',nominalYuan:yi}],{skipReview:true});
  const balance = sent.summary.planBalances.find(b => b.planId === 'P10');
  assert.deepEqual([balance.targetYuan,balance.filledYuan,balance.lockedYuan,balance.arrangeableYuan],
    [10*yi,0,yi,9*yi]);
  assert.equal(sent.execution.instructions[sent.results[0].instructionId].nominalYuan,yi);
  assert.equal(sent.execution.instructions[sent.results[0].instructionId].authoritySource,
    'calculated_skip_review');
  assert.equal(sent.approval.authoritySource,'calculated_skip_review');
  assert.equal(validateSaved(m.serialize()).ok,true);
  assert.throws(() => m.send('I-B'),/审核/);
  assert.equal(m.previewDispatchBatch([{stepId:'I-A',nominalYuan:yi}],{skipReview:true}).ready,false);
  m.generateProposal();
  assert.ok(m.getState().proposal.steps.some(step => step.nominalYuan <= 9*yi));
  assert.equal(m.getState().execution.journal.find(row => row.kind === 'send').instruction.authoritySource,
    'calculated_skip_review');
});

test('custom batch rejects duplicate, excess, invalid unit, and unknown amount without mutating state', () => {
  const m = s10();
  const before = m.serialize();
  assert.throws(() => m.previewDispatchBatch([{stepId:'I-A',nominalYuan:yi},
    {stepId:'I-A',nominalYuan:yi}],{skipReview:true}),/唯一/);
  assert.throws(() => m.previewDispatchBatch([{stepId:'I-A',nominalYuan:null}],{skipReview:true}),/正整数/);
  assert.equal(m.previewDispatchBatch([{stepId:'I-A',nominalYuan:4*yi}],{skipReview:true}).ready,false);
  assert.match(m.previewDispatchBatch([{stepId:'I-A',nominalYuan:yi+1}],{skipReview:true}).reason,/业务单位/);
  assert.throws(() => m.sendCustomBatch([{stepId:'I-A',nominalYuan:4*yi}],{skipReview:true}),/阻断|可安排/);
  assert.equal(m.serialize(),before);
});

test('selected order is checked against cumulative reserved cash, with no simulated fill or cash receipt', () => {
  const m = createModel(); m.reset('S10'); m.deletePlan('P10');
  const a = m.addPlan({label:'A',businessType:'reverse_repo',direction:'outflow',targetYuan:2*yi}).plans.at(-1);
  const b = m.addPlan({label:'B',businessType:'reverse_repo',direction:'outflow',targetYuan:2*yi}).plans.at(-1);
  m.generateProposal();
  const stepA = m.getState().proposal.steps.find(step => step.planId === a.planId);
  const stepB = m.getState().proposal.steps.find(step => step.planId === b.planId);
  const items = [{stepId:stepB.stepId,nominalYuan:2*yi},{stepId:stepA.stepId,nominalYuan:2*yi}];
  const preview = m.previewDispatchBatch(items,{skipReview:true});
  assert.deepEqual(preview.rows.map(row => [row.stepId,row.ready]),[[stepB.stepId,true],[stepA.stepId,false]]);
  assert.equal(preview.ready,false);
  assert.throws(() => m.sendCustomBatch(items,{skipReview:true}),/资金/);
  assert.equal(Object.keys(m.getState().execution.instructions).length,0);
  const result = m.sendCustomBatch([items[0]],{skipReview:true});
  assert.equal(result.results[0].status,'accepted');
  assert.equal(result.summary.planBalances.find(x => x.planId === b.planId).filledYuan,0);
  assert.equal(Object.keys(result.execution.cashFlows).length,0);
});

test('manual route needs human review; skip route still obeys unknown receipt and saved authority source', () => {
  const m = s10();
  const first = [{stepId:'I-A',nominalYuan:yi}];
  assert.throws(() => m.sendCustomBatch(first),/审核/);
  m.approveProposal();
  assert.equal(m.previewDispatchBatch(first).ready,true);
  const sent = m.sendCustomBatch(first,{receiptMode:'unknown'});
  assert.equal(sent.results[0].status,'unknown');
  assert.equal(sent.approval.authoritySource,undefined);
  assert.equal(sent.summary.planBalances.find(b => b.planId === 'P10').lockedYuan,yi);
  assert.equal(m.previewDispatchBatch([{stepId:'I-B',nominalYuan:yi}],{skipReview:true}).ready,false);
  assert.equal(validateSaved(m.serialize()).ok,true);
});

test('rejected local receipt releases the reservation without inventing a fill', () => {
  const m = s10();
  const result = m.sendCustomBatch([{stepId:'I-A',nominalYuan:yi}],
    {skipReview:true,receiptMode:'rejected'});
  assert.equal(result.results[0].status,'rejected');
  const balance = result.summary.planBalances.find(b => b.planId === 'P10');
  assert.deepEqual([balance.filledYuan,balance.lockedYuan,balance.arrangeableYuan],[0,0,10*yi]);
  assert.equal(validateSaved(m.serialize()).ok,true);
});

test('a later actual fill updates the filled slice while keeping the unsent target', () => {
  const m = s10();
  const sent = m.sendCustomBatch([{stepId:'I-A',nominalYuan:2*yi}],{skipReview:true});
  const instructionId = sent.results[0].instructionId;
  m.simulateEvent('fill',{instructionId,nominalYuan:yi});
  const balance = m.getState().summary.planBalances.find(b => b.planId === 'P10');
  assert.deepEqual([balance.targetYuan,balance.filledYuan,balance.lockedYuan,balance.arrangeableYuan],
    [10*yi,yi,yi,8*yi]);
  assert.equal(validateSaved(m.serialize()).ok,true);
});

test('skip review cannot refresh stale, expired, or restored execution facts implicitly', () => {
  const item = [{stepId:'I-A',nominalYuan:yi}];
  const stale = s10();
  stale.markSnapshotStale();
  assert.throws(() => stale.previewDispatchBatch(item,{skipReview:true}),/快照过期/);
  assert.throws(() => stale.sendCustomBatch(item,{skipReview:true}),/快照过期/);
  assert.equal(stale.getState().approval,null);
  stale.refreshSnapshot();
  assert.equal(stale.previewDispatchBatch(item,{skipReview:true}).ready,true);

  const expired = s10();
  const now = Date.now;
  try {
    Date.now = () => now() + 31000;
    assert.throws(() => expired.previewDispatchBatch(item,{skipReview:true}),/快照过期/);
    assert.throws(() => expired.sendCustomBatch(item,{skipReview:true}),/快照过期/);
  } finally { Date.now = now; }
  assert.equal(expired.getState().approval,null);

  const restored = createModel(s10().serialize());
  restored.generateProposal();
  assert.throws(() => restored.previewDispatchBatch(item,{skipReview:true}),/快照过期/);
  assert.throws(() => restored.sendCustomBatch(item,{skipReview:true}),/快照过期/);
  restored.refreshSnapshot();
  assert.equal(restored.previewDispatchBatch(item,{skipReview:true}).ready,true);
});
