import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { baseTemplate, createScenarios, plan, YI } from '../scripts/robustness-scenarios.mjs';

const conditions = (step, kind) => step.machineConditions.filter(row => row.kind === kind);

test('reducing a split S10 step discards its old cash threshold but retains actual split prerequisites', () => {
  const model = createModel();
  model.reset('S10');
  const initial = model.generateProposal();
  const second = initial.proposal.steps.find(step => step.stepId === 'I-B');
  assert.deepEqual(conditions(second, 'cash_available').map(row => row.minimumYuan), [7*YI]);

  const recalculated = model.recalculateDispatchBatch([
    {planId:'P10',nominalYuan:YI,sourceStepId:'I-B'},
  ]);
  const revised = recalculated.proposal.steps[0];
  assert.equal(conditions(revised, 'cash_available').length, 0);
  assert.deepEqual(revised.machineConditions.map(row => row.kind),
    ['previous_confirmed','filled','payable_cleared']);
  assert.equal(conditions(revised, 'previous_confirmed')[0].stepId, 'I-A');
  assert.equal(conditions(revised, 'filled')[0].minimumYuan, 3*YI);
  assert.equal(recalculated.recalculationRows[0].ready, false);
  assert.match(recalculated.recalculationRows[0].reason, /前置指令/);
});

test('sale, financing, and future purchase conditions are rebuilt at their current amounts', () => {
  const template = baseTemplate({id:'BATCH-AUDIT-SALE',cash:10,gov:5,
    holdings:[{securityId:'LONG',amount:3,sellable:3}]});
  template.draftPlans = [plan('卖长债','bond_sell',2,'LONG'),
    plan('银行间融资','interbank_repo_financing',2),plan('逆回购','reverse_repo',2)];
  const model = createModel();
  model.startFromTemplate(template);
  const [sale,financing,lending] = model.getState().plans;
  const initial = model.generateProposal();
  assert.deepEqual(conditions(initial.proposal.steps.find(step => step.planId === sale.planId),
    'holding_confirmed').map(row => row.minimumYuan), [2*YI]);
  const reordered = model.recalculateDispatchBatch([
    {planId:lending.planId,nominalYuan:2*YI},
    {planId:financing.planId,nominalYuan:YI},
    {planId:sale.planId,nominalYuan:YI},
  ]);
  assert.deepEqual(reordered.recalculationRows.map(row => row.ready), [true,true,true]);
  assert.deepEqual(conditions(reordered.proposal.steps[2], 'holding_confirmed')
    .map(row => row.minimumYuan), [YI]);
  assert.equal(reordered.proposal.steps[2].machineConditions.length, 1);

  const legacy = createModel();
  legacy.reset('S13');
  for (const existing of [...legacy.getState().plans]) legacy.deletePlan(existing.planId);
  const repo = legacy.addPlan({label:'融资',businessType:'interbank_repo_financing',
    direction:'inflow',targetYuan:2*YI,
    repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}}).plans.at(-1);
  legacy.setRepoResources('INTERBANK',{pledgeConfirmedYuan:3*YI});
  const repoInitial = legacy.generateProposal();
  assert.deepEqual(conditions(repoInitial.proposal.steps[0], 'pledge_confirmed')
    .map(row => row.minimumYuan), [2*YI]);
  const repoRevised = legacy.recalculateDispatchBatch([{planId:repo.planId,nominalYuan:YI}]);
  assert.equal(repoRevised.recalculationRows[0].ready, true);
  assert.deepEqual(conditions(repoRevised.proposal.steps[0], 'pledge_confirmed')
    .map(row => row.minimumYuan), [YI]);
  assert.equal(repoRevised.proposal.steps[0].machineConditions.length, 1);

  const future = createModel();
  future.reset('S13');
  for (const existing of [...future.getState().plans]) future.deletePlan(existing.planId);
  const purchase = future.addPlan({label:'未来买券',businessType:'bond_buy',
    direction:'outflow',targetYuan:2*YI,settlementDate:'2026-09-09'}).plans.at(-1);
  const futureInitial = future.generateProposal();
  assert.deepEqual(conditions(futureInitial.proposal.steps[0], 'settlement_capacity')
    .map(row => row.minimumYuan), [2*YI]);
  const futureRevised = future.recalculateDispatchBatch([{planId:purchase.planId,nominalYuan:YI}]);
  assert.equal(futureRevised.recalculationRows[0].ready, true);
  assert.deepEqual(conditions(futureRevised.proposal.steps[0], 'settlement_capacity')
    .map(row => [row.valueDate,row.minimumYuan]), [['2026-09-09',YI]]);
  assert.equal(futureRevised.proposal.steps[0].machineConditions.length, 1);
});

