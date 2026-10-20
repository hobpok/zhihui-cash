import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlanningFixture, E } from './planning-fixtures.js';
import { KNOWLEDGE_VERSION, readPlanningSnapshot, validateIntent,
  preparePlanningDraft, applyConfirmedDraft, compareDrafts } from './planning.js';

test('a newer request supersedes every unconfirmed draft on the same model', () => {
  const { model, intent } = makePlanningFixture('S2');
  const first = preparePlanningDraft(model, intent);
  const second = preparePlanningDraft(model, { ...intent, requestId: `${intent.requestId}-NEW` });
  assert.ok(first.main?.draftId && second.main?.draftId);
  assert.notEqual(first.main.draftId, second.main.draftId);
  const before = model.serialize();
  assert.throws(() => applyConfirmedDraft(model, { draftId: first.main.draftId, confirmed: true }),
    /不存在|重新测算/);
  assert.equal(model.serialize(), before);
  assert.equal(applyConfirmedDraft(model, { draftId: second.main.draftId, confirmed: true }).status, 'applied');
});

test('confirmation and target-change consent require literal true', () => {
  const { model, intent } = makePlanningFixture('S3');
  const draft = preparePlanningDraft(model, intent);
  assert.ok(draft.alternative?.applicable);
  const before = model.serialize();
  for (const confirmed of ['true', 1, {}, null]) {
    assert.throws(() => applyConfirmedDraft(model,
      { draftId: draft.alternative.draftId, confirmed, acceptTargetChanges: true }), /明确确认/);
    assert.equal(model.serialize(), before);
  }
  for (const acceptTargetChanges of ['true', 1, {}, null]) {
    assert.throws(() => applyConfirmedDraft(model,
      { draftId: draft.alternative.draftId, confirmed: true, acceptTargetChanges }), /明确接受/);
    assert.equal(model.serialize(), before);
  }
});

test('comparison accepts only untouched candidates from one snapshot and request', () => {
  const first = makePlanningFixture('S3');
  const a = preparePlanningDraft(first.model, first.intent);
  assert.ok(a.main?.applicable && a.alternative?.applicable);
  assert.deepEqual(compareDrafts([a.alternative, a.main]).map(x => x.draftId),
    [a.main.draftId, a.alternative.draftId]);
  assert.throws(() => compareDrafts([structuredClone(a.main)]), /本地候选/);
  const edited = a.main.financingYuan;
  a.main.financingYuan = edited + E;
  assert.throws(() => compareDrafts([a.main]), /未改写/);
  a.main.financingYuan = edited;
  const second = makePlanningFixture('S3');
  const b = preparePlanningDraft(second.model, { ...second.intent, requestId: 'OTHER-REQUEST' });
  assert.ok(b.main?.applicable);
  assert.throws(() => compareDrafts([a.main, b.main]), /同快照同需求/);
});

test('public preview edits cannot change the private draft applied after re-simulation', () => {
  const { model, intent } = makePlanningFixture('S2');
  const result = preparePlanningDraft(model, intent);
  const preview = result.main;
  assert.ok(preview?.applicable);
  const shownCash = preview.projectedFinalCashYuan;
  preview.projectedFinalCashYuan = 99 * E;
  preview.finalRules.rows.length = 0;
  assert.throws(() => compareDrafts([preview]), /未改写/);
  assert.equal(applyConfirmedDraft(model, { draftId: preview.draftId, confirmed: true }).status, 'applied');
  assert.equal(model.getState().summary.projectedEndOfDayYuan.balanceYuan, shownCash);
  assert.notEqual(shownCash, preview.projectedFinalCashYuan);
});

test('actual financing receipt expires a draft without altering execution facts', () => {
  const { model, intent, expected } = makePlanningFixture('S5');
  const draft = preparePlanningDraft(model, intent);
  assert.ok(draft.alternative?.applicable);
  model.simulateEvent('cash_available', {
    instructionId: expected.facts.financeInstructionId,
    amountYuan: 3 * E, cashFlowId: 'AI-S5-REAL-RECEIPT',
  });
  const afterReceipt = model.serialize();
  assert.equal(model.getState().summary.accountCashYuan, 9 * E);
  assert.throws(() => applyConfirmedDraft(model, {
    draftId: draft.alternative.draftId, confirmed: true, acceptTargetChanges: true,
  }), /过期/);
  assert.equal(model.serialize(), afterReceipt);
});

function sentOldReverseRepo() {
  const { model, intent } = makePlanningFixture('S2');
  model.addPlan({ label: '既有逆回购2亿', businessType: 'reverse_repo', direction: 'outflow',
    targetYuan: 2 * E, repoTerms: { market: 'INTERBANK', tenorDays: 7, annualRate: null } });
  const proposal = model.generateProposal();
  model.approveProposal();
  const instructionId = model.send(proposal.proposal.steps[0].stepId).sentInstructionId;
  return { model, intent, instructionId };
}

test('unknown send outcome cannot yield an executable planning candidate', () => {
  const { model, intent, instructionId } = sentOldReverseRepo();
  assert.equal(model.getState().execution.instructions[instructionId].status, 'unknown');
  const result = preparePlanningDraft(model, intent);
  assert.notEqual(result.status, 'feasible');
  assert.notEqual(result.main?.applicable, true);
});

test('out-of-order authoritative receipt cannot yield an executable planning candidate', () => {
  const { model, intent, instructionId } = sentOldReverseRepo();
  const state = model.getState();
  model.recordEvent({ eventId: 'AI-RECEIPT-GAP', type: 'accepted', instructionId,
    runId: state.context.runId, sourceSequence: state.execution.sourceSequence + 2 });
  assert.equal(Object.keys(model.getState().execution.pending).length, 1);
  const result = preparePlanningDraft(model, intent);
  assert.notEqual(result.status, 'feasible');
  assert.notEqual(result.main?.applicable, true);
});

test('knowledge and model facts in a planning snapshot are deeply immutable', () => {
  const { model, intent } = makePlanningFixture('S2');
  const snapshot = readPlanningSnapshot(model);
  const before = model.serialize();
  assert.equal(snapshot.versions.knowledge, KNOWLEDGE_VERSION);
  assert.ok(Object.isFrozen(snapshot.versions));
  assert.ok(Object.isFrozen(snapshot.saved.initialData.portfolio));
  assert.throws(() => { snapshot.versions.knowledge = 'forged'; }, TypeError);
  assert.throws(() => { snapshot.saved.initialData.portfolio.navYuan = 1; }, TypeError);
  assert.equal(snapshot.versions.knowledge, KNOWLEDGE_VERSION);
  assert.equal(validateIntent(snapshot, intent).ok, true);
  assert.equal(model.serialize(), before);
});
