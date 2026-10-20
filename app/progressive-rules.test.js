import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyntheticInitialTemplate,createLegacySyntheticInitialTemplate} from './initial-data.js';
import {evaluateCoreRules} from './core-rules.js';

const base=(nav=1000,cash=100,otherDays=0)=>{
  const initialData=createSyntheticInitialTemplate();
  initialData.portfolio.navYuan=nav;
  initialData.portfolio.accountCashYuan=cash;
  initialData.holdings=[];
  initialData.pendingSettlements=[];
  initialData.maturityCashEvents=[];
  initialData.otherFundBankExposure=initialData.otherFundBankExposure.map(x=>({...x,
    depositYuan:0,cdYuan:0,bondYuan:0,otherYuan:0}));
  initialData.termWeights.assets=[
    {weightId:'CASH',label:'现金',amountYuan:cash,remainingTradingDays:0,sourceAccountCash:true},
    {weightId:'OTHER',label:'其他资产',amountYuan:nav-cash,remainingTradingDays:otherDays},
  ];
  initialData.termWeights.liabilities=[];
  initialData.termWeights.positiveRepos=[];
  return {initialData,plans:[],context:{businessDate:initialData.businessDate},
    summary:{availableYuan:cash},execution:{instructions:{}}};
};
const addHolding=(s,securityId,amountYuan,days)=>{
  const security=s.initialData.securities.find(x=>x.securityId===securityId);
  security.remainingTradingDays=days;
  s.initialData.holdings.push({holdingId:`H-${securityId}`,securityId,amountYuan,sellableYuan:amountYuan});
  s.initialData.termWeights.assets[1].amountYuan-=amountYuan;
  s.initialData.termWeights.assets.push({weightId:`W-${securityId}`,label:'持仓',sourceHoldingId:`H-${securityId}`,
    amountYuan,remainingTradingDays:days});
};
const plan=(type,securityId,issuerId=null,days=null)=>({
  planId:`P-${type}-${securityId ?? 'REPO'}`,businessType:type,securityId,issuerId,
  counterpartyId:issuerId,direction:['cd_sell','bond_sell','interbank_repo_financing'].includes(type)?'inflow':'outflow',
  repoTerms:days===null?null:{market:'INTERBANK',tenorDays:days,annualRate:null},
});
const row=(s,id,options={},subjectId='PORTFOLIO')=>evaluateCoreRules(s,options).rows
  .find(x=>x.ruleId===id && x.subjectId===subjectId);

test('C09 can improve 95 to 92 to 89 over two candidate sales',()=>{
  const s=base(100,5);
  addHolding(s,'BOND-X',95,100);
  const sale=plan('bond_sell','BOND-X');
  assert.equal(row(s,'C09').currentValue,95);
  assert.equal(row(s,'C09').result,'block');
  const first=row(s,'C09',{plan:sale,amountYuan:3});
  assert.equal(first.projectedValue,92);
  assert.equal(first.result,'warn');
  assert.match(first.reason,/仍未达标/);
  const second=row(s,'C09',{projectedActions:[{plan:sale,amountYuan:3}],plan:sale,amountYuan:3});
  assert.equal(second.currentValue,92);
  assert.equal(second.projectedValue,89);
  assert.equal(second.result,'pass');
  assert.equal(evaluateCoreRules(s,{plan:sale,amountYuan:3}).blocking.length,0);
});

test('C03 concentration improves 6 to 5.5 to 5 percent',()=>{
  const s=base();
  addHolding(s,'CD-B',60,10);
  const sale=plan('cd_sell','CD-B','BANK-B');
  assert.equal(row(s,'C03',{},'BANK-B').result,'block');
  const first=row(s,'C03',{plan:sale,amountYuan:5},'BANK-B');
  assert.equal(first.currentValue,0.06);
  assert.equal(first.projectedValue,0.055);
  assert.equal(first.result,'warn');
  const next=row(s,'C03',{projectedActions:[{plan:sale,amountYuan:5}],plan:sale,amountYuan:5},'BANK-B');
  assert.equal(next.currentValue,0.055);
  assert.equal(next.projectedValue,0.05);
  assert.equal(next.result,'pass');
});

test('one breached metric may improve while another remains unchanged and breached',()=>{
  const s=base(1000,100,113);
  addHolding(s,'CD-B',60,0); // C03 6%; C09 94.92 days from OTHER alone.
  const sale=plan('cd_sell','CD-B','BANK-B');
  const result=evaluateCoreRules(s,{plan:sale,amountYuan:5});
  assert.equal(result.blocking.length,0);
  assert.equal(result.rows.find(x=>x.ruleId==='C03'&&x.subjectId==='BANK-B').result,'warn');
  const term=result.rows.find(x=>x.ruleId==='C09');
  assert.equal(term.currentValue,94.92);
  assert.equal(term.projectedValue,94.92);
  assert.equal(term.result,'warn');
  assert.match(term.reason,/未恶化/);
});

