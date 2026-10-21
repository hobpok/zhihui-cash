import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, deriveBatchReadiness, deriveDispatchGroups, validateSaved, UI_VERSION } from './model.js';
import { evaluateCurrentConcentration } from './engine.js';
import {applyEvent} from './execution.js';
import { createLegacySyntheticInitialTemplate as createSyntheticInitialTemplate,
  createSyntheticInitialTemplate as createSingleDayTemplate } from './initial-data.js';

const yi = 100000000;
const startS10 = () => { const m = createModel(); m.reset('S10'); m.generateProposal(); m.approveProposal(); return m; };
const bondBatch = (count = 2) => {
  const template = createSyntheticInitialTemplate();
  const bond = template.draftPlans.find(p => p.businessType === 'bond_buy');
  template.draftPlans = Array.from({ length: count }, (_,i) =>
    ({ ...bond, label: `合成现券买入${i + 1}`, targetYuan: 10000000 }));
  const model = createModel(); model.startFromTemplate(template); model.generateProposal(); model.approveProposal();
  return model;
};

test('manual batch accepts two independent synthetic steps and preserves distinct instruction IDs', () => {
  const m = bondBatch();
  const before = m.getState();
  assert.equal(before.coreRules.enabled, true);
  assert.equal(before.dispatchGroups.find(g => g.status === 'ready')?.stepIds.length, 2);
  assert.equal(before.batchReadiness.filter(r => r.ready).length, 2);
  const ids = before.proposal.steps.map(step => step.stepId);
  const batch = m.sendBatch(ids);
  assert.equal(batch.stoppedReason, null);
  assert.deepEqual(batch.results.map(r => r.status), ['accepted','accepted']);
  assert.equal(new Set(batch.results.map(r => r.instructionId)).size, 2);
  assert.deepEqual(batch.results.map(r => r.stepId), ids);
  assert.equal(batch.summary.dateBalances.at(-1).availableYuan, before.summary.dateBalances.at(-1).availableYuan - 20000000);
  assert.deepEqual(batch.summary.planBalances.map(b => b.lockedYuan), [10000000,10000000]);
  assert.equal(batch.execution.sourceSequence, 2);
  assert.throws(() => m.send(ids[0]), /已有发送事实/);
  assert.equal(validateSaved(m.serialize()).ok, true);
});

test('blocked overall proposal can approve and batch send only its calculated feasible slice', () => {
  const template = createSingleDayTemplate();
  const repo = template.draftPlans.find(plan => plan.businessType === 'reverse_repo');
  template.draftPlans = [{ ...repo, targetYuan: 1000000000 }];
  const model = createModel();
  model.startFromTemplate(template);
  const proposed = model.generateProposal();
  assert.equal(proposed.proposal.status, 'search_exhausted');
  assert.deepEqual(proposed.proposal.steps.map(step => step.blocked), [false, true]);
  assert.equal(proposed.canApprove, true);
  assert.deepEqual(proposed.approvalEligibleStepIds, [proposed.proposal.steps[0].stepId]);
  assert.equal(proposed.execution.snapshot.quality, 'fresh');
  model.markSnapshotStale();
  const approved = model.approveProposal();
  assert.equal(approved.approvalStatus, 'valid');
  assert.equal(approved.execution.snapshot.quality, 'fresh');
  assert.ok(Date.now() - approved.execution.snapshot.observedAt < 30000);
  assert.deepEqual(approved.batchReadiness.map(row => row.ready), [true, false]);
  assert.match(approved.batchReadiness[1].reason, /阻断|子集/);
  assert.throws(() => model.send(proposed.proposal.steps[1].stepId), /阻断|子集/);
  const batch = model.sendBatch();
  assert.deepEqual(batch.results.map(row => row.status), ['accepted']);
  assert.equal(batch.execution.instructions[batch.results[0].instructionId].filledYuan, 0);
  assert.equal(batch.summary.planBalances[0].lockedYuan, proposed.proposal.steps[0].nominalYuan);
  assert.equal(validateSaved(model.serialize()).ok, true);
});

test('a missing source report prevents review and cannot be washed into a fresh snapshot', () => {
  const model = bondBatch();
  const first = model.getState().proposal.steps[0];
  const sent = model.send(first.stepId).sentInstructionId;
  model.recordEvent({ eventId: 'OUT-OF-ORDER', sourceSequence: 2, type: 'accepted', instructionId: sent });
  const before = model.getState();
  assert.equal(Object.keys(before.execution.pending).length, 1);
  assert.equal(before.canApprove, false);
  assert.throws(() => model.approveProposal(), /回报序号缺失/);
  assert.throws(() => model.refreshSnapshot(), /回报序号缺失/);
  const after = model.getState();
  assert.deepEqual(after.execution.pending, before.execution.pending);
  assert.equal(after.approval.approvalId, before.approval.approvalId);
  assert.equal(after.execution.snapshot.version, before.execution.snapshot.version);
});

test('a newer trace cannot invalidate an older approved copy that reused a step ID', () => {
  const model = startS10();
  const saved = JSON.parse(model.serialize());
  const historicalApprovalId = saved.approval.approvalId;
  saved.proposal.proposalId = `${saved.context.runId}-PROP-2`;
  saved.proposal.version = 2;
  saved.nextProposalId = 3;
  saved.proposal.status = 'insufficient_data';
  saved.proposal.steps[0].blocked = true;
  saved.proposal.groups[0].status = 'blocked';
  saved.calculation.trace.steps[0].rules[0].result = 'missing';
  assert.equal(saved.approval.proposalCopy.steps[0].stepId, saved.proposal.steps[0].stepId);
  assert.equal(validateSaved(saved).ok, true);
  const restored = createModel(saved).getState();
  assert.equal(restored.approval.approvalId, historicalApprovalId);
  assert.equal(restored.approvalStatus, 'stale');
  assert.equal(restored.canApprove, false);
});

test('business preferences survive archives, invalidate review, and never appear in old defaults', () => {
  const template = createSyntheticInitialTemplate();
  template.draftPlans = [template.draftPlans[0],template.draftPlans[3]];
  const model = createModel(); model.startFromTemplate(template);
  model.generateProposal(); model.approveProposal();
  const approvedId = model.getState().approval.approvalId;
  model.setPreferences(['liquidity_last','settlement_safety','fewer_warnings']);
  assert.equal(model.getState().approvalStatus,'stale');
  assert.equal(model.getState().canApprove,false);
  assert.equal(model.getState().proposal,null);
  assert.equal(model.getState().approval.approvalId,approvedId);
  const reordered = model.generateProposal();
  assert.deepEqual(reordered.proposal.steps.map(x =>
    reordered.plans.find(p => p.planId === x.planId).businessType),['bond_buy','reverse_repo']);
  assert.equal(validateSaved(model.serialize()).ok,true);
  const restored = createModel(model.serialize());
  assert.deepEqual(restored.getState().preferences.orderedKeys,
    ['liquidity_last','settlement_safety','fewer_warnings']);
  assert.equal(restored.getState().approvalStatus,'stale');
  assert.throws(() => restored.setPreferences(['reverse_repo_first','liquidity_last']),/偏好/);
  assert.equal(restored.getState().preferences.orderedKeys[0],'liquidity_last');
  const old = createModel().serialize();
  assert.deepEqual(createModel(old).getState().preferences.orderedKeys,[]);
});

