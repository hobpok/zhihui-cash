import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel} from './model.js';
import {createBankOrderInitialTemplate} from './default-scenario.js';
import {evaluateCoreRules} from './core-rules.js';
import {evaluateSelectedSequence} from './engine.js';
import {baseTemplate,createScenarios,plan,YI} from '../scripts/robustness-scenarios.mjs';

const scenario = id => structuredClone(createScenarios().find(x => x.id === id).template);
const start = template => { const model=createModel(); model.startFromTemplate(template); return model; };
const cover = (state,label) => state.proposal.planCoverage.find(row =>
  state.plans.find(p => p.planId === row.planId)?.label === label);
const step = (state,label) => state.proposal.steps.find(row =>
  state.plans.find(p => p.planId === row.planId)?.label === label);

test('a cash-only reverse repo split cannot hide a smaller C02-compliant slice', () => {
  const t=baseTemplate({id:'PART-REPO-C02',cash:3,gov:3});
  t.draftPlans=[plan('逆回购7亿','reverse_repo',7)];
  const model=start(t),state=model.generateProposal();
  assert.equal(state.proposal.status,'feasible');
  assert.equal(state.proposal.steps.length,1);
  assert.equal(state.proposal.steps[0].nominalYuan,YI);
  assert.equal(state.proposal.unarrangedYuan,6*YI);
  assert.ok(state.calculation.trace.search.partialChecks>0);
  model.approveProposal();
  const id=model.send(state.proposal.steps[0].stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:id});
  model.simulateEvent('fill',{instructionId:id,nominalYuan:YI});
  const remaining=model.generateProposal();
  assert.equal(remaining.proposal.planCoverage[0].suggestedYuan,0);
  assert.equal(remaining.summary.planBalances[0].remainingYuan,6*YI);
});

test('default six-plan partial financing leaves a dispatchable ten-yi reverse repo and retains the rest', () => {
  const model=start(createBankOrderInitialTemplate({businessDate:'2026-10-24'}));
  model.generateProposal();model.approveProposal();
  for (const sent of model.sendBatch().results) {
    const instruction=model.getState().execution.instructions[sent.instructionId];
    model.simulateEvent('fill',{instructionId:sent.instructionId,
      nominalYuan:(instruction.businessType==='interbank_repo_financing'?39:2)*YI});
  }
  const prepared=model.generateProposal();model.approveProposal();
  for (const kind of ['deposit','cd_buy']) for (const p of prepared.plans.filter(p=>p.businessType===kind)) {
    const id=model.send(prepared.proposal.steps.find(s=>s.planId===p.planId).stepId).sentInstructionId;
    model.simulateEvent('accepted',{instructionId:id});
    model.simulateEvent('fill',{instructionId:id,nominalYuan:p.targetYuan});
  }
  const before=model.getState(),facts=structuredClone(before.execution);
  assert.equal(before.summary.availableYuan,15*YI);
  assert.equal(before.summary.accountCashYuan,5*YI);
  const state=model.generateProposal(),repo=state.plans.find(p=>p.businessType==='reverse_repo');
  const financing=state.plans.find(p=>p.businessType==='interbank_repo_financing');
  assert.deepEqual(state.execution,facts);
  assert.equal(state.summary.planBalances.find(p=>p.planId===financing.planId).lockedYuan,10*YI);
  assert.equal(state.proposal.status,'feasible');
  assert.deepEqual(state.proposal.steps.map(s=>[s.planId,s.nominalYuan]),[[repo.planId,10*YI]]);
  assert.equal(cover(state,repo.label).unarrangedYuan,10*YI);
  assert.equal(evaluateSelectedSequence(state,[{planId:repo.planId,nominalYuan:10*YI+1000000}]).status,'blocked_sequence');
  model.approveProposal();
  const id=model.send(state.proposal.steps[0].stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:id});
  // Recalculation must not allocate the dispatched amount a second time.
  assert.ok(model.generateProposal().proposal.steps.every(s=>s.blocked));
  model.simulateEvent('fill',{instructionId:id,nominalYuan:10*YI});
  const remaining=model.generateProposal();
  assert.equal(remaining.summary.availableYuan,5*YI);
  assert.equal(remaining.summary.accountCashYuan,5*YI);
  const c02=evaluateCoreRules(remaining).rows.find(r=>r.ruleId==='C02'&&r.subjectId==='PORTFOLIO');
  assert.equal(c02.currentValue,0.05);
  assert.ok(remaining.proposal.steps.every(s=>s.blocked));
  assert.equal(remaining.summary.planBalances.find(p=>p.planId===repo.planId).remainingYuan,10*YI);
});

test('R06 suggests exactly one yi slice and preserves six yi after fill', () => {
  const model=start(scenario('R06'));
  let state=model.generateProposal();
  assert.equal(state.proposal.status,'feasible');
  assert.equal(state.proposal.steps.length,1);
  assert.equal(state.proposal.steps[0].nominalYuan,YI);
  assert.deepEqual([cover(state,'买短债7亿').targetYuan,cover(state,'买短债7亿').unarrangedYuan],
    [7*YI,6*YI]);
  assert.ok(state.calculation.trace.search.partialChecks > 0);
  model.approveProposal();
  const id=model.send(state.proposal.steps[0].stepId).sentInstructionId;
  assert.equal(model.getState().summary.planBalances[0].lockedYuan,YI);
  assert.throws(()=>model.send(state.proposal.steps[0].stepId),/已有发送事实/);
  model.simulateEvent('accepted',{instructionId:id});
  model.simulateEvent('fill',{instructionId:id,nominalYuan:YI});
  state=model.generateProposal();
  assert.equal(state.summary.planBalances[0].filledYuan,YI);
  assert.equal(state.summary.planBalances[0].remainingYuan,6*YI);
  assert.equal(state.proposal.planCoverage[0].targetYuan,7*YI);
  assert.equal(state.proposal.planCoverage[0].suggestedYuan,0);
});

