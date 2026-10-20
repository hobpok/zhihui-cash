import test from 'node:test';
import assert from 'node:assert/strict';
import { newExecution, registerSend, registerCancel, registerCashEvent, applyEvent, executionSummary, validateExecution } from './execution.js';

const yi = 100000000;
const plan = { planId: 'P', direction: 'outflow', targetYuan: 3 * yi };
const started = (cash = 3 * yi) => registerSend(newExecution(cash), { stepId: 'A', nominalYuan: 3 * yi }, plan, 'AP');
const event = (sourceSequence, type, instructionId, fields = {}) => ({ eventId: `E${sourceSequence}`, sourceSequence, type, instructionId, ...fields });

test('unknown input stays unknown even after zero settled and synthetic inflow', () => {
  const s = started(null);
  let e = applyEvent(s.execution, event(1, 'accepted', s.instructionId)).execution;
  e = applyEvent(e, event(2, 'fill', s.instructionId, { nominalYuan: yi, fillId: 'F1' })).execution;
  assert.throws(() => applyEvent(e, event(3, 'cash_settled', s.instructionId,
    { amountYuan: yi, cashFlowId: 'P1' })), /实际账户现金不足/);
  e = applyEvent(e, event(3, 'cash_available', null, { amountYuan: yi, cashFlowId: 'F1', syntheticFunding: true })).execution;
  assert.equal(executionSummary(e, [plan]).settledBalanceYuan, null);
  assert.equal(executionSummary(e, [plan]).availableYuan, null);
});

test('out-of-order event is buffered, duplicate receipt ignored, and conflicting ID rejected', () => {
  const s = started();
  const accepted = event(1, 'accepted', s.instructionId);
  let result = applyEvent(s.execution, event(2, 'fill', s.instructionId, { nominalYuan: yi, fillId: 'F1' }));
  assert.equal(result.result, 'gap');
  assert.equal(result.execution.sourceSequence, 0);
  assert.equal(result.execution.instructions[s.instructionId].filledYuan, 0);
  result = applyEvent(result.execution, accepted);
  assert.equal(result.execution.sourceSequence, 2);
  assert.equal(result.execution.instructions[s.instructionId].filledYuan, yi);
  assert.equal(applyEvent(result.execution, { ...accepted, receivedAt: 'later' }).result, 'duplicate');
  assert.throws(() => applyEvent(result.execution, { ...accepted, type: 'rejected' }), /内容冲突/);
  assert.equal(validateExecution(result.execution, [plan]), true);
});

test('cancel requires matching nominal and reservation-release evidence; partial fill remains fact', () => {
  const s = started();
  let e = applyEvent(s.execution, event(1, 'accepted', s.instructionId)).execution;
  e = applyEvent(e, event(2, 'fill', s.instructionId, { nominalYuan: yi, fillId: 'F1' })).execution;
  const c = registerCancel(e, s.instructionId); e = c.execution;
  const basis = { cancelRequestId: c.cancelRequestId, cancelSliceId: 'S1', nominalYuan: yi,
    reservationId: s.instructionId, releaseYuan: yi };
  e = applyEvent(e, event(3, 'cancel_confirmed', s.instructionId, { ...basis, nominalConfirmed: true })).execution;
  assert.deepEqual([executionSummary(e, [plan]).planBalances[0].filledYuan, executionSummary(e, [plan]).planBalances[0].lockedYuan], [yi, 2 * yi]);
  assert.throws(() => applyEvent(e, event(4, 'cancel_confirmed', s.instructionId,
    { ...basis, releaseYuan: 2 * yi, releaseConfirmed: true })), /同额/);
  e = applyEvent(e, event(4, 'cancel_confirmed', s.instructionId, { ...basis, releaseConfirmed: true })).execution;
  const b = executionSummary(e, [plan]).planBalances[0];
  assert.deepEqual([b.filledYuan, b.lockedYuan, b.arrangeableYuan], [yi, yi, yi]);
  assert.equal(validateExecution(e, [plan]), true);
});

test('replay validation catches removed instruction, forged cash and erased journal', () => {
  const s = started();
  let e = applyEvent(s.execution, event(1, 'accepted', s.instructionId)).execution;
  assert.equal(validateExecution(e, [plan]), true);
  const removed = structuredClone(e); delete removed.instructions[s.instructionId];
  assert.throws(() => validateExecution(removed, [plan]), /流水|引用/);
  const forged = structuredClone(e); forged.cashFlows.FAKE = { type: 'cash_available', instructionId: null, amountYuan: yi };
  assert.throws(() => validateExecution(forged, [plan]), /流水/);
  const erased = structuredClone(e); erased.journal.pop();
  assert.throws(() => validateExecution(erased, [plan]), /流水/);
});

