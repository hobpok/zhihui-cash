import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { createHistoricalComplexTemplate } from './test-fixtures/historical-complex.js';

const YI = 100_000_000;

test('custom batch rebuilds old sale and financing dependencies after partial fills', () => {
  const model = createModel();
  model.startFromTemplate(createHistoricalComplexTemplate());
  model.generateProposal();
  const plans = model.getState().plans;
  const sale = plans.find(plan => plan.businessType === 'cd_sell');
  const financing = plans.find(plan => plan.businessType === 'interbank_repo_financing');
  const deposit = plans.find(plan => plan.businessType === 'deposit');
  const zhongyuan = plans.find(plan => plan.businessType === 'cd_buy' && plan.label.includes('中原'));
  const guangzhou = plans.find(plan => plan.businessType === 'cd_buy' && plan.label.includes('广州'));
  assert.ok(sale && financing && deposit && zhongyuan && guangzhou);

  const first = model.recalculateDispatchBatch([
    {planId:sale.planId,nominalYuan:8*YI},
    {planId:financing.planId,nominalYuan:5*YI},
  ]);
  assert.deepEqual(first.recalculationRows.map(row => row.ready),[true,true]);
  model.approveProposal();
  const sent = model.sendCustomBatch(model.getState().proposal.steps.map(step => ({
    stepId:step.stepId,nominalYuan:step.nominalYuan,
  })));
  assert.deepEqual(sent.results.map(row => row.status),['accepted','accepted']);
  for (const [index,row] of sent.results.entries()) model.simulateEvent('fill',{
    instructionId:row.instructionId,nominalYuan:index === 0 ? 8*YI : 5*YI,
  });
  model.refreshSnapshot();
  const proposed = model.generateProposal();
  assert.equal(proposed.summary.availableYuan,13*YI);
  assert.equal(proposed.summary.accountCashYuan,0);
  const previousBuy = proposed.proposal.steps.find(step => step.planId === zhongyuan.planId);
  assert.ok(previousBuy.machineConditions.some(c => c.kind === 'funds_available' && c.minimumYuan === 9.5*YI));
  assert.ok(previousBuy.machineConditions.some(c => c.kind === 'filled' && c.planId === sale.planId && c.minimumYuan === 13*YI));

  const comparison = createModel(model.serialize());
  comparison.refreshSnapshot();
  const guangzhouPath = comparison.recalculateDispatchBatch([
    {planId:sale.planId,nominalYuan:5*YI},
    {planId:financing.planId,nominalYuan:12.6*YI},
    {planId:guangzhou.planId,nominalYuan:YI},
  ]);
  assert.deepEqual(guangzhouPath.recalculationRows.map(row => row.ready),[true,true,true]);

  const updated = model.recalculateDispatchBatch([
    {planId:sale.planId,nominalYuan:5*YI},
    {planId:financing.planId,nominalYuan:12.6*YI},
    {planId:deposit.planId,nominalYuan:6*YI},
    {planId:zhongyuan.planId,nominalYuan:YI},
  ]);
  assert.deepEqual(updated.recalculationRows.map(row => row.ready),[true,true,true,true]);
  const currentBuy = updated.proposal.steps.find(step => step.planId === zhongyuan.planId);
  assert.equal(currentBuy.machineConditions.some(c =>
    ['funds_available','filled'].includes(c.kind) && [sale.planId,financing.planId].includes(c.planId)),false);
  assert.equal(updated.calculation.trace.steps.some(step => step.rules.some(rule =>
    ['block','missing','closed'].includes(rule.result))),false);
});


