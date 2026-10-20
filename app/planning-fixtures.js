// E2 deterministic, synthetic scenarios from docs/ai/验收场景.md.
// All amounts are integer yuan. These fixtures are independent model runs.
import { createModel, validateSaved } from './model.js';
import { INITIAL_TEMPLATE_VERSION, TERM_WEIGHTS_VERSION, SINGLE_DAY_DEMO_MODE,
  normalizeInitialTemplate } from './initial-data.js';

export const E = 100000000;
const DATE = '2026-10-04';
const BANK = 'AI-BANK-A';
const SECOND_BANK = 'AI-BANK-B';
const money = billions => billions * E;

const plan = (businessType, amount, { securityId = null, tenorDays = null } = {}) => ({
  label: `AI验收合成${businessType}`, businessType,
  direction: ['interbank_repo_financing'].includes(businessType) ? 'inflow' : 'outflow',
  counterpartyId: null, issuerId: ['deposit', 'cd_buy'].includes(businessType) ? BANK : null,
  targetYuan: money(amount), termsNote: 'AI验收合成计划，非真实交易',
  repoTerms: tenorDays === null ? null : { market: 'INTERBANK', tenorDays, annualRate: null },
  tradeDate: DATE, settlementDate: DATE, securityId,
  marketTier: businessType === 'cd_buy' ? 'secondary' : null,
});

function template(caseId) {
  const config = {
    S1: { cash: 10, nonbank: 90, days: 95, quota: 20 },
    S2: { cash: 20, nonbank: 80, days: 95, quota: 20 },
    S3: { cash: 10, nonbank: 90, days: 80, quota: 20 },
    S4: { cash: 5, nonbank: 83, days: 80, quota: 20, oldDeposit: 12 },
    S5: { cash: 10, nonbank: 90, days: 80, quota: 8 },
  }[caseId];
  if (!config) throw new Error(`未知AI验收场景：${caseId}`);
  const securities = [
    { securityId: 'AI-NONBANK-BASKET', label: '分散的合成非银行资产束', instrumentKind: 'bond',
      issuerBankId: null, issuerType: 'non_bank', isGovernmentBond: false,
      remainingTradingDays: config.days },
    ...[30, 90].map(days => ({ securityId: `AI-A-DEP-${days}`, label: `合成A银行${days}天存款`,
      instrumentKind: 'deposit', issuerBankId: BANK, issuerType: 'bank',
      isGovernmentBond: false, remainingTradingDays: days })),
    { securityId: 'AI-A-CD-120', label: '合成A银行120天存单', instrumentKind: 'cd',
      issuerBankId: BANK, issuerType: 'bank', isGovernmentBond: false, remainingTradingDays: 120 },
  ];
  // S3's fixed 15yi deposit spans two banks so each stays below the current 8% fund gate.
  if (caseId === 'S3') securities.push({ ...securities.find(s => s.securityId === 'AI-A-DEP-90'),
    securityId: 'AI-B-DEP-90', label: '合成B银行90天存款', issuerBankId: SECOND_BANK });
  const holdings = [{ holdingId: 'AI-H-NB', securityId: 'AI-NONBANK-BASKET',
    amountYuan: money(config.nonbank), sellableYuan: 0 }];
  if (config.oldDeposit) holdings.push({ holdingId: 'AI-H-A-DEP', securityId: 'AI-A-DEP-30',
    amountYuan: money(config.oldDeposit), sellableYuan: 0 });
  const draftPlans = caseId === 'S3'
    ? [plan('reverse_repo', 10, { tenorDays: 7 })]
    : caseId === 'S5'
      ? [plan('interbank_repo_financing', 5, { tenorDays: 7 }),
        plan('reverse_repo', 7, { tenorDays: 7 })]
      : [];
  return normalizeInitialTemplate({
    templateVersion: INITIAL_TEMPLATE_VERSION, templateId: `AI-PLANNING-${caseId}`,
    label: `AI拟单验收${caseId}`, revision: 1, demoMode: SINGLE_DAY_DEMO_MODE,
    provenance: { kind: 'synthetic', note: 'docs/ai/验收场景.md 的独立合成演示数据；所有金额、资质及交易均非真实事实。' },
    businessDate: DATE,
    portfolio: { portfolioId: `AI-FUND-${caseId}`, label: '合成100亿货币基金',
      navYuan: money(100), accountCashYuan: money(config.cash), netSubscriptionYuan: 0,
      feeYuan: 0, bufferYuan: 0, legacyBankExposureYuan: null },
    banks: [BANK, ...(caseId === 'S3' ? [SECOND_BANK] : [])].map(bankId => ({
      bankId, label: bankId === BANK ? '合成A银行' : '合成B银行', custodyQualified: true, rating: 'AA',
      ratingAsOf: DATE, quarterlyNetAssetsYuan: money(300), quarterEnd: '2026-06-30' })),
    securities, holdings,
    termWeights: { version: TERM_WEIGHTS_VERSION, coverage: 'complete',
      calendar: 'day-365-demo-v1', asOfDate: DATE,
      assets: [{ weightId: 'AI-TW-CASH', label: '实际账户现金', amountYuan: money(config.cash),
        remainingTradingDays: 0, sourceAccountCash: true },
      ...holdings.map(h => ({ weightId: `AI-TW-${h.holdingId}`, label: h.securityId,
        amountYuan: h.amountYuan, remainingTradingDays:
          securities.find(s => s.securityId === h.securityId).remainingTradingDays,
        sourceHoldingId: h.holdingId }))], liabilities: [], positiveRepos: [] },
    otherFundBankExposure: [BANK, ...(caseId === 'S3' ? [SECOND_BANK] : [])].map(bankId =>
      ({ bankId, depositYuan: 0, cdYuan: 0, bondYuan: 0, otherYuan: 0 })),
    financingResources: { INTERBANK: { quotaConfirmedYuan: money(config.quota), pledgeConfirmedYuan: null },
      SSE: { quotaConfirmedYuan: null, pledgeConfirmedYuan: null },
      SZSE: { quotaConfirmedYuan: null, pledgeConfirmedYuan: null } },
    ruleInitials: { depositThreshold: '0.08', observationThreshold: '0.082' },
    maturityCashEvents: [], pendingSettlements: [], draftPlans,
  });
}

