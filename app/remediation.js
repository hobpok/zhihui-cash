// Read-only, bounded discovery of sales that release an indivisible deposit's
// company-bank headroom. Every returned candidate is verified by the shared solver.
import { bankIdForPlan, bankDepositLimitBps } from './initial-data.js';
import { evaluateCoreRules } from './core-rules.js';
import { isSecuritySale, unitFor } from './business.js';
import { validateIntent, solveFundingAndReverseRepo } from './planning.js';

const copy = value => structuredClone(value);
const known = value => Number.isSafeInteger(value) && value >= 0;
const sum = values => {
  if (!values.every(known)) return null;
  const total = values.reduce((n, value) => n + BigInt(value), 0n);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
};
const numeric = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return known(n) ? n : null;
};
const saleMatches = (plan, security) => security && plan.issuerId === security.issuerBankId &&
  (plan.businessType === 'cd_sell' ? security.instrumentKind === 'cd' :
    plan.businessType === 'bond_sell' && security.instrumentKind === 'bond');

// Mirror current holding facts, then reserve the ENTIRE remaining sale intention.
// Merely accepted purchases never become sellable inventory. Existing sales,
// including their unarranged amounts, cannot be reused by a corrective sale.
function saleInventory(state, fixedPlans) {
  const t = state.initialData;
  const balances = new Map(state.summary.planBalances.map(row => [row.planId, row]));
  const instructions = Object.values(state.execution.instructions);
  const matured = new Set(t.maturityCashEvents.filter(e =>
    e.dueDate <= state.context.businessDate && e.sourceHoldingId).map(e => e.sourceHoldingId));
  return t.securities.filter(s => s.issuerBankId && ['cd', 'bond'].includes(s.instrumentKind)).map(security => {
    const holdings = t.holdings.filter(h => h.securityId === security.securityId && !matured.has(h.holdingId));
    let total = sum(holdings.map(h => h.sellableYuan));
    const additions = [], deductions = [], reservations = [];
    for (const trade of t.pendingSettlements.filter(x => x.securityId === security.securityId && !x.holdingIncludedAtOpen)) {
      if (trade.direction === 'inflow') deductions.push(trade.amountYuan);
      else if (trade.settlementDate <= state.context.businessDate) additions.push(trade.cashIncludedAtOpen
        ? trade.amountYuan : sum(Object.values(state.execution.cashEventReceipts)
          .filter(receipt => receipt.sourceId === trade.tradeId).map(receipt => receipt.amountYuan)));
    }
    for (const instruction of instructions.filter(i => i.securityId === security.securityId && i.status !== 'rejected')) {
      if (['cd_buy', 'bond_buy'].includes(instruction.businessType)) additions.push(instruction.settledYuan);
      else if (isSecuritySale(instruction.businessType)) deductions.push(instruction.filledYuan);
    }
    let releaseYuan = 0, invalidReservation = false;
    for (const plan of state.plans.filter(p => p.securityId === security.securityId && isSecuritySale(p.businessType))) {
      const remaining = balances.get(plan.planId)?.remainingYuan;
      reservations.push(remaining);
      if (!saleMatches(plan, security)) invalidReservation = true;
      if (known(remaining)) releaseYuan += remaining;
    }
    for (const plan of fixedPlans.filter(p => p.securityId === security.securityId && isSecuritySale(p.businessType))) {
      reservations.push(plan.targetYuan);
      if (!saleMatches(plan, security)) invalidReservation = true;
      releaseYuan += plan.targetYuan;
    }
    const add = sum(additions), deduct = sum(deductions), reserved = sum(reservations);
    if ([total, add, deduct, reserved].some(n => n === null)) total = null;
    else {
      const current = BigInt(total) + BigInt(add) - BigInt(deduct);
      total = current >= 0n && current <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(current) : null;
    }
    const validReservations = !invalidReservation && total !== null && reserved !== null && reserved <= total;
    return { security, availableYuan: validReservations ? total - reserved : total === null ? null : 0,
      existingReleaseYuan: validReservations && known(releaseYuan) ? releaseYuan : 0,
      missing: total === null || reserved === null, invalidReservation };
  });
}

function allocations(holdings, need, limit) {
  const variants = [], seen = new Set();
  const add = entries => {
    const key = entries.map(x => `${x.item.security.securityId}:${x.amountYuan}`).sort().join('|');
    if (entries.length && !seen.has(key) && variants.length < limit) { seen.add(key); variants.push(entries); }
  };
  // Try each security alone, and greedy combinations with each holding leading.
  // No exhaustive claim: amount splits between these boundaries remain unsearched.
  for (const item of holdings.filter(item => item.security.instrumentKind === 'cd'))
    if (item.availableYuan >= need) add([{ item, amountYuan: need }]);
  for (let first = 0; first < holdings.length && variants.length < limit; first++) {
    const order = [holdings[first], ...holdings.filter((_, index) => index !== first)];
    const entries = []; let left = need;
    for (const item of order) {
      const unit = unitFor(item.security.instrumentKind === 'cd' ? 'cd_sell' : 'bond_sell');
      const amountYuan = Math.min(left, Math.floor(item.availableYuan / unit) * unit);
      if (amountYuan > 0) { entries.push({ item, amountYuan }); left -= amountYuan; }
      if (!left) { add(entries); break; }
    }
  }
  return variants;
}

