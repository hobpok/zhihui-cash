import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyntheticInitialTemplate,normalizeInitialTemplate,bankDepositLimitBps} from './initial-data.js';
import {evaluateCoreRules} from './core-rules.js';
import {createModel,validateSaved} from './model.js';
import {evaluateSelectedSequence} from './engine.js';
import {readPlanningSnapshot,simulateDraft} from './planning.js';
import {metricPresentation} from './metric-display.js';

const E=100000000, gateId='C05-DEPOSIT';
// Independent controlled fixture, deliberately unrelated to the default scenario.
function template(limitBps=600) {
  const t=createSyntheticInitialTemplate();
  t.maturityCashEvents=[];t.pendingSettlements=[];
  t.holdings=t.holdings.filter(h=>h.securityId!=='DEP-A-T0');
  t.holdings.find(h=>h.securityId==='DEP-A').amountYuan=20*E;
  const cd=t.holdings.find(h=>h.securityId==='CD-A');
  cd.amountYuan=19.5*E;cd.sellableYuan=cd.amountYuan;
  t.portfolio.accountCashYuan=100*E;
  t.banks.find(b=>b.bankId==='BANK-A').depositLimitBps=limitBps;
  const other=t.otherFundBankExposure.find(x=>x.bankId==='BANK-A');
  Object.assign(other,{depositYuan:(limitBps/10-39.5)*E-.5*E,cdYuan:0,bondYuan:0,otherYuan:0});
  for (const s of t.securities) s.remainingTradingDays=10;
  t.termWeights.assets=[
    {weightId:'CASH',label:'测试现金',amountYuan:100*E,remainingTradingDays:0,sourceAccountCash:true},
    ...t.holdings.map(h=>({weightId:`TW-${h.holdingId}`,label:'测试持仓',sourceHoldingId:h.holdingId,
      amountYuan:h.amountYuan,remainingTradingDays:10})),
    {weightId:'RESIDUAL',label:'显式测试其他资产',amountYuan:t.portfolio.navYuan-100*E-
      t.holdings.reduce((sum,h)=>sum+h.amountYuan,0),remainingTradingDays:10},
  ];
  const deposit=t.draftPlans.find(p=>p.businessType==='deposit');
  t.draftPlans=[{...deposit,targetYuan:.5*E},
    {...deposit,label:'测试A银行存单买入',businessType:'cd_buy',securityId:'CD-A',marketTier:'secondary',targetYuan:E}];
  return t;
}
function state(t=template()) {
  const m=createModel();m.startFromTemplate(t);return m.getState();
}
const gate=(s,options={},bank='BANK-A')=>evaluateCoreRules(s,options).rows.find(r=>r.ruleId===gateId&&r.subjectId===bank);
const deposit=s=>s.plans.find(p=>p.businessType==='deposit');
const cd=s=>s.plans.find(p=>p.businessType==='cd_buy');
const options=(s,n,projectedActions=[])=>({plan:deposit(s),amountYuan:n,projectedActions});

test('bank-specific company gate uses bank assets: 6%/8% equality passes and +1 yuan blocks',()=>{
  for (const limitBps of [600,800]) {
    const s=state(template(limitBps));
    assert.equal(gate(s).currentValue,(limitBps/10-.5)/1000);
    assert.equal(gate(s).headroomYuan,.5*E);
    assert.equal(gate(s,options(s,.5*E)).result,'pass');
    assert.equal(gate(s,options(s,.5*E)).projectedValue,limitBps/10000);
    assert.equal(gate(s,options(s,.5*E+1)).result,'block');
    assert.equal(gate(s,options(s,.5*E+1)).headroomYuan,-1);
    assert.deepEqual(gate(s).threshold,{operator:'≤',numerator:limitBps/100,denominator:100});
    s.initialData.portfolio.navYuan=100*E+1;
    assert.equal(gate(s,options(s,.5*E)).result,'pass');
    assert.equal(gate(s,options(s,.5*E+1)).result,'block');
    s.initialData.banks.find(b=>b.bankId==='BANK-A').quarterlyNetAssetsYuan+=1;
    assert.equal(gate(s,options(s,.5*E+1)).result,'block');
  }
});

