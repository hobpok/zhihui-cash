import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOriginalInitialTemplate } from './original-scenario.js';
import { createModel } from './model.js';
import { evaluateCoreRules } from './core-rules.js';
import { runLifecycle } from '../scripts/robustness-lifecycle.mjs';

const q = yi => Math.round(yi * 100000000);
const rule = (rows, id, subject = 'PORTFOLIO') => {
  const result = rows.find(row => row.ruleId === id && row.subjectId === subject);
  assert.ok(result, `${id}/${subject}`);
  return result;
};

test('public original preset preserves historical business fields', () => {
  // Original-source business-field digest, excluding redacted provenance note.
  const template = createOriginalInitialTemplate({ businessDate: '2026-10-14' });
  assert.equal(template.label, '原始样例：零现金／成农商6%');
  template.label = '收益导向零现金单日模拟样例';
  delete template.provenance.note;
  assert.equal(createHash('sha256').update(JSON.stringify(template)).digest('hex'),
    '14805b7c7543109b1ac6f00e3ca38e7e35b9caac9d7164d27770b3eb5519780b');
  assert.equal(template.templateId, 'SIM-DEFAULT-COMPLEX-01');
  assert.equal(template.revision, 1);
  assert.equal(template.provenance.kind, 'synthetic');
  assert.equal(template.portfolio.accountCashYuan, 0);
  assert.equal(template.portfolio.navYuan, q(500));
  assert.equal(template.holdings.reduce((n, row) => n + row.amountYuan, 0), q(500));
  assert.equal(template.holdings.find(row => row.securityId === 'SIM-GOV-30').amountYuan, q(25.1));
  assert.deepEqual(template.draftPlans.map(plan => plan.targetYuan),
    [13, 6, 7.5, 1, 1, 1, 1, 17.6, 13.1].map(q));
  assert.deepEqual(template.draftPlans.map(plan => plan.businessType),
    ['cd_sell', 'deposit', 'cd_buy', 'cd_buy', 'cd_buy', 'bond_buy', 'bond_buy',
      'interbank_repo_financing', 'reverse_repo']);
  assert.deepEqual(template.draftPlans.map(plan => plan.securityId ?
    template.securities.find(security => security.securityId === plan.securityId).remainingTradingDays :
    plan.repoTerms.tenorDays), [30, 100, 120, 150, 60, 60, 90, 1, 7]);
  assert.deepEqual(template.maturityCashEvents, []);
  assert.deepEqual(template.pendingSettlements, []);
});

test('requested business date updates operational dates but preserves quarterly facts and relative tenors', () => {
  const before = createOriginalInitialTemplate({ businessDate: '2026-10-14' });
  const after = createOriginalInitialTemplate({ businessDate: '2026-12-01' });
  assert.equal(after.businessDate, '2026-12-01');
  assert.equal(after.termWeights.asOfDate, '2026-12-01');
  assert.ok(after.banks.every(bank => bank.ratingAsOf === '2026-12-01'));
  assert.ok(after.banks.every(bank => bank.quarterEnd === '2026-06-30'));
  assert.ok(after.draftPlans.every(plan => plan.tradeDate === '2026-12-01' && plan.settlementDate === '2026-12-01'));
  before.businessDate = after.businessDate;
  before.termWeights.asOfDate = after.businessDate;
  for (const bank of before.banks) bank.ratingAsOf = after.businessDate;
  for (const plan of before.draftPlans) plan.tradeDate = plan.settlementDate = after.businessDate;
  assert.deepEqual(after, before);
  assert.throws(() => createOriginalInitialTemplate({ businessDate: '2026-02-30' }), /日期|公历日/);
});

test('each original preset is an independent deep copy', () => {
  const first = createOriginalInitialTemplate({ businessDate: '2026-10-20' });
  const expected = createOriginalInitialTemplate({ businessDate: '2026-10-20' });
  first.banks[0].label = 'edited';
  first.holdings[0].amountYuan = 1;
  first.securities[0].remainingTradingDays = 1;
  first.termWeights.assets[0].amountYuan = 1;
  first.draftPlans.at(-1).repoTerms.tenorDays = 1;
  first.otherFundBankExposure[0].bondYuan = 1;
  assert.deepEqual(createOriginalInitialTemplate({ businessDate: '2026-10-20' }), expected);
});

