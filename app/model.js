// Versioned local simulation envelope, not the full 2A RunState/source adapter.
import { calculate, evaluateCurrentConcentration, evaluateSelectedSequence } from './engine.js';
import { newExecution, executionSummary, registerSend, registerCancel, registerCashEvent, applyEvent, validateExecution } from './execution.js';
import { normalizeInitialTemplate, legacyInitialTemplate,
  deriveTemplateExposure, bankIdForPlan, validatePlanSecurity, openingAccountCash } from './initial-data.js';
import { createDefaultInitialTemplate } from './default-scenario.js';
import { BUSINESS_DIRECTIONS, EXCHANGE_REPO_TENORS, EXCHANGE_REPO_MAX_ORDER_YUAN,
  isFinancing, isExchangeRepo, isSecuritySale, unitFor, windowStatus, cancellationStatus } from './business.js';
import { coreRulesEnabled, evaluateCoreRules } from './core-rules.js';
import { yi, amountDetail, coreRuleDetail, ratioLimitYuan } from './readiness-diagnostics.js';
export const UI_VERSION = 'simulation-ui-3';
export const CONTRACT_MAPPING = 'simulation-execution-3';
const RULES_VERSION = '2B-0.1.0';
const DATE = '2026-09-07';
const PORTFOLIO = 'DEMO-500';
const PREF_KEYS = ['settlement_safety', 'fewer_warnings', 'metric_headroom', 'reverse_repo_first', 'liquidity_last'];
const REPO_MARKETS = ['INTERBANK','SSE','SZSE'];
const RULE_NAMES = { 'DEMO-CASH-01':'可用资金','DEMO-EXP-01':'存款集中度',
  'DEMO-WARN-01':'银行敞口观察','DEMO-SETTLEMENT-01':'交收资金',
  'DEMO-REPO-TERMS':'回购期限与市场','DEMO-REPO-PLEDGE':'已确认质押券',
  'DEMO-EXCHANGE-WINDOW':'交易所申报窗口' };
const emptyRepoResources = () => Object.fromEntries(REPO_MARKETS.map(m => [m, { quotaConfirmedYuan: null, pledgeConfirmedYuan: null }]));
const singleDay = state => state.initialData?.demoMode === 'single-day-principal-v1';
const repoTermsValid = (p, simple = false) => (isFinancing(p.businessType) || isExchangeRepo(p.businessType) ||
  (p.businessType === 'reverse_repo' && p.repoTerms !== null)) ?
  exactKeys(p.repoTerms, ['market','tenorDays','annualRate']) && REPO_MARKETS.includes(p.repoTerms.market) &&
  (['interbank_repo_financing','reverse_repo'].includes(p.businessType) ? p.repoTerms.market === 'INTERBANK' : p.repoTerms.market !== 'INTERBANK') &&
  Number.isSafeInteger(p.repoTerms.tenorDays) && p.repoTerms.tenorDays > 0 && (simple || p.repoTerms.tenorDays <= 3660) &&
  (simple || !isExchangeRepo(p.businessType) || EXCHANGE_REPO_TENORS.includes(p.repoTerms.tenorDays)) &&
  (p.repoTerms.annualRate === null || (typeof p.repoTerms.annualRate === 'string' &&
    /^(?:0|0\.[0-9]{1,12}|1(?:\.0{1,12})?)$/.test(p.repoTerms.annualRate))) : p.repoTerms === null;
const clone = value => JSON.parse(JSON.stringify(value));
// JSON object members are unordered; arrays retain their business order.
// Cloud storage may canonicalize keys without changing any saved facts.
const canonicalJson = value => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const money = (value, name, positive = false) => {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error(`${name}必须是${positive ? '正' : '非负'}的安全整数元`);
  return value;
};
const safeAdd = (a, b) => {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new Error('金额计算超出安全整数范围');
  return n;
};
const numberedId = (id, prefix) => {
  if (typeof id !== 'string' || !id.startsWith(prefix) || !/^[1-9]\d*$/.test(id.slice(prefix.length))) throw new Error('存档ID与运行域不匹配');
  const n = Number(id.slice(prefix.length));
  if (!Number.isSafeInteger(n)) throw new Error('存档ID序号超出安全整数范围');
  return n;
};
const seedPlans = {
  S13: [
    ['P-REPO', '10亿逆回购', 'reverse_repo', 'outflow', null, null, 1000000000],
    ['P-DEP', 'A银行存款', 'deposit', 'outflow', null, 'BANK-A', 100000000],
    ['P-CD', 'A银行存单买入', 'cd_buy', 'outflow', null, 'BANK-A', 100000000],
    ['P-BOND', '其他现券买入', 'bond_buy', 'outflow', null, 'ISSUER-C', 100000000],
    ['P-SELL', 'B银行存单卖出', 'cd_sell', 'inflow', null, 'BANK-B', 200000000],
  ],
  S10: [['P10', '10亿逆回购（3+7）', 'reverse_repo', 'outflow', 'S10-CP-01', null, 1000000000]],
};
const seeds = scenarioId => seedPlans[scenarioId].map(([planId, label, businessType, direction, counterpartyId, issuerId, targetYuan]) => ({
  planId, label, businessType, direction, counterpartyId, issuerId, targetYuan, termsNote: '', repoTerms: null,
  tradeDate: DATE, settlementDate: DATE, securityId: null,
  marketTier: ['cd_buy','cd_sell','bond_buy','bond_sell'].includes(businessType) ? 'secondary' : null, version: 1,
}));
const seedInputs = scenarioId => ({
  initialCashYuan: 300000000,
  navYuan: scenarioId === 'S13' ? 50000000000 : null,
  bankExposureYuan: scenarioId === 'S13' ? 3950000000 : null,
  feeYuan: 0, bufferYuan: 0,
});
const seedRuleConfig = () => ({ version: 1, depositThreshold: '0.08', observationThreshold: '0.082' });
const decimalRatio = value => typeof value === 'string' &&
  /^(?:0\.[0-9]{1,12}|1(?:\.0{1,12})?)$/.test(value) &&
  (value[0] === '1' || /[1-9]/.test(value.slice(2)));