test('company numerator includes own and other money funds deposit/CD/bank bonds, excludes other assets',()=>{
  const s=state(template(800));
  assert.equal(gate(s,options(s,.5*E)).result,'pass');
  s.initialData.securities.find(x=>x.securityId==='BOND-C').issuerBankId='BANK-A';
  s.initialData.holdings.push({holdingId:'BANK-A-BOND',securityId:'BOND-C',amountYuan:1,sellableYuan:0});
  assert.equal(gate(s,options(s,.5*E)).result,'block');
  s.initialData.holdings.pop();
  s.initialData.securities.find(x=>x.securityId==='BOND-C').issuerBankId='BANK-C';
  const other=s.initialData.otherFundBankExposure.find(x=>x.bankId==='BANK-A');
  for (const key of ['depositYuan','cdYuan','bondYuan']) {
    other[key]+=1;
    assert.equal(gate(s,options(s,.5*E)).result,'block');
    other[key]-=1;
  }
  other.otherYuan=50*E;
  assert.equal(gate(s,options(s,.5*E)).result,'pass');
});

test('approved 8% belongs to one bank; missing limits resolve to ordinary 6% and no NAV gate exists',()=>{
  const s=state(template(800));
  delete s.initialData.banks.find(b=>b.bankId==='BANK-B').depositLimitBps;
  const p={...deposit(s),issuerId:'BANK-B',securityId:null};
  const b=gate(s,{plan:p,amountYuan:9*E},'BANK-B');
  // BANK-B: own 2亿 + other 3亿 + deposit 9亿 = 14亿 / 200亿 = 7%.
  assert.equal(b.result,'block');
  assert.equal(b.threshold.numerator,6);
  assert.equal(gate(s,options(s,.5*E)).result,'pass');
  assert.ok(!evaluateCoreRules(s,options(s,E)).rows.some(r=>r.ruleId==='C04-DEPOSIT'));
  s.initialData.otherFundBankExposure.find(x=>x.bankId==='BANK-A').depositYuan=0;
  const aboveOldNavGate=evaluateCoreRules(s,options(s,E));
  assert.equal(gate(s,options(s,E)).result,'pass'); // own 40.5/500 = 8.1%; company 40.5/1000 = 4.05%.
  assert.equal(aboveOldNavGate.blocking.length,0);
});

test('CD purchases can cross bank deposit threshold; existing holdings above it are not a gate breach',()=>{
  const s=state(template(800));
  assert.equal(gate(s,{plan:cd(s),amountYuan:E}).result,'not_applicable');
  s.initialData.holdings.find(h=>h.securityId==='CD-A').amountYuan+=E;
  assert.equal(gate(s).result,'not_applicable');
  assert.equal(gate(s).currentValue,.0805);
  assert.equal(gate(s).headroomYuan,0);
  assert.equal(metricPresentation(gate(s)).tone,'near');
  assert.equal(gate(s,options(s,1)).result,'block');
});

for (const limitBps of [600,800]) {
test(`${limitBps/100}% projected deposits preserve legal sequence before a later CD`,()=>{
  const s=state(template(limitBps)), dep={plan:deposit(s),amountYuan:.5*E}, buy={plan:cd(s),amountYuan:E};
  assert.equal(gate(s,{projectedActions:[dep,buy]}).result,'pass');
  assert.equal(gate(s,{projectedActions:[buy,dep]}).result,'block');
  assert.equal(gate(s,{plan:cd(s),amountYuan:E,projectedActions:[dep]}).result,'pass');
  assert.equal(gate(s,options(s,.5*E,[buy])).result,'block');
  const unrelated={...cd(s),issuerId:'BANK-B',securityId:'CD-B'};
  assert.equal(gate(s,{plan:unrelated,amountYuan:1,projectedActions:[buy,dep]}).result,'block');
});

test(`${limitBps/100}% later sales do not erase earlier violations; malformed deposits stay missing`,()=>{
  const s=state(template(limitBps)), tooMuch={plan:deposit(s),amountYuan:.5*E+1};
  const sell={plan:{...cd(s),direction:'inflow',businessType:'cd_sell'},amountYuan:E};
  assert.equal(gate(s,{projectedActions:[tooMuch,sell]}).result,'block');
  for (const amountYuan of [null,undefined,1.5,-1])
    assert.equal(gate(s,{projectedActions:[{plan:deposit(s),amountYuan}]}).result,'missing');
});

test(`${limitBps/100}% sent commitments reserve once; cancellation and filled sales release capacity`,()=>{
  const s=state(template(limitBps)), p=deposit(s), buy=cd(s);
  s.execution.instructions.DEP={planId:p.planId,status:'unknown',nominalYuan:.5*E,cancelledYuan:0,filledYuan:0,settledYuan:0};
  assert.equal(gate(s,options(s,1)).result,'block');
  s.execution.instructions.DEP.status='partial';s.execution.instructions.DEP.filledYuan=.1*E;
  assert.equal(gate(s).headroomYuan,0);
  s.execution.instructions.DEP.cancelledYuan=.2*E;
  assert.equal(gate(s).headroomYuan,.2*E);
  s.execution.instructions.DEP.status='rejected';
  s.execution.instructions.CD={planId:buy.planId,status:'accepted',nominalYuan:E,cancelledYuan:0,filledYuan:0,settledYuan:0};
  assert.equal(gate(s,options(s,1)).result,'block');
  const sell={...buy,planId:'SELL',businessType:'cd_sell',direction:'inflow'};s.plans.push(sell);
  s.execution.instructions.SALE={planId:'SELL',status:'accepted',nominalYuan:E,cancelledYuan:0,filledYuan:0,settledYuan:0};
  assert.equal(gate(s,options(s,.5*E)).result,'block');
  s.execution.instructions.SALE.filledYuan=E;
  assert.equal(gate(s,options(s,.5*E)).result,'pass');
});

}