test('sale fill and settlement do not increase cash until available event', () => {
  const salePlan = { planId: 'SELL', direction: 'inflow', targetYuan: 2 * yi };
  const s = registerSend(newExecution(3 * yi), { stepId: 'S', nominalYuan: 2 * yi }, salePlan, 'AP');
  let e = applyEvent(s.execution, event(1, 'accepted', s.instructionId)).execution;
  e = applyEvent(e, event(2, 'fill', s.instructionId, { nominalYuan: 2 * yi, fillId: 'F1' })).execution;
  assert.equal(executionSummary(e, [salePlan]).availableYuan, 3 * yi);
  assert.throws(() => applyEvent(e, event(3, 'cash_available', s.instructionId,
    { amountYuan: 2 * yi, cashFlowId: 'SALE' })), /尚未结算/);
  e = applyEvent(e, event(3, 'cash_settled', s.instructionId, { amountYuan: 2 * yi, cashFlowId: 'SET' })).execution;
  assert.equal(executionSummary(e, [salePlan]).availableYuan, 3 * yi);
  e = applyEvent(e, event(4, 'cash_available', s.instructionId, { amountYuan: 2 * yi, cashFlowId: 'SALE' })).execution;
  assert.equal(executionSummary(e, [salePlan]).availableYuan, 5 * yi);
});

test('single-day partial sale fill raises business cash once while account payment waits for receipt', () => {
  const sale = { planId:'SALE', businessType:'cd_sell', direction:'inflow', targetYuan:2*yi };
  const buy = { planId:'BUY', businessType:'bond_buy', direction:'outflow', targetYuan:4*yi };
  const sent = registerSend(newExecution(3*yi, [], 'single-day-principal-v1'),
    {stepId:'SALE-1',nominalYuan:2*yi},sale,'AP');
  let e = applyEvent(sent.execution,event(1,'accepted',sent.instructionId)).execution;
  e = applyEvent(e,event(2,'fill',sent.instructionId,{nominalYuan:yi,fillId:'SALE-F1'})).execution;
  let s = executionSummary(e,[sale,buy]);
  assert.deepEqual([s.accountCashYuan,s.availableYuan,s.saleUncreditedYuan],[3*yi,4*yi,yi]);
  const buySent = registerSend(e,{stepId:'BUY-1',nominalYuan:4*yi},buy,'AP');
  let withBuy = applyEvent(buySent.execution,event(3,'accepted',buySent.instructionId)).execution;
  withBuy = applyEvent(withBuy,event(4,'fill',buySent.instructionId,{nominalYuan:4*yi,fillId:'BUY-F1'})).execution;
  assert.throws(() => applyEvent(withBuy,event(5,'cash_settled',buySent.instructionId,
    {amountYuan:4*yi,cashFlowId:'BUY-PAY'})),/实际账户现金不足/);
  e = applyEvent(e,event(3,'cash_settled',sent.instructionId,{amountYuan:yi,cashFlowId:'SALE-SET-1'})).execution;
  assert.deepEqual([executionSummary(e,[sale,buy]).accountCashYuan,
    executionSummary(e,[sale,buy]).availableYuan],[3*yi,4*yi]);
  e = applyEvent(e,event(4,'cash_available',sent.instructionId,{amountYuan:yi,cashFlowId:'SALE-CASH-1'})).execution;
  s = executionSummary(e,[sale,buy]);
  assert.deepEqual([s.accountCashYuan,s.availableYuan,s.saleUncreditedYuan],[4*yi,4*yi,0]);
  e = applyEvent(e,event(5,'fill',sent.instructionId,{nominalYuan:yi,fillId:'SALE-F2'})).execution;
  s = executionSummary(e,[sale,buy]);
  assert.deepEqual([s.accountCashYuan,s.availableYuan,s.saleUncreditedYuan],[4*yi,5*yi,yi]);
  e = applyEvent(e,event(6,'cash_settled',sent.instructionId,{amountYuan:yi,cashFlowId:'SALE-SET-2'})).execution;
  e = applyEvent(e,event(7,'cash_available',sent.instructionId,{amountYuan:yi,cashFlowId:'SALE-CASH-2'})).execution;
  s = executionSummary(e,[sale,buy]);
  assert.deepEqual([s.accountCashYuan,s.availableYuan,s.saleUncreditedYuan],[5*yi,5*yi,0]);
  assert.equal(validateExecution(e,[sale,buy]),true);
});

