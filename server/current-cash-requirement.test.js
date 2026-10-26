import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../app/model.js';
import { createDefaultInitialTemplate } from '../app/default-scenario.js';
import { evaluateCoreRules } from '../app/core-rules.js';
import { calculateCurrentCashRequirement, createPlanningTools } from './planning-tools.js';

const E = 100000000;
const setup = ({ financing = 20 * E, sale = 2 * E } = {}) => {
  const model = createModel();
  model.startFromTemplate(createDefaultInitialTemplate());
  model.generateProposal();
  model.approveProposal();
  model.sendBatch();
  for (const instruction of Object.values(model.getState().execution.instructions)) {
    const nominalYuan = instruction.businessType === 'cd_sell' ? sale : financing;
    if (nominalYuan) model.simulateEvent('fill', { instructionId: instruction.instructionId, nominalYuan });
  }
  return model;
};
const read = model => {
  const before = model.serialize(), saved = JSON.parse(before);
  const tools = createPlanningTools(saved, { requestId: 'current-cash-only', documentRevision: 1 });
  const first = tools.execute('read_metrics', {});
  assert.equal(first.status, 'ok');
  assert.deepEqual(tools.execute('read_metrics', {}).currentCashRequirement, first.currentCashRequirement);
  assert.equal(model.serialize(), before);
  assert.deepEqual(saved, JSON.parse(before));
  assert.ok(!JSON.stringify(first).includes('journal'));
  return first.currentCashRequirement;
};
const c02 = state => state.coreRules.rows.find(row => row.ruleId === 'C02' && row.subjectId === 'PORTFOLIO');

test('current C02 needs 3 yi after 20 yi financing and 2 yi sale; target remainder stays 29 yi', () => {
  const result = read(setup());
  assert.equal(result.status, 'ok');
  assert.equal(result.scope, 'current_state_only');
  assert.equal(result.currentNumeratorYuan, 22 * E);
  assert.equal(result.navYuan, 500 * E);
  assert.equal(result.thresholdNumerator, 5);
  assert.equal(result.thresholdDenominator, 100);
  assert.equal(result.requiredNumeratorYuan, 25 * E);
  assert.equal(result.additionalFinancingFillYuan, 3 * E);
  assert.equal(result.currentC02Ratio, .044);
  assert.equal(result.projectedC02Ratio, .05);
  assert.equal(result.financingTargetYuan, 49 * E);
  assert.equal(result.financingFilledYuan, 20 * E);
  assert.equal(result.financingUnfilledYuan, 29 * E);
});

test('20 yi financing alone needs 5 yi; the sent but unfilled sale contributes nothing', () => {
  const result = read(setup({ sale: 0 }));
  assert.equal(result.currentNumeratorYuan, 20 * E);
  assert.equal(result.additionalFinancingFillYuan, 5 * E);
});

test('sending 49 yi financing and 2 yi sale without any fill leaves the whole current 25 yi gap', () => {
  const result = read(setup({ financing: 0, sale: 0 }));
  assert.equal(result.currentNumeratorYuan, 0);
  assert.equal(result.additionalFinancingFillYuan, 25 * E);
  assert.equal(result.financingFilledYuan, 0);
  assert.equal(result.financingUnfilledYuan, 49 * E);
});

test('already compliant current C02 needs zero even though 26 yi financing remains and next purchase fails', () => {
  const model = setup({ financing: 23 * E }), result = read(model), state = model.getState();
  assert.equal(result.currentNumeratorYuan, 25 * E);
  assert.equal(result.additionalFinancingFillYuan, 0);
  assert.equal(result.financingUnfilledYuan, 26 * E);
  const deposit = state.plans.find(plan => plan.businessType === 'deposit');
  const next = evaluateCoreRules(state, { plan: deposit, amountYuan: deposit.targetYuan });
  assert.equal(c02({ coreRules: next }).result, 'block');
  assert.match(result.constraints.join(' '), /不代表全部其他交易可下达/);
});

test('above threshold has zero gap and retains the actual higher projected ratio', () => {
  const result = read(setup({ financing: 30 * E }));
  assert.equal(result.additionalFinancingFillYuan, 0);
  assert.equal(result.currentC02Ratio, .064);
  assert.equal(result.projectedC02Ratio, .064);
});

test('confirmed fills improve C02 before receipts, and receiving them never doubles the numerator', () => {
  const model = setup(), before = read(model);
  assert.equal(model.getState().summary.accountCashYuan, 5 * E);
  const ids = Object.keys(model.getState().execution.instructions);
  assert.ok(model.processExecutionBatch(ids, 'settle').results.every(row => row.status === 'settled'));
  const after = read(model);
  assert.equal(model.getState().summary.accountCashYuan, 27 * E);
  assert.deepEqual(after, before);
});

test('partial financing and sale fills retain exact yuan without rounding to yi or the trading lot', () => {
  const result = read(setup({ financing: 20 * E + 17, sale: E + 23 }));
  assert.equal(result.currentNumeratorYuan, 21 * E + 40);
  assert.equal(result.additionalFinancingFillYuan, 4 * E - 40);
  assert.equal(result.financingFilledYuan, 20 * E + 17);
  assert.equal(result.financingUnfilledYuan, 29 * E - 17);
});

