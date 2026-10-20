import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { calculate } from './engine.js';

const send = (model, planId, nominalYuan) => {
  const result = model.recalculateDispatchBatch([{ planId, nominalYuan }]);
  assert.equal(result.recalculationReady, true, result.recalculationRows[0]?.reason);
  assert.notEqual(model.getState().approvalStatus, 'valid');
  model.approveProposal();
  const step = model.getState().proposal.steps[0];
  const dispatched = model.sendCustomBatch([{ stepId: step.stepId, nominalYuan }]);
  assert.equal(dispatched.results[0].status, 'accepted');
  return dispatched.results[0].instructionId;
};

test('selected plan amount gets a new calculated proposal and requires fresh review', () => {
  const model = createModel();
  model.generateProposal('AUTO');
  model.approveProposal();
  const oldApproval = model.getState().approval.approvalId;
  const result = model.recalculateDispatchBatch([{ planId: 'P-CD', nominalYuan: 100_000_000 }]);
  assert.equal(result.recalculationReady, true);
  assert.equal(result.proposal.pathId, 'CUSTOM-ORDER');
  assert.equal(result.approvalStatus, 'stale');
  assert.equal(model.getState().approval.approvalId, oldApproval);
  assert.throws(() => model.sendCustomBatch(result.proposal.steps.map(step => ({
    stepId: step.stepId, nominalYuan: step.nominalYuan,
  }))), /审核/);
  model.approveProposal();
  assert.equal(model.getState().approvalStatus, 'valid');
});

test('a recalculated batch may omit ready steps while keeping their calculation and review', async () => {
  const {baseTemplate,plan,YI}=await import('../scripts/robustness-scenarios.mjs');
  const template=baseTemplate({id:'V2-SUBSET',cash:5,gov:5});
  template.draftPlans=[plan('甲逆回购','reverse_repo',2),plan('乙逆回购','reverse_repo',2)];
  const model=createModel();model.startFromTemplate(template);
  const original=model.getState().plans;
  const result=model.recalculateDispatchBatch(original.map(p=>({planId:p.planId,nominalYuan:2*YI})));
  assert.equal(result.recalculationReady,true);
  const [first,second]=result.proposal.steps;
  const subset=[{stepId:second.stepId,nominalYuan:second.nominalYuan}];
  assert.equal(model.previewDispatchBatch(subset,{skipReview:true}).ready,true);
  assert.throws(()=>model.previewDispatchBatch([
    {stepId:second.stepId,nominalYuan:second.nominalYuan},
    {stepId:first.stepId,nominalYuan:first.nominalYuan},
  ],{skipReview:true}),/原顺序/);
  assert.throws(()=>model.previewDispatchBatch([{stepId:second.stepId,nominalYuan:YI}],{skipReview:true}),/重新计算/);
  model.approveProposal();
  const approved=model.getState().approval.approvalId;
  assert.equal(model.previewDispatchBatch(subset).ready,true);
  assert.equal(model.getState().approval.approvalId,approved);
  assert.deepEqual(model.sendCustomBatch(subset).results.map(row=>row.status),['accepted']);
});

test('a blocked instruction does not prevent an independent later instruction from being checked', async () => {
  const {baseTemplate,plan,YI}=await import('../scripts/robustness-scenarios.mjs');
  const template=baseTemplate({id:'V2-BLOCKED-FIRST',cash:3,gov:5});
  template.draftPlans=[plan('超额逆回购','reverse_repo',5),plan('独立逆回购','reverse_repo',2)];
  const model=createModel();model.startFromTemplate(template);
  const [large,small]=model.getState().plans;
  const result=model.recalculateDispatchBatch([
    {planId:large.planId,nominalYuan:5*YI},
    {planId:small.planId,nominalYuan:2*YI},
  ]);
  assert.deepEqual(result.recalculationRows.map(row=>row.ready),[false,true]);
  const onlySmall=[{stepId:result.recalculationRows[1].stepId,nominalYuan:2*YI}];
  assert.equal(model.previewDispatchBatch(onlySmall,{skipReview:true}).ready,true);
  assert.equal(model.previewDispatchBatch(result.recalculationRows.map(row=>({
    stepId:row.stepId,nominalYuan:row.nominalYuan,
  })),{skipReview:true}).ready,false);
  model.approveProposal();
  assert.equal(model.sendCustomBatch(onlySmall).results[0].status,'accepted');
});

test('refresh after recalculation preserves the current proposal and permits a fresh check', () => {
  const model=createModel();model.generateProposal();
  const result=model.recalculateDispatchBatch([{planId:'P-CD',nominalYuan:100_000_000}]);
  const proposalId=result.proposal.proposalId;
  model.markSnapshotStale();
  assert.throws(()=>model.previewDispatchBatch(result.proposal.steps.map(step=>({
    stepId:step.stepId,nominalYuan:step.nominalYuan,
  })),{skipReview:true}),/快照过期/);
  const refreshed=model.refreshSnapshot();
  assert.equal(refreshed.proposal.proposalId,proposalId);
  assert.equal(model.previewDispatchBatch(result.proposal.steps.map(step=>({
    stepId:step.stepId,nominalYuan:step.nominalYuan,
  })),{skipReview:true}).ready,true);
});