test('R07 buys unrelated bond and one yi B-bank CD, then retains one yi CD goal', () => {
  const model=start(scenario('R07'));
  let state=model.generateProposal();
  assert.equal(step(state,'买B存单2亿').nominalYuan,YI);
  assert.equal(step(state,'买短债1亿').nominalYuan,YI);
  assert.equal(cover(state,'买B存单2亿').unarrangedYuan,YI);
  model.approveProposal();
  const sent=model.sendBatch();
  assert.deepEqual(sent.results.map(x=>x.status),['accepted','accepted']);
  assert.equal(sent.summary.planBalances.reduce((n,x)=>n+x.lockedYuan,0),2*YI);
  for (const row of sent.results) model.simulateEvent('fill',{instructionId:row.instructionId,nominalYuan:YI});
  state=model.generateProposal();
  assert.equal(state.summary.planBalances.find(x=>x.planId===cover(state,'买B存单2亿').planId).remainingYuan,YI);
  assert.equal(state.summary.planBalances.find(x=>x.planId===cover(state,'买短债1亿').planId).remainingYuan,0);
  assert.equal(cover(state,'买B存单2亿').suggestedYuan,0);
});

test('two competing plans share the same cash and same-bank headroom once', () => {
  const cash=baseTemplate({id:'PART-CASH',cash:3,gov:3});
  cash.draftPlans=[plan('甲买债','bond_buy',7,'SHORT'),plan('乙买债','bond_buy',7,'SHORT')];
  const cashState=start(cash).generateProposal();
  assert.equal(cashState.proposal.steps.reduce((n,x)=>n+x.nominalYuan,0),YI);
  assert.equal(cashState.proposal.unarrangedYuan,13*YI);

  const bank=baseTemplate({id:'PART-BANK',cash:10,holdings:[{securityId:'CD-B',amount:4}]});
  bank.draftPlans=[plan('甲买B','cd_buy',2,'CD-B'),plan('乙买B','cd_buy',2,'CD-B')];
  const bankState=start(bank).generateProposal();
  assert.equal(bankState.proposal.steps.reduce((n,x)=>n+x.nominalYuan,0),YI);
  assert.equal(bankState.proposal.unarrangedYuan,3*YI);
});

test('buffer caps a slice even where C02 has more headroom', () => {
  const t=baseTemplate({id:'PART-BUFFER',cash:3,gov:5});
  t.portfolio.bufferYuan=2*YI;
  t.draftPlans=[plan('买短债','bond_buy',3,'SHORT')];
  const state=start(t).generateProposal();
  assert.equal(state.proposal.steps.length,1);
  assert.equal(state.proposal.steps[0].nominalYuan,YI);
  assert.equal(state.proposal.unarrangedYuan,2*YI);
});

test('unknown bank denominator and invalid unit do not become guessed capacity', () => {
  const missing=start(scenario('R12')).generateProposal();
  assert.equal(step(missing,'买B存单1亿'),undefined);
  assert.equal(step(missing,'逆回购1亿').nominalYuan,YI);
  const t=baseTemplate({id:'PART-UNIT',cash:3,gov:3});
  t.draftPlans=[{...plan('单位不整','bond_buy',7,'SHORT'),targetYuan:7*YI+1}];
  const unitState=start(t).generateProposal();
  assert.equal(unitState.proposal.steps.length,0);
  assert.equal(unitState.proposal.unarrangedYuan,7*YI+1);
  assert.equal(unitState.calculation.trace.search.boundary,'unit_mismatch');
  const unknown=baseTemplate({id:'PART-IDENTITY',cash:10});
  unknown.draftPlans=[{...plan('发行人未知','cd_buy',2,'CD-B'),securityId:null,issuerId:null}];
  const unknownModel=start(unknown),unknownState=unknownModel.generateProposal();
  assert.equal(unknownState.canApprove,false);
  assert.throws(()=>unknownModel.approveProposal(),/没有可审核/);
});

test('projected financing fill can unlock a bounded buy without adding a second financing plan', () => {
  const t=baseTemplate({id:'PART-FINANCE',cash:3,gov:3});
  t.portfolio.bufferYuan=2*YI;
  t.draftPlans=[plan('融资2亿','interbank_repo_financing',2),plan('买短债8亿','bond_buy',8,'SHORT')];
  const model=start(t);
  const state=model.generateProposal();
  assert.equal(state.plans.filter(p=>p.direction==='inflow').length,1);
  const funding=step(state,'融资2亿'),buy=step(state,'买短债8亿');
  assert.equal(funding.nominalYuan,2*YI);
  assert.equal(buy.nominalYuan,3*YI);
  assert.ok(buy.machineConditions.some(x=>x.kind==='funds_available' && x.basis==='fill' &&
    x.planId===funding.planId));
  assert.equal(cover(state,'买短债8亿').unarrangedYuan,5*YI);
});

test('projected sale exposure relief can precede a capped same-bank purchase', () => {
  const t=baseTemplate({id:'PART-SALE',cash:10,holdings:[{securityId:'CD-B',amount:6}]});
  t.draftPlans=[plan('卖B存单2亿','cd_sell',2,'CD-B'),plan('买B存单3亿','cd_buy',3,'CD-B')];
  const state=start(t).generateProposal();
  assert.equal(step(state,'卖B存单2亿').nominalYuan,2*YI);
  assert.equal(step(state,'买B存单3亿').nominalYuan,YI);
  assert.ok(step(state,'买B存单3亿').machineConditions.some(x=>x.kind==='filled'));
});
