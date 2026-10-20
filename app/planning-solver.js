// Deterministic planning over an isolated model copy. Amounts are integer yuan.
import { createModel } from './model.js';
import { calculate } from './engine.js';
import { evaluateCoreRules, coreRulesEnabled } from './core-rules.js';
import { unitFor, isFinancing } from './business.js';

const copy = value => JSON.parse(JSON.stringify(value));
const integer = (value, label, zero = true) => {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`${label}须为${zero ? '非负' : '正'}安全整数元`);
  return value;
};
const aligned = (amount, unit, label) => {
  integer(amount, label);
  if (amount % unit) throw new Error(`${label}不符合交易单位`);
  return amount;
};
const floorUnit = (amount, unit) => Math.max(0, Math.floor(amount / unit) * unit);
const serializable = value => value && typeof value === 'object' && !Array.isArray(value);
const finiteCash = state => state.summary?.projectedEndOfDayYuan?.balanceYuan;

function snapshotSaved(snapshot) {
  if (!serializable(snapshot) || !serializable(snapshot.saved)) throw new Error('缺少有效规划快照');
  if (snapshot.state?.context?.runId !== snapshot.saved.context?.runId) throw new Error('规划快照运行ID不一致');
  return copy(snapshot.saved);
}

function applyDeltas(model, deltas) {
  if (!Array.isArray(deltas) || deltas.length > 66) throw new Error('草案差量无效或超出动作预算');
  for (const delta of deltas) {
    if (!serializable(delta)) throw new Error('草案差量无效');
    if (delta.kind === 'add') model.addPlan(delta.plan);
    else if (delta.kind === 'update') {
      if (!serializable(delta.patch) || Object.keys(delta.patch).some(key => key !== 'targetYuan'))
        throw new Error('求解器只允许修改计划意向金额');
      const existing = model.getState().plans.find(plan => plan.planId === delta.planId);
      if (!existing || !['interbank_repo_financing', 'reverse_repo'].includes(existing.businessType))
        throw new Error('求解器只允许调整现有融资或逆回购意向金额');
      model.updatePlan(delta.planId, delta.patch);
    } else if (delta.kind === 'delete') {
      const existing = model.getState().plans.find(plan => plan.planId === delta.planId);
      if (existing?.businessType !== 'reverse_repo') throw new Error('求解器只允许删除未执行逆回购计划');
      model.deletePlan(delta.planId);
    }
    else throw new Error('未知草案差量类型');
  }
}

function projectedActions(state) {
  const byId = new Map(state.plans.map(plan => [plan.planId, plan]));
  return (state.summary?.planBalances ?? []).flatMap(balance => {
    const plan = byId.get(balance.planId);
    // Sent purchases, including reverse repos, are already commitments in core-rules.
    // Sent but unfilled borrowing and sales still belong in the final projection.
    const amountYuan = isFinancing(plan.businessType) || plan.direction === 'inflow'
      ? balance.remainingYuan : balance.arrangeableYuan;
    return amountYuan > 0 ? [{ plan, amountYuan }] : [];
  });
}

function completedGovernmentBondProjection(state) {
  const projected = copy(state);
  const assumptions = [];
  const actions = projectedActions(state);
  const securities = new Map(state.initialData.securities.map(security => [security.securityId, security]));
  const balances = new Map(state.summary.planBalances.map(balance => [balance.planId, balance]));
  const maxDays = state.initialData.demoMode === 'single-day-principal-v1' ? 365 : 252;
  for (const plan of state.plans) {
    const security = securities.get(plan.securityId);
    if (plan.businessType !== 'bond_buy' || !security?.isGovernmentBond ||
        !Number.isSafeInteger(security.remainingTradingDays) ||
        security.remainingTradingDays > maxDays) continue;
    let virtualSettleYuan = 0;
    for (const instruction of Object.values(projected.execution.instructions)) {
      if (instruction.planId !== plan.planId || instruction.status === 'rejected') continue;
      const commitment = instruction.nominalYuan - instruction.cancelledYuan;
      virtualSettleYuan += Math.max(0, commitment - instruction.settledYuan);
      instruction.settledYuan = commitment;
    }
    const arrangeable = balances.get(plan.planId)?.arrangeableYuan ?? 0;
    if (arrangeable > 0) {
      projected.execution.instructions[`AI-VIRTUAL-GOV-${plan.planId}`] = {
        planId: plan.planId, status: 'filled', nominalYuan: arrangeable,
        cancelledYuan: 0, filledYuan: arrangeable, settledYuan: arrangeable,
      };
      virtualSettleYuan += arrangeable;
    }
    if (virtualSettleYuan > 0) assumptions.push({ planId: plan.planId,
      kind: 'government_bond_purchase_settled', amountYuan: virtualSettleYuan });
  }
  const adjustedActions = actions.filter(action => !assumptions.some(item =>
    item.planId === action.plan.planId));
  return { state: projected, actions: adjustedActions, assumptions };
}

