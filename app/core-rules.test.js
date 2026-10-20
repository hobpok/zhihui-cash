import test from 'node:test';
import assert from 'node:assert/strict';
import {createLegacySyntheticInitialTemplate as createSyntheticInitialTemplate,legacyInitialTemplate} from './initial-data.js';
import {coreRulesEnabled,evaluateCoreRules} from './core-rules.js';
import {newExecution,registerCashEvent,executionSummary,registerSend,applyEvent} from './execution.js';

const state = () => {
  const initialData=createSyntheticInitialTemplate();
  return {initialData,plans:[],context:{businessDate:initialData.businessDate},
    summary:{availableYuan:350000000},execution:{instructions:{}}};
};
const check=(s,ruleId,subjectId='PORTFOLIO',options={})=>
  evaluateCoreRules(s,options).rows.find(x=>x.ruleId===ruleId&&x.subjectId===subjectId);
const plan=(type,bankId,securityId,direction='outflow',tenorDays=null)=>({
  planId:`P-${type}-${bankId}`,businessType:type,issuerId:bankId,counterpartyId:bankId,
  securityId,direction,repoTerms:tenorDays===null?null:{market:'INTERBANK',tenorDays,annualRate:null},
});

test('C01 reserves at send, equality passes and one yuan short blocks',()=>{
  const s=state(), p=plan('deposit','BANK-A','DEP-A');
  assert.equal(check(s,'C01','PORTFOLIO',{plan:p,amountYuan:350000000}).result,'pass');
  assert.equal(check(s,'C01','PORTFOLIO',{plan:p,amountYuan:350000001}).result,'block');
  assert.equal(check(s,'C01').currentValue,350000000);
});

test('C02 exact five percent, one yuan breach, and strict improvement below floor',()=>{
  const s=state();
  const p=plan('deposit','BANK-A','DEP-A');
  assert.equal(check(s,'C02','PORTFOLIO',{cashYuan:0}).result,'pass');
  assert.equal(check(s,'C02','PORTFOLIO',{cashYuan:-1}).result,'block');
  const sale=plan('bond_sell',null,'BOND-X','inflow');
  s.initialData.portfolio.navYuan=60000000000;
  assert.equal(check(s,'C02','PORTFOLIO',{cashYuan:200000000,plan:sale,amountYuan:1}).result,'warn');
  assert.equal(check(s,'C02','PORTFOLIO',{cashYuan:200000000,plan:p,amountYuan:1}).result,'block');
  assert.equal(check(s,'C01','PORTFOLIO',{cashYuan:0,plan:sale,amountYuan:100000000}).projectedValue,0);
});

test('C02 minimum headroom rounds required yuan upward',()=>{
  const s=state();
  s.initialData.portfolio.navYuan=50000000001;
  const below=check(s,'C02','PORTFOLIO',{cashYuan:0});
  assert.equal(below.result,'block');
  assert.equal(below.headroomYuan,-1);
  const equal=check(s,'C02','PORTFOLIO',{cashYuan:1});
  assert.equal(equal.result,'pass');
  assert.equal(equal.headroomYuan,0);
});

test('C03-C08 apply per bank and use exact cross-product limits',()=>{
  const s=state(), a=plan('deposit','BANK-A','DEP-A'), b=plan('cd_buy','BANK-B','CD-B'),
    c=plan('cd_buy','BANK-C','CD-C');
  const boundaries=[
    ['C03','BANK-B',b,2300000000],
    ['C04','BANK-A',a,8400000000],
    ['C05','BANK-A',a,6700000000],
    ['C06','BANK-A',a,5900000000],
    ['C07','BANK-C',c,800000000],
    ['C08','BANK-C',c,300000000],
  ];
  for(const [id,bank,p,n] of boundaries){
    assert.equal(check(s,id,bank,{plan:p,amountYuan:n}).result,'pass',`${id} equality`);
    assert.equal(check(s,id,bank,{plan:p,amountYuan:n+1}).result,'block',`${id} +1`);
  }
  assert.equal(check(s,'C03','BANK-A').result,'not_applicable');
  assert.equal(check(s,'C04','BANK-B').result,'not_applicable');
  assert.equal(check(s,'C07','BANK-C').result,'pass');
});