test('batch preview cumulatively reserves dated cash and splits the first constrained step without writing facts', () => {
  const m = bondBatch(), saved = m.serialize();
  const changedSource = m.getState();
  changedSource.execution.initialCashYuan -= 255000000; // Hypothetical fresher cash: T+1 capacity is 1500万元.
  const rows = deriveBatchReadiness(changedSource);
  assert.deepEqual(rows.map(r => r.ready),[true,false]);
  assert.equal(rows[0].reason,'最新本地校验通过');
  assert.match(rows[1].reason,/头寸|资金/);
  const groups = deriveDispatchGroups(changedSource,rows);
  assert.deepEqual(groups.map(g => g.status),['ready','blocked']);
  assert.deepEqual(groups[0].stepIds,[changedSource.proposal.steps[0].stepId]);
  assert.equal(Object.keys(changedSource.execution.instructions).length,0);
  assert.equal(m.serialize(),saved);
});

test('batch preview cumulatively checks same-bank exposure and keeps a sent sale unfilled', () => {
  const template = createSyntheticInitialTemplate();
  // Use CD buys to isolate C06's 15% cumulative exposure limit. Deposits now
  // independently stop at the stricter 8% transaction gate before reaching C06.
  const cdBuy = { ...template.draftPlans.find(p => p.businessType === 'deposit'),
    businessType:'cd_buy',securityId:'CD-A',issuerId:'BANK-A',marketTier:'secondary' };
  template.draftPlans = [1,2].map(i => ({...cdBuy,label:`合成A存单买入${i}`,targetYuan:10000000}));
  const m = createModel(); m.startFromTemplate(template); m.generateProposal(); m.approveProposal();
  const changedSource = m.getState();
  const increase = 5885000000;
  changedSource.initialData.holdings.find(h => h.holdingId === 'H-CD-A').amountYuan += increase;
  changedSource.initialData.termWeights.assets.find(w => w.weightId === 'TW-CD-A').amountYuan += increase;
  changedSource.initialData.termWeights.assets.find(w => w.weightId === 'TW-OTHER').amountYuan -= increase;
  const rows = deriveBatchReadiness(changedSource);
  assert.deepEqual(rows.map(r => r.ready),[true,false]);
  assert.equal(rows[1].ruleId,'C06');
  assert.deepEqual(deriveDispatchGroups(changedSource,rows).map(g => g.status),['ready','blocked']);
  assert.equal(Object.keys(changedSource.execution.instructions).length,0);

  const saleTemplate = createSyntheticInitialTemplate();
  saleTemplate.holdings.find(h => h.holdingId === 'H-CD-A').amountYuan += increase;
  saleTemplate.termWeights.assets.find(w => w.weightId === 'TW-CD-A').amountYuan += increase;
  saleTemplate.termWeights.assets.find(w => w.weightId === 'TW-OTHER').amountYuan -= increase;
  const sale = saleTemplate.draftPlans.find(p => p.businessType === 'cd_sell');
  saleTemplate.draftPlans = [{...sale,label:'卖出A银行存单',issuerId:'BANK-A',securityId:'CD-A',targetYuan:20000000},
    {...cdBuy,label:'买入A银行存单',targetYuan:20000000}];
  const saleModel = createModel(); saleModel.startFromTemplate(saleTemplate);
  saleModel.generateProposal(); saleModel.approveProposal();
  const saleRows = deriveBatchReadiness(saleModel.getState());
  assert.deepEqual(saleRows.map(r => r.ready),[true,false]);
  assert.match(saleRows[1].reason,/C06|金融工具/);
  assert.equal(Object.keys(saleModel.getState().execution.instructions).length,0);
});

test('legacy provenance cannot be used to disable C rules on a synthetic template or UI3 archive', () => {
  const synthetic = createSyntheticInitialTemplate();
  const disguisedTemplate = structuredClone(synthetic);
  disguisedTemplate.provenance.kind = 'legacy';
  assert.throws(() => createModel().startFromTemplate(disguisedTemplate),/仅支持当前内置模板/);

  const model = bondBatch();
  const disguisedArchive = JSON.parse(model.serialize());
  disguisedArchive.initialData.provenance.kind = 'legacy';
  assert.equal(validateSaved(disguisedArchive).ok,false);
  assert.throws(() => createModel(disguisedArchive),/历史场景来源/);
  assert.equal(model.getState().coreRules.enabled,true);
});

test('manual batch stops after second unknown result, retains both sends and never replays them', () => {
  const m = bondBatch(3), ids = m.getState().proposal.steps.map(step => step.stepId);
  const batch = m.sendBatch(ids,{receiptMode:'unknown'});
  assert.deepEqual(batch.results.map(r => r.status), ['accepted','unknown','not_sent']);
  assert.equal(batch.execution.instructions[batch.results[0].instructionId].status, 'accepted');
  assert.equal(batch.execution.instructions[batch.results[1].instructionId].status, 'unknown');
  assert.equal(batch.execution.sourceSequence, 1);
  assert.equal(Object.keys(batch.execution.instructions).length, 2);
  assert.equal(batch.batchReadiness.find(r => r.stepId === ids[2]).ready,false);
  assert.match(batch.batchReadiness.find(r => r.stepId === ids[2]).reason,/结果未知/);
  assert.equal(batch.dispatchGroups.some(g => g.status === 'ready'),false);
  assert.throws(() => m.sendBatch(ids), /结果未知/);
  assert.throws(() => m.send(ids[1]), /已有发送事实/);
  assert.throws(() => m.send(ids[2]), /结果未知/);
  m.simulateEvent('accepted',{instructionId:batch.results[1].instructionId});
  assert.equal(m.getState().batchReadiness.find(r => r.stepId === ids[2]).ready,true);
  assert.equal(validateSaved(m.serialize()).ok, true);
});

test('manual batch rejects second send with no reservation and retains first receipt', () => {
  const m = bondBatch(3), ids = m.getState().proposal.steps.map(step => step.stepId);
  const batch = m.sendBatch(ids,{receiptMode:'rejected'});
  assert.deepEqual(batch.results.map(r => r.status), ['accepted','rejected','not_sent']);
  assert.equal(batch.execution.instructions[batch.results[0].instructionId].status, 'accepted');
  assert.equal(batch.execution.instructions[batch.results[1].instructionId].status, 'rejected');
  assert.equal(batch.execution.sourceSequence, 2);
  assert.deepEqual(batch.summary.planBalances.map(b => b.lockedYuan), [10000000,0,0]);
  assert.throws(() => m.send(ids[1]), /已有发送事实/);
  assert.equal(validateSaved(m.serialize()).ok, true);
});

test('changed rule configuration invalidates approval before either single or batch dispatch', () => {
  const m = startS10();
  m.setRuleConfig({ depositThreshold:'0.07' });
  assert.equal(m.getState().approvalStatus, 'stale');
  assert.throws(() => m.send('I-A'), /审核/);
  assert.throws(() => m.sendBatch(['I-A']), /审核/);
  assert.equal(Object.keys(m.getState().execution.instructions).length, 0);
});

test('batch rechecks cumulative cash and stops before a dependent second send', () => {
  const m = startS10();
  const batch = m.sendBatch(['I-A','I-B']);
  assert.deepEqual(batch.results.map(r => r.status), ['accepted','not_sent']);
  assert.match(batch.stoppedReason,/资金/);
  assert.equal(batch.summary.planBalances[0].lockedYuan,3 * yi);
  assert.equal(Object.keys(batch.execution.instructions).length,1);
  assert.equal(batch.execution.instructions[batch.results[0].instructionId].status,'accepted');
});

