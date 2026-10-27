import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../app/model.js';
import { createDefaultInitialTemplate, createRemediationInitialTemplate } from '../app/default-scenario.js';
import { createAiDraft } from '../app/ai-draft.js';
import { createPlanningTools, calculateCurrentCashRequirement } from './planning-tools.js';
import { diagnosticPresentation, managerFixedTrades } from '../app/ai-ui.js';
import { governmentBondMaturityRatio } from '../app/metric-display.js';
import { readPlanningSnapshot, simulateDraft } from '../app/planning.js';

function setup(requirements = {}, templateFactory = createRemediationInitialTemplate) {
  const model = createModel(); model.startFromTemplate(templateFactory());
  const before = model.serialize(), requestId = 'remediation-integration', documentRevision = 1;
  const tools = createPlanningTools(JSON.parse(before), { requestId, documentRevision });
  const result = tools.execute('plan_trades', { reverseRepo: {} }, requirements);
  assert.equal(model.serialize(), before);
  const context = tools.context;
  const dialogue = { status: 'answer', references: ['plan-remediation'],
    evidence: [{ callId: 'plan-remediation', name: 'plan_trades', result }],
    basis: { documentRevision, runId: context.runId, contractVersion: context.contractVersion,
      knowledgeVersion: context.knowledgeVersion, toolVersion: context.toolVersion,
      versions: context.versions, synthetic: context.synthetic } };
  return { model, before, result, dialogue, requestId, documentRevision };
}

const E = 100000000;
const portfolioRule = (rules, id) => rules.rows.find(row => row.ruleId === id && row.subjectId === 'PORTFOLIO');

test('fresh four-plan default distinguishes current C02 repair from AI financing for all original targets', () => {
  const { model, before, result, dialogue, requestId, documentRevision } = setup({}, createDefaultInitialTemplate);
  const state = model.getState(), previous = JSON.parse(before);
  assert.deepEqual(state.plans.map(plan => [plan.businessType, plan.targetYuan]),
    [['deposit', 3 * E], ['deposit', 2 * E], ['cd_buy', E], ['reverse_repo', 20 * E]]);
  assert.equal(state.summary.accountCashYuan, 5 * E);
  assert.equal(state.summary.availableYuan, -5 * E);
  assert.equal(portfolioRule(state.coreRules, 'C02').currentValue, .03);
  assert.equal(portfolioRule(state.coreRules, 'C09').currentValue, 46200 / 515);
  assert.deepEqual(state.coreRules.missing, []);
  assert.deepEqual(governmentBondMaturityRatio(state),
    { numeratorYuan: 20 * E, denominatorYuan: 500 * E, value: .04 });
  const current = calculateCurrentCashRequirement(state);
  assert.equal(current.scope, 'current_state_only');
  assert.equal(current.additionalFinancingFillYuan, 10 * E);
  assert.equal(current.financingTargetYuan, 0);

  assert.equal(result.main.applicable, true);
  assert.equal(result.main.financingYuan, 34 * E);
  assert.equal(result.main.reverseRepoYuan, 20 * E);
  assert.equal(result.main.projectedFinalCashYuan, 5 * E);
  assert.equal(portfolioRule(result.main.finalRules, 'C02').currentValue, .05);
  assert.equal(portfolioRule(result.main.finalRules, 'C09').numeratorYuan, 46700 * E);
  assert.equal(portfolioRule(result.main.finalRules, 'C09').denominatorYuan, 549 * E);
  assert.deepEqual(result.main.finalRules.blocking, []);
  assert.deepEqual(result.main.finalRules.missing, []);
  assert.deepEqual(result.remediation.actions.map(action => [action.securityId, action.targetYuan]),
    [['SIM-GZ-CD-OLD', 2 * E]]);
  assert.equal(model.serialize(), before);

  const bridge = createAiDraft({ model });
  assert.equal(bridge.prepare(dialogue, { requestId, documentRevision }).error, '');
  assert.match(bridge.confirm('main').error, /明确同意新增卖券/);
  assert.equal(model.serialize(), before);
  assert.equal(bridge.confirm('main', { acceptRemediation: true }).appliedRole, 'main');
  const after = JSON.parse(model.serialize());
  assert.equal(after.plans.length, 6);
  assert.equal(after.plans.find(plan => plan.businessType === 'interbank_repo_financing').targetYuan, 34 * E);
  assert.equal(after.plans.find(plan => plan.businessType === 'interbank_repo_financing').repoTerms.tenorDays, 1);
  assert.equal(after.plans.find(plan => plan.businessType === 'cd_sell').targetYuan, 2 * E);
  for (const original of previous.plans)
    assert.deepEqual(after.plans.find(plan => plan.planId === original.planId), original);
  assert.deepEqual(after.execution, { ...previous.execution, requiresRefresh: true, requiresReapproval: true });
  assert.deepEqual(governmentBondMaturityRatio(model.getState()), governmentBondMaturityRatio(state));
});

