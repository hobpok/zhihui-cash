import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiDraft } from './ai-draft.js';
import { makePlanningFixture, E } from './planning-fixtures.js';
import { createPlanningTools } from '../server/planning-tools.js';
import { automaticInstructionLabel } from './display-labels.js';

function dialogueFor(caseId, { documentRevision = 3, automaticFinancing = false } = {}) {
  const { model, intent } = makePlanningFixture(caseId);
  if (automaticFinancing) delete intent.financing.maxAmountYuan;
  const requestId = `E5-${caseId}`;
  const tools = createPlanningTools(JSON.parse(model.serialize()), { requestId, documentRevision });
  const args = { fixedTrades: intent.fixedPlans.map(plan => ({
    businessType: plan.businessType, securityId: plan.securityId, targetYuan: plan.targetYuan })),
    financing: intent.financing,
    reverseRepo: Object.fromEntries(Object.entries(intent.reverseRepo).filter(([, value]) => value !== null)),
    allowReduceReverseRepo: intent.allowReduceReverseRepo };
  const result = tools.execute('plan_trades', args);
  const context = tools.context;
  const dialogue = { status: 'answer', references: ['call-plan'],
    evidence: [{ callId: 'call-plan', name: 'plan_trades', result }],
    basis: { documentRevision, runId: context.runId, contractVersion: context.contractVersion,
      knowledgeVersion: context.knowledgeVersion, toolVersion: context.toolVersion,
      versions: context.versions, synthetic: context.synthetic } };
  return { model, intent, dialogue, requestId, documentRevision };
}

test('new AI fixed and repo plans use ordinary names while existing labels survive confirmation', () => {
  for (const caseId of ['S1', 'S2', 'S3']) {
    const { model, dialogue, requestId, documentRevision } = dialogueFor(caseId);
    const originals = structuredClone(model.getState().plans);
    const bridge = createAiDraft({ model });
    const prepared = bridge.prepare(dialogue, { requestId, documentRevision });
    assert.equal(prepared.error, '');
    assert.equal(prepared.result.serverMismatch, false);
    for (const delta of prepared.result.main.deltas.filter(delta => delta.kind === 'add')) {
      assert.equal(delta.plan.label, automaticInstructionLabel(delta.plan, model.getState().initialData));
      assert.doesNotMatch(delta.plan.label, /AI建议|AI拟单|cd_sell/);
    }
    for (const step of dialogue.evidence[0].result.main.executionPath)
      assert.ok(step.planLabel && step.businessType);
    assert.equal(bridge.confirm('main').error, '');
    for (const original of originals)
      assert.equal(model.getState().plans.find(plan => plan.planId === original.planId)?.label, original.label);
  }
});

test('CD sale reconstruction uses the same ordinary label as its local draft', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S1');
  const tools = createPlanningTools(JSON.parse(model.serialize()), { requestId, documentRevision });
  dialogue.evidence[0].result = tools.execute('plan_trades', {
    fixedTrades: [{ businessType: 'cd_sell', securityId: 'AI-A-CD-120', targetYuan: E }],
    financing: { maxAmountYuan: 0 }, reverseRepo: { amountYuan: 0 },
  });
  const prepared = createAiDraft({ model }).prepare(dialogue, { requestId, documentRevision });
  assert.equal(prepared.error, '');
  assert.equal(prepared.result.serverMismatch, false);
  const plan = prepared.result.intent.fixedPlans[0];
  assert.equal(plan.label, automaticInstructionLabel(plan, model.getState().initialData));
  assert.match(plan.label, /卖出/);
  assert.doesNotMatch(plan.label, /AI建议|AI拟单|cd_sell/);
});

test('omitted financing cap survives server projection and stages either locally rechecked role', () => {
  for (const role of ['main', 'alternative']) {
    const { model, dialogue, requestId, documentRevision } = dialogueFor('S3', { automaticFinancing: true });
    const server = dialogue.evidence[0].result;
    assert.equal(server.intent.financing.maxAmountYuan, null);
    const before = JSON.parse(model.serialize());
    const bridge = createAiDraft({ model });
    const prepared = bridge.prepare(dialogue, { requestId, documentRevision });
    assert.equal(prepared.error, '');
    assert.equal(prepared.result.serverMismatch, false);
    assert.equal(Object.hasOwn(prepared.result.intent.financing, 'maxAmountYuan'), false);
    assert.equal(prepared.result.main.financingYuan, 20 * E);
    assert.equal(prepared.result.main.reverseRepoYuan, 10 * E);
    assert.equal(prepared.result.alternative.financingYuan, 10 * E);
    assert.equal(prepared.result.alternative.reverseRepoYuan, 0);
    assert.deepEqual(JSON.parse(model.serialize()), before);
    if (role === 'alternative') {
      assert.match(bridge.confirm(role).error, /明确接受/);
      assert.deepEqual(JSON.parse(model.serialize()), before);
    }
    const applied = bridge.confirm(role, { acceptTargetChanges: role === 'alternative' });
    assert.equal(applied.error, '');
    assert.equal(applied.appliedRole, role);
    const after = JSON.parse(model.serialize());
    assert.notDeepEqual(after.plans, before.plans);
    assert.deepEqual(after.execution.instructions, before.execution.instructions);
    assert.deepEqual(after.execution.journal, before.execution.journal);
    assert.deepEqual(after.execution.fills, before.execution.fills);
    assert.deepEqual(after.execution.cashFlows, before.execution.cashFlows);
    assert.deepEqual(after.approval, before.approval);
    assert.match(bridge.confirm(role, { acceptTargetChanges: true }).error, /已应用/);
    assert.deepEqual(JSON.parse(model.serialize()), after);
  }
});