test('restored C run retains approved copy but requires a fresh calculation and review', () => {
  const original = bondBatch();
  const approvalId = original.getState().approval.approvalId;
  const restored = createModel(original.serialize());
  assert.equal(restored.getState().approval.approvalId,approvalId);
  assert.equal(restored.getState().approvalStatus,'stale');
  assert.throws(() => restored.sendBatch(),/审核/);
  restored.refreshSnapshot(); restored.generateProposal(); restored.approveProposal();
  const result = restored.sendBatch();
  assert.deepEqual(result.results.map(r => r.status),['accepted','accepted']);
  assert.notEqual(result.approval.approvalId,approvalId);
});

test('synthetic C reservations release only after both cancellation confirmations', () => {
  const m = bondBatch();
  const before = m.getState();
  const step = before.proposal.steps[0];
  const instructionId = m.send(step.stepId).sentInstructionId;
  m.simulateEvent('accepted',{instructionId});
  const afterSend = m.getState();
  assert.equal(afterSend.summary.planBalances[0].lockedYuan,10000000);
  assert.equal(afterSend.summary.dateBalances.at(-1).availableYuan,
    before.summary.dateBalances.at(-1).availableYuan - 10000000);
  const cancelRequestId = m.requestCancel(instructionId).cancelRequestId;
  const evidence = {instructionId,cancelRequestId,cancelSliceId:'C-cancel',nominalYuan:10000000,
    reservationId:instructionId,releaseYuan:10000000};
  m.simulateEvent('cancel_confirmed',{...evidence,nominalConfirmed:true});
  assert.equal(m.getState().summary.planBalances[0].lockedYuan,10000000);
  m.simulateEvent('cancel_confirmed',{...evidence,releaseConfirmed:true});
  const afterCancel = m.getState();
  assert.equal(afterCancel.summary.planBalances[0].lockedYuan,0);
  assert.equal(afterCancel.summary.dateBalances.at(-1).availableYuan,
    before.summary.dateBalances.at(-1).availableYuan);
  assert.equal(afterCancel.coreRules.rows.find(r => r.ruleId === 'C09').currentValue,
    before.coreRules.rows.find(r => r.ruleId === 'C09').currentValue);
});

test('simulation contract keeps unknown input unknown and stores calculation trace', () => {
  const m = createModel(); m.setInputs({ initialCashYuan: null });
  assert.equal(m.getState().summary.availableYuan, null);
  m.generateProposal('AUTO');
  assert.equal(m.getState().proposal.origin, 'calculated');
  assert.ok(m.getState().calculation.trace);
  assert.equal(m.getState().uiVersion, UI_VERSION);
  assert.equal(validateSaved(m.serialize()).ok, true);
});

test('S10 approval covers 3 and 7 in separate manual sends, with 5+2 funding insufficient until complete', () => {
  const m = startS10();
  const a = m.send('I-A').sentInstructionId;
  assert.equal(m.getState().summary.localReservedYuan, 3 * yi);
  assert.throws(() => m.send('I-A'), /已有发送事实/);
  m.simulateEvent('accepted', { instructionId: a });
  assert.equal(m.getState().summary.platformReservedYuan, 3 * yi);
  m.simulateEvent('fill', { instructionId: a, nominalYuan: 3 * yi });
  assert.equal(m.getState().summary.payableReservedYuan, 3 * yi);
  m.simulateEvent('cash_settled', { instructionId: a, amountYuan: 3 * yi, cashFlowId: 'pay-a' });
  assert.equal(m.getState().summary.settledBalanceYuan, 0);
  m.confirmFunding(5 * yi);
  assert.throws(() => m.send('I-B'), /资金/);
  m.confirmFunding(2 * yi);
  const b = m.send('I-B').sentInstructionId;
  m.simulateEvent('accepted', { instructionId: b });
  m.simulateEvent('fill', { instructionId: b, nominalYuan: 7 * yi });
  m.simulateEvent('cash_settled', { instructionId: b, amountYuan: 7 * yi, cashFlowId: 'pay-b' });
  const s = m.getState();
  assert.deepEqual([s.summary.settledBalanceYuan, s.summary.availableYuan], [0, 0]);
  assert.deepEqual([s.summary.planBalances[0].filledYuan, s.summary.planBalances[0].lockedYuan, s.summary.planBalances[0].arrangeableYuan], [10 * yi, 0, 0]);
  assert.equal(validateSaved(m.serialize()).ok, true);
});

test('stale and restored snapshots block dispatch and retain original send identity', () => {
  const m = startS10(), a = m.send('I-A').sentInstructionId;
  m.simulateEvent('accepted', { instructionId: a });
  m.simulateEvent('fill', { instructionId: a, nominalYuan: 3 * yi });
  m.simulateEvent('cash_settled', { instructionId: a, amountYuan: 3 * yi, cashFlowId: 'p-a' });
  m.confirmFunding(7 * yi); m.markSnapshotStale();
  assert.throws(() => m.send('I-B'), /过期/);
  m.refreshSnapshot();
  const restored = createModel(m.serialize());
  assert.equal(restored.getState().execution.requiresRefresh, true);
  assert.equal(restored.getState().approvalStatus, 'stale');
  assert.throws(() => restored.send('I-B'), /审核/);
  restored.refreshSnapshot();
  restored.generateProposal(); restored.approveProposal();
  assert.throws(() => restored.send('I-A'), /没有当前可下达/);
  restored.send('I-B');
  assert.equal(Object.keys(restored.getState().execution.instructions).length, 2);
});

test('execution facts prevent plan object replacement and target below filled plus lock', () => {
  const m = startS10(); m.send('I-A');
  assert.throws(() => m.updatePlan('P10', { businessType: 'deposit' }), /仅可修改/);
  assert.throws(() => m.updatePlan('P10', { targetYuan: 2 * yi }), /意向金额不得低于/);
  assert.throws(() => m.deletePlan('P10'), /不可删除/);
  m.updatePlan('P10', { targetYuan: 12 * yi });
  assert.equal(m.getState().summary.planBalances[0].lockedYuan, 3 * yi);
  assert.equal(m.getState().approvalStatus, 'stale');
});

test('S13 independent funded steps need no artificial fill dependency', () => {
  const m = createModel(); m.generateProposal('A'); m.approveProposal();
  const steps = m.getState().proposal.steps;
  const sale = m.send(steps[0].stepId).sentInstructionId;
  m.simulateEvent('accepted', { instructionId: sale });
  assert.equal(m.getState().stepReadiness[1].ready, true);
  m.simulateEvent('fill', { instructionId: sale, nominalYuan: 2 * yi });
  m.simulateEvent('cash_settled', { instructionId: sale, amountYuan: 2 * yi, cashFlowId: 'sale-settle' });
  assert.equal(m.getState().stepReadiness[1].ready, true);
  m.simulateEvent('cash_available', { instructionId: sale, amountYuan: 2 * yi, cashFlowId: 'sale-available' });
  assert.equal(m.getState().stepReadiness[1].ready, true);
  const dep = m.send(steps[1].stepId).sentInstructionId;
  m.simulateEvent('accepted', { instructionId: dep });
  assert.equal(m.getState().stepReadiness[2].ready, true);
  m.simulateEvent('fill', { instructionId: dep, nominalYuan: yi });
  assert.equal(m.getState().stepReadiness[2].ready, true);
});

