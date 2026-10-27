import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel,validateSaved} from './model.js';
import {createBankOrderInitialTemplate} from './default-scenario.js';
import {evaluateCoreRules} from './core-rules.js';
import {APP_RELEASE,RESET_RELEASE} from './release-version.js';
import {baseTemplate,plan} from '../scripts/robustness-scenarios.mjs';

const E=100000000;
const setup=()=>{const m=createModel();m.startFromTemplate(createBankOrderInitialTemplate());return m;};
const find=(s,kind)=>s.plans.find(p=>p.businessType===kind);
const rules=(s,p,n)=>evaluateCoreRules(s,{plan:p,amountYuan:n});
const row=(r,id)=>r.rows.find(x=>x.ruleId===id&&x.subjectId==='PORTFOLIO');

for(const kind of ['cd_sell','interbank_repo_financing']) {
  test(`${kind} improves negative business cash under a fill premise without requiring full repair`,()=>{
    const m=setup(),s=m.getState(),before=m.serialize(),r=rules(s,find(s,kind),2*E);
    assert.equal(row(r,'C01').currentValue,-20*E);
    assert.equal(row(r,'C01').projectedValue,-18*E);
    assert.equal(row(r,'C01').result,'warn');
    assert.equal(row(r,'C01').improvementTrend,1);
    assert.equal(row(r,'C02').projectedValue,.004);
    assert.ok(row(r,'C09').projectedValue<92.4);
    assert.deepEqual(r.blocking,[]);assert.deepEqual(r.missing,[]);
    assert.equal(m.serialize(),before);
  });
}

test('both inflows are priority and can be sent together while purchases still wait',()=>{
  const m=setup();m.generateProposal();
  const s=m.getState(),g=m.getAdvancementGroups();
  assert.deepEqual(new Set(g.priority.map(x=>s.plans.find(p=>p.planId===x.planId).businessType)),
    new Set(['cd_sell','interbank_repo_financing']));
  assert.equal(g.restricted.length,4);
  m.approveProposal();const sent=m.sendBatch();
  assert.equal(sent.results.length,2);assert.ok(sent.results.every(x=>x.status==='accepted'));
  assert.equal(sent.summary.availableYuan,-20*E);assert.equal(sent.summary.accountCashYuan,5*E);
  assert.ok(Object.values(sent.execution.instructions).every(x=>x.filledYuan===0));
});

for(const kind of ['cd_sell','interbank_repo_financing']) {
  test(`${kind} can fill first and partially; receipts never double count the business improvement`,()=>{
    const m=setup();m.generateProposal();m.approveProposal();m.sendBatch();
    const id=Object.values(m.getState().execution.instructions).find(i=>i.businessType===kind).instructionId;
    m.simulateEvent('fill',{instructionId:id,nominalYuan:E});
    const partial=m.getState();
    assert.equal(partial.summary.availableYuan,-19*E);assert.equal(partial.summary.accountCashYuan,5*E);
    assert.equal(partial.execution.instructions[id].filledYuan,E);
    assert.equal(partial.coreRules.rows.find(x=>x.ruleId==='C01').result,'block');
    const saved=m.serialize(),restored=createModel();
    assert.equal(validateSaved(saved).ok,true);restored.load(saved);
    assert.deepEqual(restored.getState().execution.instructions,partial.execution.instructions);
    assert.deepEqual(restored.getState().execution.journal,partial.execution.journal);
    const settled=restored.processExecutionBatch([id],'settle');
    assert.equal(settled.results[0].status,'settled');
    assert.equal(restored.getState().summary.availableYuan,-19*E);
    assert.equal(restored.getState().summary.accountCashYuan,6*E);
  });
}

test('manual sale-first order has no fictitious dependency on the unfilled financing',()=>{
  const m=setup(),s=m.getState();
  m.recalculateDispatchBatch(['cd_sell','interbank_repo_financing'].map(k=>{
    const p=find(s,k);return {planId:p.planId,nominalYuan:p.targetYuan};
  }));
  m.approveProposal();const before=m.getState();
  assert.ok(before.batchReadiness.every(x=>x.ready));
  const sent=m.sendBatch();assert.equal(sent.results.length,2);
  assert.ok(sent.results.every(x=>x.status==='accepted'));
  assert.equal(sent.summary.availableYuan,-20*E);
});

test('unknown cash, unavailable holdings and missing maturity cannot use the improvement exception',()=>{
  const m=setup(),s=m.getState(),p=find(s,'cd_sell');
  const missing=evaluateCoreRules(s,{plan:p,amountYuan:2*E,cashYuan:null});
  assert.ok(missing.missing.some(x=>x.ruleId==='C01'));
  const t=createBankOrderInitialTemplate();
  const security=t.draftPlans.find(x=>x.businessType==='cd_sell').securityId;
  t.holdings.find(x=>x.securityId===security).sellableYuan=0;
  const noHolding=createModel();noHolding.startFromTemplate(t);noHolding.generateProposal();
  assert.ok(!noHolding.getAdvancementGroups().priority.some(x=>x.planId===find(noHolding.getState(),'cd_sell').planId));
  const broken=structuredClone(s);broken.initialData.securities.find(x=>x.securityId===p.securityId).remainingTradingDays=null;
  assert.ok(rules(broken,p,2*E).missing.some(x=>x.ruleId==='C09'));
});

test('cash-consuming trades cannot use an improvement elsewhere to deepen a negative position',()=>{
  const s=setup().getState();
  for(const p of s.plans.filter(x=>x.direction==='outflow')) {
    const r=rules(s,p,p.targetYuan);
    assert.equal(row(r,'C01').result,'block');
    assert.equal(row(r,'C01').improvementTrend,-1);
  }
});

test('normal compliant purchases remain permitted and do not acquire improvement priority',()=>{
  const m=setup();m.generateProposal();m.approveProposal();m.sendBatch();
  const ids=Object.keys(m.getState().execution.instructions);
  assert.ok(m.processExecutionBatch(ids,'fill').results.every(x=>x.status==='filled'));
  m.generateProposal();
  const g=m.getAdvancementGroups();assert.equal(g.priority.length,0);
  assert.ok(g.synchronous.length>0);
});

test('release retains the existing initialization marker',()=>{
  assert.equal(APP_RELEASE,'6-0.41.0');assert.equal(RESET_RELEASE,'6-0.28.0');
});

test('an otherwise compliant metric worsening within its limit forbids progressive relief and priority',()=>{
  const t=baseTemplate({id:'PROGRESSIVE-NO-WORSENING',cash:1,holdings:[{securityId:'CD-B',amount:6,days:0}],residualDays:0});
  t.termWeights.assets.find(x=>x.weightId==='W-RESIDUAL').amountYuan+=10*E;
  t.termWeights.liabilities=[{weightId:'L-OTHER',label:'其他长期负债',amountYuan:10*E,remainingTradingDays:1000}];
  t.draftPlans=[plan('融资1亿','interbank_repo_financing',1,null,1)];
  const m=createModel();m.startFromTemplate(t);
  const s=m.getState(),r=rules(s,s.plans[0],E),term=row(r,'C09');
  assert.equal(term.result,'pass');assert.equal(term.currentValue,-100);
  assert.ok(term.projectedValue>term.currentValue&&term.projectedValue<90);
  assert.equal(term.improvementTrend,-1);
  assert.equal(row(r,'C01').improvementTrend,1);
  assert.equal(row(r,'C02').result,'block');
  assert.match(row(r,'C02').reason,/其他指标恶化/);
  m.generateProposal();assert.equal(m.getAdvancementGroups().priority.length,0);
});
