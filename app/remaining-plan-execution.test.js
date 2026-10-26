import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel,executionFillReadiness,validateSaved} from './model.js';
import {registerSend,applyEvent} from './execution.js';
import {baseTemplate,plan,YI} from '../scripts/robustness-scenarios.mjs';

function setup(){
  const t=baseTemplate({id:'REMAINING-EXECUTION',cash:10,gov:5});
  t.otherFundBankExposure.find(x=>x.bankId==='BANK-B').depositYuan=58*YI;
  t.draftPlans=[plan('先存2亿','deposit',2,'DEP-B'),plan('后买CD1亿','cd_buy',1,'CD-B')];
  const m=createModel();m.startFromTemplate(t);m.generateProposal();return m;
}

test('skipping an unsent deposit in an automatic proposal cannot dispatch its dependent CD',()=>{
  const m=setup(),s=m.getState(),cd=s.proposal.steps.find(x=>s.plans.find(p=>p.planId===x.planId).businessType==='cd_buy');
  m.approveProposal();const before=m.serialize();
  assert.throws(()=>m.send(cd.stepId),/剩余整笔存款/);
  assert.equal(m.serialize(),before);
  const sent=m.sendBatch();
  assert.deepEqual(sent.results.map(x=>x.status),['accepted','accepted']);
});

test('legacy accepted CD is preserved but cannot newly fill ahead of the unsent deposit',()=>{
  const m=setup(),s=JSON.parse(m.serialize()),p=s.plans.find(p=>p.businessType==='cd_buy');
  // A valid pre-fix archive can already contain an accepted purchase. Construct
  // that historical fact through the execution API, bypassing only new sending.
  const sent=registerSend(s.execution,{stepId:'LEGACY-CD',nominalYuan:YI},p,'LEGACY-APPROVAL');
  s.execution=applyEvent(sent.execution,{eventId:'LEGACY-ACCEPT',sourceSequence:1,
    type:'accepted',instructionId:sent.instructionId}).execution;
  assert.equal(validateSaved(s).ok,true);
  m.load(JSON.stringify(s));
  const restored=m.getState(),before=m.serialize();
  assert.deepEqual(restored.execution.instructions,s.execution.instructions);
  assert.deepEqual(restored.execution.journal,s.execution.journal);
  const gate=executionFillReadiness(restored,sent.instructionId,YI);
  assert.equal(gate.ready,false);assert.equal(gate.ruleId,'PLAN-DEPOSIT-ORDER');
  assert.throws(()=>m.simulateEvent('fill',{instructionId:sent.instructionId,nominalYuan:YI}),/剩余整笔存款/);
  assert.equal(m.serialize(),before);
});

test('an already filled legacy CD is never reversed or hidden to make a remaining deposit feasible',()=>{
  const m=setup(),s=JSON.parse(m.serialize()),p=s.plans.find(p=>p.businessType==='cd_buy');
  const sent=registerSend(s.execution,{stepId:'LEGACY-FILLED',nominalYuan:YI},p,'LEGACY-APPROVAL');
  s.execution=applyEvent(sent.execution,{eventId:'LEGACY-ACCEPT',sourceSequence:1,
    type:'accepted',instructionId:sent.instructionId}).execution;
  s.execution=applyEvent(s.execution,{eventId:'LEGACY-FILL',sourceSequence:2,type:'fill',
    instructionId:sent.instructionId,nominalYuan:YI,fillId:'LEGACY-FILL-ID'}).execution;
  m.load(JSON.stringify(s));m.generateProposal();const after=m.getState();
  assert.deepEqual(after.execution.instructions,s.execution.instructions);
  assert.deepEqual(after.execution.journal,s.execution.journal);
  assert.equal(after.summary.planBalances.find(x=>x.planId===p.planId).filledYuan,YI);
  assert.equal(m.getAdvancementGroups().pending.length,0);
  assert.match(m.getAdvancementGroups().restricted.map(x=>x.reason).join(' '),/6%|存款/);
});