test('automatic financing still blocks stale basis, server mismatch and invalid explicit caps', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S3', { automaticFinancing: true });
  const before = model.serialize();
  const bridge = createAiDraft({ model });
  for (const invalid of [-1, 0.5, '2000000000', Number.MAX_SAFE_INTEGER + 1, undefined]) {
    const tampered = structuredClone(dialogue);
    tampered.evidence[0].result.intent.financing.maxAmountYuan = invalid;
    assert.match(bridge.prepare(tampered, { requestId, documentRevision }).error, /融资上限须为安全整数元/);
    assert.equal(bridge.confirm('main').appliedRole, null);
    assert.equal(model.serialize(), before);
  }
  const mismatch = structuredClone(dialogue);
  mismatch.evidence[0].result.main.financingYuan += E;
  assert.equal(bridge.prepare(mismatch, { requestId, documentRevision }).result.serverMismatch, true);
  assert.match(bridge.confirm('main').error, /不一致/);
  assert.equal(model.serialize(), before);
  assert.equal(bridge.prepare(dialogue, { requestId, documentRevision }).error, '');
  model.setPreferences([...model.getState().preferences.orderedKeys, 'reverse_repo_first']);
  const changed = model.serialize();
  assert.match(bridge.confirm('main').error, /已变化/);
  assert.equal(model.serialize(), changed);
});

test('an explicit zero cap retains zero-financing semantics through the bridge', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S2');
  const tools = createPlanningTools(JSON.parse(model.serialize()), { requestId, documentRevision });
  dialogue.evidence[0].result = tools.execute('plan_trades', {
    fixedTrades: [], financing: { maxAmountYuan: 0, tenorDays: 7, unitYuan: E },
    reverseRepo: { amountYuan: 8 * E, tenorDays: 7, unitYuan: E }, allowReduceReverseRepo: false,
  });
  const bridge = createAiDraft({ model });
  const prepared = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(prepared.error, '');
  assert.equal(prepared.result.serverMismatch, false);
  assert.equal(prepared.result.intent.financing.maxAmountYuan, 0);
  assert.equal(prepared.result.main.financingYuan, 0);
  assert.equal(prepared.result.main.reverseRepoYuan, 8 * E);
  assert.equal(bridge.confirm('main').appliedRole, 'main');
  assert.equal(model.getState().plans.some(plan => plan.businessType === 'interbank_repo_financing'), false);
});

test('automatic financing can stage a new fixed trade while preserving existing execution facts', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S1', { automaticFinancing: true });
  const before = JSON.parse(model.serialize());
  const bridge = createAiDraft({ model });
  const prepared = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(prepared.error, '');
  assert.equal(prepared.result.serverMismatch, false);
  assert.equal(prepared.result.main.financingYuan, 15 * E);
  assert.equal(bridge.confirm('main').appliedRole, 'main');
  const after = JSON.parse(model.serialize());
  assert.equal(after.plans.some(plan => plan.businessType === 'cd_buy' && plan.targetYuan === 15 * E), true);
  for (const key of ['instructions', 'journal', 'fills', 'cashFlows'])
    assert.deepEqual(after.execution[key], before.execution[key]);
  assert.deepEqual(after.approval, before.approval);
});