test('omitting a selected predecessor uses the remaining current prefix and actual cash', () => {
  const template = baseTemplate({id:'BATCH-AUDIT-OMISSION',cash:6,gov:5,
    holdings:[{securityId:'LONG',amount:3,sellable:3}]});
  template.draftPlans = [plan('卖长债','bond_sell',2,'LONG'),
    plan('逆回购','reverse_repo',2),plan('买短债','bond_buy',2,'SHORT')];
  const model = createModel();
  model.startFromTemplate(template);
  model.generateProposal();
  const [sale,lending,purchase] = model.getState().plans;
  const all = model.recalculateDispatchBatch([
    {planId:sale.planId,nominalYuan:2*YI},
    {planId:lending.planId,nominalYuan:2*YI},
    {planId:purchase.planId,nominalYuan:2*YI},
  ]);
  assert.deepEqual(all.recalculationRows.map(row => row.ready), [true,true,true]);
  const omitted = model.recalculateDispatchBatch([
    {planId:purchase.planId,nominalYuan:2*YI},
    {planId:lending.planId,nominalYuan:2*YI},
  ]);
  assert.deepEqual(omitted.recalculationRows.map(row => row.ready), [true,true]);
  assert.ok(omitted.proposal.steps.every(step => step.machineConditions.every(row =>
    row.planId !== sale.planId)));
  assert.deepEqual(omitted.calculation.trace.steps.map(row => [row.beforeCashYuan,row.afterCashYuan]),
    [[6*YI,4*YI],[4*YI,2*YI]]);
});

test('historical sale receipt and unrecognized conditions are retained for explicit review', () => {
  const original = createModel();
  original.reset('S13');
  const first = original.generateProposal().proposal.steps[0];
  const saved = JSON.parse(original.serialize());
  const conditionsBefore = saved.proposal.steps[0].machineConditions;
  conditionsBefore.push({kind:'sale_cash_available',planId:'P-SELL'});
  conditionsBefore.push({kind:'legacy_external_approval',reference:'legacy-audit'});
  const restored = createModel(saved);
  restored.refreshSnapshot();
  const result = restored.recalculateDispatchBatch([
    {planId:first.planId,nominalYuan:first.nominalYuan},
  ]);
  assert.deepEqual(result.proposal.steps[0].machineConditions
    .filter(row => ['sale_cash_available','legacy_external_approval'].includes(row.kind)),
  conditionsBefore.filter(row => ['sale_cash_available','legacy_external_approval'].includes(row.kind)));
  assert.equal(result.recalculationRows[0].ready, false);
  assert.match(result.recalculationRows[0].reason, /卖券回款/);
});

test('a blocked prefix reports its own rule and reason instead of an unrelated conflict', () => {
  const template = createScenarios().find(scenario => scenario.id === 'R07').template;
  const model = createModel();
  model.startFromTemplate(template);
  model.generateProposal();
  const buy = model.getState().plans.find(item => item.businessType === 'cd_buy');
  const result = model.recalculateDispatchBatch([{planId:buy.planId,nominalYuan:2*YI}]);
  const row = result.recalculationRows[0];
  const blockedRule = result.calculation.trace.steps[0].rules.find(rule => rule.result === 'block');
  assert.equal(row.ready, false);
  assert.equal(row.ruleId, 'C03');
  assert.equal(row.name, blockedRule.name);
  assert.equal(row.reason, `${blockedRule.name}：${blockedRule.reason}`);
  assert.equal(result.proposal.groups[0].reason, row.reason);
});


test('oversized exchange financing explains the per-order limit rather than an unrelated interest note', () => {
  const model=createModel();model.reset('S10');
  const financing=model.addPlan({label:'超额交易所融资',businessType:'exchange_repo_financing',direction:'inflow',
    targetYuan:150*YI,repoTerms:{market:'SSE',tenorDays:1,annualRate:null}}).plans.at(-1);
  model.setRepoResources('SSE',{pledgeConfirmedYuan:200*YI});model.generateProposal();
  const result=model.recalculateDispatchBatch([{planId:financing.planId,nominalYuan:150*YI}]);
  assert.equal(result.recalculationReady,false);
  assert.match(result.recalculationRows[0].reason,/单笔上限100亿/);
  assert.match(result.recalculationRows[0].reason,/本次150亿/);
  assert.doesNotMatch(result.recalculationRows[0].reason,/利息与到期/);
});