test('threshold is taken from the evaluated rule, with exact BigInt ceiling at the safe integer boundary', () => {
  const state = setup().getState(), nav = Number.MAX_SAFE_INTEGER;
  state.inputs.navYuan = state.initialData.portfolio.navYuan = c02(state).denominatorYuan = nav;
  c02(state).threshold = { operator: '≥', numerator: 7, denominator: 113 };
  c02(state).numeratorYuan = 0;
  const before = structuredClone(state), result = calculateCurrentCashRequirement(state);
  const required = Number((BigInt(nav) * 7n + 112n) / 113n);
  assert.equal(result.status, 'ok');
  assert.equal(result.requiredNumeratorYuan, required);
  assert.equal(result.additionalFinancingFillYuan, required);
  assert.equal(result.thresholdNumerator, 7);
  assert.equal(result.thresholdDenominator, 113);
  assert.deepEqual(state, before);
});

test('one-yuan below an exact ceiling needs one yuan, at or above it needs zero', () => {
  const state = setup().getState();
  state.inputs.navYuan = state.initialData.portfolio.navYuan = c02(state).denominatorYuan = 101;
  c02(state).threshold = { operator: '≥', numerator: 7, denominator: 113 };
  for (const [current, gap] of [[6, 1], [7, 0], [8, 0]]) {
    c02(state).numeratorYuan = current;
    const result = calculateCurrentCashRequirement(state);
    assert.equal(result.status, 'ok');
    assert.equal(result.requiredNumeratorYuan, 7);
    assert.equal(result.additionalFinancingFillYuan, gap);
  }
});

test('missing C02 input or threshold never becomes a zero gap', () => {
  for (const change of [
    state => { c02(state).numeratorYuan = null; },
    state => { c02(state).denominatorYuan = null; },
    state => { state.inputs.navYuan = null; },
    state => { c02(state).threshold = null; },
    state => { c02(state).threshold.denominator = 0; },
    state => { c02(state).result = 'missing'; },
    state => { c02(state).needed = ['governmentBondWithinYearYuan']; },
    state => { state.coreRules.rows = state.coreRules.rows.filter(row => row.ruleId !== 'C02'); },
    state => { delete state.coreRules; },
  ]) {
    const state = setup().getState(); change(state);
    const result = calculateCurrentCashRequirement(state);
    assert.equal(result.status, 'insufficient_data');
    assert.equal(result.additionalFinancingFillYuan, null);
    assert.equal(result.projectedC02Ratio, null);
    assert.ok(result.needed.length);
  }
});

test('a valid saved run with unknown NAV returns an honest insufficient_data result', () => {
  const template = createDefaultInitialTemplate(); template.portfolio.navYuan = null;
  const model = createModel(); model.startFromTemplate(template);
  const result = read(model);
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.additionalFinancingFillYuan, null);
});

test('a valid saved run with a genuinely unknown dispatch report gives no definite amount', () => {
  const model = createModel(); model.startFromTemplate(createDefaultInitialTemplate());
  model.generateProposal(); model.approveProposal();
  model.sendBatch(null, { receiptMode: 'unknown', stopAtIndex: 0 });
  const result = read(model);
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.additionalFinancingFillYuan, null);
  assert.ok(result.needed.includes('execution.unknownOrPendingReport'));
});

test('completed cancellation history keeps its reference and fills but permits current C02 calculation', () => {
  const model = setup(), before = read(model);
  const instruction = Object.values(model.getState().execution.instructions)
    .find(item => item.businessType === 'interbank_repo_financing');
  const instructionId = instruction.instructionId;
  const cancelRequestId = model.requestCancel(instructionId).cancelRequestId;
  const remaining = instruction.nominalYuan - instruction.filledYuan;
  const evidence = { instructionId, cancelRequestId, cancelSliceId: 'ALL-REMAINDER',
    nominalYuan: remaining, reservationId: instructionId, releaseYuan: remaining };
  assert.equal(read(model).additionalFinancingFillYuan, null);
  model.simulateEvent('cancel_confirmed', { ...evidence, nominalConfirmed: true });
  assert.equal(read(model).status, 'insufficient_data');
  model.simulateEvent('cancel_confirmed', { ...evidence, releaseConfirmed: true });
  const state = model.getState();
  assert.equal(state.execution.instructions[instructionId].cancelRequestId, cancelRequestId);
  assert.equal(state.execution.cancels[cancelRequestId].slices['ALL-REMAINDER'].applied, true);
  assert.equal(state.execution.instructions[instructionId].filledYuan, 20 * E);
  assert.equal(state.execution.instructions[instructionId].cancelledYuan, 29 * E);
  assert.deepEqual(read(model), before);
});

