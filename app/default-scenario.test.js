import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createModel, validateSaved } from './model.js';
import { evaluateCoreRules } from './core-rules.js';
import { normalizeInitialTemplate } from './initial-data.js';
import { createDefaultInitialTemplate, createBankOrderInitialTemplate, createRemediationInitialTemplate, createAiFinancingInitialTemplate, prepareInitialTemplateForReset } from './default-scenario.js';
import { runLifecycle } from '../scripts/robustness-lifecycle.mjs';

const E=100000000, q=n=>Math.round(n*E);
const rule=(rows,id,subject='PORTFOLIO')=>{
  const r=rows.find(x=>x.ruleId===id && x.subjectId===subject);
  assert.ok(r,`${id}/${subject}`);return r;
};
const opening=t=>{const m=createModel();m.startFromTemplate(t);return m.getState();};
const find=(s,kind,code)=>s.plans.find(p=>p.businessType===kind && (!code||p.issuerId===`SIM-BANK-${code}`));
const sum=rows=>rows.reduce((n,r)=>n+r.amountYuan,0);

test('historical five-plan remediation scenario preserves the optional six-plan preset',()=>{
  const options={businessDate:'2026-10-26'},t=createRemediationInitialTemplate(options);
  const old=createBankOrderInitialTemplate(options),oldSnapshot=structuredClone(old);
  assert.deepEqual(t,createRemediationInitialTemplate(options));
  assert.equal(t.templateId,'SIM-REMEDIATION-COMPANY-GATES-20261026');
  assert.equal(t.draftPlans.length,5);assert.equal(t.draftPlans.some(p=>p.businessType==='cd_sell'),false);
  assert.equal(old.draftPlans.length,6);assert.equal(old.draftPlans.filter(p=>p.businessType==='cd_sell').length,1);
  assert.deepEqual(t.draftPlans,old.draftPlans.filter(p=>p.businessType!=='cd_sell'));
  for(const field of ['portfolio','banks','securities','holdings','termWeights','otherFundBankExposure','maturityCashEvents'])
    assert.deepEqual(t[field],old[field]);
  assert.ok(t.holdings.find(h=>h.securityId==='SIM-GZ-CD-OLD').sellableYuan>=q(2));
  t.holdings[0].amountYuan=0;
  assert.deepEqual(old,oldSnapshot);assert.deepEqual(createBankOrderInitialTemplate(options),oldSnapshot);
  const m=createModel();m.startFromTemplate();
  assert.equal(m.getState().plans.length,4);assert.equal(m.getState().plans.some(p=>p.businessType==='cd_sell'),false);
});

test('saved six-plan runs retain their original template, plans and calculated facts',()=>{
  const m=createModel();m.startFromTemplate(createBankOrderInitialTemplate({businessDate:'2026-10-19'}));
  m.generateProposal('AUTO');const saved=m.serialize(),restored=createModel(saved);
  const expected=JSON.parse(saved);
  expected.execution.requiresRefresh=true;expected.execution.requiresReapproval=true;
  assert.deepEqual(JSON.parse(restored.serialize()),expected);assert.equal(restored.getState().plans.length,6);
  assert.equal(restored.getState().initialData.templateId,'SIM-DEFAULT-COMPANY-GATES-20261019');
  assert.ok(restored.getState().plans.some(p=>p.businessType==='cd_sell'));
  assert.deepEqual(validateSaved(JSON.parse(saved)),{ok:true,errors:[]});
});

test('preset-sale company scenario preserves exact balance sheet, three banks, and background term weights',()=>{
  const t=createBankOrderInitialTemplate({businessDate:'2026-10-19'});
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
  assert.equal(t.draftPlans.find(p=>p.businessType==='cd_sell').targetYuan,q(2));
  assert.equal(t.draftPlans.find(p=>p.businessType==='cd_sell').direction,'inflow');
  assert.doesNotThrow(()=>normalizeInitialTemplate(t));
});

test('opening includes due repo once in business measures while account remains five',()=>{
  const s=opening(createDefaultInitialTemplate());
  assert.equal(s.summary.accountCashYuan,q(5));assert.equal(s.summary.availableYuan,-q(5));
  assert.equal(rule(s.coreRules.rows,'C02').currentValue,.03);
  assert.equal(rule(s.coreRules.rows,'C09').numeratorYuan,q(46200));
  assert.equal(rule(s.coreRules.rows,'C09').denominatorYuan,q(515));
  assert.equal(rule(s.coreRules.rows,'C09').currentValue,46200/515);
  assert.ok(s.coreRules.rows.filter(r=>r.subjectId!=='PORTFOLIO').every(r=>['pass','not_applicable'].includes(r.result)));
  assert.ok(!s.coreRules.rows.some(r=>r.ruleId==='C04-DEPOSIT'));
  assert.deepEqual(s.coreRules.missing,[]);
});