function terminal(snapshot, deltas) {
  const model = createModel(snapshotSaved(snapshot));
  applyDeltas(model, deltas);
  const appliedSaved = JSON.parse(model.serialize());
  const state = model.getState();
  const cashYuan = finiteCash(state);
  const completedGov = completedGovernmentBondProjection(state);
  const evaluated = coreRulesEnabled(state) ? evaluateCoreRules(completedGov.state, {
    projectedActions: completedGov.actions, cashYuan,
  }) : { enabled: false, rows: [], blocking: [], missing: [], reason: '当前运行未启用核心规则' };
  // Terminal metrics have no execution order. The deposit gate is checked by
  // the engine at each step; evaluating it in draft order can reject a valid
  // deposit-then-CD path when the CD happens to be listed first in the draft.
  const rules = evaluated.enabled ? {
    ...evaluated,
    rows: evaluated.rows.map(row => (row.ruleId==='C05-DEPOSIT') ? {
      ...row,result:'not_applicable',needed:[],
      reason:'新增存款闸门按该银行6%或8%参数、执行顺序逐笔核验，终态不单独判定',
    } : row),
    blocking: evaluated.blocking.filter(row => !(row.ruleId==='C05-DEPOSIT')),
    missing: evaluated.missing.filter(row => !(row.ruleId==='C05-DEPOSIT')),
  } : evaluated;
  return { model, state, appliedSaved, cashYuan, rules,
    governmentBondSettlementAssumptions: completedGov.assumptions };
}

const coreStatus = trial => trial.cashYuan === null || trial.rules.missing.length ? 'insufficient_data' :
  trial.rules.blocking.length ? 'blocked' : 'feasible';

function inFlightPrerequisites(state) {
  const prerequisites=[];
  for (const instruction of Object.values(state.execution?.instructions ?? {})) {
    if (['unknown','rejected'].includes(instruction.status)) continue;
    const remaining=instruction.nominalYuan-instruction.cancelledYuan;
    const unfilled=remaining-instruction.filledYuan;
    if (unfilled>0) prerequisites.push({kind:'in_flight_fill',planId:instruction.planId,
      instructionId:instruction.instructionId,amountYuan:unfilled,
      condition:'已下达指令仍待成交回报'});
    if (instruction.direction==='outflow') {
      const unpaid=remaining-instruction.settledYuan;
      if (unpaid>0) prerequisites.push({kind:'in_flight_settlement',planId:instruction.planId,
        instructionId:instruction.instructionId,amountYuan:unpaid,
        condition:'已下达指令仍待结算付款'});
    } else {
      const unsettled=instruction.filledYuan-instruction.settledYuan;
      if (unsettled>0) prerequisites.push({kind:'in_flight_settlement',planId:instruction.planId,
        instructionId:instruction.instructionId,amountYuan:unsettled,
        condition:'已成交流入指令仍待结算确认'});
      const credited=Object.values(state.execution.cashFlows ?? {})
        .filter(flow=>flow.type==='cash_available' && flow.instructionId===instruction.instructionId)
        .reduce((sum,flow)=>sum+flow.amountYuan,0);
      const uncredited=remaining-credited;
      if (uncredited>0) prerequisites.push({kind:'in_flight_cash_receipt',planId:instruction.planId,
        instructionId:instruction.instructionId,amountYuan:uncredited,
        condition:'已下达指令仍待资金到账'});
    }
  }
  return prerequisites;
}