test('company denominator, other funds and eligibility missing remain missing',()=>{
  const s=state();
  s.initialData.otherFundBankExposure=s.initialData.otherFundBankExposure.filter(x=>x.bankId!=='BANK-A');
  assert.equal(check(s,'C05','BANK-A').result,'missing');
  s.initialData.banks.find(x=>x.bankId==='BANK-B').custodyQualified=null;
  assert.equal(check(s,'C03','BANK-B').result,'missing');
  s.initialData.banks.find(x=>x.bankId==='BANK-C').quarterlyNetAssetsYuan=null;
  assert.equal(check(s,'C08','BANK-C').result,'missing');
  assert.ok(evaluateCoreRules(s).missing.length>=3);
  s.initialData.banks.find(x=>x.bankId==='BANK-A').quarterEnd='2026-12-31';
  assert.equal(check(s,'C05','BANK-A').result,'missing');
  s.initialData.banks.find(x=>x.bankId==='BANK-C').ratingAsOf='2026-12-31';
  assert.equal(check(s,'C07','BANK-C').result,'missing');
});

test('sent buys reserve full uncancelled nominal; sales release confirmed fills only',()=>{
  const s=state(),buy=plan('cd_buy','BANK-B','CD-B'),sell=plan('cd_sell','BANK-B','CD-B','inflow');
  s.plans=[buy,sell];
  s.execution.instructions={BUY:{planId:buy.planId,status:'unknown',nominalYuan:100000000,
    filledYuan:0,cancelledYuan:0},SELL:{planId:sell.planId,status:'partial',nominalYuan:50000000,
    filledYuan:20000000,cancelledYuan:0}};
  assert.equal(check(s,'C03','BANK-B').numeratorYuan,280000000);
  s.execution.instructions.BUY.status='partial';
  s.execution.instructions.BUY.filledYuan=40000000;
  s.execution.instructions.BUY.cancelledYuan=30000000;
  assert.equal(check(s,'C03','BANK-B').numeratorYuan,250000000);
  s.execution.instructions.BUY.cancelledYuan=60000000;
  assert.equal(check(s,'C03','BANK-B').numeratorYuan,220000000);
  s.execution.instructions.BUY.status='rejected';
  assert.equal(check(s,'C03','BANK-B').numeratorYuan,180000000);
});

test('opening pending holdingIncludedAtOpen prevents double counting',()=>{
  const s=state();
  assert.equal(check(s,'C03','BANK-B').numeratorYuan,200000000);
  s.initialData.pendingSettlements.find(x=>x.tradeId==='SECONDARY-CD-B').holdingIncludedAtOpen=false;
  assert.equal(check(s,'C03','BANK-B').numeratorYuan,250000000);
  assert.equal(check(s,'C04','BANK-A').numeratorYuan,1600000000);
});

test('C09 full weighted formula, equal 90 days, one day-weight above and ledger mismatch',()=>{
  const s=state();
  s.initialData.holdings=[];
  s.initialData.pendingSettlements=[];
  s.initialData.portfolio.navYuan=100;
  s.initialData.portfolio.accountCashYuan=100;
  s.initialData.termWeights={version:'term-weights-1',coverage:'complete',calendar:'weekday-252-demo-v1',asOfDate:s.initialData.businessDate,
    assets:[{weightId:'A',label:'资产',amountYuan:100,remainingTradingDays:90},
      {weightId:'C',label:'现金',amountYuan:100,remainingTradingDays:0,sourceAccountCash:true}],
    liabilities:[{weightId:'L',label:'负债',amountYuan:100,remainingTradingDays:0}],positiveRepos:[]};
  assert.equal(check(s,'C09').result,'pass');
  s.initialData.termWeights.assets[0].remainingTradingDays=91;
  assert.equal(check(s,'C09').result,'block');
  s.initialData.termWeights.liabilities.push({weightId:'L2',label:'负债二',amountYuan:100,remainingTradingDays:1});
  assert.equal(check(s,'C09').result,'missing');
  s.initialData.termWeights.liabilities.pop();
  s.initialData.termWeights.liabilities[0].remainingTradingDays=91;
  s.initialData.termWeights.positiveRepos=[{weightId:'R',label:'正回购调整',amountYuan:100,remainingTradingDays:90}];
  assert.equal(check(s,'C09').result,'missing');
  s.initialData.termWeights.positiveRepos[0].remainingTradingDays=91;
  assert.equal(check(s,'C09').result,'pass');
  assert.equal(check(s,'C09').projectedValue,45.5);
  s.initialData.termWeights.asOfDate='2026-09-08';
  assert.equal(check(s,'C09').result,'missing');
});

