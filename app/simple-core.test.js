import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticInitialTemplate, createLegacySyntheticInitialTemplate,
  deriveTemplateExposure, normalizeInitialTemplate, openingAccountCash,
  upgradeToSingleDayTemplate, SINGLE_DAY_DEMO_MODE } from './initial-data.js';
import { evaluateCoreRules } from './core-rules.js';

const state = t => ({initialData:t,plans:[],context:{businessDate:t.businessDate},
  summary:{availableYuan:500000000},execution:{instructions:{}}});
const rule = (s,id,subject='PORTFOLIO') => evaluateCoreRules(s).rows
  .find(x=>x.ruleId===id && x.subjectId===subject);

test('new seed splits whole due deposit; receipt timing cannot restore tenor or bank exposure',()=>{
  const t=createSyntheticInitialTemplate();
  assert.equal(t.demoMode,SINGLE_DAY_DEMO_MODE);
  assert.equal(t.portfolio.accountCashYuan,300000000);
  assert.equal(openingAccountCash(t),300000000);
  assert.equal(deriveTemplateExposure(t).byBank['BANK-A'].depositYuan,300000000);
  const s=state(t), before=rule(s,'C09');
  assert.equal(before.result,'pass');
  s.execution.cashEventReceipts={R:{sourceId:'MAT-T0-DEP-A',amountYuan:200000000}};
  const after=rule(s,'C09');
  assert.equal(after.result,'pass');
  assert.equal(after.numeratorYuan,before.numeratorYuan);
  assert.equal(after.denominatorYuan,before.denominatorYuan);
  assert.equal(deriveTemplateExposure(t).byBank['BANK-A'].depositYuan,300000000);
  t.maturityCashEvents[0].includedInOpeningCash=true;
  assert.equal(openingAccountCash(t),500000000);
  assert.equal(rule(s,'C09').numeratorYuan,before.numeratorYuan);
});

test('signed net subscription enters opening cash, while NAV remains user supplied',()=>{
  const t=createSyntheticInitialTemplate();
  t.portfolio.netSubscriptionYuan=-10000000;
  t.maturityCashEvents[0].includedInOpeningCash=true;
  assert.equal(openingAccountCash(t),490000000);
  assert.equal(t.portfolio.navYuan,50000000000);
  assert.doesNotThrow(()=>normalizeInitialTemplate(t));
  t.portfolio.netSubscriptionYuan=Number.MAX_SAFE_INTEGER;
  assert.equal(openingAccountCash(t),null);
  assert.throws(()=>normalizeInitialTemplate(t),/超出安全整数元范围/);
  t.portfolio.netSubscriptionYuan=-600000000;
  assert.throws(()=>normalizeInitialTemplate(t),/日初净赎回\/到期付款超过已到账现金/);
});

test('a linked maturing government bond leaves C02 liquid assets once',()=>{
  const t=createSyntheticInitialTemplate();
  t.securities.find(x=>x.securityId==='GOV-01').remainingTradingDays=0;
  t.maturityCashEvents.push({eventId:'MAT-GOV',label:'政府债今日兑付',kind:'security_redemption',
    direction:'inflow',amountYuan:2500000000,dueDate:t.businessDate,
    includedInOpeningCash:false,sourceHoldingId:'H-GOV'});
  assert.equal(deriveTemplateExposure(t).governmentBondWithinYearYuan,0);
  const s=state(t);
  assert.equal(rule(s,'C02').numeratorYuan,500000000);
  assert.equal(rule(s,'C09').result,'pass');
});

test('only C09 adds outstanding repo to NAV; other fund rules keep NAV',()=>{
  const t=createSyntheticInitialTemplate();
  t.portfolio.navYuan=500;
  t.portfolio.accountCashYuan=0;
  t.holdings=[]; t.pendingSettlements=[]; t.maturityCashEvents=[];
  t.termWeights.assets=[
    {weightId:'CASH',label:'现金',amountYuan:0,remainingTradingDays:0,sourceAccountCash:true},
    {weightId:'A',label:'存量资产',amountYuan:500,remainingTradingDays:100},
    {weightId:'B',label:'新增资产',amountYuan:100,remainingTradingDays:30},
  ];
  t.termWeights.liabilities=[{weightId:'L',label:'正回购负债',amountYuan:100,remainingTradingDays:0}];
  t.termWeights.positiveRepos=[{weightId:'R',label:'正回购调整',amountYuan:100,remainingTradingDays:0}];
  const s=state(t); s.summary.availableYuan=0;
  const c09=rule(s,'C09');
  assert.equal(c09.denominatorYuan,600);
  assert.equal(c09.numeratorYuan,53000);
  assert.equal(c09.projectedValue,53000/600);
  assert.equal(rule(s,'C02').denominatorYuan,500);
  assert.equal(rule(s,'C03','BANK-B').denominatorYuan,500);
  assert.equal(rule(s,'C04','BANK-A').denominatorYuan,500);
  assert.equal(rule(s,'C06','BANK-A').denominatorYuan,500);
  assert.equal(rule(s,'C07','BANK-C').denominatorYuan,500);
});

test('single-day validation rejects future and non-principal inputs without altering old seed',()=>{
  const old=createLegacySyntheticInitialTemplate();
  assert.equal(old.demoMode,undefined);
  assert.equal(old.maturityCashEvents.length,3);
  assert.equal(old.termWeights.calendar,'weekday-252-demo-v1');
  assert.throws(()=>upgradeToSingleDayTemplate(old),/请从新默认模板开始/);
  assert.equal(old.demoMode,undefined);
  const t=createSyntheticInitialTemplate();
  const changed=fn=>{const x=structuredClone(t);fn(x);return x;};
  assert.throws(()=>normalizeInitialTemplate(changed(x=>{x.portfolio.feeYuan=1;})),/费用/);
  assert.throws(()=>normalizeInitialTemplate(changed(x=>{x.draftPlans[0].settlementDate='2026-09-08';})),/当日交收/);
  assert.throws(()=>normalizeInitialTemplate(changed(x=>{x.draftPlans[0].repoTerms.annualRate='0.02';})),/不计利息/);
  assert.throws(()=>normalizeInitialTemplate(changed(x=>{x.securities[0].instrumentKind='abs';})),/ABS/);
});
