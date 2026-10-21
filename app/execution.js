// Versioned, local simulation ledger. This is not the full 2A source snapshot adapter.
import { isFinancing, isExchangeRepo, isSecuritySale, unitFor, windowStatus,
  isIndivisible,indivisibleAmountIssue } from './business.js';
export const EXECUTION_VERSION = 'simulation-execution-3';
const copy = value => JSON.parse(JSON.stringify(value));
// Object key order can change during cloud JSON serialization. Event order
// and other arrays remain significant when checking replay and duplicates.
const canonicalJson = value => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const fact = event => { const { receivedAt, reportClockTime, ...rest } = event; return rest; };
const yuan = (n, name, positive = false) => {
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0)) throw new Error(`${name}必须是安全整数元`);
  return n;
};
const add = (a, b) => yuan(a + b, '金额');
const signedAdd = (a, b) => { const n = a + b; if (!Number.isSafeInteger(n)) throw new Error('金额超出安全整数范围'); return n; };

export function newExecution(initialCashYuan, openingFacts = [], demoMode = null) {
  const execution = {
    version: EXECUTION_VERSION, snapshot: { version: 1, observedAt: Date.now(), quality: 'fresh' },
    requiresRefresh: false, requiresReapproval: false, sourceSequence: 0, pending: {}, seen: {}, journal: [],
    instructions: {}, cancels: {}, cashFlows: {}, fills: {}, syntheticFundingYuan: 0,
    openingFacts: copy(openingFacts), cashEventReceipts: {},
    nextInstruction: 1, nextCancel: 1, nextLocalEvent: 1, initialCashYuan,
  };
  if (demoMode !== null) execution.demoMode = demoMode;
  return execution;
}
const singleDay = execution => execution.demoMode === 'single-day-principal-v1';