test('nonzero fee can be calculated but cannot be sent without a cash allocation contract', () => {
  const m = createModel(); m.reset('S10'); m.setInputs({ initialCashYuan: 310000000, feeYuan: 10000000 });
  m.generateProposal();
  assert.equal(m.getState().proposal.steps.length, 2);
  m.approveProposal();
  assert.match(m.getState().stepReadiness[0].reason, /非零费用/);
  assert.throws(() => m.send(), /非零费用|没有当前可下达/);
});

test('historical partly filled deposit retains facts and its released residual gets a new approved whole step', () => {
  let m = createModel(); m.generateProposal('A'); m.approveProposal();
  const [saleStep, depositStep] = m.getState().proposal.steps;
  const sale = m.send(saleStep.stepId).sentInstructionId;
  m.simulateEvent('accepted', { instructionId: sale });
  m.simulateEvent('fill', { instructionId: sale, nominalYuan: 2 * yi });
  m.simulateEvent('cash_settled', { instructionId: sale, amountYuan: 2 * yi, cashFlowId: 'sale-set' });
  m.simulateEvent('cash_available', { instructionId: sale, amountYuan: 2 * yi, cashFlowId: 'sale-avail' });
  const deposit = m.send(depositStep.stepId).sentInstructionId;
  m.simulateEvent('accepted', { instructionId: deposit });
  // A pre-rule partial fill remains an auditable fact on restore. New live
  // deposit fills cannot manufacture this state.
  const historical=JSON.parse(m.serialize());
  historical.execution.instructions[deposit].businessType='reverse_repo';
  historical.execution.journal.find(row=>row.kind==='send' && row.instruction.instructionId===deposit)
    .instruction.businessType='reverse_repo';
  const sequence=historical.execution.nextLocalEvent++;
  historical.execution=applyEvent(historical.execution,{type:'fill',instructionId:deposit,
    eventId:`${historical.context.runId}-E-${sequence}`,sourceSequence:historical.execution.sourceSequence+1,
    nominalYuan:40000000,fillId:`${historical.context.runId}-OLD-PARTIAL`}).execution;
  historical.execution.instructions[deposit].businessType='deposit';
  historical.execution.journal.find(row=>row.kind==='send' && row.instruction.instructionId===deposit)
    .instruction.businessType='deposit';
  m=createModel(historical);
  const cancelRequestId = m.requestCancel(deposit).cancelRequestId;
  const evidence = { instructionId: deposit, cancelRequestId, cancelSliceId: 'part-1',
    nominalYuan: 60000000, reservationId: deposit, releaseYuan: 60000000 };
  m.simulateEvent('cancel_confirmed', { ...evidence, nominalConfirmed: true });
  assert.equal(m.getState().summary.planBalances.find(p => p.planId === 'P-DEP').lockedYuan, 60000000);
  m.simulateEvent('cancel_confirmed', { ...evidence, releaseConfirmed: true });
  m.generateProposal('A'); m.approveProposal();
  const replacement = m.getState().proposal.steps.find(x => x.planId === 'P-DEP');
  assert.equal(replacement.nominalYuan, 60000000);
  assert.notEqual(replacement.stepId, depositStep.stepId);
  assert.ok(m.getState().calculation.trace.steps.some(x => x.stepId === replacement.stepId));
  assert.equal(m.getState().stepReadiness.find(x => x.stepId === replacement.stepId).ready, true);
  const replacementId = m.send(replacement.stepId).sentInstructionId;
  assert.notEqual(replacementId, deposit);
});

const addRepo = (model, type, market, amount = 7 * yi) => model.addPlan({ label: market + '正回购',
  businessType: type, direction: 'inflow', targetYuan: amount,
  repoTerms: { market, tenorDays: 1, annualRate: null } }).plans.at(-1);

test('interbank borrowing reserves collateral, creates debt, and credits only available cash', () => {
  const m = createModel(); m.reset('S10');
  const repo = addRepo(m, 'interbank_repo_financing', 'INTERBANK');
  m.generateProposal();
  assert.equal(m.getState().proposal.status, 'insufficient_data');
  m.setRepoResources('INTERBANK', { pledgeConfirmedYuan: 7 * yi });
  m.generateProposal(); m.approveProposal();
  const step = m.getState().proposal.steps.find(s => s.planId === repo.planId);
  assert.equal(m.getState().stepReadiness.find(s => s.stepId === step.stepId).ready, true);
  const id = m.send(step.stepId).sentInstructionId;
  assert.equal(m.getState().summary.pledgeUsedByMarket.INTERBANK, 7 * yi);
  m.simulateEvent('accepted', { instructionId: id });
  m.simulateEvent('fill', { instructionId: id, nominalYuan: 7 * yi });
  assert.equal(m.getState().summary.availableYuan, 3 * yi);
  assert.equal(m.getState().summary.financingPrincipalYuan, 7 * yi);
  assert.equal(m.getState().summary.repoLiabilities[0].interestYuan, null);
  m.simulateEvent('cash_available', { instructionId: id, amountYuan: 7 * yi, cashFlowId: 'repo-account-available' });
  assert.equal(m.getState().summary.availableYuan, 10 * yi);
  const outflowStep = m.getState().proposal.steps.find(s => s.planId === 'P10');
  assert.equal(m.getState().stepReadiness.find(s => s.stepId === outflowStep.stepId).ready, true);
  assert.equal(validateSaved(m.serialize()).ok, true);
});

test('single-day financing fill enters business cash and end-of-day projection once', () => {
  const template = createSingleDayTemplate();
  template.pendingSettlements = [];
  template.draftPlans = [{...template.draftPlans.find(p => p.businessType === 'reverse_repo'),
    label:'合成银行间融资',businessType:'interbank_repo_financing',direction:'inflow',
    targetYuan:yi,repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}}];
  const model = createModel(); model.startFromTemplate(template);
  const before = model.getState();
  assert.equal(before.summary.projectedEndOfDayYuan.balanceYuan,before.summary.availableYuan+yi);
  model.generateProposal(); model.approveProposal();
  const id = model.send(model.getState().proposal.steps[0].stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:id});
  model.simulateEvent('fill',{instructionId:id,nominalYuan:yi});
  const filled = model.getState();
  assert.equal(filled.summary.availableYuan,before.summary.availableYuan+yi);
  assert.equal(filled.summary.accountCashYuan,before.summary.accountCashYuan);
  assert.equal(filled.summary.cashRatioBasis.businessCashYuan,filled.summary.availableYuan);
  assert.equal(filled.summary.projectedEndOfDayYuan.balanceYuan,before.summary.availableYuan+yi);
  model.simulateEvent('cash_available',{instructionId:id,amountYuan:yi,cashFlowId:'FIN-CASH'});
  const credited = model.getState();
  assert.equal(credited.summary.availableYuan,filled.summary.availableYuan);
  assert.equal(credited.summary.accountCashYuan,before.summary.accountCashYuan+yi);
  assert.equal(credited.summary.projectedEndOfDayYuan.balanceYuan,filled.summary.projectedEndOfDayYuan.balanceYuan);
});

