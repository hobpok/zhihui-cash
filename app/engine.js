// Deterministic calculations for the versioned 2B demonstration domain.
// Projected single-day financing and sale inflows depend on fill. None of
// these calculations is an authoritative balance, financing commitment, or
// substitute for the dispatch-time check.
import { BUSINESS_TYPES,BUSINESS_DIRECTIONS,isFinancing,isExchangeRepo,isSecuritySale,unitFor,windowStatus,
  EXCHANGE_REPO_MAX_ORDER_YUAN,EXCHANGE_REPO_TENORS } from './business.js';
import { deriveTemplateExposure,bankIdForPlan } from './initial-data.js';
import { coreRulesEnabled,evaluateCoreRules } from './core-rules.js';
export const DEMO_UNIT_YUAN = 1000000;
export const DEFAULT_NODE_LIMIT = 100000;
export const DEFAULT_LARGE_NODE_LIMIT = 2500;
export const DEFAULT_ACTION_BUDGET = 64;
export const DEFAULT_CANDIDATE_BUDGET = 256;
export const MAX_RETAINED_CANDIDATES = 20;
// At most 64 actions, each with at most 53 safe-integer unit positions, can
// require a binary search. Keep this separate from order/candidate budgets.
const MAX_PARTIAL_EVALUATIONS = 4096;
const PARTIAL_OUTFLOW_TYPES = new Set(['reverse_repo','exchange_repo_lending','deposit','cd_buy','bond_buy']);
const DEFAULT_PREFERENCES = ['settlement_safety', 'fewer_warnings', 'metric_headroom'];
const OPTIONAL_PREFERENCES = ['reverse_repo_first','liquidity_last'];
const REVERSE_REPO_TYPES = new Set(['reverse_repo','exchange_repo_lending']);
const singleDay = state => state.initialData?.demoMode === 'single-day-principal-v1';
const safe = (n, label) => {
  if (!Number.isSafeInteger(n)) throw new Error(`${label}超出安全整数元范围`);
  return n;
};
const add = (a, b, label = '金额') => safe(a + b, label);
const sub = (a, b, label = '金额') => safe(a - b, label);
const nonnegative = (value, label) => value === null ? null :
  (Number.isSafeInteger(value) && value >= 0 ? value : (() => { throw new Error(`${label}必须为非负安全整数元或null`); })());
const ratio = value => {
  if (typeof value !== 'string' || !/^(?:0\.[0-9]{1,12}|1(?:\.0{1,12})?)$/.test(value)) throw new Error('阈值格式无效');
  const [whole, fraction = ''] = value.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  return { numerator: BigInt(whole) * denominator + BigInt(fraction || 0), denominator };
};
const thresholdResult = (numerator, denominator, threshold, inclusive) => {
  if (numerator === null || denominator === null || denominator <= 0) return 'missing';
  const q = ratio(threshold);
  const left = BigInt(numerator) * q.denominator;
  const right = BigInt(denominator) * q.numerator;
  return inclusive ? (left >= right ? 'warn' : 'pass') : (left > right ? 'block' : 'pass');
};
export function evaluateConcentration({ action, exposureYuan, navYuan, addExposureYuan = 0,
  depositThreshold = '0.08', observationThreshold = '0.082', appliesToBankA = true }) {
  nonnegative(exposureYuan, '敞口'); nonnegative(navYuan, 'NAV'); nonnegative(addExposureYuan, '新增敞口');
  const relevant = appliesToBankA && ['deposit','cd_buy'].includes(action);
  const depositResult = action === 'deposit' && appliesToBankA ?
    thresholdResult(exposureYuan,navYuan,depositThreshold,false) : 'not_applicable';
  const q = ratio(depositThreshold);
  const crossProductDelta = depositResult === 'missing' || depositResult === 'not_applicable' ? null :
    (BigInt(exposureYuan) * q.denominator - BigInt(navYuan) * q.numerator).toString();
  const actualPostExposureYuan = !relevant ? exposureYuan :
    depositResult === 'block' ? exposureYuan :
    exposureYuan === null || navYuan === null || navYuan <= 0 ? null : add(exposureYuan,addExposureYuan,'预计敞口');
  const warningResult = !relevant ? 'not_applicable' :
    thresholdResult(actualPostExposureYuan,navYuan,observationThreshold,true);
  let observationHeadroomYuan = null;
  if (relevant && actualPostExposureYuan !== null && navYuan !== null && navYuan > 0) {
    const w = ratio(observationThreshold);
    const numerator = BigInt(navYuan) * w.numerator - BigInt(actualPostExposureYuan) * w.denominator;
    if (numerator % w.denominator === 0n) observationHeadroomYuan = safe(Number(numerator / w.denominator),'观察线余量');
  }
  return { depositResult, warningResult, crossProductDelta, actualPostExposureYuan, observationHeadroomYuan };
}
export function calculateFunding({ initialYuan, availableFundingYuan, lockedOutflowYuan, remainingOutflowYuan,
  expectedSaleYuan, feeYuan, bufferYuan }) {
  // Business balances can be negative when today's maturity payables exceed cash.
  // Preserve that deficit in the funding need; transaction amounts remain nonnegative.
  if (initialYuan!==null) safe(initialYuan,'initialYuan');
  for (const [key,value] of Object.entries({availableFundingYuan,lockedOutflowYuan,
    remainingOutflowYuan,expectedSaleYuan,feeYuan,bufferYuan})) nonnegative(value,key);
  const currentAvailableYuan = [initialYuan,availableFundingYuan,lockedOutflowYuan].some(x => x === null) ? null :
    sub(add(initialYuan,availableFundingYuan),lockedOutflowYuan);
  const noSaleTimingGapYuan = currentAvailableYuan === null || remainingOutflowYuan === null ? null :
    Math.max(0,sub(remainingOutflowYuan,currentAvailableYuan));
  const baseNetGapYuan = noSaleTimingGapYuan === null || expectedSaleYuan === null ? null :
    Math.max(0,sub(sub(remainingOutflowYuan,currentAvailableYuan),expectedSaleYuan));
  const allInGapYuan = baseNetGapYuan === null || feeYuan === null || bufferYuan === null ? null :
    Math.max(0,add(add(sub(sub(remainingOutflowYuan,currentAvailableYuan),expectedSaleYuan),feeYuan),bufferYuan));
  return { currentAvailableYuan, baseNetGapYuan, noSaleTimingGapYuan, allInGapYuan,
    allInResult:allInGapYuan === null ? 'missing' : 'known' };
}
export function calculateSplit({targetYuan,filledYuan,lockedYuan,availableYuan,feeYuan,bufferYuan,
  unitYuan = DEMO_UNIT_YUAN}) {
  if (availableYuan!==null) safe(availableYuan,'availableYuan');
  for (const [key,value] of Object.entries({targetYuan,filledYuan,lockedYuan,feeYuan,bufferYuan})) nonnegative(value,key);
  if (!Number.isSafeInteger(unitYuan) || unitYuan <= 0) throw new Error('交易单位无效');
  const arrangeableYuan = sub(sub(targetYuan,filledYuan),lockedYuan);
  if (arrangeableYuan < 0) throw new Error('计划名义金额不守恒');
  const common = { arrangeableYuan,targetRetainedYuan:targetYuan };
  if (arrangeableYuan % unitYuan !== 0) return { ...common,proposedNowYuan:null,
    unarrangedAfterProposalYuan:null,result:'unit_conflict' };
  if ([availableYuan,feeYuan,bufferYuan].some(x => x === null)) return { ...common,proposedNowYuan:null,
    unarrangedAfterProposalYuan:null,result:'missing' };
  const budget = Math.max(0,sub(sub(availableYuan,feeYuan),bufferYuan));
  const proposedNowYuan = Math.min(arrangeableYuan,Math.floor(budget / unitYuan) * unitYuan);
  return { ...common,proposedNowYuan,unarrangedAfterProposalYuan:sub(arrangeableYuan,proposedNowYuan),
    result:proposedNowYuan > 0 ? 'proposed' : 'waiting' };
}
const asPercent = (numerator, denominator) => numerator === null || denominator === null || denominator <= 0 ? null :
  `${(Number((BigInt(numerator) * 10000n * 2n + BigInt(denominator)) / (2n * BigInt(denominator))) / 100).toFixed(2)}%`;
// A plan's issuer is authoritative. Only deposits without an issuer use the
// counterparty as the deposit-taking bank in this demonstration.
const bankIdOf = (plan,template) => template && template.provenance?.kind !== 'legacy' ? bankIdForPlan(plan,template) :
  plan?.issuerId || (plan?.businessType === 'deposit' ? plan.counterpartyId : null);
const requiresBankIdentity = (plan,template) => ['deposit','cd_buy'].includes(plan?.businessType) && !bankIdOf(plan,template);
const isBankA = (plan,template) => bankIdOf(plan,template) === 'BANK-A';
const exposureDelta = (plan,template) => isBankA(plan,template) && ['deposit', 'cd_buy'].includes(plan.businessType);
const identityNeeded = (plan,template) => requiresBankIdentity(plan,template) ?
  [plan.businessType === 'cd_buy' ? 'issuerId' : 'bankId'] : [];
