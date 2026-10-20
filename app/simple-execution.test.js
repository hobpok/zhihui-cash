import test from 'node:test';
import assert from 'node:assert/strict';
import { newExecution, registerCashEvent, registerSend, registerCancel, applyEvent,
  executionSummary, validateExecution } from './execution.js';
import { createModel, validateSaved } from './model.js';
import { createSyntheticInitialTemplate, openingAccountCash } from './initial-data.js';
import { evaluateCoreRules } from './core-rules.js';

const date = '2026-09-07';
const simple = 'single-day-principal-v1';
const event = (n, type, instructionId, fields = {}) =>
  ({ eventId:`E-${n}`, sourceSequence:n, type, instructionId, ...fields });

test('single-day maturity settles only in full and migrates business cash into account cash once', () => {
  const maturity = { eventId:'MAT', label:'到期', kind:'deposit_maturity', direction:'inflow',
    amountYuan:200, dueDate:date, includedInOpeningCash:false };
  let ledger = newExecution(300,[maturity],simple);
  assert.equal(executionSummary(ledger,[],{businessDate:date}).availableYuan,500);
  assert.throws(() => registerCashEvent(ledger,{eventId:'R1',sourceId:'MAT',amountYuan:100},date),/整笔/);
  ledger = registerCashEvent(ledger,{eventId:'R1',sourceId:'MAT',amountYuan:200},date).execution;
  assert.deepEqual([executionSummary(ledger,[],{businessDate:date}).accountCashYuan,
    executionSummary(ledger,[],{businessDate:date}).availableYuan],[500,500]);
  assert.equal(registerCashEvent(ledger,{eventId:'R1',sourceId:'MAT',amountYuan:200},date).result,'duplicate');
  assert.equal(validateExecution(ledger,[]),true);
});

test('single-day maturity payment also requires the full amount and actual account cash', () => {
  const maturity = {eventId:'MAT-OUT',label:'到期应付',kind:'repo_maturity',direction:'outflow',
    amountYuan:200,dueDate:date,includedInOpeningCash:false};
  let ledger = newExecution(100,[maturity],simple);
  assert.equal(executionSummary(ledger,[],{businessDate:date}).availableYuan,-100);
  assert.throws(() => registerCashEvent(ledger,{eventId:'PART',sourceId:'MAT-OUT',amountYuan:100},date),/整笔/);
  assert.throws(() => registerCashEvent(ledger,{eventId:'FULL',sourceId:'MAT-OUT',amountYuan:200},date),/账户现金不足/);
  ledger = applyEvent(ledger,event(1,'cash_available',null,
    {cashFlowId:'FUND',amountYuan:100,syntheticFunding:true})).execution;
  ledger = registerCashEvent(ledger,{eventId:'FULL',sourceId:'MAT-OUT',amountYuan:200},date).execution;
  assert.deepEqual([executionSummary(ledger,[],{businessDate:date}).accountCashYuan,
    executionSummary(ledger,[],{businessDate:date}).availableYuan],[0,0]);
});

test('single-day repo fill ignores exchange clock; cancellation keeps filled principal without pledge evidence', () => {
  const repoTerms = {market:'SSE',tenorDays:5,annualRate:null};
  const plan = {planId:'REPO',businessType:'exchange_repo_financing',direction:'inflow',
    targetYuan:2000,tradeDate:date,settlementDate:date,repoTerms};
  const sent = registerSend(newExecution(300,[],simple),{stepId:'S',nominalYuan:2000},plan,'AP',
    {time:'23:00:00',isTradingDay:false});
  let ledger = applyEvent(sent.execution,event(1,'accepted',sent.instructionId)).execution;
  ledger = applyEvent(ledger,event(2,'fill',sent.instructionId,
    {fillId:'F',nominalYuan:1000,tradeTime:'23:00:01'})).execution;
  const cancel = registerCancel(ledger,sent.instructionId); ledger = cancel.execution;
  const receipt = {cancelRequestId:cancel.cancelRequestId,cancelSliceId:'C',nominalYuan:1000,
    reservationId:sent.instructionId,releaseYuan:1000};
  ledger = applyEvent(ledger,event(3,'cancel_confirmed',sent.instructionId,
    {...receipt,nominalConfirmed:true})).execution;
  ledger = applyEvent(ledger,event(4,'cancel_confirmed',sent.instructionId,
    {...receipt,releaseConfirmed:true})).execution;
  const result = executionSummary(ledger,[plan]);
  assert.equal(result.financingPrincipalYuan,1000);
  assert.equal(result.planBalances[0].lockedYuan,0);
  assert.equal(result.pledgeUsedByMarket.SSE,0);
  assert.equal(result.quotaUsedByMarket.SSE,0); // Deprecated compatibility alias, never a financing constraint.
  assert.equal(validateExecution(ledger,[plan]),true);
});