test('single-day sale fill improves C01 and C02 before receipt, while purchase payment uses account cash', () => {
  const template = createSingleDayTemplate();
  template.pendingSettlements = [];
  template.draftPlans = [
    {...template.draftPlans.find(p => p.businessType === 'cd_sell')},
    {...template.draftPlans.find(p => p.businessType === 'bond_buy'),targetYuan:525000000},
  ];
  const model = createModel(); model.startFromTemplate(template);
  const initial = model.getState();
  const initialEnd = initial.summary.projectedEndOfDayYuan.balanceYuan;
  const initialC02 = initial.coreRules.rows.find(r => r.ruleId === 'C02').numeratorYuan;
  model.generateProposal(); model.approveProposal();
  const steps = model.getState().proposal.steps;
  const saleStep = steps.find(s => model.getState().plans.find(p => p.planId === s.planId).businessType === 'cd_sell');
  const buyStep = steps.find(s => model.getState().plans.find(p => p.planId === s.planId).businessType === 'bond_buy');
  assert.ok(buyStep.machineConditions.some(c => c.kind === 'funds_available' && c.basis === 'fill' &&
    c.planId === saleStep.planId));
  assert.equal(model.getState().stepReadiness.find(s => s.stepId === buyStep.stepId).ready,false);
  const saleId = model.send(saleStep.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:saleId});
  model.simulateEvent('fill',{instructionId:saleId,nominalYuan:50000000});
  let state = model.getState();
  assert.deepEqual([state.summary.accountCashYuan,state.summary.availableYuan,state.summary.saleUncreditedYuan],
    [3*yi,550000000,50000000]);
  assert.equal(state.coreRules.rows.find(r => r.ruleId === 'C01').currentValue,550000000);
  assert.equal(state.coreRules.rows.find(r => r.ruleId === 'C02').numeratorYuan,initialC02+50000000);
  assert.equal(state.summary.projectedEndOfDayYuan.balanceYuan,initialEnd);
  assert.equal(state.stepReadiness.find(s => s.stepId === buyStep.stepId).ready,true);
  const buyId = model.send(buyStep.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:buyId});
  model.simulateEvent('fill',{instructionId:buyId,nominalYuan:525000000});
  assert.throws(() => model.simulateEvent('cash_settled',
    {instructionId:buyId,amountYuan:525000000,cashFlowId:'BUY-PRE-RECEIPT'}),/实际账户现金不足/);
  model.simulateEvent('cash_settled',{instructionId:saleId,amountYuan:50000000,cashFlowId:'SALE-SETTLED'});
  model.simulateEvent('cash_available',{instructionId:saleId,amountYuan:50000000,cashFlowId:'SALE-RECEIVED'});
  state = model.getState();
  assert.deepEqual([state.summary.accountCashYuan,state.summary.availableYuan,state.summary.saleUncreditedYuan],
    [350000000,25000000,0]);
  assert.equal(state.coreRules.rows.find(r => r.ruleId === 'C02').numeratorYuan,2525000000);
  assert.equal(state.summary.projectedEndOfDayYuan.balanceYuan,initialEnd);
  model.recordCashEvent({eventId:'MATURITY-RECEIVED',sourceId:'MAT-T0-DEP-A',amountYuan:2*yi});
  model.simulateEvent('cash_settled',{instructionId:buyId,amountYuan:525000000,cashFlowId:'BUY-PAID'});
  state = model.getState();
  assert.equal(state.summary.accountCashYuan,25000000);
  assert.equal(state.summary.availableYuan,25000000);
  assert.equal(validateSaved(model.serialize()).ok,true);
});

test('single-day buy depending on financing becomes dispatchable at fill, while payment waits', () => {
  const template = createSingleDayTemplate();
  template.pendingSettlements = [];
  template.portfolio.bufferYuan = 3*yi;
  template.draftPlans = [
    {...template.draftPlans.find(p => p.businessType === 'reverse_repo'),
      label:'合成银行间融资',businessType:'interbank_repo_financing',direction:'inflow',
      targetYuan:2*yi,repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}},
    {...template.draftPlans.find(p => p.businessType === 'bond_buy'),targetYuan:4*yi},
  ];
  const model = createModel(); model.startFromTemplate(template);
  model.generateProposal(); model.approveProposal();
  const proposed = model.getState();
  const funding = proposed.proposal.steps.find(step =>
    proposed.plans.find(p => p.planId === step.planId)?.businessType === 'interbank_repo_financing');
  const buy = proposed.proposal.steps.find(step =>
    proposed.plans.find(p => p.planId === step.planId)?.businessType === 'bond_buy');
  assert.ok(funding && buy);
  assert.ok(buy.machineConditions.some(c => c.kind === 'funds_available' && c.basis === 'fill' &&
    c.planId === funding.planId && c.minimumYuan === 2*yi));
  const id = model.send(funding.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:id});
  assert.equal(model.getState().stepReadiness.find(r => r.stepId === buy.stepId).ready,false);
  model.simulateEvent('fill',{instructionId:id,nominalYuan:2*yi});
  assert.equal(model.getState().stepReadiness.find(r => r.stepId === buy.stepId).ready,true);
  const buyId = model.send(buy.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:buyId});
  model.simulateEvent('fill',{instructionId:buyId,nominalYuan:4*yi});
  assert.throws(() => model.simulateEvent('cash_settled',{
    instructionId:buyId,amountYuan:4*yi,cashFlowId:'BUY-PAY-BEFORE'}),/不足/);
});

test('exchange financing uses send window and authoritative trade time, including after-close report', () => {
  const m = createModel(); m.reset('S10');
  const repo = addRepo(m, 'exchange_repo_financing', 'SSE');
  m.setRepoResources('SSE', { pledgeConfirmedYuan: 7 * yi });
  m.setMarketClock({ time: '15:29:00' });
  m.generateProposal(); m.approveProposal();
  const step = m.getState().proposal.steps.find(s => s.planId === repo.planId);
  const id = m.send(step.stepId).sentInstructionId;
  m.simulateEvent('accepted', { instructionId: id });
  m.setMarketClock({ time: '15:31:00' });
  assert.throws(() => m.simulateEvent('fill', { instructionId: id, nominalYuan: 7 * yi, tradeTime: '15:30:01' }), /成交时间|窗口/);
  m.simulateEvent('fill', { instructionId: id, nominalYuan: 7 * yi, tradeTime: '15:29:30' });
  assert.equal(m.getState().summary.financingPrincipalYuan, 7 * yi);
  m.simulateEvent('cash_available', { instructionId: id, amountYuan: 7 * yi, cashFlowId: 'repo-open' });
  assert.equal(m.getState().summary.availableYuan, 10 * yi);
  assert.throws(() => m.setMarketClock({ time: '15:29:00' }), /倒流/);
  const saved = m.serialize();
  assert.equal(validateSaved(saved).ok, true);
});

