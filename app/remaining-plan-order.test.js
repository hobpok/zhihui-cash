import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel} from './model.js';
import {calculate,evaluateSelectedSequence,remainingDepositOrderIssue} from './engine.js';
import {createBankOrderInitialTemplate} from './default-scenario.js';
import {baseTemplate,plan,YI} from '../scripts/robustness-scenarios.mjs';

const start = template => { const model=createModel();model.startFromTemplate(template);return model; };
const bankPlan = (state,kind,bank) => state.plans.find(p=>p.businessType===kind && p.issuerId===bank);
const selected = (state,p) => state.proposal.steps.find(step=>step.planId===p.planId);
const coverage = (state,p) => state.proposal.planCoverage.find(row=>row.planId===p.planId);

// Rebuild the retained six-plan revision without changing or migrating a saved
// run. Its amounts are independent assertions of the old public sample.
function oldSixTemplate() {
  const t=createBankOrderInitialTemplate({businessDate:'2026-10-24'});
  t.revision=1;
  t.draftPlans[0]={...t.draftPlans[1],label:'广州存款1亿',targetYuan:YI};
  t.draftPlans[1]={...t.draftPlans[3],label:'广州买存单2亿',issuerId:'SIM-BANK-GZ',
    securityId:'SIM-GZ-CD-NEW',targetYuan:2*YI};
  t.draftPlans[5]={...t.draftPlans[5],label:'融资51亿1天',targetYuan:51*YI};
  return t;
}
function partiallyFinanced(amount) {
  const model=start(oldSixTemplate()),initial=model.generateProposal();
  model.approveProposal();
  const finance=initial.proposal.steps.find(step=>initial.plans.find(p=>p.planId===step.planId)
    .businessType==='interbank_repo_financing');
  const id=model.send(finance.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:id});
  model.simulateEvent('fill',{instructionId:id,nominalYuan:amount*YI});
  return {model,id};
}
function constrainedBank({cash=1,other=58,cd=1,sale=false,bond=false}={}) {
  const t=baseTemplate({id:'REMAINING-ORDER',cash,gov:5,
    holdings:sale?[{securityId:'CD-B',amount:2}]:[]});
  t.otherFundBankExposure.find(x=>x.bankId==='BANK-B').depositYuan=other*YI;
  if (bond) t.securities.push({...t.securities.find(s=>s.securityId==='CD-B'),
    securityId:'BOND-B',label:'合成银行债',instrumentKind:'bond'});
  t.draftPlans=[...(sale?[plan('原计划卖存单2亿','cd_sell',2,'CD-B')]:[]),
    plan('整笔存款2亿','deposit',2,'DEP-B'),
    plan('同银行证券买入',bond?'bond_buy':'cd_buy',cd,bond?'BOND-B':'CD-B')];
  return t;
}

test('old six-plan partial financing protects both whole deposits without spending the in-flight remainder',()=>{
  const {model}=partiallyFinanced(30),before=model.serialize();
  const state=model.generateProposal();
  const gz=bankPlan(state,'deposit','SIM-BANK-GZ'),jn=bankPlan(state,'deposit','SIM-BANK-JNRCB');
  const jncd=bankPlan(state,'cd_buy','SIM-BANK-JNRCB'),gzcd=bankPlan(state,'cd_buy','SIM-BANK-GZ');
  assert.equal(state.proposal.status,'feasible');
  assert.equal(selected(state,gz).nominalYuan,YI);
  assert.equal(selected(state,jn).nominalYuan,2*YI);
  assert.equal(selected(state,jncd).nominalYuan,YI);
  assert.equal(selected(state,gzcd).nominalYuan,YI);
  assert.ok(state.proposal.steps.indexOf(selected(state,jn))<state.proposal.steps.indexOf(selected(state,jncd)));
  assert.equal(state.proposal.steps.reduce((n,s)=>n+s.nominalYuan,0),5*YI);
  const financing=state.summary.planBalances.find(b=>state.plans.find(p=>p.planId===b.planId).direction==='inflow');
  assert.deepEqual([financing.filledYuan,financing.lockedYuan,financing.arrangeableYuan],[30*YI,21*YI,0]);
  assert.equal(state.summary.availableYuan,10*YI);
  assert.equal(coverage(state,gzcd).unarrangedYuan,YI);
  assert.equal(state.calculation.trace.search.subsetStrategy,'remaining_deposit_guarded_greedy');
  assert.equal(state.calculation.trace.search.complete,false);
  assert.deepEqual(state.initialData,JSON.parse(before).initialData);
  assert.equal(state.plans.length,6);
  // A repeated calculation uses the same facts and cannot allocate the locked
  // 21-yi financing again or replace the retained revision with new defaults.
  assert.deepEqual(model.generateProposal().proposal.steps,state.proposal.steps);
});