function plannedConcentration(plan, exposureYuan, navYuan, amountYuan, depositThreshold, observationThreshold,template) {
  if (requiresBankIdentity(plan,template)) return {depositResult:'missing',warningResult:'missing',
    crossProductDelta:null,actualPostExposureYuan:null,observationHeadroomYuan:null};
  return evaluateConcentration({action:plan?.businessType,exposureYuan,navYuan,
    addExposureYuan:amountYuan,depositThreshold,observationThreshold,appliesToBankA:exposureDelta(plan,template)});
}
const conditionText = conditions => conditions.length ? conditions.map(c => {
  if (c.kind === 'cash_available') return `手动下达前确认可用资金至少${c.minimumYuan}元`;
  if (c.kind === 'settlement_capacity') return `${c.valueDate}及后续交收日确认业务头寸至少${c.minimumYuan}元`;
  if (c.kind === 'funds_available') return c.basis === 'fill' ?
    `${c.planId}累计成交至少${c.minimumYuan}元` : `${c.planId}到账cash_available累计至少${c.minimumYuan}元`;
  if (c.kind === 'pledge_confirmed') return `${c.market}已确认剩余质押能力至少${c.minimumYuan}元`;
  if (c.kind === 'exchange_window_open') return `${c.market}交易所回购新申报时段开放`;
  if (c.kind === 'filled') return `${c.planId}累计成交至少${c.minimumYuan}元`;
  if (c.kind === 'payable_cleared') return `${c.planId}对应应付已结清`;
  if (c.kind === 'holding_confirmed') return `${c.planId}持仓及卖出可用量已核实`;
  return `${c.stepId}成交及占用已反映`;
}).join('；') + '；最新现金与规则复核通过' : null;
const balances = state => {
  if (state.summary?.planBalances) return state.summary.planBalances;
  return state.plans.map(plan => {
    const [filledYuan, lockedYuan] = state.progress?.ledger?.[plan.planId] ?? [0, 0];
    return { planId: plan.planId, targetYuan: plan.targetYuan, filledYuan,
      lockedYuan, remainingYuan: sub(plan.targetYuan, filledYuan),
      arrangeableYuan: sub(sub(plan.targetYuan, filledYuan), lockedYuan) };
  });
};
export function evaluateCurrentConcentration(state, plan, amountYuan) {
  nonnegative(amountYuan, '本次金额');
  const template = state.initialData ?? null;
  const applicable = exposureDelta(plan,template);
  const templateExposure = template?.provenance?.kind !== 'legacy' &&
    state.summary?.exposureAdjustmentsByBankYuan ? deriveTemplateExposure(template) : null;
  const baseExposureYuan = templateExposure ?
    templateExposure.byBank['BANK-A']?.totalYuan ?? null : state.inputs?.bankExposureYuan ?? null;
  const navYuan = state.inputs?.navYuan ?? null;
  let committedExposureYuan = 0;
  const unknownCommittedPlanIds = [];
  if (templateExposure) {
    const adjustments = state.summary.exposureAdjustmentsByBankYuan;
    committedExposureYuan = adjustments['BANK-A'] ?? 0;
    safe(committedExposureYuan,'已确认敞口净调整');
    for (const row of balances(state)) {
      const other = state.plans?.find(p => p.planId === row.planId);
      if (requiresBankIdentity(other,template) && add(row.filledYuan,row.lockedYuan,'已成交及锁定敞口') > 0)
        unknownCommittedPlanIds.push(row.planId);
    }
  } else {
    // Legacy planBalances already reconciles progress and live execution.
    for (const row of balances(state)) {
      const other = state.plans?.find(p => p.planId === row.planId);
      if (requiresBankIdentity(other,template) && add(row.filledYuan,row.lockedYuan,'已成交及锁定敞口') > 0)
        unknownCommittedPlanIds.push(row.planId);
      if (exposureDelta(other,template)) committedExposureYuan = add(committedExposureYuan,
        add(row.filledYuan,row.lockedYuan,'已成交及锁定敞口'),'已成交及锁定敞口');
    }
  }
  const currentExposureYuan = baseExposureYuan === null || unknownCommittedPlanIds.length ? null :
    add(baseExposureYuan,committedExposureYuan,'当前敞口');
  const needed = [...identityNeeded(plan,template),...(applicable ? [
    ...(baseExposureYuan === null ? ['bankExposureYuan'] : []),
    ...(navYuan === null || navYuan === 0 ? ['navYuan'] : []),
    ...unknownCommittedPlanIds.map(id => `bankId:${id}`),
  ] : [])];
  return { ...plannedConcentration(plan,currentExposureYuan,navYuan,amountYuan,
    state.ruleConfig?.depositThreshold ?? '0.08',state.ruleConfig?.observationThreshold ?? '0.082',template),
    needed,appliesToBankA:applicable,bankId:bankIdOf(plan,template),baseExposureYuan,
    committedExposureYuan,currentExposureYuan,unknownCommittedPlanIds };
}
const available = state => {
  if (state.summary && Object.hasOwn(state.summary, 'availableYuan')) return state.summary.availableYuan;
  const cash = state.progress?.cash;
  if (!cash || cash.settledBalanceYuan === null) return null;
  return sub(cash.settledBalanceYuan,
    add(add(cash.localReservedYuan, cash.platformReservedYuan), cash.payableReservedYuan));
};
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === value;
};
const isDatedSecurity = plan => ['cd_buy','cd_sell','bond_buy','bond_sell'].includes(plan?.businessType);
function cashDates(state, today) {
  const events = state.summary?.futureCashEvents ?? [];
  if (!Array.isArray(events)) throw new Error('未来现金事件列表无效');
  const seen = new Set(), deltaByDate = new Map();
  for (const event of events) {
    if (!event || typeof event.sourceId !== 'string' || !event.sourceId || seen.has(event.sourceId) ||
      !validDate(event.valueDate) || (event.signedDeltaYuan !== null && !Number.isSafeInteger(event.signedDeltaYuan)) ||
      typeof event.confirmed !== 'boolean' || typeof event.includedInAvailableYuan !== 'boolean')
      throw new Error('未来现金事件字段或来源ID无效');
    seen.add(event.sourceId);
    // Today's events and already included amounts are represented in summary.availableYuan.
    if (event.confirmed && !event.includedInAvailableYuan && event.valueDate > today) {
      const prior = deltaByDate.has(event.valueDate) ? deltaByDate.get(event.valueDate) : 0;
      deltaByDate.set(event.valueDate,prior === null || event.signedDeltaYuan === null ? null :
        add(prior,event.signedDeltaYuan));
    }
  }
  return deltaByDate;
}
function futureFloor(todayCash, startDate, eventDeltas, actionDeltas) {
  if (todayCash === null) return null;
  let balance = todayCash, floor = null;
  const dates = [...new Set([...eventDeltas.keys(),...actionDeltas.keys(),startDate])].sort();
  for (const date of dates) {
    const delta = eventDeltas.has(date) ? eventDeltas.get(date) : 0;
    if (delta === null) return null;
    balance = add(balance,add(delta,actionDeltas.get(date) ?? 0));
    if (date >= startDate) floor = floor === null ? balance : Math.min(floor,balance);
  }
  return floor;
}
function futureProjection(todayCash, eventDeltas, actionDeltas) {
  let balance = todayCash;
  return [...new Set([...eventDeltas.keys(),...actionDeltas.keys()])].sort().map(valueDate => {
    const confirmedDeltaYuan = eventDeltas.has(valueDate) ? eventDeltas.get(valueDate) : 0;
    const proposedDeltaYuan = actionDeltas.get(valueDate) ?? 0;
    balance = balance === null || confirmedDeltaYuan === null ? null :
      add(balance,add(confirmedDeltaYuan,proposedDeltaYuan));
    return {valueDate,confirmedDeltaYuan,proposedDeltaYuan,availableYuan:balance};
  });
}
const settlementDateFor = (plan,today) => isDatedSecurity(plan) && validDate(plan.settlementDate) &&
  plan.settlementDate > today ? plan.settlementDate : null;