function sendPlan(model, businessType) {
  const proposal = model.generateProposal();
  if (!proposal.canApprove) throw new Error(`场景执行准备失败：${businessType}`);
  model.approveProposal();
  const state = model.getState();
  const planId = state.plans.find(x => x.businessType === businessType)?.planId;
  const step = state.proposal.steps.find(x => x.planId === planId);
  if (!step) throw new Error(`未排出执行步骤：${businessType}`);
  return model.send(step.stepId).sentInstructionId;
}

function addS5Facts(model) {
  const [financingId, reverseRepoId] = model.getState().plans.map(p => p.planId);
  const financeInstructionId = sendPlan(model, 'interbank_repo_financing');
  model.simulateEvent('accepted', { instructionId: financeInstructionId });
  model.simulateEvent('fill', { instructionId: financeInstructionId, nominalYuan: money(3) });
  const reverseInstructionId = sendPlan(model, 'reverse_repo');
  model.simulateEvent('accepted', { instructionId: reverseInstructionId });
  model.simulateEvent('fill', { instructionId: reverseInstructionId, nominalYuan: money(4) });
  model.simulateEvent('cash_settled', { instructionId: reverseInstructionId,
    amountYuan: money(4), cashFlowId: 'AI-S5-REVERSE-PAID-4' });
  model.updatePlan(financingId, { targetYuan: money(8) });
  model.updatePlan(reverseRepoId, { targetYuan: money(12) });
  return { financingId, reverseRepoId, financeInstructionId, reverseInstructionId };
}

export function makePlanningFixture(caseId) {
  const id = String(caseId).toUpperCase();
  const model = createModel();
  model.startFromTemplate(template(id));
  const facts = id === 'S5' ? addS5Facts(model) : null;
  const existingReverseRepoId = id === 'S3' ? model.getState().plans[0].planId : facts?.reverseRepoId;
  const fixedPlans = {
    S1: [plan('cd_buy', 15, { securityId: 'AI-A-CD-120' })],
    S2: [],
    S3: [plan('deposit', 7.5, { securityId: 'AI-A-DEP-90' }),
      { ...plan('deposit', 7.5, { securityId: 'AI-B-DEP-90' }), issuerId: SECOND_BANK }],
    S4: [plan('deposit', 5, { securityId: 'AI-A-DEP-30' })],
    S5: [plan('deposit', 6, { securityId: 'AI-A-DEP-90' })],
  }[id];
  const intent = {
    requestId: `AI-PLANNING-${id}-REQUEST`, fixedPlans,
    financing: { ...(facts ? { planId: facts.financingId } : {}), tenorDays: 7,
      maxAmountYuan: money(id === 'S5' ? 8 : 20), unitYuan: E },
    reverseRepo: { ...(existingReverseRepoId ? { planId: existingReverseRepoId } : {}),
      amountYuan: id === 'S2' ? money(8) : id === 'S3' ? money(10) : id === 'S5' ? money(12) : null,
      tenorDays: 7, unitYuan: E },
    allowReduceReverseRepo: ['S3', 'S5'].includes(id),
  };
  const expected = {
    S1: { status: 'feasible', financingYuan: money(15), reverseRepoYuan: 0,
      cashYuan: money(10), termNumeratorYuan: money(10350), termDenominatorYuan: money(115) },
    S2: { status: 'feasible', financingYuan: 0, reverseRepoYuan: money(8),
      cashYuan: money(12), termNumeratorYuan: money(7656), termDenominatorYuan: money(100) },
    S3: { status: 'feasible', financingYuan: money(20), reverseRepoYuan: money(10),
      cashYuan: money(5), alternativeFinancingYuan: money(10), alternativeReverseRepoYuan: 0 },
    S4: { status: 'blocked', blockingRuleId: 'C06', originalDepositYuan: money(5),
      feasibleDepositYuan: money(3), unfulfilledDepositYuan: money(2) },
    S5: { status: 'blocked_with_alternative', financingYuan: money(8),
      reverseRepoYuan: money(7), cashYuan: money(5),
      termNumeratorYuan: money(7789), termDenominatorYuan: money(108),
      financingFilledYuan: money(3), financingLockedYuan: money(2), financingArrangeableYuan: money(3),
      reverseRepoFilledYuan: money(4), reverseRepoLockedYuan: money(3), reverseRepoArrangeableYuan: money(5),
      facts },
  }[id];
  const validation = validateSaved(model.serialize());
  if (!validation.ok) throw new Error(`场景${id}存档无效：${validation.errors.join('；')}`);
  return { model, intent, expected };
}