test('same fillId under a new eventId never migrates a second nominal or cash obligation', () => {
  const s = started();
  let e = applyEvent(s.execution, event(1, 'accepted', s.instructionId)).execution;
  e = applyEvent(e, event(2, 'fill', s.instructionId, { nominalYuan: yi, fillId: 'TRADE-1' })).execution;
  const before = executionSummary(e, [plan]);
  assert.throws(() => applyEvent(e, event(3, 'fill', s.instructionId, { nominalYuan: yi, fillId: 'TRADE-1' })), /成交ID缺失或重复/);
  assert.deepEqual(executionSummary(e, [plan]), before);
  assert.equal(e.sourceSequence, 2);
  assert.equal(validateExecution(e, [plan]), true);
});

test('exchange financing and lending fill/cancel nominal lots stay at 1000 yuan while cash settlement remains yuan based', () => {
  for (const [businessType,direction] of [['exchange_repo_financing','inflow'],['exchange_repo_lending','outflow']]) {
    const repoTerms = { market:'SSE', tenorDays:7, annualRate:null };
    const p = { planId:businessType, businessType, direction, targetYuan:2000, repoTerms };
    const sent = registerSend(newExecution(5000), {stepId:'R', nominalYuan:2000}, p, 'AP',
      {time:'09:30:00',isTradingDay:true});
    let e = applyEvent(sent.execution,event(1,'accepted',sent.instructionId)).execution;
    const badFill = event(2,'fill',sent.instructionId,{nominalYuan:1,fillId:'F1',tradeTime:'09:30:01'});
    assert.throws(() => applyEvent(e,badFill), /交易单位/);
    e = applyEvent(e,event(2,'fill',sent.instructionId,{nominalYuan:1000,fillId:'F2',tradeTime:'09:30:01'})).execution;
    const c = registerCancel(e,sent.instructionId); e = c.execution;
    assert.throws(() => applyEvent(e,event(3,'cancel_confirmed',sent.instructionId,{
      cancelRequestId:c.cancelRequestId,cancelSliceId:'tiny',nominalYuan:1,
      reservationId:sent.instructionId,releaseYuan:1,nominalConfirmed:true})), /交易单位/);
    e = applyEvent(e,event(3,'cash_settled',sent.instructionId,{cashFlowId:'C1',amountYuan:1})).execution;
    assert.equal(e.instructions[sent.instructionId].settledYuan,1);
    assert.equal(validateExecution(e,[p]),true);
  }
});

test('bond sale proceeds stay unavailable until settlement and account availability; cancellation preserves filled fact', () => {
  const bond = { planId:'BOND-SALE', businessType:'bond_sell', direction:'inflow', targetYuan:2 * yi, repoTerms:null };
  const sent = registerSend(newExecution(3 * yi), {stepId:'BOND-1', nominalYuan:2 * yi}, bond, 'AP');
  let e = applyEvent(sent.execution,event(1,'accepted',sent.instructionId)).execution;
  e = applyEvent(e,event(2,'fill',sent.instructionId,{nominalYuan:yi,fillId:'B-FILL-1'})).execution;
  assert.equal(executionSummary(e,[bond]).availableYuan,3 * yi);
  assert.throws(() => applyEvent(e,event(3,'cash_available',sent.instructionId,{amountYuan:yi,cashFlowId:'B-AVAIL'})),/尚未结算/);
  e = applyEvent(e,event(3,'cash_settled',sent.instructionId,{amountYuan:yi,cashFlowId:'B-SETTLED'})).execution;
  assert.equal(executionSummary(e,[bond]).availableYuan,3 * yi);
  e = applyEvent(e,event(4,'cash_available',sent.instructionId,{amountYuan:yi,cashFlowId:'B-AVAIL'})).execution;
  assert.equal(executionSummary(e,[bond]).availableYuan,4 * yi);
  const c = registerCancel(e,sent.instructionId); e = c.execution;
  const slice = {cancelRequestId:c.cancelRequestId,cancelSliceId:'B-UNFILLED',nominalYuan:yi,
    reservationId:sent.instructionId,releaseYuan:yi};
  e = applyEvent(e,event(5,'cancel_confirmed',sent.instructionId,{...slice,nominalConfirmed:true})).execution;
  assert.equal(executionSummary(e,[bond]).planBalances[0].lockedYuan,yi);
  e = applyEvent(e,event(6,'cancel_confirmed',sent.instructionId,{...slice,releaseConfirmed:true})).execution;
  assert.deepEqual([executionSummary(e,[bond]).planBalances[0].filledYuan,
    executionSummary(e,[bond]).planBalances[0].lockedYuan,executionSummary(e,[bond]).availableYuan],
    [yi,0,4 * yi]);
  assert.equal(validateExecution(e,[bond]),true);
});

