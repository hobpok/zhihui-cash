import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModel } from './model.js';
import { createLegacySyntheticInitialTemplate as createSyntheticInitialTemplate } from './initial-data.js';
import { createHistoricalComplexTemplate } from './test-fixtures/historical-complex.js';
import { calculate,calculateFunding,calculateSplit,evaluateConcentration,evaluateCurrentConcentration,
  rankComparableCandidates } from './engine.js';
const independentCases = JSON.parse(readFileSync(new URL('../data/calculation/v2b/cases.json',import.meta.url),'utf8')).cases;

function datedState(plans, availableYuan, futureCashEvents = []) {
  return {context:{businessDate:'2026-09-29'},plans,
    summary:{availableYuan,futureCashEvents,planBalances:plans.map(p => ({planId:p.planId,
      targetYuan:p.targetYuan,filledYuan:0,lockedYuan:0,remainingYuan:p.targetYuan,
      arrangeableYuan:p.targetYuan}))},
    inputs:{navYuan:50000000000,bankExposureYuan:0,feeYuan:0,bufferYuan:0}};
}
const datedBond = (planId,targetYuan,settlementDate,direction = 'outflow') => ({planId,label:planId,
  businessType:direction === 'outflow' ? 'bond_buy' : 'bond_sell',direction,targetYuan,
  tradeDate:'2026-09-29',settlementDate,securityId:'BOND-X',marketTier:'secondary'});

test('T+1 security purchase preserves today headroom and reserves every later settlement date', () => {
  const state = datedState([datedBond('T1-BUY',400000000,'2026-09-30')],500000000);
  const result = calculate(state);
  assert.equal(result.proposal.status,'waiting_conditions');
  assert.equal(result.trace.currentAvailableYuan,500000000);
  assert.equal(result.trace.todayProjectedAvailableYuan,500000000);
  assert.deepEqual(result.trace.futureCashProjection,[{valueDate:'2026-09-30',
    confirmedDeltaYuan:0,proposedDeltaYuan:-400000000,availableYuan:100000000}]);
  assert.deepEqual(result.proposal.steps[0].machineConditions,[{kind:'settlement_capacity',
    valueDate:'2026-09-30',minimumYuan:400000000,planId:'T1-BUY'}]);
  assert.equal(result.trace.steps[0].rules.find(r=>r.ruleId==='DEMO-SETTLEMENT-01').result,'pass');
});

test('future obligations and same-day T+1 purchases share one dated budget', () => {
  const obligation = {sourceId:'OLD-TRADE',valueDate:'2026-10-01',signedDeltaYuan:-200000000,
    confirmed:true,includedInAvailableYuan:false};
  const one = calculate(datedState([datedBond('T1-BUY',400000000,'2026-09-30')],500000000,[obligation]));
  assert.equal(one.proposal.status,'search_exhausted');
  assert.equal(one.trace.steps[0].rules.find(r=>r.ruleId==='DEMO-SETTLEMENT-01').result,'block');
  const two = calculate(datedState([datedBond('BUY-A',300000000,'2026-09-30'),
    datedBond('BUY-B',300000000,'2026-09-30')],500000000));
  assert.equal(two.proposal.status,'search_exhausted');
  assert.ok(two.trace.steps.some(step => step.rules.some(r =>
    r.ruleId === 'DEMO-SETTLEMENT-01' && r.result === 'block')));
});

test('a later T0 purchase cannot spend cash already needed by a T+1 order or old obligation', () => {
  const mixed = datedState([datedBond('A-T1',400000000,'2026-09-30'),
    datedBond('B-T0',400000000,'2026-09-29')],500000000);
  const firstFuture = calculate(mixed,{pathId:'A'});
  const today = firstFuture.trace.steps.find(step=>step.planId==='B-T0');
  assert.equal(today.rules.find(r=>r.ruleId==='DEMO-SETTLEMENT-01').result,'block');
  assert.equal(firstFuture.proposal.status,'blocked_sequence');
  const old = {sourceId:'OLD-OBLIGATION',valueDate:'2026-09-30',signedDeltaYuan:-300000000,
    confirmed:true,includedInAvailableYuan:false};
  const todayOnly = calculate(datedState([datedBond('TODAY-BUY',300000000,'2026-09-29')],
    500000000,[old]));
  assert.equal(todayOnly.trace.steps[0].rules.find(r=>r.ruleId==='DEMO-SETTLEMENT-01').result,'block');
});

test('later sale plan cannot finance same-day purchase or a firm future buy', () => {
  const state = datedState([datedBond('FUTURE-SELL',300000000,'2026-09-30','inflow'),
    datedBond('TODAY-BUY',400000000,'2026-09-29')],300000000);
  const result = calculate(state,{pathId:'A'});
  const buy = result.trace.steps.find(x=>x.planId==='TODAY-BUY');
  assert.equal(buy.afterCashYuan,-100000000);
  assert.equal(buy.rules.find(r=>r.ruleId==='DEMO-CASH-01').result,'waiting_conditions');
  const future = calculate(datedState([datedBond('FUTURE-SELL',300000000,'2026-09-30','inflow'),
    datedBond('FUTURE-BUY',400000000,'2026-09-30')],300000000));
  assert.equal(future.proposal.status,'search_exhausted');
});

test('today included maturities are not re-added and old undated path remains unchanged', () => {
  const included = {sourceId:'TODAY-MATURED',valueDate:'2026-09-29',signedDeltaYuan:200000000,
    confirmed:true,includedInAvailableYuan:true};
  const today = calculate(datedState([datedBond('T1-BUY',400000000,'2026-09-30')],500000000,[included]));
  assert.equal(today.trace.futureCashProjection[0].availableYuan,100000000);
  const old = calculate(createModel().getState(),{pathId:'A'});
  assert.equal(old.proposal.peakShortfallYuan,800000000);
  assert.equal(old.trace.cashContract.mode,'demo_nominal_equals_cash');
});

test('unknown future cash event blocks a dated amount judgment without treating it as zero', () => {
  const unknown = {sourceId:'UNKNOWN-MATURITY',valueDate:'2026-10-01',signedDeltaYuan:null,
    confirmed:true,includedInAvailableYuan:false};
  const result = calculate(datedState([datedBond('T1-BUY',100000000,'2026-09-30')],500000000,[unknown]));
  assert.equal(result.proposal.status,'insufficient_data');
  assert.equal(result.trace.steps[0].rules.find(r=>r.ruleId==='DEMO-SETTLEMENT-01').result,'missing');
  assert.equal(result.trace.futureCashProjection.at(-1).availableYuan,null);
});

