import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { createHistoricalComplexTemplate } from './test-fixtures/historical-complex.js';
import { createPlanningTools } from '../server/planning-tools.js';
import { diagnoseExecution } from './execution-diagnostics.js';

test('legacy state without C02 does not create a liquidity bridge', () => {
  const state = createModel().getState();
  const report = diagnoseExecution(state);
  assert.equal(report.liquidityBridge,null);
  assert.equal(report.current.c02.ruleId,null);
});

test('settled sale without cash_available remains a receivable', () => {
  const template = createHistoricalComplexTemplate();
  const sale = template.draftPlans.find(x => x.businessType === 'cd_sell');
  template.draftPlans = [{...sale,targetYuan:100000000}];
  const model = createModel();
  model.startFromTemplate(template);
  model.generateProposal('AUTO');
  model.approveProposal();
  const step = model.getState().proposal.steps.find(x => x.planId === model.getState().plans[0].planId);
  assert.ok(step && !step.blocked);
  const instructionId = model.send(step.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId});
  model.simulateEvent('fill',{instructionId,nominalYuan:100000000});
  model.simulateEvent('cash_settled',{instructionId,amountYuan:100000000,cashFlowId:'sale-settled'});
  const saved = JSON.parse(model.serialize());
  const report = createPlanningTools(saved,{requestId:'sale-receipt',documentRevision:1})
    .execute('diagnose_execution',{});
  assert.equal(report.status,'attention');
  assert.deepEqual(report.settlementActions.map(x => [x.kind,x.amountYuan]),
    [['receive_cash',100000000]]);
  assert.equal(report.recommendations[0].code,'track_sale_receipt');
  assert.equal(report.cashReconciliation.matches,true);
  assert.equal(report.cashReconciliation.creditedInflowYuan,0);
  assert.equal(report.cashReconciliation.accountCashYuan,template.portfolio.accountCashYuan);
  assert.equal(report.current.cash.saleUncreditedYuan,100000000);
  assert.equal(report.current.cash.businessCashYuan,template.portfolio.accountCashYuan + 100000000);
  assert.equal(report.current.cash.accountCashYuan,template.portfolio.accountCashYuan);
  assert.equal(report.current.cash.navYuan,template.portfolio.navYuan);
  assert.equal(report.current.cash.governmentBondWithinYearYuan,
    model.getState().summary.cashRatioBasis.governmentBondWithinYearYuan);
  assert.equal(report.unfinishedPlans.length,0);
  assert.equal(report.liquidityBridge.businessCashAfterRemainingOutflowsYuan,
    report.current.cash.businessCashYuan);
  assert.deepEqual(saved,JSON.parse(model.serialize()));
  const withoutC02 = structuredClone(model.getState());
  withoutC02.coreRules.rows = withoutC02.coreRules.rows.filter(x => x.ruleId !== 'C02');
  assert.equal(diagnoseExecution(withoutC02).liquidityBridge,null);
  model.simulateEvent('cash_available',{instructionId,amountYuan:100000000,cashFlowId:'sale-cash'});
  const afterReceipt = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'sale-receipt-confirmed',documentRevision:1}).execute('diagnose_execution',{});
  assert.equal(afterReceipt.current.cash.saleUncreditedYuan,0);
  assert.equal(afterReceipt.current.cash.accountCashYuan,template.portfolio.accountCashYuan + 100000000);
  assert.equal(afterReceipt.current.cash.businessCashYuan,report.current.cash.businessCashYuan);
  assert.equal(afterReceipt.current.c02.currentValue,report.current.c02.currentValue);
});

test('saved C02 blocker never overrides a passing current isolated rule check', () => {
  const template = createHistoricalComplexTemplate();
  const sale = template.draftPlans.find(x => x.businessType === 'cd_sell');
  template.draftPlans = [{...sale,targetYuan:100000000}];
  const model = createModel();
  model.startFromTemplate(template);
  const state = structuredClone(model.getState());
  const planId = state.plans[0].planId;
  state.proposal = {status:'search_exhausted',planCoverage:state.summary.planBalances.map(x => ({...x})),
    blockers:[{planId,code:'core-C02',severity:'block'}],
    steps:[{stepId:'OLD-C02',planId,nominalYuan:100000000,blocked:true}]};
  state.calculation = {trace:{steps:[{stepId:'OLD-C02',rules:[{ruleId:'C02',result:'block'}]}]}};
  const report = diagnoseExecution(state);
  assert.deepEqual(report.unfinishedPlans[0].immediateBlockers,[]);
  assert.equal(report.unfinishedPlans[0].staleProposalBlocker,true);
  assert.equal(report.unfinishedPlans[0].reasonClass,'saved_proposal_requires_recalculation');
  assert.equal(report.next.firstBlockedStep,null);
  assert.equal(report.next.proposalStatus,null);
  assert.equal(report.next.unarrangedYuan,null);
  assert.equal(report.next.proposalBasis,'saved_proposal_rule_mismatch');
  assert.equal(report.next.savedUnarrangedYuan,null);
  assert.equal(report.next.savedFirstBlockedStep.basis,'saved_proposal_historical');
});