test('full default with corrective CD sale requires 34yi financing rather than 33.99yi', () => {
  const model = createModel(); model.startFromTemplate(createDefaultInitialTemplate());
  const snapshot = readPlanningSnapshot(model), before = model.serialize();
  const date = snapshot.state.context.businessDate;
  const sale = { kind: 'add', plan: { label: '合成补救卖券', businessType: 'cd_sell', direction: 'inflow',
    issuerId: 'SIM-BANK-GZ', securityId: 'SIM-GZ-CD-OLD', targetYuan: 2 * E,
    tradeDate: date, settlementDate: date, marketTier: 'secondary' } };
  for (const amountYuan of [34 * E - 1000000, 34 * E]) {
    const finance = { kind: 'add', plan: { label: '合成融资边界', businessType: 'interbank_repo_financing',
      direction: 'inflow', targetYuan: amountYuan, tradeDate: date, settlementDate: date,
      repoTerms: { market: 'INTERBANK', tenorDays: 1, annualRate: null } } };
    const result = simulateDraft(snapshot, [sale, finance]);
    const c02 = portfolioRule(result.finalRules, 'C02');
    assert.equal(c02.numeratorYuan, 25 * E - (34 * E - amountYuan));
    assert.equal(c02.result, amountYuan === 34 * E ? 'pass' : 'block');
    assert.equal(result.applicable, amountYuan === 34 * E);
  }
  assert.equal(model.serialize(), before);
});

test('saved fresh four-plan default and legacy five-plan remediation retain their own facts', () => {
  for (const [factory, count, maturity, financing] of [
    [createDefaultInitialTemplate, 4, 10 * E, undefined],
    [createRemediationInitialTemplate, 5, 25 * E, 49 * E],
  ]) {
    const model = createModel(); model.startFromTemplate(factory());
    const saved = JSON.parse(model.serialize()), restored = createModel(saved);
    const readBack = JSON.parse(restored.serialize());
    assert.equal(readBack.plans.length, count);
    assert.equal(readBack.initialData.maturityCashEvents[0].amountYuan, maturity);
    assert.equal(readBack.plans.find(plan => plan.businessType === 'interbank_repo_financing')?.targetYuan, financing);
    assert.deepEqual(readBack.plans, saved.plans);
    assert.deepEqual(readBack.initialData, saved.initialData);
    assert.deepEqual(readBack.execution.instructions, saved.execution.instructions);
    assert.deepEqual(readBack.execution.journal, saved.execution.journal);
  }
});

