import test from 'node:test';
import assert from 'node:assert/strict';
import {createLegacySyntheticInitialTemplate as createSyntheticInitialTemplate} from './initial-data.js';
import {evaluateCoreRules} from './core-rules.js';
import {buildAnalysis,normalizeAnalysisPreferences,updateAnalysisPreference} from './analysis.js';

function state() {
  const initialData=createSyntheticInitialTemplate();
  return {initialData,plans:[],context:{runId:'TEST',businessDate:initialData.businessDate},
    summary:{availableYuan:350000000},execution:{instructions:{},snapshot:{quality:'fresh',observedAt:0}},
    rulesVersion:'2B-0.1.0',ruleConfig:{version:1},preferences:{version:1},revision:4};
}
const row = (result,key)=>result.coreRows.find(x=>x.key===key);
const plan = ()=>({planId:'P-DEP',businessType:'deposit',direction:'outflow',
  issuerId:'BANK-A',counterpartyId:'BANK-A',securityId:'DEP-A',
  settlementDate:'2026-09-07'});

test('current checks use independently expected amounts, ratios and counts',()=>{
  const analysis=buildAnalysis(state());
  assert.equal(analysis.ruleDirectory.length,121);
  assert.equal(analysis.ruleDirectory.filter(x=>x.configured).length,10);
  assert.equal(analysis.ruleDirectory[10].name,'待提供');
  assert.equal(analysis.counts.catalogTotal,121);
  assert.equal(analysis.counts.configuredRules,10);
  assert.equal(analysis.counts.applicableSubjectChecks,13);
  assert.equal(analysis.counts.calculatedSubjectChecks,13);
  assert.equal(analysis.counts.notapp,8);
  assert.equal(analysis.counts.historicalMetrics,102);
  assert.equal(analysis.counts.externalRead,0);
  assert.equal(row(analysis,'C01:PORTFOLIO').currentValue,350000000);
  assert.equal(row(analysis,'C02:PORTFOLIO').currentValue,(350000000+2500000000)/50000000000);
  assert.equal(row(analysis,'C02:PORTFOLIO').headroomYuan,350000000);
  assert.equal(row(analysis,'C03:BANK-B').currentValue,200000000/50000000000);
  assert.equal(row(analysis,'C09:PORTFOLIO').currentValue,31.135);
  assert.equal(row(analysis,'C02:PORTFOLIO').projectedValue,null);
  assert.equal(analysis.projection.available,false);
});

test('legacy has zero actual C calculations rather than mapping old 8% rule',()=>{
  const s=state();
  s.initialData.provenance.kind='legacy';
  const analysis=buildAnalysis(s);
  assert.equal(analysis.coreRows.length,0);
  assert.equal(analysis.counts.calculatedSubjectChecks,0);
  assert.equal(analysis.counts.applicableSubjectChecks,0);
  assert.equal(analysis.counts.configuredRules,10);
  assert.equal(analysis.projection.available,false);
});

test('missing inputs and threshold breaches stay distinct from calculated passes',()=>{
  const s=state();
  s.initialData.banks.find(x=>x.bankId==='BANK-B').custodyQualified=null;
  let analysis=buildAnalysis(s);
  assert.equal(row(analysis,'C03:BANK-B').status,'missing');
  assert.equal(analysis.counts.missingSubjectChecks,3);
  assert.equal(analysis.counts.calculatedSubjectChecks,12);
  s.initialData.banks.find(x=>x.bankId==='BANK-B').custodyQualified=false;
  s.summary.availableYuan=-1;
  analysis=buildAnalysis(s);
  assert.equal(row(analysis,'C01:PORTFOLIO').status,'block');
  assert.equal(row(analysis,'C01:PORTFOLIO').headroomYuan,-1);
  assert.equal(row(analysis,'C02:PORTFOLIO').status,'block');
  assert.equal(analysis.counts.block,2);
});

test('one selected independent first step is rechecked; stale or sent trace is rejected',()=>{
  const s=state(),p=plan();
  s.plans=[p];
  const step={stepId:'S1',planId:p.planId,nominalYuan:100000000,
    blocked:false,machineConditions:[]};
  const expected=evaluateCoreRules(s,{plan:p,amountYuan:step.nominalYuan,
    cashYuan:s.summary.availableYuan});
  s.proposal={origin:'calculated',proposalId:'TEST-PROP-1',steps:[step]};
  s.calculation={trace:{steps:[{...step,beforeCashYuan:350000000,rules:expected.rows}],
    rulesVersion:s.rulesVersion,ruleConfigVersion:1,preferencesVersion:1,snapshotRevision:3}};
  let analysis=buildAnalysis(s,{stepId:'S1',nowMs:30000});
  assert.equal(analysis.projection.available,true);
  assert.match(analysis.projection.label,/单笔独立测算/);
  assert.equal(row(analysis,'C01:PORTFOLIO').projectedValue,250000000);
  assert.equal(row(analysis,'C04:BANK-A').projectedValue,1700000000/50000000000);
  assert.equal(buildAnalysis(s,{stepId:'S1'}).projection.available,false);
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:30001}).projection.available,false);
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:-1}).projection.available,false);
  s.execution.snapshot.observedAt=30001;
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:30000}).projection.available,false);
  s.execution.snapshot.observedAt=0;
  s.execution.instructions.I1={stepId:'S1',status:'unknown',planId:p.planId,
    nominalYuan:100000000,cancelledYuan:0,filledYuan:0};
  analysis=buildAnalysis(s,{stepId:'S1',nowMs:30000});
  assert.equal(analysis.projection.available,false);
  assert.equal(row(analysis,'C04:BANK-A').projectedValue,null);
  delete s.execution.instructions.I1;
  s.revision=6;
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:30000}).projection.available,false);
  s.revision=4;
  s.initialData.banks.find(x=>x.bankId==='BANK-A').custodyQualified=false;
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:30000}).projection.available,false);
  s.initialData.banks.find(x=>x.bankId==='BANK-A').custodyQualified=true;
  step.machineConditions=[{kind:'cash_available'}];
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:30000}).projection.available,false);
});