function stageConfirmedInFlightFinancing(appliedSaved) {
  const model = createModel(appliedSaved);
  const prerequisites = [];
  for (const instruction of Object.values(model.getState().execution.instructions)) {
    if (!isFinancing(instruction.businessType) || !['accepted', 'partial', 'filled'].includes(instruction.status)) continue;
    const remaining = instruction.nominalYuan - instruction.filledYuan - instruction.cancelledYuan;
    if (remaining > 0) {
      model.simulateEvent('fill', { instructionId: instruction.instructionId, nominalYuan: remaining });
      prerequisites.push({ kind: 'in_flight_fill', instructionId: instruction.instructionId, amountYuan: remaining });
    }
    const filled = model.getState().execution.instructions[instruction.instructionId].filledYuan;
    const credited = Object.values(model.getState().execution.cashFlows).filter(flow =>
      flow.type === 'cash_available' && flow.instructionId === instruction.instructionId)
      .reduce((sum, flow) => sum + flow.amountYuan, 0);
    if (filled > credited) {
      const amountYuan = filled - credited;
      model.simulateEvent('cash_available', { instructionId: instruction.instructionId,
        amountYuan, cashFlowId: `AI-STAGED-${instruction.instructionId}` });
      prerequisites.push({ kind: 'in_flight_cash_receipt', instructionId: instruction.instructionId, amountYuan });
    }
  }
  if (!prerequisites.length) return null;
  const staged = model.generateProposal();
  return { prerequisites, proposal: staged.proposal,
    trace: staged.calculation?.trace ?? null, executionPath: staged.proposal.steps ?? [] };
}

function stageGovernmentPurchases(appliedSaved, assumptions) {
  const model = createModel(appliedSaved);
  const prerequisites = [];
  for (const { planId } of assumptions) {
    // Existing accepted instructions may still need a fill and payment. Unknown
    // sends and cancellation requests are never converted into settled facts.
    for (const instruction of Object.values(model.getState().execution.instructions)
      .filter(item => item.planId === planId)) {
      if (!['accepted', 'partial', 'filled'].includes(instruction.status) || instruction.cancelRequestId) return null;
      const remaining = instruction.nominalYuan - instruction.filledYuan - instruction.cancelledYuan;
      if (remaining > 0) model.simulateEvent('fill', {
        instructionId: instruction.instructionId, nominalYuan: remaining });
      const current = model.getState().execution.instructions[instruction.instructionId];
      const unpaid = current.filledYuan - current.settledYuan;
      if (unpaid > 0) model.simulateEvent('cash_settled', {
        instructionId: instruction.instructionId, amountYuan: unpaid,
        cashFlowId: `AI-STAGED-GOV-${instruction.instructionId}` });
      if (remaining > 0 || unpaid > 0) prerequisites.push({ kind: 'government_purchase_settlement',
        planId, instructionId: instruction.instructionId, nominalYuan: remaining,
        settledYuan: unpaid, requiresFreshReport: true });
    }
    let loops = 0;
    while ((model.getState().summary.planBalances.find(row => row.planId === planId)?.arrangeableYuan ?? 0) > 0) {
      if (++loops > 32) return null;
      const calculated = model.generateProposal();
      const step = calculated.proposal.steps.find(item => item.planId === planId && !item.blocked);
      if (!step || step.nominalYuan <= 0 || !calculated.canApprove) return null;
      model.approveProposal();
      const instructionId = model.send(step.stepId).sentInstructionId;
      model.simulateEvent('accepted', { instructionId });
      model.simulateEvent('fill', { instructionId, nominalYuan: step.nominalYuan });
      model.simulateEvent('cash_settled', { instructionId, amountYuan: step.nominalYuan,
        cashFlowId: `AI-STAGED-GOV-${instructionId}` });
      prerequisites.push({ kind: 'government_purchase_settlement', planId,
        nominalYuan: step.nominalYuan, requiresManagerReview: true,
        requiresFreshReport: true });
    }
  }
  if (!prerequisites.length) return null;
  const staged = model.generateProposal();
  return { prerequisites, proposal: staged.proposal,
    trace: staged.calculation?.trace ?? null, executionPath: staged.proposal.steps ?? [] };
}