test('synthetic template counts confirmed primary CD once beyond opening holdings', () => {
  const model = createModel();
  const state = model.startFromTemplate(createSyntheticInitialTemplate());
  const plan = state.plans.find(p=>p.businessType==='deposit');
  const check = evaluateCurrentConcentration(state,plan,plan.targetYuan);
  assert.equal(check.baseExposureYuan,1500000000);
  assert.equal(check.committedExposureYuan,100000000);
  assert.equal(check.currentExposureYuan,1600000000);
});

test('S13 independent whole-order reference: A, B, C and all 120 permutations', () => {
  const state = createModel().getState();
  const a = calculate(state, { pathId:'A' });
  const b = calculate(state, { pathId:'B' });
  const c = calculate(state, { pathId:'C' });
  assert.equal(a.proposal.status, 'waiting_conditions');
  assert.equal(a.proposal.peakShortfallYuan, 800000000);
  assert.equal(a.trace.projectedFinalCashYuan, -800000000);
  assert.deepEqual(a.proposal.steps.at(-1).machineConditions.find(x => x.kind === 'cash_available'),
    {kind:'cash_available',minimumYuan:1000000000,additionalYuan:800000000,planId:'P-REPO'});
  assert.equal(b.proposal.status, 'blocked_sequence');
  assert.equal(b.proposal.steps.length, 3);
  assert.equal(b.proposal.steps[2].blocked, true);
  assert.equal(b.proposal.peakShortfallYuan, null);
  assert.equal(c.proposal.status, 'waiting_conditions');
  assert.equal(c.proposal.peakShortfallYuan, 1000000000);
  const auto = calculate(state);
  assert.equal(auto.candidates.length, 120);
  assert.equal(auto.candidates.filter(x => x.status === 'blocked_sequence').length, 60);
  assert.equal(auto.proposal.peakShortfallYuan, 800000000);
  assert.equal(auto.trace.search.boundary, 'split_grid_unexplored');
  assert.ok(auto.trace.excludedPreferenceKeys.includes('metric_headroom'));
});

const businessPreferenceTemplate = ({exchange = false, bondCount = 1} = {}) => {
  const template = createSyntheticInitialTemplate();
  const repo = template.draftPlans.find(p => p.businessType === 'reverse_repo');
  const bond = template.draftPlans.find(p => p.businessType === 'bond_buy');
  template.draftPlans = [repo,...Array.from({length:bondCount},(_,i) =>
    ({...bond,label:`普通债券买入${i + 1}`,targetYuan:bondCount > 1 ? 10000000 : bond.targetYuan}))];
  if (exchange) template.draftPlans.push({...repo,label:'交易所融券',businessType:'exchange_repo_lending',
    targetYuan:100000000,repoTerms:{market:'SSE',tenorDays:1,annualRate:null}});
  return template;
};
const businessOrder = (state,result) => result.proposal.steps.map(step =>
  state.plans.find(p => p.planId === step.planId).businessType);

test('explicit business preference changes feasible candidate order for both lending markets', () => {
  for (const [key,expected] of [
    ['reverse_repo_first',['reverse_repo','exchange_repo_lending','bond_buy']],
    ['liquidity_last',['bond_buy','reverse_repo','exchange_repo_lending']]]) {
    const model = createModel(); model.startFromTemplate(businessPreferenceTemplate({exchange:true}));
    model.setPreferences([key]);
    const state = model.getState(), result = calculate(state);
    assert.ok(['feasible','waiting_conditions'].includes(result.proposal.status));
    assert.deepEqual(businessOrder(state,result),expected);
    assert.equal(result.trace.orderedPreferenceKeys[0],key);
    assert.equal(result.candidates[0].firstDifferenceKey,'candidateId');
  }
  const legacy = createModel(); legacy.startFromTemplate(businessPreferenceTemplate());
  assert.deepEqual(calculate(legacy.getState()).trace.orderedPreferenceKeys,
    ['settlement_safety','fewer_warnings','metric_headroom']);
  assert.deepEqual(businessOrder(legacy.getState(),calculate(legacy.getState())),['reverse_repo','bond_buy']);
});

test('business preference cannot promote an exchange lending order after its window closes', () => {
  const model = createModel(); model.startFromTemplate(businessPreferenceTemplate({exchange:true}));
  model.setPreferences(['reverse_repo_first']);
  model.setMarketClock({time:'15:30:00'});
  const result = calculate(model.getState());
  assert.equal(result.proposal.status,'waiting_conditions');
  assert.ok(result.trace.diagnostics.some(x => x.code === 'exchange-window-closed'));
  assert.equal(result.proposal.steps.some(step =>
    model.getState().plans.find(p => p.planId === step.planId).businessType === 'exchange_repo_lending' &&
    !step.blocked),false);
});

test('business preference shapes bounded search before its candidate budget runs out', () => {
  for (const [key,first,last] of [
    ['reverse_repo_first','reverse_repo','bond_buy'],['liquidity_last','bond_buy','reverse_repo']]) {
    const model = createModel(); model.startFromTemplate(businessPreferenceTemplate({bondCount:7}));
    model.setPreferences([key]);
    const state = model.getState(), result = calculate(state,{candidateBudget:10,nodeLimit:250});
    assert.equal(result.trace.search.strategy,'bounded_prefix');
    assert.equal(result.trace.search.boundary,'candidate_budget');
    assert.equal(result.trace.search.exploredCandidates,10);
    assert.ok(['feasible','waiting_conditions'].includes(result.proposal.status));
    assert.equal(businessOrder(state,result)[0],first);
    assert.equal(businessOrder(state,result).at(-1),last);
  }
});

test('business ranking compares repo positions from the first difference', () => {
  const candidates = [[0,3],[1,2]].map((repoPositions,i) => ({
    candidateId:`C${i}`,hardPass:true,completeTarget:true,inputsComplete:true,
    comparisonGroupId:'G',executionClass:'conditional',peakFundingYuan:0,warningsNew:0,repoPositions
  }));
  const input = {candidates,comparisonGroupId:'G',executionClass:'conditional'};
  assert.deepEqual(rankComparableCandidates({...input,priority:['reverse_repo_first']}).rankedIds,['C0','C1']);
  assert.deepEqual(rankComparableCandidates({...input,priority:['liquidity_last']}).rankedIds,['C1','C0']);
});

