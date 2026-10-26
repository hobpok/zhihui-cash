import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel,validateSaved,deriveExecutionOrderDependencies,executionFillReadiness} from './model.js';
import {evaluateSelectedSequence} from './engine.js';
import {newExecution,registerSend,registerCancel,applyEvent,validateExecution} from './execution.js';
import {baseTemplate,plan,YI} from '../scripts/robustness-scenarios.mjs';

const start=t=>{const m=createModel();m.startFromTemplate(t);return m;};
function depositTemplate({cash=10,gov=5,other=0,cd=false,sale=false}={}) {
  const t=baseTemplate({id:'DEPOSIT-ATOMIC',cash,gov,holdings:sale?[{securityId:'CD-B',amount:2}]:[]});
  t.otherFundBankExposure.find(x=>x.bankId==='BANK-B').depositYuan=other*YI;
  t.draftPlans=[...(sale?[plan('先卖B存单2亿','cd_sell',2,'CD-B')]:[]),
    plan('整笔B存款2亿','deposit',2,'DEP-B'),...(cd?[plan('后买B存单1亿','cd_buy',1,'CD-B')]:[])];
  return t;
}
const event=(sequence,type,instructionId,fields={})=>({eventId:`ATOMIC-E-${sequence}`,
  sourceSequence:sequence,type,instructionId,...fields});
const pending=(execution,id)=>execution.instructions[id].nominalYuan-
  execution.instructions[id].filledYuan-execution.instructions[id].cancelledYuan;
const accept=(execution,id)=>applyEvent(execution,event(execution.sourceSequence+1,'accepted',id)).execution;

test('deposit is never split by cash capacity, rule headroom or single-plan split search',()=>{
  for(const template of [depositTemplate({cash:1,gov:5}),depositTemplate({other:59})]) {
    const model=start(template),state=model.generateProposal();
    assert.ok(state.proposal.steps.every(step=>step.nominalYuan===2*YI));
    assert.equal(state.proposal.planCoverage[0].suggestedYuan,0);
    assert.equal(state.proposal.unarrangedYuan,2*YI);
    assert.equal(state.calculation.candidates.some(row=>row.candidateId==='0-SPLIT'),false);
  }
});

test('engine, custom recalculation, preview and send reject partial deposits without mutating facts',()=>{
  const model=start(depositTemplate());
  const state=model.generateProposal(),step=state.proposal.steps[0],plan=state.plans[0];
  const partial=[{stepId:step.stepId,nominalYuan:YI}];
  assert.equal(evaluateSelectedSequence(state,[{planId:plan.planId,nominalYuan:YI}]).status,'blocked_sequence');
  const before=model.serialize();
  assert.throws(()=>model.recalculateDispatchBatch([{planId:plan.planId,nominalYuan:YI}]),/存款不可拆分/);
  const preview=model.previewDispatchBatch(partial,{skipReview:true});
  assert.equal(preview.ready,false);assert.match(preview.reason,/存款不可拆分/);
  assert.throws(()=>model.sendCustomBatch(partial,{skipReview:true}),/存款不可拆分/);
  assert.equal(model.serialize(),before);
  assert.throws(()=>registerSend(newExecution(10*YI),{stepId:'X',nominalYuan:YI},plan,'AP'),/存款不可拆分/);
});

test('new deposit fills and cancels are whole-ticket operations and failures leave execution unchanged',()=>{
  const p={planId:'ATOMIC-P',businessType:'deposit',direction:'outflow',targetYuan:2*YI};
  const sent=registerSend(newExecution(10*YI),{stepId:'X',nominalYuan:2*YI},p,'AP');
  let execution=accept(sent.execution,sent.instructionId);
  assert.throws(()=>applyEvent(execution,event(2,'fill',sent.instructionId,
    {nominalYuan:YI,fillId:'PARTIAL'})),/存款不可拆分/);
  assert.equal(execution.instructions[sent.instructionId].filledYuan,0);
  const cancel=registerCancel(execution,sent.instructionId);execution=cancel.execution;
  const fields={cancelRequestId:cancel.cancelRequestId,cancelSliceId:'C',reservationId:sent.instructionId,
    nominalConfirmed:true,releaseConfirmed:true};
  assert.throws(()=>applyEvent(execution,event(2,'cancel_confirmed',sent.instructionId,
    {...fields,nominalYuan:YI,releaseYuan:YI})),/存款不可拆分/);
  execution=applyEvent(execution,event(2,'cancel_confirmed',sent.instructionId,
    {...fields,nominalYuan:2*YI,releaseYuan:2*YI})).execution;
  assert.equal(pending(execution,sent.instructionId),0);
  const resent=registerSend(execution,{stepId:'Y',nominalYuan:2*YI},p,'AP2');
  execution=accept(resent.execution,resent.instructionId);
  execution=applyEvent(execution,event(execution.sourceSequence+1,'fill',resent.instructionId,
    {nominalYuan:2*YI,fillId:'WHOLE'})).execution;
  assert.equal(validateExecution(execution,[p]),true);
});