test('C09 old template missing and synthetic-only switch leaves legacy rules alone',()=>{
  const s=state(); delete s.initialData.termWeights;
  assert.equal(check(s,'C09').result,'missing');
  const legacy=legacyInitialTemplate({scenarioId:'S10',context:{businessDate:'2026-09-07',portfolioId:'DEMO-500'},
    inputs:{initialCashYuan:0,navYuan:50000000000,bankExposureYuan:null,feeYuan:0,bufferYuan:0},
    plans:[],ruleConfig:{depositThreshold:'0.08',observationThreshold:'0.082'}});
  s.initialData=legacy;
  assert.equal(coreRulesEnabled(s),false);
  assert.deepEqual(evaluateCoreRules(s).rows,[]);
});

test('projected actions affect exposure, but unconfirmed inflow cannot finance the next order',()=>{
  const s=state(),buy=plan('cd_buy','BANK-B','CD-B'),sale=plan('cd_sell','BANK-B','CD-B','inflow');
  const actions=[{plan:sale,amountYuan:100000000}];
  assert.equal(check(s,'C03','BANK-B',{projectedActions:actions}).numeratorYuan,100000000);
  assert.equal(check(s,'C01','PORTFOLIO',{projectedActions:actions,cashYuan:0,plan:buy,amountYuan:1}).result,'block');
});

test('T+1 purchase preserves T0 cash and checks confirmed future date budget',()=>{
  const s=state(), p={...plan('bond_buy',null,'GOV-01'),settlementDate:'2026-09-08'};
  s.summary.dateBalances=[{valueDate:'2026-09-08',availableYuan:100}];
  assert.equal(check(s,'C01','PORTFOLIO',{plan:p,amountYuan:100}).result,'pass');
  assert.equal(check(s,'C02','PORTFOLIO',{plan:p,amountYuan:100}).projectedValue,
    check(s,'C02').currentValue);
  assert.equal(check(s,'C01','PORTFOLIO',{plan:p,amountYuan:101}).result,'block');
  s.summary.dateBalances[0].availableYuan=null;
  assert.equal(check(s,'C01','PORTFOLIO',{plan:p,amountYuan:1}).result,'missing');
});

test('unknown bank identity blocks, while explicit non-bank issuer does not',()=>{
  const s=state(),bankPlan={...plan('cd_buy',null,null),issuerId:null};
  assert.equal(check(s,'C03','UNRESOLVED',{plan:bankPlan,amountYuan:1}).result,'missing');
  const nonBank=plan('bond_buy',null,'BOND-X');
  assert.equal(check(s,'C03','UNRESOLVED',{plan:nonBank,amountYuan:1}),undefined);
  assert.equal(check(s,'C03','BANK-A',{plan:nonBank,amountYuan:1}).result,'not_applicable');
});

test('unrelated unknown bank data stays visible on dashboard but does not block independent bank trade',()=>{
  const s=state();
  s.initialData.banks.find(x=>x.bankId==='BANK-C').rating=null;
  assert.equal(check(s,'C07','BANK-C').result,'missing');
  const p=plan('deposit','BANK-A','DEP-A');
  assert.equal(check(s,'C07','BANK-C',{plan:p,amountYuan:1}).result,'not_applicable');
  assert.equal(evaluateCoreRules(s,{plan:p,amountYuan:1}).missing.length,0);
});

test('C09 confirmed opening CD is added only when absent from opening holdings',()=>{
  const s=state();
  const withPending=BigInt(check(s,'C09').numeratorYuan);
  s.initialData.pendingSettlements.find(x=>x.tradeId==='PRIMARY-CD-A').holdingIncludedAtOpen=true;
  const alreadyIncluded=BigInt(check(s,'C09').numeratorYuan);
  assert.equal(withPending-alreadyIncluded,100000000n*50n);
  assert.equal(check(s,'C04','BANK-A').numeratorYuan,1500000000);
});

test('C09 T+1 sent purchase occupies tenor risk while C01 keeps T0 cash',()=>{
  const s=state(),p={...plan('bond_buy',null,'BOND-X'),settlementDate:'2026-09-08'};
  s.plans=[p];
  const before=BigInt(check(s,'C09').numeratorYuan);
  s.execution.instructions={I:{planId:p.planId,status:'unknown',nominalYuan:100000000,
    filledYuan:0,cancelledYuan:0,settledYuan:0}};
  assert.equal(BigInt(check(s,'C09').numeratorYuan)-before,100000000n*110n);
  assert.equal(check(s,'C01').currentValue,350000000);
  assert.equal(check(s,'C01','PORTFOLIO',{plan:p,amountYuan:1}).projectedValue,350000000);
});