test('deposit threshold compares exact pre-trade numerator and allows edited B order', () => {
  const model = createModel();
  const original = calculate(model.getState(), {pathId:'B'});
  assert.equal(original.trace.steps[2].beforeExposureYuan, 4050000000);
  assert.equal(original.trace.steps[2].rules[0].result, 'block');
  model.setRuleConfig({ depositThreshold:'0.081' });
  const exact = calculate(model.getState(), {pathId:'B'});
  assert.equal(exact.proposal.status, 'waiting_conditions');
  assert.equal(exact.trace.steps[2].rules[0].result, 'pass');
  assert.equal(exact.trace.steps[2].afterRatio, '8.30%');
  assert.equal(exact.trace.steps[2].rules[1].result, 'warn');
});

test('S10 proposes 3+7, then replans only the remaining 7 without replaying A', () => {
  const model = createModel(); model.reset('S10');
  const initial = calculate(model.getState());
  assert.deepEqual(initial.proposal.steps.map(x => [x.stepId,x.nominalYuan]), [['I-A',300000000],['I-B',700000000]]);
  assert.equal(initial.proposal.steps[0].machineConditions.length, 0);
  assert.deepEqual(initial.proposal.steps[1].machineConditions.map(x => x.kind),
    ['previous_confirmed','filled','payable_cleared','cash_available']);
  assert.equal(initial.trace.planBalances[0].remainingYuan, 1000000000);
  model.selectProgress('funding7');
  const progressed = calculate(model.getState());
  assert.deepEqual(progressed.proposal.steps.map(x => [x.stepId,x.nominalYuan]), [['I-B',700000000]]);
  assert.deepEqual(progressed.proposal.steps[0].machineConditions.map(x => x.kind),
    ['filled','payable_cleared','cash_available']);
  assert.equal(progressed.trace.currentAvailableYuan, 700000000);
  assert.equal(progressed.trace.planBalances[0].remainingYuan, 700000000);
});

test('null inputs and unit mismatch remain explicit', () => {
  const model = createModel();
  model.setInputs({ navYuan:null });
  assert.equal(calculate(model.getState(),{pathId:'A'}).proposal.status,'insufficient_data');
  model.setInputs({ navYuan:50000000000 });
  model.updatePlan('P-DEP',{targetYuan:100000001});
  const mismatch = calculate(model.getState());
  assert.equal(mismatch.proposal.status,'search_exhausted');
  assert.deepEqual(mismatch.trace.unitMismatch,[{planId:'P-DEP',unmatchedYuan:1}]);
  assert.equal(mismatch.trace.planBalances.find(x => x.planId === 'P-DEP').remainingYuan,100000001);
});

test('bounded enumeration reports its unvisited boundary without infeasibility claim', () => {
  const result = calculate(createModel().getState(),{nodeLimit:2});
  assert.equal(result.trace.search.truncated,true);
  assert.ok(['node_limit','candidate_budget'].includes(result.trace.search.boundary));
  assert.equal(result.proposal.status,'search_exhausted');
});

test('safe integer amounts are enforced and threshold comparison uses BigInt', () => {
  const model = createModel();
  model.setInputs({ bankExposureYuan:40000000000, navYuan:500000000000 });
  const r = calculate(model.getState(),{pathId:'A'});
  assert.equal(r.trace.steps[1].rules[0].result,'pass'); // exactly 8%, strict greater-than rule
  model.setInputs({ bankExposureYuan:40000000001 });
  const blocked = calculate(model.getState(),{pathId:'A'});
  assert.equal(blocked.trace.steps[1].rules[0].result,'block');
});

test('8.2% observation boundary warns inclusively while missing fees stay unknown', () => {
  const model = createModel();
  model.setInputs({ bankExposureYuan:4000000000 });
  const exact = calculate(model.getState(),{pathId:'A'});
  assert.equal(exact.trace.steps[1].beforeRatio,'8.00%');
  assert.equal(exact.trace.steps[1].rules[0].result,'pass');
  assert.equal(exact.trace.steps[1].afterRatio,'8.20%');
  assert.equal(exact.trace.steps[1].rules[1].result,'warn');
  model.setInputs({ feeYuan:null });
  const missing = calculate(model.getState(),{pathId:'A'});
  assert.equal(missing.proposal.status,'insufficient_data');
  assert.equal(missing.proposal.peakShortfallYuan,null);
  assert.equal(missing.trace.cashContract.formalConversionDefined,false);
});

test('custom five-business plan amounts are preserved under the stated demo cash contract', () => {
  const model = createModel();
  model.updatePlan('P-REPO',{targetYuan:600000000});
  model.updatePlan('P-SELL',{targetYuan:300000000});
  const result = calculate(model.getState());
  assert.equal(result.trace.planBalances.find(x=>x.planId==='P-REPO').targetYuan,600000000);
  assert.equal(result.trace.planBalances.find(x=>x.planId==='P-SELL').targetYuan,300000000);
  assert.equal(result.trace.cashContract.mode,'demo_nominal_equals_cash');
  assert.equal(result.candidates.length,120);
});

test('independent 2B literal funding expectations F01–F05', () => {
  for (const item of independentCases.filter(x=>x.kind==='funding')) {
    assert.deepEqual(calculateFunding(item.input),item.expected,item.caseId);
  }
});

test('independent 2B concentration expectations D01–D10 and W01–W04', () => {
  for (const item of independentCases.filter(x=>x.kind==='deposit_threshold')) {
    const output = evaluateConcentration(item.input);
    assert.equal(output.depositResult,item.expected.result,item.caseId);
    assert.equal(output.crossProductDelta,item.expected.crossProductDelta,item.caseId);
    assert.equal(output.actualPostExposureYuan,item.expected.actualPostExposureYuan,item.caseId);
  }
  for (const item of independentCases.filter(x=>x.kind==='warning_threshold')) {
    const output = evaluateConcentration({action:'cd_buy',exposureYuan:item.input.postExposureYuan,
      navYuan:item.input.navYuan,addExposureYuan:0});
    assert.equal(output.warningResult,item.expected.result,item.caseId);
    assert.equal(output.observationHeadroomYuan,item.expected.headroomYuan,item.caseId);
  }
});

