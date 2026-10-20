import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { baseTemplate, plan, YI } from '../scripts/robustness-scenarios.mjs';

test('custom order recalculation retains a real per-step cash and rule trace', () => {
  const template = baseTemplate({ id:'V3-TRACE',cash:5,gov:5 });
  template.draftPlans = [plan('甲逆回购','reverse_repo',2),plan('乙逆回购','reverse_repo',2)];
  const model = createModel(); model.startFromTemplate(template);
  const [first,second] = model.getState().plans;
  const result = model.recalculateDispatchBatch([
    { planId:second.planId,nominalYuan:2*YI },
    { planId:first.planId,nominalYuan:2*YI },
  ]);
  assert.deepEqual(result.recalculationRows.map(row => row.ready),[true,true]);
  const trace = result.calculation.trace.steps;
  assert.deepEqual(trace.map(row => row.planId),[second.planId,first.planId]);
  assert.deepEqual(trace.map(row => [row.beforeCashYuan,row.afterCashYuan]),
    [[5*YI,3*YI],[3*YI,YI]]);
  assert.ok(trace.every(row => row.rules.some(rule => rule.ruleId === 'DEMO-CASH-01')));
  assert.ok(trace.every((row,index) => row.stepId === result.proposal.steps[index].stepId));
  assert.equal(result.calculation.trace.projectedFinalCashYuan,YI);
});

test('blocked custom step has calculation evidence and does not consume later cash', () => {
  const template = baseTemplate({ id:'V3-TRACE-BLOCK',cash:3,gov:5 });
  template.draftPlans = [plan('超额逆回购','reverse_repo',5),plan('独立逆回购','reverse_repo',2)];
  const model = createModel(); model.startFromTemplate(template);
  const [large,small] = model.getState().plans;
  const result = model.recalculateDispatchBatch([
    {planId:large.planId,nominalYuan:5*YI},
    {planId:small.planId,nominalYuan:2*YI},
  ]);
  assert.deepEqual(result.recalculationRows.map(row => row.ready),[false,true]);
  const [blocked,independent] = result.calculation.trace.steps;
  assert.equal(blocked.beforeCashYuan,3*YI);
  assert.ok(blocked.rules.some(rule => rule.result === 'block'));
  assert.equal(independent.beforeCashYuan,3*YI);
  assert.equal(independent.afterCashYuan,YI);
});

test('advancement groups preserve calculation order and separate review from business limits', () => {
  const template = baseTemplate({ id:'V3-GROUPS',cash:3,gov:5 });
  template.draftPlans = [plan('可推进逆回购','reverse_repo',2),plan('受限逆回购','reverse_repo',5)];
  const model = createModel(); model.startFromTemplate(template);
  model.setPreferences(['reverse_repo_first']);
  const [first,second] = model.getState().plans;
  model.recalculateDispatchBatch([
    {planId:first.planId,nominalYuan:2*YI},
    {planId:second.planId,nominalYuan:5*YI},
  ]);
  let groups = model.getAdvancementGroups();
  assert.deepEqual(groups.priority.map(step => step.planId),[first.planId]);
  assert.equal(groups.priority[0].status,'awaiting_review');
  assert.deepEqual(groups.restricted.map(step => step.planId),[second.planId]);
  assert.match(groups.restricted[0].reason,/不足|阻断/);
  model.markSnapshotStale();
  groups = model.getAdvancementGroups();
  assert.deepEqual(groups.priority.map(step => step.planId),[first.planId]);
  assert.equal(groups.priority[0].status,'awaiting_refresh');
  assert.deepEqual(groups.restricted.map(step => step.planId),[second.planId]);
});

test('legacy zero financing quota does not constrain borrowing; pledge still does', () => {
  const model = createModel(); model.reset('S10');
  const repo = model.addPlan({label:'银行间融资',businessType:'interbank_repo_financing',
    direction:'inflow',targetYuan:7*YI,
    repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}}).plans.at(-1);
  model.setRepoResources('INTERBANK',{pledgeConfirmedYuan:7*YI});
  const saved = JSON.parse(model.serialize());
  saved.repoResources.INTERBANK.quotaConfirmedYuan = 0;
  const restored = createModel(saved);
  restored.refreshSnapshot();
  const result = restored.generateProposal();
  const financing = result.proposal.steps.find(step => step.planId === repo.planId);
  assert.ok(financing);
  assert.ok(!financing.machineConditions.some(condition => condition.kind === 'quota_confirmed'));
  assert.ok(!result.calculation.trace.steps.some(row => row.rules.some(rule =>
    rule.ruleId === 'DEMO-REPO-QUOTA')));
  assert.throws(() => restored.setRepoResources('INTERBANK',{quotaConfirmedYuan:7*YI}),/额度已取消/);
  restored.setRepoResources('INTERBANK',{pledgeConfirmedYuan:0});
  const constrained = restored.generateProposal();
  assert.ok(constrained.calculation.trace.steps.some(row => row.rules.some(rule =>
    rule.ruleId === 'DEMO-REPO-PLEDGE' && rule.result === 'waiting_conditions')));
});
