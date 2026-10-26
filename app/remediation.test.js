import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { createBankOrderInitialTemplate } from './default-scenario.js';
import { readPlanningSnapshot, solveFundingAndReverseRepo } from './planning.js';
import { findRemediation } from './remediation.js';

const E = 100000000;
const settings = { executionSearch: { nodeLimit: 20000, candidateBudget: 128 } };
function fixture(edit = () => {}, keepSale = false) {
  const template = createBankOrderInitialTemplate({ businessDate: '2026-10-26' });
  if (!keepSale) template.draftPlans = template.draftPlans.filter(plan => plan.businessType !== 'cd_sell');
  edit(template);
  const model = createModel(); model.startFromTemplate(template);
  const state = model.getState();
  const financing = state.plans.find(plan => plan.businessType === 'interbank_repo_financing');
  const reverse = state.plans.find(plan => plan.businessType === 'reverse_repo');
  const intent = { requestId: 'remediation-test', fixedPlans: [],
    financing: { ...(financing ? { planId: financing.planId } : {}), tenorDays: 1, maxAmountYuan: 60 * E },
    reverseRepo: { ...(reverse ? { planId: reverse.planId } : {}), tenorDays: 7, amountYuan: reverse?.targetYuan ?? 0 },
    allowReduceReverseRepo: true };
  return { model, intent };
}
const find = ({ model, intent }, options = {}) => findRemediation(readPlanningSnapshot(model), intent,
  { ...settings, ...options });
const sellable = (t, amount) => { t.holdings.find(h => h.securityId === 'SIM-GZ-CD-OLD').sellableYuan = amount; };

test('missing default sale discovers 2yi CD, preserves every target, verifies conditional full path, and is read-only', () => {
  const f = fixture(), snapshot = readPlanningSnapshot(f.model);
  const before = f.model.serialize(), frozen = JSON.stringify(snapshot), input = structuredClone(f.intent);
  const base = solveFundingAndReverseRepo(snapshot, f.intent, settings);
  assert.equal(Boolean(base.main?.applicable), false);
  const result = findRemediation(snapshot, f.intent, { ...settings, baseResult: base });
  assert.equal(result.status, 'candidate');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].securityId, 'SIM-GZ-CD-OLD');
  assert.equal(result.actions[0].targetYuan, 2 * E);
  assert.equal(result.actions[0].businessType, 'cd_sell');
  assert.equal(result.actions[0].requiresManagerConfirmation, true);
  assert.equal(result.intent.allowReduceReverseRepo, false);
  assert.equal(result.result.main.applicable, true);
  assert.equal(result.result.main.status, 'waiting_conditions');
  assert.equal(result.result.main.reverseRepoYuan, 20 * E);
  assert.equal(result.result.main.finalRules.blocking.length, 0);
  assert.equal(result.result.main.finalRules.missing.length, 0);
  const plans = result.result.main.appliedSaved.plans;
  for (const original of snapshot.state.plans) assert.ok(plans.some(plan =>
    plan.planId === original.planId && plan.targetYuan >= original.targetYuan));
  const steps = result.result.main.executionPath;
  const sale = plans.find(plan => plan.businessType === 'cd_sell');
  const deposit = snapshot.state.plans.find(plan => plan.businessType === 'deposit' && plan.issuerId === 'SIM-BANK-GZ');
  assert.ok(steps.findIndex(step => step.planId === sale.planId) < steps.findIndex(step => step.planId === deposit.planId));
  assert.ok(steps.filter(step => step.planId === deposit.planId).every(step =>
    step.nominalYuan === 3 * E && step.machineConditions.some(condition => condition.kind === 'filled')));
  assert.equal(result.search.complete, false);
  assert.equal(f.model.serialize(), before);
  assert.equal(JSON.stringify(snapshot), frozen);
  assert.deepEqual(f.intent, input);
});

test('fixed manager plans stay intact and reverse repo reduction stays disabled', () => {
  const f = fixture(), t = f.model.getState().initialData;
  f.intent.fixedPlans.push({ label: '经理固定广州存单买入', businessType: 'cd_buy', direction: 'outflow',
    issuerId: 'SIM-BANK-GZ', targetYuan: E, securityId: 'SIM-GZ-CD-NEW',
    tradeDate: t.businessDate, settlementDate: t.businessDate, marketTier: 'secondary' });
  const original = structuredClone(f.intent.fixedPlans);
  const result = find(f);
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.intent.fixedPlans.slice(0, original.length), original);
  assert.equal(result.result.main.reverseRepoYuan, 20 * E);
  assert.equal(result.result.main.requiresTargetChange, false);
  assert.equal(result.result.alternative, null);
});

test('existing full sale is not duplicated; partial unsent sale only needs the remainder', () => {
  assert.equal(find(fixture(() => {}, true)).status, 'not_needed');
  const f = fixture(t => { t.draftPlans.find(plan => plan.businessType === 'cd_sell').targetYuan = E; }, true);
  const result = find(f);
  assert.equal(result.status, 'candidate');
  assert.equal(result.actions[0].targetYuan, E);
  assert.equal(result.intent.fixedPlans.length, 1);
  const original = f.model.getState().plans.find(plan => plan.businessType === 'cd_sell');
  assert.equal(result.result.main.appliedSaved.plans.find(plan => plan.planId === original.planId).targetYuan, E);
});