test('two filled repos immediately improve business cash and C02; receipts only migrate actual cash', () => {
  const template = createSyntheticInitialTemplate({businessDate:date});
  template.pendingSettlements = [];
  const buy = {...template.draftPlans.find(p => p.businessType === 'bond_buy'),
    planId:'BUY',targetYuan:400000000};
  const repos = [1000000000,500000000].map((targetYuan,index) => ({
    planId:`FIN-${index+1}`,label:`融资${index+1}`,businessType:'interbank_repo_financing',
    direction:'inflow',targetYuan,tradeDate:date,settlementDate:date,
    repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null},securityId:null,
  }));
  const plans = [buy,...repos];
  let ledger = newExecution(openingAccountCash(template),template.maturityCashEvents,simple);
  ledger = registerSend(ledger,{stepId:'BUY',nominalYuan:buy.targetYuan},buy,'AP-BUY').execution;
  const ids = [];
  for (const [index,repo] of repos.entries()) {
    const sent = registerSend(ledger,{stepId:`FIN-${index+1}`,nominalYuan:repo.targetYuan},repo,`AP-${index+1}`);
    ledger = sent.execution;
    ids.push(sent.instructionId);
  }
  let sequence = 0;
  const report = (type,instructionId,fields={}) => {
    ledger = applyEvent(ledger,event(++sequence,type,instructionId,fields)).execution;
  };
  const check = (account,available,financing,cashNumerator,termDenominator) => {
    const summary = executionSummary(ledger,plans,{businessDate:date});
    const state = {initialData:template,plans,context:{businessDate:date},execution:ledger,summary};
    const rows = evaluateCoreRules(state).rows;
    const c02 = rows.find(r => r.ruleId === 'C02');
    const c09 = rows.find(r => r.ruleId === 'C09');
    assert.deepEqual([summary.accountCashYuan,summary.availableYuan,summary.financingPrincipalYuan],
      [account,available,financing]);
    assert.deepEqual([c02.numeratorYuan,c02.denominatorYuan,c09.denominatorYuan],
      [cashNumerator,50000000000,termDenominator]);
    assert.equal(c09.result,'pass');
  };
  check(300000000,100000000,0,2600000000,50000000000);
  for (const [index,repo] of repos.entries()) {
    report('accepted',ids[index]);
    report('fill',ids[index],{fillId:`FILL-${index+1}`,nominalYuan:repo.targetYuan});
  }
  check(300000000,1600000000,1500000000,4100000000,51500000000);
  report('cash_settled',ids[0],{cashFlowId:'SETTLED-1',amountYuan:repos[0].targetYuan});
  check(300000000,1600000000,1500000000,4100000000,51500000000);
  report('cash_available',ids[0],{cashFlowId:'AVAILABLE-1',amountYuan:repos[0].targetYuan});
  check(1300000000,1600000000,1500000000,4100000000,51500000000);
  report('cash_available',ids[1],{cashFlowId:'AVAILABLE-2',amountYuan:repos[1].targetYuan});
  check(1800000000,1600000000,1500000000,4100000000,51500000000);
  assert.equal(validateExecution(ledger,plans),true);
});

