import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel,validateSaved} from './model.js';
import {baseTemplate,plan,YI} from '../scripts/robustness-scenarios.mjs';

function prepared({approve=true}={}) {
  const template=baseTemplate({id:'BATCH-COMMIT-FACTS',cash:10,gov:5});
  template.draftPlans=[1,2,3].map(i=>plan(`独立逆回购${i}`,'reverse_repo',1));
  const model=createModel();model.startFromTemplate(template);model.generateProposal();
  if(approve)model.approveProposal();
  return model;
}
function validView(model,result) {
  assert.equal(validateSaved(model.serialize()).ok,true);
  assert.deepEqual(result.summary,model.getState().summary);
  assert.deepEqual(result.batchReadiness,model.getState().batchReadiness);
  assert.deepEqual(result.dispatchGroups,model.getState().dispatchGroups);
}

for(const custom of [false,true]) for(const receiptMode of ['accepted','unknown','rejected']) {
  test(`${custom?'custom skip-review':'reviewed'} batch commits each send and receipt before returning its full view: ${receiptMode}`,()=>{
    const model=prepared({approve:!custom}),before=model.getState();
    const steps=before.proposal.steps;
    const result=custom?model.sendCustomBatch(steps.map(s=>({stepId:s.stepId,nominalYuan:s.nominalYuan})),
      {skipReview:true,receiptMode}):model.sendBatch(steps.map(s=>s.stepId),{receiptMode});
    const expected=receiptMode==='accepted'?['accepted','accepted','accepted']:
      ['accepted',receiptMode,'not_sent'];
    assert.deepEqual(result.results.map(r=>r.status),expected);
    const factCommits=receiptMode==='accepted'?6:receiptMode==='unknown'?3:4;
    assert.equal(result.revision-before.revision,factCommits+(custom?1:0));
    assert.equal(result.execution.journal.length,factCommits);
    assert.equal(result.execution.sourceSequence,receiptMode==='accepted'?3:receiptMode==='unknown'?1:2);
    assert.equal(Object.keys(result.execution.fills).length,0);
    assert.equal(Object.keys(result.execution.cashFlows).length,0);
    assert.deepEqual(result.summary.planBalances.map(r=>r.lockedYuan),
      receiptMode==='accepted'?[YI,YI,YI]:receiptMode==='unknown'?[YI,YI,0]:[YI,0,0]);
    validView(model,result);
  });
}

test('batch fill keeps completed facts when the second instruction fails and duplicate receipt adds no revision',()=>{
  const model=prepared();
  const sent=model.sendBatch(),ids=sent.results.map(r=>r.instructionId);
  model.simulateEvent('fill',{instructionId:ids[1],nominalYuan:YI});
  const before=model.getState();
  const result=model.processExecutionBatch(ids,'fill');
  assert.deepEqual(result.results.map(r=>r.status),['filled','blocked','not_processed']);
  assert.equal(result.revision,before.revision+1);
  assert.equal(result.execution.journal.length,before.execution.journal.length+1);
  assert.deepEqual(ids.map(id=>result.execution.instructions[id].filledYuan),[YI,YI,0]);
  const serialized=model.serialize();
  const duplicate=model.recordEvent(result.execution.journal.at(-1).event);
  assert.equal(duplicate.eventResult,'duplicate');
  assert.equal(model.serialize(),serialized);
  validView(model,result);
});

test('batch settlement commits each completed payment and stops before an unfilled instruction',()=>{
  const model=prepared(),sent=model.sendBatch(),ids=sent.results.map(r=>r.instructionId);
  model.processExecutionBatch(ids.slice(0,2),'fill');
  const before=model.getState();
  const result=model.processExecutionBatch(ids,'settle');
  assert.deepEqual(result.results.map(r=>r.status),['settled','settled','blocked']);
  assert.equal(result.revision,before.revision+2);
  assert.equal(result.execution.journal.length,before.execution.journal.length+2);
  assert.deepEqual(ids.map(id=>result.execution.instructions[id].settledYuan),[YI,YI,0]);
  assert.equal(result.summary.accountCashYuan,before.summary.accountCashYuan-2*YI);
  validView(model,result);
});