test('E4 projected intent becomes a fresh local E2 draft without changing facts', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S1');
  const before = model.serialize();
  const bridge = createAiDraft({ model });
  const state = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(state.error, '');
  assert.equal(state.result.serverMismatch, false);
  assert.equal(state.result.main.financingYuan, 15 * E);
  assert.equal(state.result.intent.fixedPlans[0].securityId, 'AI-A-CD-120');
  assert.equal(JSON.stringify(state).includes('appliedSaved'), false);
  assert.equal(model.serialize(), before);
  state.result.main.financingYuan = 0; // public state cannot change the registered E2 candidate
  assert.equal(bridge.snapshot().result.main.financingYuan, 15 * E);
  const applied = bridge.confirm('main');
  assert.equal(applied.appliedRole, 'main');
  assert.equal(bridge.snapshot().appliedRole, 'main');
  assert.equal(model.getState().plans.some(plan => plan.businessType === 'cd_buy'), true);
  assert.equal(Object.keys(model.getState().execution.instructions).length, 0);
  const once = model.serialize();
  assert.equal(bridge.confirm('main').appliedRole, 'main');
  assert.match(bridge.snapshot().error, /已应用/);
  assert.equal(model.serialize(), once);
});

test('server candidate tampering is disclosed and cannot be applied', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S2');
  const before = model.serialize();
  dialogue.evidence[0].result.main.financingYuan = 9 * E;
  dialogue.evidence[0].result.main.deltas = [{ kind: 'delete', planId: 'unrelated' }];
  const bridge = createAiDraft({ model });
  const state = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(state.result.main.financingYuan, 0);
  assert.equal(state.result.serverMismatch, true);
  assert.ok(state.result.serverDiscrepancies.includes('主方案融资金额'));
  assert.equal(bridge.confirm('main').appliedRole, null);
  assert.match(bridge.snapshot().error, /不一致/);
  assert.equal(model.serialize(), before);
});

test('server delta tampering blocks confirmation even when the amount summary still agrees', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S2');
  const before = model.serialize();
  dialogue.evidence[0].result.main.deltas = [{ kind: 'delete', planId: 'unrelated' }];
  const bridge = createAiDraft({ model });
  const state = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(state.result.serverMismatch, true);
  assert.ok(state.result.serverDiscrepancies.includes('主方案交易清单'));
  assert.ok(!state.result.main.deltas.some(delta => delta.planId === 'unrelated'));
  assert.equal(bridge.confirm('main').appliedRole, null);
  assert.equal(model.serialize(), before);
});

test('every projected delta field, missing lists and truncated lists are verified before confirmation', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S1');
  const before = model.serialize();
  const bridge = createAiDraft({ model });
  const changes = [
    candidate => { candidate.deltas[0].kind = 'delete'; },
    candidate => { candidate.deltas[0].planId = 'unrelated'; },
    candidate => { candidate.deltas[0].businessType = 'cd_sell'; },
    candidate => { candidate.deltas[0].securityId = 'other-security'; },
    candidate => { candidate.deltas[0].targetYuan += E; },
    candidate => { candidate.deltas[0].tenorDays = 1; },
    candidate => { delete candidate.deltas[0].planId; },
    candidate => { candidate.deltas.reverse(); },
    candidate => { candidate.deltas.pop(); },
    candidate => { delete candidate.deltas; },
    candidate => { candidate.deltasTruncated = true; },
  ];
  for (const change of changes) {
    const tampered = structuredClone(dialogue);
    change(tampered.evidence[0].result.main);
    const state = bridge.prepare(tampered, { requestId, documentRevision });
    assert.equal(state.error, '');
    assert.equal(state.result.serverMismatch, true);
    assert.ok(state.result.serverDiscrepancies.includes('主方案交易清单'));
    assert.equal(bridge.confirm('main').appliedRole, null);
    assert.equal(model.serialize(), before);
  }
  assert.equal(bridge.prepare(dialogue, { requestId, documentRevision }).result.serverMismatch, false);
  assert.equal(bridge.confirm('main').appliedRole, 'main');
});

test('alternative delta updates and deletions must match the exact locally rechecked plan', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S3');
  const before = model.serialize();
  const candidate = dialogue.evidence[0].result.alternative;
  const changedIndex = candidate.deltas.findIndex(delta => delta.kind !== 'add');
  assert.ok(changedIndex >= 0);
  candidate.deltas[changedIndex].planId = 'unrelated';
  const bridge = createAiDraft({ model });
  const state = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(state.result.serverMismatch, true);
  assert.ok(state.result.serverDiscrepancies.includes('备选方案交易清单'));
  assert.equal(bridge.confirm('alternative', { acceptTargetChanges: true }).appliedRole, null);
  assert.equal(model.serialize(), before);
});

