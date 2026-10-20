import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { evaluateSelectedSequence } from './engine.js';

const rule = (candidate, id) => candidate.trace.at(-1).rules.find(row => row.ruleId === id);
const legacyState = () => createModel().getState();
const financingState = () => {
  const state = legacyState();
  const plan = {planId:'P-FUND',label:'交易所融资一亿元',businessType:'exchange_repo_financing',
    direction:'inflow',targetYuan:100000000,repoTerms:{market:'SSE',tenorDays:1,annualRate:null}};
  state.plans.push(plan);
  state.summary.planBalances.push({planId:plan.planId,targetYuan:plan.targetYuan,filledYuan:0,
    lockedYuan:0,remainingYuan:plan.targetYuan,arrangeableYuan:plan.targetYuan});
  state.repoResources = {SSE:{pledgeConfirmedYuan:200000000}};
  state.marketClock = {time:'09:30:00',isTradingDay:true,timezone:'Asia/Shanghai'};
  return state;
};
const selected = (state,planId,nominalYuan = 100000000) =>
  evaluateSelectedSequence(state,[{planId,nominalYuan}]);

test('dated settlement block gives the actual future floor, requirement and shortfall', () => {
  const plan = {planId:'T1',label:'明日买债',businessType:'bond_buy',direction:'outflow',
    targetYuan:400000000,tradeDate:'2026-09-29',settlementDate:'2026-09-30'};
  const state = {context:{businessDate:'2026-09-29'},plans:[plan],
    summary:{availableYuan:500000000,planBalances:[{planId:'T1',targetYuan:400000000,
      filledYuan:0,lockedYuan:0,remainingYuan:400000000,arrangeableYuan:400000000}],
      futureCashEvents:[{sourceId:'OLD',valueDate:'2026-10-01',signedDeltaYuan:-200000000,
        confirmed:true,includedInAvailableYuan:false}]},
    inputs:{navYuan:50000000000,bankExposureYuan:0,feeYuan:1000000,bufferYuan:10000000}};
  const result = selected(state,'T1',400000000);
  const row = rule(result,'DEMO-SETTLEMENT-01');
  assert.equal(result.status,'blocked_sequence');
  assert.equal(row.name,'交收日已确认业务头寸');
  assert.equal(row.currentYuan,300000000);
  assert.equal(row.requiredYuan,411000000);
  assert.match(row.reason,/2026-09-30.*411000000元.*缺口111000000元/);
});

test('unknown future cash remains null and names the missing settlement check', () => {
  const plan = {planId:'T1',label:'明日买债',businessType:'bond_buy',direction:'outflow',
    targetYuan:100000000,tradeDate:'2026-09-29',settlementDate:'2026-09-30'};
  const state = {context:{businessDate:'2026-09-29'},plans:[plan],
    summary:{availableYuan:500000000,planBalances:[{planId:'T1',targetYuan:100000000,
      filledYuan:0,lockedYuan:0,remainingYuan:100000000,arrangeableYuan:100000000}],
      futureCashEvents:[{sourceId:'UNKNOWN',valueDate:'2026-10-01',signedDeltaYuan:null,
        confirmed:true,includedInAvailableYuan:false}]},
    inputs:{navYuan:50000000000,bankExposureYuan:0,feeYuan:0,bufferYuan:0}};
  const row = rule(selected(state,'T1'),'DEMO-SETTLEMENT-01');
  assert.equal(row.result,'missing');
  assert.equal(row.currentYuan,null);
  assert.equal(row.requiredYuan,100000000);
  assert.match(row.reason,/已确认业务头寸或现金缓冲未知/);
});

test('pledge wait and missing state expose market, used amount and confirmed amount', () => {
  const state = financingState();
  state.repoResources.SSE.pledgeConfirmedYuan = 70000000;
  const waiting = rule(selected(state,'P-FUND'),'DEMO-REPO-PLEDGE');
  assert.equal(waiting.result,'waiting_conditions');
  assert.equal(waiting.availableYuan,70000000);
  assert.equal(waiting.requiredYuan,100000000);
  assert.match(waiting.reason,/SSE.*需100000000元.*剩余70000000元/);
  state.repoResources.SSE.pledgeConfirmedYuan = null;
  const missing = rule(selected(state,'P-FUND'),'DEMO-REPO-PLEDGE');
  assert.equal(missing.result,'missing');
  assert.equal(missing.confirmedYuan,null);
  assert.match(missing.reason,/SSE.*未知.*100000000元/);
});

test('closed exchange window and missing repo terms identify their actual inputs', () => {
  const state = financingState();
  state.marketClock.time = '15:30:00';
  const closed = rule(selected(state,'P-FUND'),'DEMO-EXCHANGE-WINDOW');
  assert.equal(closed.result,'closed');
  assert.equal(closed.currentTime,'15:30:00');
  assert.match(closed.reason,/SSE.*15:30:00/);
  state.plans.at(-1).repoTerms.tenorDays = 5;
  const terms = rule(selected(state,'P-FUND'),'DEMO-REPO-TERMS');
  assert.equal(terms.result,'missing');
  assert.equal(terms.tenorDays,5);
  assert.match(terms.reason,/SSE.*5天/);
});

test('legacy deposit block and cash wait explain the measured values', () => {
  const state = legacyState();
  state.inputs.bankExposureYuan = 4100000000;
  const blocked = rule(selected(state,'P-DEP'),'DEMO-EXP-01');
  assert.equal(blocked.result,'block');
  assert.equal(blocked.currentYuan,4100000000);
  assert.equal(blocked.navYuan,50000000000);
  assert.match(blocked.reason,/4100000000元.*0.08/);
  state.inputs.bankExposureYuan = 3950000000;
  const waiting = rule(selected(state,'P-REPO',1000000000),'DEMO-CASH-01');
  assert.equal(waiting.result,'waiting_conditions');
  assert.equal(waiting.currentYuan,300000000);
  assert.equal(waiting.requiredYuan,1000000000);
  assert.match(waiting.reason,/至少1000000000元.*300000000元.*700000000元/);
});
