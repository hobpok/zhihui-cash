import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel,validateSaved} from './model.js';
import {newExecution,applyEvent,validateExecution} from './execution.js';
import {createSyntheticInitialTemplate} from './initial-data.js';
import {createHistoricalComplexTemplate} from './test-fixtures/historical-complex.js';

// Match D1's canonical object serialization and a different remote key order.
// Deliberately never sort arrays, including the execution journal.
const reordered=(value,descending=false)=>Array.isArray(value)?value.map(x=>reordered(x,descending))
  :value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort((a,b)=>descending?b.localeCompare(a):a.localeCompare(b))
    .map(key=>[key,reordered(value[key],descending)])):value;
const saved=model=>JSON.parse(model.serialize());
const valid=value=>assert.deepEqual(validateSaved(value),{ok:true,errors:[]});
const executed=()=>{
 const model=createModel();model.startFromTemplate(createHistoricalComplexTemplate());model.generateProposal();model.approveProposal();
 const batch=model.sendBatch(),id=batch.results.find(x=>x.status==='accepted').instructionId;
 model.simulateEvent('fill',{instructionId:id,fillId:'KEY-ORDER-FILL',nominalYuan:1000000});
 model.simulateEvent('cash_settled',{instructionId:id,cashFlowId:'KEY-ORDER-SETTLE',amountYuan:1000000});
 model.simulateEvent('cash_available',{instructionId:id,cashFlowId:'KEY-ORDER-CASH',amountYuan:1000000});
 return model;
};

test('legacy seeds and historical progress survive arbitrary JSON object key order',()=>{
 for(const scenario of ['S13','S10']){
  const model=createModel();model.reset(scenario);valid(reordered(saved(model)));valid(reordered(saved(model),true));
  if(scenario==='S10'){model.selectProgress('filled3');valid(reordered(saved(model)));valid(reordered(saved(model),true));}
 }
});

test('cloud key canonicalization preserves normalized template and approval while load still requires reapproval',()=>{
 const model=createModel();model.startFromTemplate(createHistoricalComplexTemplate());model.generateProposal();model.approveProposal();
 const value=reordered(saved(model));
 value.approval.proposalCopy=reordered(value.approval.proposalCopy,true);
 valid(value);valid(reordered(value,true));
 const restored=createModel();restored.load(JSON.stringify(value));
 assert.deepEqual(restored.getState().plans,model.getState().plans);
 assert.deepEqual(restored.getState().initialData,model.getState().initialData);
 assert.equal(restored.getState().execution.requiresRefresh,true);
 assert.equal(restored.getState().execution.requiresReapproval,true);
 assert.equal(restored.getState().approvalStatus,'stale');
 assert.equal(restored.getState().canApprove,false);
});

test('opening cash receipts and their source facts survive sorted cloud JSON',()=>{
 const model=createModel(),template=createSyntheticInitialTemplate();model.startFromTemplate(template);
 const source=model.getState().summary.settlementRows.find(row=>row.direction==='inflow'&&row.remainingYuan>0);
 assert.ok(source);model.recordCashEvent({eventId:'ORDER-OPENING-CASH',sourceId:source.sourceId,amountYuan:source.remainingYuan});
 valid(reordered(saved(model)));valid(reordered(saved(model),true));
});

test('filled, settled and credited facts replay and load safely after cloud object canonicalization',()=>{
 const model=executed(),original=saved(model),before=model.getState();
 valid(reordered(original));valid(reordered(original,true));
 const cloud=reordered(original);
 // Compare plan terms with independently serialized instruction terms.
 for(const instruction of Object.values(cloud.execution.instructions))instruction.repoTerms=reordered(instruction.repoTerms,true);
 valid(cloud);model.load(cloud);
 const after=model.getState();
 for(const key of ['journal','instructions','fills','cashFlows','seen'])assert.deepEqual(after.execution[key],before.execution[key]);
 assert.equal(after.summary.accountCashYuan,before.summary.accountCashYuan);
 assert.equal(after.summary.availableYuan,before.summary.availableYuan);
 assert.equal(after.execution.requiresReapproval,true);
});

test('reordered duplicate reports stay idempotent but altered report contents are rejected',()=>{
 const event={eventId:'KEY-ORDER-EVENT',sourceSequence:1,type:'cash_available',instructionId:null,
  cashFlowId:'KEY-ORDER-FUNDING',amountYuan:100,syntheticFunding:true};
 const applied=applyEvent(newExecution(300),event).execution;
 assert.equal(applyEvent(applied,reordered(event,true)).result,'duplicate');
 assert.throws(()=>applyEvent(applied,{...reordered(event),amountYuan:101}),/同一回报ID内容冲突/);
 const pending={...event,eventId:'KEY-ORDER-PENDING',sourceSequence:2};
 const queued=applyEvent(newExecution(300),pending).execution;
 assert.equal(applyEvent(queued,reordered(pending,true)).result,'duplicate');
 assert.deepEqual(queued.pending[2],pending);
 assert.equal(validateExecution(reordered(queued,true),[]),true);
});

test('key-order tolerance never permits changed rules, unknown fields or altered execution facts',()=>{
 const model=executed(),original=reordered(saved(model));
 const changedRule=structuredClone(original);changedRule.ruleConfig.depositThreshold='0.09';
 assert.equal(validateSaved(changedRule).ok,false);
 assert.match(validateSaved(changedRule).errors.join(';'),/已修改规则缺少新配置版本/);
 const unknown=structuredClone(original);unknown.ruleConfig.unrecognized=1;assert.equal(validateSaved(unknown).ok,false);
 const changedFill=structuredClone(original);Object.values(changedFill.execution.fills)[0].nominalYuan+=1;
 assert.equal(validateSaved(changedFill).ok,false);
 assert.match(validateSaved(changedFill).errors.join(';'),/事件流水不一致/);
 const changedTerms=structuredClone(original),repo=Object.values(changedTerms.execution.instructions).find(x=>x.repoTerms);
 assert.ok(repo);repo.repoTerms.tenorDays+=1;assert.equal(validateSaved(changedTerms).ok,false);
 assert.match(validateSaved(changedTerms).errors.join(';'),/计划引用无效/);
});

test('JSON array order still protects seed plan identity and chronological execution replay',()=>{
 const legacy=createModel(),seed=reordered(saved(legacy));seed.plans.reverse();
 assert.equal(validateSaved(seed).ok,false);
 assert.match(validateSaved(seed).errors.join(';'),/种子来源标记/);
 const model=executed(),value=reordered(saved(model));value.execution.journal.reverse();
 assert.equal(validateSaved(value).ok,false);
 // Same-run load also refuses an actual edit to previously confirmed journal.
 const changed=structuredClone(reordered(saved(model)));changed.execution.journal[0].instruction.label='tampered';
 assert.throws(()=>model.load(changed),/事件流水不一致|较新执行事实/);
});

