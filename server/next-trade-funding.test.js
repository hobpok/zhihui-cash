import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../app/model.js';
import { createDefaultInitialTemplate } from '../app/default-scenario.js';
import { createPlanningTools } from './planning-tools.js';

const E=100000000;
function setup({financing=20*E,sale=2*E,financingTarget=49*E,templateChange=()=>{}}={}) {
  const template=createDefaultInitialTemplate();
  template.draftPlans.find(x=>x.businessType==='interbank_repo_financing').targetYuan=financingTarget;
  templateChange(template);
  const m=createModel();m.startFromTemplate(template);m.generateProposal();m.approveProposal();m.sendBatch();
  for (const i of Object.values(m.getState().execution.instructions)) {
    const amount=i.businessType==='cd_sell'?sale:financing;
    if (amount) m.simulateEvent('fill',{instructionId:i.instructionId,nominalYuan:amount});
  }
  return m;
}
function assess(model,bank='广州') {
  const before=model.serialize(), saved=JSON.parse(before), savedBefore=structuredClone(saved);
  const tools=createPlanningTools(saved,{requestId:'next-test',documentRevision:1});
  const plan=tools.context.plans.find(x=>x.businessType==='deposit'&&x.label.includes(bank));
  const result=tools.execute('assess_next_trade_funding',{planId:plan.planId});
  assert.equal(model.serialize(),before);assert.deepEqual(saved,savedBefore);
  assert.deepEqual(tools.execute('assess_next_trade_funding',{planId:plan.planId}),result);
  assert.ok(!JSON.stringify(result).includes('journal'));
  assert.equal(result.canDispatchNow,false);
  return result;
}

test('Guangzhou next deposit needs 6 yi, current-only repair 3, target remainder 29',()=>{
  const r=assess(setup());
  assert.equal(r.status,'ok');assert.equal(r.scope,'next_existing_trade');
  assert.equal(r.currentCashRequirement.additionalFinancingFillYuan,3*E);
  assert.equal(r.nextTradeRequirement.currentNumeratorYuan,22*E);
  assert.equal(r.nextTradeRequirement.targetOutflowYuan,3*E);
  assert.equal(r.nextTradeRequirement.mathematicalAdditionalFinancingYuan,6*E);
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,6*E);
  assert.equal(r.nextTradeRequirement.projectedC02Ratio,.05);
  assert.equal(r.financing.existingUnfilledYuan,29*E);
  assert.equal(r.financing.verifiedFillYuan,6*E);
  assert.equal(r.payment.accountCashYuan,5*E);assert.equal(r.payment.shortfallYuan,0);
  assert.equal(r.payment.paymentYuan,3*E);assert.deepEqual(r.remainingBlockers,[]);
});
test('Jiangnan existing 2 yi target needs 5 yi under the same facts',()=>{
  const r=assess(setup(),'江南');assert.equal(r.status,'ok');
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,5*E);
});
test('current C02 already met is different from next deposit requirement',()=>{
  const r=assess(setup({financing:23*E}));
  assert.equal(r.currentCashRequirement.additionalFinancingFillYuan,0);
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,3*E);
});
test('next-trade C02 already met needs zero without exhausting existing financing',()=>{
  const r=assess(setup({financing:26*E}));assert.equal(r.status,'ok');
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,0);
  assert.equal(r.financing.existingUnfilledYuan,23*E);
  assert.equal(r.financing.allocations.length,0);
});
test('unfilled sale is never credited and missing Guangzhou sale remains a separate blocker',()=>{
  const r=assess(setup({sale:0}));
  assert.equal(r.nextTradeRequirement.currentNumeratorYuan,20*E);
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,8*E);
  assert.equal(r.status,'blocked');
  assert.ok(r.remainingBlockers.some(x=>x.ruleId==='C05-DEPOSIT'));
});
test('rounded financing lot exceeds the exact mathematical gap by 17 yuan',()=>{
  const r=assess(setup({financing:20*E+17}));
  assert.equal(r.status,'ok');
  assert.equal(r.nextTradeRequirement.mathematicalAdditionalFinancingYuan,6*E-17);
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,6*E);
  assert.equal(r.financing.unitYuan,1000000);
  assert.ok(r.nextTradeRequirement.projectedC02Ratio>.05);
});
test('known existing financing capacity below the needed amount cannot be claimed feasible',()=>{
  const r=assess(setup({financingTarget:24*E}));assert.equal(r.status,'blocked');
  // The smaller target also leaves the sale unarranged in this proposal.
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,8*E);
  assert.equal(r.financing.availableCapacityYuan,4*E);
  assert.ok(r.remainingBlockers.some(x=>x.kind==='financing_capacity'));
});
test('unknown send result gives no confident next-trade amount',()=>{
  const m=createModel();m.startFromTemplate(createDefaultInitialTemplate());m.generateProposal();m.approveProposal();
  m.sendBatch(null,{receiptMode:'unknown',stopAtIndex:0});
  const r=assess(m);assert.equal(r.status,'insufficient_data');
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,null);
});
test('target already dispatched is not offered as another fresh deposit',()=>{
  const m=setup({financing:26*E});m.refreshSnapshot();
  const plan=m.getState().plans.find(x=>x.businessType==='deposit'&&x.label.includes('广州'));
  m.recalculateDispatchBatch([{planId:plan.planId,nominalYuan:3*E}]);m.approveProposal();m.send();
  const r=assess(m);assert.equal(r.status,'blocked');
  assert.ok(r.remainingBlockers.some(x=>x.kind==='target_in_flight'));
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,null);
});
test('completed target reports no next dispatch rather than a manufactured funding need',()=>{
  const m=setup({financing:26*E});m.refreshSnapshot();
  const plan=m.getState().plans.find(x=>x.businessType==='deposit'&&x.label.includes('广州'));
  m.recalculateDispatchBatch([{planId:plan.planId,nominalYuan:3*E}]);m.approveProposal();
  const sent=m.send();m.simulateEvent('accepted',{instructionId:sent.sentInstructionId});
  m.simulateEvent('fill',{instructionId:sent.sentInstructionId,nominalYuan:3*E});
  const r=assess(m);assert.equal(r.status,'complete');
});
test('unknown NAV is not a zero gap',()=>{
  const m=createModel(),template=createDefaultInitialTemplate();template.portfolio.navYuan=null;
  m.startFromTemplate(template);const r=assess(m);assert.equal(r.status,'insufficient_data');
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,null);
});
test('tool requires an exact existing plan ID and rejects surplus fields',()=>{
  const m=setup(),t=createPlanningTools(JSON.parse(m.serialize()),{requestId:'bad',documentRevision:1});
  assert.equal(t.execute('assess_next_trade_funding',{planId:'fake'}).status,'invalid_intent');
  assert.equal(t.execute('assess_next_trade_funding',{planId:t.context.plans[0].planId,amountYuan:E}).status,'invalid_intent');
});