test('reverse repo reserves cash on send and becomes a receivable on fill without creating inflow', () => {
  const template = createSyntheticInitialTemplate({businessDate:date});
  template.pendingSettlements = [];
  const plan = {planId:'REVERSE',label:'逆回购',businessType:'exchange_repo_lending',
    direction:'outflow',targetYuan:100000000,tradeDate:date,settlementDate:date,
    repoTerms:{market:'SSE',tenorDays:7,annualRate:null},securityId:null};
  let ledger = newExecution(openingAccountCash(template),template.maturityCashEvents,simple);
  const sent = registerSend(ledger,{stepId:'REVERSE',nominalYuan:plan.targetYuan},plan,'AP-REVERSE');
  ledger = sent.execution;
  const assess = () => {
    const summary = executionSummary(ledger,[plan],{businessDate:date});
    const state = {initialData:template,plans:[plan],context:{businessDate:date},execution:ledger,summary};
    const rows = evaluateCoreRules(state).rows;
    return {summary,c02:rows.find(r=>r.ruleId==='C02'),c09:rows.find(r=>r.ruleId==='C09')};
  };
  const sentState = assess();
  assert.deepEqual([sentState.summary.accountCashYuan,sentState.summary.availableYuan,
    sentState.c02.numeratorYuan,sentState.summary.reverseRepoReceivableYuan],
    [300000000,400000000,2900000000,0]);
  ledger = applyEvent(ledger,event(1,'accepted',sent.instructionId)).execution;
  ledger = applyEvent(ledger,event(2,'fill',sent.instructionId,
    {fillId:'REVERSE-FILL',nominalYuan:plan.targetYuan})).execution;
  const filled = assess();
  assert.deepEqual([filled.summary.accountCashYuan,filled.summary.availableYuan,
    filled.c02.numeratorYuan,filled.summary.reverseRepoReceivableYuan],
    [300000000,400000000,2900000000,100000000]);
  assert.equal(filled.c09.denominatorYuan,sentState.c09.denominatorYuan);
  assert.equal(filled.c09.numeratorYuan,sentState.c09.numeratorYuan);
  assert.throws(() => applyEvent(ledger,event(3,'cash_available',sent.instructionId,
    {cashFlowId:'INVALID-INFLOW',amountYuan:plan.targetYuan})),/流入指令/);
  ledger = applyEvent(ledger,event(3,'cash_settled',sent.instructionId,
    {cashFlowId:'REVERSE-PAY',amountYuan:plan.targetYuan})).execution;
  const paid = assess();
  assert.deepEqual([paid.summary.accountCashYuan,paid.summary.availableYuan,
    paid.c02.numeratorYuan,paid.summary.reverseRepoReceivableYuan],
    [200000000,400000000,2900000000,100000000]);
  assert.equal(validateExecution(ledger,[plan]),true);
});

test('new template uses signed net subscriptions and opening receipts while preserving base cash', () => {
  const template = createSyntheticInitialTemplate({businessDate:date});
  assert.equal(template.demoMode,simple);
  assert.equal(template.portfolio.accountCashYuan,300000000);
  assert.equal(openingAccountCash(template),template.portfolio.accountCashYuan +
    template.portfolio.netSubscriptionYuan + template.maturityCashEvents
      .filter(x => x.dueDate === date && x.includedInOpeningCash)
      .reduce((n,x) => n + (x.direction === 'inflow' ? x.amountYuan : -x.amountYuan),0));
  const model = createModel(); const state = model.startFromTemplate(template);
  assert.equal(state.execution.demoMode,simple);
  assert.equal(state.execution.initialCashYuan,openingAccountCash(template));
  assert.equal(validateSaved(model.serialize()).ok,true);
  assert.equal(createModel(model.serialize()).getState().execution.demoMode,simple);
});

test('single-day model rejects future plan settlement and projects all plans regardless of blockers', () => {
  const template = createSyntheticInitialTemplate({businessDate:date});
  template.draftPlans = [];
  const model = createModel(); model.startFromTemplate(template);
  assert.throws(() => model.addPlan({label:'未来交收',businessType:'deposit',direction:'outflow',
    counterpartyId:'BANK-A',issuerId:'BANK-A',targetYuan:1000000,termsNote:'',repoTerms:null,
    tradeDate:date,settlementDate:'2026-09-08',securityId:'DEP-A',marketTier:null}),/当日|交收/);
  const before = model.getState().summary.availableYuan;
  model.addPlan({label:'超出账户计划',businessType:'bond_buy',direction:'outflow',
    counterpartyId:null,issuerId:null,targetYuan:before + 1000000,termsNote:'',repoTerms:null,
    tradeDate:date,settlementDate:date,securityId:'BOND-X',marketTier:'secondary'});
  const state = model.getState();
  assert.equal(state.summary.projectedEndOfDayYuan.balanceYuan,-1000000);
  assert.equal(state.summary.projectedEndOfDayYuan.unconfirmedOutflowYuan,before + 1000000);
});