/** Apply only plan deltas in an isolated copy, then use the existing engine for the path. */
export function simulateDraft(snapshot, deltas, options = {}) {
  const trial = terminal(snapshot, deltas);
  const originalBalances = new Map((snapshot.state?.summary?.planBalances ?? [])
    .map(row => [row.planId, row]));
  const originalPlanIds = new Set((snapshot.state?.plans ?? []).map(plan => plan.planId));
  const changedTargetPlanIds = deltas.filter(delta => delta.kind !== 'add').map(delta => delta.planId);
  const finalRules = trial.rules;
  const terminalStatus = coreStatus(trial);
  let proposal = null, trace = null, search = null, candidates = [];
  try {
    // Read-only completion checks need terminal metrics, not exhaustive ordering.
    // Keep normal planning unchanged; explicitly bounded checks use the same engine.
    const bounded = options.executionSearch ? calculate(trial.state,
      { ...options.executionSearch, pathId: options.pathId ?? 'AUTO' }) : null;
    const calculated = bounded ? {proposal:bounded.proposal,calculation:bounded}
      : trial.model.generateProposal(options.pathId ?? 'AUTO');
    proposal = calculated.proposal;
    trace = calculated.calculation?.trace ?? null;
    search = trace?.search ?? null;
    candidates = calculated.calculation?.candidates ?? [];
  } catch (error) {
    return { applicable: false, status: 'search_incomplete', deltas: copy(deltas),
      appliedSaved: trial.appliedSaved, finalRules, projectedFinalCashYuan: trial.cashYuan,
      currentAccountCashYuan: trial.state.summary?.accountCashYuan ?? null,
      proposal: null, trace: null, search: { complete: false, boundary: 'engine_error', message: error.message },
      executionPath: [], unmetTargets: [], changedTargetPlanIds };
  }
  const unfinished = proposal?.planCoverage?.filter(row => row.unarrangedYuan > 0) ?? [];
  const unresolvedExecution = Object.keys(trial.state.execution?.pending ?? {}).length > 0 ||
    Object.values(trial.state.execution?.instructions ?? {}).some(instruction =>
      instruction.status === 'unknown' || instruction.cancelRequestId !== null);
  const inFlight=inFlightPrerequisites(trial.state);
  const unconfirmedFinancingResource = (proposal?.blockers ?? []).some(item =>
    /^repo-pledge-(?:missing|short)$/.test(item.code));
  const fullCoverage = proposal?.unarrangedYuan === 0 &&
    ['feasible', 'waiting_conditions'].includes(proposal.status);
  const pendingFinancingYuan = (trial.state.summary?.planBalances ?? []).reduce((sum, balance) => {
    const plan = trial.state.plans.find(item => item.planId === balance.planId);
    return sum + (plan && isFinancing(plan.businessType) ? balance.lockedYuan : 0);
  }, 0);
  // Hypothetical fill/receipt events are applied only to another isolated copy.
  // The candidate's appliedSaved retains the actual unfilled, uncredited facts.
  let staged = null;
  if (!options.executionSearch && !fullCoverage && terminalStatus === 'feasible' && pendingFinancingYuan > 0 &&
      proposal?.unarrangedYuan > 0 && proposal.unarrangedYuan <= pendingFinancingYuan) {
    try { staged = stageConfirmedInFlightFinancing(trial.appliedSaved); }
    catch { staged = null; }
  }
  if (!options.executionSearch && !fullCoverage && terminalStatus === 'feasible' &&
      trial.governmentBondSettlementAssumptions.length &&
      (!staged || staged.proposal.unarrangedYuan > 0)) {
    try { staged = stageGovernmentPurchases(trial.appliedSaved,
      trial.governmentBondSettlementAssumptions); }
    catch { staged = null; }
  }
  const contingentCoverage = !!staged && staged.proposal.unarrangedYuan === 0 &&
    ['feasible', 'waiting_conditions'].includes(staged.proposal.status);
  // A pre-existing breach may remain while each proposed action improves it.
  const progressive = fullCoverage && terminalStatus === 'blocked' &&
    Array.isArray(trace?.steps) && trace.steps.length > 0 &&
    trace.steps.every(step => Array.isArray(step.rules) &&
      !step.rules.some(row => row.result === 'block' || row.result === 'missing'));
  const applicable = !unresolvedExecution && !unconfirmedFinancingResource &&
    (fullCoverage || contingentCoverage) &&
    (terminalStatus === 'feasible' || progressive) && finalRules.missing.length === 0;
  const status = unresolvedExecution ? 'unresolved_execution' :
    terminalStatus === 'insufficient_data' || proposal?.status === 'insufficient_data' ? 'insufficient_data' :
    applicable ? (inFlight.length || contingentCoverage ? 'waiting_conditions' :
      progressive ? 'improving' : proposal.status) :
      proposal?.status === 'search_exhausted' || search?.truncated ? 'search_incomplete' : 'blocked';
  const executionPath = (proposal?.steps ?? []).map(step => ({
    stepId: step.stepId, planId: step.planId, nominalYuan: step.nominalYuan,
    condition: step.condition, machineConditions: step.machineConditions,
    blocked: step.blocked,
  }));
  if (contingentCoverage) executionPath.splice(0, executionPath.length,
    ...staged.prerequisites,
    ...staged.executionPath.map(step => ({ kind: 'conditional_step', stepId: step.stepId,
      planId: step.planId, nominalYuan: step.nominalYuan, condition: step.condition,
      machineConditions: step.machineConditions, blocked: step.blocked })));
  if (inFlight.length) executionPath.unshift(...inFlight.map(item=>({
    kind:item.kind,planId:item.planId,instructionId:item.instructionId,
    nominalYuan:item.amountYuan,condition:item.condition,blocked:false,
    machineConditions:[],
  })));
  return { applicable, status, deltas: copy(deltas), appliedSaved: trial.appliedSaved,
    finalRules, proposal, trace, search, candidates, executionPath,
    governmentBondSettlementAssumptions: trial.governmentBondSettlementAssumptions,
    executionAuthority: 'requires_refresh_review_and_manual_dispatch',
    projectedFinalCashYuan: trial.cashYuan,
    currentAccountCashYuan: trial.state.summary?.accountCashYuan ?? null,
    unmetTargets: unfinished,
    conditionalUnarrangedYuan: contingentCoverage ? proposal.unarrangedYuan : 0,
    inFlightPrerequisites: inFlight,
    requiresInFlightFinancingReceipt: contingentCoverage && staged.prerequisites.some(item =>
      item.kind === 'in_flight_cash_receipt'),
    unresolvedExecution, unconfirmedFinancingResource,
    stagedVerification: staged && { prerequisites: staged.prerequisites,
      proposal: staged.proposal, trace: staged.trace },
    changedTargetPlanIds,
    previousTargetBalances: Object.fromEntries(changedTargetPlanIds.filter(id => originalPlanIds.has(id))
      .map(id => [id, originalBalances.get(id) ?? null])),
  };
}