test('missing or zero bank assets, missing exposure/date and invalid deposit amounts cannot pass',()=>{
  for (const denominator of [null,0]) {
    const s=state();s.initialData.banks.find(b=>b.bankId==='BANK-A').quarterlyNetAssetsYuan=denominator;
    assert.equal(gate(s,options(s,1)).result,'missing');
    assert.equal(gate(s).result,'not_applicable');
    assert.equal(gate(s).headroomYuan,null);
  }
  const s=state();s.initialData.holdings.find(h=>h.securityId==='CD-A').amountYuan=null;
  assert.equal(gate(s,options(s,1)).result,'missing');
  for (const amountYuan of [null,1.5,-1]) {
    const s=state();
    assert.equal(gate(s,options(s,amountYuan)).result,'missing');
  }
  const dated=state();dated.initialData.banks.find(b=>b.bankId==='BANK-A').quarterEnd='2099-01-01';
  assert.equal(gate(dated,options(dated,1)).result,'missing');
  const other=state();other.initialData.otherFundBankExposure=other.initialData.otherFundBankExposure.filter(x=>x.bankId!=='BANK-A');
  assert.equal(gate(other,options(other,1)).result,'missing');
});

test('progressive C09 improvement never waives a breached company deposit gate',()=>{
  const s=state();
  for (const asset of s.initialData.termWeights.assets) if (asset.weightId==='RESIDUAL') asset.remainingTradingDays=200;
  // The independent transaction gate remains a block alongside an already
  // exceeded portfolio metric and is never softened to a progressive warning.
  const checked=evaluateCoreRules(s,options(s,E));
  assert.equal(gate(s,options(s,E)).result,'block');
  assert.ok(checked.blocking.some(r=>r.ruleId===gateId));
});

test('selected engine order, model batch preview and dispatch all enforce the same cumulative gate',()=>{
  const m=createModel();m.startFromTemplate(template());const s=m.getState(),p=deposit(s),buy=cd(s);
  const backwards=[{planId:buy.planId,nominalYuan:E},{planId:p.planId,nominalYuan:.5*E}];
  const blocked=evaluateSelectedSequence(s,backwards);
  assert.equal(blocked.status,'blocked_sequence');
  assert.ok(blocked.trace.at(-1).rules.some(r=>r.ruleId===gateId&&r.result==='block'));
  const bad=m.recalculateDispatchBatch(backwards);
  assert.equal(bad.recalculationReady,false);
  // The manager-selected engine trace still diagnoses the later deposit gate;
  // dispatch now rejects the harmful purchase earlier, before reserving it.
  assert.equal(bad.recalculationRows[0].ruleId,'PLAN-DEPOSIT-ORDER');
  assert.match(bad.recalculationRows[0].reason,/剩余整笔存款/);
  const good=m.recalculateDispatchBatch([...backwards].reverse());
  assert.equal(good.recalculationReady,true);
  const items=good.proposal.steps.map(st=>({stepId:st.stepId,nominalYuan:st.nominalYuan}));
  assert.equal(m.previewDispatchBatch(items,{skipReview:true}).ready,true);
  const sent=m.sendCustomBatch(items,{skipReview:true});
  assert.deepEqual(sent.results.map(r=>r.status),['accepted','accepted']);
  assert.equal(gate(m.getState()).currentValue,.061);
  assert.equal(validateSaved(m.serialize()).ok,true);
});

