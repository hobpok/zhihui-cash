// Reusable, deterministic lifecycle driver for synthetic single-day templates.
// All changes to a run go through createModel's public methods.
import { createModel, validateSaved } from '../app/model.js';

const copy = value => JSON.parse(JSON.stringify(value));
const money = n => Number.isSafeInteger(n) && n > 0 ? n : 0;

export function compactState(state) {
  const balances = new Map((state.summary?.planBalances ?? []).map(row => [row.planId, row]));
  return {
    revision: state.revision,
    proposal: state.proposal ? {
      proposalId: state.proposal.proposalId, status: state.proposal.status,
      pathId: state.proposal.pathId, conflicts: copy(state.proposal.conflicts ?? []),
      blockers: (state.proposal.blockers ?? []).map(b => ({ code: b.code,
        severity: b.severity, planId: b.planId, message: b.message })),
      groups: copy(state.proposal.groups ?? []),
      steps: (state.proposal.steps ?? []).map(step => ({ stepId: step.stepId,
        planId: step.planId, nominalYuan: step.nominalYuan, blocked: step.blocked,
        machineConditions: copy(step.machineConditions ?? []) })),
    } : null,
    cash: {
      accountCashYuan: state.summary?.accountCashYuan ?? null,
      businessAvailableYuan: state.summary?.availableYuan ?? null,
      payableReservedYuan: state.summary?.payableReservedYuan ?? null,
      projectedEndOfDayYuan: state.summary?.projectedEndOfDayYuan?.balanceYuan ?? null,
    },
    plans: (state.plans ?? []).map(plan => ({ planId: plan.planId, label: plan.label,
      businessType: plan.businessType, direction: plan.direction,
      targetYuan: plan.targetYuan, ...copy(balances.get(plan.planId) ?? {}) })),
    coreRules: (state.coreRules?.rows ?? []).map(row => ({ ruleId: row.ruleId,
      subjectId: row.subjectId, result: row.result, currentValue: row.currentValue,
      projectedValue: row.projectedValue, numeratorYuan: row.numeratorYuan,
      denominatorYuan: row.denominatorYuan, needed: copy(row.needed ?? []),
      reason: row.reason })),
    instructions: Object.values(state.execution?.instructions ?? {}).map(i => ({
      instructionId: i.instructionId, stepId: i.stepId, planId: i.planId,
      status: i.status, businessType: i.businessType, direction: i.direction,
      nominalYuan: i.nominalYuan,
      filledYuan: i.filledYuan, settledYuan: i.settledYuan,
      cancelledYuan: i.cancelledYuan,
      creditedYuan: Object.values(state.execution?.cashFlows ?? {})
        .filter(f => f.type === 'cash_available' && f.instructionId === i.instructionId)
        .reduce((sum, f) => sum + f.amountYuan, 0),
    })),
    cashEventReceipts: Object.values(state.execution?.cashEventReceipts ?? {}).map(r => ({
      sourceId: r.sourceId, direction: r.direction, amountYuan: r.amountYuan,
    })),
    approvalStatus: state.approvalStatus,
    completed: lifecycleComplete(state),
  };
}

const remainingOpening = state => {
  const facts = state.execution?.openingFacts ?? [];
  const receipts = Object.values(state.execution?.cashEventReceipts ?? {});
  return facts.map(fact => {
    const sourceId = fact.eventId ?? fact.tradeId;
    const received = receipts.filter(r => r.sourceId === sourceId)
      .reduce((sum, r) => sum + r.amountYuan, 0);
    const already = fact.includedInOpeningCash || fact.cashIncludedAtOpen;
    return { sourceId, direction: fact.direction,
      valueDate: fact.dueDate ?? fact.settlementDate,
      remainingYuan: fact.amountYuan === null ? null : already ? 0 : fact.amountYuan - received,
      maturity: Boolean(fact.eventId) };
  }).filter(row => row.valueDate <= state.context.businessDate && row.remainingYuan !== 0);
};

const outstanding = state => Object.values(state.execution?.instructions ?? {})
  .filter(i => i.status !== 'rejected').map(i => {
    const creditedYuan = Object.values(state.execution.cashFlows ?? {})
      .filter(f => f.type === 'cash_available' && f.instructionId === i.instructionId)
      .reduce((sum, f) => sum + f.amountYuan, 0);
    return { ...i, unfilledYuan: i.nominalYuan - i.filledYuan - i.cancelledYuan,
      unsettledYuan: i.filledYuan - i.settledYuan,
      uncreditedYuan: i.filledYuan - creditedYuan };
  });

function lifecycleComplete(state) {
  if (!(state.summary?.planBalances ?? []).every(p => p.remainingYuan === 0)) return false;
  if (remainingOpening(state).length) return false;
  return outstanding(state).every(i => i.unfilledYuan === 0 && i.unsettledYuan === 0 &&
    (i.direction === 'outflow' || i.uncreditedYuan === 0));
}