function accountCash(execution) {
  if (execution.initialCashYuan === null) return null;
  let cash = BigInt(execution.initialCashYuan);
  for (const i of Object.values(execution.instructions)) if (i.direction === 'outflow') cash -= BigInt(i.settledYuan);
  for (const flow of Object.values(execution.cashFlows)) if (flow.type === 'cash_available') cash += BigInt(flow.amountYuan);
  for (const receipt of Object.values(execution.cashEventReceipts ?? {}))
    cash += BigInt(receipt.direction === 'inflow' ? receipt.amountYuan : -receipt.amountYuan);
  if (cash < BigInt(Number.MIN_SAFE_INTEGER) || cash > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('账户现金超出安全整数范围');
  return Number(cash);
}

const openingSourceId = f => f.eventId ?? f.tradeId;
const openingValueDate = f => f.dueDate ?? f.settlementDate;
const openingIsPrimary = f => f.kind === 'primary_cd_subscription';
const openingInCash = f => f.includedInOpeningCash === true || f.cashIncludedAtOpen === true;
const openingAmount = f => f.amountYuan;
const receivedFor = (execution, sourceId) => Object.values(execution.cashEventReceipts ?? {})
  .filter(r => r.sourceId === sourceId).reduce((n, r) => add(n, r.amountYuan), 0);

export function registerCashEvent(execution, receipt, businessDate) {
  const next = copy(execution);
  if (!receipt || typeof receipt.eventId !== 'string' || !receipt.eventId ||
    typeof receipt.sourceId !== 'string' || !receipt.sourceId ||
    Object.keys(receipt).some(k => !['eventId','sourceId','amountYuan','direction'].includes(k)))
    throw new Error('现金事件ID、来源ID或字段无效');
  if (next.seen[receipt.eventId] || next.cashFlows[receipt.eventId]) throw new Error('现金回报ID与既有执行事件冲突');
  const prior = next.cashEventReceipts[receipt.eventId];
  if (prior) {
    if (prior.sourceId !== receipt.sourceId || prior.amountYuan !== receipt.amountYuan)
      throw new Error('同一现金回报ID内容冲突');
    return { execution: next, result: 'duplicate' };
  }
  const fact = next.openingFacts.find(f => openingSourceId(f) === receipt.sourceId);
  if (!fact) throw new Error('现金事件来源不存在');
  if (next.openingFacts.some(f => openingSourceId(f) === receipt.eventId))
    throw new Error('现金回报ID与期初来源ID冲突');
  yuan(receipt.amountYuan, '现金回报金额', true);
  if (openingAmount(fact) === null) throw new Error('来源金额未知，不能收付');
  if (openingValueDate(fact) > businessDate) throw new Error('现金事件尚未到交收日');
  if (openingInCash(fact)) throw new Error('期初已计入账户现金，不可重复收付');
  if (singleDay(next) && Object.hasOwn(fact, 'eventId') && receipt.amountYuan !== openingAmount(fact))
    throw new Error('简化模板到期款须整笔收付');
  if (add(receivedFor(next, receipt.sourceId), receipt.amountYuan) > openingAmount(fact)) throw new Error('现金事件累计收付超过来源金额');
  if (fact.direction === 'outflow') {
    const actual = accountCash(next);
    if (actual === null || actual < receipt.amountYuan) throw new Error('实际账户现金不足，不能付款');
  }
  next.cashEventReceipts[receipt.eventId] = { ...copy(receipt), direction: fact.direction };
  next.journal.push({ kind: 'opening_cash_event', receipt: copy(next.cashEventReceipts[receipt.eventId]), businessDate });
  return { execution: next, result: 'applied' };
}

export function executionSummary(execution, plans, { businessDate = null } = {}) {
  const settledBalanceYuan = accountCash(execution);
  let localReservedYuan = 0, platformReservedYuan = 0, payableReservedYuan = 0;
  const futureCashEvents = [], settlementRows = [];
  const pledgeUsedByMarket = { INTERBANK: 0, SSE: 0, SZSE: 0 };
  let financingPrincipalYuan = 0, financingUncreditedYuan = 0, saleUncreditedYuan = 0;
  const repoLiabilities = [];
  let reverseRepoReceivableYuan = 0;
  const repoAssets = [];
  const ledger = Object.fromEntries(plans.map(p => [p.planId, [0, 0]]));
  for (const instruction of Object.values(execution.instructions)) {
    const remaining = instruction.nominalYuan - instruction.filledYuan - instruction.cancelledYuan - (instruction.status === 'rejected' ? instruction.nominalYuan : 0);
    if (remaining < 0) throw new Error('指令名义金额超额');
    const row = ledger[instruction.planId];
    if (!row) throw new Error('指令计划引用不存在');
    row[0] = add(row[0], instruction.filledYuan);
    row[1] = add(row[1], remaining);
    if (isFinancing(instruction.businessType)) {
      if (!Object.hasOwn(pledgeUsedByMarket, instruction.repoMarket)) throw new Error('融资指令市场无效');
      const committedYuan = add(instruction.filledYuan, remaining);
      if (!singleDay(execution)) pledgeUsedByMarket[instruction.repoMarket] = add(pledgeUsedByMarket[instruction.repoMarket], committedYuan);
      financingPrincipalYuan = add(financingPrincipalYuan, instruction.filledYuan);
      const credited = Object.values(execution.cashFlows).filter(f => f.type === 'cash_available' &&
        f.instructionId === instruction.instructionId).reduce((n,f) => add(n,f.amountYuan),0);
      financingUncreditedYuan = add(financingUncreditedYuan, instruction.filledYuan - credited);
      if (instruction.filledYuan) repoLiabilities.push({ instructionId: instruction.instructionId, planId: instruction.planId,
        market: instruction.repoMarket, principalYuan: instruction.filledYuan, tenorDays: instruction.repoTerms.tenorDays,
        annualRate: instruction.repoTerms.annualRate, interestYuan: null, maturityDate: null,
        status: 'outstanding_not_simulated' });
    }
    if (isSecuritySale(instruction.businessType)) {
      const credited = Object.values(execution.cashFlows).filter(f => f.type === 'cash_available' &&
        f.instructionId === instruction.instructionId).reduce((n,f) => add(n,f.amountYuan),0);
      saleUncreditedYuan = add(saleUncreditedYuan, instruction.filledYuan - credited);
    }
    if (instruction.businessType === 'exchange_repo_lending') {
      reverseRepoReceivableYuan = add(reverseRepoReceivableYuan, instruction.filledYuan);
      if (instruction.filledYuan) repoAssets.push({ instructionId: instruction.instructionId, planId: instruction.planId,
        market: instruction.repoMarket, principalYuan: instruction.filledYuan, tenorDays: instruction.repoTerms.tenorDays,
        annualRate: instruction.repoTerms.annualRate, interestYuan: null, maturityDate: null,
        status: 'receivable_not_simulated' });
    }
    const unpaidYuan = instruction.filledYuan - instruction.settledYuan;
    const future = businessDate !== null && instruction.settlementDate !== null && instruction.settlementDate > businessDate;
    if (instruction.direction === 'outflow') {
      if (!future) {
        if (instruction.status === 'unknown') localReservedYuan = add(localReservedYuan, remaining);
        else if (instruction.status !== 'rejected') platformReservedYuan = add(platformReservedYuan, remaining);
        payableReservedYuan = add(payableReservedYuan, unpaidYuan);
      } else if (remaining + unpaidYuan > 0) futureCashEvents.push({ sourceId: instruction.instructionId,
        valueDate: instruction.settlementDate, signedDeltaYuan: -(remaining + unpaidYuan),
        confirmed: true, includedInAvailableYuan: false });
    } else if (future && instruction.filledYuan > 0) {
      const credited = Object.values(execution.cashFlows).filter(f => f.type === 'cash_available' &&
        f.instructionId === instruction.instructionId).reduce((n,f) => add(n,f.amountYuan),0);
      const receivable = instruction.filledYuan - credited;
      if (receivable > 0)
      futureCashEvents.push({ sourceId: instruction.instructionId, valueDate: instruction.settlementDate,
        signedDeltaYuan: receivable, confirmed: true, includedInAvailableYuan: false });
    }
    settlementRows.push({ sourceId: instruction.instructionId, label: instruction.planId, kind: instruction.businessType,
      direction: instruction.direction, tradeDate: instruction.tradeDate ?? null,
      settlementDate: instruction.settlementDate ?? null, amountYuan: instruction.nominalYuan,
      settledYuan: instruction.settledYuan, remainingYuan: instruction.nominalYuan - instruction.settledYuan,
      status: instruction.status, canSettle: !future && instruction.filledYuan > instruction.settledYuan });
  }
  let unreceivedMaturityYuan = 0, openingReservedYuan = 0, unknownToday = false;
  for (const f of execution.openingFacts ?? []) {
    const sourceId = openingSourceId(f), valueDate = openingValueDate(f), amountYuan = openingAmount(f);
    const settledYuan = openingInCash(f) ? amountYuan : receivedFor(execution, sourceId);
    const remainingYuan = amountYuan === null ? null : amountYuan - settledYuan;
    const dueToday = businessDate !== null && valueDate === businessDate;
    const future = businessDate !== null && valueDate > businessDate;
    const isMaturity = Object.hasOwn(f, 'eventId');
    if (remainingYuan === null && (dueToday || (valueDate < businessDate && f.direction === 'outflow') || openingIsPrimary(f)))
      unknownToday = true;
    if (remainingYuan !== null && remainingYuan > 0) {
      if (dueToday && isMaturity) unreceivedMaturityYuan = signedAdd(unreceivedMaturityYuan,
        f.direction === 'inflow' ? remainingYuan : -remainingYuan);
      else if (openingIsPrimary(f) || (valueDate <= businessDate && f.direction === 'outflow'))
        openingReservedYuan = add(openingReservedYuan, remainingYuan);
      if (future && !openingIsPrimary(f)) futureCashEvents.push({ sourceId, valueDate,
        signedDeltaYuan: f.direction === 'inflow' ? remainingYuan : -remainingYuan,
        confirmed: true, includedInAvailableYuan: false });
    } else if (remainingYuan === null && future) futureCashEvents.push({ sourceId, valueDate,
      signedDeltaYuan: null, confirmed: true, includedInAvailableYuan: false });
    settlementRows.push({ sourceId, label: f.label, kind: f.kind, direction: f.direction,
      tradeDate: f.tradeDate ?? null, settlementDate: valueDate, amountYuan,
      settledYuan, remainingYuan, status: openingInCash(f) || remainingYuan === 0 ? 'settled' :
        settledYuan > 0 ? 'partial' : 'pending', canSettle: !future && remainingYuan !== null && remainingYuan > 0 });
  }
  const reserved = add(add(add(localReservedYuan, platformReservedYuan), payableReservedYuan), openingReservedYuan);
  const availableYuan = settledBalanceYuan === null || unknownToday ? null :
    signedAdd(signedAdd(signedAdd(settledBalanceYuan, unreceivedMaturityYuan),
      singleDay(execution) ? add(financingUncreditedYuan, saleUncreditedYuan) : 0), -reserved);
  if (availableYuan !== null && !Number.isSafeInteger(availableYuan)) throw new Error('可用资金超出安全整数范围');
  let openingBusinessAvailableYuan = execution.initialCashYuan;
  if (openingBusinessAvailableYuan !== null) {
    for (const f of execution.openingFacts ?? []) {
      const valueDate = openingValueDate(f), amountYuan = openingAmount(f);
      if (!Object.hasOwn(f, 'eventId') || openingInCash(f) || valueDate !== businessDate) continue;
      if (amountYuan === null) { openingBusinessAvailableYuan = null; break; }
      openingBusinessAvailableYuan = signedAdd(openingBusinessAvailableYuan,
        f.direction === 'inflow' ? amountYuan : -amountYuan);
    }
  }
  futureCashEvents.sort((a,b) => a.valueDate.localeCompare(b.valueDate) || a.sourceId.localeCompare(b.sourceId));
  const dateBalances = [];
  if (businessDate !== null) {
    dateBalances.push({ valueDate: businessDate, availableYuan });
    let running = availableYuan;
    for (const f of futureCashEvents) {
      running = running === null || f.signedDeltaYuan === null ? null : signedAdd(running, f.signedDeltaYuan);
      const last = dateBalances.at(-1);
      if (last.valueDate === f.valueDate) last.availableYuan = running;
      else dateBalances.push({ valueDate: f.valueDate, availableYuan: running });
    }
  }
  const openingTradeBalances = settlementRows.filter(r => (execution.openingFacts ?? [])
    .some(f => openingSourceId(f) === r.sourceId && Object.hasOwn(f, 'tradeId')))
    .map(r => ({ ...r, businessType: execution.openingFacts.find(f => openingSourceId(f) === r.sourceId).businessType }));
  const planBalances = plans.map(p => {
    const [filledYuan, lockedYuan] = ledger[p.planId];
    const remainingYuan = p.targetYuan - filledYuan;
    const arrangeableYuan = remainingYuan - lockedYuan;
    if (arrangeableYuan < 0) throw new Error('计划意向金额低于成交加锁定');
    return { planId: p.planId, targetYuan: p.targetYuan, filledYuan, lockedYuan, remainingYuan, arrangeableYuan };
  });
  return { settledBalanceYuan, accountCashYuan: settledBalanceYuan, localReservedYuan, platformReservedYuan,
    payableReservedYuan: add(payableReservedYuan, openingReservedYuan), availableYuan,
    openingBusinessAvailableYuan, unreceivedMaturityYuan: unknownToday ? null : unreceivedMaturityYuan,
    futureCashEvents, settlementRows, dateBalances, openingTradeBalances,
    planBalances,
    // Deprecated read-only alias for older consumers; no quota is maintained or checked.
    quotaUsedByMarket:{ ...pledgeUsedByMarket }, pledgeUsedByMarket,
    financingPrincipalYuan, financingUncreditedYuan,
    saleUncreditedYuan, repoLiabilities,
    reverseRepoReceivableYuan, repoAssets,
    quality: execution.pending && Object.keys(execution.pending).length ? 'gap' : execution.snapshot.quality };
}

export function registerSend(execution, step, plan, approvalId, marketClock = null, authoritySource = null) {
  const next = copy(execution);
  if (isIndivisible(plan.businessType)) {
    const prior = Object.values(next.instructions).filter(i => i.planId === plan.planId && i.status !== 'rejected');
    const filledYuan = prior.reduce((n,i) => add(n,i.filledYuan),0);
    const lockedYuan = prior.reduce((n,i) => add(n,i.nominalYuan-i.filledYuan-i.cancelledYuan),0);
    const issue = indivisibleAmountIssue(plan,{filledYuan,lockedYuan},step.nominalYuan);
    if (issue) throw new Error(issue);
  }
  if (Object.values(next.instructions).some(i => i.stepId === step.stepId && i.status !== 'rejected')) throw new Error('该指令已经发送或结果未知，不得重复发送');
  const instructionId = `${approvalId}-I-${next.nextInstruction++}`;
  if (next.openingFacts.some(f => openingSourceId(f) === instructionId)) throw new Error('新指令ID与期初来源冲突');
  next.instructions[instructionId] = {
    instructionId, stepId: step.stepId, planId: plan.planId, direction: plan.direction,
    nominalYuan: step.nominalYuan, filledYuan: 0, cancelledYuan: 0, settledYuan: 0,
    tradeDate: plan.tradeDate ?? null, settlementDate: plan.settlementDate ?? null,
    securityId: plan.securityId ?? null, marketTier: plan.marketTier ?? null,
    status: 'unknown', approvalId, cancelRequestId: null, businessType: plan.businessType ?? (plan.direction === 'inflow' ? 'cd_sell' : 'reverse_repo'),
    repoMarket: plan.repoTerms?.market ?? null, repoTerms: plan.repoTerms ?? null,
    sentTime: marketClock?.time ?? null, sentTradingDay: marketClock?.isTradingDay ?? null,
    machineConditions:copy(step.machineConditions ?? []),
    ...(authoritySource === 'calculated_skip_review' ? { authoritySource } : {}),
  };
  next.journal.push({ kind: 'send', instruction: copy(next.instructions[instructionId]) });
  return { execution: next, instructionId };
}

export function registerCancel(execution, instructionId) {
  const next = copy(execution), instruction = next.instructions[instructionId];
  if (!instruction || instruction.status === 'rejected' || instruction.status === 'unknown') throw new Error('仅已接收且未成交完的指令可申请撤改');
  if (instruction.cancelRequestId) throw new Error('该指令已有待处理撤改申请');
  const remaining = instruction.nominalYuan - instruction.filledYuan - instruction.cancelledYuan;
  if (remaining <= 0) throw new Error('没有可撤的未成交量');
  const cancelRequestId = `${instructionId}-C-${next.nextCancel++}`;
  next.cancels[cancelRequestId] = { cancelRequestId, instructionId, requestedYuan: remaining, slices: {}, failed: false };
  instruction.cancelRequestId = cancelRequestId;
  next.journal.push({ kind: 'cancel_request', request: copy(next.cancels[cancelRequestId]) });
  return { execution: next, cancelRequestId };
}

function applyOne(next, event, { historicalReplay = false } = {}) {
  const { type, instructionId } = event;
  const i = instructionId == null ? null : next.instructions[instructionId];
  if (instructionId != null && !i) throw new Error('回报指令不存在');
  if (type === 'accepted') {
    if (i.status !== 'unknown') throw new Error('接收状态冲突');
    i.status = 'accepted';
  } else if (type === 'rejected') {
    if (i.status !== 'unknown' || event.noReservation !== true) throw new Error('拒绝必须确认无占用且此前未接收');
    i.status = 'rejected';
  } else if (type === 'fill') {
    if (i.status !== 'accepted' && i.status !== 'partial') throw new Error('成交须引用已接收指令');
    yuan(event.nominalYuan, '成交名义', true);
    if (!historicalReplay && isIndivisible(i.businessType) &&
        event.nominalYuan !== i.nominalYuan-i.filledYuan-i.cancelledYuan)
      throw new Error('存款不可拆分：须一次成交该指令全部未成交余量');
    if (isExchangeRepo(i.businessType) && event.nominalYuan % unitFor(i.businessType) !== 0)
      throw new Error('交易所回购成交名义须符合交易单位');
    if (isExchangeRepo(i.businessType) && !singleDay(next)) {
      const gate = windowStatus({ time: i.sentTime, isTradingDay: i.sentTradingDay, timezone: 'Asia/Shanghai' },
        { mode: 'fill', at: event.tradeTime });
      if (gate.result !== 'open' || event.tradeTime < i.sentTime ||
        (event.reportClockTime && event.tradeTime > event.reportClockTime)) throw new Error('交易所融资成交时点不在已发送且开放的窗口内');
    }
    if (typeof event.fillId !== 'string' || !event.fillId || next.fills[event.fillId] ||
      next.openingFacts.some(f => openingSourceId(f) === event.fillId))
      throw new Error('成交ID缺失或重复，或与期初来源冲突，不能重复入账');
    if (i.filledYuan + i.cancelledYuan + event.nominalYuan > i.nominalYuan) throw new Error('成交超过可用未成交份额');
    i.filledYuan = add(i.filledYuan, event.nominalYuan);
    next.fills[event.fillId] = { instructionId, nominalYuan: event.nominalYuan };
    i.status = i.filledYuan + i.cancelledYuan === i.nominalYuan ? 'filled' : 'partial';
  } else if (type === 'cash_settled') {
    if (!i) throw new Error('结算须引用指令');
    yuan(event.amountYuan, '结算金额', true);
    if (!event.cashFlowId || next.cashFlows[event.cashFlowId] ||
      next.openingFacts.some(f => openingSourceId(f) === event.cashFlowId))
      throw new Error('结算现金流ID重复或缺失，或与期初来源冲突');
    if (i.settledYuan + event.amountYuan > i.filledYuan) throw new Error('结算金额超过已录入成交名义');
    if (i.direction === 'outflow') {
      const actual = accountCash(next);
      if (actual === null || actual < event.amountYuan) throw new Error('实际账户现金不足，不能付款');
    }
    i.settledYuan = add(i.settledYuan, event.amountYuan);
    next.cashFlows[event.cashFlowId] = { type, instructionId, amountYuan: event.amountYuan };
  } else if (type === 'cash_available') {
    yuan(event.amountYuan, '到账金额', true);
    if (!event.cashFlowId || next.cashFlows[event.cashFlowId] ||
      next.openingFacts.some(f => openingSourceId(f) === event.cashFlowId))
      throw new Error('到账现金流ID重复或缺失，或与期初来源冲突');
    if (i && i.direction !== 'inflow') throw new Error('卖券到账须引用流入指令');
    if (i) {
      const credited = Object.values(next.cashFlows).filter(f => f.type === 'cash_available' && f.instructionId === instructionId).reduce((n, f) => add(n, f.amountYuan), 0);
      if (credited + event.amountYuan > (isFinancing(i.businessType) ? i.filledYuan : i.settledYuan))
        throw new Error(isFinancing(i.businessType) ? '融资到账超过已成交本金' : '卖券尚未结算或到账超过结算');
    } else if (event.syntheticFunding !== true) throw new Error('独立到账必须明确标识合成资金');
    next.cashFlows[event.cashFlowId] = { type, instructionId: instructionId ?? null, amountYuan: event.amountYuan };
    if (!i) next.syntheticFundingYuan = add(next.syntheticFundingYuan, event.amountYuan);
  } else if (type === 'cancel_confirmed') {
    const c = next.cancels[event.cancelRequestId];
    if (!c || c.instructionId !== instructionId || c.failed) throw new Error('撤改申请引用无效');
    if (!event.cancelSliceId || typeof event.cancelSliceId !== 'string') throw new Error('缺少撤改份额ID');
    yuan(event.nominalYuan, '撤改份额', true);
    if (!historicalReplay && isIndivisible(i.businessType) &&
        !c.slices[event.cancelSliceId]?.applied &&
        event.nominalYuan !== i.nominalYuan-i.filledYuan-i.cancelledYuan)
      throw new Error('存款不可拆分：须整笔撤销该指令全部未成交余量');
    if (isExchangeRepo(i.businessType) && event.nominalYuan % unitFor(i.businessType) !== 0)
      throw new Error('交易所回购撤改名义须符合交易单位');
    if (event.reservationId !== instructionId || event.releaseYuan !== event.nominalYuan)
      throw new Error('撤改要求占用ID匹配且现金释放与名义同额');
    if (isFinancing(i.businessType) && !singleDay(next) && event.releaseConfirmed === true && event.repoResourcesReleased !== true)
      throw new Error('融资撤改须确认质押占用已恢复');
    if (isFinancing(i.businessType) && !singleDay(next) && event.repoResourcesReleased === true && event.releaseConfirmed !== true)
      throw new Error('融资资源释放证据须关联对应撤改释放确认');
    const slice = c.slices[event.cancelSliceId] ?? { nominalYuan: event.nominalYuan, reservationId: event.reservationId,
      releaseYuan: event.releaseYuan, nominalConfirmed: false, releaseConfirmed: false,
      repoResourcesReleased: false, applied: false };
    if (slice.nominalYuan !== event.nominalYuan) throw new Error('撤改份额金额冲突');
    if (event.nominalConfirmed === true) slice.nominalConfirmed = true;
    if (event.releaseConfirmed === true) slice.releaseConfirmed = true;
    if (event.repoResourcesReleased === true) slice.repoResourcesReleased = true;
    if (event.nominalConfirmed !== true && event.releaseConfirmed !== true) throw new Error('撤改确认缺少证据');
    c.slices[event.cancelSliceId] = slice;
    if (slice.nominalConfirmed && slice.releaseConfirmed && (!isFinancing(i.businessType) || singleDay(next) || slice.repoResourcesReleased) && !slice.applied) {
      if (i.filledYuan + i.cancelledYuan + slice.nominalYuan > i.nominalYuan ||
        Object.values(c.slices).filter(s => s.applied).reduce((n, s) => add(n, s.nominalYuan), 0) + slice.nominalYuan > c.requestedYuan)
        throw new Error('撤改释放超过剩余可撤份额');
      i.cancelledYuan = add(i.cancelledYuan, slice.nominalYuan);
      slice.applied = true;
      if (i.filledYuan + i.cancelledYuan === i.nominalYuan) i.status = 'filled';
    }
  } else if (type === 'cancel_failed') {
    const c = next.cancels[event.cancelRequestId];
    if (!c || c.instructionId !== instructionId) throw new Error('撤改失败引用无效');
    c.failed = true;
    i.cancelRequestId = null;
  } else throw new Error('未知回报类型');
}

export function applyEvent(execution, event, { beforeApply } = {}) {
  const next = copy(execution);
  if (!event || typeof event !== 'object' || typeof event.eventId !== 'string' || !event.eventId ||
    !Number.isSafeInteger(event.sourceSequence) || event.sourceSequence < 1) throw new Error('回报ID或来源序号无效');
  if (next.cashEventReceipts[event.eventId]) throw new Error('回报ID与期初现金回报冲突');
  if (next.openingFacts.some(f => openingSourceId(f) === event.eventId)) throw new Error('回报ID与期初来源冲突');
  const prior = next.seen[event.eventId];
  if (prior) {
    if (!equal(fact(prior), fact(event))) throw new Error('同一回报ID内容冲突，需人工核对');
    return { execution: next, result: 'duplicate' };
  }
  if (event.sourceSequence <= next.sourceSequence) throw new Error('旧序号回报未在已确认事件索引中');
  const queued = next.pending[event.sourceSequence];
  if (queued) {
    if (!equal(fact(queued), fact(event))) throw new Error('同一来源序号内容冲突，需人工核对');
    return { execution: next, result: 'duplicate_pending' };
  }
  next.seen[event.eventId] = copy(event);
  next.pending[event.sourceSequence] = copy(event);
  while (next.pending[next.sourceSequence + 1]) {
    const current = next.pending[next.sourceSequence + 1];
    if (beforeApply) beforeApply(next,current);
    applyOne(next, current);
    delete next.pending[next.sourceSequence + 1];
    next.sourceSequence++;
    next.journal.push({ kind: 'event', event: current });
  }
  return { execution: next, result: Object.keys(next.pending).length ? 'gap' : 'applied' };
}

export function validateExecution(execution, plans) {
  if (!execution || execution.version !== EXECUTION_VERSION || !Array.isArray(execution.journal) ||
    !Number.isSafeInteger(execution.sourceSequence) || execution.sourceSequence < 0 ||
    !execution.snapshot || !['fresh','stale'].includes(execution.snapshot.quality)) throw new Error('执行存档合同不兼容');
  if (typeof execution.requiresRefresh !== 'boolean' || typeof execution.requiresReapproval !== 'boolean') throw new Error('恢复校验标记无效');
  if (execution.initialCashYuan !== null) yuan(execution.initialCashYuan, '初始资金');
  if (execution.demoMode !== undefined && execution.demoMode !== 'single-day-principal-v1')
    throw new Error('未知执行模式');
  if (!Array.isArray(execution.openingFacts) || !execution.cashEventReceipts ||
    typeof execution.cashEventReceipts !== 'object') throw new Error('期初事实或现金回报结构无效');
  const sourceIds = new Set();
  for (const f of execution.openingFacts) {
    const id = openingSourceId(f), date = openingValueDate(f);
    if (typeof id !== 'string' || !id || sourceIds.has(id) ||
      typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !['inflow','outflow'].includes(f.direction) ||
      (f.amountYuan !== null && (!Number.isSafeInteger(f.amountYuan) || f.amountYuan <= 0)))
      throw new Error('期初现金来源ID、日期或金额无效');
    sourceIds.add(id);
  }
  for (const i of Object.values(execution.instructions)) {
    if (i.machineConditions !== undefined) {
      if (!Array.isArray(i.machineConditions)) throw new Error('指令成交依赖须为数组');
      const kinds=['pledge_confirmed','quota_confirmed','exchange_window_open','funds_available','cash_available',
        'settlement_capacity','filled','payable_cleared','previous_confirmed','sale_cash_available','holding_confirmed'];
      const amounts=['pledge_confirmed','quota_confirmed','funds_available','cash_available',
        'settlement_capacity','filled','holding_confirmed'];
      for (const condition of i.machineConditions) {
        if (!condition || typeof condition!=='object' || Array.isArray(condition) || !kinds.includes(condition.kind))
          throw new Error('指令成交依赖类型无效');
        if (amounts.includes(condition.kind)) yuan(condition.minimumYuan,'指令依赖最低金额');
        if (condition.additionalYuan!==undefined) yuan(condition.additionalYuan,'指令依赖差额');
        if (condition.planId!==undefined && !plans.some(plan=>plan.planId===condition.planId))
          throw new Error('指令成交依赖计划引用无效');
        if (['funds_available','filled','payable_cleared','sale_cash_available','holding_confirmed'].includes(condition.kind) &&
            typeof condition.planId!=='string') throw new Error('指令成交依赖缺少计划引用');
        if (condition.kind==='previous_confirmed' &&
            (typeof condition.stepId!=='string' || !Object.values(execution.instructions).some(prior=>prior.stepId===condition.stepId)))
          throw new Error('指令成交依赖前置步骤引用无效');
        if (condition.basis!==undefined && !['fill','cash_available'].includes(condition.basis))
          throw new Error('指令成交依赖计量口径无效');
        if (condition.market!==undefined && !['INTERBANK','SSE','SZSE'].includes(condition.market))
          throw new Error('指令成交依赖市场无效');
        if (condition.kind==='settlement_capacity' &&
            (typeof condition.valueDate!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(condition.valueDate)))
          throw new Error('指令成交依赖交收日无效');
      }
    }
    if (i.authoritySource !== undefined && i.authoritySource !== 'calculated_skip_review')
      throw new Error('指令授权来源无效');
    for (const key of ['nominalYuan','filledYuan','cancelledYuan','settledYuan']) yuan(i[key], key);
    if (i.filledYuan + i.cancelledYuan > i.nominalYuan || i.settledYuan > i.filledYuan ||
      !plans.some(p => p.planId === i.planId && p.direction === i.direction &&
        (p.businessType ?? (p.direction === 'inflow' ? 'cd_sell' : 'reverse_repo')) === i.businessType &&
        equal(p.repoTerms ?? null, i.repoTerms))) throw new Error('执行存档指令金额或计划引用无效');
    if ((isFinancing(i.businessType) || isExchangeRepo(i.businessType)) && (i.repoMarket !== i.repoTerms?.market ||
      (!singleDay(execution) && (typeof i.sentTime !== 'string' || i.sentTradingDay !== true)))) throw new Error('回购指令资源、时钟或期限信息无效');
    if (!singleDay(execution) && isExchangeRepo(i.businessType) &&
      windowStatus({ time: i.sentTime, isTradingDay: i.sentTradingDay, timezone:'Asia/Shanghai' }, { mode:'send' }).result !== 'open')
      throw new Error('交易所回购发送时点不在申报窗口');
  }
  for (const [sequence, event] of Object.entries(execution.pending)) {
    if (+sequence <= execution.sourceSequence || event.sourceSequence !== +sequence || !equal(execution.seen[event.eventId], event)) throw new Error('待补序回报索引无效');
  }
  let replay = newExecution(execution.initialCashYuan, execution.openingFacts, execution.demoMode ?? null);
  for (const entry of execution.journal) {
    if (entry.kind === 'send') {
      const i = entry.instruction;
      if (!i || replay.instructions[i.instructionId] || i.filledYuan !== 0 || i.cancelledYuan !== 0 || i.settledYuan !== 0 || i.status !== 'unknown')
        throw new Error('发送流水内容无效');
      replay.instructions[i.instructionId] = copy(i);
    } else if (entry.kind === 'cancel_request') {
      const c = entry.request;
      const i = replay.instructions[c?.instructionId];
      if (!c || !i || i.cancelRequestId || c.requestedYuan !== i.nominalYuan - i.filledYuan - i.cancelledYuan ||
        !equal(c.slices, {}) || c.failed !== false) throw new Error('撤改申请流水内容无效');
      replay.cancels[c.cancelRequestId] = copy(c);
      i.cancelRequestId = c.cancelRequestId;
    } else if (entry.kind === 'opening_cash_event') {
      const applied = registerCashEvent(replay, entry.receipt, entry.businessDate);
      if (applied.result !== 'applied') throw new Error('期初现金回报流水重复');
      replay = applied.execution;
    } else if (entry.kind === 'event') {
      const event = entry.event;
      if (event.sourceSequence !== replay.sourceSequence + 1 || replay.seen[event.eventId]) throw new Error('回报事件流水缺序或重复');
      applyOne(replay, event,{historicalReplay:true});
      replay.sourceSequence++;
      replay.seen[event.eventId] = copy(event);
    } else throw new Error('未知执行流水类型');
  }
  if (replay.sourceSequence !== execution.sourceSequence || !equal(replay.instructions, execution.instructions) ||
    !equal(replay.cancels, execution.cancels) || !equal(replay.cashFlows, execution.cashFlows) ||
    !equal(replay.cashEventReceipts, execution.cashEventReceipts) || !equal(replay.fills, execution.fills) ||
    replay.syntheticFundingYuan !== execution.syntheticFundingYuan) throw new Error('执行存档与事件流水不一致');
  const seenKeys = Object.keys(execution.seen).sort();
  const expectedSeen = { ...replay.seen };
  for (const event of Object.values(execution.pending)) expectedSeen[event.eventId] = event;
  if (!equal(seenKeys, Object.keys(expectedSeen).sort()) ||
    seenKeys.some(id => !equal(fact(execution.seen[id]), fact(expectedSeen[id])))) throw new Error('事件去重索引与流水不一致');
  executionSummary(execution, plans);
  return true;
}