test('invalid IDs, amounts and unrelated references are rejected before local planning', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S1');
  const before = model.serialize();
  const bridge = createAiDraft({ model });
  dialogue.evidence[0].result.intent.fixedTrades[0].targetYuan = 1.5;
  assert.match(bridge.prepare(dialogue, { requestId, documentRevision }).error, /安全整数/);
  dialogue.evidence[0].result.intent.fixedTrades[0].targetYuan = 15 * E;
  dialogue.evidence[0].result.intent.fixedTrades[0].securityId = 'UNKNOWN';
  assert.match(bridge.prepare(dialogue, { requestId, documentRevision }).error, /当前运行/);
  dialogue.evidence[0].result.intent.fixedTrades[0].securityId = 'AI-A-CD-120';
  dialogue.references[0] = 'another-call';
  assert.match(bridge.prepare(dialogue, { requestId, documentRevision }).error, /引用/);
  assert.equal(bridge.confirm('main').appliedRole, null);
  assert.equal(model.serialize(), before);
});

test('existing plan identity cannot be removed from projected intent', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S3');
  const bridge = createAiDraft({ model });
  dialogue.evidence[0].result.intent.reverseRepo.planId = null;
  assert.match(bridge.prepare(dialogue, { requestId, documentRevision }).error, /已有计划/);
});

test('document, run and local version changes prevent stale preparation or confirmation', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S2');
  const bridge = createAiDraft({ model });
  assert.match(bridge.prepare(dialogue, { requestId, documentRevision: documentRevision + 1 }).error, /版本不符/);
  const wrong = structuredClone(dialogue);
  wrong.basis.runId = 'ANOTHER-RUN';
  assert.match(bridge.prepare(wrong, { requestId, documentRevision }).error, /版本不符/);
  const valid = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(valid.error, '');
  model.setPreferences([...model.getState().preferences.orderedKeys, 'reverse_repo_first']);
  const changed = model.serialize();
  assert.equal(bridge.confirm('main').appliedRole, null);
  assert.match(bridge.snapshot().error, /已变化/);
  assert.equal(model.serialize(), changed);
  assert.match(bridge.prepare(dialogue, { requestId, documentRevision }).error, /版本不符/);
});

test('alternative needs explicit target consent; duplicate confirmation changes no execution facts', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S5');
  const before = JSON.parse(model.serialize());
  const bridge = createAiDraft({ model });
  const state = bridge.prepare(dialogue, { requestId, documentRevision });
  assert.equal(state.error, '');
  assert.equal(state.result.serverMismatch, false);
  assert.equal(state.result.alternative.reverseRepoYuan, 7 * E);
  assert.equal(bridge.confirm('alternative').appliedRole, null);
  assert.match(bridge.snapshot().error, /明确接受/);
  assert.deepEqual(JSON.parse(model.serialize()), before);
  assert.equal(bridge.confirm('alternative', { acceptTargetChanges: true }).appliedRole, 'alternative');
  const after = JSON.parse(model.serialize());
  assert.deepEqual(after.execution.instructions, before.execution.instructions);
  assert.deepEqual(after.execution.journal, before.execution.journal);
  assert.equal(after.plans.find(plan => plan.planId === state.result.intent.reverseRepo.planId).targetYuan, 7 * E);
  assert.equal(bridge.confirm('alternative', { acceptTargetChanges: true }).appliedRole, 'alternative');
  assert.deepEqual(JSON.parse(model.serialize()), after);
});

test('metrics and clarification responses have no planning draft', () => {
  const { model, dialogue, requestId, documentRevision } = dialogueFor('S2');
  const bridge = createAiDraft({ model });
  dialogue.status = 'clarification'; dialogue.references = []; dialogue.evidence = [];
  assert.deepEqual(bridge.prepare(dialogue, { requestId, documentRevision }),
    { result: null, error: '', appliedRole: null });
  assert.equal(bridge.confirm('main').appliedRole, null);
  bridge.invalidate();
  assert.deepEqual(bridge.snapshot(), { result: null, error: '', appliedRole: null });
});

test('AI confirmation stages targets without approving or changing investment execution facts', () => {
  for (const [caseId, role] of [['S1','main'],['S5','alternative']]) {
    const { model, dialogue, requestId, documentRevision } = dialogueFor(caseId);
    const bridge = createAiDraft({ model });
    assert.equal(bridge.prepare(dialogue, { requestId, documentRevision }).error, '');
    const before = JSON.parse(model.serialize());
    const outcome = bridge.confirm(role, { acceptTargetChanges: role === 'alternative' });
    assert.equal(outcome.error, '');
    assert.equal(outcome.appliedRole, role);
    const after = JSON.parse(model.serialize());
    assert.notDeepEqual(after.plans, before.plans);
    for (const key of ['instructions','journal','fills','cashFlows'])
      assert.deepEqual(after.execution[key], before.execution[key]);
    assert.deepEqual(after.approval, before.approval);
    assert.equal(model.getState().batchReadiness.some(row => row.ready), false);
    assert.equal(after.execution.requiresReapproval, true);
    assert.equal(bridge.confirmAndDispatch, undefined);
    assert.equal(model.commitAiDraftAndDispatch, undefined);
  }
});
