// Read-only, bounded explanation of the current execution state. No journal leaves this module.
import { evaluateCoreRules } from './core-rules.js';

const MAX_PLANS = 128;
const MAX_ACTIONS = 64;
const safeMoney = x => Number.isSafeInteger(x) ? x : null;
const safeText = (x, n = 160) => typeof x === 'string' ? x.slice(0, n) : null;
const rows = x => Array.isArray(x) ? x : [];
const rule = x => ({
  ruleId: safeText(x?.ruleId, 40), result: safeText(x?.result, 24),
  currentValue: Number.isFinite(x?.currentValue) ? x.currentValue : null,
  projectedValue: Number.isFinite(x?.projectedValue) ? x.projectedValue : null,
  headroomYuan: safeMoney(x?.headroomYuan),
  needed: rows(x?.needed).slice(0, 8).map(x => safeText(x, 80)),
});
const unique = values => [...new Set(values.filter(Boolean))];

export function diagnoseExecution(state) {
  // Saved ordering is historical evidence only; current next-trade rules are recalculated below.
  const proposal = state.proposal ?? {};
  const trace = rows(state.calculation?.trace?.steps);
  const balances = new Map(rows(state.summary?.planBalances).map(x => [x.planId, x]));
  const savedCoverage = rows(proposal.planCoverage);
  const proposalCoverageMatches = savedCoverage.length === rows(state.plans).length &&
    savedCoverage.every(x => {
      const b = balances.get(x.planId);
      return b && ['targetYuan','filledYuan','lockedYuan','remainingYuan'].every(key => x[key] === b[key]);
    });
  const currentRules = rows(state.coreRules?.rows);
  const resultCounts = {};
  for (const item of currentRules) resultCounts[item.result] = (resultCounts[item.result] ?? 0) + 1;
  const portfolioRule = code => currentRules.find(x => x.ruleId === code && x.subjectId === 'PORTFOLIO');
  const unfinished = rows(state.plans).filter(plan => (balances.get(plan.planId)?.remainingYuan ?? 0) > 0);
  const planReports = unfinished.slice(0, MAX_PLANS).map(plan => {
    const balance = balances.get(plan.planId);
    const amount = balance.arrangeableYuan;
    // This is an isolated immediate next-trade check, not a proof about all possible orderings.
    const immediate = amount > 0 && state.coreRules?.enabled
      ? evaluateCoreRules(state, { plan, amountYuan: amount }) : null;
    const immediateBlockers = rows(immediate?.rows).filter(x =>
      ['block','missing','closed'].includes(x.result)).slice(0, 12).map(rule);
    const proposalBlockers = (proposalCoverageMatches ? rows(proposal.blockers) : [])
      .filter(x => x.planId === plan.planId)
      .slice(0, 6).map(x => ({ code: safeText(x.code, 60), severity: safeText(x.severity, 24),
        ruleId: /^core-(C\d+(?:-DEPOSIT)?)$/.exec(x.code ?? '')?.[1] ?? null }));
    const coverage = proposalCoverageMatches ? savedCoverage.find(x => x.planId === plan.planId) : null;
    const staleProposalBlocker = immediate && immediateBlockers.length === 0 &&
      proposalBlockers.some(x => x.severity === 'block');
    return {
      planId: safeText(plan.planId, 128), businessType: safeText(plan.businessType, 48),
      label: safeText(plan.label, 100), targetYuan: safeMoney(plan.targetYuan),
      filledYuan: safeMoney(balance.filledYuan), lockedYuan: safeMoney(balance.lockedYuan),
      remainingYuan: safeMoney(balance.remainingYuan), arrangeableYuan: safeMoney(amount),
      suggestedYuan: safeMoney(coverage?.suggestedYuan), unarrangedYuan: safeMoney(coverage?.unarrangedYuan),
      immediateBlockers, proposalBlockers, proposalBlockersBasis:'saved_proposal_historical',
      staleProposalBlocker,
      reasonClass: immediateBlockers.some(x => x.result === 'missing') ? 'missing_data' :
        immediateBlockers.length ? 'rule_blocked' :
        staleProposalBlocker ? 'saved_proposal_requires_recalculation' :
        !coverage ? 'not_recalculated' :
        (coverage?.unarrangedYuan ?? 0) > 0 ? 'unarranged_or_order_dependent' : 'arranged',
    };
  });

  const cashFlows = Object.values(state.execution?.cashFlows ?? {});
  const creditedByInstruction = new Map();
  let creditedInflowYuan = 0;
  for (const flow of cashFlows.filter(x => x.type === 'cash_available')) {
    creditedInflowYuan += flow.amountYuan;
    if (flow.instructionId) creditedByInstruction.set(flow.instructionId,
      (creditedByInstruction.get(flow.instructionId) ?? 0) + flow.amountYuan);
  }
  const instructions = Object.values(state.execution?.instructions ?? {});
  const paidOutflowYuan = instructions.filter(x => x.direction === 'outflow')
    .reduce((sum, x) => sum + x.settledYuan, 0);
  const openingCashEventsNetYuan = Object.values(state.execution?.cashEventReceipts ?? {})
    .reduce((sum, x) => sum + (x.direction === 'inflow' ? x.amountYuan : -x.amountYuan), 0);
  const initialCashYuan = safeMoney(state.execution?.initialCashYuan);
  const calculatedAccountCashYuan = initialCashYuan === null ? null :
    initialCashYuan + creditedInflowYuan - paidOutflowYuan + openingCashEventsNetYuan;
  const settlementActions = [];
  for (const instruction of instructions) {
    if (settlementActions.length >= MAX_ACTIONS) break;
    const credited = creditedByInstruction.get(instruction.instructionId) ?? 0;
    const uncredited = instruction.direction === 'inflow' ?
      Math.max(0, (instruction.businessType?.includes('financing') ? instruction.filledYuan : instruction.settledYuan) - credited) : 0;
    const unsettled = Math.max(0, instruction.filledYuan - instruction.settledYuan);
    if (instruction.status === 'unknown') settlementActions.push({kind:'verify_unknown',
      instructionId:safeText(instruction.instructionId,128), planId:safeText(instruction.planId,128),
      businessType:safeText(instruction.businessType,48), amountYuan:safeMoney(instruction.nominalYuan)});
    if (unsettled && instruction.direction === 'inflow' && !instruction.businessType?.includes('financing'))
      settlementActions.push({kind:'settle_inflow', instructionId:safeText(instruction.instructionId,128),
        planId:safeText(instruction.planId,128), businessType:safeText(instruction.businessType,48),
        amountYuan:safeMoney(unsettled)});
    if (uncredited) settlementActions.push({kind:'receive_cash',
      instructionId:safeText(instruction.instructionId,128), planId:safeText(instruction.planId,128),
      businessType:safeText(instruction.businessType,48), amountYuan:safeMoney(uncredited)});
    if (unsettled && instruction.direction === 'outflow') settlementActions.push({kind:'pay_cash',
      instructionId:safeText(instruction.instructionId,128), planId:safeText(instruction.planId,128),
      businessType:safeText(instruction.businessType,48), amountYuan:safeMoney(unsettled)});
  }
  for (const row of rows(state.summary?.openingTradeBalances)) {
    if (settlementActions.length >= MAX_ACTIONS || !(row.remainingYuan > 0)) continue;
    settlementActions.push({ kind:row.direction === 'inflow' ? 'receive_opening_cash' : 'pay_opening_cash',
      instructionId:null, planId:null, sourceId:safeText(row.sourceId,128),
      businessType:safeText(row.businessType,48), amountYuan:safeMoney(row.remainingYuan) });
  }
  const firstBlockedPlan = planReports.find(x => x.immediateBlockers.length);
  const savedProposalRuleMismatch = planReports.some(x => x.staleProposalBlocker);
  const savedFirstBlocked = proposalCoverageMatches ? rows(proposal.steps).find(x => x.blocked) : null;
  const firstBlocked = firstBlockedPlan ? {planId:firstBlockedPlan.planId,
    nominalYuan:firstBlockedPlan.arrangeableYuan} : null;
  const firstRules = firstBlockedPlan?.immediateBlockers ?? [];
  const c02 = portfolioRule('C02');
  const saleReceipt = settlementActions.find(x => x.kind === 'receive_cash' &&
    ['cd_sell','bond_sell'].includes(x.businessType));
  const remainingOutflowYuan = planReports.filter(x =>
    ['deposit','cd_buy','bond_buy','reverse_repo','exchange_repo_lending'].includes(x.businessType))
    .reduce((sum,x) => sum + (x.remainingYuan ?? 0),0);
  const simpleOutflowBridge = planReports.every(x => {
    if (!['deposit','cd_buy','bond_buy','reverse_repo','exchange_repo_lending'].includes(x.businessType))
      return false;
    if (x.businessType !== 'bond_buy') return true;
    const plan = state.plans.find(p => p.planId === x.planId);
    const security = state.initialData?.securities?.find(s => s.securityId === plan?.securityId);
    return security?.isGovernmentBond !== true;
  });
  const accountCashYuan = safeMoney(state.summary?.accountCashYuan);
  const businessCashYuan = safeMoney(state.summary?.cashRatioBasis?.businessCashYuan);
  const saleUncreditedYuan = safeMoney(state.summary?.saleUncreditedYuan);
  const reservedYuan = safeMoney((state.summary?.localReservedYuan ?? 0) +
    (state.summary?.platformReservedYuan ?? 0) + (state.summary?.payableReservedYuan ?? 0));
  const accountCashAvailableForPaymentsYuan = accountCashYuan === null || reservedYuan === null ? null :
    accountCashYuan - reservedYuan;
  const accountCanCoverRemainingOutflows = accountCashAvailableForPaymentsYuan === null ? null :
    accountCashAvailableForPaymentsYuan >= remainingOutflowYuan;
  const recommendations = [];
  if (planReports.length) recommendations.push({priority:1,code:'refresh_recalculate_review',
    planId:null,amountYuan:null,
    text:accountCanCoverRemainingOutflows && Number.isSafeInteger(c02?.headroomYuan) &&
      c02.headroomYuan >= remainingOutflowYuan ?
      '当前已成交卖券计入业务现金，实际账户现金也可覆盖剩余付款；刷新快照，重新计算逐笔规则和排序、重新审核，再手动下达。无需等待卖券到账才测算C02。' :
      '刷新执行快照，重新计算逐笔规则、资金和排序；按最新结果重新审核后手动下达。'});
  if (saleReceipt) recommendations.push({priority:2,code:'track_sale_receipt',
    planId:saleReceipt.planId, amountYuan:saleReceipt.amountYuan,
    text:'继续核对已结算卖券的银行到账。若确已到账，在“投管系统”找到卖券指令，点击“录入投管回报”，选择“卖券回款到账并可用”；到账只调和账户现金和待收款，不再增加同一笔卖券在C02中的金额。不要重复录入成交或结算。'});
  for (const item of settlementActions.filter(x => x.kind !== 'receive_cash' || x !== saleReceipt).slice(0, 8))
    recommendations.push({priority:2,code:item.kind,planId:item.planId,amountYuan:item.amountYuan,
      text:item.kind === 'receive_cash' ? '核实成交资金到账回报。' :
        item.kind === 'pay_cash' ? '核实已成交但尚未付款的金额及实际账户可用现金。' :
        item.kind === 'settle_inflow' ? '核实卖出成交的交收回报，交收后再核验到账。' :
        item.kind === 'verify_unknown' ? '核实发送结果未知指令的实际回报，避免重复下达。' :
        '核对期初未结清现金事件及银行回报。'});
  if (!planReports.length && (rows(state.coreRules?.blocking).length ||
      rows(state.coreRules?.missing).length || state.execution?.requiresRefresh ||
      state.execution?.requiresReapproval)) recommendations.push({priority:3,
    code:'refresh_recalculate_review',planId:null,amountYuan:null,
    text:'刷新执行快照、重新计算与审核；仅对最新可下达步骤手动下达。'});
  const snapshot = state.execution?.snapshot;
  const snapshotAgeMs = Number.isFinite(snapshot?.observedAt) ? Math.max(0, Date.now() - snapshot.observedAt) : null;
  const c02DenominatorYuan = safeMoney(c02?.denominatorYuan);
  const projectedC02Ratio = simpleOutflowBridge && Number.isSafeInteger(c02?.numeratorYuan) && c02DenominatorYuan > 0
    ? Math.round((c02.numeratorYuan - remainingOutflowYuan) / c02DenominatorYuan * 1e12) / 1e12 : null;
  const projectedC02HeadroomYuan = simpleOutflowBridge && Number.isSafeInteger(c02?.headroomYuan)
    ? safeMoney(c02.headroomYuan - remainingOutflowYuan) : null;
  const projectedC02MarginPercentagePoints = projectedC02HeadroomYuan !== null && c02DenominatorYuan > 0
    ? Math.round(projectedC02HeadroomYuan / c02DenominatorYuan * 100 * 1e10) / 1e10 : null;
  return {
    status:planReports.length || settlementActions.length || rows(state.coreRules?.blocking).length ||
      rows(state.coreRules?.missing).length || state.execution?.requiresRefresh ||
      state.execution?.requiresReapproval ? 'attention' : 'complete',
    businessDate:safeText(state.context?.businessDate,10), asOfRevision:safeMoney(state.revision),
    current:{ruleCounts:resultCounts, c01:rule(portfolioRule('C01')),
      c02:{...rule(c02),numeratorYuan:safeMoney(c02?.numeratorYuan),
        marginPercentagePoints:Number.isSafeInteger(c02?.headroomYuan) && c02DenominatorYuan > 0 ?
          Math.round(c02.headroomYuan / c02DenominatorYuan * 100 * 1e10) / 1e10 : null,
        thresholdRatio:Number.isFinite(c02?.threshold?.numerator) &&
        Number.isFinite(c02?.threshold?.denominator) && c02.threshold.denominator > 0 ?
        c02.threshold.numerator / c02.threshold.denominator : null},
      c09:rule(portfolioRule('C09')), cash:{accountCashYuan,
        businessAvailableYuan:safeMoney(state.summary?.availableYuan),
        businessCashYuan, saleUncreditedYuan, accountCashAvailableForPaymentsYuan,
        navYuan:safeMoney(state.inputs?.navYuan),
        governmentBondWithinYearYuan:safeMoney(state.summary?.cashRatioBasis?.governmentBondWithinYearYuan),
        unreceivedMaturityYuan:safeMoney(state.summary?.unreceivedMaturityYuan),
        reservedYuan}},
    next:{proposalStatus:proposalCoverageMatches && !savedProposalRuleMismatch ?
        safeText(proposal.status,48) : null,
      proposalBasis:savedProposalRuleMismatch ? 'saved_proposal_rule_mismatch' :
        proposalCoverageMatches ? 'saved_proposal_same_balances' : 'no_matching_saved_proposal',
      savedProposalStatus:proposalCoverageMatches ? safeText(proposal.status,48) : null,
      unfinishedYuan:safeMoney(planReports.reduce((sum,x) => sum + (x.remainingYuan ?? 0),0)),
      unarrangedYuan:proposalCoverageMatches && !savedProposalRuleMismatch ?
        safeMoney(proposal.unarrangedYuan) : null,
      savedUnarrangedYuan:proposalCoverageMatches ? safeMoney(proposal.unarrangedYuan) : null,
      firstBlockedStep:firstBlocked ? {planId:safeText(firstBlocked.planId,128),
        amountYuan:safeMoney(firstBlocked.nominalYuan),rules:firstRules,
        basis:'current_isolated_rule_check'} : null,
      savedFirstBlockedStep:savedFirstBlocked ? {planId:safeText(savedFirstBlocked.planId,128),
        amountYuan:safeMoney(savedFirstBlocked.nominalYuan),
        rules:rows(trace.find(x => x.stepId === savedFirstBlocked.stepId)?.rules)
          .filter(x => ['block','missing','closed'].includes(x.result)).slice(0, 12).map(rule),
        basis:'saved_proposal_historical'} : null,
      searchExhausted:proposalCoverageMatches && !savedProposalRuleMismatch &&
        proposal.status === 'search_exhausted',
      savedSearchExhausted:proposalCoverageMatches && proposal.status === 'search_exhausted'},
    unfinishedPlans:planReports, plansTruncated:unfinished.length > MAX_PLANS,
    cashReconciliation:{initialCashYuan, creditedInflowYuan:safeMoney(creditedInflowYuan),
      paidOutflowYuan:safeMoney(paidOutflowYuan), openingCashEventsNetYuan:safeMoney(openingCashEventsNetYuan),
      calculatedAccountCashYuan:safeMoney(calculatedAccountCashYuan),
      accountCashYuan:safeMoney(state.summary?.accountCashYuan),
      matches:calculatedAccountCashYuan === state.summary?.accountCashYuan},
    settlementActions:settlementActions.slice(0,MAX_ACTIONS),
    settlementActionsTruncated:instructions.length > MAX_ACTIONS || settlementActions.length > MAX_ACTIONS,
    gates:{snapshotQuality:safeText(snapshot?.quality,24),snapshotAgeSeconds:snapshotAgeMs === null ? null : Math.floor(snapshotAgeMs/1000),
      requiresRefresh:state.execution?.requiresRefresh === true,
      requiresReapproval:state.execution?.requiresReapproval === true,
      pendingReports:Object.keys(state.execution?.pending ?? {}).length,
      approvalStatus:safeText(state.approvalStatus,24)},
    liquidityBridge:projectedC02Ratio !== null && projectedC02HeadroomYuan !== null ? {
      accountCashYuan, businessCashYuan, saleUncreditedYuan,
      saleReceiptYuan:saleReceipt?.amountYuan ?? 0,
      remainingOutflowYuan:safeMoney(remainingOutflowYuan),
      accountCashAvailableForPaymentsYuan, accountCanCoverRemainingOutflows,
      accountCashAfterRemainingOutflowsYuan:accountCashYuan === null ? null :
        safeMoney(accountCashYuan - remainingOutflowYuan),
      accountCashAfterRemainingPaymentsWithoutReceiptYuan:accountCashYuan === null ? null :
        safeMoney(accountCashYuan - remainingOutflowYuan),
      businessCashAfterRemainingOutflowsYuan:businessCashYuan === null ? null :
        safeMoney(businessCashYuan - remainingOutflowYuan),
      accountCashAfterSaleReceiptYuan:saleReceipt && accountCashYuan !== null ?
        safeMoney(accountCashYuan + saleReceipt.amountYuan) : null,
      projectedC02RatioAfterRemainingOutflows:projectedC02Ratio,
      projectedC02NumeratorYuan:safeMoney(c02.numeratorYuan - remainingOutflowYuan),
      projectedC02HeadroomYuan,
      projectedC02MarginPercentagePoints,
      condition:'已成交卖券已计入业务现金/C02；到账只改变账户现金及待收款。剩余付款测算假定其它头寸和规则不变，须按当前快照重算逐笔规则与顺序。'} : null,
    recommendations:recommendations.slice(0,12),
    limitations:unique([
      savedProposalRuleMismatch ? '存档排单阻断与当前逐笔规则结果相矛盾；该旧排单不可作为当前下达依据，须刷新重算并重审。' :
        proposalCoverageMatches ? '存档排单金额覆盖与当前余额相同，但未重新运行组合排序；规则与下一笔判断已按当前状态逐笔重算。' :
        '无与当前计划余额匹配的存档排单；本工具只做逐笔下一笔规则判断。',
      proposalCoverageMatches && proposal.status === 'search_exhausted' ? '旧排单搜索预算耗尽；未证明不存在其他顺序或可行方案。' : null,
      '逐笔immediateBlockers为各计划按当前状态单独执行剩余金额的检验，不是全路径可行性证明。',
      '已成交卖券与实际到账分别核验；业务现金和实际账户现金口径不同，到账不能重复增加C02。',
      '到账、付款和成交事实须依据实际回报核验；本工具不写入回报、不审核、不下达。',
    ]),
  };
}