function recordOpening(model, actions, receiptCounter) {
  let changed = false;
  // Receipts first; due payments are attempted only against actual account cash.
  for (const direction of ['inflow', 'outflow']) {
    for (const row of remainingOpening(model.getState()).filter(x => x.direction === direction)) {
      if (!money(row.remainingYuan)) continue;
      const cash = model.getState().summary.accountCashYuan;
      if (direction === 'outflow' && (cash === null || cash < row.remainingYuan)) continue;
      const eventId = `${model.getState().context.runId}-OPEN-${receiptCounter.value++}`;
      const result = model.recordCashEvent({ eventId, sourceId: row.sourceId,
        amountYuan: row.remainingYuan });
      actions.push({ kind: 'opening_cash', sourceId: row.sourceId, direction,
        amountYuan: row.remainingYuan, result: result.eventResult });
      changed = true;
    }
  }
  return changed;
}

function executeInstructions(model, actions, flowCounter) {
  let changed = false;
  const cashFlowId = () => `${model.getState().context.runId}-FLOW-${flowCounter.value++}`;
  // Fully fill accepted instructions. A filled outgoing trade may remain unpaid.
  for (const i of outstanding(model.getState())) {
    if (!['accepted', 'partial'].includes(i.status) || !money(i.unfilledYuan)) continue;
    model.simulateEvent('fill', { instructionId: i.instructionId, nominalYuan: i.unfilledYuan });
    actions.push({ kind: 'fill', instructionId: i.instructionId, amountYuan: i.unfilledYuan });
    changed = true;
  }
  // Funding can credit on fill; sales must settle before the account is credited.
  for (const i of outstanding(model.getState()).filter(x => x.direction === 'inflow')) {
    if (i.businessType === 'interbank_repo_financing' || i.businessType === 'exchange_repo_financing') {
      if (money(i.uncreditedYuan)) {
        model.simulateEvent('cash_available', { instructionId: i.instructionId,
          amountYuan: i.uncreditedYuan, cashFlowId: cashFlowId() });
        actions.push({ kind: 'credit', instructionId: i.instructionId, amountYuan: i.uncreditedYuan });
        changed = true;
      }
      if (money(i.unsettledYuan) && i.settlementDate <= model.getState().context.businessDate) {
        model.simulateEvent('cash_settled', { instructionId: i.instructionId,
          amountYuan: i.unsettledYuan, cashFlowId: cashFlowId() });
        actions.push({ kind: 'settle_inflow', instructionId: i.instructionId,
          amountYuan: i.unsettledYuan });
        changed = true;
      }
    } else {
      if (money(i.unsettledYuan)) {
        model.simulateEvent('cash_settled', { instructionId: i.instructionId,
          amountYuan: i.unsettledYuan, cashFlowId: cashFlowId() });
        actions.push({ kind: 'settle_inflow', instructionId: i.instructionId,
          amountYuan: i.unsettledYuan });
        changed = true;
      }
      const fresh = outstanding(model.getState()).find(x => x.instructionId === i.instructionId);
      const creditable = fresh.settledYuan - (fresh.filledYuan - fresh.uncreditedYuan);
      if (money(creditable)) {
        model.simulateEvent('cash_available', { instructionId: i.instructionId,
          amountYuan: creditable, cashFlowId: cashFlowId() });
        actions.push({ kind: 'credit', instructionId: i.instructionId, amountYuan: creditable });
        changed = true;
      }
    }
  }
  return changed;
}

function settleOutgoing(model, actions, receiptCounter, flowCounter) {
  let changed = false;
  // Mature opening obligations get the first claim on newly credited account cash.
  changed = recordOpening(model, actions, receiptCounter) || changed;
  for (const i of outstanding(model.getState()).filter(x => x.direction === 'outflow')) {
    if (!money(i.unsettledYuan) || i.settlementDate > model.getState().context.businessDate) continue;
    const cash = model.getState().summary.accountCashYuan;
    if (cash === null || cash < i.unsettledYuan) continue;
    model.simulateEvent('cash_settled', { instructionId: i.instructionId,
      amountYuan: i.unsettledYuan,
      cashFlowId: `${model.getState().context.runId}-FLOW-${flowCounter.value++}` });
    actions.push({ kind: 'settle_outflow', instructionId: i.instructionId,
      amountYuan: i.unsettledYuan });
    changed = true;
  }
  return changed;
}

