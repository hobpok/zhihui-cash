import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, deriveBatchReadiness } from './model.js';
import { createSyntheticInitialTemplate } from './initial-data.js';
import { yi, amountDetail, coreRuleDetail } from './readiness-diagnostics.js';

const YI = 100_000_000;
function twoPurchases() {
  const template = createSyntheticInitialTemplate();
  const bond = template.draftPlans.find(plan => plan.businessType === 'bond_buy');
  template.draftPlans = [1, 2].map(index =>
    ({ ...bond, label: `诊断现券买入${index}`, targetYuan: 10_000_000 }));
  const model = createModel();
  model.startFromTemplate(template);
  model.generateProposal();
  model.approveProposal();
  return model;
}
function addCondition(state, index, condition) {
  const fixture = structuredClone(state);
  fixture.proposal.steps[index].machineConditions.push(condition);
  fixture.approval.proposalCopy = structuredClone(fixture.proposal);
  return fixture;
}

test('money diagnostics preserve exact yuan and distinguish unknown from zero', () => {
  assert.equal(yi(17_6000_0000), '17.6亿');
  assert.equal(yi(1), '0.00000001亿');
  assert.equal(amountDetail(2 * YI, null), '最低2亿，当前未知，缺口待核实');
  assert.equal(amountDetail(2 * YI, 0), '最低2亿，当前0亿，尚差2亿');
  assert.match(coreRuleDetail({ name:'银行规则',subjectLabel:'成农商',reason:'交易后违反阈值',headroomYuan:-1, result:'block' }),
    /银行规则（成农商）.*超出0.00000001亿/);
  assert.match(coreRuleDetail({ name:'银行规则',reason:'交易后违反阈值',headroomYuan:'无法读取',result:'block' }),
    /金额缺口待核实/);
});

test('cash prerequisite names the current plan and exact shortfall', () => {
  const state = twoPurchases().getState();
  const fixture = addCondition(state, 0, { kind:'cash_available',minimumYuan:4 * YI });
  const row = deriveBatchReadiness(fixture)[0];
  assert.equal(row.ready, false);
  assert.match(row.reason, /条件资金尚未可用：诊断现券买入1/);
  assert.match(row.reason, /最低4亿，当前3.5亿，尚差0.5亿/);
});

test('dated settlement prerequisite identifies its date and exact gap', () => {
  const state = twoPurchases().getState();
  const fixture = addCondition(state, 0, {
    kind:'settlement_capacity',valueDate:state.context.businessDate,minimumYuan:4 * YI,
  });
  const row = deriveBatchReadiness(fixture)[0];
  assert.equal(row.ready, false);
  assert.match(row.reason, new RegExp(state.context.businessDate));
  assert.match(row.reason, /交收日资金容量不足：诊断现券买入1/);
  assert.match(row.reason, /最低4亿，当前3.5亿，尚差0.5亿/);
});

test('previous step condition identifies the exact unfilled source', () => {
  const state = twoPurchases().getState();
  const fixture = addCondition(state, 1, {
    kind:'previous_confirmed',stepId:state.proposal.steps[0].stepId,
  });
  const rows = deriveBatchReadiness(fixture);
  assert.equal(rows[0].ready, true);
  assert.equal(rows[1].ready, false);
  assert.match(rows[1].reason, /前置指令尚未完成成交：诊断现券买入1/);
  assert.match(rows[1].reason, /最低0.1亿，当前0亿，尚差0.1亿/);
});

test('unsettled prior purchase identifies its unpaid amount', () => {
  const model = twoPurchases();
  const state = model.getState(), first = state.proposal.steps[0];
  const instructionId = model.send(first.stepId).sentInstructionId;
  model.simulateEvent('accepted', { instructionId });
  model.simulateEvent('fill', { instructionId,nominalYuan:10_000_000 });
  const fixture = addCondition(model.getState(), 1, { kind:'payable_cleared',planId:first.planId });
  const row = deriveBatchReadiness(fixture)[1];
  assert.equal(row.ready, false);
  assert.match(row.reason, /前置应付未结清：诊断现券买入1，未结清0.1亿/);
});

test('confirmed pledge shortage identifies market, trade and remaining ability', () => {
  const model = createModel();
  model.reset('S10');
  model.deletePlan('P10');
  const source = model.addPlan({ label:'诊断银行间融资',businessType:'interbank_repo_financing',
    direction:'inflow',targetYuan:YI,
    repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null} }).plans.at(-1);
  model.setRepoResources('INTERBANK',{pledgeConfirmedYuan:YI});
  model.generateProposal();
  model.approveProposal();
  const fixture = structuredClone(model.getState());
  fixture.repoResources.INTERBANK.pledgeConfirmedYuan = 40_000_000;
  const row = deriveBatchReadiness(fixture).find(item => item.stepId ===
    fixture.proposal.steps.find(step => step.planId === source.planId).stepId);
  assert.equal(row.ready, false);
  assert.match(row.reason, /已确认质押券不足：诊断银行间融资（INTERBANK）/);
  assert.match(row.reason, /最低1亿，当前0.4亿，尚差0.6亿/);
});

test('sale receipt prerequisite identifies the source sale and unpaid proceeds', () => {
  const template = createSyntheticInitialTemplate();
  const sale = template.draftPlans.find(plan => plan.businessType === 'cd_sell');
  const buy = template.draftPlans.find(plan => plan.businessType === 'bond_buy');
  template.draftPlans = [
    { ...sale,label:'诊断卖券回款',targetYuan:50_000_000 },
    { ...buy,label:'诊断买券',targetYuan:10_000_000 },
  ];
  const model = createModel();
  model.startFromTemplate(template);
  model.generateProposal();
  model.approveProposal();
  const state = model.getState();
  const salePlan = state.plans.find(plan => plan.businessType === 'cd_sell');
  const buyIndex = state.proposal.steps.findIndex(step => step.planId !== salePlan.planId);
  const fixture = addCondition(state,buyIndex,{kind:'sale_cash_available',planId:salePlan.planId});
  const row = deriveBatchReadiness(fixture)[buyIndex];
  assert.equal(row.ready, false);
  assert.match(row.reason, /卖券回款尚未全额可用：诊断卖券回款/);
  assert.match(row.reason, /最低0.5亿，当前0亿，尚差0.5亿/);
});

test('unknown machine prerequisite blocks instead of silently passing', () => {
  const state = twoPurchases().getState();
  const fixture = addCondition(state,0,{kind:'legacy_external_approval',planId:state.plans[1].planId});
  const row = deriveBatchReadiness(fixture)[0];
  assert.equal(row.ready,false);
  assert.match(row.reason,/未知执行前置条件（legacy_external_approval）/);
  assert.match(row.reason,/诊断现券买入1关联诊断现券买入2/);
});