test('model rejects partial simulated fills and batch fills one whole deposit',()=>{
  const model=start(depositTemplate());model.generateProposal();model.approveProposal();
  const sent=model.sendBatch(),id=sent.results[0].instructionId,before=model.serialize();
  assert.throws(()=>model.simulateEvent('fill',{instructionId:id,nominalYuan:YI}),/存款不可拆分/);
  assert.equal(model.serialize(),before);
  assert.equal(model.processExecutionBatch([id],'fill').results[0].amountYuan,2*YI);
  assert.equal(validateSaved(model.serialize()).ok,true);
});

test('sent deposits and CDs retain fill order; cancelling an instruction does not discard its remaining deposit goal',()=>{
  const model=start(depositTemplate({other:58,cd:true}));model.generateProposal();model.approveProposal();
  const sent=model.sendBatch();assert.deepEqual(sent.results.map(row=>row.status),['accepted','accepted']);
  const depositId=sent.results.find(row=>sent.execution.instructions[row.instructionId].businessType==='deposit').instructionId;
  const cdId=sent.results.find(row=>sent.execution.instructions[row.instructionId].businessType==='cd_buy').instructionId;
  const deps=deriveExecutionOrderDependencies(sent,cdId);
  assert.ok(deps.some(row=>row.planId===sent.execution.instructions[depositId].planId &&
    row.minimumYuan===2*YI && row.actualYuan===0 && !row.ready));
  const before=model.serialize();
  assert.throws(()=>model.simulateEvent('fill',{instructionId:cdId,nominalYuan:YI}),/先整笔存款成交/);
  assert.equal(model.serialize(),before);
  assert.equal(model.processExecutionBatch([cdId,depositId],'fill').results[0].status,'blocked');
  assert.equal(model.processExecutionBatch([depositId],'fill').results[0].status,'filled');
  assert.ok(deriveExecutionOrderDependencies(model.getState(),cdId).some(row=>row.planId===
    sent.execution.instructions[depositId].planId && row.ready && row.actualYuan===2*YI));
  assert.equal(model.processExecutionBatch([cdId],'fill').results[0].status,'filled');
  assert.equal(validateSaved(model.serialize()).ok,true);

  const cancelled=start(depositTemplate({other:58,cd:true}));cancelled.generateProposal();cancelled.approveProposal();
  const c=cancelled.sendBatch(),d=c.results[0].instructionId,b=c.results[1].instructionId;
  const request=cancelled.requestCancel(d);
  cancelled.simulateEvent('cancel_confirmed',{instructionId:d,cancelRequestId:request.cancelRequestId,
    cancelSliceId:'FULL',reservationId:d,nominalYuan:2*YI,releaseYuan:2*YI,nominalConfirmed:true,releaseConfirmed:true});
  assert.equal(deriveExecutionOrderDependencies(cancelled.getState(),b).some(row=>!row.ready),false);
  const remainingGoal=executionFillReadiness(cancelled.getState(),b);
  assert.equal(remainingGoal.ready,false);
  assert.equal(remainingGoal.ruleId,'PLAN-DEPOSIT-ORDER');
  assert.match(remainingGoal.reason,/剩余整笔存款/);
});

test('saved instruction conditions reject malformed arrays, amounts and references, while absent old fields remain valid',()=>{
  const model=start(depositTemplate());model.generateProposal();model.approveProposal();
  const sent=model.sendBatch(),id=sent.results[0].instructionId;
  const saved=JSON.parse(model.serialize());
  const conditions=[{},null,{kind:'filled'},[{kind:'filled',planId:'MISSING',minimumYuan:YI}],
    [{kind:'filled',planId:saved.plans[0].planId,minimumYuan:-1}],
    [{kind:'previous_confirmed',stepId:'MISSING'}],
    [{kind:'funds_available',planId:saved.plans[0].planId,minimumYuan:YI,basis:'reserved'}]];
  for (const invalid of conditions) {
    const corrupted=structuredClone(saved);
    corrupted.execution.instructions[id].machineConditions=invalid;
    corrupted.execution.journal.find(row=>row.kind==='send').instruction.machineConditions=invalid;
    assert.equal(validateSaved(corrupted).ok,false,JSON.stringify(invalid));
  }
  delete saved.execution.instructions[id].machineConditions;
  delete saved.execution.journal.find(row=>row.kind==='send').instruction.machineConditions;
  assert.equal(validateSaved(saved).ok,true);
});