test('when the whole deposit cannot fit now, a conflicting CD is held with an explicit remaining-plan reason',()=>{
  const {model}=partiallyFinanced(27),state=model.generateProposal();
  const deposit=bankPlan(state,'deposit','SIM-BANK-JNRCB'),cd=bankPlan(state,'cd_buy','SIM-BANK-JNRCB');
  assert.equal(coverage(state,deposit).suggestedYuan,0);
  assert.equal(coverage(state,cd).suggestedYuan,0);
  const excluded=state.calculation.trace.search.excludedActions.find(x=>x.planId===cd.planId);
  assert.equal(excluded.ruleId,'PLAN-DEPOSIT-ORDER');
  assert.deepEqual(excluded.requiredDepositPlanIds,[deposit.planId]);
  assert.match(excluded.reason,/剩余整笔存款/);
  assert.match(excluded.reason,/6%/);
  assert.ok(state.proposal.steps.every(step=>state.plans.find(p=>p.planId===step.planId).businessType!=='deposit' ||
    step.nominalYuan===state.plans.find(p=>p.planId===step.planId).targetYuan));
});

test('remaining-bank headroom also caps a partial CD when the unsent deposit needs more cash',()=>{
  const model=start(constrainedBank({other:57,cd:2})),state=model.generateProposal();
  const cd=state.plans.find(p=>p.businessType==='cd_buy'),deposit=state.plans.find(p=>p.businessType==='deposit');
  assert.equal(selected(state,cd).nominalYuan,YI);
  assert.equal(coverage(state,deposit).suggestedYuan,0);
  assert.equal(remainingDepositOrderIssue(state,cd,YI),null);
  assert.equal(remainingDepositOrderIssue(state,cd,2*YI).ruleId,'PLAN-DEPOSIT-ORDER');
  assert.equal(coverage(state,cd).unarrangedYuan,YI);
});

test('guard covers bank bonds and uses the configured bank threshold rather than display names',()=>{
  const t=constrainedBank({bond:true});
  t.banks.find(b=>b.bankId==='BANK-B').label='独立测试银行';
  const model=start(t),state=model.generateProposal(),bond=state.plans.find(p=>p.businessType==='bond_buy');
  const issue=remainingDepositOrderIssue(state,bond,YI);
  assert.equal(issue.bankId,'BANK-B');assert.equal(issue.blockingRule.ruleId,'C05-DEPOSIT');
  assert.equal(coverage(state,bond).suggestedYuan,0);
  const relaxed=structuredClone(state);
  relaxed.initialData.banks.find(b=>b.bankId==='BANK-B').depositLimitBps=800;
  assert.equal(remainingDepositOrderIssue(relaxed,bond,YI),null);
});

test('planned exposure-releasing sales are considered only as a future route for the retained deposits',()=>{
  const model=start(constrainedBank({sale:true})),state=model.getState();
  const cd=state.plans.find(p=>p.businessType==='cd_buy'),before=model.serialize();
  assert.equal(remainingDepositOrderIssue(state,cd,YI).ruleId,'PLAN-DEPOSIT-ORDER');
  assert.equal(model.serialize(),before);
  // Merely considering that sale must neither create cash nor claim a fill.
  assert.equal(state.summary.availableYuan,YI);
  assert.ok(state.summary.planBalances.every(row=>row.filledYuan===0));
});

test('an impossible combined deposit goal cannot hide individually executable deposits',()=>{
  const t=constrainedBank({cash:10});
  const deposit=t.draftPlans[0],cd=t.draftPlans[1];
  t.draftPlans=[cd,{...deposit,label:'甲整笔存款2亿'},{...deposit,label:'乙整笔存款2亿'}];
  const model=start(t),opening=model.getState(),buy=opening.plans[0];
  assert.equal(remainingDepositOrderIssue(opening,buy,YI).ruleId,'PLAN-DEPOSIT-ORDER');
  const state=model.generateProposal();
  assert.equal(state.plans.find(p=>p.planId===state.proposal.steps[0].planId).businessType,'deposit');
  assert.ok(state.proposal.planCoverage.some(row=>row.suggestedYuan===2*YI &&
    state.plans.find(p=>p.planId===row.planId).businessType==='deposit'));
  assert.ok(state.proposal.unarrangedYuan>=2*YI);
});

