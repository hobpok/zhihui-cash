import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticInitialTemplate } from './initial-data.js';
import { createModel, validateSaved } from './model.js';

test('3 account plus 2 due supports 4 instruction, but payment waits for actual receipt', () => {
  const template = createSyntheticInitialTemplate();
  template.pendingSettlements = [];
  template.draftPlans = [{ ...template.draftPlans.find(p => p.businessType === 'bond_buy'),
    targetYuan: 400000000 }];
  const model = createModel();
  model.startFromTemplate(template);
  model.generateProposal();
  model.approveProposal();
  const snapshot = () => {
    const s = model.getState();
    return { account: s.summary.accountCashYuan, business: s.summary.availableYuan,
      end: s.summary.projectedEndOfDayYuan.balanceYuan,
      term: s.coreRules.rows.find(r => r.ruleId === 'C09').currentValue,
      missing: s.coreRules.missing.length };
  };
  const rows = [snapshot()];
  const id = model.send(model.getState().proposal.steps[0].stepId).sentInstructionId;
  model.simulateEvent('accepted', { instructionId: id });
  model.simulateEvent('fill', { instructionId: id, nominalYuan: 400000000 });
  rows.push(snapshot());
  const beforeFailedPayment = model.serialize();
  assert.throws(() => model.simulateEvent('cash_settled', {
    instructionId: id, amountYuan: 400000000, cashFlowId: 'PAY-BEFORE',
  }), /不足/);
  assert.equal(model.serialize(), beforeFailedPayment);
  model.recordCashEvent({ eventId: 'RECEIVE-DUE', sourceId: 'MAT-T0-DEP-A', amountYuan: 200000000 });
  rows.push(snapshot());
  model.simulateEvent('cash_settled', {
    instructionId: id, amountYuan: 400000000, cashFlowId: 'PAY-AFTER',
  });
  rows.push(snapshot());
  assert.deepEqual(rows.map(x => x.business), [500000000, 100000000, 100000000, 100000000]);
  assert.deepEqual(rows.map(x => x.account), [300000000, 300000000, 500000000, 100000000]);
  assert.ok(rows.every(x => x.end === 100000000 && x.missing === 0));
  assert.equal(rows[1].term, rows[2].term);
  assert.equal(validateSaved(model.serialize()).ok, true);
});