test('original preset uses the same UTC+8 current-business-date default as the new preset', context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T15:59:59Z') });
  assert.equal(createOriginalInitialTemplate().businessDate, '2026-10-19');
  context.mock.timers.tick(1000);
  const next = createOriginalInitialTemplate();
  assert.equal(next.businessDate, '2026-10-20');
  assert.equal(next.termWeights.asOfDate, '2026-10-20');
  assert.ok(next.banks.every(bank => bank.ratingAsOf === '2026-10-20'));
  assert.ok(next.draftPlans.every(plan => plan.tradeDate === '2026-10-20' && plan.settlementDate === '2026-10-20'));
});

test('original Chengdu company six-percent ordering remains valid under current rules', () => {
  const model = createModel();
  model.startFromTemplate(createOriginalInitialTemplate({ businessDate: '2026-10-20' }));
  const state = model.getState();
  const deposit = state.plans.find(plan => plan.businessType === 'deposit');
  const cd = state.plans.find(plan => plan.businessType === 'cd_buy' && plan.issuerId === deposit.issuerId);
  assert.equal(deposit.issuerId, 'SIM-BANK-CDRCB');
  assert.equal(deposit.targetYuan, q(6));
  const gate = (plan, amountYuan, projectedActions = []) => rule(evaluateCoreRules(state,
    { plan, amountYuan, projectedActions }).rows, 'C05-DEPOSIT', 'SIM-BANK-CDRCB');
  const initial = rule(state.coreRules.rows, 'C05-DEPOSIT', 'SIM-BANK-CDRCB');
  assert.equal(initial.currentValue, 60 / 1100);
  assert.equal(initial.denominatorYuan, q(1100));
  assert.equal(gate(deposit, q(6)).projectedValue, .06);
  assert.equal(gate(deposit, q(6)).result, 'pass');
  assert.equal(gate(deposit, q(6) + 1).result, 'block');
  assert.equal(gate(deposit, q(6), [{ plan: cd, amountYuan: q(1) }]).result, 'block');
  assert.equal(gate(cd, q(1), [{ plan: deposit, amountYuan: q(6) }]).result, 'pass');
});

test('all nine original plans still complete through current model APIs and end with zero cash', () => {
  const result = runLifecycle(createOriginalInitialTemplate({ businessDate: '2026-10-20' }));
  assert.deepEqual(result.blocked, []);
  assert.equal(result.final.completed, true);
  assert.deepEqual(result.validationSaved, { ok: true, errors: [] });
  assert.equal(result.final.instructions.length, 9);
  assert.ok(result.final.plans.every(plan => plan.remainingYuan === 0));
  assert.ok(result.final.instructions.every(instruction => instruction.filledYuan === instruction.nominalYuan &&
    instruction.settledYuan === instruction.nominalYuan));
  assert.deepEqual(result.final.cash, { accountCashYuan: 0, businessAvailableYuan: 0,
    payableReservedYuan: 0, projectedEndOfDayYuan: 0 });
  assert.equal(rule(result.final.coreRules, 'C02').currentValue, .0502);
  assert.equal(rule(result.initial.coreRules, 'C09').numeratorYuan, q(44719.6));
  assert.equal(rule(result.final.coreRules, 'C09').numeratorYuan, q(46281.3));
  assert.equal(rule(result.final.coreRules, 'C09').denominatorYuan, q(517.6));
  assert.equal(rule(result.final.coreRules, 'C09').currentValue, q(46281.3) / q(517.6));
  assert.ok(result.final.coreRules.every(row => ['pass', 'not_applicable'].includes(row.result)));
  assert.equal(rule(result.final.coreRules, 'C05', 'SIM-BANK-CDRCB').currentValue, 67 / 1100);
  assert.equal(q(13 + 17.6 - 6 - 7.5 - 1 - 1 - 1 - 1 - 13.1), 0);
});