test('independent 2B split and ranking expectations S01–S05, R01–R04', () => {
  for (const item of independentCases.filter(x=>x.kind==='split_amount')) {
    assert.deepEqual(calculateSplit(item.input),item.expected,item.caseId);
  }
  for (const item of independentCases.filter(x=>x.kind==='ranking')) {
    const output = rankComparableCandidates(item.input);
    assert.deepEqual(output.eligibleIds,item.expected.eligibleIds,item.caseId);
    assert.deepEqual(output.rankedIds,item.expected.rankedIds,item.caseId);
    assert.deepEqual(output.excludedPreferenceKeys,item.expected.excludedPreferenceKeys,item.caseId);
  }
});

test('9.01亿 aligns to 100万元, while a smaller tail remains unmatched', () => {
  const model = createModel();
  model.updatePlan('P-REPO',{targetYuan:901000000});
  assert.equal(calculate(model.getState()).trace.unitMismatch.length,0);
  model.updatePlan('P-REPO',{targetYuan:900100000});
  assert.deepEqual(calculate(model.getState()).trace.unitMismatch,
    [{planId:'P-REPO',unmatchedYuan:100000}]);
});

test('A-bank certificate sale never guesses a release of exposure', () => {
  const model = createModel();
  model.updatePlan('P-SELL',{issuerId:'BANK-A'});
  const result = calculate(model.getState(),{pathId:'A'});
  assert.equal(result.proposal.status,'insufficient_data');
  assert.equal(result.trace.steps[0].afterExposureYuan,null);
  assert.equal(result.trace.steps[1].rules[0].result,'missing');
});

const withFinancing = (market = 'SSE',type = 'exchange_repo_financing') => {
  const state = createModel().getState();
  const plan = {planId:'P-FUND',label:'经理手动建立融资1亿',businessType:type,direction:'inflow',
    counterpartyId:null,issuerId:null,targetYuan:100000000,termsNote:'',version:1,
    repoTerms:{market,tenorDays:1,annualRate:null}};
  state.plans.push(plan);
  state.summary.planBalances.push({planId:plan.planId,targetYuan:plan.targetYuan,filledYuan:0,
    lockedYuan:0,remainingYuan:plan.targetYuan,arrangeableYuan:plan.targetYuan});
  state.repoResources = { INTERBANK:{quotaConfirmedYuan:200000000,pledgeConfirmedYuan:200000000},
    SSE:{quotaConfirmedYuan:200000000,pledgeConfirmedYuan:200000000},
    SZSE:{quotaConfirmedYuan:200000000,pledgeConfirmedYuan:200000000} };
  state.marketClock = {time:'09:30:00',isTradingDay:true,timezone:'Asia/Shanghai'};
  return state;
};

test('manual financing creates qualified conditional cash; later outflow waits for its actual credit', () => {
  for (const [market,type] of [['SSE','exchange_repo_financing'],['INTERBANK','interbank_repo_financing']]) {
    const state = withFinancing(market,type);
    const result = calculate(state);
    assert.equal(result.proposal.status,'waiting_conditions');
    assert.equal(result.trace.expectedFinancingYuan,100000000);
    assert.equal(result.trace.cashContract.unitsByPlan['P-FUND'],market === 'SSE' ? 1000 : 1000000);
    const one = result.candidates.find(x => x.status === 'waiting_conditions');
    assert.ok(one);
    const selected = result.proposal.steps;
    const fund = selected.find(x => x.planId === 'P-FUND');
    assert.deepEqual(fund.machineConditions.filter(x => ['quota_confirmed','pledge_confirmed'].includes(x.kind))
      .map(x => x.kind),['pledge_confirmed']);
    if (market === 'SSE') assert.ok(fund.machineConditions.some(x => x.kind === 'exchange_window_open'));
    const fundIndex = selected.indexOf(fund);
    if (fundIndex < selected.length - 1) assert.ok(selected.slice(fundIndex + 1)
      .filter(x => state.plans.find(p => p.planId === x.planId).direction === 'outflow')
      .every(x => x.machineConditions.some(c => c.kind === 'funds_available' && c.planId === 'P-FUND')));
  }
});

test('unknown pledge capacity or exchange clock is insufficient data', () => {
  const state = withFinancing();
  state.repoResources.SSE.pledgeConfirmedYuan = null;
  assert.equal(calculate(state).proposal.status,'insufficient_data');
  state.repoResources.SSE.pledgeConfirmedYuan = 200000000;
  state.marketClock = null;
  assert.equal(calculate(state).proposal.status,'insufficient_data');
});

test('exchange financing after 15:30 keeps its target but cannot be approved for the same day', () => {
  const state = withFinancing();
  state.marketClock.time = '15:30:00';
  const result = calculate(state);
  assert.equal(result.proposal.status,'search_exhausted');
  assert.equal(result.trace.search.statusCounts.blocked_sequence,result.trace.search.exploredCandidates);
  assert.equal(result.trace.planBalances.find(x=>x.planId==='P-FUND').targetYuan,100000000);
  assert.ok(result.proposal.conflicts.some(x=>x.includes('新申报窗口已结束')));
});

test('exchange repo tenor outside the confirmed term set remains insufficient data', () => {
  const state = withFinancing();
  state.plans.at(-1).repoTerms.tenorDays = 5;
  const result = calculate(state);
  assert.equal(result.proposal.status,'insufficient_data');
  assert.ok(result.trace.steps.some(step => step.rules.some(x => x.ruleId === 'DEMO-REPO-TERMS' && x.result === 'missing')));
});

test('eight actions retain a bounded top set and exact explored counts', () => {
  const state = withFinancing();
  state.plans.push({planId:'P-IB',label:'银行间融资1亿',businessType:'interbank_repo_financing',direction:'inflow',
    counterpartyId:null,issuerId:null,targetYuan:100000000,termsNote:'',version:1,
    repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}});
  state.plans.push({planId:'P-EX-LEND',label:'交易所融券（逆回购）1亿',businessType:'exchange_repo_lending',direction:'outflow',
    counterpartyId:null,issuerId:null,targetYuan:100000000,termsNote:'',version:1,
    repoTerms:{market:'SZSE',tenorDays:1,annualRate:null}});
  for (const plan of state.plans.slice(-2)) state.summary.planBalances.push({planId:plan.planId,targetYuan:plan.targetYuan,
    filledYuan:0,lockedYuan:0,remainingYuan:plan.targetYuan,arrangeableYuan:plan.targetYuan});
  const result = calculate(state,{nodeLimit:2000});
  assert.equal(new Set(state.plans.map(x=>x.businessType)).size,8);
  assert.ok(['node_limit','candidate_budget'].includes(result.trace.search.boundary));
  assert.ok(result.candidates.length <= 20);
  assert.equal(Object.values(result.trace.search.statusCounts).reduce((a,b)=>a+b,0),
    result.trace.search.exploredCandidates);
  assert.equal(result.trace.search.retainedCandidates,result.candidates.length);
  const wider = calculate(state);
  assert.ok(wider.trace.search.nodes <= 100000);
  assert.equal(wider.trace.search.truncated,true);
  assert.equal(wider.trace.search.strategy,'bounded_prefix');
  assert.ok(wider.candidates.length <= 20);
  assert.equal(Object.values(wider.trace.search.statusCounts).reduce((a,b)=>a+b,0),
    wider.trace.search.exploredCandidates);
});

