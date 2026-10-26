import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../app/model.js';
import { createRemediationInitialTemplate } from '../app/default-scenario.js';
import { createAiDraft } from '../app/ai-draft.js';
import { createPlanningTools } from './planning-tools.js';
import { diagnosticPresentation, managerFixedTrades } from '../app/ai-ui.js';

function setup(requirements = {}) {
  const model = createModel(); model.startFromTemplate(createRemediationInitialTemplate());
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