test('C09 sale reduces weighted asset only after fill, without crediting C01 cash',()=>{
  const s=state(),p=plan('cd_sell','BANK-B','CD-B','inflow');
  s.plans=[p];
  const before=BigInt(check(s,'C09').numeratorYuan);
  s.execution.instructions={I:{planId:p.planId,status:'accepted',nominalYuan:50000000,
    filledYuan:0,cancelledYuan:0,settledYuan:0}};
  assert.equal(BigInt(check(s,'C09').numeratorYuan),before);
  s.execution.instructions.I.status='partial';
  s.execution.instructions.I.filledYuan=20000000;
  assert.equal(before-BigInt(check(s,'C09').numeratorYuan),20000000n*80n);
  assert.equal(check(s,'C01').currentValue,350000000);
});

test('C09 financing fill adds matching liability and repo adjustment once',()=>{
  const s=state(),p=plan('interbank_repo_financing',null,null,'inflow',7);
  s.plans=[p];
  const before=check(s,'C09');
  s.execution.instructions={I:{planId:p.planId,status:'partial',nominalYuan:100000000,
    filledYuan:40000000,cancelledYuan:0,settledYuan:0}};
  const after=check(s,'C09');
  assert.equal(BigInt(after.numeratorYuan),BigInt(before.numeratorYuan));
  assert.equal(BigInt(after.denominatorYuan)-BigInt(before.denominatorYuan),40000000n);
  assert.equal(check(s,'C01').currentValue,350000000);
});

test('C02 unreceived government bond purchase cannot fill a 5 percent shortfall',()=>{
  const s=state(),p={...plan('bond_buy',null,'GOV-01'),settlementDate:'2026-09-08'};
  s.plans=[p];
  s.execution.instructions={I:{planId:p.planId,status:'accepted',nominalYuan:100000000,
    filledYuan:0,cancelledYuan:0,settledYuan:0}};
  assert.equal(check(s,'C02','PORTFOLIO',{cashYuan:-1}).result,'block');
  s.execution.instructions.I.filledYuan=100000000;
  assert.equal(check(s,'C02','PORTFOLIO',{cashYuan:-1}).result,'block');
  s.execution.instructions.I.settledYuan=100000000;
  assert.equal(check(s,'C02','PORTFOLIO',{cashYuan:-1}).result,'pass');
});

test('C09 marks partial and complete independent maturity receipts missing while B cash migrates once',()=>{
  const s=state(),t=s.initialData;
  s.execution=newExecution(t.portfolio.accountCashYuan,[...t.maturityCashEvents,...t.pendingSettlements]);
  const refresh=()=>{s.summary=executionSummary(s.execution,s.plans,{businessDate:t.businessDate});};
  refresh();
  const opening=check(s,'C09');
  assert.equal(opening.result,'pass');
  assert.equal(s.summary.availableYuan,350000000);
  for (const [eventId,amountYuan,accountCashYuan] of [['R-PART',50000000,350000000],
    ['R-REST',150000000,500000000]]) {
    s.execution=registerCashEvent(s.execution,{eventId,sourceId:'MAT-T0-DEP-A',amountYuan,
      direction:'inflow'},t.businessDate).execution;
    refresh();
    const c09=check(s,'C09');
    assert.equal(c09.result,'missing');
    assert.ok(c09.needed.some(x=>x.includes(eventId)));
    assert.equal(c09.numeratorYuan,null);
    assert.equal(s.summary.accountCashYuan,accountCashYuan);
    assert.equal(s.summary.availableYuan,350000000);
  }
});

test('C09 marks independent unlinked funding missing and leaves B cash fact intact',()=>{
  const s=state(),t=s.initialData;
  s.execution=newExecution(t.portfolio.accountCashYuan,[...t.maturityCashEvents,...t.pendingSettlements]);
  s.execution=applyEvent(s.execution,{eventId:'EV-FUND',sourceSequence:1,type:'cash_available',
    instructionId:null,syntheticFunding:true,cashFlowId:'FLOW-FUND',amountYuan:100000000}).execution;
  s.summary=executionSummary(s.execution,s.plans,{businessDate:t.businessDate});
  const c09=check(s,'C09');
  assert.equal(c09.result,'missing');
  assert.ok(c09.needed.some(x=>x.includes('FLOW-FUND')));
  assert.equal(s.execution.syntheticFundingYuan,100000000);
  assert.equal(s.summary.accountCashYuan,400000000);
  assert.equal(s.summary.availableYuan,450000000);
});