test('exchange repo lending is a cash outflow with window and term checks but no financing resources', () => {
  const state = withFinancing();
  const lending = {planId:'P-LEND',label:'交易所融券（逆回购）',businessType:'exchange_repo_lending',direction:'outflow',
    counterpartyId:null,issuerId:null,targetYuan:100000000,termsNote:'',version:1,
    repoTerms:{market:'SSE',tenorDays:7,annualRate:null}};
  state.plans = [lending];
  state.summary.planBalances = [{planId:'P-LEND',targetYuan:100000000,filledYuan:0,lockedYuan:0,
    remainingYuan:100000000,arrangeableYuan:100000000}];
  state.repoResources.SSE = {quotaConfirmedYuan:null,pledgeConfirmedYuan:null};
  const result = calculate(state);
  assert.equal(result.proposal.status,'waiting_conditions');
  assert.equal(result.trace.projectedFinalCashYuan,200000000);
  assert.equal(result.trace.expectedFinancingYuan,0);
  assert.equal(result.trace.cashContract.unitsByPlan['P-LEND'],1000);
  assert.equal(result.proposal.steps[0].machineConditions.some(x=>['quota_confirmed','pledge_confirmed'].includes(x.kind)),false);
  assert.equal(result.proposal.steps[0].machineConditions.some(x=>x.kind==='exchange_window_open'),true);
  assert.equal(result.trace.steps[0].rules.some(x=>x.ruleId==='DEMO-REPO-QUOTA'),false);
  state.marketClock.time = '15:30:00';
  const closed = calculate(state);
  assert.equal(closed.proposal.status,'search_exhausted');
  assert.equal(closed.trace.planBalances[0].remainingYuan,100000000);
  state.marketClock.time = '09:30:00';
  state.plans[0].repoTerms.tenorDays = 5;
  assert.equal(calculate(state).proposal.status,'insufficient_data');
});

test('exchange lending respects 1000元 unit and 100亿元 single-order limit', () => {
  const state = withFinancing();
  state.plans = [{planId:'P-LEND',label:'交易所融券',businessType:'exchange_repo_lending',direction:'outflow',
    counterpartyId:null,issuerId:null,targetYuan:1001000,termsNote:'',version:1,
    repoTerms:{market:'SZSE',tenorDays:1,annualRate:null}}];
  state.summary.planBalances = [{planId:'P-LEND',targetYuan:1001000,filledYuan:0,lockedYuan:0,
    remainingYuan:1001000,arrangeableYuan:1001000}];
  assert.equal(calculate(state).trace.unitMismatch.length,0);
  state.plans[0].targetYuan = 1000500;
  for (const key of ['targetYuan','remainingYuan','arrangeableYuan']) state.summary.planBalances[0][key] = 1000500;
  assert.equal(calculate(state).trace.search.boundary,'unit_mismatch');
  state.plans[0].targetYuan = 15000000000;
  for (const key of ['targetYuan','remainingYuan','arrangeableYuan']) state.summary.planBalances[0][key] = 15000000000;
  const split = calculate(state);
  assert.deepEqual(split.proposal.steps.map(x=>x.nominalYuan),[10000000000,5000000000]);
});

test('exchange repo over 100亿元 is divided into at most two valid orders', () => {
  const state = withFinancing();
  state.plans = [state.plans.at(-1)];
  state.summary.planBalances = [state.summary.planBalances.at(-1)];
  state.plans[0].targetYuan = 15000000000;
  state.summary.planBalances[0].targetYuan = 15000000000;
  state.summary.planBalances[0].remainingYuan = 15000000000;
  state.summary.planBalances[0].arrangeableYuan = 15000000000;
  state.repoResources.SSE = {quotaConfirmedYuan:15000000000,pledgeConfirmedYuan:15000000000};
  const split = calculate(state);
  assert.deepEqual(split.proposal.steps.map(x => x.nominalYuan),[10000000000,5000000000]);
  assert.equal(split.proposal.steps.reduce((n,x)=>n+x.nominalYuan,0),state.plans[0].targetYuan);
  state.plans[0].targetYuan = 21000000000;
  for (const key of ['targetYuan','remainingYuan','arrangeableYuan']) state.summary.planBalances[0][key] = 21000000000;
  const exceeded = calculate(state);
  assert.equal(exceeded.proposal.status,'search_exhausted');
  assert.equal(exceeded.trace.search.boundary,'per_order_limit');
});

test('two financing plans consume shared pledge capacity cumulatively', () => {
  const state = withFinancing();
  const one = state.plans.at(-1);
  state.plans = [one,{...one,planId:'P-FUND-2',label:'第二笔交易所融资'}];
  state.summary.planBalances = [state.summary.planBalances.at(-1),
    {...state.summary.planBalances.at(-1),planId:'P-FUND-2'}];
  state.repoResources.SSE = {quotaConfirmedYuan:150000000,pledgeConfirmedYuan:150000000};
  const result = calculate(state);
  const second = result.trace.steps[1];
  assert.ok(!second.rules.some(x => x.ruleId === 'DEMO-REPO-QUOTA'));
  assert.ok(second.rules.some(x => x.ruleId === 'DEMO-REPO-PLEDGE' && x.result === 'waiting_conditions'));
});