test('no-sale scenario reaches AI candidate, explicit sale consent, atomic add and no duplicate application', () => {
  const { model, before, result, dialogue, requestId, documentRevision } = setup();
  assert.equal(result.remediation.status, 'candidate');
  assert.equal(result.remediation.requiresManagerConfirmation, true);
  assert.equal(result.main.applicable, true);
  assert.deepEqual(result.remediation.actions.map(a => [a.securityId, a.targetYuan]), [['SIM-GZ-CD-OLD', 200000000]]);
  assert.equal(result.intent.allowReduceReverseRepo, false);
  assert.ok(!JSON.stringify(result).includes('appliedSaved'));
  const bridge = createAiDraft({ model });
  const prepared = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(prepared.error, '');
  assert.equal(prepared.result.serverMismatch, false);
  assert.match(bridge.confirm('main').error, /明确同意新增卖券/);
  assert.equal(model.serialize(), before);
  assert.equal(bridge.confirm('main', { acceptRemediation: true }).appliedRole, 'main');
  const after = JSON.parse(model.serialize()), previous = JSON.parse(before);
  assert.equal(after.plans.filter(p => p.businessType === 'cd_sell').length, 1);
  assert.deepEqual(after.execution, { ...previous.execution, requiresRefresh: true, requiresReapproval: true });
  for (const plan of previous.plans.filter(p => p.businessType !== 'interbank_repo_financing'))
    assert.equal(after.plans.find(p => p.planId === plan.planId).targetYuan, plan.targetYuan);
  const applied = model.serialize();
  assert.match(bridge.confirm('main', { acceptRemediation: true }).error, /已应用/);
  assert.equal(model.serialize(), applied);
});

test('explicit restriction prevents automatic sale remediation', () => {
  const { result } = setup({ disableRemediation: true });
  assert.equal(result.remediation, undefined);
  assert.equal(result.main.applicable, false);
  assert.equal(result.intent.fixedTrades.length, 0);
});

test('explicit no-sale restriction also rejects provider supplied new sales', () => {
  const model = createModel(); model.startFromTemplate(createRemediationInitialTemplate());
  const tools = createPlanningTools(JSON.parse(model.serialize()), { requestId: 'forbid-provider-sale', documentRevision: 1 });
  const result = tools.execute('plan_trades', { reverseRepo: {}, fixedTrades: [
    { businessType: 'cd_sell', securityId: 'SIM-GZ-CD-OLD', targetYuan: 200000000 },
  ] }, { disableRemediation: true });
  assert.equal(result.status, 'invalid_intent');
  assert.match(result.errors[0], /禁止新增卖券/);
});

test('an explicit manager sale remains visible beside an identical corrective sale', () => {
  const model = createModel(); model.startFromTemplate(createRemediationInitialTemplate());
  const tools = createPlanningTools(JSON.parse(model.serialize()), { requestId: 'same-sale-roles', documentRevision: 1 });
  const sale = { businessType: 'cd_sell', securityId: 'SIM-GZ-CD-OLD', targetYuan: 100000000 };
  const result = tools.execute('plan_trades', { reverseRepo: {}, fixedTrades: [sale] });
  assert.equal(result.remediation.status, 'candidate');
  assert.equal(result.remediation.actions[0].targetYuan, 100000000);
  assert.equal(result.intent.fixedTrades.length, 2);
  assert.deepEqual(managerFixedTrades(result), [sale]);
});

test('remediation cannot apply after run changes or when server amounts differ', () => {
  const { model, dialogue, requestId, documentRevision } = setup();
  const bridge = createAiDraft({ model });
  const altered = structuredClone(dialogue);
  altered.evidence[0].result.main.financingYuan += 1000000;
  assert.equal(bridge.prepare(altered, { requestId, documentRevision }).result.serverMismatch, true);
  assert.match(bridge.confirm('main', { acceptRemediation: true }).error, /不一致/);
  bridge.prepare(dialogue, { requestId, documentRevision });
  model.setPreferences([...model.getState().preferences.orderedKeys, 'reverse_repo_first']);
  const before = model.serialize();
  assert.match(bridge.confirm('main', { acceptRemediation: true }).error, /已变化/);
  assert.equal(model.serialize(), before);
});

test('diagnostic presentation distinguishes bad amounts, missing citations and stale evidence', () => {
  assert.match(diagnosticPresentation({ reason: 'narrative_amount', recovery: 'trusted_summary' }).recovery, /可信工具核算摘要/);
  assert.match(diagnosticPresentation({ reason: 'required_reference', recovery: 'retry' }).reason, /缺少必要/);
  assert.match(diagnosticPresentation({ reason: 'reference_stale', recovery: 'refresh_run' }).recovery, /旧方案不能/);
  assert.ok(!JSON.stringify(diagnosticPresentation({ reason: '<script>secret', recovery: 'unknown' })).includes('secret'));
});