test('C09 leaves confirmed CD payment and instruction-linked funding outside the unmapped-cash guard',()=>{
  const s=state(),t=s.initialData;
  s.execution=newExecution(t.portfolio.accountCashYuan,[...t.maturityCashEvents,...t.pendingSettlements]);
  s.execution=registerCashEvent(s.execution,{eventId:'CD-PAY',sourceId:'PRIMARY-CD-A',
    amountYuan:100000000,direction:'outflow'},t.businessDate).execution;
  s.summary=executionSummary(s.execution,s.plans,{businessDate:t.businessDate});
  assert.equal(s.summary.accountCashYuan,200000000);
  assert.equal(s.summary.availableYuan,350000000);
  assert.equal(check(s,'C09').result,'pass');
  const p=plan('interbank_repo_financing',null,null,'inflow',7);
  p.targetYuan=100000000;
  s.plans=[p];
  const sent=registerSend(s.execution,{stepId:'FIN-1',nominalYuan:100000000},p,'APPROVAL-1');
  s.execution=sent.execution;
  s.execution=applyEvent(s.execution,{eventId:'FIN-ACCEPT',sourceSequence:1,
    instructionId:sent.instructionId,type:'accepted'}).execution;
  s.execution=applyEvent(s.execution,{eventId:'FIN-FILL',sourceSequence:2,
    instructionId:sent.instructionId,type:'fill',fillId:'FIN-FILL-ID',nominalYuan:100000000}).execution;
  s.execution=applyEvent(s.execution,{eventId:'FIN-CASH',sourceSequence:3,
    instructionId:sent.instructionId,type:'cash_available',cashFlowId:'FIN-FLOW',amountYuan:100000000}).execution;
  s.summary=executionSummary(s.execution,s.plans,{businessDate:t.businessDate});
  assert.equal(s.summary.accountCashYuan,300000000);
  assert.equal(check(s,'C09').result,'pass');
});


test('C09 full repo formula: funding tenor cancels, lending tenor counts, and cash-only funding is insufficient',()=>{
  // Independent synthetic ledger: 490*95 + 2.83*10 = 46578.3 billion-yuan-days.
  // Assets 517.6, liabilities/repos 17.6 -> NAV 500, C09 denominator 517.6.
  const E=100000000, s=state(), t=s.initialData;
  t.holdings=[]; t.pendingSettlements=[]; t.maturityCashEvents=[];
  t.portfolio.navYuan=500*E; t.portfolio.accountCashYuan=2477000000;
  t.termWeights={...t.termWeights,coverage:'complete',asOfDate:t.businessDate,
    assets:[{weightId:'A',label:'A',amountYuan:490*E,remainingTradingDays:95},
      {weightId:'B',label:'B',amountYuan:283000000,remainingTradingDays:10},
      {weightId:'C',label:'C',amountYuan:2477000000,remainingTradingDays:0,sourceAccountCash:true}],
    liabilities:[{weightId:'L',label:'L',amountYuan:1760000000,remainingTradingDays:7}],
    positiveRepos:[{weightId:'R',label:'R',amountYuan:1760000000,remainingTradingDays:7}]};
  t.securities.find(x=>x.securityId==='CD-B').remainingTradingDays=120;
  const buy=plan('cd_buy','BANK-B','CD-B');
  const evaluate=(f,r,fd=1,rd=7)=>check(s,'C09','PORTFOLIO',{projectedActions:[
    {plan:plan('interbank_repo_financing',null,null,'inflow',fd),amountYuan:f},
    {plan:buy,amountYuan:3*E},
    {plan:plan('reverse_repo',null,null,'outflow',rd),amountYuan:r}]});
  assert.equal(check(s,'C09').numeratorYuan,4657830000000);
  assert.equal(check(s,'C09').denominatorYuan,51760000000);
  assert.equal(evaluate(290000000,0).result,'block'); // C02-only funding cannot satisfy C09.
  assert.equal(evaluate(393000000,0).result,'block');
  const main=evaluate(394000000,4000000);
  assert.equal(main.result,'pass');
  assert.equal(main.numeratorYuan,4693858000000);
  assert.equal(main.denominatorYuan,52154000000);
  assert.deepEqual(evaluate(394000000,4000000,7),main);
  assert.equal(evaluate(394000000,5000000).result,'block');
  assert.equal(evaluate(394000000,30000000,1,1).projectedValue,90);
  assert.equal(evaluate(394000000,30000001,1,1).result,'block');
  assert.equal(evaluate(402000000,112000000).result,'block');
  assert.equal(evaluate(403000000,113000000).result,'pass');
});