test('AI completion finds deposit-before-CD instead of treating terminal company ratio as a stock limit',()=>{
  const t=template();t.draftPlans.reverse();const m=createModel();m.startFromTemplate(t);
  const result=simulateDraft(readPlanningSnapshot(m),[],{executionSearch:{nodeLimit:512,candidateBudget:64}});
  assert.equal(result.applicable,true);
  assert.equal(result.finalRules.rows.find(r=>r.ruleId===gateId&&r.subjectId==='BANK-A').result,'not_applicable');
  assert.deepEqual(result.proposal.steps.map(st=>m.getState().plans.find(p=>p.planId===st.planId).businessType),['deposit','cd_buy']);
});

test('company 10% ceiling and noncustody fund 5% remain independent of 8% deposit approval',()=>{
  const s=state(template(800)),buy=cd(s);
  const rows=evaluateCoreRules(s,{plan:buy,amountYuan:21*E}).rows;
  assert.equal(rows.find(r=>r.ruleId===gateId&&r.subjectId==='BANK-A').result,'not_applicable');
  assert.equal(rows.find(r=>r.ruleId==='C05'&&r.subjectId==='BANK-A').result,'block');
  const b=s.initialData.banks.find(b=>b.bankId==='BANK-B');
  b.depositLimitBps=800;b.quarterlyNetAssetsYuan=1000*E;
  const p={...deposit(s),issuerId:'BANK-B',securityId:null};
  const restricted=evaluateCoreRules(s,{plan:p,amountYuan:24*E}).rows;
  assert.equal(restricted.find(r=>r.ruleId===gateId&&r.subjectId==='BANK-B').result,'pass');
  assert.equal(restricted.find(r=>r.ruleId==='C03'&&r.subjectId==='BANK-B').result,'block');
});

test('bank-bond buys cross the deposit gate but still obey the company 10% ceiling',()=>{
  const s=state();
  s.initialData.securities.find(x=>x.securityId==='BOND-C').issuerBankId='BANK-A';
  const buy={...cd(s),businessType:'bond_buy',securityId:'BOND-C'};
  const rows=n=>evaluateCoreRules(s,{plan:buy,amountYuan:n}).rows;
  assert.equal(rows(E).find(r=>r.ruleId===gateId&&r.subjectId==='BANK-A').result,'not_applicable');
  assert.equal(rows(E).find(r=>r.ruleId==='C05'&&r.subjectId==='BANK-A').result,'pass');
  assert.equal(rows(40*E).find(r=>r.ruleId==='C05'&&r.subjectId==='BANK-A').result,'block');
});

test('optional bank limit validates strictly, round-trips and preserves old saved input/facts',()=>{
  for (const invalid of [null,0,601,700,1000,'600',6,.06]) {
    const t=template();t.banks[0].depositLimitBps=invalid;
    assert.throws(()=>normalizeInitialTemplate(t),/基点/);
  }
  const t=template(800), serialized=JSON.stringify(t);
  assert.deepEqual(normalizeInitialTemplate(JSON.parse(serialized)),t);
  const m=createModel();m.startFromTemplate(t);
  assert.equal(validateSaved(m.serialize()).ok,true);
  assert.equal(createModel(m.serialize()).getState().initialData.banks[0].depositLimitBps,800);
  const old=template();for (const b of old.banks) delete b.depositLimitBps;
  assert.deepEqual(normalizeInitialTemplate(old),old);
  assert.equal(bankDepositLimitBps(old.banks[0]),600);
  const legacy=createModel();legacy.startFromTemplate(old);
  const archive=legacy.serialize();
  assert.equal(validateSaved(archive).ok,true);
  const restored=createModel(archive);
  assert.equal(JSON.stringify(restored.getState().initialData),JSON.stringify(old));
  const restoredArchive=JSON.parse(restored.serialize()), originalArchive=JSON.parse(archive);
  assert.deepEqual(restoredArchive.initialData,originalArchive.initialData);
  assert.deepEqual(restoredArchive.execution.instructions,originalArchive.execution.instructions);
  assert.deepEqual(restoredArchive.execution.fills,originalArchive.execution.fills);
  assert.deepEqual(restoredArchive.plans,originalArchive.plans);
  assert.equal(gate(restored.getState(),options(restored.getState(),.5*E+1)).result,'block');
});