function repoPlan(state, kind, tenorDays, amountYuan) {
  return { label: kind === 'financing' ? `AI建议${tenorDays}天正回购` : `AI建议${tenorDays}天逆回购`,
    businessType: kind === 'financing' ? 'interbank_repo_financing' : 'reverse_repo',
    direction: kind === 'financing' ? 'inflow' : 'outflow',
    counterpartyId: null, issuerId: null, securityId: null, marketTier: null,
    targetYuan: amountYuan, termsNote: 'AI拟单草案；经理确认后仍须审核和手动下达',
    repoTerms: { market: 'INTERBANK', tenorDays, annualRate: null },
    tradeDate: state.context.businessDate, settlementDate: state.context.businessDate };
}

function targetDelta(state, planId, amountYuan, kind, tenorDays) {
  if (planId) {
    const existing = state.plans.find(plan => plan.planId === planId);
    if (!existing) throw new Error(`${kind}计划ID不存在`);
    if (existing.businessType !== (kind === 'financing' ? 'interbank_repo_financing' : 'reverse_repo'))
      throw new Error(`${kind}计划业务类型不符`);
    if (existing.repoTerms?.tenorDays !== tenorDays) throw new Error(`${kind}期限与已有计划不一致`);
    const balance = state.summary.planBalances.find(row => row.planId === planId);
    if (amountYuan < balance.filledYuan + balance.lockedYuan)
      throw new Error(`${kind}意向金额低于已成交及在途金额`);
    if (amountYuan === existing.targetYuan) return [];
    if (amountYuan === 0) return [{ kind: 'delete', planId }];
    return [{ kind: 'update', planId, patch: { targetYuan: amountYuan } }];
  }
  return amountYuan === 0 ? [] : [{ kind: 'add', plan: repoPlan(state, kind, tenorDays, amountYuan) }];
}