const flow = (settledBalanceYuan, localReservedYuan = 0, platformReservedYuan = 0, payableReservedYuan = 0) => ({
  settledBalanceYuan, localReservedYuan, platformReservedYuan, payableReservedYuan,
});
const progressCatalog = {
  S13: {
    initial: { label: '日初种子', cash: flow(300000000), ledger: {}, quality: 'demo_seed' },
  },
  S10: {
    initial: { label: '日初3亿', cash: flow(300000000), ledger: {}, quality: 'demo_seed' },
    locked3: { label: 'A本地锁定3亿', cash: flow(300000000, 300000000), ledger: { P10: [0, 300000000] }, quality: 'illustrative_local_lock' },
    unknown3: { label: 'A发送结果未知（占用保留）', cash: flow(300000000, 300000000), ledger: { P10: [0, 300000000] }, quality: 'illustrative_unknown' },
    accepted3: { label: 'A已接收（占用迁移）', cash: flow(300000000, 0, 300000000), ledger: { P10: [0, 300000000] }, quality: 'illustrative_accepted' },
    cancel_pending: { label: 'A撤改待双证据（不释放）', cash: flow(300000000, 0, 300000000), ledger: { P10: [0, 300000000] }, quality: 'illustrative_cancel_pending' },
    filled3: { label: 'A成交3亿待结算', cash: flow(300000000, 0, 0, 300000000), ledger: { P10: [300000000, 0] }, quality: 'illustrative_fill' },
    settled3: { label: 'A已结算', cash: flow(0), ledger: { P10: [300000000, 0] }, quality: 'illustrative_settled' },
    funding7: { label: '独立7亿已确认可用', cash: flow(700000000), ledger: { P10: [300000000, 0] }, quality: 'illustrative_cash_available' },
  },
};
const progressFor = (scenarioId, id, inputs = seedInputs(scenarioId)) => {
  const progress = clone(progressCatalog[scenarioId][id]);
  if (id === 'initial') progress.cash.settledBalanceYuan = inputs.initialCashYuan;
  return progress;
};
const fresh = scenarioId => {
  if (!seedPlans[scenarioId]) throw new Error('未知场景');
  const runId = `${scenarioId}-ui-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const state = {
    uiVersion: UI_VERSION, contractMapping: CONTRACT_MAPPING, scenarioId,
    context: { scenarioId, runId, portfolioId: PORTFOLIO, businessDate: DATE },
    revision: 0, rulesVersion: RULES_VERSION, seedTouched: false, nextPlanId: 1, nextProposalId: 1, nextApprovalId: 1,
    plans: seeds(scenarioId), inputs: seedInputs(scenarioId), ruleConfig: seedRuleConfig(),
    preferences: { version: 1, orderedKeys: [] }, repoResources: emptyRepoResources(), repoResourcesVersion: 1,
    marketClock: { time: '09:30:00', isTradingDay: true, timezone: 'Asia/Shanghai' },
    proposal: null, calculation: null, approval: null, progressId: 'initial', progress: progressFor(scenarioId, 'initial'),
    execution: newExecution(seedInputs(scenarioId).initialCashYuan),
  };
  state.initialData = legacyInitialTemplate(state);
  return state;
};
const planSignature = plans => plans.map(({ planId, label, businessType, direction, counterpartyId, issuerId, targetYuan, termsNote, repoTerms,
  tradeDate, settlementDate, securityId, marketTier, version }) =>
  [planId, label, businessType, direction, counterpartyId, issuerId, targetYuan, termsNote, repoTerms,
    tradeDate, settlementDate, securityId, marketTier, version]);
const pristine = state => state.seedTouched === false && same(planSignature(state.plans), planSignature(seeds(state.scenarioId))) &&
  same(state.inputs, seedInputs(state.scenarioId)) && same(state.ruleConfig, seedRuleConfig());
function approvalStatus(state) {
  const a = state.approval;
  if (!a) return 'none';
  if (state.execution.requiresReapproval) return 'stale';
  if (!state.proposal || a.proposalId !== state.proposal.proposalId || a.proposalVersion !== state.proposal.version ||
      !same(a.proposalCopy, state.proposal) || a.preferencesVersion !== state.preferences.version || a.rulesVersion !== state.rulesVersion ||
      a.ruleConfigVersion !== state.ruleConfig.version ||
      !same(a.planVersions, state.plans.map(p => [p.planId, p.version]))) return 'stale';
  return 'valid';
}
const manualApproval = state => approvalStatus(state) === 'valid' &&
  state.approval?.authoritySource !== 'calculated_skip_review';
const executionAuthorization = (state, source) => ({
  approvalId: `${state.context.runId}-AP-${state.nextApprovalId}`,
  proposalId: state.proposal.proposalId, proposalVersion: state.proposal.version,
  proposalCopy: clone(state.proposal),
  planVersions: state.plans.map(p => [p.planId, p.version]),
  preferencesVersion: state.preferences.version, rulesVersion: state.rulesVersion,
  ruleConfigVersion: state.ruleConfig.version,
  ...(source === 'calculated_skip_review' ? { authoritySource: source } : {}),
});
// A blocked overall search can still contain calculated steps that are safe to
// review. The approval retains the full proposal for audit; only steps in a
// ready or conditional group may subsequently pass the send-time checks.
export function eligibleApprovalSteps(state) {
  if (state.execution.requiresReapproval || Object.keys(state.execution.pending).length ||
      state.proposal?.origin !== 'calculated') return [];
  const allowed = new Set((state.proposal.groups ?? [])
    .filter(group => ['ready', 'conditional'].includes(group.status))
    .flatMap(group => group.stepIds));
  const trace = state.calculation?.trace?.steps ?? [];
  return state.proposal.steps.filter(step => !step.blocked && allowed.has(step.stepId) &&
    !trace.find(row => row.stepId === step.stepId)?.rules?.some(rule =>
      ['block', 'missing', 'closed'].includes(rule.result)));
}
function saleHoldingReady(state, plan, nominalYuan) {
  if (!['cd_sell','bond_sell'].includes(plan.businessType)) return true;
  if (state.initialData.provenance.kind === 'legacy') {
    const b = summary(state).planBalances.find(x => x.planId === plan.planId);
    return state.scenarioId === 'S13' && plan.planId === 'P-SELL' && plan.businessType === 'cd_sell' &&
      plan.issuerId === 'BANK-B' && plan.targetYuan <= 200000000 &&
      b.filledYuan + b.lockedYuan + nominalYuan <= 200000000;
  }
  if (plan.securityId === null) return false;
  const security = state.initialData.securities.find(x => x.securityId === plan.securityId);
  if (!security || !(['cd_sell'].includes(plan.businessType) ? security.instrumentKind === 'cd' :
      ['bond','government_bond','abs'].includes(security.instrumentKind)) ||
      plan.issuerId !== security.issuerBankId) return false;
  let sellableYuan = 0;
  const maturedHoldings = singleDay(state) ? new Set(state.initialData.maturityCashEvents
    .filter(e => e.dueDate <= state.context.businessDate && e.sourceHoldingId)
    .map(e => e.sourceHoldingId)) : new Set();
  for (const h of state.initialData.holdings.filter(h => h.securityId === plan.securityId)) {
    if (maturedHoldings.has(h.holdingId)) continue;
    if (h.sellableYuan === null) return false;
    sellableYuan = safeAdd(sellableYuan,h.sellableYuan);
  }
  if (singleDay(state)) {
    for (const opening of state.initialData.pendingSettlements.filter(x => x.securityId === plan.securityId &&
      x.direction === 'outflow' && !x.holdingIncludedAtOpen && x.settlementDate <= state.context.businessDate)) {
      const paid = opening.cashIncludedAtOpen ? opening.amountYuan :
        Object.values(state.execution.cashEventReceipts).filter(r => r.sourceId === opening.tradeId)
          .reduce((n,r) => safeAdd(n,r.amountYuan),0);
      sellableYuan = safeAdd(sellableYuan,paid);
    }
    for (const instruction of Object.values(state.execution.instructions)) {
      if (instruction.securityId === plan.securityId && ['cd_buy','bond_buy'].includes(instruction.businessType))
        sellableYuan = safeAdd(sellableYuan,instruction.settledYuan);
    }
  }
  const openingPending = state.initialData.pendingSettlements.filter(x => x.securityId === plan.securityId &&
    x.direction === 'inflow' && !x.holdingIncludedAtOpen).reduce((n,x) => safeAdd(n,x.amountYuan),0);
  const liveCommitted = state.plans.filter(p => p.securityId === plan.securityId && p.direction === 'inflow')
    .reduce((n,p) => { const b = summary(state).planBalances.find(x => x.planId === p.planId);
      return safeAdd(n,safeAdd(b.filledYuan,b.lockedYuan)); },0);
  return sellableYuan - openingPending - liveCommitted >= nominalYuan;
}
function readiness(state, item, { skipReview = false } = {}) {
  if (state.progressId !== 'initial') return { stepId: item.stepId, ready: false, reason: `历史场景进度仅供查看：${state.progress?.label ?? state.progressId}，${item.stepId}不可下达` };
  if (state.execution.requiresRefresh || state.execution.snapshot.quality !== 'fresh' ||
      Date.now() - state.execution.snapshot.observedAt > 30000) return { stepId: item.stepId, ready: false,
        reason: `执行快照过期或恢复后尚未刷新：快照质量${state.execution.snapshot.quality}、观察时间${Number.isFinite(state.execution.snapshot.observedAt) ? new Date(state.execution.snapshot.observedAt).toISOString() : '未知'}，${item.stepId}须刷新后复核` };
  if (Object.keys(state.execution.pending).length) return { stepId: item.stepId, ready: false,
    reason: `回报序号缺失，等待补齐：待处理序号${Object.keys(state.execution.pending).join('、')}` };
  if (approvalStatus(state) !== 'valid' || (!skipReview && !manualApproval(state)))
    return { stepId: item.stepId, ready: false, reason: `指令包尚未有效人工审核：${item.stepId}当前审核状态${approvalStatus(state)}${state.approval?.authoritySource === 'calculated_skip_review' ? '（仅计算预演）' : ''}` };
  const calculatedStep = state.proposal?.steps.find(step => step.stepId === item.stepId);
  const calculatedTrace = state.calculation?.trace?.steps?.find(step => step.stepId === item.stepId);
  const traceBlock = calculatedTrace?.rules?.find(rule => ['block','missing','closed'].includes(rule.result));
  if (!calculatedStep || state.proposal.origin !== 'calculated' || state.execution.requiresReapproval ||
      item.nominalYuan > calculatedStep.nominalYuan ||
      (!skipReview && !eligibleApprovalSteps(state).some(step => step.stepId === item.stepId)) ||
      (skipReview && (!calculatedTrace || calculatedTrace.rules?.some(rule =>
        ['missing','closed'].includes(rule.result)) ||
        (calculatedStep.blocked && item.nominalYuan === calculatedStep.nominalYuan))))
    return { stepId: item.stepId, ready: false,
      reason: traceBlock?.reason ? `计算阻断：${coreRuleDetail(traceBlock)}` :
        '该步骤被计算阻断或不在可审核子集内',
      ...(traceBlock?.ruleId ? {ruleId:traceBlock.ruleId} : {}) };
  if (Object.values(state.execution.instructions).some(i => i.stepId === item.stepId)) return { stepId: item.stepId, ready: false,
    reason: `该步骤已有发送事实：${item.stepId}，须重新生成指令包` };
  if (Object.values(state.execution.instructions).some(i => i.status === 'unknown'))
    return { stepId: item.stepId, ready: false, reason: `已有发送结果未知的指令：${Object.entries(state.execution.instructions).filter(([,i]) => i.status === 'unknown').map(([id]) => id).join('、')}，须核实回报后再下达` };
  const plan = state.plans.find(p => p.planId === item.planId);
  const balance = summary(state).planBalances.find(b => b.planId === item.planId);
  if (!plan || !Number.isSafeInteger(item.nominalYuan) || item.nominalYuan <= 0 ||
      item.nominalYuan % unitFor(plan.businessType) !== 0)
    return { stepId: item.stepId, ready: false, reason: `本次金额须为正整数元且符合业务单位：${plan?.label ?? item.planId}本次${yi(item.nominalYuan)}、业务单位${plan ? unitFor(plan.businessType) : '未知'}元` };
  if (!plan || !balance || balance.arrangeableYuan < item.nominalYuan) return { stepId: item.stepId, ready: false,
    reason: `可安排名义金额不足：${plan?.label ?? item.planId}本次${yi(item.nominalYuan)}，${balance ? `当前可安排${yi(balance.arrangeableYuan)}，尚差${yi(item.nominalYuan-balance.arrangeableYuan)}` : '可安排余额未知'}；需重新建议和审核` };
  if (!saleHoldingReady(state, plan, item.nominalYuan))
    return { stepId: item.stepId, ready: false, reason: `证券品种、发行人或持仓可卖量未核实：${plan.label}（${plan.securityId ?? '证券代码未知'}）本次${yi(item.nominalYuan)}；可卖量或匹配关系须核实` };
  if (coreRulesEnabled(state)) {
    if (['deposit','cd_buy','cd_sell'].includes(plan.businessType) && !bankIdForPlan(plan,state.initialData))
      return { stepId: item.stepId, ready: false, reason: `存款银行或存单发行人未确认：${plan.label}（${plan.planId}），无法判断核心规则` };
    const rules = evaluateCoreRules({ ...state, summary: summary(state) },
      { plan, amountYuan: item.nominalYuan });
    const failed = rules.missing?.[0] ?? rules.blocking?.[0];
    if (failed) return { stepId: item.stepId, ready: false,
      reason: coreRuleDetail(failed),
      ruleId: failed.ruleId ?? null, coreRules: rules };
  } else {
    const concentration = evaluateCurrentConcentration({ ...state, summary: summary(state) }, plan, item.nominalYuan);
    if (concentration.needed.some(key => key === 'issuerId' || key === 'bankId' || key.startsWith('bankId:')))
      return { stepId: item.stepId, ready: false, reason: `发行人/存款银行未确认：${plan.label}（${plan.planId}），无法判断适用规则` };
    if (concentration.needed.length || concentration.depositResult === 'missing' || concentration.warningResult === 'missing')
      return { stepId: item.stepId, ready: false, reason: `银行敞口或净值未知：${plan.label}（${plan.issuerId ?? plan.counterpartyId ?? '银行未知'}），最新规则不可校验；缺少${concentration.needed.join('、') || '投前敞口或净值'}` };
    if (concentration.depositResult === 'block')
      return { stepId: item.stepId, ready: false, reason: `最新存款投前集中度超过当前配置阈值：${plan.label}（${plan.issuerId ?? plan.counterpartyId ?? '银行未知'}），投前敞口${yi(concentration.actualPostExposureYuan)}、上限${yi(ratioLimitYuan(state.inputs.navYuan,state.ruleConfig.depositThreshold))}（阈值${state.ruleConfig.depositThreshold}），超出${yi(BigInt(concentration.actualPostExposureYuan)-ratioLimitYuan(state.inputs.navYuan,state.ruleConfig.depositThreshold))}；需重新计算` };
    if (concentration.warningResult === 'warn' && !skipReview &&
        !(state.approval.proposalCopy.conflicts ?? []).some(w => w.includes('DEMO-WARN-01')))
      return { stepId: item.stepId, ready: false, reason: `出现未经审核的集中度软预警：${plan.label}（${plan.issuerId ?? plan.counterpartyId ?? '银行未知'}），预计敞口${yi(concentration.actualPostExposureYuan)}、观察线${yi(ratioLimitYuan(state.inputs.navYuan,state.ruleConfig.observationThreshold))}（阈值${state.ruleConfig.observationThreshold}）；须重新审核` };
  }
  if (isExchangeRepo(plan.businessType) && (item.nominalYuan > EXCHANGE_REPO_MAX_ORDER_YUAN ||
    item.nominalYuan % unitFor(plan.businessType) !== 0))
    return { stepId: item.stepId, ready: false, reason: `交易所正回购单笔金额或交易单位不符合当前配置规则：${plan.label}本次${yi(item.nominalYuan)}，单笔上限${yi(EXCHANGE_REPO_MAX_ORDER_YUAN)}，交易单位${unitFor(plan.businessType)}元` };
  const available = summary(state).availableYuan;
  if ((available === null && !isFinancing(plan.businessType)) || state.inputs.feeYuan === null || state.inputs.bufferYuan === null)
    return { stepId: item.stepId, ready: false, reason: `关键资金字段未知：${[available === null && !isFinancing(plan.businessType) ? '可用资金' : null,state.inputs.feeYuan === null ? '费用' : null,state.inputs.bufferYuan === null ? '资金缓冲' : null].filter(Boolean).join('、')}；${plan.label}不可下达` };
  if (state.inputs.feeYuan !== 0) return { stepId: item.stepId, ready: false, reason: `非零费用缺少已核实现金分配：${plan.label}，费用${yi(state.inputs.feeYuan)}，不能下达` };
  if (isFinancing(plan.businessType)) {
    const market = plan.repoTerms?.market;
    const resource = state.repoResources[market];
    if (!resource || (!singleDay(state) && resource.pledgeConfirmedYuan === null))
      return { stepId: item.stepId, ready: false, reason: `合格质押券金额未知：${plan.label}（${market ?? '市场未知'}），本次需${yi(item.nominalYuan)}` };
    const pledged = summary(state).pledgeUsedByMarket[market];
    if (!singleDay(state) && resource.pledgeConfirmedYuan - pledged < item.nominalYuan)
      return { stepId: item.stepId, ready: false, reason: `已确认质押券不足：${plan.label}（${market}），${amountDetail(item.nominalYuan,resource.pledgeConfirmedYuan-pledged)}` };
  }
  if (!singleDay(state) && isExchangeRepo(plan.businessType) && windowStatus(state.marketClock, { mode: 'send' }).result !== 'open')
    return { stepId: item.stepId, ready: false, reason: `交易所回购当前不在可申报窗口：${plan.label}（${plan.repoTerms?.market ?? '市场未知'}），${state.marketClock?.time ?? '时间未知'}；${windowStatus(state.marketClock,{mode:'send'}).reason}` };
  if (plan.direction === 'outflow' && plan.settlementDate <= state.context.businessDate &&
      (available - item.nominalYuan - state.inputs.feeYuan < state.inputs.bufferYuan ||
        summary(state).dateBalances.some(x => x.valueDate > state.context.businessDate &&
          (x.availableYuan === null || x.availableYuan - item.nominalYuan - state.inputs.feeYuan < state.inputs.bufferYuan))))
    {
      const base = available - state.inputs.feeYuan, baseFails =
        base - state.inputs.bufferYuan < item.nominalYuan;
      const future = summary(state).dateBalances.find(x =>
        x.valueDate > state.context.businessDate &&
        (x.availableYuan === null || x.availableYuan - item.nominalYuan - state.inputs.feeYuan < state.inputs.bufferYuan));
      const actual = baseFails ? base :
        future?.availableYuan === null ? null : future?.availableYuan - state.inputs.feeYuan;
      return { stepId: item.stepId, ready: false, reason: `最新可用资金不足：${plan.label}（${baseFails ? state.context.businessDate : future?.valueDate ?? state.context.businessDate}），需支付${yi(item.nominalYuan)}、保留缓冲${yi(state.inputs.bufferYuan)}；${amountDetail(BigInt(item.nominalYuan) + BigInt(state.inputs.bufferYuan),actual)}` };
    }
  if (plan.direction === 'outflow' && plan.settlementDate > state.context.businessDate) {
    const balances = summary(state).dateBalances;
    const base = balances.filter(x => x.valueDate <= plan.settlementDate).at(-1)?.availableYuan ?? null;
    if (base === null || base - item.nominalYuan - state.inputs.feeYuan < state.inputs.bufferYuan ||
      balances.some(x => x.valueDate > plan.settlementDate &&
        (x.availableYuan === null || x.availableYuan - item.nominalYuan - state.inputs.feeYuan < state.inputs.bufferYuan)))
      {
        const future = balances.find(x => x.valueDate > plan.settlementDate &&
          (x.availableYuan === null || x.availableYuan - item.nominalYuan - state.inputs.feeYuan < state.inputs.bufferYuan));
        const baseFails = base === null || base - item.nominalYuan - state.inputs.feeYuan < state.inputs.bufferYuan;
        const actual = baseFails ? base : future?.availableYuan ?? null;
        return { stepId: item.stepId, ready: false, reason: `交收日及后续日期确认资金不足：${plan.label}（${baseFails ? plan.settlementDate : future?.valueDate ?? plan.settlementDate}），需支付${yi(item.nominalYuan)}、费用${yi(state.inputs.feeYuan)}、缓冲${yi(state.inputs.bufferYuan)}；${amountDetail(BigInt(item.nominalYuan) + BigInt(state.inputs.feeYuan) + BigInt(state.inputs.bufferYuan),actual)}` };
      }
  }
  for (const original of item.machineConditions ?? []) {
    if (original.kind === 'quota_confirmed') continue; // Legacy approval condition; no longer a business limit.
    const amountDependent = ['pledge_confirmed','holding_confirmed','cash_available','settlement_capacity'];
    const c = item.nominalYuan !== calculatedStep.nominalYuan && original.planId === item.planId &&
      amountDependent.includes(original.kind) && Number.isSafeInteger(original.minimumYuan)
      ? { ...original, minimumYuan: Math.max(0, safeAdd(original.minimumYuan, item.nominalYuan - calculatedStep.nominalYuan)) }
      : original;
    if (c.kind === 'pledge_confirmed') {
      if (singleDay(state)) continue;
      const used = summary(state).pledgeUsedByMarket[c.market];
      if (state.repoResources[c.market]?.pledgeConfirmedYuan === null || state.repoResources[c.market]?.pledgeConfirmedYuan === undefined)
        return { stepId: item.stepId, ready: false, reason: `融资资格资源未知：${plan.label}（${c.market ?? '市场未知'}），已确认质押券金额未知，本条件最低${yi(c.minimumYuan)}` };
      if (state.repoResources[c.market].pledgeConfirmedYuan - used < c.minimumYuan)
        return { stepId: item.stepId, ready: false, reason: `融资资格资源不足：${plan.label}（${c.market}）已确认剩余质押能力，${amountDetail(c.minimumYuan,state.repoResources[c.market].pledgeConfirmedYuan-used)}` };
    }
    if (!singleDay(state) && c.kind === 'exchange_window_open' && windowStatus(state.marketClock, { mode: 'send' }).result !== 'open')
      return { stepId: item.stepId, ready: false, reason: `交易所正回购当前不在可申报窗口：${plan.label}（${c.market ?? plan.repoTerms?.market ?? '市场未知'}），${state.marketClock?.time ?? '时间未知'}；${windowStatus(state.marketClock,{mode:'send'}).reason}` };
    if (c.kind === 'funds_available') {
      const source = state.plans.find(p => p.planId === c.planId);
      const inflowFill = singleDay(state) && source &&
        (isFinancing(source.businessType) || isSecuritySale(source.businessType));
      const credited = inflowFill ? summary(state).planBalances.find(b => b.planId === c.planId)?.filledYuan ?? 0 :
        Object.values(state.execution.cashFlows).filter(f => f.type === 'cash_available' &&
          state.execution.instructions[f.instructionId]?.planId === c.planId).reduce((n, f) => safeAdd(n, f.amountYuan), 0);
      if (credited < c.minimumYuan) {
        const name = inflowFill ? '前序成交条件' : '前序到账条件';
        const basis = inflowFill ? '累计成交' : '累计到账可用';
        return { stepId:item.stepId,ready:false,ruleId:'EXEC-FUNDS-AVAILABLE',name,
          blockingCondition:{...c,actualYuan:credited,shortfallYuan:c.minimumYuan-credited,basis:inflowFill?'fill':'cash_available'},
          reason:`${name}：${source?.label ?? c.planId}须${basis}至少${yi(c.minimumYuan)}，当前${yi(credited)}，尚差${yi(c.minimumYuan-credited)}；这是当前计算方案的执行前提` };
      }
    }
    if (c.kind === 'cash_available' && available < c.minimumYuan) return { stepId: item.stepId, ready: false,
      reason: `条件资金尚未可用：${plan.label}，${amountDetail(c.minimumYuan,available)}` };
    if (c.kind === 'settlement_capacity') {
      const balances = summary(state).dateBalances;
      const base = balances.filter(x => x.valueDate <= c.valueDate).at(-1)?.availableYuan ?? null;
      if (base === null || base < c.minimumYuan || balances.some(x => x.valueDate > c.valueDate &&
        (x.availableYuan === null || x.availableYuan < c.minimumYuan)))
        {
          const future = balances.find(x => x.valueDate > c.valueDate &&
            (x.availableYuan === null || x.availableYuan < c.minimumYuan));
          const baseFails = base === null || base < c.minimumYuan;
          const actual = baseFails ? base : future?.availableYuan ?? null;
          return { stepId: item.stepId, ready: false, reason: `交收日资金容量不足：${plan.label}（${baseFails ? c.valueDate : future?.valueDate ?? c.valueDate}），${amountDetail(c.minimumYuan,actual)}` };
        }
    }
    if (c.kind === 'filled') {
      const filled = summary(state).planBalances.find(b => b.planId === c.planId)?.filledYuan ?? 0;
      if (filled < c.minimumYuan) {
        const source = state.plans.find(p => p.planId === c.planId);
        return { stepId:item.stepId,ready:false,ruleId:'EXEC-FILLED',name:'前置成交条件',
          blockingCondition:{...c,actualYuan:filled,shortfallYuan:c.minimumYuan-filled},
          reason:`前置成交条件：${source?.label ?? c.planId}须累计成交至少${yi(c.minimumYuan)}，当前${yi(filled)}，尚差${yi(c.minimumYuan-filled)}` };
      }
    }
    if (c.kind === 'payable_cleared' && Object.values(state.execution.instructions).some(i => i.planId === c.planId && i.filledYuan > i.settledYuan)) {
      const source = state.plans.find(p => p.planId === c.planId);
      const unpaid = Object.values(state.execution.instructions).filter(i => i.planId === c.planId)
        .reduce((n,i) => safeAdd(n,Math.max(0,i.filledYuan-i.settledYuan)),0);
      return { stepId: item.stepId, ready: false, reason: `前置应付未结清：${source?.label ?? c.planId}，未结清${yi(unpaid)}` };
    }
    if (c.kind === 'previous_confirmed') {
      const priorStep = state.approval.proposalCopy.steps.find(x => x.stepId === c.stepId);
      const prior = Object.values(state.execution.instructions).find(i => i.stepId === c.stepId);
      if (!prior || prior.filledYuan < (priorStep?.nominalYuan ?? prior.nominalYuan))
        {
          const source = state.plans.find(p => p.planId === priorStep?.planId);
          return { stepId: item.stepId, ready: false, reason: `前置指令尚未完成成交：${source?.label ?? c.stepId}（${c.stepId}），${amountDetail(priorStep?.nominalYuan ?? prior?.nominalYuan ?? null,prior?.filledYuan ?? null)}` };
        }
    }
    if (c.kind === 'sale_cash_available') {
      const sale = state.plans.find(p => p.planId === c.planId);
      const credited = Object.values(state.execution.cashFlows).filter(f => f.type === 'cash_available' && state.execution.instructions[f.instructionId]?.planId === c.planId)
        .reduce((n, f) => safeAdd(n, f.amountYuan), 0);
      if (!sale || credited < sale.targetYuan) return { stepId: item.stepId, ready: false,
        reason: `卖券回款尚未全额可用：${sale?.label ?? c.planId}，${sale ? amountDetail(sale.targetYuan,credited) : '源交易不存在，最低金额未知'}` };
    }
    if (c.kind === 'holding_confirmed') {
      const sale = state.plans.find(p => p.planId === c.planId);
      if (!sale || !saleHoldingReady(state,sale,item.nominalYuan))
        return { stepId: item.stepId, ready: false, reason: `持仓可卖量未核实：${sale?.label ?? c.planId}（${sale?.securityId ?? '证券代码未知'}），本次${yi(item.nominalYuan)}；可卖量或匹配关系须核实` };
    }
    if (!['pledge_confirmed','exchange_window_open','funds_available','cash_available',
      'settlement_capacity','filled','payable_cleared','previous_confirmed',
      'sale_cash_available','holding_confirmed'].includes(c.kind)) {
      const source = state.plans.find(p => p.planId === c.planId);
      return { stepId: item.stepId, ready: false, reason: `未知执行前置条件（${c.kind ?? '类型缺失'}）：${plan.label}关联${source?.label ?? c.planId ?? c.stepId ?? '来源未知'}，无法确认已满足，须重新计算并核实条件` };
    }
  }
  return { stepId: item.stepId, ready: true, reason: '最新本地校验通过' };
}
// Preview the approved order against a private ledger. A simulated receipt reserves each
// ready step for the next check; neither the actual execution facts nor IDs are touched.
export function deriveBatchReadiness(state) {
  const virtual = clone(state), rows = [];
  for (const step of state.proposal?.steps ?? []) {
    const gate = readiness(virtual, step);
    if (!gate.ready) { rows.push(gate); continue; }
    try {
      const plan = virtual.plans.find(p => p.planId === step.planId);
      const sent = registerSend(virtual.execution, step, plan, virtual.approval.approvalId, virtual.marketClock);
      virtual.execution = applyEvent(sent.execution, {
        eventId: `PREVIEW-${rows.length + 1}`, sourceSequence: sent.execution.sourceSequence + 1,
        type: 'accepted', instructionId: sent.instructionId,
      }).execution;
      rows.push(gate);
    } catch (error) {
      rows.push({ stepId: step.stepId, ready: false, reason: `批次预览无法保留本笔资源：${error.message}` });
    }
  }
  return rows;
}
function summary(state) {
  if (state.progressId === 'initial') {
    const result = executionSummary(state.execution, state.plans, { businessDate: state.context.businessDate });
    const adjustment = {};
    const apply = (bankId, amount) => {
      if (bankId === null || amount === null) return;
      const n = (adjustment[bankId] ?? 0) + amount;
      if (!Number.isSafeInteger(n)) throw new Error('银行敞口调整超出安全整数范围');
      adjustment[bankId] = n;
    };
    for (const trade of state.initialData.pendingSettlements) if (!trade.holdingIncludedAtOpen) {
      const bankId = trade.issuerId ?? state.initialData.securities.find(s => s.securityId === trade.securityId)?.issuerBankId ?? null;
      apply(bankId, trade.direction === 'outflow' ? trade.amountYuan : -trade.amountYuan);
    }
    for (const instruction of Object.values(state.execution.instructions)) {
      const plan = state.plans.find(p => p.planId === instruction.planId);
      if (!plan) continue;
      const bankId = bankIdForPlan(plan, state.initialData);
      const remaining = instruction.status === 'rejected' ? 0 :
        instruction.nominalYuan - instruction.filledYuan - instruction.cancelledYuan;
      apply(bankId, plan.direction === 'outflow' ? instruction.filledYuan + remaining : -instruction.filledYuan);
    }
    let projected = result.availableYuan;
    let unconfirmedInflowYuan = 0, unconfirmedOutflowYuan = 0, confirmedInflowYuan = 0;
    if (projected !== null) {
      for (const p of state.plans) if (singleDay(state) || p.settlementDate === state.context.businessDate) {
        const b = result.planBalances.find(x => x.planId === p.planId);
        if (p.direction === 'outflow') {
          projected = safeAdd(projected, -b.arrangeableYuan);
          unconfirmedOutflowYuan = safeAdd(unconfirmedOutflowYuan, b.arrangeableYuan);
        } else {
          const credited = Object.values(state.execution.cashFlows).filter(f => f.type === 'cash_available' &&
            state.execution.instructions[f.instructionId]?.planId === p.planId)
            .reduce((n, f) => safeAdd(n, f.amountYuan), 0);
          const included = singleDay(state) && (isFinancing(p.businessType) || isSecuritySale(p.businessType)) ?
            b.filledYuan : credited;
          projected = safeAdd(projected, p.targetYuan - included);
          const completed = Math.min(b.filledYuan - included, p.targetYuan - included);
          confirmedInflowYuan = safeAdd(confirmedInflowYuan, completed);
          unconfirmedInflowYuan = safeAdd(unconfirmedInflowYuan, p.targetYuan - included - completed);
        }
      }
      for (const f of state.initialData.pendingSettlements) if (f.direction === 'inflow' &&
        f.settlementDate === state.context.businessDate && !f.cashIncludedAtOpen) {
        const settled = Object.values(state.execution.cashEventReceipts).filter(r => r.sourceId === f.tradeId)
          .reduce((n, r) => safeAdd(n, r.amountYuan), 0);
        if (f.amountYuan === null) { projected = null; break; }
        projected = safeAdd(projected, f.amountYuan - settled);
        confirmedInflowYuan = safeAdd(confirmedInflowYuan, f.amountYuan - settled);
      }
    }
    const exposureBase = deriveTemplateExposure(state.initialData);
    return { ...result, exposureAdjustmentsByBankYuan: adjustment,
      cashRatioBasis: { businessCashYuan: result.availableYuan,
        governmentBondWithinYearYuan: exposureBase.governmentBondWithinYearYuan,
        navYuan: state.inputs.navYuan },
      projectedEndOfDayYuan: { balanceYuan: projected, unconfirmedInflowYuan,
        unconfirmedOutflowYuan, confirmedInflowYuan,
        assumption: 'today_plans_complete_and_cash_settles' } };
  }
  const cash = state.progress.cash;
  const reserved = safeAdd(safeAdd(cash.localReservedYuan, cash.platformReservedYuan), cash.payableReservedYuan);
  const availableYuan = cash.settledBalanceYuan === null ? null : cash.settledBalanceYuan - reserved;
  if (availableYuan !== null && !Number.isSafeInteger(availableYuan)) throw new Error('可用资金超出安全整数范围');
  const planBalances = state.plans.map(p => {
    const [filledYuan, lockedYuan] = state.progress.ledger[p.planId] ?? [0, 0];
    const remainingYuan = p.targetYuan - filledYuan;
    const arrangeableYuan = remainingYuan - lockedYuan;
    return { planId: p.planId, targetYuan: p.targetYuan, filledYuan, lockedYuan, arrangeableYuan, remainingYuan };
  });
  return { ...cash, accountCashYuan: cash.settledBalanceYuan, openingBusinessAvailableYuan: cash.settledBalanceYuan,
    unreceivedMaturityYuan: 0, futureCashEvents: [], settlementRows: [], dateBalances: [],
    openingTradeBalances: [],
    exposureAdjustmentsByBankYuan: {},
    cashRatioBasis: { businessCashYuan: availableYuan, governmentBondWithinYearYuan: null,
      navYuan: state.inputs.navYuan },
    projectedEndOfDayYuan: { balanceYuan: null, unconfirmedInflowYuan: 0,
      unconfirmedOutflowYuan: 0, confirmedInflowYuan: 0, assumption: 'historical_progress' },
    availableYuan, planBalances, quality: state.progress.quality };
}
const exactKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  same(Object.keys(obj).sort(), [...keys].sort());
const coreKeys = ['uiVersion','contractMapping','scenarioId','context','revision','rulesVersion','seedTouched','nextPlanId','nextProposalId','nextApprovalId','plans','inputs','ruleConfig','preferences','repoResources','repoResourcesVersion','marketClock','proposal','calculation','approval','progressId','progress','execution','initialData'];
function normalizeSaved(data) {
  const s = clone(typeof data === 'string' ? JSON.parse(data) : data);
  if (s?.uiVersion === 'simulation-ui-1' && s?.contractMapping === 'simulation-execution-1') {
    const oldKeys = coreKeys.filter(k => !['repoResources','repoResourcesVersion','marketClock','initialData'].includes(k));
    if (!exactKeys(s, oldKeys) || s.execution?.version !== 'simulation-execution-1' || !Array.isArray(s.plans) ||
      s.plans.some(p => !['reverse_repo','deposit','cd_buy','bond_buy','cd_sell'].includes(p.businessType)))
      throw new Error('旧版存档结构不完整，不能安全迁移');
    s.uiVersion = 'simulation-ui-2'; s.contractMapping = 'simulation-execution-2';
    s.repoResources = emptyRepoResources(); s.repoResourcesVersion = 1;
    s.marketClock = { time: '09:30:00', isTradingDay: true, timezone: 'Asia/Shanghai' };
    for (const plan of s.plans) plan.repoTerms = null;
    const byId = new Map(s.plans.map(p => [p.planId,p]));
    const adaptInstruction = i => {
      const plan = byId.get(i.planId);
      if (!plan) throw new Error('旧版指令计划引用缺失');
      i.businessType = plan.businessType; i.repoMarket = null; i.repoTerms = null;
      i.sentTime = null; i.sentTradingDay = null;
    };
    for (const i of Object.values(s.execution.instructions ?? {})) adaptInstruction(i);
    for (const entry of s.execution.journal ?? []) if (entry.kind === 'send') adaptInstruction(entry.instruction);
    s.execution.version = 'simulation-execution-2';
  }
  if (s?.uiVersion !== 'simulation-ui-2' || s?.contractMapping !== 'simulation-execution-2') return s;
  const oldKeys = coreKeys.filter(k => k !== 'initialData');
  if (!exactKeys(s, oldKeys) || s.execution?.version !== 'simulation-execution-2')
    throw new Error('UI2存档结构不完整，不能安全迁移');
  s.initialData = legacyInitialTemplate(s);
  s.uiVersion = UI_VERSION; s.contractMapping = CONTRACT_MAPPING;
  const businessDate = s.context.businessDate;
  for (const p of s.plans) {
    p.tradeDate = businessDate; p.settlementDate = businessDate; p.securityId = null;
    p.marketTier = ['cd_buy','cd_sell','bond_buy','bond_sell'].includes(p.businessType) ? 'secondary' : null;
  }
  const adaptDates = i => {
    const plan = s.plans.find(p => p.planId === i.planId);
    if (!plan) throw new Error('旧版指令计划引用缺失');
    i.tradeDate = businessDate; i.settlementDate = businessDate;
    i.securityId = null; i.marketTier = plan.marketTier;
  };
  for (const i of Object.values(s.execution.instructions ?? {})) adaptDates(i);
  for (const entry of s.execution.journal ?? []) if (entry.kind === 'send') adaptDates(entry.instruction);
  s.execution.version = CONTRACT_MAPPING;
  s.execution.openingFacts = []; s.execution.cashEventReceipts = {};
  s.execution.requiresRefresh = true; s.execution.requiresReapproval = true;
  return s;
}
function validateSavedV2(data) {
  const errors = [];
  try {
    const s = typeof data === 'string' ? JSON.parse(data) : data;
    if (!exactKeys(s, coreKeys)) throw new Error('存档字段不完整或含未知字段');
    if (s.uiVersion !== UI_VERSION || s.contractMapping !== CONTRACT_MAPPING) throw new Error('UI存档或映射版本不兼容');
    if (!seedPlans[s.scenarioId] || s.rulesVersion !== RULES_VERSION) throw new Error('场景或规则版本不兼容');
    if (typeof s.seedTouched !== 'boolean' || (!s.seedTouched &&
      (!same(planSignature(s.plans), planSignature(seeds(s.scenarioId))) || !same(s.inputs, seedInputs(s.scenarioId)) ||
        !same(s.ruleConfig, seedRuleConfig()) || s.nextPlanId !== 1))) throw new Error('种子来源标记与计划、输入或规则不一致');
    const initialData = normalizeInitialTemplate(s.initialData);
    if (!same(initialData, s.initialData)) throw new Error('运行初始数据不规范');
    if (initialData.provenance.kind === 'legacy' &&
      (initialData.templateId !== `LEGACY-${s.scenarioId}` || initialData.termWeights != null ||
        ['securities','holdings','otherFundBankExposure','maturityCashEvents','pendingSettlements']
          .some(key => initialData[key].length !== 0) ||
        initialData.banks.some(bank => bank.custodyQualified !== null || bank.rating !== null ||
          bank.ratingAsOf !== null || bank.quarterlyNetAssetsYuan !== null || bank.quarterEnd !== null)))
      throw new Error('历史场景来源不能包含新模板证券、持仓、现金事件或核心规则输入');
    if (!exactKeys(s.context, ['scenarioId','runId','portfolioId','businessDate']) || s.context.scenarioId !== s.scenarioId ||
      typeof s.context.runId !== 'string' || !s.context.runId.startsWith(`${s.scenarioId}-ui-`) ||
      s.context.portfolioId !== initialData.portfolio.portfolioId ||
      s.context.businessDate !== initialData.businessDate) throw new Error('运行域不匹配');
    for (const key of ['revision','nextPlanId','nextProposalId','nextApprovalId']) money(s[key], key, key !== 'revision');
    for (const key of ['nextPlanId','nextProposalId','nextApprovalId']) {
      if (s[key] > s.revision + 1) throw new Error('存档计数器超出已记录修订');
    }
    if (!Array.isArray(s.plans)) throw new Error('计划集合无效');
    if (!exactKeys(s.inputs, ['initialCashYuan','navYuan','bankExposureYuan','feeYuan','bufferYuan'])) throw new Error('输入字段无效');
    for (const key of ['initialCashYuan','navYuan','bankExposureYuan','feeYuan','bufferYuan']) {
      if (s.inputs[key] !== null) money(s.inputs[key], key, key === 'navYuan');
    }
    if (!exactKeys(s.ruleConfig, ['version','depositThreshold','observationThreshold']) ||
      !decimalRatio(s.ruleConfig.depositThreshold) || !decimalRatio(s.ruleConfig.observationThreshold)) throw new Error('规则阈值必须为(0,1]内精确十进制字符串');
    money(s.ruleConfig.version, '规则配置版本', true);
    if (s.ruleConfig.version > s.revision + 1) throw new Error('规则配置版本超出运行修订');
    if (s.ruleConfig.version === 1 && !same(s.ruleConfig, seedRuleConfig())) throw new Error('已修改规则缺少新配置版本');
    const ids = new Set();
    const totals = { inflow: 0, outflow: 0 };
    for (const p of s.plans) {
      if (!exactKeys(p, ['planId','label','businessType','direction','counterpartyId','issuerId','targetYuan','termsNote',
        'repoTerms','tradeDate','settlementDate','securityId','marketTier','version'])) throw new Error('计划字段无效');
      if (typeof p.planId !== 'string' || !p.planId || ids.has(p.planId) || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 80 ||
        !Object.hasOwn(BUSINESS_DIRECTIONS, p.businessType) || p.direction !== BUSINESS_DIRECTIONS[p.businessType] ||
        !repoTermsValid(p, singleDay(s)) ||
        (singleDay(s) && p.repoTerms !== null && p.repoTerms.annualRate !== null) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(p.tradeDate) || !/^\d{4}-\d{2}-\d{2}$/.test(p.settlementDate) ||
        p.tradeDate !== s.context.businessDate || p.settlementDate < p.tradeDate ||
        (singleDay(s) && p.settlementDate !== s.context.businessDate) ||
        (p.securityId !== null && (typeof p.securityId !== 'string' || !initialData.securities.some(s => s.securityId === p.securityId))) ||
        ![null,'secondary'].includes(p.marketTier) ||
        (p.counterpartyId !== null && (typeof p.counterpartyId !== 'string' || p.counterpartyId.length > 80)) ||
        (p.issuerId !== null && (typeof p.issuerId !== 'string' || p.issuerId.length > 80)) ||
        typeof p.termsNote !== 'string' || p.termsNote.length > 500) throw new Error('计划类型、方向、对象或文字长度无效');
      const security = p.securityId === null ? null : initialData.securities.find(x => x.securityId === p.securityId);
      if (security) {
        validatePlanSecurity(p, initialData);
        if (p.issuerId !== security.issuerBankId)
          throw new Error('运行计划发行人须与来源证券一致');
      }
      ids.add(p.planId); money(p.targetYuan, '计划意向金额', true); money(p.version, '计划版本', true);
      if (p.targetYuan % unitFor(p.businessType) !== 0 && (isFinancing(p.businessType) || isExchangeRepo(p.businessType)))
        throw new Error('回购计划金额须符合业务单位');
      totals[p.direction] = safeAdd(totals[p.direction], p.targetYuan);
      if (!seedPlans[s.scenarioId].some(seed => seed[0] === p.planId) &&
        numberedId(p.planId, `${s.context.runId}-P-`) >= s.nextPlanId) throw new Error('计划计数器未超过已用ID');
    }
    if (!exactKeys(s.preferences, ['version','orderedKeys']) || !Array.isArray(s.preferences.orderedKeys)) throw new Error('偏好结构无效');
    money(s.preferences.version, '偏好版本', true);
    if (new Set(s.preferences.orderedKeys).size !== s.preferences.orderedKeys.length ||
      s.preferences.orderedKeys.some(k => !PREF_KEYS.includes(k)) ||
      ['reverse_repo_first','liquidity_last'].every(k => s.preferences.orderedKeys.includes(k)))
      throw new Error('偏好键重复、未知或业务偏好冲突');
    money(s.repoResourcesVersion, '融资资源版本', true);
    if (!exactKeys(s.repoResources, REPO_MARKETS)) throw new Error('融资共享资源字段无效');
    for (const market of REPO_MARKETS) {
      const resource = s.repoResources[market];
      if (!exactKeys(resource, ['quotaConfirmedYuan','pledgeConfirmedYuan'])) throw new Error('融资资源字段无效');
      for (const value of Object.values(resource)) if (value !== null) money(value, '融资确认资源');
    }
    if (!exactKeys(s.marketClock, ['time','isTradingDay','timezone']) || s.marketClock.timezone !== 'Asia/Shanghai' ||
      typeof s.marketClock.isTradingDay !== 'boolean' || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(s.marketClock.time)) throw new Error('业务时钟无效');
    if (!progressCatalog[s.scenarioId][s.progressId] || !same(s.progress, progressFor(s.scenarioId, s.progressId, s.inputs))) throw new Error('历史场景进度快照不完整或金额被改写');
    validateExecution(s.execution, s.plans);
    if (s.execution.initialCashYuan !== openingAccountCash(initialData) ||
      (singleDay(s) && s.execution.demoMode !== initialData.demoMode) ||
      (!singleDay(s) && s.execution.demoMode !== undefined))
      throw new Error('执行初始现金与输入不符');
    if (s.inputs.initialCashYuan !== initialData.portfolio.accountCashYuan ||
      s.inputs.navYuan !== initialData.portfolio.navYuan ||
      s.inputs.bankExposureYuan !== initialData.portfolio.legacyBankExposureYuan ||
      s.inputs.feeYuan !== initialData.portfolio.feeYuan ||
      s.inputs.bufferYuan !== initialData.portfolio.bufferYuan ||
      !same(s.execution.openingFacts, [...initialData.maturityCashEvents, ...initialData.pendingSettlements]))
      throw new Error('运行初始数据与账本起点不一致');
    if (s.progressId !== 'initial' && s.execution.journal.length) throw new Error('历史进度与执行事件不可混用');
    if (s.progressId !== 'initial') {
      for (const planId of Object.keys(s.progress.ledger)) {
        const current = s.plans.find(p => p.planId === planId);
        const original = seeds(s.scenarioId).find(p => p.planId === planId);
        if (!current || !original || ['businessType','direction','counterpartyId','issuerId'].some(k => current[k] !== original[k]))
          throw new Error('在途事实引用的计划或交易对象不匹配');
      }
    }
    for (const b of summary(s).planBalances) {
      if (b.arrangeableYuan < 0 || safeAdd(safeAdd(b.filledYuan, b.lockedYuan), b.arrangeableYuan) !== b.targetYuan ||
        safeAdd(b.lockedYuan, b.arrangeableYuan) !== b.remainingYuan) throw new Error('计划名义金额不守恒');
    }
    if (s.proposal !== null) {
      if (!Object.keys(s.proposal).every(k => ['proposalId','version','pathId','origin','status','peakShortfallYuan','conflicts','message','steps','groups','blockers','planCoverage','unfinishedYuan','unarrangedYuan'].includes(k)) ||
        !['proposalId','version','pathId','origin','status','peakShortfallYuan','conflicts','message','steps'].every(k => Object.hasOwn(s.proposal,k)) ||
        !Array.isArray(s.proposal.steps) || !Array.isArray(s.proposal.conflicts)) throw new Error('建议字段无效');
      if (s.proposal.groups !== undefined && (!Array.isArray(s.proposal.groups) || s.proposal.groups.some(g =>
        !Array.isArray(g.stepIds) || g.stepIds.some(id => !s.proposal.steps.some(step => step.stepId === id)))))
        throw new Error('建议批次引用无效');
      if (s.proposal.blockers !== undefined && !Array.isArray(s.proposal.blockers)) throw new Error('建议阻断列表无效');
      if (s.proposal.planCoverage !== undefined && !Array.isArray(s.proposal.planCoverage)) throw new Error('计划覆盖数据无效');
      for (const key of ['unfinishedYuan','unarrangedYuan']) if (s.proposal[key] !== undefined) money(s.proposal[key], key);
      const proposalNumber = numberedId(s.proposal.proposalId, `${s.context.runId}-PROP-`);
      if (proposalNumber >= s.nextProposalId || s.proposal.version !== proposalNumber) throw new Error('建议计数器或版本不匹配');
      money(s.proposal.version, '建议版本', true);
      if (!s.calculation || typeof s.calculation.trace !== 'object' || !Array.isArray(s.calculation.candidates)) throw new Error('建议计算追踪缺失');
      for (const step of s.proposal.steps) {
        if (!s.plans.some(p => p.planId === step.planId) || !Number.isSafeInteger(step.nominalYuan) || step.nominalYuan <= 0 ||
          !Array.isArray(step.machineConditions)) throw new Error('建议步骤引用或金额无效');
      }
    } else if (s.calculation !== null) throw new Error('无建议时不能保留计算追踪');
    if (s.approval !== null) {
      const a = s.approval;
      if (!Object.keys(a).every(key => ['approvalId','proposalId','proposalVersion','proposalCopy','planVersions','preferencesVersion','rulesVersion','ruleConfigVersion','authoritySource'].includes(key)) ||
        !['approvalId','proposalId','proposalVersion','proposalCopy','planVersions','preferencesVersion','rulesVersion','ruleConfigVersion'].every(key => Object.hasOwn(a,key)) ||
        (a.authoritySource !== undefined && a.authoritySource !== 'calculated_skip_review') ||
        !Array.isArray(a.planVersions) || !Array.isArray(a.proposalCopy?.steps)) throw new Error('审核副本字段或运行域无效');
      if (numberedId(a.approvalId, `${s.context.runId}-AP-`) >= s.nextApprovalId ||
        numberedId(a.proposalId, `${s.context.runId}-PROP-`) >= s.nextProposalId) throw new Error('审核计数器未超过已用ID');
      money(a.proposalVersion, '审核建议版本', true); money(a.preferencesVersion, '审核偏好版本', true);
      money(a.ruleConfigVersion, '审核规则配置版本', true);
      if (a.preferencesVersion > s.preferences.version) throw new Error('审核偏好版本晚于当前版本');
      if (a.ruleConfigVersion > s.ruleConfig.version) throw new Error('审核规则配置版本晚于当前版本');
      if (a.rulesVersion !== RULES_VERSION || a.proposalId !== a.proposalCopy.proposalId || a.proposalVersion !== a.proposalCopy.version ||
        (a.authoritySource === 'calculated_skip_review'
          ? a.proposalCopy.origin !== 'calculated' || !a.proposalCopy.steps.length
          : !eligibleApprovalSteps({ ...s, proposal: a.proposalCopy, calculation: null,
              execution: { requiresReapproval: false, pending: {} } }).length))
        throw new Error('审核副本引用无效');
      if (numberedId(a.proposalCopy.proposalId, `${s.context.runId}-PROP-`) !== a.proposalCopy.version ||
        !a.planVersions.every(([id, version]) => s.plans.some(p => p.planId === id && p.version >= version))) throw new Error('历史审核副本引用无效');
      // A stale approval remains visible for audit, but cannot become valid through load.
      if (approvalStatus(s) === 'valid' && !same(a.proposalCopy, s.proposal)) throw new Error('有效审核副本不匹配');
    }
  } catch (e) { errors.push(e.message); }
  return { ok: errors.length === 0, errors };
}
export function validateSaved(data) {
  try { return validateSavedV2(normalizeSaved(data)); }
  catch (e) { return { ok: false, errors: [e.message] }; }
}
export function deriveDispatchGroups(state, batchRows = deriveBatchReadiness(state)) {
  const byStep = new Map(batchRows.map(row => [row.stepId, row]));
  const used = new Set();
  const proposalGroups = (state.proposal?.groups ?? []).map((group, index) => ({
    groupId: group.groupId ?? `批次${index + 1}`,
    stepIds: group.stepIds.filter(id => byStep.has(id)),
  }));
  const groups = [];
  const appendGroup = (groupId, stepIds) => {
    const segments = [];
    for (const id of stepIds) {
      const row = byStep.get(id), last = segments.at(-1);
      if (row.ready && last?.status === 'ready') last.stepIds.push(id);
      else segments.push({ status: row.ready ? 'ready' : 'blocked', stepIds: [id], reason: row.reason });
    }
    for (const [index, segment] of segments.entries()) groups.push({
      groupId: segments.length === 1 ? groupId : `${groupId}-${index + 1}`,
      stepIds: segment.stepIds,
      nominalYuan: segment.stepIds.reduce((n,id) => safeAdd(n,state.proposal.steps.find(step => step.stepId === id).nominalYuan),0),
      status: segment.status,
      reason: segment.status === 'ready' ? '本批次按顺序累计校验可下达' : segment.reason,
    });
  };
  for (const group of proposalGroups) {
    const stepIds = group.stepIds.filter(id => !used.has(id));
    if (!stepIds.length) continue;
    stepIds.forEach(id => used.add(id));
    appendGroup(group.groupId,stepIds);
  }
  const ungrouped = (state.proposal?.steps ?? []).filter(step => !used.has(step.stepId));
  if (ungrouped.length) appendGroup('当前可下达',ungrouped.map(step => step.stepId));
  return groups;
}
// Categories are a view of one calculated sequence. A private cumulative send
// preview decides whether steps can be sent together; it never searches or sorts.
export function deriveAdvancementGroups(state) {
  const result = { priority:[], synchronous:[], restricted:[], pending:[] };
  const steps = state.proposal?.steps ?? [];
  const pendingByPlan = new Set(steps.map(step => step.planId));
  const unresolved = state.progressId !== 'initial' || Object.keys(state.execution.pending).length > 0;
  const stale = state.execution.requiresRefresh || state.execution.snapshot.quality !== 'fresh' ||
    Date.now() - state.execution.snapshot.observedAt > 30000 || state.execution.requiresReapproval;
  let batchRows = [];
  if (steps.length && !unresolved) {
    const preview = clone(state);
    // The board describes business compatibility of the calculated order. A
    // timed-out observation still needs refresh before a real send.
    preview.execution.requiresRefresh = false;
    preview.execution.requiresReapproval = false;
    preview.execution.snapshot = { ...preview.execution.snapshot,quality:'fresh',observedAt:Date.now() };
    if (approvalStatus(preview) !== 'valid' || !manualApproval(preview))
      preview.approval = executionAuthorization(preview,'manual_review');
    batchRows = deriveBatchReadiness(preview);
  }
  const rows = new Map(batchRows.map(row => [row.stepId,row]));
  const preference = state.preferences?.orderedKeys ?? [];
  let readyIndex = 0;
  for (const step of steps) {
    const trace = state.calculation?.trace?.steps?.find(row => row.stepId === step.stepId);
    const businessBlock = step.blocked || trace?.rules?.some(rule =>
      ['block','missing','closed'].includes(rule.result));
    const row = rows.get(step.stepId);
    const details = { ...step, reason:row?.reason ?? null };
    if (businessBlock || (!unresolved && !row?.ready && row?.reason !== '指令包尚未有效人工审核')) {
      const blockingRule = trace?.rules?.find(rule => ['block','missing','closed'].includes(rule.result));
      result.restricted.push({ ...details,status:'restricted',
        reason:blockingRule?.reason ?
          `计算阻断：${coreRuleDetail(blockingRule)}` :
          row?.reason ?? '该步骤当前业务条件受限' });
      continue;
    }
    if (unresolved) {
      result.pending.push({ ...details,status:'awaiting_refresh',
        reason:'历史场景或回报缺口须先核实' });
      continue;
    }
    const relief = Number.isSafeInteger(trace?.beforeExposureYuan) &&
      Number.isSafeInteger(trace?.afterExposureYuan) &&
      trace.afterExposureYuan < trace.beforeExposureYuan ||
      Number.isSafeInteger(trace?.beforeCashYuan) && Number.isSafeInteger(trace?.afterCashYuan) &&
      trace.afterCashYuan > trace.beforeCashYuan;
    const plan = state.plans.find(item => item.planId === step.planId);
    const managerOrder = readyIndex === 0 && preference.length > 0;
    const preferencePriority = preference.includes('reverse_repo_first') &&
      plan?.businessType === 'reverse_repo';
    const priority = relief || managerOrder || preferencePriority;
    result[priority ? 'priority' : 'synchronous'].push({ ...details,
      status:stale ? 'awaiting_refresh' : manualApproval(state) ?
        (priority?'priority':'synchronous') : 'awaiting_review',
      reason:relief?'该步缓解现金或银行敞口':preferencePriority?'符合经理设置的逆回购优先偏好':
        managerOrder?'已计算排单首位':'与前序可共同下达' });
    readyIndex++;
  }
  for (const plan of state.plans) {
    if (pendingByPlan.has(plan.planId)) continue;
    const balance = summary(state).planBalances.find(row => row.planId === plan.planId);
    if (!balance || balance.arrangeableYuan <= 0) continue;
    const cancelling = Object.values(state.execution.instructions).some(instruction =>
      instruction.planId === plan.planId && instruction.status === 'cancel_pending');
    result.pending.push({planId:plan.planId,label:plan.label,nominalYuan:balance.arrangeableYuan,
      status:cancelling?'cancel_pending':'awaiting_calculation',
      reason:cancelling?'撤改单确认中':'尚未进入本次计算顺序'});
  }
  return result;
}
export function createModel(saved) {
  let state = saved === undefined ? fresh('S13') : null;
  if (saved !== undefined) {
    const checked = validateSaved(saved);
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    state = normalizeSaved(saved);
    state.execution.requiresRefresh = true;
    state.execution.requiresReapproval = true;
  }
  const view = () => {
    const readinessRows = (state.proposal?.steps ?? []).map(step => readiness(state, step));
    const batchRows = deriveBatchReadiness(state);
    const groups = deriveDispatchGroups(state,batchRows);
    const approvalEligibleStepIds = eligibleApprovalSteps(state).map(step => step.stepId);
    return { ...clone(state), approvalStatus: approvalStatus(state),
      canApprove: approvalEligibleStepIds.length > 0, approvalEligibleStepIds,
      approvalReason: Object.keys(state.execution.pending).length ? '回报序号缺失，等待补齐后才能审核' :
        approvalEligibleStepIds.length ? '存在可审核的计算步骤' : '当前没有可审核的计算指令子集',
      progressOptions: Object.entries(progressCatalog[state.scenarioId]).map(([id, p]) => ({ id, label: p.label })),
      summary: summary(state), seedPristine: pristine(state),
      coreRules: evaluateCoreRules({ ...state, summary: summary(state) }),
      stepReadiness: readinessRows, batchReadiness: batchRows, dispatchGroups: groups };
  };
  const commit = next => {
    next.revision = safeAdd(state.revision, 1);
    const checked = validateSaved(next);
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    state = next;
    return view();
  };
  const initialOnly = () => { if (state.progressId !== 'initial' || state.execution.journal.length)
    throw new Error('已有历史进度或执行事实；此项编辑仅可在新建或重置的独立副本进行'); };
  const normalizedPlan = (input, planId, version) => {
    if (!input || typeof input !== 'object') throw new Error('计划输入无效');
    if (singleDay(state) && (input.tradeDate ?? state.context.businessDate) !== state.context.businessDate)
      throw new Error('简化模板新增交易须为当日');
    if (singleDay(state) && (input.settlementDate ?? input.tradeDate ?? state.context.businessDate) !== state.context.businessDate)
      throw new Error('简化模板新增交易只允许当日交收');
    if (singleDay(state) && input.repoTerms?.annualRate != null)
      throw new Error('简化模板回购不计利息，年利率须为空');
    return {
      planId, label: String(input.label ?? '').trim(), businessType: String(input.businessType ?? '').trim(),
      direction: input.direction, counterpartyId: input.counterpartyId ?? null,
      issuerId: input.issuerId ?? state.initialData.securities.find(s => s.securityId === input.securityId)?.issuerBankId ?? null,
      targetYuan: input.targetYuan, termsNote: String(input.termsNote ?? ''), repoTerms: input.repoTerms ?? null,
      tradeDate: input.tradeDate ?? state.context.businessDate,
      settlementDate: input.settlementDate ?? input.tradeDate ?? state.context.businessDate,
      securityId: input.securityId ?? null,
      marketTier: input.marketTier ?? (['cd_buy','cd_sell','bond_buy','bond_sell'].includes(input.businessType) ? 'secondary' : null),
      version,
    };
  };
  const dispatchOne = selected => {
    const gate = readiness(state, selected);
    if (!gate.ready) throw new Error(gate.reason);
    const plan = state.plans.find(p => p.planId === selected.planId);
    const next = clone(state);
    const sent = registerSend(next.execution, selected, plan, state.approval.approvalId, state.marketClock);
    next.execution = sent.execution;
    commit(next);
    return sent.instructionId;
  };
  const customItems = items => {
    if (!Array.isArray(items) || !items.length || items.some(item => !item ||
      Object.keys(item).some(key => !['stepId','nominalYuan'].includes(key)) ||
      typeof item.stepId !== 'string' || !Number.isSafeInteger(item.nominalYuan) || item.nominalYuan <= 0) ||
      new Set(items.map(item => item.stepId)).size !== items.length)
      throw new Error('自定义批次步骤须唯一，本次金额须为正整数元');
    if (!state.proposal || state.proposal.origin !== 'calculated' ||
      items.some(item => !state.proposal.steps.some(step => step.stepId === item.stepId)))
      throw new Error('自定义批次须引用当前计算指令包');
    if (state.proposal.pathId === 'CUSTOM-ORDER') {
      const positions = new Map(state.proposal.steps.map((step,index) => [step.stepId,index]));
      if (items.some((item,index) => item.nominalYuan !== state.proposal.steps[positions.get(item.stepId)].nominalYuan ||
        (index > 0 && positions.get(items[index-1].stepId) >= positions.get(item.stepId))))
        throw new Error('重算后的批次仅可按原顺序减少选择；金额或顺序变化须重新计算');
    }
    return items.map(item => ({ stepId: item.stepId, nominalYuan: item.nominalYuan }));
  };
  const customAuthority = (target, skipReview) => {
    if (!skipReview) {
      if (!manualApproval(target)) throw new Error('发送前须审核当前具体指令包');
      return;
    }
    if (target.progressId !== 'initial' || target.execution.requiresReapproval ||
      Object.keys(target.execution.pending).length || !target.proposal || target.proposal.origin !== 'calculated')
      throw new Error('跳过人工审核须先完成当前计算并补齐回报');
    if (target.execution.requiresRefresh || target.execution.snapshot.quality !== 'fresh' ||
      Date.now() - target.execution.snapshot.observedAt > 30000)
      throw new Error('执行快照过期或恢复后尚未刷新');
    target.approval = executionAuthorization(target, 'calculated_skip_review');
    target.nextApprovalId++;
  };
  const previewCustom = (items, skipReview, assumeFreshSnapshot = false) => {
    const selected = customItems(items);
    if (typeof skipReview !== 'boolean') throw new Error('跳过审核选项无效');
    if (typeof assumeFreshSnapshot !== 'boolean' || (assumeFreshSnapshot && !skipReview))
      throw new Error('只读快照预检选项无效');
    const virtual = clone(state), rows = [];
    if (assumeFreshSnapshot) {
      virtual.execution.snapshot = { ...virtual.execution.snapshot, quality:'fresh', observedAt:Date.now() };
      virtual.execution.requiresRefresh = false;
    }
    customAuthority(virtual, skipReview);
    for (const item of selected) {
      const calculated = virtual.proposal.steps.find(step => step.stepId === item.stepId);
      const step = { ...calculated, nominalYuan: item.nominalYuan };
      const gate = readiness(virtual, step, { skipReview });
      const row = { stepId: item.stepId, nominalYuan: item.nominalYuan,
        ready: gate.ready, reason: gate.reason };
      if (!gate.ready) { rows.push(row); break; }
      try {
        const plan = virtual.plans.find(p => p.planId === step.planId);
        const sent = registerSend(virtual.execution, step, plan, virtual.approval.approvalId,
          virtual.marketClock, skipReview ? 'calculated_skip_review' : null);
        virtual.execution = applyEvent(sent.execution, {
          eventId: `CUSTOM-PREVIEW-${rows.length + 1}`, sourceSequence: sent.execution.sourceSequence + 1,
          type: 'accepted', instructionId: sent.instructionId,
        }).execution;
        rows.push(row);
      } catch (error) {
        rows.push({ ...row, ready: false, reason: `批次预览无法保留本笔资源：${error.message}` });
        break;
      }
    }
    if (rows.length < selected.length) for (const item of selected.slice(rows.length))
      rows.push({ ...item, ready: false, reason: '前序步骤未通过，后续步骤未校验' });
    const failed = rows.find(row => !row.ready);
    return { rows, ready: !failed, reason: failed?.reason ?? '本批次按所选顺序可下达' };
  };
  return {
    getState: view,
    getAdvancementGroups: () => deriveAdvancementGroups(state),
    startFromTemplate(template) {
      const t = normalizeInitialTemplate(template ?? createDefaultInitialTemplate());
      if (t.provenance.kind !== 'synthetic') throw new Error('新建运行仅支持当前内置模板；旧运行须通过原存档迁移或场景重置');
      const ids = [...t.maturityCashEvents.map(e => e.eventId), ...t.pendingSettlements.map(e => e.tradeId)];
      if (new Set(ids).size !== ids.length) throw new Error('模板现金来源ID重复');
      const next = fresh('S13');
      next.context.portfolioId = t.portfolio.portfolioId;
      next.context.businessDate = t.businessDate;
      next.initialData = clone(t);
      next.inputs = { initialCashYuan: t.portfolio.accountCashYuan, navYuan: t.portfolio.navYuan,
        bankExposureYuan: t.portfolio.legacyBankExposureYuan,
        feeYuan: t.portfolio.feeYuan, bufferYuan: t.portfolio.bufferYuan };
      next.ruleConfig = { version: 1, ...clone(t.ruleInitials) };
      next.repoResources = clone(t.financingResources);
      next.plans = t.draftPlans.map((p, i) => ({ ...clone(p),
        issuerId: p.issuerId ?? t.securities.find(s => s.securityId === p.securityId)?.issuerBankId ?? null,
        planId: `${next.context.runId}-P-${i + 1}`, version: 1 }));
      next.nextPlanId = next.plans.length + 1;
      next.revision = next.plans.length;
      next.seedTouched = true;
      next.progress = progressFor('S13', 'initial', next.inputs);
      next.execution = newExecution(openingAccountCash(t),
        [...t.maturityCashEvents, ...t.pendingSettlements], t.demoMode ?? null);
      const checked = validateSaved(next);
      if (!checked.ok) throw new Error(checked.errors.join('；'));
      state = next;
      return view();
    },
    recordCashEvent(receipt) {
      if (state.progressId !== 'initial') throw new Error('历史场景进度不接收现金事件');
      const result = registerCashEvent(state.execution, receipt, state.context.businessDate);
      if (result.result === 'duplicate') return { ...view(), eventResult: 'duplicate' };
      const next = clone(state);
      next.execution = result.execution;
      return { ...commit(next), eventResult: result.result };
    },
    setInputs(patch) {
      if (state.initialData.provenance.kind !== 'legacy')
        throw new Error('模板运行期初不可原地改写；请修改模板并新建独立运行');
      initialOnly();
      if (!patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['initialCashYuan','navYuan','bankExposureYuan','feeYuan','bufferYuan'].includes(k))) throw new Error('输入字段无效');
      if (state.execution.journal.length) throw new Error('已有执行事实，不能改写初始输入');
      const next = clone(state); next.inputs = { ...next.inputs, ...patch }; next.proposal = null; next.calculation = null; next.seedTouched = true;
      for (const [from,to] of [['initialCashYuan','accountCashYuan'],['navYuan','navYuan'],
        ['bankExposureYuan','legacyBankExposureYuan'],['feeYuan','feeYuan'],['bufferYuan','bufferYuan']])
        if (Object.hasOwn(patch, from)) next.initialData.portfolio[to] = patch[from];
      next.progress = progressFor(next.scenarioId, 'initial', next.inputs);
      next.execution.initialCashYuan = next.inputs.initialCashYuan;
      return commit(next);
    },
    setRuleConfig(patch) {
      initialOnly();
      if (!patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['depositThreshold','observationThreshold'].includes(k))) throw new Error('规则配置字段无效');
      const next = clone(state);
      next.ruleConfig = { ...next.ruleConfig, ...patch, version: safeAdd(next.ruleConfig.version, 1) };
      next.seedTouched = true; next.proposal = null; next.calculation = null;
      return commit(next);
    },
    addPlan(input) {
      const next = clone(state);
      const id = `${state.context.runId}-P-${state.nextPlanId}`;
      next.nextPlanId++; next.plans.push(normalizedPlan(input, id, 1)); next.proposal = null; next.calculation = null; next.seedTouched = true;
      return commit(next);
    },
    updatePlan(planId, patch) {
      const next = clone(state); const i = next.plans.findIndex(p => p.planId === planId);
      if (i < 0) throw new Error('计划不存在');
      if (!patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['label','businessType','direction','counterpartyId','issuerId','targetYuan','termsNote','repoTerms',
        'tradeDate','settlementDate','securityId','marketTier'].includes(k))) throw new Error('计划修改字段无效');
      const { filledYuan, lockedYuan } = summary(state).planBalances.find(b => b.planId === planId);
      if ((filledYuan > 0 || lockedYuan > 0 || Object.values(state.execution.instructions).some(x => x.planId === planId)) &&
        Object.keys(patch).some(k => !['label','termsNote','targetYuan'].includes(k))) throw new Error('在途或成交计划仅可修改名称、备注和不低于已成交加锁定的意向金额');
      const changed = normalizedPlan({ ...next.plans[i], ...patch }, planId, next.plans[i].version + 1);
      if (changed.targetYuan < safeAdd(filledYuan, lockedYuan)) throw new Error('意向金额不得低于已成交加锁定金额');
      next.plans[i] = changed; next.proposal = null; next.calculation = null; next.seedTouched = true; return commit(next);
    },
    deletePlan(planId) {
      const next = clone(state); const i = next.plans.findIndex(p => p.planId === planId);
      if (i < 0) throw new Error('计划不存在');
      const { filledYuan, lockedYuan } = summary(state).planBalances.find(b => b.planId === planId);
      if (filledYuan > 0 || lockedYuan > 0 || Object.values(state.execution.instructions).some(x => x.planId === planId)) throw new Error('已有执行事实的计划不可删除');
      next.plans.splice(i, 1); next.proposal = null; next.calculation = null; next.seedTouched = true; return commit(next);
    },
    setPreferences(orderedKeys) {
      const next = clone(state);
      next.preferences = { version: safeAdd(state.preferences.version, 1), orderedKeys: clone(orderedKeys) };
      next.proposal = null; next.calculation = null;
      return commit(next);
    },
    setRepoResources(market, patch) {
      if (state.progressId !== 'initial' || !REPO_MARKETS.includes(market) || !patch || typeof patch !== 'object' ||
        Object.keys(patch).some(k => k !== 'pledgeConfirmedYuan')) throw new Error('仅可维护已确认质押券资源；人工融资额度已取消');
      const next = clone(state);
      next.repoResources[market] = { ...next.repoResources[market], ...patch };
      next.repoResourcesVersion = safeAdd(next.repoResourcesVersion, 1);
      next.proposal = null; next.calculation = null;
      return commit(next);
    },
    setMarketClock(patch) {
      if (state.progressId !== 'initial' || !patch || typeof patch !== 'object' ||
        Object.keys(patch).some(k => !['time','isTradingDay'].includes(k))) throw new Error('业务时钟输入无效');
      const next = clone(state), nextClock = { ...next.marketClock, ...patch };
      if (state.execution.journal.length && (nextClock.time < state.marketClock.time || nextClock.isTradingDay !== state.marketClock.isTradingDay))
        throw new Error('已有执行事实时业务时钟不可倒流或切换交易日');
      next.marketClock = nextClock;
      return commit(next);
    },
    generateProposal(pathId = 'AUTO', options = {}) {
      const next = clone(state);
      const supplied = options.result !== undefined;
      if (supplied && (typeof options.expectedSerialized !== 'string' ||
        options.expectedSerialized !== JSON.stringify(state)))
        throw new Error('计算期间数据已变化，请重新计算');
      const result = supplied ? options.result : calculate({ ...state, summary: summary(state) }, { pathId });
      const content = result.proposal;
      const remap = new Map();
      for (const step of content.steps) if (Object.values(state.execution.instructions).some(i => i.stepId === step.stepId && i.status !== 'rejected'))
        remap.set(step.stepId, `${step.stepId}-R${state.nextProposalId}`);
      for (const step of content.steps) {
        step.stepId = remap.get(step.stepId) ?? step.stepId;
        for (const condition of step.machineConditions ?? []) if (condition.stepId && remap.has(condition.stepId)) condition.stepId = remap.get(condition.stepId);
      }
      for (const group of content.groups ?? []) group.stepIds = group.stepIds.map(id => remap.get(id) ?? id);
      for (const traceStep of result.trace?.steps ?? []) {
        traceStep.stepId = remap.get(traceStep.stepId) ?? traceStep.stepId;
        for (const condition of traceStep.machineConditions ?? []) if (condition.stepId && remap.has(condition.stepId)) condition.stepId = remap.get(condition.stepId);
      }
      if (state.proposal) {
        const { proposalId, version, ...oldContent } = state.proposal;
        if (same(oldContent, content) && !state.execution.requiresReapproval) return view();
      }
      next.proposal = { proposalId: `${state.context.runId}-PROP-${state.nextProposalId}`, version: state.nextProposalId, ...content };
      next.calculation = { trace: result.trace, candidates: result.candidates };
      next.execution.requiresReapproval = false;
      next.nextProposalId++; return commit(next);
    },
    recalculateDispatchBatch(items) {
      if (state.progressId !== 'initial' || !Array.isArray(items) || !items.length ||
        items.some(item => !item || typeof item.planId !== 'string' ||
          !Number.isSafeInteger(item.nominalYuan) || item.nominalYuan <= 0 ||
          Object.keys(item).some(key => !['planId','nominalYuan','sourceStepId'].includes(key))) ||
        new Set(items.map(item => item.planId)).size !== items.length)
        throw new Error('重算批次须按顺序选择不同计划及正整数元金额');
      const balances = new Map(summary(state).planBalances.map(row => [row.planId, row]));
      for (const item of items) {
        const plan = state.plans.find(p => p.planId === item.planId);
        if (!plan || !balances.has(item.planId) || item.nominalYuan > balances.get(item.planId).arrangeableYuan)
          throw new Error('本次金额超过完整意向金额的剩余可安排量');
        if (item.sourceStepId !== undefined && (typeof item.sourceStepId !== 'string' ||
          !state.proposal?.steps.some(step => step.stepId === item.sourceStepId && step.planId === item.planId)))
          throw new Error('来源计算步骤已失效，请按当前指令重新计算');
        if (item.nominalYuan % unitFor(plan.businessType) !== 0)
          throw new Error('本次金额须符合该业务交易单位');
      }
      const next = clone(state), proposalId = `${state.context.runId}-PROP-${state.nextProposalId}`;
      const oldSteps = state.proposal?.steps ?? [];
      const missingPlans = items.filter(item=>!oldSteps.some(step=>step.planId===item.planId));
      const freshSteps = missingPlans.length ? calculate({ ...state, summary:summary(state) }, { pathId:'AUTO' }).proposal.steps : [];
      for(const item of missingPlans) if(freshSteps.filter(step=>step.planId===item.planId).length>1)
        throw new Error('新增步骤缺少唯一计算依据，请先在交易台重新计算建议');
      const referenceSteps = [...oldSteps,...freshSteps.filter(step=>missingPlans.some(item=>item.planId===step.planId))];
      const stepByPlan = new Map(items.map((item,index) => [item.planId, `${proposalId}-STEP-${index + 1}`]));
      const stepBySource = new Map(items.filter(item=>item.sourceStepId)
        .map(item=>[item.sourceStepId,stepByPlan.get(item.planId)]));
      const steps = items.map((item,index) => {
        const plan = state.plans.find(p => p.planId === item.planId);
        const old = item.sourceStepId ? oldSteps.find(step => step.stepId === item.sourceStepId) :
          referenceSteps.find(step => step.planId === item.planId);
        const derivedFromCalculation = state.proposal?.origin === 'calculated' || freshSteps.includes(old);
        const machineConditions = (old?.machineConditions ?? []).map(condition => {
          // Only the known engine-derived requirements are rebuilt for the
          // selected amount and prefix. Preserve unknown or historical kinds,
          // including sale_cash_available, and S10 split execution facts.
          const recalculatedKinds = ['funds_available','cash_available',
            'settlement_capacity','pledge_confirmed','holding_confirmed',
            'exchange_window_open'];
          if (derivedFromCalculation && (recalculatedKinds.includes(condition.kind) ||
            condition.kind === 'filled' && condition.planId !== item.planId)) return null;
          const dependencyPlan = referenceSteps.find(step => step.stepId === condition.stepId)?.planId;
          const uniquelyMapped = dependencyPlan && referenceSteps.filter(step=>step.planId===dependencyPlan).length===1 &&
            stepByPlan.has(dependencyPlan) ? stepByPlan.get(dependencyPlan) : null;
          const newDependency = stepBySource.get(condition.stepId) ?? uniquelyMapped;
          const mapped = newDependency ? { ...condition, stepId:newDependency } : { ...condition };
          if (mapped.kind === 'quota_confirmed') return null;
          const amountDependent = ['pledge_confirmed','holding_confirmed','cash_available','settlement_capacity'];
          if (mapped.planId === item.planId && amountDependent.includes(mapped.kind) &&
            Number.isSafeInteger(mapped.minimumYuan) && old)
            mapped.minimumYuan = Math.max(0,safeAdd(mapped.minimumYuan,item.nominalYuan-old.nominalYuan));
          return mapped;
        }).filter(Boolean);
        return { stepId: stepByPlan.get(item.planId), planId: item.planId,
          label: plan.label, nominalYuan: item.nominalYuan, sequenceIndex: index + 1,
          machineConditions, blocked: false, condition: null };
      });
      next.proposal = { proposalId, version: state.nextProposalId, pathId: 'CUSTOM-ORDER',
        origin: 'calculated', status: 'waiting_conditions', peakShortfallYuan: null,
        conflicts: [], message: '按用户所选顺序与金额逐前缀重新计算；未选意向金额继续保留。',
        steps, groups: [], planCoverage: [], unfinishedYuan: 0, unarrangedYuan: 0, blockers: [] };
      const openingCashYuan = summary(state).availableYuan;
      next.calculation = { trace: { search: { boundary: 'selected_path_only', nodes: items.length,
        exploredCandidates: items.length }, initialAvailableYuan:openingCashYuan,
        currentAvailableYuan:openingCashYuan, projectedFinalCashYuan:openingCashYuan,
        todayProjectedAvailableYuan:openingCashYuan,
        rulesVersion:state.rulesVersion,ruleConfigVersion:state.ruleConfig.version,
        preferencesVersion:state.preferences.version,snapshotRevision:state.revision,
        planBalances:[...balances.values()], steps: [] }, candidates: [] };
      next.execution.requiresReapproval = false;
      const virtual = clone(next);
      virtual.approval = executionAuthorization(virtual,'calculated_skip_review');
      const rows = [], accepted = [];
      for (const step of steps) {
        const evaluated = evaluateSelectedSequence({ ...state, summary:summary(state) },
          [...accepted,{planId:step.planId,nominalYuan:step.nominalYuan}]);
        const projection = evaluated.trace.at(-1);
        const engineStep = evaluated.steps.at(-1);
        const projectedCurrent = projection?.planId === step.planId &&
          projection.nominalYuan === step.nominalYuan;
        const idMap = new Map(accepted.map((prior,index) => [`CUSTOM-${index + 1}`,prior.stepId]));
        idMap.set(`CUSTOM-${accepted.length + 1}`,step.stepId);
        const projectedConditions = projectedCurrent ? (projection.machineConditions ?? []).map(condition =>
          condition.stepId ? { ...condition, stepId:idMap.get(condition.stepId) ?? condition.stepId } : condition) : [];
        step.machineConditions = [...step.machineConditions,...projectedConditions.filter(condition =>
          !step.machineConditions.some(old => same(old,condition)))];
        const traceRow = projectedCurrent ? { ...projection,stepId:step.stepId,
          rules:(projection.rules ?? []).map(rule => ({...rule,
            name:rule.name ?? RULE_NAMES[rule.ruleId] ?? rule.ruleId ?? '逐步业务校验'})),
          machineConditions:clone(step.machineConditions) } : {
          stepId:step.stepId,planId:step.planId,nominalYuan:step.nominalYuan,
          beforeCashYuan:null,afterCashYuan:null,beforeExposureYuan:null,afterExposureYuan:null,
          navYuan:state.inputs.navYuan,beforeRatio:null,afterRatio:null,
          machineConditions:clone(step.machineConditions),rules:[] };
        next.calculation.trace.steps.push(traceRow);
        virtual.proposal.steps.find(item => item.stepId === step.stepId).machineConditions = clone(step.machineConditions);
        virtual.calculation.trace.steps.push(clone(traceRow));
        virtual.approval.proposalCopy = clone(virtual.proposal);
        // A blocked instruction never reserves the private ledger. Later independent
        // instructions can still be checked against the successful prior prefix.
        const gate = readiness(virtual,step,{skipReview:true});
        const blockingRule = traceRow.rules?.find(rule =>
          ['block','missing','closed'].includes(rule.result));
        const engineBlocked = !projectedCurrent || engineStep?.blocked ||
          Boolean(blockingRule);
        const reason = engineBlocked ?
          (blockingRule ? `${blockingRule.name ?? RULE_NAMES[blockingRule.ruleId] ?? blockingRule.ruleId ?? '逐步业务校验'}：${blockingRule.reason ?? '本步逐步计算未通过'}` :
            (!gate.ready ? gate.reason : evaluated.conflicts.findLast(conflict => conflict.includes(step.label)) ??
              evaluated.conflicts.at(-1) ?? '所选步骤未能形成完整的逐步计算依据')) : gate.reason;
        rows.push({ stepId:step.stepId, planId:step.planId, nominalYuan:step.nominalYuan,
          ready:!engineBlocked && gate.ready, reason,
          ...(engineBlocked && blockingRule ? {ruleId:blockingRule.ruleId,name:blockingRule.name ?? RULE_NAMES[blockingRule.ruleId] ?? blockingRule.ruleId} : {}),
          ...(!engineBlocked && !gate.ready ? {ruleId:gate.ruleId,name:gate.name,blockingCondition:gate.blockingCondition} : {}) });
        if (!rows.at(-1).ready) continue;
        try {
          const plan = virtual.plans.find(p => p.planId === step.planId);
          const sent = registerSend(virtual.execution,step,plan,virtual.approval.approvalId,virtual.marketClock,'calculated_skip_review');
          virtual.execution = applyEvent(sent.execution, { eventId:`CUSTOM-RECALC-${rows.length}`,
            sourceSequence:sent.execution.sourceSequence+1,type:'accepted',instructionId:sent.instructionId }).execution;
          accepted.push({stepId:step.stepId,planId:step.planId,nominalYuan:step.nominalYuan});
          next.calculation.trace.projectedFinalCashYuan = evaluated.projectedFinalCashYuan;
          next.calculation.trace.todayProjectedAvailableYuan = evaluated.projectedFinalCashYuan;
        } catch(error) {
          rows.at(-1).ready = false;
          rows.at(-1).reason = `批次预览无法保留本笔资源：${error.message}`;
        }
      }
      for (const [index,row] of rows.entries()) {
        steps[index].blocked = !row.ready;
        if (!row.ready && !next.calculation.trace.steps[index].rules.some(rule =>
          ['block','missing','closed'].includes(rule.result)))
          next.calculation.trace.steps[index].rules.push({ ruleId:row.ruleId ?? 'CUSTOM-DISPATCH-CHECK',
            name:row.name ?? '逐步下达条件',result:'block',reason:row.reason,
            ...(row.blockingCondition ? {blockingCondition:clone(row.blockingCondition)} : {}) });
        next.proposal.groups.push({ groupId:`CUSTOM-${index+1}`,stepIds:[row.stepId],
          status:row.ready?'ready':'blocked',reason:row.reason });
      }
      const ready = rows.every(row => row.ready);
      next.proposal.status = ready?'feasible':'blocked_sequence';
      next.proposal.message = ready?'所选顺序及金额逐前缀通过，仍须核对并手动下达。':'所选顺序存在阻断；只说明此路径当前不可全额下达。';
      next.proposal.blockers = rows.filter(row => !row.ready).map(row => ({
        severity:'block',planId:row.planId,reason:row.reason }));
      next.proposal.planCoverage = [...balances.values()].map(balance => {
        const suggestedYuan = rows.find(row => row.planId === balance.planId && row.ready)?.nominalYuan ?? 0;
        return { ...balance, suggestedYuan, unarrangedYuan:balance.arrangeableYuan-suggestedYuan };
      });
      next.proposal.unfinishedYuan = next.proposal.planCoverage.reduce((n,row)=>safeAdd(n,row.remainingYuan),0);
      next.proposal.unarrangedYuan = next.proposal.planCoverage.reduce((n,row)=>safeAdd(n,row.unarrangedYuan),0);
      next.nextProposalId++;
      return { ...commit(next), recalculationRows:rows, recalculationReady:ready };
    },
    approveProposal() {
      if (state.execution.requiresReapproval) throw new Error('恢复后须重新计算建议并审核');
      if (Object.keys(state.execution.pending).length) throw new Error('回报序号缺失，等待补齐后才能审核');
      if (!eligibleApprovalSteps(state).length) throw new Error('当前没有可审核的计算指令子集');
      const next = clone(state);
      next.approval = executionAuthorization(state, 'manual_review');
      // The manager's review confirms the current local simulated ledger.
      // Missing source reports remain authoritative gaps and cannot be erased.
      next.execution.snapshot = { version: next.execution.snapshot.version + 1, observedAt: Date.now(), quality: 'fresh' };
      next.execution.requiresRefresh = false;
      next.nextApprovalId++; return commit(next);
    },
    refreshSnapshot() {
      if (state.progressId !== 'initial') throw new Error('历史场景进度不可刷新为执行快照');
      if (Object.keys(state.execution.pending).length) throw new Error('回报序号缺失，不能标记为最新快照');
      const next = clone(state);
      next.execution.snapshot = { version: next.execution.snapshot.version + 1, observedAt: Date.now(), quality: 'fresh' };
      next.execution.requiresRefresh = false;
      return commit(next);
    },
    markSnapshotStale() {
      const next = clone(state); next.execution.snapshot.quality = 'stale'; return commit(next);
    },
    send(stepId = null) {
      if (!manualApproval(state)) throw new Error('发送前须审核当前具体指令包');
      const steps = state.approval.proposalCopy.steps;
      const availableSteps = steps.filter(step => readiness(state, step).ready);
      const selected = stepId === null ? availableSteps[0] : steps.find(step => step.stepId === stepId);
      if (!selected) throw new Error('没有当前可下达的已审核指令');
      const instructionId = dispatchOne(selected);
      return { ...view(), sentInstructionId: instructionId };
    },
    sendBatch(stepIds = null, { receiptMode = 'accepted', stopAtIndex = null } = {}) {
      if (!['accepted','unknown','rejected'].includes(receiptMode)) throw new Error('批次回执模式无效');
      if (stopAtIndex !== null && (!Number.isSafeInteger(stopAtIndex) || stopAtIndex < 0))
        throw new Error('批次停止位置无效');
      if (!manualApproval(state)) throw new Error('发送前须审核当前具体指令包');
      if (Object.values(state.execution.instructions).some(i => i.status === 'unknown'))
        throw new Error('已有发送结果未知的指令，须先核实回报再下达下一批');
      const approvedSteps = state.approval.proposalCopy.steps;
      if (stepIds !== null && (!Array.isArray(stepIds) || !stepIds.length ||
        new Set(stepIds).size !== stepIds.length || stepIds.some(id => typeof id !== 'string' ||
          !approvedSteps.some(step => step.stepId === id)))) throw new Error('批次步骤必须唯一且属于当前审核包');
      const selectedIds = stepIds ?? view().batchReadiness.filter(row => row.ready).map(row => row.stepId);
      if (!selectedIds.length) throw new Error('没有当前可下达的已审核批次');
      const exceptionAt = receiptMode === 'accepted' ? -1 : Math.min(stopAtIndex ?? 1, selectedIds.length - 1);
      const results = [];
      let stoppedReason = null;
      for (let index = 0; index < selectedIds.length; index++) {
        const stepId = selectedIds[index];
        const step = approvedSteps.find(item => item.stepId === stepId);
        const gate = readiness(state, step);
        if (!gate.ready) {
          stoppedReason = gate.reason;
          results.push({ stepId, instructionId: null, status: 'not_sent', reason: gate.reason });
          break;
        }
        let instructionId;
        try { instructionId = dispatchOne(step); }
        catch (error) {
          stoppedReason = error.message;
          results.push({ stepId, instructionId: null, status: 'not_sent', reason: error.message });
          break;
        }
        const outcome = index === exceptionAt ? receiptMode : 'accepted';
        if (outcome === 'unknown') {
          stoppedReason = '本笔本地发送结果未知，已保留占用；核实回报前停止本批剩余步骤';
          results.push({ stepId, instructionId, status: 'unknown', reason: stoppedReason });
          break;
        }
        try {
          const event = { type: outcome, eventId: `${state.context.runId}-E-${state.execution.nextLocalEvent}`,
            sourceSequence: state.execution.sourceSequence + 1, runId: state.context.runId,
            instructionId, ...(outcome === 'rejected' ? { noReservation: true } : {}) };
          const next = clone(state);
          next.execution = applyEvent(next.execution, event).execution;
          next.execution.nextLocalEvent++;
          commit(next);
          const reason = outcome === 'accepted' ? '本地投管流程记录为已接收，尚未成交' : '本地投管流程记录为拒绝且无占用；本批剩余步骤未发送';
          results.push({ stepId, instructionId, status: outcome, reason });
          if (outcome === 'rejected') { stoppedReason = reason; break; }
        } catch (error) {
          stoppedReason = `本笔回执未确认，已保留发送事实：${error.message}`;
          results.push({ stepId, instructionId, status: 'unknown', reason: stoppedReason });
          break;
        }
      }
      for (const stepId of selectedIds.slice(results.length))
        results.push({ stepId, instructionId: null, status: 'not_sent', reason: stoppedReason ?? '本批次已停止' });
      return { ...view(), results, stoppedReason };
    },
    previewDispatchBatch(items, { skipReview = false, assumeFreshSnapshot = false } = {}) {
      return previewCustom(items, skipReview, assumeFreshSnapshot);
    },
    sendCustomBatch(items, { skipReview = false, receiptMode = 'accepted', stopAtIndex = null } = {}) {
      if (!['accepted','unknown','rejected'].includes(receiptMode)) throw new Error('批次回执模式无效');
      if (stopAtIndex !== null && (!Number.isSafeInteger(stopAtIndex) || stopAtIndex < 0))
        throw new Error('批次停止位置无效');
      const selected = customItems(items);
      const preview = previewCustom(selected, skipReview);
      if (!preview.ready) throw new Error(preview.reason);
      if (Object.values(state.execution.instructions).some(i => i.status === 'unknown'))
        throw new Error('已有发送结果未知的指令，须先核实回报再下达下一批');
      if (skipReview) {
        const next = clone(state);
        customAuthority(next, true);
        commit(next);
      }
      const exceptionAt = receiptMode === 'accepted' ? -1 : Math.min(stopAtIndex ?? 1, selected.length - 1);
      const results = [];
      let stoppedReason = null;
      for (let index = 0; index < selected.length; index++) {
        const item = selected[index];
        const calculated = state.proposal.steps.find(step => step.stepId === item.stepId);
        const step = { ...calculated, nominalYuan: item.nominalYuan };
        const gate = readiness(state, step, { skipReview });
        if (!gate.ready) {
          stoppedReason = gate.reason;
          results.push({ ...item, instructionId: null, status: 'not_sent', reason: gate.reason });
          break;
        }
        let instructionId;
        try {
          const plan = state.plans.find(p => p.planId === step.planId);
          const next = clone(state);
          const sent = registerSend(next.execution, step, plan, state.approval.approvalId,
            state.marketClock, skipReview ? 'calculated_skip_review' : null);
          next.execution = sent.execution;
          commit(next);
          instructionId = sent.instructionId;
        } catch (error) {
          stoppedReason = error.message;
          results.push({ ...item, instructionId: null, status: 'not_sent', reason: error.message });
          break;
        }
        const outcome = index === exceptionAt ? receiptMode : 'accepted';
        if (outcome === 'unknown') {
          stoppedReason = '本笔本地发送结果未知，已保留占用；核实回报前停止本批剩余步骤';
          results.push({ ...item, instructionId, status: 'unknown', reason: stoppedReason });
          break;
        }
        try {
          const event = { type: outcome, eventId: `${state.context.runId}-E-${state.execution.nextLocalEvent}`,
            sourceSequence: state.execution.sourceSequence + 1, runId: state.context.runId,
            instructionId, ...(outcome === 'rejected' ? { noReservation: true } : {}) };
          const next = clone(state);
          next.execution = applyEvent(next.execution, event).execution;
          next.execution.nextLocalEvent++;
          commit(next);
          const reason = outcome === 'accepted' ? '本地投管流程记录为已接收，尚未成交' : '本地投管流程记录为拒绝且无占用；本批剩余步骤未发送';
          results.push({ ...item, instructionId, status: outcome, reason });
          if (outcome === 'rejected') { stoppedReason = reason; break; }
        } catch (error) {
          stoppedReason = `本笔回执未确认，已保留发送事实：${error.message}`;
          results.push({ ...item, instructionId, status: 'unknown', reason: stoppedReason });
          break;
        }
      }
      for (const item of selected.slice(results.length))
        results.push({ ...item, instructionId: null, status: 'not_sent', reason: stoppedReason ?? '本批次已停止' });
      return { ...view(), results, stoppedReason };
    },
    processExecutionBatch(instructionIds, action) {
      if (!['fill','settle'].includes(action) || !Array.isArray(instructionIds) ||
        !instructionIds.length || new Set(instructionIds).size !== instructionIds.length ||
        instructionIds.some(id => typeof id !== 'string' || !state.execution.instructions[id]))
        throw new Error('投管批量操作须选择唯一且存在的指令');
      if (state.progressId !== 'initial') throw new Error('历史场景进度不接收回报');
      const results = [];
      let stoppedReason = null;
      for (const instructionId of instructionIds) {
        const next = clone(state);
        const instruction = next.execution.instructions[instructionId];
        const localEvent = (type, fields) => {
          const sequence = next.execution.nextLocalEvent;
          const event = { ...fields, type, instructionId,
            eventId:`${next.context.runId}-E-${sequence}`,
            sourceSequence:next.execution.sourceSequence+1,runId:next.context.runId };
          if (type === 'fill') {
            event.fillId = `${next.context.runId}-FILL-${sequence}`;
            if (isExchangeRepo(instruction.businessType)) {
              event.tradeTime = next.marketClock.time;
              if (!singleDay(next)) {
                const gate = windowStatus(next.marketClock,{mode:'fill',at:event.tradeTime});
                if (gate.result !== 'open' || event.tradeTime < instruction.sentTime)
                  throw new Error('交易所成交时间须在已发送后的开放窗口');
                event.reportClockTime = next.marketClock.time;
              }
            }
          } else event.cashFlowId = `${next.context.runId}-F-${sequence}`;
          next.execution = applyEvent(next.execution,event).execution;
          next.execution.nextLocalEvent++;
        };
        try {
          if (action === 'fill') {
            const amountYuan = instruction.nominalYuan-instruction.filledYuan-instruction.cancelledYuan;
            if (amountYuan <= 0) throw new Error('没有未成交份额');
            localEvent('fill',{nominalYuan:amountYuan});
            commit(next);
            results.push({instructionId,status:'filled',amountYuan,reason:'已记录成交；资金收付仍待结算'});
          } else {
            if (instruction.settlementDate !== null && instruction.settlementDate > next.context.businessDate)
              throw new Error('交易尚未到交收日，不能确认资金划拨');
            const unsettledYuan = instruction.filledYuan-instruction.settledYuan;
            const creditedYuan = Object.values(next.execution.cashFlows)
              .filter(flow => flow.type === 'cash_available' && flow.instructionId === instructionId)
              .reduce((n,flow)=>safeAdd(n,flow.amountYuan),0);
            const uncreditedYuan = instruction.direction === 'inflow' ? instruction.filledYuan-creditedYuan : 0;
            if (unsettledYuan <= 0 && uncreditedYuan <= 0)
              throw new Error('该指令已完成结算和资金划拨，没有待处理金额');
            if (unsettledYuan > 0) localEvent('cash_settled',{amountYuan:unsettledYuan});
            if (uncreditedYuan > 0) localEvent('cash_available',{amountYuan:uncreditedYuan});
            commit(next);
            results.push({instructionId,status:'settled',amountYuan:Math.max(unsettledYuan,uncreditedYuan),
              reason:instruction.direction==='inflow'?'已确认结算及到账，实际账户增加':'已确认结算付款，实际账户扣减'});
          }
        } catch(error) {
          stoppedReason = error.message || String(error);
          results.push({instructionId,status:'blocked',amountYuan:0,reason:stoppedReason});
          break;
        }
      }
      for (const instructionId of instructionIds.slice(results.length))
        results.push({instructionId,status:'not_processed',amountYuan:0,
          reason:'前笔失败，本批后续未处理'});
      return { ...view(),results,stoppedReason };
    },
    requestCancel(instructionId) {
      const instruction = state.execution.instructions[instructionId];
      if (!singleDay(state) && instruction && isExchangeRepo(instruction.businessType) && cancellationStatus(state.marketClock).result !== 'open')
        throw new Error('交易所正回购当前不在可撤单窗口');
      const next = clone(state);
      const result = registerCancel(next.execution, instructionId);
      next.execution = result.execution;
      return { ...commit(next), cancelRequestId: result.cancelRequestId };
    },
    recordEvent(event) {
      if (state.progressId !== 'initial') throw new Error('历史场景进度不接收回报');
      if (event.runId !== undefined && event.runId !== state.context.runId) throw new Error('回报运行域不匹配');
      const instruction = state.execution.instructions[event.instructionId];
      if (['cash_settled','cash_available'].includes(event.type) && instruction &&
        instruction.settlementDate !== null && instruction.settlementDate > state.context.businessDate)
        throw new Error('交易尚未到交收日，不能确认现金收付');
      if (!singleDay(state) && event.type === 'fill' && instruction && isExchangeRepo(instruction.businessType)) {
        const gate = windowStatus(state.marketClock, { mode: 'fill', at: event.tradeTime });
        if (gate.result !== 'open' || event.tradeTime > state.marketClock.time || event.tradeTime < instruction.sentTime)
          throw new Error('交易所成交时间须在已发送后的开放窗口，且不晚于当前业务时钟');
        event = { ...event, reportClockTime: state.marketClock.time };
      }
      const next = clone(state);
      const result = applyEvent(next.execution, event);
      if (result.result.startsWith('duplicate')) return { ...view(), eventResult: result.result };
      next.execution = result.execution;
      if (event.eventId === `${state.context.runId}-E-${state.execution.nextLocalEvent}`) next.execution.nextLocalEvent++;
      return { ...commit(next), eventResult: result.result };
    },
    simulateEvent(type, fields = {}) {
      if (!fields || typeof fields !== 'object') throw new Error('回报字段无效');
      const event = { ...fields, type, eventId: `${state.context.runId}-E-${state.execution.nextLocalEvent}`,
        sourceSequence: state.execution.sourceSequence + 1, runId: state.context.runId };
      if (type === 'fill' && !event.fillId) event.fillId = `${state.context.runId}-FILL-${state.execution.nextLocalEvent}`;
      if (type === 'fill' && isExchangeRepo(state.execution.instructions[event.instructionId]?.businessType) && !event.tradeTime)
        event.tradeTime = state.marketClock.time;
      return this.recordEvent(event);
    },
    confirmFunding(amountYuan) {
      money(amountYuan, '独立到账', true);
      return this.simulateEvent('cash_available', { cashFlowId: `${state.context.runId}-F-${state.execution.nextLocalEvent}`,
        instructionId: null, amountYuan, syntheticFunding: true });
    },
    selectProgress(id) {
      if (!progressCatalog[state.scenarioId][id]) throw new Error('未知场景进度');
      if (id === state.progressId) return view();
      if (state.seedTouched || state.execution.journal.length) throw new Error('已有修改或执行事实，不可切换预置进度；请新建独立副本');
      const next = clone(state); next.progressId = id; next.progress = progressFor(state.scenarioId, id); return commit(next);
    },
    reset(scenarioId = state.scenarioId) { state = fresh(scenarioId); return view(); },
    serialize() { return JSON.stringify(state); },
    load(data) {
      const checked = validateSaved(data);
      if (!checked.ok) throw new Error(checked.errors.join('；'));
      const incoming = normalizeSaved(data);
      if (incoming.context.runId === state.context.runId && state.execution.journal.length &&
        (incoming.revision < state.revision || !same(incoming.execution.journal, state.execution.journal)))
        throw new Error('旧存档不能覆盖当前运行域的较新执行事实');
      incoming.execution.requiresRefresh = true;
      incoming.execution.requiresReapproval = true;
      state = incoming; return view();
    },
  };
}