test('unarranged existing financing is verified by calculation, send and fill on the private model',()=>{
  const m=createModel();m.startFromTemplate(createDefaultInitialTemplate());
  const r=assess(m,'江南');
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,27*E);
  assert.equal(r.financing.verifiedFillYuan,27*E);
  assert.ok(r.financing.allocations.some(x=>x.basis==='hypothetical_new_instruction_within_existing_target'));
});
test('multiple incomplete financing targets do not silently choose an allocation',()=>{
  const m=setup({financing:0,sale:0,templateChange:t=>{
    t.draftPlans.push({...structuredClone(t.draftPlans.find(x=>x.businessType==='interbank_repo_financing')),label:'第二笔融资'});
  }});
  const r=assess(m);assert.equal(r.status,'unsupported');
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,null);
});

test('C02 financing fills do not invent cash receipts when actual account payment is insufficient',()=>{
  const m=setup({templateChange:t=>{
    // Move four yi from opening cash into an eligible government-bond holding.
    // This preserves NAV, complete term weights and the current C02 numerator,
    // while the actual payment account contains only one yi.
    t.portfolio.accountCashYuan=E;
    t.termWeights.assets.find(x=>x.sourceAccountCash).amountYuan=E;
    const holding=t.holdings.find(x=>x.securityId==='SIM-GOV-30');
    holding.amountYuan+=4*E;holding.sellableYuan+=4*E;
    t.termWeights.assets.find(x=>x.sourceHoldingId===holding.holdingId).amountYuan=holding.amountYuan;
  }});
  const r=assess(m);
  assert.equal(r.status,'blocked');
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,6*E);
  assert.equal(r.financing.verifiedFillYuan,6*E);
  assert.equal(r.nextTradeRequirement.projectedC02Ratio,.05);
  assert.equal(r.payment.accountCashYuan,E);
  assert.equal(r.payment.availableForPaymentYuan,E);
  assert.equal(r.payment.shortfallYuan,2*E);
  assert.ok(r.remainingBlockers.some(x=>x.kind==='payment_receipt'&&x.amountYuan===2*E));
  assert.equal(m.getState().summary.accountCashYuan,E);
});

test('730-day Guangzhou deposit still breaches C09 after its six-yi C02 financing minimum',()=>{
  const r=assess(setup({templateChange:t=>{
    t.securities.find(x=>x.securityId==='SIM-GZ-DEP-NEW').remainingTradingDays=730;
  }}));
  assert.equal(r.status,'blocked');
  assert.equal(r.nextTradeRequirement.additionalFinancingFillYuan,6*E);
  assert.equal(r.financing.verifiedFillYuan,6*E);
  assert.equal(r.nextTradeRequirement.projectedC02Ratio,.05);
  assert.equal(r.payment.shortfallYuan,0);
  const c09=r.projectedTargetRules.find(x=>x.ruleId==='C09');
  assert.equal(c09.result,'block');assert.ok(c09.projectedValue>90);
  assert.ok(r.remainingBlockers.some(x=>x.kind==='core_rule'&&x.ruleId==='C09'));
});