test('a sent but unfilled same-bank sale does not release deposit headroom',()=>{
  const model=start(depositTemplate({other:58,sale:true}));
  const state=model.generateProposal();
  const snapshot=JSON.parse(model.serialize());
  for(const step of state.proposal.steps) {
    const p=state.plans.find(p=>p.planId===step.planId);
    const sent=registerSend(snapshot.execution,step,p,'OLD-APPROVAL');
    snapshot.execution=accept(sent.execution,sent.instructionId);
  }
  const ids=Object.values(snapshot.execution.instructions),sale=ids.find(i=>i.businessType==='cd_sell'),deposit=ids.find(i=>i.businessType==='deposit');
  assert.equal(executionFillReadiness(snapshot,deposit.instructionId).ready,false);
  assert.ok(deriveExecutionOrderDependencies(snapshot,deposit.instructionId).some(row=>row.planId===sale.planId&&!row.ready));
  const restored=createModel();restored.load(JSON.stringify(snapshot));
  assert.throws(()=>restored.simulateEvent('fill',{instructionId:deposit.instructionId,nominalYuan:2*YI}),/先卖券成交|累计成交/);
  restored.simulateEvent('fill',{instructionId:sale.instructionId,nominalYuan:2*YI});
  assert.ok(deriveExecutionOrderDependencies(restored.getState(),deposit.instructionId).some(row=>
    row.planId===sale.planId && row.ready && row.actualYuan===2*YI));
  restored.simulateEvent('fill',{instructionId:deposit.instructionId,nominalYuan:2*YI});
  assert.equal(validateSaved(restored.serialize()).ok,true);
});

test('partial CD fill is allowed when its actual amount preserves the pending whole deposit headroom',()=>{
  const t=depositTemplate({other:57,cd:true});t.draftPlans[1].targetYuan=2*YI;
  const model=start(t);model.generateProposal();model.approveProposal();
  const sent=model.sendBatch(),cd=Object.values(sent.execution.instructions).find(i=>i.businessType==='cd_buy');
  const deposit=Object.values(sent.execution.instructions).find(i=>i.businessType==='deposit');
  assert.equal(executionFillReadiness(sent,cd.instructionId,2*YI).ready,false);
  assert.equal(executionFillReadiness(sent,cd.instructionId,YI).ready,true);
  model.simulateEvent('fill',{instructionId:cd.instructionId,nominalYuan:YI});
  assert.equal(executionFillReadiness(model.getState(),cd.instructionId,YI).ready,false);
  model.simulateEvent('fill',{instructionId:deposit.instructionId,nominalYuan:2*YI});
  model.simulateEvent('fill',{instructionId:cd.instructionId,nominalYuan:YI});
  assert.equal(validateSaved(model.serialize()).ok,true);
});

test('fill-time future cash check does not reserve its own outstanding obligation a second time',()=>{
  const model=start(depositTemplate({cash:3}));model.generateProposal();model.approveProposal();
  const sent=model.sendBatch(),id=sent.results[0].instructionId;
  const state=structuredClone(sent);
  // Reuse the valid ticket as an old dated T+1 instruction. The one-day demo
  // does not create new T+1 plans, but its retained execution checker must not
  // charge the same future reservation twice.
  delete state.initialData.demoMode;delete state.execution.demoMode;
  state.initialData.termWeights.calendar='weekday-252-demo-v1';
  state.plans[0].settlementDate='2026-10-04';
  state.execution.instructions[id].settlementDate='2026-10-04';
  assert.equal(executionFillReadiness(state,id).ready,true);
});

test('old partial deposit fills replay unchanged, with the residual filled or cancelled whole',()=>{
  const model=start(depositTemplate());model.generateProposal();model.approveProposal();
  const sent=model.sendBatch(),id=sent.results[0].instructionId;
  const snapshot=JSON.parse(model.serialize());
  // Manufacture a pre-rule journal using the unchanged divisible execution
  // mechanics, then restore its historical business identity in both copies.
  snapshot.execution.instructions[id].businessType='reverse_repo';
  snapshot.execution.journal.find(row=>row.kind==='send').instruction.businessType='reverse_repo';
  snapshot.execution=applyEvent(snapshot.execution,event(snapshot.execution.sourceSequence+1,'fill',id,
    {nominalYuan:YI,fillId:'OLD-PARTIAL'})).execution;
  snapshot.execution.instructions[id].businessType='deposit';
  snapshot.execution.journal.find(row=>row.kind==='send').instruction.businessType='deposit';
  assert.equal(validateSaved(JSON.stringify(snapshot)).ok,true);
  const restored=createModel();restored.load(JSON.stringify(snapshot));
  assert.equal(restored.getState().execution.instructions[id].filledYuan,YI);
  assert.throws(()=>restored.simulateEvent('fill',{instructionId:id,nominalYuan:YI/2}),/存款不可拆分/);
  restored.simulateEvent('fill',{instructionId:id,nominalYuan:YI});
  assert.equal(restored.getState().execution.instructions[id].filledYuan,2*YI);
  assert.equal(validateSaved(restored.serialize()).ok,true);
});