test('a sale-unlocked selected deposit cannot hide the next whole deposit from prefix protection',()=>{
  const t=baseTemplate({id:'SALE-MULTI-DEPOSIT',cash:1,gov:1,
    holdings:[{securityId:'CD-B',amount:6,sellable:6}]});
  t.otherFundBankExposure.find(x=>x.bankId==='BANK-B').depositYuan=56*YI;
  t.draftPlans=[plan('卖B存单6亿','cd_sell',6,'CD-B'),
    plan('甲整笔存款2亿','deposit',2,'DEP-B'),plan('乙整笔存款2亿','deposit',2,'DEP-B'),
    plan('买B存单1亿','cd_buy',1,'CD-B')];
  const model=start(t),opening=model.getState();
  const [sale,first,second,cd]=opening.plans;
  const issue=remainingDepositOrderIssue(opening,cd,YI,
    [{plan:sale,amountYuan:6*YI},{plan:first,amountYuan:2*YI}]);
  assert.equal(issue.ruleId,'PLAN-DEPOSIT-ORDER');
  assert.ok(issue.requiredDepositPlanIds.includes(second.planId));
  const state=model.generateProposal();
  assert.equal(selected(state,cd),undefined);
  assert.equal(coverage(state,cd).unarrangedYuan,YI);
  assert.equal(coverage(state,second).unarrangedYuan,2*YI);
  assert.deepEqual(state.proposal.steps.map(step=>step.planId),[sale.planId,first.planId]);
  // The sale remains an unfilled prerequisite, not a cash or holding fact.
  assert.equal(state.summary.availableYuan,YI);
  assert.ok(selected(state,first).machineConditions.some(c=>c.kind==='filled'&&c.planId===sale.planId));
});

for (const available of [0,2,null]) test(`future sale with sellable=${available} never licenses a CD before a currently valid deposit`,()=>{
  const t=constrainedBank({cash:10,sale:available!==0});
  if (available===0) t.draftPlans.unshift(plan('无持仓卖存单2亿','cd_sell',2,'CD-B'));
  // Keep opening company exposure at 58 yi for both the valid and invalid sale
  // cases, so the whole two-yi deposit itself is currently valid.
  if (available!==0) {
    t.otherFundBankExposure.find(x=>x.bankId==='BANK-B').depositYuan=56*YI;
    if (available===null) t.holdings.find(h=>h.securityId==='CD-B').sellableYuan=null;
  }
  t.draftPlans.sort((a,b)=>Number(b.businessType==='cd_buy')-Number(a.businessType==='cd_buy'));
  const model=start(t),opening=model.getState(),cd=opening.plans.find(p=>p.businessType==='cd_buy');
  assert.equal(remainingDepositOrderIssue(opening,cd,YI).ruleId,'PLAN-DEPOSIT-ORDER');
  const state=model.generateProposal(),deposit=state.plans.find(p=>p.businessType==='deposit');
  assert.ok(state.proposal.steps.indexOf(selected(state,deposit))<state.proposal.steps.indexOf(selected(state,cd)));
  assert.equal(coverage(state,deposit).suggestedYuan,2*YI);
});

test('already-sent whole deposits are not reserved twice by the unsent-plan guard',()=>{
  const model=start(constrainedBank({cash:10})),state=model.generateProposal();
  const deposit=state.plans.find(p=>p.businessType==='deposit'),cd=state.plans.find(p=>p.businessType==='cd_buy');
  assert.equal(remainingDepositOrderIssue(state,cd,YI).ruleId,'PLAN-DEPOSIT-ORDER');
  model.approveProposal();
  model.send(selected(state,deposit).stepId);
  const sent=model.getState();
  assert.equal(sent.summary.planBalances.find(b=>b.planId===deposit.planId).arrangeableYuan,0);
  assert.equal(remainingDepositOrderIssue(sent,cd,YI),null);
});

test('completion of the original financing restores all five unsent goals in the correct order',()=>{
  const {model,id}=partiallyFinanced(30);
  model.generateProposal();
  model.simulateEvent('fill',{instructionId:id,nominalYuan:21*YI});
  const state=model.generateProposal();
  assert.equal(state.proposal.status,'feasible');
  assert.equal(state.proposal.steps.length,5);
  assert.equal(state.proposal.unarrangedYuan,0);
  assert.ok(state.proposal.planCoverage.every(row=>row.unarrangedYuan===0));
  assert.equal(state.plans.filter(p=>p.businessType==='interbank_repo_financing').length,1);
});

test('new six-plan default and explicitly selected order retain their amounts and terms',()=>{
  const t=createBankOrderInitialTemplate({businessDate:'2026-10-24'}),model=start(t),state=model.generateProposal();
  assert.equal(state.proposal.steps.length,6);
  assert.equal(state.proposal.unarrangedYuan,0);
  assert.deepEqual(state.initialData.draftPlans,t.draftPlans);
  const old=start(oldSixTemplate()),original=old.generateProposal();
  const deposit=bankPlan(original,'deposit','SIM-BANK-JNRCB'),cd=bankPlan(original,'cd_buy','SIM-BANK-JNRCB');
  const explicit=evaluateSelectedSequence(original,[{planId:cd.planId,nominalYuan:YI},
    {planId:deposit.planId,nominalYuan:2*YI}]);
  assert.equal(explicit.steps[0].planId,cd.planId);
  assert.equal(explicit.status,'blocked_sequence');
  const bounded=calculate(state,{nodeLimit:1});
  assert.equal(bounded.trace.search.truncated,true);
  assert.equal(bounded.trace.search.complete,false);
});
