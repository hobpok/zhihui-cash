import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyntheticInitialTemplate,normalizeInitialTemplate,openingAccountCash} from './initial-data.js';
import {evaluateCoreRules} from './core-rules.js';
import {newExecution,registerCashEvent,registerSend,applyEvent,executionSummary,validateExecution} from './execution.js';
import {calculateFunding,calculateSplit} from './engine.js';
import {runLifecycle} from '../scripts/robustness-lifecycle.mjs';

const Y=100000000;
function fixture(){
  const t=createSyntheticInitialTemplate();
  t.portfolio.navYuan=500*Y;t.portfolio.accountCashYuan=5*Y;
  t.holdings=[];t.pendingSettlements=[];t.draftPlans=[];
  t.termWeights.assets=[
    {weightId:'C',label:'基础现金',amountYuan:5*Y,remainingTradingDays:0,sourceAccountCash:true},
    {weightId:'A',label:'存续资产',amountYuan:520*Y,remainingTradingDays:100},
  ];
  t.termWeights.liabilities=[{weightId:'L',label:'今日到期负债',amountYuan:25*Y,remainingTradingDays:0}];
  t.termWeights.positiveRepos=[{weightId:'R',label:'今日到期正回购',amountYuan:25*Y,remainingTradingDays:0}];
  t.maturityCashEvents=[{eventId:'MAT',label:'正回购今日到期未付',kind:'repo_maturity',direction:'outflow',
    amountYuan:25*Y,dueDate:t.businessDate,includedInOpeningCash:false,
    sourceLiabilityWeightId:'L',sourcePositiveRepoWeightId:'R'}];
  return normalizeInitialTemplate(t);
}
const financing=t=>({planId:'FIN',label:'新融资',businessType:'interbank_repo_financing',direction:'inflow',
  targetYuan:80*Y,tradeDate:t.businessDate,settlementDate:t.businessDate,securityId:null,
  repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}});
const state=(t,e,plans=[])=>({initialData:t,execution:e,plans,context:{businessDate:t.businessDate},
  summary:executionSummary(e,plans,{businessDate:t.businessDate})});
const rule=(s,id,options={})=>evaluateCoreRules(s,options).rows.find(r=>r.ruleId===id);

test('linked maturity enters business C09 at opening; financing candidate can cover negative C01 without crediting actual cash',()=>{
  const t=fixture(),e=newExecution(openingAccountCash(t),t.maturityCashEvents,t.demoMode),s=state(t,e);
  assert.equal(s.summary.availableYuan,-20*Y);
  assert.equal(s.summary.accountCashYuan,5*Y);
  assert.equal(rule(s,'C09').denominatorYuan,500*Y);
  assert.equal(rule(s,'C09').numeratorYuan,52000*Y);
  const p=financing(t),before=JSON.stringify(e);
  assert.equal(rule(s,'C01',{plan:p,amountYuan:20*Y}).projectedValue,0);
  assert.equal(rule(s,'C01',{plan:p,amountYuan:20*Y}).result,'pass');
  assert.equal(rule(s,'C01',{plan:p,amountYuan:20*Y-1}).result,'warn');
  assert.equal(rule(s,'C01',{plan:p,amountYuan:20*Y-1}).projectedValue,-1);
  assert.equal(rule(s,'C09',{plan:p,amountYuan:80*Y}).denominatorYuan,580*Y);
  assert.equal(JSON.stringify(e),before);
  assert.equal(s.summary.accountCashYuan,5*Y);
});

