import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_TEMPLATE_VERSION, TERM_WEIGHTS_VERSION, createLegacySyntheticInitialTemplate as createSyntheticInitialTemplate, normalizeInitialTemplate,
  legacyInitialTemplate, deriveTemplateExposure, bankIdForPlan, validatePlanSecurity } from './initial-data.js';

const changed = (template, fn) => { const x = structuredClone(template); fn(x); return x; };

test('synthetic template is normalized, separately mutable and covers dated cash/trade sources', () => {
  const a = createSyntheticInitialTemplate();
  const b = createSyntheticInitialTemplate();
  assert.equal(a.templateVersion, INITIAL_TEMPLATE_VERSION);
  assert.equal(a.provenance.kind, 'synthetic');
  assert.equal(a.portfolio.accountCashYuan, 300000000);
  assert.ok(a.maturityCashEvents.some(e => e.dueDate === a.businessDate &&
    e.amountYuan === 200000000 && !e.includedInOpeningCash));
  assert.ok(a.maturityCashEvents.some(e => e.dueDate === a.businessDate && e.includedInOpeningCash));
  assert.ok(a.pendingSettlements.some(x => x.kind === 'primary_cd_subscription' &&
    x.tradeDate < x.settlementDate && !x.cashIncludedAtOpen));
  assert.ok(a.pendingSettlements.some(x => x.kind === 'secondary_security_trade' &&
    x.tradeDate < x.settlementDate));
  assert.ok(a.draftPlans.some(p => p.settlementDate > p.tradeDate));
  assert.ok(a.draftPlans.length <= 5);
  assert.equal(a.termWeights.version,TERM_WEIGHTS_VERSION);
  assert.equal(a.termWeights.coverage,'complete');
  assert.equal(a.termWeights.assets.reduce((n,x)=>n+x.amountYuan,0),a.portfolio.navYuan);
  a.portfolio.accountCashYuan = 0;
  assert.equal(b.portfolio.accountCashYuan, 300000000);
});

test('exposure is based on current holdings only, with separate company and legacy aggregates', () => {
  const t = createSyntheticInitialTemplate();
  const result = deriveTemplateExposure(t);
  assert.equal(result.governmentBondWithinYearYuan, 2500000000);
  assert.deepEqual([result.byBank['BANK-A'].depositYuan,result.byBank['BANK-A'].cdYuan,
    result.byBank['BANK-A'].totalYuan,result.byBank['BANK-A'].otherFundsYuan,
    result.byBank['BANK-A'].companyTotalYuan],
    [500000000,1000000000,1500000000,1700000000,3200000000]);
  // Confirmed primary CD is a payable source, not an extra holding in this projection.
  assert.equal(result.byBank['BANK-A'].cdYuan, 1000000000);
  assert.equal(bankIdForPlan(t.draftPlans[1], t), 'BANK-A');
  assert.equal(bankIdForPlan(t.draftPlans[3], t), null);
  assert.equal(result.legacyBankExposureYuan, null);
});

test('unknown exposure and tenor remain unknown', () => {
  const t = createSyntheticInitialTemplate();
  t.holdings.find(h => h.holdingId === 'H-CD-A').amountYuan = null;
  t.securities.find(s => s.securityId === 'GOV-01').remainingTradingDays = null;
  const x = deriveTemplateExposure(t);
  assert.equal(x.byBank['BANK-A'].cdYuan, null);
  assert.equal(x.byBank['BANK-A'].totalYuan, null);
  assert.equal(x.governmentBondWithinYearYuan, null);
});

test('template rejects invalid calendar dates, unsafe money, duplicate IDs and broken references', () => {
  const t = createSyntheticInitialTemplate();
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.businessDate='2026-02-30'; })), /公历/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.portfolio.accountCashYuan=1.2; })), /整数元/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.portfolio.navYuan=Number.MAX_SAFE_INTEGER+1; })), /整数元/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.banks.push(structuredClone(x.banks[0])); })), /重复ID/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.holdings[0].securityId='MISSING'; })), /未知证券/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.pendingSettlements[0].issuerId='BANK-B'; })), /不一致/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.pendingSettlements[0].businessType='bond_buy'; })), /品种/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.draftPlans[2].securityId='GOV-01'; })), /品种/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.draftPlans[0].securityId='GOV-01'; })), /不适用证券ID/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.draftPlans[2].issuerId='BANK-A'; })), /发行人/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.pendingSettlements[0].tradeId=x.maturityCashEvents[0].eventId; })), /来源ID重复/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.draftPlans[0].direction='inflow'; })), /方向/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.draftPlans[0].tradeDate='2026-09-04'; })), /计划交易日/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.maturityCashEvents[0].amountYuan=null;
    x.maturityCashEvents[0].includedInOpeningCash=true; })), /未知金额/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.termWeights.assets[0].remainingTradingDays=-1; })), /剩余交易日/);
  assert.throws(() => normalizeInitialTemplate(changed(t,x => { x.termWeights.liabilities.push({
    weightId:x.termWeights.assets[0].weightId,label:'重复',amountYuan:1,remainingTradingDays:1}); })), /跨类别重复/);
  assert.doesNotThrow(() => normalizeInitialTemplate(changed(t,x => { delete x.termWeights; })));
});

test('linked bank security can identify a missing issuer while legacy unlinked plans remain valid', () => {
  const t=createSyntheticInitialTemplate();
  const plan={...t.draftPlans[2],issuerId:null};
  assert.equal(validatePlanSecurity(plan,t),true);
  assert.equal(bankIdForPlan(plan,t),'BANK-B');
  assert.equal(validatePlanSecurity({...plan,securityId:null},t),true);
  assert.doesNotThrow(() => normalizeInitialTemplate(changed(t,x => {x.pendingSettlements[0].issuerId=null;})));
});

test('legacy S13/S10 values stay aggregated without fabricated security positions', () => {
  const base = {
    scenarioId:'S13',context:{businessDate:'2026-09-07',portfolioId:'DEMO-500'},
    inputs:{initialCashYuan:300000000,navYuan:50000000000,bankExposureYuan:3950000000,feeYuan:0,bufferYuan:0},
    ruleConfig:{depositThreshold:'0.08',observationThreshold:'0.082'},
    plans:[{label:'A银行存款',businessType:'deposit',direction:'outflow',counterpartyId:null,
      issuerId:'BANK-A',targetYuan:100000000,termsNote:'',repoTerms:null}],
  };
  const s13 = legacyInitialTemplate(base);
  assert.equal(s13.provenance.kind,'legacy');
  assert.deepEqual(s13.holdings,[]);
  assert.equal(deriveTemplateExposure(s13).legacyBankExposureYuan,3950000000);
  assert.equal(deriveTemplateExposure(s13).byBank['BANK-A'].totalYuan,0);
  const s10 = legacyInitialTemplate(changed(base,x => {
    x.scenarioId='S10'; x.inputs.navYuan=null; x.inputs.bankExposureYuan=null;
  }));
  assert.equal(s10.portfolio.navYuan,null);
  assert.equal(s10.portfolio.legacyBankExposureYuan,null);
});