const selectedPreferences = state => {
  const keys = state.preferences?.orderedKeys ?? [];
  if (!Array.isArray(keys) || new Set(keys).size !== keys.length ||
    keys.some(k => ![...DEFAULT_PREFERENCES,...OPTIONAL_PREFERENCES].includes(k)) ||
    OPTIONAL_PREFERENCES.every(k => keys.includes(k))) throw new Error('偏好顺序无效');
  return [...keys, ...DEFAULT_PREFERENCES.filter(k => !keys.includes(k))];
};
const repoUsage = state => {
  if (state.summary?.pledgeUsedByMarket)
    return { pledge:state.summary.pledgeUsedByMarket };
  const used = { INTERBANK:0,SSE:0,SZSE:0 };
  for (const instruction of Object.values(state.execution?.instructions ?? {})) {
    const plan = state.plans.find(p => p.planId === instruction.planId);
    const market = plan?.repoTerms?.market;
    if (!isFinancing(plan?.businessType) || !Object.hasOwn(used,market) || instruction.status === 'rejected') continue;
    const committed = sub(instruction.nominalYuan, instruction.cancelledYuan ?? 0);
    used[market] = add(used[market],committed);
  }
  return {pledge:used};
};
export function rankComparableCandidates({priority = [], candidates, comparisonGroupId, executionClass}) {
  const keys = selectedPreferences({preferences:{orderedKeys:priority}});
  const eligible = candidates.filter(c => c.hardPass && c.completeTarget && c.inputsComplete &&
    c.comparisonGroupId === comparisonGroupId && c.executionClass === executionClass);
  const converted = eligible.map(c => ({ candidateId:c.candidateId,status:'waiting_conditions',fullCoverage:true,
    peakShortfallYuan:c.peakFundingYuan,warningCount:c.warningsNew,
    repoPositions:c.repoPositions ?? (c.reverseRepoFirstIndex == null ? null :
      c.reverseRepoFirstIndex < 0 ? [] : [c.reverseRepoFirstIndex]) }));
  converted.sort((a,b) => compare(a,b,keys));
  return { eligibleIds:eligible.map(c=>c.candidateId).sort(),rankedIds:converted.map(c=>c.candidateId),
    excludedPreferenceKeys:['metric_headroom'] };
}
function base(state) {
  if (!Array.isArray(state?.plans)) throw new Error('计划列表无效');
  const today = state.context?.businessDate ?? null;
  if (today !== null && !validDate(today)) throw new Error('业务日期无效');
  const map = new Map();
  for (const plan of state.plans) {
    if (!plan?.planId || map.has(plan.planId) || BUSINESS_DIRECTIONS[plan.businessType] !== plan.direction) throw new Error('计划类型或ID无效');
    nonnegative(plan.targetYuan, '计划意向金额'); map.set(plan.planId, plan);
  }
  const b = balances(state);
  for (const row of b) {
    if (!map.has(row.planId)) throw new Error('计划余额引用不存在');
    for (const key of ['targetYuan','filledYuan','lockedYuan','arrangeableYuan','remainingYuan']) nonnegative(row[key], key);
    if (add(add(row.filledYuan, row.lockedYuan), row.arrangeableYuan) !== row.targetYuan ||
      add(row.lockedYuan, row.arrangeableYuan) !== row.remainingYuan) throw new Error('计划名义金额不守恒');
  }
  const cash = available(state);
  if (cash !== null) safe(cash, '当前可用资金');
  const futureCashDeltas = today === null ? new Map() : cashDates(state,today);
  for (const plan of state.plans) {
    if (plan.tradeDate != null && !validDate(plan.tradeDate)) throw new Error('交易日期无效');
    if (plan.settlementDate != null && !validDate(plan.settlementDate)) throw new Error('交收日期无效');
    if (plan.tradeDate && plan.settlementDate && plan.settlementDate < plan.tradeDate)
      throw new Error('交收日期早于交易日期');
    if (singleDay(state) && plan.settlementDate !== today)
      throw new Error('简化模板新增交易只允许当日交收');
  }
  const input = state.inputs ?? {};
  for (const key of ['navYuan','bankExposureYuan','feeYuan','bufferYuan']) nonnegative(input[key] ?? null, key);
  const initialConcentration = evaluateCurrentConcentration(state,
    {businessType:'deposit',issuerId:'BANK-A'},0);
  return { map, balances: b, cash, today, futureCashDeltas, initialConcentration, singleDay: singleDay(state),
    input, orderedKeys: selectedPreferences(state),
    repoResources:state.repoResources ?? {}, repoUsed:repoUsage(state), marketClock:state.marketClock ?? null,
    depositThreshold: state.ruleConfig?.depositThreshold ?? '0.08', observationThreshold: state.ruleConfig?.observationThreshold ?? '0.082' };
}
function permutations(items, limit, visit, onNode = () => {}) {
  let nodes = 0, truncated = false;
  const recur = (prefix, rest) => {
    if (truncated) return;
    nodes++;
    onNode(Math.min(nodes, limit));
    if (nodes > limit) { truncated = true; return; }
    if (!rest.length) { visit(prefix); return; }
    for (let i = 0; i < rest.length; i++) recur([...prefix, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
  };
  recur([], items);
  return { nodes: Math.min(nodes, limit), truncated };
}
function searchOrder(actions, keys) {
  const repoFirst = keys.includes('reverse_repo_first');
  const repoLast = keys.includes('liquidity_last');
  return [...actions].sort((a,b) => (a.plan.direction === 'inflow' ? 0 : 1) -
    (b.plan.direction === 'inflow' ? 0 : 1) ||
    (repoFirst || repoLast ? (repoFirst ? -1 : 1) *
      (Number(REVERSE_REPO_TYPES.has(a.plan.businessType)) -
       Number(REVERSE_REPO_TYPES.has(b.plan.businessType))) : 0) ||
    a.amount - b.amount || a.plan.planId.localeCompare(b.plan.planId));
}
function boundedSearch(state,facts,actions,nodeLimit,candidateLimit,visit,onNode = () => {}) {
  const ordered = searchOrder(actions,facts.orderedKeys);
  let nodes = 0, explored = 0, pruned = 0, stopReason = null;
  const recur = (prefix,rest) => {
    if (stopReason) return;
    if (nodes >= nodeLimit) { stopReason = 'node_budget'; return; }
    nodes++;
    onNode(nodes);
    if (prefix.length) {
      const id = `AUTO-${prefix.map(a => a.plan.planId).join('>')}`;
      const candidate = evaluate(state,facts,prefix,id);
      if (candidate.status === 'blocked_sequence') { pruned++; return; }
      if (!rest.length) {
        visit(candidate); explored++;
        if (explored >= candidateLimit) stopReason = 'candidate_budget';
        return;
      }
    }
    for (let i = 0; i < rest.length && !stopReason; i++)
      recur([...prefix,rest[i]],[...rest.slice(0,i),...rest.slice(i+1)]);
  };
  recur([],ordered);
  return {nodes,explored,pruned,truncated:!!stopReason,complete:!stopReason,
    boundary:stopReason,actionCount:actions.length};
}
function namedOrder(pathId, actions) {
  const byId = new Map(actions.map(a => [a.plan.planId, a]));
  const ids = pathId === 'A' ? ['P-SELL','P-DEP','P-CD','P-BOND','P-REPO'] :
    pathId === 'B' ? ['P-SELL','P-CD','P-DEP','P-BOND','P-REPO'] :
    pathId === 'C' ? ['P-DEP','P-CD','P-BOND','P-REPO','P-SELL'] : null;
  if (!ids) return null;
  const ordered = [...ids.flatMap(id => byId.has(id) ? [byId.get(id)] : []),
    ...actions.filter(a => !ids.includes(a.plan.planId))];
  return ordered.map((a,index) => ({...a,sequenceIndex:index + 1}));
}
function evaluate(state, facts, actions, id, split = null) {
  const trace = [], steps = [], conflicts = [], warningKeys = new Set();
  const initialConcentration = facts.initialConcentration;
  let projectedCash = facts.cash, exposure = initialConcentration.currentExposureYuan;
  let firmCash = facts.cash;
  let peak = projectedCash === null || facts.input.bufferYuan === null ? null : Math.max(0, sub(facts.input.bufferYuan, projectedCash));
  let priorStepId = null, conditional = false, missing = false, blocked = false;
  const projectedInflowSources = [], projectedRepoUsed = { INTERBANK:0,SSE:0,SZSE:0 };
  const projectedActions = [];
  const useCore = coreRulesEnabled(state);
  const futureActionDeltas = new Map();
  const basePieces = split ? [{ plan: actions[0].plan, amount: split }, { plan: actions[0].plan, amount: sub(actions[0].amount, split) }, ...actions.slice(1).map(a => ({ plan:a.plan, amount:a.amount, sequenceIndex:a.sequenceIndex }))] :
    actions.map(a => ({ plan:a.plan, amount:a.amount, sequenceIndex:a.sequenceIndex }));
  const pieces = basePieces.flatMap(piece => isExchangeRepo(piece.plan.businessType) && piece.amount > EXCHANGE_REPO_MAX_ORDER_YUAN ?
    [{...piece,amount:EXCHANGE_REPO_MAX_ORDER_YUAN},{...piece,amount:sub(piece.amount,EXCHANGE_REPO_MAX_ORDER_YUAN)}] : [piece]);
  const hasA = pieces.some(({ plan }) => exposureDelta(plan,state.initialData));
  if (!useCore && hasA && (exposure === null || facts.input.navYuan === null || facts.input.navYuan === 0)) missing = true;
  if (facts.cash === null || facts.input.feeYuan === null || facts.input.bufferYuan === null) missing = true;
  let feeApplied = false;
  for (let i = 0; i < pieces.length; i++) {
    const { plan, amount, sequenceIndex } = pieces[i];
    const valueDate = facts.today === null ? null : settlementDateFor(plan,facts.today);
    const checkTodayHorizon = valueDate === null && plan.direction === 'outflow' && facts.today !== null &&
      (facts.futureCashDeltas.size > 0 || futureActionDeltas.size > 0);
    const settlementCheckDate = valueDate ?? (checkTodayHorizon ? facts.today : null);
    const planBalance = facts.balances.find(b => b.planId === plan.planId);
    const resumedS10 = id === '3+7' && !split && (planBalance?.filledYuan > 0 || planBalance?.lockedYuan > 0);
    const stepId = id === '3+7' ? (resumedS10 || i > 0 ? 'I-B' : 'I-A') : `${id}-${sequenceIndex ?? i + 1}`;
    const before = projectedCash, preExposure = exposure, firmBefore = firmCash;
    const futureBefore = settlementCheckDate === null ? null : futureFloor(projectedCash,settlementCheckDate,
      facts.futureCashDeltas,futureActionDeltas);
    const conditions = [];
    if (id === '3+7' && priorStepId) conditions.push({ kind: 'previous_confirmed', stepId: priorStepId });
    if (id === '3+7' && (i === 1 || resumedS10)) {
      conditions.push({ kind: 'filled', planId: plan.planId, minimumYuan: split ?? 300000000 });
      conditions.push({ kind: 'payable_cleared', planId: plan.planId });
      conditions.push({ kind: 'cash_available', minimumYuan: amount, planId: plan.planId });
    }
    if (isSecuritySale(plan.businessType)) conditions.push({kind:'holding_confirmed',planId:plan.planId,minimumYuan:amount});
    if (plan.direction === 'outflow' && firmCash !== null && facts.input.bufferYuan !== null &&
      firmCash < amount + facts.input.bufferYuan + (feeApplied ? 0 : (facts.input.feeYuan ?? 0))) {
      let needed = amount + facts.input.bufferYuan + (feeApplied ? 0 : (facts.input.feeYuan ?? 0)) - firmCash;
      for (const source of projectedInflowSources) {
        if (needed <= 0) break;
        const additional = Math.min(source.amount,needed);
        const sourcePlan = facts.map.get(source.planId);
        const fillBasis = facts.singleDay && sourcePlan &&
          (isFinancing(sourcePlan.businessType) || isSecuritySale(sourcePlan.businessType));
        const included = fillBasis ? facts.balances.find(b => b.planId === source.planId)?.filledYuan ?? 0 :
          Object.values(state.execution?.cashFlows ?? {}).filter(f => f.type === 'cash_available' &&
            state.execution?.instructions?.[f.instructionId]?.planId === source.planId)
            .reduce((n,f) => add(n,f.amountYuan),0);
        conditions.push({kind:'funds_available',planId:source.planId,
          ...(fillBasis ? {basis:'fill'} : {}),minimumYuan:add(included,additional)});
        needed -= additional;
      }
      if (['A','B'].includes(id) && sequenceIndex > 1 &&
        facts.balances.find(b => b.planId === 'P-SELL')?.arrangeableYuan === 0 &&
        !projectedInflowSources.some(x => x.planId === 'P-SELL')) {
        const source = facts.map.get('P-SELL');
        if (source) conditions.push({kind:'funds_available',planId:'P-SELL',minimumYuan:source.targetYuan});
      }
    }
    const repoChecks = [];
    let settlementResult = 'not_applicable';
    let settlementRequiredYuan = null, settlementFeeYuan = null;
    if (isFinancing(plan.businessType) || isExchangeRepo(plan.businessType)) {
      const market = plan.repoTerms?.market;
      const validMarket = isExchangeRepo(plan.businessType) ? ['SSE','SZSE'].includes(market) : market === 'INTERBANK';
      if (!validMarket || !Number.isSafeInteger(plan.repoTerms?.tenorDays) || plan.repoTerms.tenorDays <= 0 ||
        (!facts.singleDay && plan.repoTerms.tenorDays > 3660) ||
        (!facts.singleDay && isExchangeRepo(plan.businessType) && !EXCHANGE_REPO_TENORS.includes(plan.repoTerms.tenorDays))) {
        missing = true; repoChecks.push({ruleId:'DEMO-REPO-TERMS',name:'回购交易参数',result:'missing',
          reason:`${plan.label}的交易场所或期限缺失、与业务类型不符；当前市场${market ?? '未知'}，期限${plan.repoTerms?.tenorDays ?? '未知'}天，须核对业务类型及允许期限。`,
          market:market ?? null,tenorDays:plan.repoTerms?.tenorDays ?? null});
        conflicts.push(`${plan.label}的交易场所或期限缺失、与业务类型不符，交易参数待核。`);
      } else {
        if (isFinancing(plan.businessType)) {
          const resources = facts.repoResources[market];
          for (const [resource,field,kind] of (!facts.singleDay ?
            [['pledge','pledgeConfirmedYuan','pledge_confirmed']] : [])) {
            const confirmed = resources?.[field] ?? null;
            const priorUsed = facts.repoUsed[resource]?.[market] ?? 0;
            const planned = projectedRepoUsed[market];
            conditions.push({kind,market,minimumYuan:amount});
            const remaining = confirmed === null || !Number.isSafeInteger(confirmed) ? null :
              sub(sub(confirmed,priorUsed),planned);
            const resourceName = resource === 'pledge' ? '已确认质押能力' : '已确认回购资源';
            if (confirmed === null) { missing = true; repoChecks.push({ruleId:`DEMO-REPO-${resource.toUpperCase()}`,
              name:resourceName,result:'missing',reason:`${market}${resourceName}未知；本笔需${amount}元，现有占用${priorUsed}元、此前拟安排${planned}元。`,
              market,requiredYuan:amount,confirmedYuan:null,usedYuan:priorUsed,plannedYuan:planned,availableYuan:null}); }
            else if (!Number.isSafeInteger(confirmed) || confirmed < 0 ||
              sub(sub(confirmed,priorUsed),planned) < amount) {
              conditional = true; repoChecks.push({ruleId:`DEMO-REPO-${resource.toUpperCase()}`,
                name:resourceName,result:'waiting_conditions',
                reason:`${market}${resourceName}需${amount}元，当前确认${confirmed}元，现有占用${priorUsed}元、此前拟安排${planned}元，剩余${remaining === null ? '待核' : `${remaining}元`}；须补足并复核。`,
                market,requiredYuan:amount,confirmedYuan:confirmed,usedYuan:priorUsed,plannedYuan:planned,
                availableYuan:remaining});
            } else repoChecks.push({ruleId:`DEMO-REPO-${resource.toUpperCase()}`,result:'pass'});
          }
          projectedRepoUsed[market] = add(projectedRepoUsed[market],amount);
        }
        if (isExchangeRepo(plan.businessType) && !facts.singleDay) {
          conditions.push({kind:'exchange_window_open',market});
          const window = windowStatus(facts.marketClock,{mode:'send'});
          repoChecks.push({ruleId:'DEMO-EXCHANGE-WINDOW',result:window.result,
            ...(window.result === 'missing' || window.result === 'closed' ? {
              name:'交易所回购新申报窗口',market,
              reason:window.result === 'missing' ?
                `${market}新申报窗口无法核对：${window.reason}；当前时间${facts.marketClock?.time ?? '未知'}、时区${facts.marketClock?.timezone ?? '未知'}。` :
                `${market}当前${facts.marketClock?.time ?? '未知时间'}不在本业务日新申报窗口；交易日状态${facts.marketClock?.isTradingDay === false ? '非交易日' : '交易日'}，须待窗口开放并复核。`,
              currentTime:facts.marketClock?.time ?? null,isTradingDay:facts.marketClock?.isTradingDay ?? null,
              timezone:facts.marketClock?.timezone ?? null,
            } : {})});
          if (window.result === 'missing') missing = true;
          else if (window.result === 'closed') {
            if (facts.marketClock?.isTradingDay === false || facts.marketClock?.time >= '15:30:00') {
              blocked = true;
              conflicts.push('当前业务日的交易所回购新申报窗口已结束；意向金额保留，不自动顺延至下一交易日。');
            } else {
              conditional = true;
              conflicts.push('交易所回购目前不在新申报时段，须待本业务日窗口开放并手动复核。');
            }
          }
        }
      }
      if (!facts.singleDay && (plan.repoTerms?.annualRate === null || plan.repoTerms?.annualRate === undefined))
        conflicts.push(isFinancing(plan.businessType) ?
          `${plan.label}的利息与到期应付尚未测算；本金到账仅计入当前测算。` :
          `${plan.label}的利息与到期回款尚未测算；本金流出按当前现金约束。`);
    }
    const concentration = plannedConcentration(plan,exposure,facts.input.navYuan,amount,
      facts.depositThreshold,facts.observationThreshold,state.initialData);
    const hard = useCore ? 'not_applicable' : concentration.depositResult;
    let postExposure = concentration.actualPostExposureYuan;
    const warning = useCore ? 'not_applicable' : concentration.warningResult;
    const legacyExposureRule = result => ({ruleId:'DEMO-EXP-01',result,
      crossProductDelta:concentration.crossProductDelta,
      ...(['block','missing'].includes(result) ? {
        name:'A银行存款投前敞口',currentYuan:preExposure,navYuan:facts.input.navYuan ?? null,
        threshold:facts.depositThreshold,
        reason:result === 'block' ?
          `新增A银行存款前敞口${preExposure}元、NAV ${facts.input.navYuan}元，严格超过配置阈值${facts.depositThreshold}；本笔${amount}元不能下达。` :
          `A银行存款投前敞口${preExposure === null ? '未知' : `${preExposure}元`}、NAV ${facts.input.navYuan == null ? '未知' : `${facts.input.navYuan}元`}，无法核对阈值${facts.depositThreshold}；须核对银行身份、敞口及NAV。`,
      } : {})});
    const legacyWarningRule = result => ({ruleId:'DEMO-WARN-01',result,
      ...(result === 'missing' ? {name:'A银行敞口观察线',currentYuan:concentration.actualPostExposureYuan,
        navYuan:facts.input.navYuan ?? null,threshold:facts.observationThreshold,
        reason:`交易后A银行敞口或NAV未知，无法核对观察阈值${facts.observationThreshold}。`} : {})});
    if (!useCore && isSecuritySale(plan.businessType) && isBankA(plan,state.initialData) &&
      !state.initialData?.holdings?.some(h => h.securityId === plan.securityId)) {
      // The demonstration has no authoritative mapping for releasing an A-bank
      // holding from the exposure numerator. Do not infer a decrement.
      postExposure = null;
      missing = true;
      if (!conflicts.includes('A银行卖券的敞口释放映射未定义，后续相关规则需要权威数据。'))
        conflicts.push('A银行卖券的敞口释放映射未定义，后续相关规则需要权威数据。');
    }
    if (hard === 'missing' || warning === 'missing') missing = true;
    const core = useCore ? evaluateCoreRules(state,{plan,amountYuan:amount,projectedActions,cashYuan:before}) : null;
    for (const row of core?.rows ?? []) if (row.result === 'warn') {
      warningKeys.add(`${row.ruleId}:${row.subjectId ?? 'PORTFOLIO'}`);
      const explanation = `${row.ruleId}：${row.reason}`;
      if (!conflicts.includes(explanation)) conflicts.push(explanation);
    }
    const precedentNeedsFill = a => isSecuritySale(a.plan.businessType) || isFinancing(a.plan.businessType);
    if (core && projectedActions.some(precedentNeedsFill)) {
      const withoutUnfilledPrecedents = evaluateCoreRules(state,{plan,amountYuan:amount,
        projectedActions:projectedActions.filter(a => !precedentNeedsFill(a)),cashYuan:firmCash});
      if (!core.blocking.length && !core.missing.length &&
        (withoutUnfilledPrecedents.blocking.length || withoutUnfilledPrecedents.missing.length)) {
        const precedentsByPlan = new Map();
        for (const prior of projectedActions.filter(precedentNeedsFill))
          precedentsByPlan.set(prior.plan.planId,add(precedentsByPlan.get(prior.plan.planId) ?? 0,prior.amountYuan));
        for (const [planId,additionalYuan] of precedentsByPlan) {
          const baseline = facts.balances.find(x => x.planId === planId)?.filledYuan ?? 0;
          conditions.push({kind:'filled',planId,minimumYuan:add(baseline,additionalYuan)});
        }
      }
    }
    if (core?.missing?.length) missing = true;
    if (core?.blocking?.length) {
      blocked = true;
      for (const row of core.blocking) conflicts.push(`${plan.label}：${row.name ?? row.ruleId} ${row.reason ?? '超过约束'}。`);
      steps.push({stepId,planId:plan.planId,nominalYuan:amount,label:`${plan.label} ${amount}元被阻断`,
        condition:conditionText(conditions),machineConditions:conditions,blocked:true});
      trace.push({stepId,planId:plan.planId,nominalYuan:amount,beforeCashYuan:before,
        afterCashYuan:before,beforeExposureYuan:preExposure,afterExposureYuan:preExposure,
        rules:core.rows,machineConditions:conditions});
      break;
    }
    if (hard === 'block') {
      blocked = true;
      const label = `${plan.label} ${amount}元被阻断`;
      conflicts.push('DEMO-EXP-01：新增A银行存款交易前敞口严格超过当前配置阈值。');
      steps.push({ stepId, planId: plan.planId, nominalYuan: amount, label, condition: conditionText(conditions), machineConditions: conditions, blocked: true });
      trace.push({ stepId, planId: plan.planId, nominalYuan: amount, beforeCashYuan: before,
        afterCashYuan: before, beforeExposureYuan: preExposure, afterExposureYuan: preExposure,
        navYuan: facts.input.navYuan, beforeRatio: asPercent(preExposure, facts.input.navYuan),
        afterRatio: asPercent(preExposure, facts.input.navYuan),
        rules: [legacyExposureRule('block'),legacyWarningRule('not_applicable')], machineConditions: conditions });
      break;
    }
    if (warning === 'warn') warningKeys.add(`DEMO-WARN-01:BANK-A:${state.ruleConfig?.version ?? 1}:warn`);
    if (plan.direction === 'inflow') {
      // A future security sale remains an unconfirmed receivable. It cannot
      // finance today's orders or create firm future settlement capacity.
      if (valueDate === null) {
        const existing = projectedInflowSources.find(x => x.planId === plan.planId);
        if (existing) existing.amount = add(existing.amount,amount);
        else projectedInflowSources.push({planId:plan.planId,amount});
        if (projectedCash !== null) projectedCash = add(projectedCash, amount);
      }
      conditional = true;
    } else {
      const feeThisStep = !feeApplied && facts.input.feeYuan !== null ? facts.input.feeYuan : 0;
      if (valueDate !== null) {
        const feeAndAmount = add(amount,feeThisStep);
        const required = facts.input.bufferYuan === null ? null : add(feeAndAmount,facts.input.bufferYuan);
        settlementRequiredYuan = required; settlementFeeYuan = feeThisStep;
        conditions.push({kind:'settlement_capacity',valueDate,minimumYuan:required ?? feeAndAmount,
          planId:plan.planId});
        if (futureBefore === null || required === null) { missing = true; settlementResult = 'missing'; }
        else if (futureBefore < required) {
          blocked = true;
          settlementResult = 'block';
          conflicts.push(`${plan.label}在${valueDate}及后续交收日的已确认业务头寸不足，不能按${amount}元下达；未来卖出计划尚未成交的回款不计入可用头寸。`);
        } else settlementResult = 'pass';
        futureActionDeltas.set(valueDate,sub(futureActionDeltas.get(valueDate) ?? 0,feeAndAmount));
        if (!feeApplied && facts.input.feeYuan !== null) feeApplied = true;
        conditional = true;
      } else if (checkTodayHorizon) {
        const feeAndAmount = add(amount,feeThisStep);
        const required = facts.input.bufferYuan === null ? null : add(feeAndAmount,facts.input.bufferYuan);
        settlementRequiredYuan = required; settlementFeeYuan = feeThisStep;
        conditions.push({kind:'settlement_capacity',valueDate:facts.today,
          minimumYuan:required ?? feeAndAmount,planId:plan.planId});
        if (futureBefore === null || required === null) { missing = true; settlementResult = 'missing'; }
        else if (futureBefore < required) {
          blocked = true; settlementResult = 'block';
          conflicts.push(`${plan.label}下达后会侵占已确认的后续交收资金，不能按${amount}元下达。`);
        } else settlementResult = 'pass';
        if (projectedCash !== null && facts.input.feeYuan !== null) {
          projectedCash = sub(projectedCash,feeAndAmount);
          if (!feeApplied) feeApplied = true;
        } else projectedCash = null;
      } else if (projectedCash !== null && facts.input.feeYuan !== null) {
        projectedCash = sub(projectedCash, amount);
        if (!feeApplied) { projectedCash = sub(projectedCash, feeThisStep); feeApplied = true; }
      } else projectedCash = null;
      if (valueDate === null && firmCash !== null && facts.input.feeYuan !== null)
        firmCash = sub(firmCash,add(amount,feeThisStep));
      if (valueDate === null && projectedCash !== null && facts.input.bufferYuan !== null && projectedCash < facts.input.bufferYuan) {
        const required = sub(facts.input.bufferYuan, projectedCash);
        if (!conditions.some(c => c.kind === 'cash_available')) conditions.push({ kind: 'cash_available',
          minimumYuan:add(amount, add(facts.input.bufferYuan, feeThisStep)),
          additionalYuan:required, planId:plan.planId });
        conditional = true;
      }
    }
    if (conditions.length) conditional = true;
    if (peak !== null && projectedCash !== null) peak = Math.max(peak, sub(facts.input.bufferYuan, projectedCash));
    else peak = null;
    const label = `${plan.label} ${amount}元`;
    steps.push({ stepId, planId: plan.planId, nominalYuan: amount, label,
      condition: conditionText(conditions), machineConditions: conditions, blocked });
    trace.push({ stepId, planId: plan.planId, nominalYuan: amount, beforeCashYuan: before,
      afterCashYuan: projectedCash, valueDate:settlementCheckDate, futureAvailableBeforeYuan:futureBefore,
      futureAvailableAfterYuan:settlementCheckDate === null ? null : futureFloor(projectedCash,settlementCheckDate,
        facts.futureCashDeltas,futureActionDeltas), beforeExposureYuan: preExposure, afterExposureYuan: postExposure,
      navYuan: facts.input.navYuan, beforeRatio: asPercent(preExposure, facts.input.navYuan),
      afterRatio: asPercent(postExposure, facts.input.navYuan),
      rules: [...(core?.rows ?? [legacyExposureRule(hard),legacyWarningRule(warning)]),...repoChecks,
        { ruleId:'DEMO-SETTLEMENT-01', result:settlementResult, valueDate:settlementCheckDate,
          ...(['block','missing'].includes(settlementResult) ? (() => {
            return {name:'交收日已确认业务头寸',currentYuan:futureBefore,requiredYuan:settlementRequiredYuan,
              reason:settlementResult === 'missing' ?
                `${settlementCheckDate}及后续交收日的已确认业务头寸或现金缓冲未知；本笔${amount}元、费用${settlementFeeYuan}元，最低需求${settlementRequiredYuan === null ? '待核' : `${settlementRequiredYuan}元`}，须核对未来确认收付。` :
                `${settlementCheckDate}及后续交收日确认头寸最低${futureBefore}元，低于本笔${amount}元、费用${settlementFeeYuan}元和缓冲${facts.input.bufferYuan}元合计${settlementRequiredYuan}元；缺口${sub(settlementRequiredYuan,futureBefore)}元。`};
          })() : {}) },
        { ruleId:'DEMO-CASH-01', result: projectedCash === null ? 'missing' : conditions.some(c => c.kind === 'cash_available') ? 'waiting_conditions' : 'pass',
          ...(projectedCash === null ? {name:'实际可用现金',currentYuan:before,
            requiredYuan:null,reason:`本步预计可用现金未知；步前现金${before === null ? '未知' : `${before}元`}、费用${facts.input.feeYuan === null ? '未知' : `${facts.input.feeYuan}元`}，无法确认本笔${amount}元的付款条件。`} :
            conditions.some(c => c.kind === 'cash_available') ? (() => {
              const cashCondition = conditions.find(c => c.kind === 'cash_available');
              const shortfallYuan = firmBefore === null ? null :
                Math.max(0,sub(cashCondition.minimumYuan,firmBefore));
              return {name:'实际可用现金',currentYuan:firmBefore,requiredYuan:cashCondition.minimumYuan,
                shortfallYuan,
                reason:`本笔${amount}元付款前须确认实际可用现金至少${cashCondition.minimumYuan}元；当前已确认口径${firmBefore === null ? '未知' : `${firmBefore}元`}，差额${shortfallYuan === null ? '待核' : `${shortfallYuan}元`}，须满足关联成交、结清及到账条件后复核。`};
            })() : {}) }],
      machineConditions: conditions });
    exposure = postExposure;
    projectedActions.push({plan,amountYuan:amount});
    priorStepId = stepId;
    if (blocked) break;
  }
  if (warningKeys.size && !useCore) conflicts.push('DEMO-WARN-01：预计A银行交易后敞口达到或超过当前观察阈值。');
  if (peak > 0) conflicts.push(`预计新增流动性峰值${peak}元，须由未来已确认cash_available落实。`);
  const fullCoverage = !blocked && steps.length === pieces.length;
  const status = blocked ? 'blocked_sequence' : missing ? 'insufficient_data' : conditional ? 'waiting_conditions' : 'feasible';
  return { candidateId:id, status, peakShortfallYuan: blocked || missing ? null : peak,
    warningCount: missing ? null : warningKeys.size, steps, trace, conflicts, fullCoverage,
    repoPositions:steps.flatMap((step,index) => REVERSE_REPO_TYPES.has(facts.map.get(step.planId)?.businessType) ? [index] : []),
    projectionStartYuan:facts.cash, futureActionDeltas:Object.fromEntries(futureActionDeltas),
    executionClass: conditional ? 'conditional' : 'current_confirmed',
    excludedPreferenceKeys:['metric_headroom'], projectedFinalCashYuan: blocked ? null : projectedCash };
}
// Reuse the production projection for a manager-selected prefix. The caller
// supplies only selected amounts; no alternative order or amount is searched.
export function evaluateSelectedSequence(state, items) {
  if (!Array.isArray(items) || !items.length) throw new Error('所选顺序不能为空');
  const facts = base(state);
  const actions = items.map((item, index) => {
    const plan = facts.map.get(item.planId);
    if (!plan || !Number.isSafeInteger(item.nominalYuan) || item.nominalYuan <= 0)
      throw new Error('所选步骤或金额无效');
    return { plan, amount:item.nominalYuan, sequenceIndex:index + 1 };
  });
  return evaluate(state,facts,actions,'CUSTOM');
}
// For a same-day purchase from a compliant prefix, each C01-C09 threshold and
// the bank-specific C05-DEPOSIT transaction gate is
// an affine inequality in the added nominal amount (C09 has a positive affine
// denominator). Their intersection with cash, buffer and unit limits is an
// initial interval. This excludes sales, financing and initially breached or
// unknown baselines, where that monotonic argument does not hold.
function largestCurrentOutflowSlice(state, facts, prefix, action, budget) {
  if (!facts.singleDay || !coreRulesEnabled(state) ||
      !PARTIAL_OUTFLOW_TYPES.has(action.plan.businessType) || action.plan.direction !== 'outflow' ||
      settlementDateFor(action.plan,facts.today) !== null ||
      [facts.cash,facts.input.feeYuan,facts.input.bufferYuan].some(x => x === null) ||
      (isExchangeRepo(action.plan.businessType) && action.amount > EXCHANGE_REPO_MAX_ORDER_YUAN)) return null;
  const unit = unitFor(action.plan.businessType);
  if (!Number.isSafeInteger(unit) || unit <= 0 || action.amount % unit !== 0 || action.amount <= unit) return null;
  const prefixResult = prefix.length ? evaluate(state,facts,prefix,'AUTO-SUBSET-PREFIX') : null;
  if (prefixResult && (!prefixResult.fullCoverage ||
      !['feasible','waiting_conditions'].includes(prefixResult.status))) return null;
  const projectedActions = prefix.map(a => ({plan:a.plan,amountYuan:a.amount}));
  const baseline = evaluateCoreRules(state,{projectedActions,
    cashYuan:prefixResult ? prefixResult.projectedFinalCashYuan : facts.cash});
  if (baseline.blocking.length || baseline.missing.length) return null;
  const valid = amount => {
    if (budget.used >= MAX_PARTIAL_EVALUATIONS) return false;
    budget.used++;
    const candidate = evaluate(state,facts,[...prefix,{...action,amount}],'AUTO-SUBSET-SLICE');
    return candidate.fullCoverage && ['feasible','waiting_conditions'].includes(candidate.status) &&
      candidate.projectedFinalCashYuan !== null &&
      candidate.projectedFinalCashYuan >= facts.input.bufferYuan &&
      candidate.trace.every(step => !step.rules?.some(r => ['block','missing','closed'].includes(r.result)));
  };
  // Unit one must pass before using the downward-closed interval. A known
  // failed first unit is not turned into a false zero-valued transaction.
  if (!valid(unit)) return null;
  let low = 1, high = action.amount / unit;
  while (low < high && budget.used < MAX_PARTIAL_EVALUATIONS) {
    const mid = low + Math.ceil((high-low)/2);
    if (valid(mid*unit)) low = mid;
    else high = mid-1;
  }
  if (low >= action.amount / unit || budget.used >= MAX_PARTIAL_EVALUATIONS) return null;
  // Never promote a searched amount without a final complete-rule check.
  return valid(low*unit) ? {...action,amount:low*unit} : null;
}
function preferenceComparison(a,b,key) {
  if (key === 'reverse_repo_first' || key === 'liquidity_last') {
    if (!Array.isArray(a.repoPositions) || !Array.isArray(b.repoPositions)) return 0;
    const direction = key === 'reverse_repo_first' ? 1 : -1;
    for (let i=0; i<Math.max(a.repoPositions.length,b.repoPositions.length); i++) {
      const av = a.repoPositions[i] ?? Number.POSITIVE_INFINITY;
      const bv = b.repoPositions[i] ?? Number.POSITIVE_INFINITY;
      if (av !== bv) return direction * (av - bv);
    }
    return 0;
  }
  const av = key === 'settlement_safety' ? a.peakShortfallYuan ?? null : key === 'fewer_warnings' ? a.warningCount ?? null : null;
  const bv = key === 'settlement_safety' ? b.peakShortfallYuan ?? null : key === 'fewer_warnings' ? b.warningCount ?? null : null;
  return av !== null && bv !== null && av !== bv ? av - bv : 0;
}
function compare(a, b, keys) {
  const rank = x => x.status === 'feasible' ? 0 : x.status === 'waiting_conditions' ? 1 : x.status === 'insufficient_data' ? 2 : 3;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.fullCoverage !== b.fullCoverage) return Number(!a.fullCoverage) - Number(!b.fullCoverage);
  for (const key of keys) {
    const order = preferenceComparison(a,b,key);
    if (order) return order;
  }
  return a.candidateId.localeCompare(b.candidateId);
}
const firstDifference = (chosen, other, keys) => {
  if (!chosen || chosen.status !== other.status) return 'status';
  if (chosen.fullCoverage !== other.fullCoverage) return 'fullCoverage';
  for (const key of keys) {
    if (preferenceComparison(chosen,other,key)) return key;
  }
  return 'candidateId';
};
const detail = (c, chosen, keys, groupId) => ({ candidateId:c.candidateId, status:c.status, peakShortfallYuan:c.peakShortfallYuan,
  warningCount:c.warningCount, fullCoverage:c.fullCoverage, executionClass:c.executionClass,
  comparisonGroupId:groupId, preferenceValues:{settlement_safety:c.peakShortfallYuan,
    fewer_warnings:c.warningCount, metric_headroom:null,
    reverse_repo_first:c.repoPositions[0] ?? null,
    liquidity_last:c.repoPositions[0] ?? null}, firstDifferenceKey:firstDifference(chosen,c,keys),
  excludedPreferenceKeys:c.excludedPreferenceKeys });
function collectDiagnostics(state, facts, actions, boundary, search, winner, unitMismatch, orderLimitIssues) {
  const diagnostics = [];
  const push = (code,severity,planId,message,action) => {
    if (!diagnostics.some(x => x.code === code && x.planId === planId))
      diagnostics.push({code,severity,planId,message,action});
  };
  if (facts.cash === null) push('cash-missing','missing',null,'当前业务可用头寸未知；请核对起点及已确认收付。','auto');
  if (facts.input.feeYuan === null) push('fee-missing','missing',null,'交易费用未知，现金需求无法完整测算。','auto');
  if (facts.input.bufferYuan === null) push('buffer-missing','missing',null,'现金缓冲未知，最低资金需求无法测算。','auto');
  for (const issue of unitMismatch) push('unit-mismatch','block',issue.planId,
    `剩余金额有${issue.unmatchedYuan}元尾差，无法按该业务的交易单位完整安排。`,'edit-plan');
  for (const issue of orderLimitIssues) push('per-order-limit','block',issue.planId,
    `剩余${issue.amountYuan}元超过当前每计划两笔、每笔${issue.maxPerOrderYuan}元的分次范围。`,'edit-plan');
  for (const {plan,amount} of actions) {
    if (requiresBankIdentity(plan,state.initialData)) push('bank-identity-missing','missing',plan.planId,
      `${plan.label}缺${plan.businessType === 'cd_buy' ? '发行银行' : '存款银行'}身份；交易对手不能代替存单发行人。`,'edit-plan');
    if (!coreRulesEnabled(state) && exposureDelta(plan,state.initialData)) {
      const rule = evaluateCurrentConcentration(state,plan,amount);
      if (rule.needed.length) push('concentration-input-missing','missing',plan.planId,
        `${plan.label}需补${rule.needed.join('、')}，才能核对A银行敞口。`,
        rule.unknownCommittedPlanIds.length ? 'edit-plan' : 'auto');
    }
    if (isSecuritySale(plan.businessType) && isBankA(plan,state.initialData) &&
      !state.initialData?.holdings?.some(h => h.securityId === plan.securityId))
      push('sale-release-unknown','missing',plan.planId,
        `${plan.label}的卖券敞口释放映射未知，后续A银行敞口不得假定减少。`,'auto');
    if (isFinancing(plan.businessType) || isExchangeRepo(plan.businessType)) {
      const market = plan.repoTerms?.market;
      const validMarket = isExchangeRepo(plan.businessType) ? ['SSE','SZSE'].includes(market) : market === 'INTERBANK';
      if (!validMarket || !Number.isSafeInteger(plan.repoTerms?.tenorDays) || plan.repoTerms.tenorDays <= 0 ||
        (!facts.singleDay && plan.repoTerms.tenorDays > 3660) || (!facts.singleDay && isExchangeRepo(plan.businessType) && !EXCHANGE_REPO_TENORS.includes(plan.repoTerms.tenorDays)))
        push('repo-terms-missing','missing',plan.planId,`${plan.label}的市场或期限不符合已接入参数。`,'edit-plan');
      if (isFinancing(plan.businessType) && validMarket) {
        for (const [field,code,label] of (!facts.singleDay ?
          [['pledgeConfirmedYuan','repo-pledge','质押能力']] : [])) {
          const confirmed = facts.repoResources[market]?.[field] ?? null;
          const used = facts.repoUsed.pledge[market] ?? 0;
          if (confirmed === null) push(`${code}-missing`,'missing',plan.planId,
            `${plan.label}缺${market}${label}的已确认金额。`,'repo-settings');
          else if (confirmed - used < amount) push(`${code}-short`,'wait',plan.planId,
            `${plan.label}需${amount}元${label}，扣除现有占用后仅余${confirmed - used}元；须取得更多已确认资源。`,'repo-settings');
        }
      }
      if (isExchangeRepo(plan.businessType) && !facts.singleDay) {
        const window = windowStatus(facts.marketClock,{mode:'send'});
        if (window.result === 'missing') push('exchange-clock-missing','missing',plan.planId,
          `${plan.label}缺交易日或交易时钟，不能核对交易所回购申报窗口。`,'auto');
        else if (window.result === 'closed') push('exchange-window-closed',
          facts.marketClock?.isTradingDay === false || facts.marketClock?.time >= '15:30:00' ? 'block' : 'wait',
          plan.planId,`${plan.label}当前不在本业务日交易所回购新申报窗口。`,'auto');
      }
    }
  }
  for (const step of winner?.trace ?? []) {
    if (step.rules.some(r => r.ruleId === 'DEMO-EXP-01' && r.result === 'block'))
      push('deposit-threshold','block',step.planId,
        `${step.planId}在该顺序下的A银行存款投前敞口超过当前配置阈值。`,'auto');
    const cash = step.rules.find(r => r.ruleId === 'DEMO-CASH-01');
    if (cash?.result === 'waiting_conditions') push('cash-wait','wait',step.planId,
      `${step.planId}本次${step.nominalYuan}元须等待足额实际可用现金，再逐笔复核。`,'auto');
    const settlement = step.rules.find(r => r.ruleId === 'DEMO-SETTLEMENT-01');
    if (settlement?.result === 'block') push('settlement-capacity-short','block',step.planId,
      `${step.planId}在${settlement.valueDate}及后续日期的已确认业务头寸不足，未来卖出未成交回款不计入可用头寸。`,'auto');
    if (settlement?.result === 'missing') push('settlement-capacity-missing','missing',step.planId,
      `${step.planId}的未来交收头寸无法确认，需核对日期、费用和缓冲。`,'auto');
    for (const [ruleId,code,label] of (!facts.singleDay ?
      [['DEMO-REPO-PLEDGE','repo-pledge-cumulative','质押能力']] : []))
      if (step.rules.some(r => r.ruleId === ruleId && r.result === 'waiting_conditions'))
        push(code,'wait',step.planId,`${step.planId}本次${step.nominalYuan}元与同市场在途计划累计后${label}不足。`,'repo-settings');
  }
  if (boundary === 'action_budget') push('action-budget','info',null,
    `当前有${actions.length}个尚可安排动作，超过本次${search.budgets.actions}项安全预算；完整意向金额保留，不能判定无解。`,'auto');
  if (search.boundary === 'node_limit') push('search-budget','info',null,
    `搜索达到${search.nodes}节点预算，仅探索${search.exploredCandidates}个完整顺序；不能判定全局无解。`,'auto');
  if (search.boundary === 'candidate_budget') push('candidate-budget','info',null,
    `搜索达到${search.budgets.candidates}个完整候选预算，未探索全部顺序；不能判定全局无解。`,'auto');
  if (search.boundary === 'split_grid_unexplored') push('split-grid-unexplored','info',null,
    '已搜索完整动作顺序，尚未穷尽多计划分次组合。','auto');
  if (search.boundary === 'selected_path_only') push('selected-path-only','info',null,
    '只计算所选固定顺序；直接调用固定路径时新增计划排在原种子计划之后，可用自动搜索检查其它顺序。','auto');
  if (search.boundary === 'current_remaining_only') push('current-remaining-only','info',null,
    '只计算当前剩余动作，未探索其它分次方式。','auto');
  for (const item of search.excludedActions ?? []) push('subset-excluded',item.status === 'insufficient_data' ? 'missing' : 'block',item.planId,
    `${item.planId}未进入当前可行子集：${item.reason}`,'edit-plan');
  if (coreRulesEnabled(state)) {
    for (const {plan,amount} of actions) {
      const check = evaluateCoreRules(state,{plan,amountYuan:amount,cashYuan:facts.cash});
      for (const row of [...(check.blocking ?? []),...(check.missing ?? [])])
        push(`core-${row.ruleId}`,row.result === 'missing' ? 'missing' : 'block',plan.planId,
          `${plan.label}：${row.name ?? row.ruleId}；${row.reason ?? '需复核'}${row.needed?.length ? `；需补${row.needed.join('、')}` : ''}`,
          row.result === 'missing' ? 'edit-input' : 'edit-plan');
    }
  }
  return diagnostics;
}
export function calculate(state, options = {}) {
  const startedAt = Date.now();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  let lastProgressAt = 0, progressNodes = 0, progressCandidates = 0;
  const report = (stage, force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 100) return;
    lastProgressAt = now;
    onProgress({stage,nodes:progressNodes,candidates:progressCandidates,elapsedMs:now-startedAt});
  };
  report('读取数据', true);
  const facts = base(state);
  const requestedPathId = options.pathId ?? 'AUTO';
  const requestedNodeLimit = options.nodeLimit ?? null;
  if (requestedNodeLimit !== null && (!Number.isSafeInteger(requestedNodeLimit) || requestedNodeLimit < 1 || requestedNodeLimit > DEFAULT_NODE_LIMIT))
    throw new Error('搜索节点上限无效');
  const actionBudget = options.actionBudget ?? DEFAULT_ACTION_BUDGET;
  const candidateBudget = options.candidateBudget ?? DEFAULT_CANDIDATE_BUDGET;
  if (!Number.isSafeInteger(actionBudget) || actionBudget < 1 || actionBudget > DEFAULT_ACTION_BUDGET ||
    !Number.isSafeInteger(candidateBudget) || candidateBudget < 1 || candidateBudget > 4096)
    throw new Error('搜索预算无效');
  const actions = facts.balances.filter(b => b.arrangeableYuan > 0).map(b => ({ plan:facts.map.get(b.planId), amount:b.arrangeableYuan }))
    .sort((a,b) => a.plan.planId.localeCompare(b.plan.planId));
  const nodeLimit = requestedNodeLimit ?? (actions.length > 7 ? DEFAULT_LARGE_NODE_LIMIT : DEFAULT_NODE_LIMIT);
  const pathId = requestedPathId === '3+7' && actions.length > 1 ? 'AUTO' : requestedPathId;
  const unitMismatch = actions.filter(a => a.amount % unitFor(a.plan.businessType) !== 0)
    .map(a => ({ planId:a.plan.planId, unmatchedYuan:a.amount % unitFor(a.plan.businessType) }));
  const orderLimitIssues = actions.filter(a => isExchangeRepo(a.plan.businessType) && a.amount > 2 * EXCHANGE_REPO_MAX_ORDER_YUAN)
    .map(a => ({planId:a.plan.planId,amountYuan:a.amount,maxPerOrderYuan:EXCHANGE_REPO_MAX_ORDER_YUAN,
      maxTwoPartYuan:2 * EXCHANGE_REPO_MAX_ORDER_YUAN}));
  const allBalances = facts.balances.map(b => ({ ...b }));
  const boundary = actions.length > actionBudget ? 'action_budget' : unitMismatch.length ? 'unit_mismatch' :
    orderLimitIssues.length ? 'per_order_limit' : null;
  const results = [];
  const candidateCounts = { feasible:0, waiting_conditions:0, insufficient_data:0, blocked_sequence:0 };
  let exploredCandidates = 0;
  const retainLimit = actions.length > 5 ? MAX_RETAINED_CANDIDATES : Number.POSITIVE_INFINITY;
  const consider = candidate => {
    exploredCandidates++;
    progressCandidates = exploredCandidates;
    report('计算候选');
    candidateCounts[candidate.status] = (candidateCounts[candidate.status] ?? 0) + 1;
    results.push(candidate);
    if (results.length > retainLimit) { results.sort((a,b) => compare(a,b,facts.orderedKeys)); results.length = retainLimit; }
  };
  let search = { nodes:0, truncated:false, complete:false, boundary, exploredCandidates:0,
    retainedCandidates:0,statusCounts:candidateCounts,actionCount:actions.length,
    budgets:{nodes:nodeLimit,actions:actionBudget,candidates:candidateBudget},strategy:actions.length <= 7 ? 'enumeration' : 'bounded_prefix' };
  report('计算候选', true);
  const onNode = nodes => { progressNodes = nodes; report('计算候选'); };
  if (!boundary && actions.length) {
    if (pathId === '3+7' && state.scenarioId === 'S10') {
      const action = actions[0];
      const row = facts.balances.find(b => b.planId === action?.plan.planId);
      const hasFacts = row?.filledYuan > 0 || row?.lockedYuan > 0;
      const firstSlice = !hasFacts && row && action.plan.businessType === 'reverse_repo' ?
        calculateSplit({targetYuan:row.targetYuan,filledYuan:row.filledYuan,lockedYuan:row.lockedYuan,
          availableYuan:facts.cash,feeYuan:facts.input.feeYuan,bufferYuan:facts.input.bufferYuan}).proposedNowYuan : 0;
      const split = firstSlice && firstSlice < action.amount ? firstSlice : 0;
      if (split > 0) consider(evaluate(state,facts,actions,'3+7',split));
      else consider(evaluate(state,facts,actions,'3+7'));
      search = { ...search, nodes:1, exploredCandidates, complete:false, boundary:'selected_path_only' };
    } else if (['A','B','C'].includes(pathId)) {
      const order = namedOrder(pathId,actions);
      if (order) consider(evaluate(state,facts,order,pathId));
      search = { ...search, nodes:1, exploredCandidates, complete:false, boundary:'selected_path_only' };
    } else if (pathId === 'AUTO' || pathId === 'auto') {
      const resumedS10 = state.scenarioId === 'S10' && actions.length === 1 &&
        (() => { const row = facts.balances.find(b => b.planId === actions[0].plan.planId); return row?.filledYuan > 0 || row?.lockedYuan > 0; })();
      if (resumedS10) {
        consider(evaluate(state,facts,actions,'3+7'));
        search = { ...search, nodes:1, exploredCandidates, complete:false, boundary:'current_remaining_only' };
      } else {
      const stat = actions.length <= 7 ? permutations(OPTIONAL_PREFERENCES.some(k => facts.orderedKeys.includes(k)) ?
        searchOrder(actions,facts.orderedKeys) : actions,nodeLimit,order => {
        const id = `AUTO-${order.map(a => a.plan.planId).join('>')}`;
        consider(evaluate(state,facts,order,id));
      },onNode) : boundedSearch(state,facts,actions,nodeLimit,candidateBudget,consider,onNode);
      // Whole-action permutations are complete; the optional two-part grid is
      // deliberately not claimed to be exhausted when there are several plans.
      search = { ...search, nodes:stat.nodes, truncated:stat.truncated,prunedPrefixes:stat.pruned ?? 0,
        complete:!stat.truncated && actions.length <= 1,
        boundary:stat.truncated ? (stat.boundary === 'candidate_budget' ? 'candidate_budget' : 'node_limit') :
          actions.length > 1 ? 'split_grid_unexplored' : null,
        exploredCandidates };
      if (actions.length === 1 && actions[0].plan.direction === 'outflow' &&
        (facts.today === null || settlementDateFor(actions[0].plan,facts.today) === null) &&
        !(isExchangeRepo(actions[0].plan.businessType) && actions[0].amount > EXCHANGE_REPO_MAX_ORDER_YUAN) &&
        actions[0].amount > unitFor(actions[0].plan.businessType) && facts.cash !== null && facts.input.bufferYuan !== null &&
        !(state.scenarioId === 'S10' && resumedS10)) {
        const row = facts.balances.find(b => b.planId === actions[0].plan.planId);
        const firstSlice = calculateSplit({targetYuan:row.targetYuan,filledYuan:row.filledYuan,lockedYuan:row.lockedYuan,
          availableYuan:facts.cash,feeYuan:facts.input.feeYuan,bufferYuan:facts.input.bufferYuan,
          unitYuan:unitFor(actions[0].plan.businessType)}).proposedNowYuan;
        const split = firstSlice && firstSlice < actions[0].amount ? firstSlice : 0;
        if (split > 0 && exploredCandidates < nodeLimit) {
          // Stable tie breaker favours an immediately affordable first slice.
          consider(evaluate(state,facts,actions,state.scenarioId === 'S10' ? '3+7' : '0-SPLIT',split));
          search.exploredCandidates = exploredCandidates; search.complete = false; search.boundary = 'split_grid_unexplored';
        }
      }
      }
    } else throw new Error('未知路径标识');
  }
  if (!boundary && (actions.length > 7 || coreRulesEnabled(state)) && (pathId === 'AUTO' || pathId === 'auto') &&
    // Keep the established one-plan reverse-repo 0-SPLIT approval flow.
    !(actions.length === 1 && actions[0].plan.businessType === 'reverse_repo' &&
      results.some(c => c.candidateId === '0-SPLIT')) &&
    !results.some(c => c.fullCoverage && ['feasible','waiting_conditions'].includes(c.status) &&
      (!facts.singleDay || (c.projectedFinalCashYuan !== null && facts.input.bufferYuan !== null &&
        c.projectedFinalCashYuan >= facts.input.bufferYuan)))) {
    const ordered = searchOrder(actions,facts.orderedKeys);
    const chosen = [], excluded = [], partialBudget = {used:0};
    let subsetChecks = 0;
    for (const action of ordered) {
      const trial = evaluate(state,facts,[...chosen,action],'AUTO-SUBSET');
      subsetChecks++;
      if (trial.status === 'blocked_sequence' || trial.status === 'insufficient_data' ||
          (facts.singleDay && trial.projectedFinalCashYuan !== null && facts.input.bufferYuan !== null &&
           trial.projectedFinalCashYuan < facts.input.bufferYuan)) {
        const slice = largestCurrentOutflowSlice(state,facts,chosen,action,partialBudget);
        if (slice) {
          chosen.push(slice);
          excluded.push({planId:action.plan.planId,status:'partially_arranged',
            arrangedYuan:slice.amount,unarrangedYuan:sub(action.amount,slice.amount),
            reason:'当前指标和头寸允许的最大单位金额分片；余量保留原计划'});
        } else excluded.push({planId:action.plan.planId,status:trial.status,
          reason:trial.conflicts.at(-1) ?? trial.status});
      } else chosen.push(action);
    }
    search.subsetChecks = subsetChecks;
    search.partialChecks = partialBudget.used;
    search.excludedActions = excluded;
    if (chosen.length && (chosen.length < actions.length ||
        chosen.some((selected,i) => selected.amount !== actions.find(a => a.plan.planId === selected.plan.planId)?.amount))) {
      const subset = evaluate(state,facts,chosen,'AUTO-SUBSET');
      if (!subset.fullCoverage || !['feasible','waiting_conditions'].includes(subset.status))
        throw new Error('分片子集最终复核未通过');
      subset.fullCoverage = false;
      subset.conflicts.push(`仅找到${chosen.length}/${actions.length}笔当前可评估子集或金额分片；其余完整意向金额仍待安排。`);
      // A diagnostic subset is outside the complete-order candidate budget.
      results.push(subset);
      results.sort((a,b) => compare(a,b,facts.orderedKeys));
      if (results.length > retainLimit) results.length = retainLimit;
      search.subsetGenerated = true;
      search.subsetCandidates = 1;
    }
  }
  results.sort((a,b) => compare(a,b,facts.orderedKeys));
  progressNodes = search.nodes;
  report('逐笔与批次复核', true);
  search.retainedCandidates = results.length;
  search.stopReason = search.boundary;
  const winner = results[0] ?? null;
  const blockedOnly = exploredCandidates > 0 && candidateCounts.blocked_sequence === exploredCandidates;
  const status = boundary ? 'search_exhausted' : winner ?
    (winner.candidateId === 'AUTO-SUBSET' ? winner.status :
      winner.status === 'blocked_sequence' && pathId !== 'AUTO' && pathId !== 'auto' ? 'blocked_sequence' :
      blockedOnly ? 'search_exhausted' : winner.status) :
    actions.length ? 'search_exhausted' : 'feasible';
  const conflicts = winner?.conflicts ?? [];
  if (boundary === 'unit_mismatch') conflicts.push('交易单位不匹配：保留原意向金额及尾差，不把向下对齐金额视为完成。');
  if (boundary === 'action_budget') conflicts.push(`尚可安排动作超过${actionBudget}项安全预算；意向金额完整保留。`);
  if (boundary === 'per_order_limit') conflicts.push('当前配置的交易所回购单笔上限为100亿元、每计划最多两笔；意向金额超出该分次范围。');
  if (actions.some(a => isExchangeRepo(a.plan.businessType)) &&
    (facts.marketClock?.isTradingDay === false || facts.marketClock?.time >= '15:30:00') &&
    !conflicts.some(x => x.includes('新申报窗口已结束')))
    conflicts.push('当前业务日的交易所回购新申报窗口已结束；意向金额保留，不自动顺延至下一交易日。');
  if (blockedOnly && status === 'search_exhausted') conflicts.push('当前已探索顺序均阻断；分次及未来外部条件未穷尽，不能证明全局无解。');
  const message = status === 'feasible' ? '当前已确认输入下可形成交易建议；下达前仍需经理审核和最新复核。' :
    status === 'waiting_conditions' ? '完整意向金额保留；条件兑现后须经理手动下达并重新核对现金和规则。' :
    status === 'insufficient_data' ? '关键金额或指标为空，相关规则待核；未知值未按零处理。' :
    status === 'blocked_sequence' ? '此顺序触发当前配置的硬约束；仅证明此顺序冲突。' :
    status === 'search_exhausted' ? '当前搜索范围或预算不足，保留未探索边界；未证明意向金额无解。' :
    '限定资源与动作下无可行路径。';
  const selectedTrace = winner?.trace ?? [];
  const conditionalKinds = new Set(['previous_confirmed','filled','payable_cleared','cash_available','funds_available','holding_confirmed']);
  const readySteps = (winner?.steps ?? []).filter(step => !step.blocked &&
    !step.machineConditions.some(c => conditionalKinds.has(c.kind)) &&
    !selectedTrace.find(row => row.stepId === step.stepId)?.rules?.some(r => ['block','missing','waiting_conditions','closed'].includes(r.result)));
  const readyIds = new Set(readySteps.map(step => step.stepId));
  const groups = [];
  if (readySteps.length) groups.push({groupId:'CURRENT-READY',stepIds:readySteps.map(s => s.stepId),
    planIds:readySteps.map(s => s.planId),nominalYuan:readySteps.reduce((n,s) => add(n,s.nominalYuan),0),
    status:'ready',reason:'逐笔及累计规则已通过，发送前仍须按最新状态复核。',ruleIds:[...new Set(selectedTrace.flatMap(x => x.rules?.map(r => r.ruleId) ?? []))]});
  for (const step of winner?.steps ?? []) if (!readyIds.has(step.stepId))
    groups.push({groupId:`CONDITIONAL-${step.stepId}`,stepIds:[step.stepId],planIds:[step.planId],
      nominalYuan:step.nominalYuan,status:step.blocked ? 'blocked' : 'conditional',
      reason:step.blocked ? '该步规则阻断。' : step.condition || '该步需先满足条件或补齐输入。',
      ruleIds:selectedTrace.find(x => x.stepId === step.stepId)?.rules?.filter(r => ['block','missing','waiting_conditions','closed'].includes(r.result)).map(r => r.ruleId) ?? []});
  const planCoverage = allBalances.map(row => {
    const suggestedYuan = (winner?.steps ?? []).filter(s => s.planId === row.planId && !s.blocked)
      .reduce((n,s) => add(n,s.nominalYuan),0);
    return {planId:row.planId,targetYuan:row.targetYuan,filledYuan:row.filledYuan,
      lockedYuan:row.lockedYuan,remainingYuan:row.remainingYuan,suggestedYuan,
      unarrangedYuan:Math.max(0,sub(row.arrangeableYuan,suggestedYuan))};
  });
  const proposal = { pathId, origin:'calculated', status, peakShortfallYuan:winner?.peakShortfallYuan ?? null,
    conflicts, message, steps:winner?.steps ?? [],groups,planCoverage,
    unfinishedYuan:planCoverage.reduce((n,x) => add(n,x.remainingYuan),0),
    unarrangedYuan:planCoverage.reduce((n,x) => add(n,x.unarrangedYuan),0) };
  if (proposal.unarrangedYuan > 0 && winner?.candidateId === 'AUTO-SUBSET')
    proposal.message = `当前仅找到可行子集，尚有${proposal.unarrangedYuan}元未安排；未证明完整意向金额无解。`;
  const comparisonGroupId = JSON.stringify([state.context?.runId ?? null,state.revision ?? null,
    state.rulesVersion ?? null,state.ruleConfig?.version ?? null,facts.cash,facts.today,
    [...facts.futureCashDeltas].sort(([a],[b]) => a.localeCompare(b)),facts.input.feeYuan,
    facts.input.bufferYuan,actions.map(a => [a.plan.planId,a.amount,a.plan.tradeDate ?? null,a.plan.settlementDate ?? null])]);
  const remainingOutflowYuan = actions.filter(a=>a.plan.direction==='outflow').reduce((n,a)=>add(n,a.amount),0);
  const expectedInflowYuan = actions.filter(a=>a.plan.direction==='inflow').reduce((n,a)=>add(n,a.amount),0);
  const expectedSaleYuan = actions.filter(a=>isSecuritySale(a.plan.businessType)).reduce((n,a)=>add(n,a.amount),0);
  const expectedFinancingYuan = sub(expectedInflowYuan,expectedSaleYuan);
  const dateAware = facts.today !== null && actions.some(a => settlementDateFor(a.plan,facts.today) !== null);
  const todayOutflowYuan = actions.filter(a => a.plan.direction === 'outflow' &&
    settlementDateFor(a.plan,facts.today) === null).reduce((n,a)=>add(n,a.amount),0);
  const todayInflowYuan = actions.filter(a => a.plan.direction === 'inflow' &&
    settlementDateFor(a.plan,facts.today) === null).reduce((n,a)=>add(n,a.amount),0);
  const funding = calculateFunding({initialYuan:facts.cash,availableFundingYuan:0,lockedOutflowYuan:0,
    remainingOutflowYuan:dateAware ? todayOutflowYuan : remainingOutflowYuan,
    expectedSaleYuan:dateAware ? todayInflowYuan : expectedInflowYuan,
    feeYuan:dateAware && todayOutflowYuan === 0 ? 0 : facts.input.feeYuan,bufferYuan:facts.input.bufferYuan});
  const diagnostics = collectDiagnostics(state,facts,actions,boundary,search,winner,unitMismatch,orderLimitIssues);
  report('生成建议', true);
  proposal.blockers = diagnostics.filter(x => ['block','missing','wait'].includes(x.severity));
  const ruleCounts = {pass:0,warn:0,block:0,missing:0,not_applicable:0,waiting_conditions:0,closed:0};
  for (const step of selectedTrace) for (const row of step.rules ?? [])
    ruleCounts[row.result] = (ruleCounts[row.result] ?? 0) + 1;
  const progress = {stages:[
    {stage:'读取数据',status:'done',count:allBalances.length},
    {stage:'校验输入',status:boundary ? 'partial' : 'done',count:actions.length,issues:unitMismatch.length+orderLimitIssues.length},
    {stage:'匹配适用规则',status:'done',counts:ruleCounts},
    {stage:'计算候选',status:search.truncated ? 'partial' : 'done',nodes:search.nodes,candidates:search.exploredCandidates,boundary:search.boundary},
    {stage:'逐笔与批次复核',status:proposal.blockers.length ? 'partial' : 'done',steps:selectedTrace.length,ready:readySteps.length,blocked:proposal.blockers.length},
    {stage:'生成建议',status:proposal.steps.length || !actions.length ? 'done' : 'partial',groups:groups.length,unarrangedYuan:proposal.unarrangedYuan}
  ].map(x => ({...x,label:x.stage,message:x.status === 'done' ? '已完成' : '存在未完成检查'})),
    ruleCounts,stopReason:search.boundary,completed:true};
  if (requestedPathId !== pathId) diagnostics.push({code:'special-path-fallback',severity:'info',planId:null,
    message:'新增动作后，S10专用3+7路径改用自动顺序搜索。',action:'auto'});
  report('计算完成', true);
  return { proposal, trace: { assumptions:[dateAware ? '本次按名义金额在各自交收日测算现金变化，实际现金收付待核' :
      '本次按名义金额与当日现金同额测算，实际现金收付待核','S13原始卖券持仓可用为当前测算假设；其他卖券须确认持仓',
      dateAware ? (facts.singleDay ? '卖券与融资成交计入业务头寸及现金比例；实际付款须核对账户已到账现金，到账回报不重复增加业务头寸' :
        '未来卖出计划未成交回款不计入已确认交收额度；融资到账仍须cash_available回报') :
        '融资计划必须由经理手动建立；所有流入仅在cash_available条件后进入投影',
      ...(!facts.singleDay ? ['融资利息和到期应付尚未纳入现金需求'] : [])],
    cashContract:{mode:dateAware ? 'dated_demo_nominal_equals_cash' : 'demo_nominal_equals_cash',feeAllocation:'first_outflow_once',unitYuan:null,
      unitsByPlan:Object.fromEntries(actions.map(a => [a.plan.planId,unitFor(a.plan.businessType)])),
      formalConversionDefined:false},
    rulesVersion:state.rulesVersion ?? '2B-0.1.0', ruleConfigVersion:state.ruleConfig?.version ?? null,
    preferencesVersion:state.preferences?.version ?? null, snapshotRevision:state.revision ?? null,
    initialAvailableYuan:winner?.projectionStartYuan ?? facts.cash, currentAvailableYuan:facts.cash,
    todayProjectedAvailableYuan:winner?.projectedFinalCashYuan ?? facts.cash,
    futureCashProjection:futureProjection(winner?.projectedFinalCashYuan ?? facts.cash,
      facts.futureCashDeltas,new Map(Object.entries(winner?.futureActionDeltas ?? {}))),
    planBalances:allBalances, funding, expectedInflowYuan,expectedSaleYuan,expectedFinancingYuan,
    todayRemainingOutflowYuan:todayOutflowYuan,todayExpectedInflowYuan:todayInflowYuan,
    orderLimitIssues, search, diagnostics, progress, selectedCandidateId:winner?.candidateId ?? null,
    orderedPreferenceKeys:facts.orderedKeys, excludedPreferenceKeys:['metric_headroom'],
    steps:winner?.trace ?? [], projectedFinalCashYuan:winner?.projectedFinalCashYuan ?? null,
    unitMismatch, comparisonGroupId }, candidates:results.map(c => detail(c,winner,facts.orderedKeys,comparisonGroupId)) };
}