/** No model mutations, dispatch, AI call, or global infeasibility claim. */
export function findRemediation(snapshot, input, options = {}) {
  const { baseResult, remediationBudget = 24, maxHoldings = 8, ...solverOptions } = options;
  if (!Number.isSafeInteger(remediationBudget) || remediationBudget < 1 || remediationBudget > 128 ||
      !Number.isSafeInteger(maxHoldings) || maxHoldings < 1 || maxHoldings > 32)
    throw new Error('补救搜索预算须为1–128、持仓上限须为1–32的整数');
  const checked = validateIntent(snapshot, input);
  const search = { complete: false, boundary: 'bounded_sale_allocations',
    strategy: 'same_bank_cd_then_bank_bond; original_targets_and_full_execution_path_verified',
    attemptedVariants: 0, remediationBudget, maxHoldings, requiredReleases: [], rejected: [] };
  if (!checked.ok) return { status: 'invalid_intent', intent: input, result: baseResult ?? null,
    actions: [], reasons: checked.errors.map(message => ({ code: 'invalid_intent', message })), search };
  const intent = checked.intent;
  const strictIntent = { ...intent, allowReduceReverseRepo: false };
  const base = baseResult ?? solveFundingAndReverseRepo(snapshot, strictIntent, solverOptions);
  const finish = (status, reasons) => ({ status, intent: copy(intent), result: base, actions: [], reasons, search });
  if (base.main?.applicable && !base.main.finalRules?.blocking?.length && !base.main.finalRules?.missing?.length)
    return finish('not_needed', [{ code: 'original_target_feasible', message: '原目标已有经校验的主方案，无需新增补救卖券。' }]);
  const state = snapshot.state, t = state.initialData;
  const inventory = saleInventory(state, intent.fixedPlans);
  const balances = new Map(state.summary.planBalances.map(row => [row.planId, row]));
  const deposits = [...state.plans.map(plan => ({ plan, amountYuan: balances.get(plan.planId)?.arrangeableYuan,
    id: plan.planId })), ...intent.fixedPlans.map((plan, index) => ({ plan, amountYuan: plan.targetYuan,
    id: `fixedPlans[${index}]` }))].filter(row => row.plan.businessType === 'deposit' && row.amountYuan !== 0);
  const rows = evaluateCoreRules(state).rows;
  const groups = [], reasons = [];
  const bankIds = [...new Set(deposits.map(row => bankIdForPlan(row.plan, t)))];
  for (const bankId of bankIds) {
    const bank = t.banks.find(b => b.bankId === bankId);
    const bankDeposits = deposits.filter(row => bankIdForPlan(row.plan, t) === bankId);
    const company = rows.find(row => row.ruleId === 'C05' && row.subjectId === bankId);
    const current = numeric(company?.numeratorYuan), denominator = numeric(company?.denominatorYuan);
    const pendingDeposit = sum(bankDeposits.map(row => row.amountYuan));
    if (!bank || current === null || denominator === null || denominator <= 0 || pendingDeposit === null ||
        !bank.quarterEnd || bank.quarterEnd > state.context.businessDate) {
      reasons.push({ code: 'missing_company_exposure', bankId,
        message: '公司同银行敞口、季度净资产或剩余整笔存款金额缺失，不能推定可释放额度。' });
      continue;
    }
    const released = sum(inventory.filter(item => item.security.issuerBankId === bankId).map(item => item.existingReleaseYuan));
    if (released === null) { reasons.push({ code: 'missing_sale_inventory', bankId, message: '已有卖券可释放额度不完整。' }); continue; }
    const cap = BigInt(denominator) * BigInt(bankDepositLimitBps(bank)) / 10000n;
    const rawNeed = BigInt(current) + BigInt(pendingDeposit) - cap - BigInt(released);
    if (rawNeed <= 0n) continue;
    const unit = unitFor('cd_sell');
    const rounded = (rawNeed + BigInt(unit) - 1n) / BigInt(unit) * BigInt(unit);
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
      reasons.push({ code: 'missing_company_exposure', bankId, message: '释放额度超过安全金额范围。' }); continue;
    }
    const need = Number(rounded);
    const eligible = inventory.filter(item => item.security.issuerBankId === bankId && item.availableYuan > 0)
      .sort((a, b) => Number(a.security.instrumentKind !== 'cd') - Number(b.security.instrumentKind !== 'cd') ||
        a.security.securityId.localeCompare(b.security.securityId));
    const missing = inventory.some(item => item.security.issuerBankId === bankId && item.missing);
    search.requiredReleases.push({ bankId, amountYuan: need, depositPlanIds: bankDeposits.map(row => row.id),
      eligibleHoldings: eligible.length, scannedHoldings: Math.min(eligible.length, maxHoldings),
      omittedHoldings: Math.max(0, eligible.length - maxHoldings) });
    const variants = allocations(eligible.slice(0, maxHoldings), need, remediationBudget);
    if (!variants.length) reasons.push({ code: missing ? 'missing_sale_inventory' : 'insufficient_sellable_inventory', bankId,
      requiredReleaseYuan: need, message: missing ? '同银行部分持仓可卖量缺失，不能确认补救卖券。' :
        '本次有界扫描内的同银行可卖量不足；已有卖券、在途占用和原固定计划均已扣除。' });
    groups.push({ bankId, depositPlanIds: bankDeposits.map(row => row.id), variants,
      currentCompanyExposureYuan: current, depositYuan: pendingDeposit,
      existingReleaseYuan: released, companyLimitYuan: Number(cap), requiredReleaseYuan: need });
  }
  if (reasons.length) return finish(reasons.some(row => row.code.startsWith('missing_')) ? 'insufficient_data' : 'not_found', reasons);
  if (!groups.length) return finish('not_found', [{ code: 'no_deposit_gate_release_identified',
    message: '未识别需新增卖券释放的存款公司闸门；其他约束仍以原求解结果为准。' }]);
  let found = null;
  const visit = (index, entries) => {
    if (found || search.attemptedVariants >= remediationBudget) return;
    if (index < groups.length) {
      for (const variant of groups[index].variants) {
        visit(index + 1, [...entries, ...variant.map(entry => ({ ...entry, group: groups[index] }))]);
        if (found || search.attemptedVariants >= remediationBudget) break;
      }
      return;
    }
    search.attemptedVariants++;
    const actions = entries.map(({ item, amountYuan, group }) => ({ securityId: item.security.securityId,
      businessType: item.security.instrumentKind === 'cd' ? 'cd_sell' : 'bond_sell', targetYuan: amountYuan,
      bankId: group.bankId, depositPlanIds: copy(group.depositPlanIds),
      reason: `公司敞口${group.currentCompanyExposureYuan / 100000000}亿元，待存款${group.depositYuan / 100000000}亿元，上限${group.companyLimitYuan / 100000000}亿元；扣除已有卖券计划可释放的${group.existingReleaseYuan / 100000000}亿元，仍须新增释放至少${group.requiredReleaseYuan / 100000000}亿元。卖券实际成交才释放额度，付款另核账户现金。`,
      requiresManagerConfirmation: true }));
    const augmented = { ...copy(strictIntent), fixedPlans: [...copy(intent.fixedPlans), ...actions.map(action => ({
      label: `补救建议：卖出${t.securities.find(s => s.securityId === action.securityId).label}`,
      businessType: action.businessType, direction: 'inflow', counterpartyId: null, issuerId: action.bankId,
      securityId: action.securityId, targetYuan: action.targetYuan, marketTier: 'secondary', repoTerms: null,
      tradeDate: state.context.businessDate, settlementDate: state.context.businessDate,
      termsNote: '只读补救候选；经理确认后仍须刷新、审核并手动下达',
    }))] };
    const validation = validateIntent(snapshot, augmented);
    if (!validation.ok) { search.rejected.push({ status: 'invalid_intent', errors: validation.errors }); return; }
    const result = solveFundingAndReverseRepo(snapshot, validation.intent, solverOptions);
    if (result.main?.applicable && !result.main.requiresTargetChange &&
        !result.main.finalRules.blocking.length && !result.main.finalRules.missing.length) {
      found = { status: 'candidate', intent: validation.intent, result, actions,
        reasons: [{ code: 'verified_sale_remediation', message: '已核算新增卖券后的完整原计划及逐步执行路径；须经理确认并满足成交、到账等条件。' }], search };
    } else search.rejected.push({ status: result.status, candidateStatus: result.main?.status ?? null,
      blockingRuleIds: [...new Set([...(result.main?.finalRules?.blocking ?? []), ...(result.limitations ?? [])]
        .map(row => row.ruleId).filter(Boolean))] });
  };
  visit(0, []);
  if (found) return found;
  if (search.attemptedVariants >= remediationBudget) search.boundary = 'remediation_budget';
  return finish('not_found', [{ code: 'bounded_candidates_rejected',
    message: '本次有界卖券候选未通过完整原目标与执行路径校验，不能据此认定全局无解。' }]);
}
