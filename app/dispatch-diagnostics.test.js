import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, deriveBatchReadiness, deriveAdvancementGroups } from './model.js';
import { createSyntheticInitialTemplate, createLegacySyntheticInitialTemplate } from './initial-data.js';

const YI = 100_000_000;

function fundingAndPurchase({ legacy = false } = {}) {
  const template = legacy ? createLegacySyntheticInitialTemplate() : createSyntheticInitialTemplate();
  template.pendingSettlements = [];
  if (legacy) {
    template.draftPlans = [
      { ...template.draftPlans.find(p => p.businessType === 'cd_sell'),
        label: '合成前序卖券', targetYuan: 2 * YI },
      { ...template.draftPlans.find(p => p.businessType === 'bond_buy'),
        label: '合成后续买券', settlementDate: template.businessDate, targetYuan: 6 * YI },
    ];
  } else {
    template.portfolio.bufferYuan = 3 * YI;
    template.draftPlans = [
      { ...template.draftPlans.find(p => p.businessType === 'reverse_repo'),
        label: '合成前序融资', businessType: 'interbank_repo_financing', direction: 'inflow',
        targetYuan: 2 * YI, repoTerms: { market: 'INTERBANK', tenorDays: 1, annualRate: null } },
      { ...template.draftPlans.find(p => p.businessType === 'bond_buy'),
        label: '合成后续买券', targetYuan: 4 * YI },
    ];
  }
  const model = createModel();
  model.startFromTemplate(template);
  return model;
}

function expectFundingBlock(row, source, minimumYuan, basis, label, actualYuan = 0) {
  assert.equal(row.ready, false);
  assert.equal(row.ruleId, 'EXEC-FUNDS-AVAILABLE');
  assert.equal(row.name, basis === 'fill' ? '前序成交条件' : '前序到账条件');
  assert.deepEqual(row.blockingCondition, {
    kind: 'funds_available', planId: source.planId, minimumYuan,
    actualYuan, shortfallYuan: minimumYuan - actualYuan, basis,
  });
  assert.match(row.reason, new RegExp(row.name));
  assert.ok(row.reason.includes(label));
  assert.ok(row.reason.includes(`${minimumYuan / YI}亿`));
  assert.ok(row.reason.includes(`当前${actualYuan / YI}亿`));
  assert.ok(row.reason.includes(`尚差${(minimumYuan - actualYuan) / YI}亿`));
}

test('single-day financing prerequisite names the missing fill when cash is otherwise sufficient', () => {
  const model = fundingAndPurchase();
  model.generateProposal();
  model.approveProposal();
  const approved = model.getState();
  const [source, purchase] = approved.plans;
  const purchaseStep = approved.proposal.steps.find(step => step.planId === purchase.planId);
  assert.ok(purchaseStep.machineConditions.some(c => c.kind === 'funds_available' &&
    c.planId === source.planId && c.minimumYuan === 2 * YI && c.basis === 'fill'));
  // Isolate the prerequisite from the cash buffer gate while keeping the
  // calculated step, approval, and real execution ledger intact.
  const fixture = structuredClone(approved);
  fixture.inputs.bufferYuan = 0;
  const row = deriveBatchReadiness(fixture).find(item => item.stepId === purchaseStep.stepId);
  expectFundingBlock(row,
    source, 2 * YI, 'fill', source.label);
  const restricted = deriveAdvancementGroups(fixture).restricted.find(step => step.stepId === row.stepId);
  assert.equal(restricted?.reason, row.reason);
});

test('partial financing fill reports the remaining prerequisite shortfall', () => {
  const model = fundingAndPurchase();
  model.generateProposal();
  model.approveProposal();
  const state = model.getState();
  const [source, purchase] = state.plans;
  const sourceStep = state.proposal.steps.find(step => step.planId === source.planId);
  const purchaseStep = state.proposal.steps.find(step => step.planId === purchase.planId);
  const instructionId = model.send(sourceStep.stepId).sentInstructionId;
  model.simulateEvent('accepted', { instructionId });
  model.simulateEvent('fill', { instructionId, nominalYuan: YI });
  const fixture = structuredClone(model.getState());
  fixture.inputs.bufferYuan = 0;
  expectFundingBlock(deriveBatchReadiness(fixture).find(row => row.stepId === purchaseStep.stepId),
    source, 2 * YI, 'fill', source.label, YI);
});

test('legacy settlement prerequisite identifies an uncredited sale by plan and amount', () => {
  const model = fundingAndPurchase({ legacy: true });
  model.generateProposal();
  model.approveProposal();
  const state = model.getState();
  const [source, purchase] = state.plans;
  const purchaseStep = state.proposal.steps.find(step => step.planId === purchase.planId);
  assert.ok(purchaseStep.machineConditions.some(c => c.kind === 'funds_available' &&
    c.planId === source.planId && c.minimumYuan === YI));
  const fixture = structuredClone(state);
  fixture.execution.initialCashYuan += 2 * YI;
  expectFundingBlock(deriveBatchReadiness(fixture).find(row => row.stepId === purchaseStep.stepId),
    source, YI, 'cash_available', source.label);
});

test('recalculation retains the earlier cash blocker when its buffer is still insufficient', () => {
  const model = fundingAndPurchase();
  model.generateProposal();
  const [source, purchase] = model.getState().plans;
  const result = model.recalculateDispatchBatch([
    { planId: source.planId, nominalYuan: 2 * YI },
    { planId: purchase.planId, nominalYuan: 4 * YI },
  ]);
  const row = result.recalculationRows[1];
  assert.equal(row.ready, false);
  assert.match(row.reason, /可用资金不足/);
  assert.notEqual(row.ruleId, 'EXEC-FUNDS-AVAILABLE');
  const trace = result.calculation.trace.steps.find(step => step.stepId === row.stepId);
  assert.ok(trace.rules.some(rule => rule.result === 'block' && rule.reason === row.reason));
  assert.ok(model.getAdvancementGroups().restricted.find(step => step.stepId === row.stepId)?.reason
    .includes(row.reason));
});