test('a fully applied partial cancellation slice leaves the rest of its request unresolved', () => {
  const model = setup();
  const instruction = Object.values(model.getState().execution.instructions)
    .find(item => item.businessType === 'interbank_repo_financing');
  const instructionId = instruction.instructionId;
  const cancelRequestId = model.requestCancel(instructionId).cancelRequestId;
  const evidence = { instructionId, cancelRequestId, cancelSliceId: 'PART-REMAINDER',
    nominalYuan: E, reservationId: instructionId, releaseYuan: E };
  model.simulateEvent('cancel_confirmed', { ...evidence, nominalConfirmed: true });
  model.simulateEvent('cancel_confirmed', { ...evidence, releaseConfirmed: true });
  assert.equal(model.getState().execution.cancels[cancelRequestId].slices['PART-REMAINDER'].applied, true);
  const result = read(model);
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.additionalFinancingFillYuan, null);
  assert.ok(result.needed.includes('execution.unknownOrPendingReport'));
});

test('unknown reports, pending sequence gaps and cancellation uncertainty prevent a definite amount', () => {
  for (const change of [
    state => { Object.values(state.execution.instructions)[0].status = 'unknown'; },
    state => { Object.values(state.execution.instructions)[0].status = 'cancel_pending'; },
    state => { Object.values(state.execution.instructions)[0].cancelRequestId = 'PENDING'; },
    state => { state.execution.pending['999'] = {}; },
    state => { delete state.execution.pending; },
  ]) {
    const state = setup().getState(); change(state);
    const result = calculateCurrentCashRequirement(state);
    assert.equal(result.status, 'insufficient_data');
    assert.equal(result.additionalFinancingFillYuan, null);
  }
});

test('missing financing fill or target does not default to zero, and mismatched balances are rejected', () => {
  for (const change of [
    state => { state.plans.find(plan => plan.businessType === 'interbank_repo_financing').targetYuan = null; },
    state => { Object.values(state.execution.instructions).find(i => i.businessType === 'interbank_repo_financing').filledYuan = null; },
    state => { state.summary.planBalances.find(row => row.filledYuan === 20 * E).filledYuan = 19 * E; },
    state => { delete state.execution.instructions; },
    state => { delete state.summary.planBalances; },
  ]) {
    const state = setup().getState(); change(state);
    const result = calculateCurrentCashRequirement(state);
    assert.equal(result.status, 'insufficient_data');
    assert.equal(result.additionalFinancingFillYuan, null);
  }
});

test('only the explicit single-day fill-based contract and minimum ratio are supported', () => {
  for (const change of [
    state => { delete state.initialData.demoMode; },
    state => { delete state.execution.demoMode; },
    state => { state.coreRules.enabled = false; },
    state => { c02(state).threshold.operator = '≤'; },
  ]) {
    const state = setup().getState(); change(state);
    const result = calculateCurrentCashRequirement(state);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.additionalFinancingFillYuan, null);
  }
});

test('unsafe required or gap amounts fail closed after exact arithmetic', () => {
  for (const change of [
    state => {
      state.inputs.navYuan = state.initialData.portfolio.navYuan = c02(state).denominatorYuan = Number.MAX_SAFE_INTEGER;
      c02(state).threshold = { operator: '≥', numerator: Number.MAX_SAFE_INTEGER, denominator: 1 };
    },
    state => { c02(state).numeratorYuan = Number.MIN_SAFE_INTEGER; },
  ]) {
    const state = setup().getState(); change(state);
    const result = calculateCurrentCashRequirement(state);
    assert.equal(result.status, 'insufficient_data');
    assert.equal(result.additionalFinancingFillYuan, null);
    assert.deepEqual(result.needed, ['cashRequirementArithmetic']);
  }
});

test('all financing plans contribute, including rows beyond the 128-row AI context cap', () => {
  const state = setup().getState();
  const original = state.plans.find(plan => plan.businessType === 'interbank_repo_financing');
  for (let index = 0; index < 130; index++) {
    const planId = `FINANCE-${index}`;
    state.plans.push({ ...original, planId, targetYuan: 100 });
    state.summary.planBalances.push({ planId, filledYuan: 0 });
  }
  const result = calculateCurrentCashRequirement(state);
  assert.equal(result.status, 'ok');
  assert.equal(result.additionalFinancingFillYuan, 3 * E);
  assert.equal(result.financingTargetYuan, 49 * E + 13000);
  assert.equal(result.financingFilledYuan, 20 * E);
  assert.equal(result.financingUnfilledYuan, 29 * E + 13000);
});

test('a larger current gap does not silently enlarge an existing financing target', () => {
  const state = setup().getState();
  const plan = state.plans.find(item => item.businessType === 'interbank_repo_financing');
  plan.targetYuan = 21 * E;
  const before = structuredClone(state), result = calculateCurrentCashRequirement(state);
  assert.equal(result.status, 'ok');
  assert.equal(result.additionalFinancingFillYuan, 3 * E);
  assert.equal(result.financingUnfilledYuan, E);
  assert.match(result.constraints.at(-1), /超过现有融资目标/);
  assert.deepEqual(state, before);
});
