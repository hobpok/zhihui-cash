import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createModel, validateSaved } from './model.js';
import { evaluateCoreRules } from './core-rules.js';
import { normalizeInitialTemplate } from './initial-data.js';
import { createDefaultInitialTemplate, prepareInitialTemplateForReset } from './default-scenario.js';
import { runLifecycle } from '../scripts/robustness-lifecycle.mjs';

const E=100000000, q=n=>Math.round(n*E);
const rule=(rows,id,subject='PORTFOLIO')=>{
  const r=rows.find(x=>x.ruleId===id && x.subjectId===subject);
  assert.ok(r,`${id}/${subject}`);return r;
};
const opening=t=>{const m=createModel();m.startFromTemplate(t);return m.getState();};
const find=(s,kind,code)=>s.plans.find(p=>p.businessType===kind && (!code||p.issuerId===`SIM-BANK-${code}`));
const sum=rows=>rows.reduce((n,r)=>n+r.amountYuan,0);

test('company default preserves exact balance sheet, three banks, and background term weights',()=>{
  const t=createDefaultInitialTemplate({businessDate:'2026-10-19'});
  assert.equal(t.templateId,'SIM-DEFAULT-COMPANY-GATES-20261019');
  assert.equal(t.draftPlans.length,6);
  assert.equal(t.portfolio.navYuan,q(500));assert.equal(t.portfolio.accountCashYuan,q(5));
  const rows=t.holdings.map(h=>({...h,...t.securities.find(s=>s.securityId===h.securityId)}));
  assert.equal(sum(rows),q(520));
  for(const [kind,n] of [['government_bond',20],['repo',75],['deposit',45],['cd',380]])
    assert.equal(sum(rows.filter(r=>r.instrumentKind===kind)),q(n));
  for(const [code,n] of [['ABC',50],['GZ',20],['JNRCB',20]]) {
    const named=rows.filter(r=>r.issuerBankId===`SIM-BANK-${code}`);
    assert.equal(sum(named),q(n));assert.ok(named.every(r=>r.remainingTradingDays===90));
  }
  const background=rows.filter(r=>r.instrumentKind==='cd' && !['ABC','GZ','JNRCB'].some(code=>r.issuerBankId===`SIM-BANK-${code}`));
  assert.equal(new Set(background.map(r=>r.issuerBankId)).size,7);
  assert.equal(sum(background),q(335));
  assert.equal(sum(background.filter(r=>r.remainingTradingDays===110)),q(210));
  assert.equal(sum(background.filter(r=>r.remainingTradingDays===111)),q(125));
  for(const id of new Set(background.map(r=>r.issuerBankId))) {
    const b=t.banks.find(b=>b.bankId===id);
    assert.equal(b.custodyQualified,true);assert.equal(b.rating,'AAA');
    assert.ok(sum(background.filter(r=>r.issuerBankId===id))<=q(75));
  }
  assert.equal(sum(t.termWeights.assets),q(525));assert.equal(sum(t.termWeights.liabilities),q(25));
  assert.equal(sum(t.termWeights.positiveRepos),q(25));
  assert.equal(t.termWeights.assets.reduce((n,w)=>n+w.amountYuan*w.remainingTradingDays,0),q(46200));
  assert.equal(q(46200)/q(525),88);
  assert.deepEqual(t.banks.filter(b=>['SIM-BANK-GZ','SIM-BANK-JNRCB'].includes(b.bankId))
    .map(b=>[b.custodyQualified,b.quarterlyNetAssetsYuan,b.depositLimitBps]),[[false,q(1000),800],[false,q(1000),600]]);
  assert.equal(t.otherFundBankExposure.reduce((n,r)=>n+r.depositYuan+r.cdYuan+r.bondYuan+r.otherYuan,0),q(97));
  assert.equal(t.maturityCashEvents.length,1);assert.equal(t.maturityCashEvents[0].includedInOpeningCash,false);
  assert.equal(t.maturityCashEvents[0].sourcePositiveRepoWeightId,'TW-REPO-ADJUSTMENT');
  assert.ok(!t.draftPlans.some(p=>p.businessType==='cd_sell'));
  assert.doesNotThrow(()=>normalizeInitialTemplate(t));
});