test('new bond sale is conditional cash and always asks for holding confirmation', () => {
  const state = createModel().getState();
  const sale = {planId:'P-BOND-SELL',label:'其他现券卖出2亿',businessType:'bond_sell',direction:'inflow',
    counterpartyId:null,issuerId:'ISSUER-D',targetYuan:200000000,termsNote:'',version:1};
  const buy = {planId:'P-BOND-BUY',label:'其他现券买入4亿',businessType:'bond_buy',direction:'outflow',
    counterpartyId:null,issuerId:'ISSUER-E',targetYuan:400000000,termsNote:'',version:1};
  state.plans = [sale,buy];
  state.summary.planBalances = [sale,buy].map(p=>({planId:p.planId,targetYuan:p.targetYuan,
    filledYuan:0,lockedYuan:0,remainingYuan:p.targetYuan,arrangeableYuan:p.targetYuan}));
  const result = calculate(state);
  assert.equal(result.proposal.status,'waiting_conditions');
  assert.equal(result.trace.currentAvailableYuan,300000000);
  assert.equal(result.trace.expectedSaleYuan,200000000);
  assert.equal(result.trace.expectedFinancingYuan,0);
  const sellStep = result.proposal.steps.find(s=>s.planId===sale.planId);
  assert.deepEqual(sellStep.machineConditions.filter(c=>c.kind==='holding_confirmed'),
    [{kind:'holding_confirmed',planId:sale.planId,minimumYuan:200000000}]);
  const laterBuy = result.proposal.steps.find(s=>s.planId===buy.planId);
  assert.ok(laterBuy.machineConditions.some(c=>c.kind==='funds_available' && c.planId===sale.planId && c.minimumYuan===100000000));
  sale.issuerId = 'BANK-A';
  const unknownRelease = calculate(state);
  assert.equal(unknownRelease.proposal.status,'insufficient_data');
  assert.equal(unknownRelease.trace.steps.find(s=>s.planId===sale.planId).afterExposureYuan,null);
});

test('all nine distinct business types search within the fixed budget and retain top 20', () => {
  const state = withFinancing();
  const extra = [
    {planId:'P-IB-9',label:'银行间融资',businessType:'interbank_repo_financing',direction:'inflow',
      counterpartyId:null,issuerId:null,targetYuan:100000000,termsNote:'',version:1,
      repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}},
    {planId:'P-EX-LEND-9',label:'交易所融券',businessType:'exchange_repo_lending',direction:'outflow',
      counterpartyId:null,issuerId:null,targetYuan:100000000,termsNote:'',version:1,
      repoTerms:{market:'SZSE',tenorDays:1,annualRate:null}},
    {planId:'P-BOND-SELL-9',label:'其他现券卖出',businessType:'bond_sell',direction:'inflow',
      counterpartyId:null,issuerId:'ISSUER-D',targetYuan:100000000,termsNote:'',version:1},
  ];
  for (const p of extra) {
    state.plans.push(p);
    state.summary.planBalances.push({planId:p.planId,targetYuan:p.targetYuan,filledYuan:0,lockedYuan:0,
      remainingYuan:p.targetYuan,arrangeableYuan:p.targetYuan});
  }
  assert.equal(new Set(state.plans.map(p=>p.businessType)).size,9);
  const result = calculate(state);
  assert.ok(result.trace.search.nodes <= 100000);
  assert.ok(['node_limit','candidate_budget'].includes(result.trace.search.boundary));
  assert.equal(result.trace.search.truncated,true);
  assert.ok(result.candidates.length <= 20);
  assert.equal(Object.values(result.trace.search.statusCounts).reduce((a,b)=>a+b,0),result.trace.search.exploredCandidates);
  const tenth = {...extra[2],planId:'P-BOND-SELL-10'};
  state.plans.push(tenth);
  state.summary.planBalances.push({...state.summary.planBalances.at(-1),planId:tenth.planId});
  const ten = calculate(state);
  assert.equal(ten.trace.search.actionCount,10);
  assert.notEqual(ten.trace.search.boundary,'action_budget');
  assert.equal(ten.proposal.unfinishedYuan,ten.trace.planBalances.reduce((n,x)=>n+x.remainingYuan,0));
});

test('S13 plus 8亿正回购 and 3亿交易所融券 has a complete fixed-path candidate', () => {
  const state = createModel().getState();
  state.summary.availableYuan = 2000000000;
  const additions = [
    {planId:'P-NEW-FUND',label:'正回购8亿',businessType:'interbank_repo_financing',direction:'inflow',
      counterpartyId:null,issuerId:null,targetYuan:800000000,repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}},
    {planId:'P-NEW-LEND',label:'交易所融券3亿',businessType:'exchange_repo_lending',direction:'outflow',
      counterpartyId:null,issuerId:null,targetYuan:300000000,repoTerms:{market:'SSE',tenorDays:1,annualRate:null}},
  ];
  for (const plan of additions) {
    state.plans.push(plan);
    state.summary.planBalances.push({planId:plan.planId,targetYuan:plan.targetYuan,filledYuan:0,
      lockedYuan:0,remainingYuan:plan.targetYuan,arrangeableYuan:plan.targetYuan});
  }
  state.repoResources.INTERBANK = {quotaConfirmedYuan:800000000,pledgeConfirmedYuan:800000000};
  const result = calculate(state,{pathId:'A'});
  assert.equal(result.proposal.status,'waiting_conditions');
  assert.equal(result.proposal.steps.length,7);
  assert.ok(result.proposal.steps.some(step => step.planId === 'P-NEW-FUND'));
  assert.ok(result.proposal.steps.some(step => step.planId === 'P-NEW-LEND'));
  assert.equal(result.trace.diagnostics.some(x => x.severity === 'missing' || x.severity === 'block'),false);
  state.repoResources.INTERBANK.pledgeConfirmedYuan = null;
  const missing = calculate(state,{pathId:'A'});
  assert.equal(missing.proposal.status,'insufficient_data');
  assert.deepEqual(missing.trace.diagnostics.find(x => x.code === 'repo-pledge-missing'),{
    code:'repo-pledge-missing',severity:'missing',planId:'P-NEW-FUND',
    message:'正回购8亿缺INTERBANK质押能力的已确认金额。',action:'repo-settings'});
});