test('due maturity migrates into account cash without increasing business headroom twice', () => {
  const date = '2026-09-07';
  const maturity = { eventId:'MAT-1',label:'当日到期',kind:'deposit_maturity',direction:'inflow',
    amountYuan:2*yi,dueDate:date,includedInOpeningCash:false };
  const buy = {planId:'BUY',businessType:'bond_buy',direction:'outflow',targetYuan:4*yi,
    tradeDate:date,settlementDate:date,securityId:null,marketTier:'secondary'};
  let e = newExecution(3*yi,[maturity]);
  assert.deepEqual([executionSummary(e,[buy],{businessDate:date}).accountCashYuan,
    executionSummary(e,[buy],{businessDate:date}).availableYuan],[3*yi,5*yi]);
  const sent = registerSend(e,{stepId:'BUY-1',nominalYuan:4*yi},buy,'AP'); e = sent.execution;
  assert.equal(executionSummary(e,[buy],{businessDate:date}).availableYuan,yi);
  e = applyEvent(e,event(1,'accepted',sent.instructionId)).execution;
  assert.throws(()=>applyEvent(e,event(2,'fill',sent.instructionId,
    {nominalYuan:yi,fillId:'MAT-1'})),/期初来源冲突/);
  e = applyEvent(e,event(2,'fill',sent.instructionId,{nominalYuan:4*yi,fillId:'F-BUY'})).execution;
  assert.equal(executionSummary(e,[buy],{businessDate:date}).availableYuan,yi);
  assert.throws(() => applyEvent(e,event(3,'cash_settled',sent.instructionId,
    {amountYuan:4*yi,cashFlowId:'PAY'})),/实际账户现金不足/);
  e = registerCashEvent(e,{eventId:'R-MAT',sourceId:'MAT-1',amountYuan:2*yi},date).execution;
  assert.deepEqual([executionSummary(e,[buy],{businessDate:date}).accountCashYuan,
    executionSummary(e,[buy],{businessDate:date}).availableYuan],[5*yi,yi]);
  e = applyEvent(e,event(3,'cash_settled',sent.instructionId,{amountYuan:4*yi,cashFlowId:'PAY'})).execution;
  assert.deepEqual([executionSummary(e,[buy],{businessDate:date}).accountCashYuan,
    executionSummary(e,[buy],{businessDate:date}).availableYuan],[yi,yi]);
  assert.equal(validateExecution(e,[buy]),true);
  const forged = structuredClone(e); forged.cashEventReceipts['R-MAT'].amountYuan=yi;
  assert.throws(() => validateExecution(forged,[buy]),/流水/);
});

test('partial maturity receipts deduplicate by source and T+1 obligations stay off today cash', () => {
  const today='2026-09-07', tomorrow='2026-09-08';
  const maturity={eventId:'MAT-2',label:'今日到期',kind:'repo_maturity',direction:'inflow',
    amountYuan:2*yi,dueDate:today,includedInOpeningCash:false};
  const future={eventId:'FUT-1',label:'次日净赎回',kind:'net_subscription',direction:'outflow',
    amountYuan:yi,dueDate:tomorrow,includedInOpeningCash:false};
  const t1={planId:'T1',businessType:'bond_buy',direction:'outflow',targetYuan:yi,
    tradeDate:today,settlementDate:tomorrow,securityId:null,marketTier:'secondary'};
  let e=newExecution(3*yi,[maturity,future]);
  const before=executionSummary(e,[t1],{businessDate:today});
  assert.equal(before.availableYuan,5*yi);
  assert.deepEqual(before.futureCashEvents.map(x=>x.signedDeltaYuan),[-yi]);
  assert.throws(()=>registerCashEvent(e,{eventId:'EARLY',sourceId:'FUT-1',amountYuan:yi},today),/尚未到交收日/);
  e=registerCashEvent(e,{eventId:'R1',sourceId:'MAT-2',amountYuan:yi},today).execution;
  assert.equal(executionSummary(e,[t1],{businessDate:today}).availableYuan,5*yi);
  assert.equal(registerCashEvent(e,{eventId:'R1',sourceId:'MAT-2',amountYuan:yi},today).result,'duplicate');
  assert.throws(()=>registerCashEvent(e,{eventId:'R2',sourceId:'MAT-2',amountYuan:2*yi},today),/超过来源金额/);
  e=registerSend(e,{stepId:'T1-1',nominalYuan:yi},t1,'AP').execution;
  const after=executionSummary(e,[t1],{businessDate:today});
  assert.equal(after.availableYuan,5*yi);
  assert.equal(after.dateBalances.find(x=>x.valueDate===tomorrow).availableYuan,3*yi);
  assert.equal(validateExecution(e,[t1]),true);
});