test('opening includes due repo once in business measures while account remains five',()=>{
  const s=opening(createDefaultInitialTemplate());
  assert.equal(s.summary.accountCashYuan,q(5));assert.equal(s.summary.availableYuan,-q(20));
  assert.equal(rule(s.coreRules.rows,'C02').currentValue,0);
  assert.equal(rule(s.coreRules.rows,'C09').numeratorYuan,q(46200));
  assert.equal(rule(s.coreRules.rows,'C09').denominatorYuan,q(500));
  assert.equal(rule(s.coreRules.rows,'C09').currentValue,92.4);
  assert.ok(s.coreRules.rows.filter(r=>r.subjectId!=='PORTFOLIO').every(r=>['pass','not_applicable'].includes(r.result)));
  assert.ok(!s.coreRules.rows.some(r=>r.ruleId==='C04-DEPOSIT'));
  assert.deepEqual(s.coreRules.missing,[]);
});

for(const [code,deposit,cd,initial,threshold] of [['GZ',1,2,.079,.08],['JNRCB',2,1,.058,.06]]) {
  test(`${code} company gate allows equality after deposit and requires deposit before CD`,()=>{
    const s=opening(createDefaultInitialTemplate()),dep=find(s,'deposit',code),buy=find(s,'cd_buy',code);
    const check=(plan,n,actions=[])=>evaluateCoreRules(s,{plan,amountYuan:n,projectedActions:actions}).rows;
    const gate=rows=>rule(rows,'C05-DEPOSIT',`SIM-BANK-${code}`);
    assert.equal(gate(s.coreRules.rows).currentValue,initial);
    const equality=gate(check(dep,q(deposit)));
    assert.equal(equality.projectedValue,threshold);assert.equal(equality.result,'pass');
    assert.equal(gate(check(dep,q(deposit)+1)).result,'block');
    assert.equal(gate(check(dep,q(deposit),[{plan:buy,amountYuan:q(cd)}])).result,'block');
    const correct=check(buy,q(cd),[{plan:dep,amountYuan:q(deposit)}]);
    assert.equal(gate(correct).result,'pass');
    assert.equal(rule(correct,'C03',`SIM-BANK-${code}`).projectedValue,.046);
    assert.equal(rule(correct,'C03',`SIM-BANK-${code}`).result,'pass');
    // Ordinary CD purchase above the deposit gate is still permitted below the independent 10% cap.
    assert.equal(gate(check(buy,q(cd))).result,'not_applicable');
    assert.equal(rule(check(buy,q(cd)),'C05',`SIM-BANK-${code}`).result,'pass');
  });
}

test('noncustody fund five percent gate remains independent from company limits',()=>{
  const s=opening(createDefaultInitialTemplate()),buy=find(s,'cd_buy','GZ');
  const check=n=>rule(evaluateCoreRules(s,{plan:buy,amountYuan:n}).rows,'C03','SIM-BANK-GZ');
  assert.equal(check(q(5)).projectedValue,.05);assert.equal(check(q(5)).result,'pass');
  assert.equal(check(q(5)+1).result,'block');
});