test('recalculation blocked only by an old snapshot can pass after refresh and a new calculation', () => {
  const model=createModel();model.generateProposal();model.markSnapshotStale();
  const blocked=model.recalculateDispatchBatch([{planId:'P-CD',nominalYuan:100_000_000}]);
  assert.equal(blocked.recalculationRows[0].ready,false);
  assert.match(blocked.recalculationRows[0].reason,/快照过期/);
  model.refreshSnapshot();
  const fresh=model.recalculateDispatchBatch([{planId:'P-CD',nominalYuan:100_000_000}]);
  assert.equal(fresh.recalculationRows[0].ready,true);
  assert.equal(model.previewDispatchBatch([{stepId:fresh.recalculationRows[0].stepId,
    nominalYuan:100_000_000}],{skipReview:true}).ready,true);
});

test('hypothetical fresh-snapshot preview changes no facts and cannot authorize sending', () => {
  const model=createModel();model.generateProposal();model.markSnapshotStale();
  const step=model.getState().proposal.steps[0];
  const item=[{stepId:step.stepId,nominalYuan:step.nominalYuan}];
  const before=model.serialize();
  assert.throws(()=>model.previewDispatchBatch(item,{skipReview:true}),/快照过期/);
  assert.equal(model.previewDispatchBatch(item,{skipReview:true,assumeFreshSnapshot:true}).ready,true);
  assert.equal(model.serialize(),before);
  assert.throws(()=>model.sendCustomBatch(item,{skipReview:true}),/快照过期/);
});

test('recalculating the second step of one plan preserves its original dependency', () => {
  const model=createModel();model.reset('S10');model.generateProposal();
  const [first,second]=model.getState().proposal.steps;
  assert.equal(first.planId,second.planId);
  const recalculated=model.recalculateDispatchBatch([{
    planId:second.planId,nominalYuan:100_000_000,sourceStepId:second.stepId,
  }]);
  const condition=recalculated.proposal.steps[0].machineConditions.find(item=>item.kind==='previous_confirmed');
  assert.equal(condition.stepId,first.stepId);
  assert.equal(recalculated.recalculationRows[0].ready,false);
  assert.match(recalculated.recalculationRows[0].reason,/前置指令/);
});

test('a later expanded batch regenerates a calculation basis for a plan omitted earlier', async () => {
  const {baseTemplate,plan,YI}=await import('../scripts/robustness-scenarios.mjs');
  const template=baseTemplate({id:'V2-EXPAND',cash:5,gov:5});
  template.draftPlans=[plan('甲逆回购','reverse_repo',2),plan('乙逆回购','reverse_repo',2)];
  const model=createModel();model.startFromTemplate(template);model.generateProposal();
  const [a,b]=model.getState().plans;
  model.recalculateDispatchBatch([{planId:a.planId,nominalYuan:2*YI}]);
  const expanded=model.recalculateDispatchBatch([
    {planId:a.planId,nominalYuan:2*YI},
    {planId:b.planId,nominalYuan:2*YI},
  ]);
  assert.deepEqual(expanded.recalculationRows.map(row=>row.ready),[true,true]);
  assert.deepEqual(expanded.proposal.steps.map(step=>step.planId),[a.planId,b.planId]);
});

test('supplied calculation commits only against its matching saved state', () => {
  const target=createModel();
  const serialized=target.serialize();
  const result=calculate(target.getState(),{pathId:'AUTO'});
  assert.throws(()=>target.generateProposal('AUTO',{result}),/计算期间数据已变化/);
  const before=target.serialize();
  assert.throws(()=>target.generateProposal('AUTO',{result,expectedSerialized:'{}'}),/计算期间数据已变化/);
  assert.equal(target.serialize(),before);
  // The local result has the same shape as the engine result; the commit path remains shared.
  const committed=target.generateProposal('AUTO',{result,expectedSerialized:serialized});
  assert.equal(committed.proposal.origin,'calculated');
});

test('batch fill records no payment; settlement stops at failure and preserves prior payment', () => {
  const model = createModel();
  model.generateProposal('AUTO');
  const first = send(model, 'P-CD', 100_000_000);
  const second = send(model, 'P-BOND', 100_000_000);
  const before = model.getState().summary.accountCashYuan;
  const fill = model.processExecutionBatch([first], 'fill');
  assert.equal(fill.results[0].status, 'filled');
  assert.equal(model.getState().summary.accountCashYuan, before);
  const settled = model.processExecutionBatch([first, second], 'settle');
  assert.deepEqual(settled.results.map(row => row.status), ['settled', 'blocked']);
  const state = model.getState();
  assert.equal(state.summary.accountCashYuan, before - 100_000_000);
  assert.equal(state.execution.instructions[first].settledYuan, 100_000_000);
  assert.equal(state.execution.instructions[second].settledYuan, 0);
  assert.equal(model.processExecutionBatch([first], 'settle').results[0].status, 'blocked');
  assert.equal(model.getState().summary.accountCashYuan, before - 100_000_000);
});

