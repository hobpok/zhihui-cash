import test from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_TYPES,BUSINESS_DIRECTIONS,isFinancing,isExchangeRepo,isSecuritySale,unitFor,
  windowStatus,cancellationStatus,EXCHANGE_REPO_MAX_ORDER_YUAN,EXCHANGE_REPO_TENORS } from './business.js';

const clock = time => ({time,isTradingDay:true,timezone:'Asia/Shanghai'});
test('shared business metadata separates lending, sale and user-entered financing', () => {
  assert.equal(BUSINESS_DIRECTIONS.reverse_repo,'outflow');
  assert.equal(BUSINESS_DIRECTIONS.cd_sell,'inflow');
  assert.equal(BUSINESS_DIRECTIONS.bond_sell,'inflow');
  assert.equal(BUSINESS_TYPES.bond_sell.label,'其他现券卖出');
  assert.equal(BUSINESS_TYPES.bond_sell.cashEffect,'conditional_inflow');
  assert.equal(BUSINESS_TYPES.bond_sell.needsHolding,true);
  assert.equal(unitFor('bond_sell'),1000000);
  assert.equal(isSecuritySale('cd_sell'),true);
  assert.equal(isSecuritySale('bond_sell'),true);
  assert.equal(isSecuritySale('bond_buy'),false);
  for (const type of ['interbank_repo_financing','exchange_repo_financing']) {
    assert.equal(BUSINESS_DIRECTIONS[type],'inflow');
    assert.equal(BUSINESS_TYPES[type].creditKind,'cash_available');
    assert.equal(BUSINESS_TYPES[type].needsPledge,true);
    assert.equal(BUSINESS_TYPES[type].needsQuota,true);
    assert.equal(isFinancing(type),true);
  }
  assert.equal(isFinancing('reverse_repo'),false);
  assert.equal(isExchangeRepo('exchange_repo_financing'),true);
  assert.equal(BUSINESS_TYPES.exchange_repo_lending.label,'交易所融券（逆回购）');
  assert.equal(BUSINESS_DIRECTIONS.exchange_repo_lending,'outflow');
  assert.equal(isFinancing('exchange_repo_lending'),false);
  assert.equal(isExchangeRepo('exchange_repo_lending'),true);
  assert.equal(BUSINESS_TYPES.exchange_repo_lending.needsPledge,false);
  assert.equal(BUSINESS_TYPES.exchange_repo_lending.needsQuota,false);
  assert.equal(unitFor('exchange_repo_financing'),1000);
  assert.equal(unitFor('exchange_repo_lending'),1000);
  assert.equal(unitFor('interbank_repo_financing'),1000000);
  assert.equal(EXCHANGE_REPO_MAX_ORDER_YUAN,10000000000);
  assert.deepEqual(EXCHANGE_REPO_TENORS,[1,2,3,4,7,14,28,91,182]);
  assert.equal(Object.hasOwn(BUSINESS_TYPES,'securities_lending'),false);
  assert.deepEqual(Object.keys(BUSINESS_TYPES),
    ['reverse_repo','interbank_repo_financing','exchange_repo_financing','exchange_repo_lending',
      'deposit','cd_buy','cd_sell','bond_buy','bond_sell']);
  assert.equal(BUSINESS_TYPES.reverse_repo.label,'逆回购');
  assert.equal(BUSINESS_TYPES.bond_buy.label,'其他现券买入');
});

test('exchange send and actual trade windows are distinct at the opening auction', () => {
  assert.equal(windowStatus(clock('09:15:00'),{mode:'send'}).result,'open');
  assert.equal(windowStatus(clock('09:24:59'),{mode:'send'}).result,'open');
  assert.equal(windowStatus(clock('09:24:59'),{mode:'fill',at:'09:24:59'}).result,'closed');
  assert.equal(windowStatus(clock('09:25:00'),{mode:'send'}).result,'closed');
  assert.equal(windowStatus(clock('09:25:00'),{mode:'fill',at:'09:25:00'}).result,'open');
  assert.equal(windowStatus(clock('09:29:59'),{mode:'send'}).result,'closed');
  assert.equal(windowStatus(clock('09:30:00'),{mode:'fill',at:'09:30:00'}).result,'open');
});

test('15:30 closes new sends while older authoritative trade time remains checkable', () => {
  assert.equal(windowStatus(clock('11:30:00'),{mode:'send'}).result,'open');
  assert.equal(windowStatus(clock('12:00:00'),{mode:'send'}).result,'closed');
  assert.equal(windowStatus(clock('13:00:00'),{mode:'send'}).result,'open');
  assert.equal(windowStatus(clock('15:29:59'),{mode:'send'}).result,'open');
  assert.equal(windowStatus(clock('15:30:00'),{mode:'send'}).result,'closed');
  assert.equal(windowStatus(clock('15:30:00'),{mode:'fill',at:'15:30:00'}).result,'open');
  assert.equal(windowStatus(clock('15:30:01'),{mode:'send'}).result,'closed');
  assert.equal(windowStatus(clock('15:31:00'),{mode:'fill',at:'15:29:59'}).result,'open');
  assert.equal(windowStatus(clock('15:31:00'),{mode:'fill'}).result,'missing');
});

test('unknown calendar or timezone stays missing; no early auction cancellation', () => {
  assert.equal(windowStatus(null,{mode:'send'}).result,'missing');
  assert.equal(windowStatus({time:'09:30:00',isTradingDay:null,timezone:'Asia/Shanghai'},{mode:'send'}).result,'missing');
  assert.equal(windowStatus({time:'09:30:00',isTradingDay:true,timezone:null},{mode:'send'}).result,'missing');
  assert.equal(windowStatus({time:'09:30:00',isTradingDay:false,timezone:'Asia/Shanghai'},{mode:'send'}).result,'closed');
  assert.equal(cancellationStatus(clock('09:19:59')).result,'open');
  assert.equal(cancellationStatus(clock('09:20:00')).result,'closed');
  assert.equal(cancellationStatus(clock('09:25:00')).result,'closed');
  assert.equal(cancellationStatus(clock('09:30:00')).result,'open');
});