test('send/accept do not finance; partial fill enters term/business once; actual funding is required before maturity payment',()=>{
  const t=fixture(),p=financing(t),plans=[p];
  let e=newExecution(openingAccountCash(t),t.maturityCashEvents,t.demoMode),n=0;
  const sent=registerSend(e,{stepId:'FIN',nominalYuan:p.targetYuan},p,'AP');e=sent.execution;
  const report=(type,fields={})=>{e=applyEvent(e,{eventId:`E${++n}`,sourceSequence:n,type,
    instructionId:sent.instructionId,...fields}).execution;};
  assert.equal(rule(state(t,e,plans),'C09').denominatorYuan,500*Y);
  report('accepted');
  assert.equal(state(t,e,plans).summary.availableYuan,-20*Y);
  assert.equal(rule(state(t,e,plans),'C09').denominatorYuan,500*Y);
  report('fill',{fillId:'F1',nominalYuan:40*Y});
  let s=state(t,e,plans);
  assert.equal(s.summary.availableYuan,20*Y);assert.equal(s.summary.accountCashYuan,5*Y);
  assert.equal(rule(s,'C09').denominatorYuan,540*Y);
  const pay={eventId:'PAY',sourceId:'MAT',amountYuan:25*Y};
  assert.throws(()=>registerCashEvent(e,pay,t.businessDate),/账户现金不足/);
  report('cash_available',{cashFlowId:'FUND',amountYuan:40*Y});
  const before=rule(state(t,e,plans),'C09');
  e=registerCashEvent(e,pay,t.businessDate).execution;
  s=state(t,e,plans);
  assert.equal(s.summary.accountCashYuan,20*Y);assert.equal(s.summary.availableYuan,20*Y);
  assert.equal(rule(s,'C09').denominatorYuan,before.denominatorYuan);
  assert.equal(rule(s,'C09').numeratorYuan,before.numeratorYuan);
  assert.equal(registerCashEvent(e,pay,t.businessDate).result,'duplicate');
  assert.throws(()=>registerCashEvent(e,{...pay,eventId:'SECOND'},t.businessDate),/超过来源金额/);
  assert.equal(validateExecution(e,plans),true);
});

test('maturity associations reject missing, duplicate, wrong kind/direction/amount/term links',()=>{
  const t=fixture();
  for(const change of [
    x=>{delete x.maturityCashEvents[0].sourceLiabilityWeightId;},
    x=>{x.maturityCashEvents[0].sourcePositiveRepoWeightId='UNKNOWN';},
    x=>{x.maturityCashEvents[0].direction='inflow';},
    x=>{x.maturityCashEvents[0].kind='deposit_maturity';},
    x=>{x.maturityCashEvents[0].amountYuan--;},
    x=>{x.termWeights.liabilities[0].remainingTradingDays=1;},
    x=>{x.termWeights.positiveRepos[0].remainingTradingDays=1;},
    x=>{x.maturityCashEvents.push({...x.maturityCashEvents[0],eventId:'DUP'});},
  ]){const x=structuredClone(t);change(x);assert.throws(()=>normalizeInitialTemplate(x));}
});

test('unassociated old maturity preserves its term meaning and is never inferred as repaid',()=>{
  const t=fixture();delete t.maturityCashEvents[0].sourceLiabilityWeightId;delete t.maturityCashEvents[0].sourcePositiveRepoWeightId;
  normalizeInitialTemplate(t);
  const s=state(t,newExecution(5*Y,t.maturityCashEvents,t.demoMode));
  assert.equal(rule(s,'C09').denominatorYuan,525*Y);
  assert.equal(s.summary.accountCashYuan,5*Y);
  assert.equal(Object.keys(s.execution.cashEventReceipts).length,0);
});

test('an opening-paid linked maturity retires weights once and still requires sufficient opening account cash',()=>{
  const t=fixture();t.maturityCashEvents[0].includedInOpeningCash=true;
  assert.throws(()=>normalizeInitialTemplate(t),/日初净赎回\/到期付款超过/);
  t.portfolio.accountCashYuan=30*Y;t.termWeights.assets[0].amountYuan=30*Y;
  t.termWeights.assets[1].amountYuan=495*Y;
  normalizeInitialTemplate(t);
  const e=newExecution(openingAccountCash(t),t.maturityCashEvents,t.demoMode),s=state(t,e);
  assert.equal(s.summary.accountCashYuan,5*Y);assert.equal(s.summary.availableYuan,5*Y);
  assert.equal(rule(s,'C09').denominatorYuan,500*Y);
  assert.throws(()=>registerCashEvent(e,{eventId:'AGAIN',sourceId:'MAT',amountYuan:25*Y},t.businessDate),/期初已计入/);
});