test('settlement condition checks all later dated balances and C01 after result',()=>{
  const s=state(),p=plan();
  s.plans=[p];
  s.summary.dateBalances=[
    {valueDate:'2026-09-07',availableYuan:350000000},
    {valueDate:'2026-09-08',availableYuan:99000000},
  ];
  const condition={kind:'settlement_capacity',valueDate:'2026-09-07',
    minimumYuan:100000000,planId:p.planId};
  const step={stepId:'S1',planId:p.planId,nominalYuan:100000000,
    blocked:false,machineConditions:[condition]};
  const expected=evaluateCoreRules(s,{plan:p,amountYuan:step.nominalYuan,
    cashYuan:s.summary.availableYuan});
  assert.equal(expected.rows.find(x=>x.ruleId==='C01').result,'pass');
  s.proposal={origin:'calculated',proposalId:'TEST-PROP-1',steps:[step]};
  s.calculation={trace:{steps:[{...step,beforeCashYuan:350000000,rules:expected.rows}],
    rulesVersion:s.rulesVersion,ruleConfigVersion:1,preferencesVersion:1,snapshotRevision:3}};
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:0}).projection.available,false);
  s.summary.dateBalances[1].availableYuan=100000000;
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:0}).projection.available,true);
  s.summary.dateBalances[1].availableYuan=null;
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:0}).projection.available,false);
  s.summary.dateBalances[1].availableYuan=100000000;
  step.machineConditions=[];
  s.calculation.trace.steps[0].machineConditions=[];
  step.nominalYuan=350000001;
  s.calculation.trace.steps[0].nominalYuan=350000001;
  s.calculation.trace.steps[0].rules=evaluateCoreRules(s,{plan:p,amountYuan:350000001,
    cashYuan:350000000}).rows;
  assert.equal(buildAnalysis(s,{stepId:'S1',nowMs:0}).projection.available,false);
});

test('favorites normalize IDs, deduplicate and move without mutating input',()=>{
  const raw={favorites:['C02:PORTFOLIO','MET-001','MET-001','MET-999','bad',
    'C03:BANK-A','C03:BANK-A'],order:['C03:BANK-A','MET-001','MET-001','bad']};
  const prefs=normalizeAnalysisPreferences(raw);
  assert.deepEqual(prefs,{version:1,
    favorites:['C02:PORTFOLIO','MET-001','C03:BANK-A'],
    order:['C03:BANK-A','MET-001','C02:PORTFOLIO']});
  const up=updateAnalysisPreference(prefs,'C02:PORTFOLIO','up');
  assert.deepEqual(up.order,['C03:BANK-A','C02:PORTFOLIO','MET-001']);
  assert.deepEqual(prefs.order,['C03:BANK-A','MET-001','C02:PORTFOLIO']);
  const off=updateAnalysisPreference(up,'MET-001','toggle');
  assert.deepEqual(off.favorites,['C02:PORTFOLIO','C03:BANK-A']);
  assert.deepEqual(off.order,['C03:BANK-A','C02:PORTFOLIO']);
  assert.deepEqual(updateAnalysisPreference(off,'MET-999','toggle'),off);
  assert.deepEqual(normalizeAnalysisPreferences({favorites:['MET-001'.repeat(100)]}),
    {version:1,favorites:[],order:[]});
});


test('deposit gate is an additional demo rule and keeps original unprovided catalog intact',()=>{
  const analysis=buildAnalysis(state());
  assert.equal(analysis.ruleDirectory.filter(x=>!x.configured).length,111);
  assert.equal(analysis.ruleDirectory.find(x=>x.ruleId==='C05-DEPOSIT').source,'2026-10-19用户确认演示口径');
  assert.equal(analysis.ruleDirectory.some(x=>x.ruleId==='C04-DEPOSIT'),false);
  assert.deepEqual(normalizeAnalysisPreferences({favorites:['C05-DEPOSIT:BANK-A','C05-DEPOSIT:<bad>']}),
    {version:1,favorites:['C05-DEPOSIT:BANK-A'],order:['C05-DEPOSIT:BANK-A']});
});