test('current A-bank exposure counts each filled and locked yuan once and keeps issuer authority', () => {
  const state = createModel().getState();
  const custom = {planId:'P-CUSTOM-A',label:'自定义A存单',businessType:'cd_buy',direction:'outflow',
    issuerId:'BANK-A',counterpartyId:'BANK-B',targetYuan:100000000};
  state.plans.push(custom);
  state.summary.planBalances.push({planId:custom.planId,targetYuan:100000000,filledYuan:30000000,
    lockedYuan:30000000,remainingYuan:70000000,arrangeableYuan:40000000});
  state.progress.ledger[custom.planId] = [30000000,30000000];
  state.execution.instructions['I-TEST'] = {planId:custom.planId,nominalYuan:30000000,cancelledYuan:0,status:'accepted'};
  const current = evaluateCurrentConcentration(state,{businessType:'deposit',issuerId:'BANK-A'},1000000);
  assert.equal(current.committedExposureYuan,60000000);
  assert.equal(current.currentExposureYuan,4010000000);
  assert.equal(current.depositResult,'block');
  const other = evaluateCurrentConcentration(state,{businessType:'deposit',issuerId:'BANK-B',
    counterpartyId:'BANK-A'},1000000);
  assert.equal(other.bankId,'BANK-B');
  assert.equal(other.depositResult,'not_applicable');
  assert.equal(other.warningResult,'not_applicable');
  assert.equal(evaluateCurrentConcentration(state,{businessType:'deposit',issuerId:null,
    counterpartyId:'BANK-A'},1000000).depositResult,'block');
});

test('diagnostics identify unit, clock, search budget and action boundary without changing proposal', () => {
  const state = withFinancing();
  state.plans = [state.plans.at(-1)];
  state.summary.planBalances = [state.summary.planBalances.at(-1)];
  state.marketClock = null;
  let result = calculate(state);
  assert.equal(result.trace.diagnostics.find(x => x.code === 'exchange-clock-missing').planId,'P-FUND');
  state.marketClock = {time:'09:30:00',isTradingDay:true,timezone:'Asia/Shanghai'};
  state.plans[0].targetYuan = 100000001;
  for (const key of ['targetYuan','remainingYuan','arrangeableYuan']) state.summary.planBalances[0][key] = 100000001;
  result = calculate(state);
  assert.equal(result.trace.diagnostics.find(x => x.code === 'unit-mismatch').severity,'block');
  result = calculate(createModel().getState(),{nodeLimit:2});
  assert.equal(result.trace.diagnostics.find(x => x.code === 'search-budget').severity,'info');
  assert.equal(result.proposal.status,'search_exhausted');
});

function manySyntheticPlans({bankC = 0,unknown = false} = {}) {
  const t = createSyntheticInitialTemplate();
  t.portfolio.accountCashYuan = 2000000000;
  t.termWeights.assets.find(x => x.weightId === 'TW-CASH').amountYuan = 2000000000;
  t.termWeights.assets.find(x => x.weightId === 'TW-OTHER').amountYuan -= 1700000000;
  const deposit = t.draftPlans.find(x => x.businessType === 'deposit');
  const cd = t.draftPlans.find(x => x.businessType === 'cd_sell');
  t.draftPlans = [
    ...Array.from({length:10},(_,i) => ({...deposit,label:`A存款${i+1}`,targetYuan:1000000})),
    ...Array.from({length:bankC},(_,i) => ({...cd,label:`C存单${i+1}`,businessType:'cd_buy',
      direction:'outflow',securityId:'CD-C',issuerId:'BANK-C',targetYuan:100000000}))
  ];
  if (unknown) t.banks.find(x => x.bankId === 'BANK-C').rating = null;
  const model = createModel(); model.startFromTemplate(t);
  return model.getState();
}

test('ten independent synthetic actions form a cumulative ready group with an explicit search budget', () => {
  const result = calculate(manySyntheticPlans(),{candidateBudget:12});
  assert.equal(result.trace.search.actionCount,10);
  assert.equal(result.trace.search.strategy,'bounded_prefix');
  assert.equal(result.trace.search.boundary,'candidate_budget');
  assert.equal(result.trace.search.exploredCandidates,12);
  assert.equal(result.proposal.steps.length,10);
  assert.equal(result.proposal.groups.find(g => g.status === 'ready')?.stepIds.length,10);
  assert.equal(result.proposal.unarrangedYuan,0);
  assert.equal(result.trace.progress.stages.at(-1).unarrangedYuan,0);
  assert.equal(result.proposal.steps.some(s => s.machineConditions.some(c => c.kind === 'previous_confirmed')),false);
});

test('new deposit gate leaves the whole deposit unarranged when its full amount cannot pass', () => {
  const template=createHistoricalComplexTemplate();
  template.draftPlans=template.draftPlans.slice(0,2);
  template.otherFundBankExposure.find(x=>x.bankId==='SIM-BANK-CDRCB').bondYuan=50000000;
  const model=createModel(); model.startFromTemplate(template);
  const result=calculate(model.getState());
  const deposit=result.proposal.steps.find(x=>x.planId===model.getState().plans[1].planId);
  assert.equal(deposit,undefined);
  assert.equal(result.proposal.planCoverage[1].targetYuan,600000000);
  assert.equal(result.proposal.planCoverage[1].unarrangedYuan,600000000);
  assert.equal(result.proposal.planCoverage[1].suggestedYuan,0);
  assert.equal(result.trace.search.excludedActions.find(x=>x.planId===model.getState().plans[1].planId).status,
    'blocked_sequence');
});

test('a synthetic buy that relies on projected sale exposure waits for that sale fill', () => {
  const t = createSyntheticInitialTemplate();
  t.portfolio.accountCashYuan = 2000000000;
  t.termWeights.assets.find(x => x.weightId === 'TW-CASH').amountYuan = 2000000000;
  t.termWeights.assets.find(x => x.weightId === 'TW-OTHER').amountYuan -= 1700000000;
  const cd = t.draftPlans.find(x => x.businessType === 'cd_sell');
  t.draftPlans = [{...cd,label:'卖出C',securityId:'CD-C',issuerId:'BANK-C',targetYuan:100000000},
    ...Array.from({length:4},(_,i) => ({...cd,label:`买入C${i+1}`,businessType:'cd_buy',
      direction:'outflow',securityId:'CD-C',issuerId:'BANK-C',targetYuan:100000000}))];
  const model = createModel(); model.startFromTemplate(t);
  const result = calculate(model.getState(),{pathId:'A'});
  assert.equal(result.proposal.steps.length,5);
  const saleId = result.proposal.steps[0].planId;
  assert.ok(result.proposal.steps.at(-1).machineConditions.some(c => c.kind === 'filled' &&
    c.planId === saleId && c.minimumYuan === 100000000));
  assert.equal(result.proposal.steps.slice(1,4).some(s => s.machineConditions.some(c => c.kind === 'previous_confirmed')),false);
});