for(const [code,deposit,cd,initial,threshold] of [['JNRCB',2,1,.058,.06]]) {
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

test('Guangzhou starts at 7.9 percent and must sell CD two before depositing three at 8 percent',()=>{
  const s=opening(createBankOrderInitialTemplate()),dep=find(s,'deposit','GZ'),sale=find(s,'cd_sell','GZ');
  assert.equal(dep.targetYuan,q(3));assert.equal(sale.targetYuan,q(2));
  const gate=actions=>rule(evaluateCoreRules(s,{plan:dep,amountYuan:q(3),projectedActions:actions}).rows,'C05-DEPOSIT','SIM-BANK-GZ');
  assert.equal(rule(s.coreRules.rows,'C05-DEPOSIT','SIM-BANK-GZ').currentValue,.079);
  assert.equal(gate([]).projectedValue,.082);assert.equal(gate([]).result,'block');
  assert.equal(gate([{plan:sale,amountYuan:q(2)-1}]).result,'block');
  const after=gate([{plan:sale,amountYuan:q(2)}]);
  assert.equal(after.projectedValue,.08);assert.equal(after.result,'pass');
  assert.equal(evaluateCoreRules(s,{plan:dep,amountYuan:q(3),
    projectedActions:[{plan:sale,amountYuan:q(2)}]}).rows.find(r=>r.ruleId==='C03'&&r.subjectId==='SIM-BANK-GZ').projectedValue,.042);
});

test('noncustody fund five percent gate remains independent from company limits',()=>{
  const s=opening(createDefaultInitialTemplate()),buy=find(s,'cd_buy','JNRCB');
  const check=n=>rule(evaluateCoreRules(s,{plan:buy,amountYuan:n}).rows,'C03','SIM-BANK-JNRCB');
  assert.equal(check(q(5)).projectedValue,.05);assert.equal(check(q(5)).result,'pass');
  assert.equal(check(q(5)+1).result,'block');
});

test('six plans and due repayment complete using public model APIs with exact final ratios',()=>{
  const r=runLifecycle(createBankOrderInitialTemplate());
  assert.deepEqual(r.blocked,[]);assert.equal(r.final.completed,true);
  assert.deepEqual(r.validationSaved,{ok:true,errors:[]});
  assert.equal(r.final.instructions.length,6);assert.ok(r.final.plans.every(p=>p.remainingYuan===0));
  assert.ok(r.final.instructions.every(i=>i.filledYuan===i.nominalYuan && i.settledYuan===i.nominalYuan));
  assert.deepEqual(r.final.cash,{accountCashYuan:q(5),businessAvailableYuan:q(5),payableReservedYuan:0,projectedEndOfDayYuan:q(5)});
  assert.equal(r.final.cashEventReceipts.length,1);assert.equal(r.final.cashEventReceipts[0].amountYuan,q(25));
  assert.equal(rule(r.final.coreRules,'C02').currentValue,.05);
  assert.equal(rule(r.final.coreRules,'C09').numeratorYuan,q(46700));
  assert.equal(rule(r.final.coreRules,'C09').denominatorYuan,q(549));
  assert.equal(rule(r.final.coreRules,'C09').currentValue,46700/549);
  assert.equal(rule(r.final.coreRules,'C03','SIM-BANK-GZ').currentValue,.042);
  assert.equal(rule(r.final.coreRules,'C03','SIM-BANK-JNRCB').currentValue,.046);
  assert.equal(rule(r.final.coreRules,'C05','SIM-BANK-GZ').currentValue,.08);
  assert.equal(rule(r.final.coreRules,'C05','SIM-BANK-JNRCB').currentValue,.061);
  assert.ok(r.final.coreRules.every(row=>['pass','not_applicable'].includes(row.result)));
  assert.equal(q(5+49+2-25-3-2-1-20),q(5));
  // The lifecycle's accepted order must retain both bank-specific prerequisites.
  const order=r.final.instructions.map(i=>r.final.plans.find(p=>p.planId===i.planId).label);
  assert.ok(order.findIndex(x=>x.startsWith('卖出广州银行'))<order.findIndex(x=>x.startsWith('存入广州银行')));
  assert.ok(order.findIndex(x=>x.startsWith('存入江南农商银行'))<order.findIndex(x=>x.startsWith('买入江南农商银行')));
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
  assert.equal(restored.initialData.templateId,'SIM-AI-FINANCING-COMPANY-GATES-20261027');
  assert.ok(validateSaved(JSON.parse(saved)).ok);
});

test('legacy reset refresh stays narrowly scoped and never replaces saved templates with the new sample',()=>{
  const t=createRemediationInitialTemplate();
  assert.strictEqual(prepareInitialTemplateForReset(t),t);
  t.templateId='SIM-DEFAULT-COMPLEX-01';
  t.revision=1;
  const f=t.draftPlans.find(p=>p.businessType==='interbank_repo_financing');
  f.label='银行间正回购融资17.6亿7天';f.targetYuan=q(17.6);f.repoTerms.tenorDays=7;
  assert.equal(prepareInitialTemplateForReset(t).draftPlans.at(-1).repoTerms.tenorDays,1);
  assert.equal(f.repoTerms.tenorDays,7);
  t.revision=2;assert.strictEqual(prepareInitialTemplateForReset(t),t);
});