test('six plans and due repayment complete using public model APIs with exact final ratios',()=>{
  const r=runLifecycle(createDefaultInitialTemplate());
  assert.deepEqual(r.blocked,[]);assert.equal(r.final.completed,true);
  assert.deepEqual(r.validationSaved,{ok:true,errors:[]});
  assert.equal(r.final.instructions.length,6);assert.ok(r.final.plans.every(p=>p.remainingYuan===0));
  assert.ok(r.final.instructions.every(i=>i.filledYuan===i.nominalYuan && i.settledYuan===i.nominalYuan));
  assert.deepEqual(r.final.cash,{accountCashYuan:q(5),businessAvailableYuan:q(5),payableReservedYuan:0,projectedEndOfDayYuan:q(5)});
  assert.equal(r.final.cashEventReceipts.length,1);assert.equal(r.final.cashEventReceipts[0].amountYuan,q(25));
  assert.equal(rule(r.final.coreRules,'C02').currentValue,.05);
  assert.equal(rule(r.final.coreRules,'C09').numeratorYuan,q(46880));
  assert.equal(rule(r.final.coreRules,'C09').denominatorYuan,q(551));
  assert.equal(rule(r.final.coreRules,'C09').currentValue,46880/551);
  for(const code of ['GZ','JNRCB']) assert.equal(rule(r.final.coreRules,'C03',`SIM-BANK-${code}`).currentValue,.046);
  assert.equal(rule(r.final.coreRules,'C05','SIM-BANK-GZ').currentValue,.082);
  assert.equal(rule(r.final.coreRules,'C05','SIM-BANK-JNRCB').currentValue,.061);
  assert.ok(r.final.coreRules.every(row=>['pass','not_applicable'].includes(row.result)));
  assert.equal(q(5+51-25-1-2-2-1-20),q(5));
  // The lifecycle's accepted order must retain both bank-specific prerequisites.
  const order=r.final.instructions.map(i=>r.final.plans.find(p=>p.planId===i.planId).label);
  for(const name of ['广州银行','江南农商银行'])
    assert.ok(order.findIndex(x=>x.startsWith(`存入${name}`))<order.findIndex(x=>x.startsWith(`买入${name}`)));
});

test('former three-gates template remains a saved fact and is never replaced on restore',()=>{
  const former=JSON.parse(fs.readFileSync(new URL('./test-fixtures/former-three-gates-20261019.json',import.meta.url),'utf8'));
  const m=createModel();m.startFromTemplate(former);const saved=m.serialize();
  const restored=createModel(saved).getState();
  assert.equal(restored.initialData.templateId,'SIM-DEFAULT-THREE-GATES-20261019');
  assert.equal(restored.plans.length,7);
  assert.ok(restored.initialData.banks.some(b=>b.bankId==='SIM-BANK-CDRCB'));
  assert.ok(validateSaved(JSON.parse(saved)).ok);
});

test('new defaults follow UTC+8 date, while saved runs keep dates and facts',t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-19T15:59:59Z')});
  const m=createModel();m.startFromTemplate();const saved=m.serialize();
  t.mock.timers.tick(1000);
  const fresh=createDefaultInitialTemplate();
  assert.equal(fresh.businessDate,'2026-10-20');
  assert.equal(fresh.termWeights.asOfDate,fresh.businessDate);
  assert.ok(fresh.draftPlans.every(p=>p.tradeDate===fresh.businessDate));
  assert.ok(fresh.maturityCashEvents.every(e=>e.dueDate===fresh.businessDate));
  const restored=createModel(saved).getState();
  assert.equal(restored.context.businessDate,'2026-10-19');
  assert.equal(restored.initialData.templateId,'SIM-DEFAULT-COMPANY-GATES-20261019');
  assert.ok(validateSaved(JSON.parse(saved)).ok);
});

test('legacy reset refresh stays narrowly scoped and never replaces saved templates with the new sample',()=>{
  const t=createDefaultInitialTemplate();
  assert.strictEqual(prepareInitialTemplateForReset(t),t);
  t.templateId='SIM-DEFAULT-COMPLEX-01';
  const f=t.draftPlans.find(p=>p.businessType==='interbank_repo_financing');
  f.label='银行间正回购融资17.6亿7天';f.targetYuan=q(17.6);f.repoTerms.tenorDays=7;
  assert.equal(prepareInitialTemplateForReset(t).draftPlans.at(-1).repoTerms.tenorDays,1);
  assert.equal(f.repoTerms.tenorDays,7);
  t.revision=2;assert.strictEqual(prepareInitialTemplateForReset(t),t);
});