test('a long-bond buy relying on projected repo financing tenor waits for the financing fill', () => {
  const t = createSyntheticInitialTemplate();
  t.termWeights.assets.find(x => x.weightId === 'TW-OTHER').remainingTradingDays = 90;
  t.draftPlans = [
    {...t.draftPlans[0],label:'正回购融资',businessType:'interbank_repo_financing',
      direction:'inflow',targetYuan:100000000},
    {...t.draftPlans.find(x => x.businessType === 'bond_buy'),label:'买入长券',
      securityId:'BOND-C',issuerId:'BANK-C',targetYuan:100000000}
  ];
  const model = createModel(); model.startFromTemplate(t); model.refreshSnapshot();
  const view = model.generateProposal('A');
  assert.equal(view.proposal.steps.length,2);
  const [finance,buy] = view.proposal.steps;
  assert.ok(buy.machineConditions.some(c => c.kind === 'filled' && c.planId === finance.planId &&
    c.minimumYuan === finance.nominalYuan));
  assert.equal(buy.machineConditions.some(c => c.kind === 'funds_available'),false);
  model.approveProposal();
  assert.equal(model.getState().stepReadiness.find(x => x.stepId === buy.stepId).ready,false);
  model.send(finance.stepId);
  assert.equal(model.getState().stepReadiness.find(x => x.stepId === buy.stepId).ready,false);
});

test('below-five-percent improving sale records its warning in the approvable proposal', () => {
  const t = createSyntheticInitialTemplate();
  t.holdings.find(x => x.securityId === 'GOV-01').amountYuan = 2000000000;
  t.holdings.find(x => x.securityId === 'GOV-01').sellableYuan = 2000000000;
  t.termWeights.assets.find(x => x.weightId === 'TW-GOV').amountYuan = 2000000000;
  t.termWeights.assets.find(x => x.weightId === 'TW-OTHER').amountYuan += 500000000;
  t.draftPlans = [t.draftPlans.find(x => x.businessType === 'cd_sell')];
  const model = createModel(); model.startFromTemplate(t);
  const result = calculate(model.getState());
  assert.equal(result.proposal.status,'waiting_conditions');
  assert.ok(result.proposal.conflicts.some(x => x.includes('C02') && x.includes('改善现金')));
  assert.ok(result.candidates.some(x => x.warningCount === 1));
});

test('multi-bank cumulative limit splits a large group and preserves excluded targets', () => {
  const result = calculate(manySyntheticPlans({bankC:5}),{nodeLimit:250});
  assert.equal(result.trace.search.actionCount,15);
  assert.ok(result.proposal.steps.length >= 10);
  assert.ok(result.proposal.unarrangedYuan > 0);
  assert.ok(result.proposal.planCoverage.some(x => x.unarrangedYuan > 0));
  assert.ok(result.proposal.blockers.some(x => x.code === 'subset-excluded' && x.message.includes('BB')));
  assert.equal(result.proposal.unfinishedYuan,result.trace.planBalances.reduce((n,x)=>n+x.remainingYuan,0));
  assert.equal(result.trace.search.boundary,'node_limit');
  assert.match(result.proposal.message,/可行子集|搜索范围/);
});

test('unknown hard-rule input excludes affected large-group actions and reports the needed field', () => {
  const state = manySyntheticPlans({bankC:1});
  state.initialData.banks.find(x => x.bankId === 'BANK-C').rating = null;
  const result = calculate(state,{nodeLimit:250});
  assert.ok(result.proposal.steps.length >= 10);
  assert.ok(result.proposal.unarrangedYuan >= 100000000);
  assert.ok(result.proposal.blockers.some(x => x.severity === 'missing' && x.message.includes('rating')));
  assert.equal(result.trace.search.complete,false);
});

test('missing bank identity never inherits a CD counterparty or bypasses review', () => {
  const state = createModel().getState();
  const plan = {planId:'P-IDENTITY',label:'待确认银行',businessType:'cd_buy',direction:'outflow',
    issuerId:null,counterpartyId:'BANK-A',targetYuan:1000000};
  state.plans = [plan];
  state.summary.planBalances = [{planId:plan.planId,targetYuan:1000000,filledYuan:0,
    lockedYuan:0,remainingYuan:1000000,arrangeableYuan:1000000}];
  for (const [type,issuer,counterparty,needed] of [
    ['cd_buy',null,'BANK-A','issuerId'],
    ['cd_buy',null,null,'issuerId'],
    ['deposit',null,null,'bankId'],
  ]) {
    Object.assign(plan,{businessType:type,issuerId:issuer,counterpartyId:counterparty});
    const check = evaluateCurrentConcentration(state,plan,1000000);
    assert.deepEqual(check.needed,[needed]);
    assert.equal(check.depositResult,'missing');
    assert.equal(check.warningResult,'missing');
    const result = calculate(state);
    assert.equal(result.proposal.status,'insufficient_data');
    assert.deepEqual(result.trace.diagnostics.find(x => x.code === 'bank-identity-missing'),{
      code:'bank-identity-missing',severity:'missing',planId:plan.planId,
      message:`待确认银行缺${type === 'cd_buy' ? '发行银行' : '存款银行'}身份；交易对手不能代替存单发行人。`,
      action:'edit-plan'});
  }
  Object.assign(plan,{businessType:'cd_buy',issuerId:'BANK-B',counterpartyId:'BANK-A'});
  const knownB = evaluateCurrentConcentration(state,plan,1000000);
  assert.deepEqual(knownB.needed,[]);
  assert.equal(knownB.depositResult,'not_applicable');
  assert.equal(knownB.warningResult,'not_applicable');
  assert.equal(calculate(state).proposal.status,'feasible');
});

test('unknown committed bank identity makes subsequent A-bank exposure indeterminate', () => {
  const state = createModel().getState();
  const unknown = {planId:'P-UNKNOWN-FILLED',label:'发行人待核存单',businessType:'cd_buy',direction:'outflow',
    issuerId:null,counterpartyId:'BANK-B',targetYuan:1000000};
  state.plans.push(unknown);
  state.summary.planBalances.push({planId:unknown.planId,targetYuan:1000000,filledYuan:1000000,
    lockedYuan:0,remainingYuan:0,arrangeableYuan:0});
  const a = state.plans.find(p => p.planId === 'P-DEP');
  const check = evaluateCurrentConcentration(state,a,100000000);
  assert.equal(check.currentExposureYuan,null);
  assert.deepEqual(check.needed,['bankId:P-UNKNOWN-FILLED']);
  assert.equal(check.depositResult,'missing');
  assert.equal(calculate(state,{pathId:'A'}).proposal.status,'insufficient_data');
});