function searchResult(reason, detail = {}) {
  return { status: reason, main: null, alternative: null,
    search: { complete: false, boundary: reason, ...detail } };
}

/** Minimise total financing first; at that amount maximise uncommitted reverse repo. */
export function solveFundingAndReverseRepo(snapshot, intent, options = {}) {
  const state = snapshot?.state;
  if (!serializable(state) || !serializable(intent) || !Array.isArray(intent.fixedPlans))
    throw new Error('联合求解输入无效');
  if (!coreRulesEnabled(state)) return searchResult('insufficient_data', { reason: '当前运行未启用核心规则' });
  const budget = options.evaluationBudget ?? 160;
  integer(budget, '求解预算', false);
  if (budget > 4096) throw new Error('求解预算超过安全上限4096');
  const financing = intent.financing ?? {};
  const reverse = intent.reverseRepo ?? {};
  const financingTenor = financing.tenorDays ?? state.plans.find(p => p.planId === financing.planId)?.repoTerms?.tenorDays ?? 1;
  const reverseTenor = reverse.tenorDays ?? state.plans.find(p => p.planId === reverse.planId)?.repoTerms?.tenorDays ?? 7;
  integer(financingTenor, '融资期限', false);
  integer(reverseTenor, '逆回购期限', false);
  const financeUnit = unitFor('interbank_repo_financing');
  const reverseUnit = unitFor('reverse_repo');
  const fUnit = financing.unitYuan ?? financeUnit;
  const rUnit = reverse.unitYuan ?? reverseUnit;
  integer(fUnit, '融资交易单位', false);
  integer(rUnit, '逆回购交易单位', false);
  if (fUnit % financeUnit || rUnit % reverseUnit) throw new Error('拟单交易单位低于业务单位');
  const fPlan = financing.planId ? state.plans.find(p => p.planId === financing.planId) : null;
  const rPlan = reverse.planId ? state.plans.find(p => p.planId === reverse.planId) : null;
  if (financing.planId && !fPlan || reverse.planId && !rPlan) throw new Error('已有回购计划ID无效');
  if (fPlan && fPlan.businessType !== 'interbank_repo_financing' ||
      rPlan && rPlan.businessType !== 'reverse_repo') throw new Error('已有回购计划类型无效');
  const fBalance = fPlan && state.summary.planBalances.find(row => row.planId === fPlan.planId);
  const rBalance = rPlan && state.summary.planBalances.find(row => row.planId === rPlan.planId);
  const fBase = fPlan?.targetYuan ?? 0;
  const rBase = rPlan?.targetYuan ?? 0;
  const fMin = fBase;
  const rMin = rBalance ? rBalance.filledYuan + rBalance.lockedYuan : 0;
  if (fPlan && fPlan.repoTerms?.tenorDays !== financingTenor ||
      rPlan && rPlan.repoTerms?.tenorDays !== reverseTenor) throw new Error('期限与已有回购计划不一致');
  const explicitR = reverse.amountYuan !== null && reverse.amountYuan !== undefined;
  const requestedR = explicitR ?
    (rPlan && reverse.amountYuan === rBase
      ? aligned(reverse.amountYuan, reverseUnit, '既有逆回购金额')
      : aligned(reverse.amountYuan, rUnit, '固定逆回购金额')) : rBase;
  if (explicitR && requestedR < rMin) return searchResult('blocked', { reason: '逆回购固定意向金额低于已成交与在途金额' });
  // A search envelope keeps the unbounded intent computationally finite. It
  // is disclosed as a search boundary, never presented as a financing quota.
  const maxSafeBound = floorUnit(Math.floor(Number.MAX_SAFE_INTEGER / 16),fUnit);
  const knownScale = [state.inputs?.navYuan,state.summary?.availableYuan,
    state.inputs?.bufferYuan,requestedR,...state.plans.map(plan => plan.targetYuan),
    ...intent.fixedPlans.map(plan => plan.targetYuan)]
    .filter(Number.isSafeInteger).reduce((sum,value) => Math.min(maxSafeBound,sum + Math.abs(value)),fUnit);
  const searchBound = floorUnit(Math.min(maxSafeBound,Math.max(fBase,knownScale * 2)),fUnit);
  const explicitBound = financing.maxAmountYuan == null ? null :
    aligned(financing.maxAmountYuan,fUnit,'本次融资意向上限');
  const fMax = explicitBound ?? searchBound;
  if (fMax < fMin) return searchResult('blocked', { reason: '本次融资意向上限小于既有计划' });
  const fixed = intent.fixedPlans.map(plan => {
    if (!serializable(plan) || !Number.isSafeInteger(plan.targetYuan) || plan.targetYuan <= 0 ||
        typeof plan.businessType !== 'string' || !Number.isSafeInteger(unitFor(plan.businessType)) ||
        plan.targetYuan % unitFor(plan.businessType)) throw new Error('固定计划金额或业务类型无效');
    if (['interbank_repo_financing', 'exchange_repo_financing', 'reverse_repo',
      'exchange_repo_lending'].includes(plan.businessType))
      throw new Error('融资及逆回购须使用专用求解字段');
    return { kind: 'add', plan: copy(plan) };
  });
  const baseDeltas = (f, r) => [
    ...fixed,
    ...targetDelta(state, financing.planId, f, 'financing', financingTenor),
    ...targetDelta(state, reverse.planId, r, 'reverse', reverseTenor),
  ];
  const cache = new Map();
  let evaluations = 0;
  const assess = (f, r) => {
    const key = `${f}/${r}`;
    if (cache.has(key)) return cache.get(key);
    if (evaluations >= budget) return null;
    evaluations++;
    try {
      const trial = terminal(snapshot, baseDeltas(f, r));
      const outcome = { status: coreStatus(trial), cashYuan: trial.cashYuan,
        rows: trial.rules.rows,
        blocking: trial.rules.blocking, missing: trial.rules.missing };
      cache.set(key, outcome);
      return outcome;
    } catch (error) {
      const outcome = { status: 'blocked', reason: error.message, blocking: [], missing: [] };
      cache.set(key, outcome);
      return outcome;
    }
  };
  const findMinimumFinance = r => {
    const unit = fUnit;
    const lo0 = 0, hi0 = Math.floor((fMax - fMin) / unit);
    const top = assess(fMin + hi0 * unit, r);
    if (!top) return { amount: null, budget: true };
    if (top.status !== 'feasible') return { amount: null, top };
    let lo = lo0, hi = hi0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const result = assess(fMin + mid * unit, r);
      if (!result) return { amount: null, budget: true };
      if (result.status === 'feasible') hi = mid;
      else lo = mid + 1;
    }
    return { amount: fMin + lo * unit };
  };
  const minimum = findMinimumFinance(requestedR);
  const search = { complete: false, terminalBoundComplete: !minimum.budget && explicitBound !== null,
    boundary: minimum.budget ? 'evaluation_budget' : 'execution_paths_not_exhausted',
    evaluations, evaluationBudget: budget, financingRangeYuan: [fMin, fMax],
    financingBoundSource:explicitBound === null?'derived_search_envelope':'explicit_intent_maximum',
    financingUnitYuan: fUnit, reverseRepoUnitYuan: rUnit,
    strategy: 'monotone_financing_bound_then_reverse_repo_bound; shared_core_and_engine_verified' };
  let main = null;
  if (minimum.amount !== null) {
    const f = minimum.amount;
    let r = requestedR;
    if (!explicitR && !rPlan) {
      // With financing fixed, C01/C02 cash and C09 limit the added reverse repo.
      const atZero = assess(f, 0);
      const c01 = atZero?.rows?.find(row => row.ruleId === 'C01');
      const c02 = atZero?.rows?.find(row => row.ruleId === 'C02');
      const headrooms = [c01?.headroomYuan, c02?.headroomYuan,
        Number.isSafeInteger(atZero?.cashYuan) && Number.isSafeInteger(state.inputs?.bufferYuan)
          ? atZero.cashYuan - state.inputs.bufferYuan : null];
      const cashCap = headrooms.every(Number.isSafeInteger)
        ? floorUnit(Math.max(0, Math.min(...headrooms)), rUnit) : 0;
      let lo = 0, hi = Math.floor(cashCap / rUnit);
      while (lo < hi && evaluations < budget) {
        const mid = Math.ceil((lo + hi) / 2);
        const test = assess(f, mid * rUnit);
        if (test?.status === 'feasible') lo = mid;
        else hi = mid - 1;
      }
      if (lo < hi) { search.terminalBoundComplete = false; search.boundary = 'evaluation_budget'; }
      r = lo * rUnit;
    }
    main = simulateDraft(snapshot, baseDeltas(f, r), options);
    main.financingYuan = f;
    main.reverseRepoYuan = r;
    main.financingAmountYuan = f;
    main.reverseRepoAmountYuan = r;
    main.requiresTargetChange = false;
    main.search = { ...search, engine: main.search };
  }
  let alternative = null;
  if (intent.allowReduceReverseRepo === true && rPlan && rMin < rBase &&
      (!main || main.financingAmountYuan > fMin)) {
    // First seek the least borrowing possible with only the immutable reverse-repo amount.
    const altMin = findMinimumFinance(rMin);
    if (altMin.amount !== null) {
      const f = altMin.amount;
      let lo = Math.ceil(rMin / rUnit), hi = Math.floor((rBase - rUnit) / rUnit);
      while (lo < hi && evaluations < budget) {
        const mid = Math.ceil((lo + hi) / 2);
        if (assess(f, mid * rUnit)?.status === 'feasible') lo = mid;
        else hi = mid - 1;
      }
      const r = lo * rUnit;
      if (r < rBase) {
        alternative = simulateDraft(snapshot, baseDeltas(f, r), options);
        alternative.financingYuan = f;
        alternative.reverseRepoYuan = r;
        alternative.financingAmountYuan = f;
        alternative.reverseRepoAmountYuan = r;
        alternative.requiresTargetChange = true;
        alternative.targetChange = { planId: rPlan.planId, fromYuan: rBase, toYuan: r,
          reductionYuan: rBase - r, requiresManagerConsent: true };
        alternative.search = { ...search, engine: alternative.search };
      }
      if (lo < hi) { search.terminalBoundComplete = false; search.boundary = 'evaluation_budget'; }
    }
  }
  search.evaluations = evaluations;
  if (!main && minimum.top?.status === 'insufficient_data') return {
    status: 'insufficient_data', main, alternative, search,
    limitations: minimum.top.missing,
  };
  if (!main && minimum.top?.status === 'blocked') {
    // A terminal breach can still admit a gradual-improvement path. Verify it
    // with the shared engine instead of treating the terminal bound as universal.
    main = simulateDraft(snapshot, baseDeltas(fMax, requestedR), options);
    main.financingYuan = fMax;
    main.reverseRepoYuan = requestedR;
    main.financingAmountYuan = fMax;
    main.reverseRepoAmountYuan = requestedR;
    main.requiresTargetChange = false;
    main.search = { ...search, engine: main.search };
    if (main.status === 'improving') {
      search.terminalBoundComplete = false;
      search.boundary = 'improvement_financing_not_optimized';
      main.search.boundary = search.boundary;
    }
  }
  if (main && !main.applicable && minimum.amount !== null && fMax > minimum.amount) {
    // Final feasibility is monotone for the bounded variables; execution order
    // is not. Probe the upper boundary without claiming path exhaustion.
    const upper = simulateDraft(snapshot, baseDeltas(fMax, main.reverseRepoYuan), options);
    if (upper.applicable) {
      upper.financingYuan = fMax;
      upper.reverseRepoYuan = main.reverseRepoYuan;
      upper.financingAmountYuan = fMax;
      upper.reverseRepoAmountYuan = main.reverseRepoYuan;
      upper.requiresTargetChange = false;
      upper.search = { ...search, engine: upper.search };
      main = upper;
    }
  }
  // The deposit gate is deliberately excluded: a terminal exposure over the bank-specific deposit limit
  // may still be reachable by depositing first and buying a CD afterward.
  const invariantBankRules = new Set(['C03', 'C04', 'C05', 'C06', 'C07', 'C08']);
  const terminalProof = minimum.top?.status === 'blocked' && !minimum.budget &&
    minimum.top.blocking?.some(row => invariantBankRules.has(row.ruleId));
  const status = main?.applicable ? (main.status === 'improving' ? 'improving' : 'feasible') :
    alternative?.applicable ? 'blocked_with_alternative' :
    terminalProof ? 'blocked' : 'search_incomplete';
  return { status, main, alternative, search,
    limitations: !main?.applicable ? minimum.top?.blocking ?? [] : [],
    originalReverseRepoTargetYuan: rBase,
    requestedReverseRepoTargetYuan: requestedR,
  };
}