test('same-day bought security becomes sellable only after its purchase payment settles', () => {
  const template = createSyntheticInitialTemplate({businessDate:date});
  template.holdings.find(h => h.holdingId === 'H-BOND-X').sellableYuan = 0;
  const buy = template.draftPlans.find(p => p.businessType === 'bond_buy');
  template.draftPlans = [{...buy,settlementDate:date,targetYuan:1000000}];
  const model = createModel(); model.startFromTemplate(template);
  model.generateProposal(); model.approveProposal();
  const step = model.getState().proposal.steps[0];
  const id = model.send(step.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:id});
  model.simulateEvent('fill',{instructionId:id,nominalYuan:1000000});
  const sale = {...buy,label:'卖出刚买入的债券',businessType:'bond_sell',direction:'inflow',targetYuan:1000000};
  model.addPlan(sale); model.generateProposal(); model.approveProposal();
  const saleStep = model.getState().proposal.steps.find(x => x.planId !== step.planId);
  assert.equal(model.getState().stepReadiness.find(x => x.stepId === saleStep.stepId).ready,false);
  model.simulateEvent('cash_settled',{instructionId:id,amountYuan:1000000,cashFlowId:'BUY-PAY'});
  model.generateProposal(); model.approveProposal();
  const paidStep = model.getState().proposal.steps.find(x => x.planId !== step.planId);
  assert.equal(model.getState().stepReadiness.find(x => x.stepId === paidStep.stepId).ready,true);
});

test('a matured holding cannot also fund a security sale', () => {
  const template = createSyntheticInitialTemplate({businessDate:date});
  template.maturityCashEvents.push({eventId:'MAT-CD-C',label:'存单到期',kind:'security_redemption',
    direction:'inflow',amountYuan:100000000,dueDate:date,includedInOpeningCash:false,
    sourceHoldingId:'H-CD-C'});
  template.securities.find(s => s.securityId === 'CD-C').remainingTradingDays = 0;
  template.termWeights.assets.find(w => w.weightId === 'TW-CD-C').remainingTradingDays = 0;
  const sale = template.draftPlans.find(p => p.businessType === 'cd_sell');
  template.draftPlans = [{...sale,securityId:'CD-C',issuerId:'BANK-C',targetYuan:1000000}];
  const model = createModel(); model.startFromTemplate(template);
  model.generateProposal(); model.approveProposal();
  const step = model.getState().proposal.steps[0];
  assert.equal(model.getState().stepReadiness.find(x => x.stepId === step.stepId).ready,false);
  assert.match(model.getState().stepReadiness.find(x => x.stepId === step.stepId).reason,/可卖/);
});

test('opening purchase already paid but absent from holdings is sellable today', () => {
  const template = createSyntheticInitialTemplate({businessDate:date});
  template.holdings.find(h => h.holdingId === 'H-CD-B').sellableYuan = 0;
  const pending = template.pendingSettlements.find(x => x.tradeId === 'SECONDARY-CD-B');
  pending.holdingIncludedAtOpen = false;
  pending.cashIncludedAtOpen = true;
  const sale = template.draftPlans.find(p => p.businessType === 'cd_sell');
  template.draftPlans = [{...sale,targetYuan:1000000}];
  const model = createModel(); model.startFromTemplate(template);
  model.generateProposal(); model.approveProposal();
  const step = model.getState().proposal.steps[0];
  assert.equal(model.getState().stepReadiness.find(x => x.stepId === step.stepId).ready,true);
});