test('a term repair also carries an unchanged breach in an unrelated bank',()=>{
  const s=base(1000,100);
  addHolding(s,'CD-B',60,0);
  addHolding(s,'BOND-X',840,113); // 840×113 / 1000 = 94.92 days.
  const sale=plan('bond_sell','BOND-X');
  const result=evaluateCoreRules(s,{plan:sale,amountYuan:10});
  assert.equal(result.blocking.length,0);
  assert.equal(row(s,'C03',{},'BANK-B').result,'block');
  const bank=result.rows.find(x=>x.ruleId==='C03'&&x.subjectId==='BANK-B');
  assert.equal(bank.result,'warn');
  assert.match(bank.reason,/其他已超限指标改善/);
  assert.equal(result.rows.find(x=>x.ruleId==='C09').result,'warn');
});

test('C02 cash shortfall can improve partially and remains below five percent',()=>{
  const s=base(1000,40);
  addHolding(s,'BOND-X',100,1);
  const sale=plan('bond_sell','BOND-X');
  const liquid=row(s,'C02',{plan:sale,amountYuan:5});
  assert.equal(liquid.currentValue,0.04);
  assert.equal(liquid.projectedValue,0.045);
  assert.equal(liquid.result,'warn');
  assert.equal(row(s,'C02').result,'block');
});

test('existing breach cannot worsen; a formerly compliant limit cannot newly breach',()=>{
  const s=base();
  addHolding(s,'CD-B',60,10);
  const buy=plan('cd_buy','CD-B','BANK-B');
  const worse=row(s,'C03',{plan:buy,amountYuan:1},'BANK-B');
  assert.equal(worse.result,'block');
  assert.match(worse.reason,/恶化/);
  const edge=base();
  addHolding(edge,'CD-B',50,10);
  assert.equal(row(edge,'C03',{plan:buy,amountYuan:1},'BANK-B').result,'block');
  assert.match(row(edge,'C03',{plan:buy,amountYuan:1},'BANK-B').reason,/新超限/);
});

test('unchanged unrelated bank breach cannot grant an otherwise neutral candidate',()=>{
  const s=base();
  addHolding(s,'CD-B',60,10);
  const repo=plan('reverse_repo',null,null,0);
  const result=evaluateCoreRules(s,{plan:repo,amountYuan:1});
  const b=result.rows.find(x=>x.ruleId==='C03'&&x.subjectId==='BANK-B');
  assert.equal(b.result,'block');
  assert.match(b.reason,/未改善/);
  assert.ok(result.blocking.includes(b));
  s.initialData.banks.find(x=>x.bankId==='BANK-C').rating=null;
  const withMissing=evaluateCoreRules(s,{plan:repo,amountYuan:1});
  assert.equal(withMissing.rows.find(x=>x.ruleId==='C07'&&x.subjectId==='BANK-C').result,'not_applicable');
});

test('positive repo denominator lowers breached C09 while C01 remains an independent guard',()=>{
  const s=base(100,5);
  addHolding(s,'BOND-X',95,100);
  const financing=plan('interbank_repo_financing',null,null,7);
  const term=row(s,'C09',{plan:financing,amountYuan:3});
  assert.equal(term.currentValue,95);
  assert.equal(term.projectedValue,9500/103);
  assert.equal(term.result,'warn');
  const noCash=base(100,5);
  addHolding(noCash,'BOND-X',95,100);
  noCash.summary.availableYuan=0;
  const buy=plan('bond_buy','BOND-X');
  assert.equal(row(noCash,'C01',{plan:buy,amountYuan:1}).result,'block');
  noCash.summary.availableYuan=null;
  assert.equal(row(noCash,'C01',{plan:buy,amountYuan:1}).result,'missing');
});

test('one yuan at a large limit uses exact integer comparisons',()=>{
  const nav=9000000000000000,limit=450000000000000;
  const s=base(nav,limit,0);
  addHolding(s,'CD-B',limit+2,0);
  const sale=plan('cd_sell','CD-B','BANK-B');
  assert.equal(row(s,'C03',{plan:sale,amountYuan:1},'BANK-B').result,'warn');
  assert.equal(row(s,'C03',{plan:sale,amountYuan:2},'BANK-B').result,'pass');
  assert.doesNotThrow(()=>JSON.stringify(evaluateCoreRules(s,{plan:sale,amountYuan:1})));
});

test('legacy synthetic mode retains its prior C02 strict-improvement exception',()=>{
  const s={initialData:createLegacySyntheticInitialTemplate(),plans:[],
    context:{businessDate:'2026-09-07'},summary:{availableYuan:200000000},
    execution:{instructions:{}}};
  s.initialData.portfolio.navYuan=60000000000;
  const sale=plan('bond_sell','BOND-X');
  assert.equal(s.initialData.demoMode,undefined);
  assert.equal(row(s,'C02',{cashYuan:200000000,plan:sale,amountYuan:1}).result,'warn');
});