test('negative business balances retain the full funding deficit and cannot create an outflow slice',()=>{
  const input={initialYuan:-20*Y,availableFundingYuan:0,lockedOutflowYuan:0,
    remainingOutflowYuan:10*Y,expectedSaleYuan:Y,feeYuan:0,bufferYuan:0};
  assert.deepEqual(calculateFunding(input),{currentAvailableYuan:-20*Y,baseNetGapYuan:29*Y,
    noSaleTimingGapYuan:30*Y,allInGapYuan:29*Y,allInResult:'known'});
  assert.throws(()=>calculateFunding({...input,availableFundingYuan:-1}),/非负/);
  const split=calculateSplit({targetYuan:10*Y,filledYuan:0,lockedYuan:0,availableYuan:-20*Y,feeYuan:0,bufferYuan:0});
  assert.equal(split.proposedNowYuan,0);assert.equal(split.result,'waiting');
});

test('two linked maturities retire distinct opening repos and remain independent during actual payment',()=>{
  const t=fixture();t.portfolio.accountCashYuan=30*Y;
  t.termWeights.assets[0].amountYuan=30*Y;t.termWeights.assets[1].amountYuan=495*Y;
  t.termWeights.liabilities=[];t.termWeights.positiveRepos=[];t.maturityCashEvents=[];
  for(const [i,n] of [10,15].entries()){
    t.termWeights.liabilities.push({weightId:`L${i}`,label:'到期负债',amountYuan:n*Y,remainingTradingDays:0});
    t.termWeights.positiveRepos.push({weightId:`R${i}`,label:'到期正回购',amountYuan:n*Y,remainingTradingDays:0});
    t.maturityCashEvents.push({eventId:`M${i}`,label:'逐笔到期',kind:'repo_maturity',direction:'outflow',
      amountYuan:n*Y,dueDate:t.businessDate,includedInOpeningCash:false,
      sourceLiabilityWeightId:`L${i}`,sourcePositiveRepoWeightId:`R${i}`});
  }
  normalizeInitialTemplate(t);
  let e=newExecution(openingAccountCash(t),t.maturityCashEvents,t.demoMode);
  assert.equal(rule(state(t,e),'C09').denominatorYuan,500*Y);
  for(const [i,n] of [10,15].entries()){
    e=registerCashEvent(e,{eventId:`P${i}`,sourceId:`M${i}`,amountYuan:n*Y},t.businessDate).execution;
    assert.equal(rule(state(t,e),'C09').denominatorYuan,500*Y);
    assert.equal(state(t,e).summary.availableYuan,5*Y);
    assert.equal(state(t,e).summary.accountCashYuan,(i===0?20:5)*Y);
  }
});

test('negative-opening model can calculate, approve, finance, receive funds and pay the linked maturity',()=>{
  const t=fixture(),{planId,...draft}=financing(t);
  t.draftPlans=[{...draft,counterpartyId:null,issuerId:null,termsNote:'合成融资',marketTier:null}];
  const result=runLifecycle(t);
  assert.deepEqual(result.blocked,[]);
  assert.equal(result.validationSaved.ok,true);
  assert.equal(result.final.completed,true);
  assert.equal(result.final.cash.accountCashYuan,60*Y);
  assert.equal(result.final.cash.businessAvailableYuan,60*Y);
  assert.equal(result.final.coreRules.find(r=>r.ruleId==='C09').denominatorYuan,580*Y);
  assert.deepEqual(result.final.cashEventReceipts,[{sourceId:'MAT',direction:'outflow',amountYuan:25*Y}]);
});