test('existing fixed sale is reserved once and only its missing release is appended', () => {
  const f = fixture();
  f.intent.fixedPlans.push({ label: '经理固定卖券', businessType: 'cd_sell', direction: 'inflow',
    issuerId: 'SIM-BANK-GZ', securityId: 'SIM-GZ-CD-OLD', targetYuan: E });
  const result = find(f);
  assert.equal(result.status, 'candidate');
  assert.equal(result.actions[0].targetYuan, E);
  assert.equal(result.intent.fixedPlans[0].targetYuan, E);
});

test('insufficient and unknown sellable inventory never become global infeasibility claims', () => {
  for (const amount of [0, E, null]) {
    const f = fixture(t => sellable(t, amount));
    const before = f.model.serialize(), result = find(f);
    assert.equal(result.status, amount === null ? 'insufficient_data' : 'not_found');
    assert.deepEqual(result.actions, []);
    assert.equal(result.search.complete, false);
    assert.equal(f.model.serialize(), before);
  }
});

test('unknown company exposure is not treated as zero', () => {
  const result = find(fixture(t => { t.otherFundBankExposure.find(row => row.bankId === 'SIM-BANK-GZ').cdYuan = null; }));
  assert.equal(result.status, 'insufficient_data');
  assert.ok(result.reasons.some(row => row.code === 'missing_company_exposure'));
  assert.deepEqual(result.actions, []);
});

test('accepted sale reserves inventory; no second sale can reuse its holdings', () => {
  const f = fixture(t => {
    sellable(t, E);
    t.draftPlans = [t.draftPlans.find(plan => plan.businessType === 'cd_sell')];
    t.draftPlans[0].targetYuan = E;
  }, true);
  const proposal = f.model.generateProposal(); f.model.approveProposal();
  const instructionId = f.model.send(proposal.proposal.steps[0].stepId).sentInstructionId;
  f.model.simulateEvent('accepted', { instructionId });
  const state = f.model.getState(), day = state.context.businessDate;
  f.model.addPlan({ label: '剩余整笔广州存款', businessType: 'deposit', direction: 'outflow',
    issuerId: 'SIM-BANK-GZ', securityId: 'SIM-GZ-DEP-NEW', targetYuan: 3 * E, tradeDate: day, settlementDate: day });
  f.intent.financing = { tenorDays: 1, maxAmountYuan: 60 * E };
  f.intent.reverseRepo = { amountYuan: 0, tenorDays: 7 };
  const before = f.model.serialize(), result = find(f);
  assert.equal(result.status, 'not_found');
  assert.ok(result.reasons.some(row => row.code === 'insufficient_sellable_inventory'));
  assert.equal(result.search.requiredReleases[0].amountYuan, E);
  assert.deepEqual(result.actions, []);
  assert.equal(f.model.serialize(), before);
});

test('bank bond holdings are a fallback when no CD is held', () => {
  const f = fixture(t => { t.securities.find(s => s.securityId === 'SIM-GZ-CD-OLD').instrumentKind = 'bond'; });
  const result = find(f);
  assert.equal(result.status, 'candidate');
  assert.equal(result.actions[0].businessType, 'bond_sell');
  assert.equal(result.actions[0].targetYuan, 2 * E);
});

test('CD combinations are scanned when no individual holding covers the release', () => {
  const f = fixture(t => {
    const original = t.holdings.find(h => h.securityId === 'SIM-GZ-CD-OLD');
    original.sellableYuan = E;
    const security = { ...t.securities.find(s => s.securityId === original.securityId), securityId: 'SIM-GZ-CD-SPLIT' };
    t.securities.push(security);
    // Reassign one yi of the existing asset, retaining the complete opening ledger.
    original.amountYuan -= E;
    const weight = t.termWeights.assets.find(w => w.sourceHoldingId === original.holdingId);
    weight.amountYuan -= E;
    t.holdings.push({ holdingId: 'H-GZ-SPLIT', securityId: security.securityId, amountYuan: E, sellableYuan: E });
    t.termWeights.assets.push({ ...weight, weightId: 'TW-GZ-SPLIT', amountYuan: E, sourceHoldingId: 'H-GZ-SPLIT' });
  });
  const result = find(f);
  assert.equal(result.status, 'candidate');
  assert.equal(result.actions.length, 2);
  assert.ok(result.actions.every(action => action.businessType === 'cd_sell' && action.targetYuan === E));
  assert.equal(result.result.main.applicable, true);
});

test('a truncated execution search cannot promote an unverified sale', () => {
  const result = find(fixture(), { executionSearch: { nodeLimit: 1, candidateBudget: 1 } });
  assert.equal(result.status, 'not_found');
  assert.deepEqual(result.actions, []);
  assert.equal(result.search.complete, false);
  assert.ok(result.search.rejected.some(row => row.candidateStatus === 'search_incomplete'));
});

test('sell candidates violating another constraint are rejected despite releasing the deposit gate', () => {
  const f = fixture();
  f.intent.fixedPlans.push({ label: '固定大额工商存单买入', businessType: 'cd_buy', direction: 'outflow',
    issuerId: 'SIM-BANK-ICBC', securityId: 'SIM-ICBC-CD-OLD', targetYuan: 100 * E });
  const result = find(f);
  assert.equal(result.status, 'not_found');
  assert.deepEqual(result.actions, []);
  assert.equal(result.search.attemptedVariants, 1);
  assert.ok(result.search.rejected[0].blockingRuleIds.some(id => ['C04', 'C06'].includes(id)));
  assert.equal(result.search.complete, false);
});

test('cloned or untrusted snapshots are rejected before inventory scanning', () => {
  const f = fixture();
  const result = findRemediation(structuredClone(readPlanningSnapshot(f.model)), f.intent);
  assert.equal(result.status, 'invalid_intent');
  assert.deepEqual(result.actions, []);
});