test('v1 execution archive migrates old facts without restoring dispatch authority', () => {
  const m = startS10();
  const id = m.send('I-A').sentInstructionId;
  m.simulateEvent('accepted', { instructionId: id });
  m.simulateEvent('fill', { instructionId: id, nominalYuan: yi });
  const old = JSON.parse(m.serialize());
  old.uiVersion = 'simulation-ui-1'; old.contractMapping = 'simulation-execution-1';
  delete old.initialData;
  delete old.repoResources; delete old.repoResourcesVersion; delete old.marketClock;
  for (const plan of old.plans) for (const key of
    ['repoTerms','tradeDate','settlementDate','securityId','marketTier']) delete plan[key];
  old.execution.version = 'simulation-execution-1';
  delete old.execution.openingFacts; delete old.execution.cashEventReceipts;
  for (const instruction of Object.values(old.execution.instructions)) for (const key of
    ['businessType','repoMarket','repoTerms','sentTime','sentTradingDay',
      'tradeDate','settlementDate','securityId','marketTier']) delete instruction[key];
  for (const entry of old.execution.journal) if (entry.kind === 'send') for (const key of
    ['businessType','repoMarket','repoTerms','sentTime','sentTradingDay',
      'tradeDate','settlementDate','securityId','marketTier']) delete entry.instruction[key];
  assert.equal(validateSaved(old).ok, true);
  const forged = structuredClone(old);
  forged.plans[0].businessType = 'exchange_repo_lending';
  assert.equal(validateSaved(forged).ok, false);
  forged.plans[0].businessType = 'bond_sell';
  assert.equal(validateSaved(forged).ok, false);
  const restored = createModel(old);
  assert.equal(restored.getState().summary.planBalances[0].filledYuan, yi);
  assert.equal(restored.getState().summary.planBalances[0].lockedYuan, 2 * yi);
  assert.equal(restored.getState().approvalStatus, 'stale');
  assert.throws(() => restored.send('I-A'), /审核/);
  assert.equal(restored.getState().uiVersion, UI_VERSION);
  const added = restored.addPlan({ label: '旧档恢复后新增', businessType: 'reverse_repo',
    direction: 'outflow', targetYuan: yi }).plans.at(-1);
  assert.equal(restored.getState().summary.planBalances.find(b => b.planId === 'P10').filledYuan, yi);
  assert.equal(restored.getState().summary.planBalances.find(b => b.planId === added.planId).arrangeableYuan, yi);
  assert.equal(validateSaved(restored.serialize()).ok, true);
});

test('financing cancellation releases pledged resources only with explicit evidence', () => {
  const m = createModel(); m.reset('S10');
  const repo = addRepo(m, 'interbank_repo_financing', 'INTERBANK');
  m.setRepoResources('INTERBANK', { pledgeConfirmedYuan: 7 * yi });
  m.generateProposal(); m.approveProposal();
  const step = m.getState().proposal.steps.find(s => s.planId === repo.planId);
  const id = m.send(step.stepId).sentInstructionId;
  m.simulateEvent('accepted', { instructionId: id });
  m.simulateEvent('fill', { instructionId: id, nominalYuan: 3 * yi });
  const cancelRequestId = m.requestCancel(id).cancelRequestId;
  const evidence = { instructionId: id, cancelRequestId, cancelSliceId: 'repo-rest',
    nominalYuan: 4 * yi, reservationId: id, releaseYuan: 4 * yi };
  m.simulateEvent('cancel_confirmed', { ...evidence, nominalConfirmed: true });
  assert.throws(() => m.simulateEvent('cancel_confirmed', { ...evidence, releaseConfirmed: true }), /质押占用/);
  assert.equal(m.getState().summary.pledgeUsedByMarket.INTERBANK, 7 * yi);
  m.simulateEvent('cancel_confirmed', { ...evidence, releaseConfirmed: true, repoResourcesReleased: true });
  assert.equal(m.getState().summary.pledgeUsedByMarket.INTERBANK, 3 * yi);
  assert.equal(m.getState().summary.financingPrincipalYuan, 3 * yi);
});

const addLending = (m, amountYuan = yi) => m.addPlan({ label:'交易所融券（逆回购）',
  businessType:'exchange_repo_lending', direction:'outflow', targetYuan:amountYuan,
  repoTerms:{market:'SSE',tenorDays:7,annualRate:null} }).plans.at(-1);

test('exchange repo lending locks cash, keeps partial fill, settles outflow and releases only cancelled remainder', () => {
  const m = createModel(); m.reset('S10'); m.deletePlan('P10');
  const loan = addLending(m);
  m.generateProposal(); m.approveProposal();
  const step = m.getState().proposal.steps.find(s => s.planId === loan.planId);
  const id = m.send(step.stepId).sentInstructionId;
  assert.equal(m.getState().summary.localReservedYuan, yi);
  assert.deepEqual(m.getState().summary.quotaUsedByMarket, { INTERBANK:0, SSE:0, SZSE:0 });
  m.simulateEvent('accepted', { instructionId:id });
  m.simulateEvent('fill', { instructionId:id, nominalYuan:40000000, tradeTime:'09:30:00' });
  let s = m.getState().summary;
  assert.deepEqual([s.platformReservedYuan,s.payableReservedYuan,s.reverseRepoReceivableYuan,s.financingPrincipalYuan],
    [60000000,40000000,40000000,0]);
  assert.throws(() => m.simulateEvent('cash_available', { instructionId:id, cashFlowId:'fake-borrowed', amountYuan:40000000 }), /流入指令/);
  m.simulateEvent('cash_settled', { instructionId:id, cashFlowId:'lend-paid', amountYuan:40000000 });
  assert.equal(m.getState().summary.settledBalanceYuan,260000000);
  const cancelRequestId = m.requestCancel(id).cancelRequestId;
  const ev = { instructionId:id, cancelRequestId, cancelSliceId:'unused', nominalYuan:60000000,
    reservationId:id, releaseYuan:60000000 };
  m.simulateEvent('cancel_confirmed', { ...ev, nominalConfirmed:true });
  assert.equal(m.getState().summary.planBalances.find(p => p.planId === loan.planId).lockedYuan,60000000);
  m.simulateEvent('cancel_confirmed', { ...ev, releaseConfirmed:true });
  s = m.getState().summary;
  const b = s.planBalances.find(p => p.planId === loan.planId);
  assert.deepEqual([b.filledYuan,b.lockedYuan,b.arrangeableYuan,s.reverseRepoReceivableYuan],
    [40000000,0,60000000,40000000]);
  assert.equal(s.quotaUsedByMarket.SSE,0);
  assert.equal(validateSaved(m.serialize()).ok,true);
  const restored = createModel(m.serialize());
  assert.equal(restored.getState().summary.reverseRepoReceivableYuan,40000000);
  assert.equal(restored.getState().approvalStatus,'stale');
  assert.throws(() => restored.send(step.stepId), /审核/);
});

test('exchange lending respects cash, session, trade timestamp and known exchange tenors', () => {
  const m = createModel(); m.reset('S10'); m.deletePlan('P10'); m.setInputs({initialCashYuan:0});
  assert.throws(() => addLending(m,400000001), /业务单位/);
  assert.throws(() => m.addPlan({ label:'非法期限', businessType:'exchange_repo_lending', direction:'outflow',
    targetYuan:yi, repoTerms:{market:'SSE',tenorDays:5,annualRate:null} }), /计划类型|期限/);
  const loan = addLending(m,4 * yi);
  m.generateProposal(); m.approveProposal();
  const step = m.getState().proposal.steps.find(s => s.planId === loan.planId);
  assert.equal(m.getState().stepReadiness.find(s => s.stepId === step.stepId).ready,false);
  assert.throws(() => m.send(step.stepId), /资金/);
  const x = createModel(); x.reset('S10'); x.deletePlan('P10'); addLending(x,yi);
  x.setMarketClock({time:'15:30:00'}); x.generateProposal();
  assert.throws(() => x.approveProposal(), /没有可审核/);
  assert.throws(() => x.send(), /审核/);
  const y = createModel(); y.reset('S10'); y.deletePlan('P10'); const p = addLending(y,yi);
  y.setMarketClock({time:'15:29:00'}); y.generateProposal(); y.approveProposal();
  const lend = y.getState().proposal.steps.find(s => s.planId === p.planId);
  const id = y.send(lend.stepId).sentInstructionId;
  y.simulateEvent('accepted',{instructionId:id});
  y.setMarketClock({time:'15:31:00'});
  assert.throws(() => y.simulateEvent('fill',{instructionId:id,nominalYuan:yi,tradeTime:'15:30:01'}), /窗口|成交时间/);
  y.simulateEvent('fill',{instructionId:id,nominalYuan:yi,tradeTime:'15:29:30'});
  assert.equal(y.getState().summary.reverseRepoReceivableYuan,yi);
  assert.throws(() => y.requestCancel(id), /可撤单窗口/);
});