test('inflow batch settlement records settlement and actual cash availability once', () => {
  const model = createModel();
  model.generateProposal('AUTO');
  const id = send(model, 'P-SELL', 200_000_000);
  const before = model.getState().summary.accountCashYuan;
  model.processExecutionBatch([id], 'fill');
  assert.equal(model.getState().summary.accountCashYuan, before);
  const result = model.processExecutionBatch([id], 'settle');
  assert.equal(result.results[0].status, 'settled');
  const state = model.getState();
  assert.equal(state.execution.instructions[id].settledYuan, 200_000_000);
  assert.equal(state.summary.accountCashYuan, before + 200_000_000);
  assert.equal(Object.values(state.execution.cashFlows).filter(flow =>
    flow.type === 'cash_available' && flow.instructionId === id).length, 1);
  assert.equal(model.processExecutionBatch([id], 'settle').results[0].status, 'blocked');
  assert.equal(model.getState().summary.accountCashYuan, before + 200_000_000);
});

test('recalculation keeps the full target, rejects over-arrangement, and stops on stale facts', () => {
  const model = createModel();
  model.generateProposal('AUTO');
  const initial = model.getState();
  assert.throws(() => model.recalculateDispatchBatch([{
    planId:'P-CD',nominalYuan:100_000_001,
  }]), /超过完整意向金额/);
  assert.equal(model.getState().revision, initial.revision);
  model.markSnapshotStale();
  const blocked = model.recalculateDispatchBatch([{planId:'P-CD',nominalYuan:100_000_000}]);
  assert.equal(blocked.recalculationReady, false);
  assert.match(blocked.recalculationRows[0].reason, /快照过期/);
  assert.equal(blocked.summary.planBalances.find(row=>row.planId==='P-CD').targetYuan,100_000_000);
  assert.equal(blocked.summary.planBalances.find(row=>row.planId==='P-CD').arrangeableYuan,100_000_000);
});


test('user v2 example reallocates 5 and 3.58 yi recommendations to 3 and 5 after recalculation', async () => {
  const {baseTemplate,plan,YI}=await import('../scripts/robustness-scenarios.mjs');
  const template=baseTemplate({id:'V2-REALLOC',cash:8.58,gov:5});
  template.draftPlans=[plan('甲逆回购','reverse_repo',5),plan('乙逆回购','reverse_repo',13.1)];
  const model=createModel();model.startFromTemplate(template);
  const original=model.generateProposal();
  assert.deepEqual(original.proposal.steps.map(x=>x.nominalYuan),[500_000_000,358_000_000]);
  const [a,b]=original.plans;
  const recalc=model.recalculateDispatchBatch([{planId:a.planId,nominalYuan:3*YI},{planId:b.planId,nominalYuan:5*YI}]);
  assert.equal(recalc.recalculationReady,true);
  model.approveProposal();
  const result=model.sendCustomBatch(recalc.proposal.steps.map(x=>({stepId:x.stepId,nominalYuan:x.nominalYuan})));
  assert.deepEqual(result.results.map(x=>x.status),['accepted','accepted']);
  assert.deepEqual(result.summary.planBalances.map(x=>[x.targetYuan,x.lockedYuan]),[[5*YI,3*YI],[1_310_000_000,5*YI]]);
  assert.equal(result.summary.accountCashYuan,858_000_000);
  assert.equal(result.summary.availableYuan,58_000_000);
});

test('an unselected recommendation can be newly calculated without reusing prior authorization', async () => {
  const {baseTemplate,plan,YI}=await import('../scripts/robustness-scenarios.mjs');
  const template=baseTemplate({id:'V2-UNRECOMMENDED',cash:5,gov:5});
  template.draftPlans=[plan('甲逆回购','reverse_repo',5),plan('乙逆回购','reverse_repo',5)];
  const model=createModel();model.startFromTemplate(template);const initial=model.generateProposal();
  const unrecommended=initial.plans.find(p=>!initial.proposal.steps.some(x=>x.planId===p.planId));
  assert.ok(unrecommended);
  const recalculated=model.recalculateDispatchBatch([{planId:unrecommended.planId,nominalYuan:5*YI}]);
  assert.equal(recalculated.recalculationReady,true);
  assert.equal(recalculated.proposal.steps[0].planId,unrecommended.planId);
  model.approveProposal();
  assert.equal(model.sendCustomBatch(recalculated.proposal.steps.map(x=>({stepId:x.stepId,nominalYuan:x.nominalYuan}))).results[0].status,'accepted');
});