test('single-day repo ignores legacy quota, pledge, annual rate, and exchange hours', () => {
  const template = createSyntheticInitialTemplate({businessDate:date});
  template.draftPlans = [{label:'当日融资',businessType:'exchange_repo_financing',direction:'inflow',
    counterpartyId:null,issuerId:null,targetYuan:1000000,termsNote:'',
    repoTerms:{market:'SSE',tenorDays:5,annualRate:null},tradeDate:date,settlementDate:date,
    securityId:null,marketTier:null}];
  template.financingResources.SSE.pledgeConfirmedYuan = null;
  template.financingResources.SSE.quotaConfirmedYuan = 0;
  const model = createModel(); model.startFromTemplate(template);
  assert.throws(() => model.updatePlan(model.getState().plans[0].planId,
    {repoTerms:{market:'SSE',tenorDays:5,annualRate:'0.02'}}),/不计利息/);
  model.setMarketClock({time:'23:00:00',isTradingDay:false});
  model.generateProposal(); model.approveProposal();
  const state = model.getState();
  assert.equal(state.stepReadiness[0].ready,true);
  assert.equal(state.calculation.trace.diagnostics.some(x => /质押|时段|窗口/.test(x.message)),false);
  assert.equal(state.calculation.trace.assumptions.some(x => /利息/.test(x)),false);
  const longRepo = structuredClone(template);
  longRepo.draftPlans[0].repoTerms.tenorDays = 4001;
  const longModel = createModel(); longModel.startFromTemplate(longRepo);
  assert.equal(validateSaved(longModel.serialize()).ok,true);
});

test('single-day partial exchange financing improves business cash once; payment waits for actual receipt', () => {
  const financing={planId:'FIN',businessType:'exchange_repo_financing',direction:'inflow',targetYuan:200000000,
    tradeDate:date,settlementDate:date,repoTerms:{market:'SSE',tenorDays:7,annualRate:null}};
  const buy={planId:'BUY',businessType:'reverse_repo',direction:'outflow',targetYuan:100000000,
    tradeDate:date,settlementDate:date,repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}};
  const plans=[financing,buy];
  let ledger=newExecution(0,[],simple),seq=0;
  const sent=registerSend(ledger,{stepId:'FIN',nominalYuan:200000000},financing,'AP');ledger=sent.execution;
  const report=(type,id,fields={})=>{const e=event(seq+1,type,id,fields);const result=applyEvent(ledger,e);seq++;ledger=result.execution;return {e,result};};
  report('accepted',sent.instructionId);
  assert.equal(executionSummary(ledger,plans,{businessDate:date}).availableYuan,0);
  report('fill',sent.instructionId,{fillId:'F-1',nominalYuan:100000000});
  assert.deepEqual([executionSummary(ledger,plans,{businessDate:date}).availableYuan,
    executionSummary(ledger,plans,{businessDate:date}).accountCashYuan],[100000000,0]);
  const purchase=registerSend(ledger,{stepId:'BUY',nominalYuan:100000000},buy,'AP');ledger=purchase.execution;
  report('accepted',purchase.instructionId);report('fill',purchase.instructionId,{fillId:'B-1',nominalYuan:100000000});
  assert.throws(()=>applyEvent(ledger,event(seq+1,'cash_settled',purchase.instructionId,
    {cashFlowId:'EARLY-PAY',amountYuan:100000000})),/实际账户现金不足/);
  const received=report('cash_available',sent.instructionId,{cashFlowId:'R-1',amountYuan:50000000});
  assert.deepEqual([executionSummary(ledger,plans,{businessDate:date}).availableYuan,
    executionSummary(ledger,plans,{businessDate:date}).accountCashYuan],[0,50000000]);
  assert.equal(applyEvent(ledger,received.e).result,'duplicate');
  report('cash_available',sent.instructionId,{cashFlowId:'R-2',amountYuan:50000000});
  report('cash_settled',purchase.instructionId,{cashFlowId:'PAY',amountYuan:100000000});
  assert.deepEqual([executionSummary(ledger,plans,{businessDate:date}).availableYuan,
    executionSummary(ledger,plans,{businessDate:date}).accountCashYuan],[0,0]);
  report('fill',sent.instructionId,{fillId:'F-2',nominalYuan:100000000});
  assert.deepEqual([executionSummary(ledger,plans,{businessDate:date}).availableYuan,
    executionSummary(ledger,plans,{businessDate:date}).accountCashYuan],[100000000,0]);
  assert.equal(validateExecution(ledger,plans),true);
});