test('new bond sale can be planned but cannot dispatch without verified sellable holdings', () => {
  const m = createModel(); m.reset('S10'); m.deletePlan('P10');
  const plan = m.addPlan({label:'其他现券卖出',businessType:'bond_sell',direction:'inflow',
    issuerId:'ISSUER-NEW',targetYuan:yi}).plans.at(-1);
  m.generateProposal(); m.approveProposal();
  const step = m.getState().proposal.steps.find(s => s.planId === plan.planId);
  assert.ok(step.machineConditions.some(c => c.kind === 'holding_confirmed'));
  assert.equal(m.getState().stepReadiness.find(s => s.stepId === step.stepId).ready,false);
  assert.match(m.getState().stepReadiness.find(s => s.stepId === step.stepId).reason,/持仓可卖量未核实/);
  assert.throws(() => m.send(step.stepId),/持仓可卖量未核实/);
  assert.equal(Object.keys(m.getState().execution.instructions).length,0);
  assert.equal(validateSaved(m.serialize()).ok,true);
});

test('new plan after an S10 fill preserves the instruction, payable and audit boundary', () => {
  const m = startS10();
  const sent = m.send('I-A').sentInstructionId;
  m.simulateEvent('accepted', { instructionId: sent });
  m.simulateEvent('fill', { instructionId: sent, nominalYuan: yi });
  const before = m.getState();
  const added = m.addPlan({ label: '盘中新增逆回购', businessType: 'reverse_repo',
    direction: 'outflow', targetYuan: yi }).plans.at(-1);
  const after = m.getState();
  assert.match(added.planId, /-P-1$/);
  assert.deepEqual(after.execution.journal, before.execution.journal);
  assert.equal(after.summary.payableReservedYuan, yi);
  assert.equal(after.summary.planBalances.find(b => b.planId === 'P10').filledYuan, yi);
  assert.equal(after.summary.planBalances.find(b => b.planId === 'P10').lockedYuan, 2 * yi);
  assert.equal(after.summary.planBalances.find(b => b.planId === added.planId).arrangeableYuan, yi);
  assert.equal(after.approvalStatus, 'stale');
  assert.equal(after.proposal, null);
  assert.throws(() => m.setInputs({ initialCashYuan: 9 * yi }), /已有历史进度或执行事实/);
  assert.throws(() => m.selectProgress('filled3'), /不可切换/);
  assert.throws(() => m.send('I-B'), /审核/);
  assert.equal(validateSaved(m.serialize()).ok, true);
  const restored = createModel(m.serialize());
  assert.equal(restored.getState().summary.payableReservedYuan, yi);
  assert.equal(restored.getState().summary.planBalances.find(b => b.planId === added.planId).arrangeableYuan, yi);
  assert.equal(restored.getState().approvalStatus, 'stale');
});

test('new plan while cancellation is pending retains full locked remainder', () => {
  const m = startS10();
  const sent = m.send('I-A').sentInstructionId;
  m.simulateEvent('accepted', { instructionId: sent });
  const cancelRequestId = m.requestCancel(sent).cancelRequestId;
  const before = m.getState();
  const added = m.addPlan({ label: '撤改待确认时新增', businessType: 'reverse_repo',
    direction: 'outflow', targetYuan: yi }).plans.at(-1);
  const after = m.getState();
  assert.deepEqual(after.execution.cancels[cancelRequestId], before.execution.cancels[cancelRequestId]);
  assert.equal(after.summary.platformReservedYuan, 3 * yi);
  assert.equal(after.summary.planBalances.find(b => b.planId === 'P10').lockedYuan, 3 * yi);
  assert.equal(after.summary.planBalances.find(b => b.planId === added.planId).arrangeableYuan, yi);
  assert.equal(after.approvalStatus, 'stale');
  assert.equal(validateSaved(m.serialize()).ok, true);
});

test('historical progress remains read-only after adding and restoring a new plan', () => {
  const m = createModel(); m.reset('S10'); m.selectProgress('filled3');
  const historical = structuredClone(m.getState().progress);
  const old = m.serialize();
  const added = m.addPlan({ label: '独立意向', businessType: 'reverse_repo',
    direction: 'outflow', targetYuan: yi }).plans.at(-1);
  assert.deepEqual(m.getState().progress, historical);
  assert.equal(m.getState().summary.planBalances.find(b => b.planId === 'P10').filledYuan, 3 * yi);
  assert.equal(m.getState().summary.planBalances.find(b => b.planId === added.planId).filledYuan, 0);
  assert.throws(() => m.selectProgress('settled3'), /不可切换/);
  assert.throws(() => m.setInputs({ initialCashYuan: 4 * yi }), /已有历史进度/);
  const saved = m.serialize();
  const restored = createModel(saved);
  assert.deepEqual(restored.getState().progress, historical);
  assert.equal(restored.getState().summary.planBalances.find(b => b.planId === added.planId).arrangeableYuan, yi);
  assert.equal(validateSaved(restored.serialize()).ok, true);
  assert.throws(() => restored.send(), /审核/);
  m.load(old);
  assert.deepEqual(m.getState().progress, historical);
  assert.equal(m.getState().plans.some(p => p.planId === added.planId), false);
});

test('B-bank deposit remains executable when only A-bank demonstration exposure is high', () => {
  const m = createModel();
  for (const p of [...m.getState().plans]) m.deletePlan(p.planId);
  m.setInputs({ bankExposureYuan: 45 * yi });
  const b = m.addPlan({ label: 'B银行存款', businessType: 'deposit', direction: 'outflow',
    issuerId: 'BANK-B', targetYuan: yi }).plans.at(-1);
  const risk = evaluateCurrentConcentration(m.getState(), b, yi);
  assert.equal(risk.depositResult, 'not_applicable');
  assert.equal(risk.warningResult, 'not_applicable');
  m.generateProposal(); m.approveProposal();
  const step = m.getState().proposal.steps.find(s => s.planId === b.planId);
  assert.equal(m.getState().stepReadiness.find(s => s.stepId === step.stepId).ready, true);
  const sent = m.send(step.stepId).sentInstructionId;
  assert.equal(m.getState().execution.instructions[sent].planId, b.planId);
});

test('unknown CD issuer or deposit bank cannot acquire dispatch authority', () => {
  for (const spec of [
    { label: '存单缺发行人且对手为A', businessType: 'cd_buy', counterpartyId: 'BANK-A', issuerId: null },
    { label: '存单缺发行人且无对手', businessType: 'cd_buy', counterpartyId: null, issuerId: null },
    { label: '存款银行未知', businessType: 'deposit', counterpartyId: null, issuerId: null },
  ]) {
    const m = createModel();
    for (const p of [...m.getState().plans]) m.deletePlan(p.planId);
    const plan = m.addPlan({ ...spec, direction: 'outflow', targetYuan: yi }).plans.at(-1);
    const risk = evaluateCurrentConcentration(m.getState(), plan, yi);
    assert.ok(risk.needed.some(key => ['issuerId','bankId'].includes(key)), spec.label);
    assert.equal(risk.warningResult, 'missing', spec.label);
    m.generateProposal();
    assert.equal(m.getState().proposal.status, 'insufficient_data', spec.label);
    assert.throws(() => m.approveProposal(), /没有可审核/, spec.label);
    assert.throws(() => m.send(), /审核/, spec.label);
    assert.equal(Object.keys(m.getState().execution.instructions).length, 0, spec.label);
    assert.equal(validateSaved(m.serialize()).ok, true, spec.label);
  }
});