function collectBlocked(state) {
  const rows = [];
  const remainingByPlan = new Map((state.summary?.planBalances ?? [])
    .map(p => [p.planId, p.remainingYuan]));
  const stepPlan = new Map((state.proposal?.steps ?? []).map(s => [s.stepId, s.planId]));
  for (const row of state.proposal?.blockers ?? []) {
    if (!row.planId || remainingByPlan.get(row.planId) > 0)
      rows.push({ kind: 'proposal_blocker', code: row.code, severity: row.severity,
        planId: row.planId, reason: row.message });
  }
  for (const row of state.approvalStatus === 'valid' ? state.batchReadiness ?? [] : []) {
    if (!row.ready && remainingByPlan.get(stepPlan.get(row.stepId)) > 0)
      rows.push({ kind: 'step', stepId: row.stepId, reason: row.reason });
  }
  for (const p of state.summary?.planBalances ?? []) if (p.remainingYuan > 0)
    rows.push({ kind: 'plan_remaining', planId: p.planId,
      amountYuan: p.remainingYuan, arrangeableYuan: p.arrangeableYuan });
  for (const i of outstanding(state)) {
    if (i.unfilledYuan > 0) rows.push({ kind: 'instruction_unfilled',
      instructionId: i.instructionId, amountYuan: i.unfilledYuan });
    if (i.unsettledYuan > 0 && i.direction === 'outflow') rows.push({ kind: 'payment_pending',
      instructionId: i.instructionId, amountYuan: i.unsettledYuan,
      reason: '实际账户现金不足或尚未到交收日' });
    if (i.unsettledYuan > 0 && i.direction === 'inflow') rows.push({ kind: 'settlement_pending',
      instructionId: i.instructionId, amountYuan: i.unsettledYuan });
    if (i.uncreditedYuan > 0 && i.direction === 'inflow') rows.push({ kind: 'receipt_pending',
      instructionId: i.instructionId, amountYuan: i.uncreditedYuan });
  }
  for (const f of remainingOpening(state)) rows.push({ kind: 'opening_cash_pending', ...f });
  if (Object.keys(state.execution?.pending ?? {}).length)
    rows.push({ kind: 'source_sequence_gap', sequences: Object.keys(state.execution.pending) });
  return rows;
}

export function runLifecycle(template, { maxCycles = 30 } = {}) {
  if (!Number.isSafeInteger(maxCycles) || maxCycles < 1) throw new Error('maxCycles必须是正整数');
  const model = createModel(), rounds = [], receiptCounter = { value: 1 }, flowCounter = { value: 1 };
  let initial = null, error = null, initialized = false;
  try {
    model.startFromTemplate(template);
    initialized = true;
    model.generateProposal();
    initial = compactState(model.getState());
    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      const actions = [], round = { cycle, actions, suggestion: null, review: null,
        readiness: [], blocked: [] };
      rounds.push(round);
      let changed = false;
      changed = recordOpening(model, actions, receiptCounter) || changed;
      changed = executeInstructions(model, actions, flowCounter) || changed;
      changed = settleOutgoing(model, actions, receiptCounter, flowCounter) || changed;
      model.refreshSnapshot();
      model.generateProposal();
      let state = model.getState();
      round.suggestion = compactState(state).proposal;
      round.suggestion.trace = {
        search: copy(state.calculation?.trace?.search ?? null),
        diagnostics: copy(state.calculation?.trace?.diagnostics ?? []),
        ruleFailures: (state.calculation?.trace?.steps ?? []).flatMap(step =>
          (step.rules ?? []).filter(rule =>
            ['block', 'missing', 'waiting_conditions', 'closed'].includes(rule.result))
            .map(rule => ({ stepId: step.stepId, planId: step.planId,
              ruleId: rule.ruleId, result: rule.result, reason: rule.reason,
              needed: copy(rule.needed ?? []) }))),
      };
      if (state.canApprove) {
        model.approveProposal();
        state = model.getState();
        round.review = { approvalId: state.approval.approvalId,
          eligibleStepIds: copy(state.approvalEligibleStepIds) };
        round.readiness = copy(state.batchReadiness);
        const ready = state.batchReadiness.filter(row => row.ready).map(row => row.stepId);
        if (ready.length) {
          const sent = model.sendBatch(ready, { receiptMode: 'accepted' });
          round.sent = copy(sent.results);
          for (const result of sent.results) if (result.status === 'accepted') {
            actions.push({ kind: 'send', stepId: result.stepId,
              instructionId: result.instructionId });
            changed = true;
          }
        }
      } else round.review = { approvalId: null, reason: state.approvalReason };
      changed = executeInstructions(model, actions, flowCounter) || changed;
      changed = settleOutgoing(model, actions, receiptCounter, flowCounter) || changed;
      state = model.getState();
      round.blocked = collectBlocked(state);
      round.end = compactState(state);
      if (!changed) break;
    }
  } catch (caught) {
    error = { name: caught.name, message: caught.message };
    if (rounds.length) rounds.at(-1).error = error;
  }
  let serialized = null, final = null, validationSaved = null, blocked = [];
  try {
    if (initialized) {
      serialized = model.serialize();
      const state = model.getState();
      final = compactState(state);
      blocked = collectBlocked(state);
      validationSaved = validateSaved(serialized);
      final.validationSaved = copy(validationSaved);
    }
  } catch (caught) {
    error ??= { name: caught.name, message: caught.message };
  }
  if (error) blocked.push({ kind: 'exception', reason: error.message });
  if (rounds.length >= maxCycles && rounds.at(-1).actions.length &&
      blocked.some(b => ['plan_remaining', 'instruction_unfilled', 'payment_pending',
        'receipt_pending', 'settlement_pending', 'opening_cash_pending'].includes(b.kind)))
    blocked.push({ kind: 'cycle_limit', maxCycles });
  return { initial, final, rounds, blocked, serialized, validationSaved };
}