test('custom A-bank CD in flight counts toward a later A-bank deposit gate', () => {
  const m = createModel();
  for (const p of [...m.getState().plans]) m.deletePlan(p.planId);
  const cd = m.addPlan({ label: '自定义A存单', businessType: 'cd_buy', direction: 'outflow',
    issuerId: 'BANK-A', targetYuan: yi }).plans.at(-1);
  m.generateProposal(); m.approveProposal();
  const step = m.getState().proposal.steps.find(s => s.planId === cd.planId);
  m.send(step.stepId);
  const dep = m.addPlan({ label: '自定义A存款', businessType: 'deposit', direction: 'outflow',
    issuerId: 'BANK-A', targetYuan: yi }).plans.at(-1);
  const risk = evaluateCurrentConcentration(m.getState(), dep, yi);
  assert.equal(risk.committedExposureYuan, yi);
  assert.equal(risk.depositResult, 'block');
  assert.equal(m.getState().summary.planBalances.find(b => b.planId === cd.planId).lockedYuan, yi);
  assert.equal(m.getState().approvalStatus, 'stale');
});

test('template run isolates source and accounts confirmed primary CD and dated maturity once', () => {
  const template = createSyntheticInitialTemplate();
  const model = createModel();
  const oldRun = model.getState().context.runId;
  const state = model.startFromTemplate(template);
  assert.notEqual(state.context.runId, oldRun);
  assert.equal(template.portfolio.accountCashYuan, 3*yi);
  assert.equal(state.summary.accountCashYuan, 3*yi);
  assert.equal(state.summary.unreceivedMaturityYuan, 2*yi);
  assert.equal(state.summary.openingBusinessAvailableYuan,5*yi);
  assert.equal(state.summary.availableYuan, 3.5*yi);
  assert.equal(state.summary.openingTradeBalances.length, 2);
  assert.equal(state.summary.openingTradeBalances.find(x=>x.sourceId==='PRIMARY-CD-A').tradeDate,'2026-09-04');
  assert.equal(state.summary.openingTradeBalances.find(x=>x.sourceId==='SECONDARY-CD-B').settlementDate,
    state.context.businessDate);
  assert.equal(state.summary.exposureAdjustmentsByBankYuan['BANK-A'],yi);
  assert.ok(!state.plans.some(p=>p.planId==='PRIMARY-CD-A'));
  const paid=model.recordCashEvent({eventId:'CD-PAY-1',sourceId:'PRIMARY-CD-A',amountYuan:yi});
  assert.equal(paid.summary.accountCashYuan,2*yi);
  assert.equal(paid.summary.availableYuan,3.5*yi);
  const received=model.recordCashEvent({eventId:'MAT-RECEIPT-1',sourceId:'MAT-T0-DEP-A',amountYuan:2*yi});
  assert.equal(received.summary.accountCashYuan,4*yi);
  assert.equal(received.summary.availableYuan,3.5*yi);
  assert.equal(model.recordCashEvent({eventId:'MAT-RECEIPT-1',sourceId:'MAT-T0-DEP-A',amountYuan:2*yi}).eventResult,
    'duplicate');
  assert.throws(()=>model.recordCashEvent({eventId:'CD-PAY-2',sourceId:'PRIMARY-CD-A',amountYuan:yi}),/超过来源金额/);
  const restored=createModel(model.serialize());
  assert.equal(restored.getState().summary.availableYuan,3.5*yi);
  assert.equal(restored.getState().summary.accountCashYuan,4*yi);
  assert.equal(restored.getState().approvalStatus,'none');
  assert.equal(validateSaved(restored.serialize()).ok,true);
  const forged=JSON.parse(model.serialize()); forged.execution.cashEventReceipts['CD-PAY-1'].amountYuan=2*yi;
  assert.equal(validateSaved(forged).ok,false);
});

test('UI2 archive migrates unchanged execution facts into dated UI3 run', () => {
  const model=startS10();
  const id=model.send('I-A').sentInstructionId;
  model.simulateEvent('accepted',{instructionId:id});
  const old=JSON.parse(model.serialize());
  old.uiVersion='simulation-ui-2'; old.contractMapping='simulation-execution-2';
  delete old.initialData;
  for (const p of old.plans) for (const key of ['tradeDate','settlementDate','securityId','marketTier']) delete p[key];
  old.execution.version='simulation-execution-2';
  delete old.execution.openingFacts; delete old.execution.cashEventReceipts;
  for (const i of Object.values(old.execution.instructions))
    for (const key of ['tradeDate','settlementDate','securityId','marketTier']) delete i[key];
  for (const entry of old.execution.journal) if (entry.kind==='send')
    for (const key of ['tradeDate','settlementDate','securityId','marketTier']) delete entry.instruction[key];
  assert.equal(validateSaved(old).ok,true);
  const restored=createModel(old).getState();
  assert.equal(restored.execution.instructions[id].instructionId,id);
  assert.equal(restored.execution.instructions[id].tradeDate,restored.context.businessDate);
  assert.equal(restored.summary.platformReservedYuan,3*yi);
  assert.equal(restored.execution.requiresRefresh,true);
  assert.equal(restored.execution.requiresReapproval,true);
});

test('linked security cannot borrow sellable holdings from a different instrument or issuer', () => {
  const template=createSyntheticInitialTemplate();
  const invalid=structuredClone(template);
  invalid.draftPlans.find(p=>p.businessType==='cd_sell').securityId='GOV-01';
  assert.throws(()=>createModel().startFromTemplate(invalid),/品种/);
  const model=createModel(); model.startFromTemplate(template);
  assert.throws(()=>model.addPlan({label:'伪存单卖出',businessType:'cd_sell',direction:'inflow',
    issuerId:'BANK-B',securityId:'GOV-01',targetYuan:yi}),/品种/);
  const sale=model.getState().plans.find(p=>p.businessType==='cd_sell');
  assert.throws(()=>model.updatePlan(sale.planId,{securityId:'CD-A'}),/发行人/);
  const forged=JSON.parse(model.serialize());
  forged.plans.find(p=>p.planId===sale.planId).securityId='GOV-01';
  assert.equal(validateSaved(forged).ok,false);
});

test('new plan cannot masquerade as a historical trade date', () => {
  const model=createModel();
  const today=model.getState().context.businessDate;
  assert.throws(()=>model.addPlan({label:'伪历史成交',businessType:'bond_buy',direction:'outflow',
    targetYuan:yi,tradeDate:'2026-09-04',settlementDate:today}),/计划类型|方向|对象/);
  const id=model.getState().plans[0].planId;
  assert.throws(()=>model.updatePlan(id,{tradeDate:'2026-09-04'}),/计划类型|方向|对象/);
  const forged=JSON.parse(model.serialize()); forged.plans[0].tradeDate='2026-09-04';
  assert.equal(validateSaved(forged).ok,false);
});
