import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, validateSaved } from './model.js';
import { makePlanningFixture, E } from './planning-fixtures.js';
import { createHistoricalComplexTemplate } from './test-fixtures/historical-complex.js';
import { automaticInstructionLabel } from './display-labels.js';
import { readPlanningSnapshot, validateIntent, preparePlanningDraft, applyConfirmedDraft,
  simulateDraft, compareDrafts } from './planning.js';

const row = (candidate, id) => candidate.finalRules.rows.find(r => r.ruleId === id && r.subjectId === 'PORTFOLIO');
test('terminal projection leaves the order-dependent deposit gate to the verified execution path', () => {
  const template=createHistoricalComplexTemplate();
  const sale=template.draftPlans.find(plan=>plan.businessType==='cd_sell');
  const deposit=template.draftPlans.find(plan=>plan.businessType==='deposit');
  const cd=template.draftPlans.find(plan=>plan.businessType==='cd_buy' &&
    plan.issuerId==='SIM-BANK-CDRCB');
  template.draftPlans=[sale,cd,deposit];
  const model=createModel(); model.startFromTemplate(template);
  const result=simulateDraft(readPlanningSnapshot(model),[],
    {executionSearch:{nodeLimit:2048,candidateBudget:128}});
  assert.equal(result.status,'waiting_conditions');
  assert.equal(result.applicable,true);
  assert.equal(result.finalRules.rows.find(row=>row.ruleId==='C05-DEPOSIT' &&
    row.subjectId==='SIM-BANK-CDRCB').result,'not_applicable');
  const stepPlans=result.proposal.steps.map(step=>model.getState().plans.find(plan=>plan.planId===step.planId));
  assert.deepEqual(stepPlans.map(plan=>plan.businessType),['cd_sell','deposit','cd_buy']);
});
test('accepted and filled but unsettled instructions remain conditional completion prerequisites', () => {
  const template=createHistoricalComplexTemplate();
  template.draftPlans=[template.draftPlans.find(plan=>plan.businessType==='cd_sell')];
  const model=createModel(); model.startFromTemplate(template);
  const first=model.generateProposal(); model.approveProposal();
  const instructionId=model.send(first.proposal.steps[0].stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId});
  const simulate=()=>simulateDraft(readPlanningSnapshot(model),[],
    {executionSearch:{nodeLimit:2048,candidateBudget:128}});
  let result=simulate();
  assert.equal(result.status,'waiting_conditions');
  assert.equal(result.applicable,true);
  assert.deepEqual(result.inFlightPrerequisites.map(item=>item.kind),
    ['in_flight_fill','in_flight_cash_receipt']);
  assert.equal(result.proposal.steps.length,0);
  assert.ok(result.executionPath.every(step=>step.condition));
  model.simulateEvent('fill',{instructionId,nominalYuan:1300000000});
  result=simulate();
  assert.equal(result.status,'waiting_conditions');
  assert.deepEqual(result.inFlightPrerequisites.map(item=>item.kind),
    ['in_flight_settlement','in_flight_cash_receipt']);
  model.simulateEvent('cash_settled',{instructionId,amountYuan:1300000000,
    cashFlowId:'AI-REVIEW-SETTLED'});
  result=simulate();
  assert.equal(result.status,'waiting_conditions');
  model.simulateEvent('cash_available',{instructionId,amountYuan:1300000000,
    cashFlowId:'AI-REVIEW-CREDITED'});
  result=simulate();
  assert.deepEqual(result.inFlightPrerequisites,[]);
  assert.equal(result.status,'feasible');
});
test('financing credited before settlement still requires settlement confirmation', () => {
  const template=createHistoricalComplexTemplate();
  template.draftPlans=[template.draftPlans.find(plan=>plan.businessType==='interbank_repo_financing')];
  const model=createModel(); model.startFromTemplate(template);
  const proposal=model.generateProposal(); model.approveProposal();
  const instructionId=model.send(proposal.proposal.steps[0].stepId).sentInstructionId;
  const nominalYuan=model.getState().execution.instructions[instructionId].nominalYuan;
  model.simulateEvent('accepted',{instructionId});
  model.simulateEvent('fill',{instructionId,nominalYuan});
  model.simulateEvent('cash_available',{instructionId,amountYuan:nominalYuan,
    cashFlowId:'AI-FINANCING-CREDITED-BEFORE-SETTLEMENT'});
  const simulate=()=>simulateDraft(readPlanningSnapshot(model),[],
    {executionSearch:{nodeLimit:2048,candidateBudget:128}});
  let result=simulate();
  assert.equal(result.applicable,true);
  assert.equal(result.status,'waiting_conditions');
  assert.deepEqual(result.inFlightPrerequisites.map(item=>item.kind),['in_flight_settlement']);
  assert.equal(result.inFlightPrerequisites[0].amountYuan,nominalYuan);
  model.simulateEvent('cash_settled',{instructionId,amountYuan:nominalYuan,
    cashFlowId:'AI-FINANCING-SETTLED-AFTER-CREDIT'});
  result=simulate();
  assert.deepEqual(result.inFlightPrerequisites,[]);
});
for (const id of ['S1','S2','S3']) test(`${id}: independent amount expectations, no live mutation`, () => {
  const {model,intent,expected} = makePlanningFixture(id);
  const before = model.serialize();
  const result = preparePlanningDraft(model,intent);
  assert.ok(result.main?.applicable, JSON.stringify(result));
  assert.equal(result.main.financingYuan,expected.financingYuan);
  assert.equal(result.main.reverseRepoYuan,expected.reverseRepoYuan);
  assert.equal(result.main.projectedFinalCashYuan,expected.cashYuan);
  if (expected.termNumeratorYuan) {
    assert.equal(Number(row(result.main,'C09').numeratorYuan),expected.termNumeratorYuan);
    assert.equal(Number(row(result.main,'C09').denominatorYuan),expected.termDenominatorYuan);
  }
  if (id === 'S3') {
    assert.ok(result.alternative?.applicable);
    assert.equal(result.alternative.financingYuan,expected.alternativeFinancingYuan);
    assert.equal(result.alternative.reverseRepoYuan,expected.alternativeReverseRepoYuan);
  }
  assert.equal(model.serialize(),before);
});

test('S4: finance cannot dilute C06; full original target retained', () => {
  const {model,intent} = makePlanningFixture('S4');
  const before = model.serialize();
  const result = preparePlanningDraft(model,intent);
  assert.ok(!result.main?.applicable);
  assert.match(JSON.stringify(result),/C06/);
  assert.equal(intent.fixedPlans[0].targetYuan,5*E);
  assert.equal(model.serialize(),before);
});

test('S5: main financing cap failure, alternative preserves fills and locked portions', () => {
  const {model,intent,expected} = makePlanningFixture('S5');
  const before = JSON.parse(model.serialize());
  const result = preparePlanningDraft(model,intent);
  assert.ok(!result.main?.applicable);
  assert.ok(result.alternative?.applicable,JSON.stringify(result));
  assert.equal(result.alternative.financingYuan,8*E);
  assert.equal(result.alternative.reverseRepoYuan,7*E);
  assert.equal(result.alternative.projectedFinalCashYuan,5*E);
  assert.equal(Number(row(result.alternative,'C09').numeratorYuan),expected.termNumeratorYuan);
  assert.throws(()=>applyConfirmedDraft(model,{draftId:result.alternative.draftId,confirmed:true}),/明确接受/);
  const applied = applyConfirmedDraft(model,{draftId:result.alternative.draftId,confirmed:true,acceptTargetChanges:true});
  assert.equal(applied.status,'applied');
  const after = JSON.parse(model.serialize());
  assert.deepEqual(after.execution.journal,before.execution.journal);
  assert.deepEqual(after.execution.instructions,before.execution.instructions);
  assert.equal(after.plans.find(p=>p.planId===intent.reverseRepo.planId).targetYuan,7*E);
  assert.ok(validateSaved(after).ok);
  assert.notEqual(model.getState().approvalStatus,'valid');
});

test('confirmed draft is atomic, does not dispatch, and is idempotent', () => {
  const {model,intent} = makePlanningFixture('S2');
  const before = model.serialize();
  const result = preparePlanningDraft(model,intent);
  assert.throws(()=>applyConfirmedDraft(model,{draftId:result.main.draftId}),/明确确认/);
  assert.equal(model.serialize(),before);
  result.main.deltas.length = 0; // public copy cannot change the private approved candidate
  assert.equal(applyConfirmedDraft(model,{draftId:result.main.draftId,confirmed:true}).status,'applied');
  const applied = model.serialize();
  assert.equal(model.getState().plans.find(p=>p.businessType==='reverse_repo').targetYuan,8*E);
  assert.equal(Object.keys(model.getState().execution.instructions).length,0);
  assert.equal(applyConfirmedDraft(model,{draftId:result.main.draftId,confirmed:true}).status,'already_applied');
  assert.equal(model.serialize(),applied);
  const restored = createModel(applied);
  assert.throws(()=>applyConfirmedDraft(restored,{draftId:result.main.draftId,confirmed:true}),/重新测算/);
});

test('changed preference makes draft stale without mutation', () => {
  const {model,intent} = makePlanningFixture('S2');
  const result = preparePlanningDraft(model,intent);
  model.setPreferences([...model.getState().preferences.orderedKeys,'reverse_repo_first']);
  const before = model.serialize();
  assert.throws(()=>applyConfirmedDraft(model,{draftId:result.main.draftId,confirmed:true}),/过期/);
  assert.equal(model.serialize(),before);
});

test('intent rejects unknown fields, bad money/IDs/units and invalid reverse term', () => {
  const {model,intent} = makePlanningFixture('S2');
  const snapshot = readPlanningSnapshot(model);
  for (const bad of [
    {...intent,execute:true},
    {...intent,reverseRepo:{...intent.reverseRepo,amountYuan:0.1}},
    {...intent,reverseRepo:{...intent.reverseRepo,planId:'unknown'}},
    {...intent,reverseRepo:{...intent.reverseRepo,unitYuan:13}},
    {...intent,reverseRepo:{amountYuan:null,unitYuan:E,tenorDays:0}},
    {...intent,financing:{...intent.financing,maxAmountYuan:Number.MAX_SAFE_INTEGER+1}},
  ]) assert.equal(validateIntent(snapshot,bad).ok,false);
  assert.equal(validateIntent(snapshot,{...intent,financing:{maxAmountYuan:20*E,unitYuan:E}}).intent.financing.tenorDays,1);
  assert.equal(validateIntent(structuredClone(snapshot),intent).ok,false);
});

test('existing reverse repo defaults to preservation and cannot drop committed quantity', () => {
  const {model,intent} = makePlanningFixture('S5');
  const snapshot = readPlanningSnapshot(model);
  const draft=structuredClone(intent); delete draft.reverseRepo.amountYuan;
  assert.equal(validateIntent(snapshot,draft).intent.reverseRepo.amountYuan,12*E);
  draft.reverseRepo.amountYuan=6*E;
  assert.equal(validateIntent(snapshot,draft).ok,false);
});

test('simulation cannot leave half-applied edits live', () => {
  const {model,intent} = makePlanningFixture('S1');
  const snapshot = readPlanningSnapshot(model),before=model.serialize();
  try { simulateDraft(snapshot,[{kind:'add',plan:intent.fixedPlans[0]},
    {kind:'update',planId:'unknown',patch:{targetYuan:E}}]); } catch { /* structured failure or throw */ }
  assert.equal(model.serialize(),before);
});

test('government bonds count toward C02 while account safety buffer still limits reverse repo', () => {
  for (const buffer of [0,2*E]) {
    const {model,intent} = makePlanningFixture('S2');
    const template=structuredClone(model.getState().initialData);
    const asset=template.securities.find(s=>s.securityId==='AI-NONBANK-BASKET');
    asset.instrumentKind='government_bond'; asset.issuerType='government'; asset.isGovernmentBond=true;
    template.portfolio.bufferYuan=buffer;
    model.startFromTemplate(template);
    intent.reverseRepo.amountYuan=null;
    const result=preparePlanningDraft(model,intent);
    assert.ok(result.main?.applicable,JSON.stringify({status:result.status,limitations:result.limitations}));
    assert.equal(result.main.financingYuan,0);
    assert.equal(result.main.reverseRepoYuan,20*E-buffer);
  }
});

test('bounded search never reports exhausted budget as proof of infeasibility', () => {
  const {model,intent}=makePlanningFixture('S1');
  const result=preparePlanningDraft(model,intent,{evaluationBudget:1});
  assert.equal(result.search.complete,false);
  assert.notEqual(result.status,'blocked');
  assert.ok(!result.main?.applicable);
});

test('legacy manual quota does not limit a financing proposal', () => {
  const {model,intent}=makePlanningFixture('S1');
  const baseline=preparePlanningDraft(model,intent);
  const template=structuredClone(model.getState().initialData);
  template.financingResources.INTERBANK.quotaConfirmedYuan=0;
  model.startFromTemplate(template);
  const result=preparePlanningDraft(model,intent);
  assert.equal(result.status,baseline.status);
  assert.equal(result.main?.status,baseline.main?.status);
  assert.equal(result.main?.financingYuan,baseline.main?.financingYuan);
});

test('a verified improvement remains explicitly breached, never relabelled passed', () => {
  const {model,intent}=makePlanningFixture('S2');
  const template=structuredClone(model.getState().initialData);
  template.securities.find(s=>s.securityId==='AI-NONBANK-BASKET').remainingTradingDays=120;
  template.termWeights.assets.find(w=>w.sourceHoldingId==='AI-H-NB').remainingTradingDays=120;
  model.startFromTemplate(template);
  intent.reverseRepo.amountYuan=0; intent.financing.maxAmountYuan=5*E;
  const result=preparePlanningDraft(model,intent);
  assert.ok(result.main?.applicable,JSON.stringify({status:result.status,main:result.main?.status}));
  assert.equal(result.main.status,'improving');
  assert.equal(row(result.main,'C09').result,'block');
  assert.equal(Number(row(result.main,'C09').numeratorYuan),9600*E);
  assert.equal(Number(row(result.main,'C09').denominatorYuan),105*E);
});

test('existing finance off the search grid is preserved when no increment is needed', () => {
  const {model,intent}=makePlanningFixture('S2');
  model.addPlan({label:'既有融资',businessType:'interbank_repo_financing',direction:'inflow',targetYuan:E/2,
    repoTerms:{market:'INTERBANK',tenorDays:7,annualRate:null}});
  intent.financing.planId=model.getState().plans.at(-1).planId;
  intent.financing.maxAmountYuan=2*E;
  const result=preparePlanningDraft(model,intent);
  assert.ok(result.main?.applicable);
  assert.equal(result.main.financingYuan,E/2);
});

test('confirmed S1/S2/S3 and conditional S5 candidates complete through existing execution gates', () => {
  for (const id of ['S1','S2','S3','S5']) {
    const {model,intent,expected}=makePlanningFixture(id);
    const draft=preparePlanningDraft(model,intent);
    const selected=id==='S5'?draft.alternative:draft.main;
    applyConfirmedDraft(model,{draftId:selected.draftId,confirmed:true,acceptTargetChanges:id==='S5'});
    let flow=0;
    for(let cycle=0;cycle<16;cycle++) {
      for(const i of Object.values(model.getState().execution.instructions)) {
        const left=i.nominalYuan-i.filledYuan-i.cancelledYuan;
        if(['accepted','partial'].includes(i.status)&&left>0)
          model.simulateEvent('fill',{instructionId:i.instructionId,nominalYuan:left});
      }
      for(const i of Object.values(model.getState().execution.instructions).filter(i=>i.direction==='inflow')) {
        const credited=Object.values(model.getState().execution.cashFlows).filter(f=>
          f.type==='cash_available'&&f.instructionId===i.instructionId).reduce((s,f)=>s+f.amountYuan,0);
        if(i.filledYuan>credited) model.simulateEvent('cash_available',{
          instructionId:i.instructionId,amountYuan:i.filledYuan-credited,cashFlowId:`E2-IN-${++flow}`});
      }
      for(const i of Object.values(model.getState().execution.instructions).filter(i=>i.direction==='outflow')) {
        const due=i.filledYuan-i.settledYuan;
        if(due>0&&model.getState().summary.accountCashYuan>=due) model.simulateEvent('cash_settled',{
          instructionId:i.instructionId,amountYuan:due,cashFlowId:`E2-OUT-${++flow}`});
      }
      if(model.getState().summary.planBalances.every(b=>b.remainingYuan===0)) break;
      model.refreshSnapshot(); model.generateProposal();
      if(model.getState().canApprove) {
        model.approveProposal();
        const ready=model.getState().stepReadiness.find(r=>r.ready);
        if(ready) model.sendBatch([ready.stepId]);
      }
    }
    const final=model.getState();
    assert.ok(final.summary.planBalances.every(b=>b.remainingYuan===0),`${id}: outstanding target`);
    assert.equal(final.summary.accountCashYuan,expected.cashYuan,id);
    assert.ok(final.coreRules.rows.every(r=>!['block','missing'].includes(r.result)),id);
    assert.ok(validateSaved(model.serialize()).ok);
  }
});

test('final government-bond sale removes eligibility from C02', () => {
  const {model,intent}=makePlanningFixture('S2');
  const t=structuredClone(model.getState().initialData);
  const asset=t.securities.find(s=>s.securityId==='AI-NONBANK-BASKET');
  asset.instrumentKind='government_bond';asset.issuerType='government';asset.isGovernmentBond=true;
  t.holdings[0].sellableYuan=t.holdings[0].amountYuan;
  model.startFromTemplate(t);
  intent.fixedPlans=[{label:'卖出政府债',businessType:'bond_sell',direction:'inflow',
    targetYuan:80*E,securityId:asset.securityId,issuerId:null}];
  intent.reverseRepo.amountYuan=null;
  const result=preparePlanningDraft(model,intent);
  assert.ok(result.main?.applicable,JSON.stringify({status:result.status,main:result.main?.status}));
  assert.equal(result.main.financingYuan,0);
  assert.equal(result.main.reverseRepoYuan,95*E);
  assert.equal(result.main.projectedFinalCashYuan,5*E);
  assert.equal(Number(row(result.main,'C02').numeratorYuan),5*E);
});

test('government-bond purchase counts only in a settlement-conditional final projection', () => {
  const {model,intent}=makePlanningFixture('S2');
  const t=structuredClone(model.getState().initialData);
  t.securities.push({securityId:'NEW-GOV',label:'合成政府债',instrumentKind:'government_bond',
    issuerBankId:null,issuerType:'government',isGovernmentBond:true,remainingTradingDays:30});
  model.startFromTemplate(t);
  intent.fixedPlans=[{label:'买入政府债',businessType:'bond_buy',direction:'outflow',
    targetYuan:10*E,securityId:'NEW-GOV',issuerId:null}];
  intent.reverseRepo.amountYuan=null;
  const result=preparePlanningDraft(model,intent);
  assert.ok(result.main?.applicable,JSON.stringify({status:result.status,main:result.main?.status}));
  assert.equal(result.main.financingYuan,0);
  assert.equal(result.main.reverseRepoYuan,10*E);
  assert.equal(Number(row(result.main,'C02').numeratorYuan),10*E);
  assert.ok(result.main.executionPath.some(s=>s.kind==='government_purchase_settlement' || s.kind==='government_settlement'));
  assert.equal(model.getState().summary.accountCashYuan,20*E);
});


test('new repo intent defaults to funding one day and lending seven days; explicit and existing terms survive', () => {
  const {model,intent} = makePlanningFixture('S2');
  const snapshot = readPlanningSnapshot(model);
  const input = structuredClone(intent);
  delete input.financing.tenorDays;
  delete input.reverseRepo.tenorDays;
  const checked = validateIntent(snapshot,input);
  assert.equal(checked.ok,true);
  assert.equal(checked.intent.financing.tenorDays,1);
  assert.equal(checked.intent.reverseRepo.tenorDays,7);
  input.financing.tenorDays = 14;
  input.reverseRepo.tenorDays = 1;
  const explicit = validateIntent(snapshot,input);
  assert.equal(explicit.intent.financing.tenorDays,14);
  assert.equal(explicit.intent.reverseRepo.tenorDays,1);
  const existing = makePlanningFixture('S5');
  delete existing.intent.financing.tenorDays;
  delete existing.intent.reverseRepo.tenorDays;
  const preserved = validateIntent(readPlanningSnapshot(existing.model),existing.intent);
  assert.equal(preserved.ok,true);
  assert.equal(preserved.intent.financing.tenorDays,7);
  assert.equal(preserved.intent.reverseRepo.tenorDays,7);
});


test('generated repo labels follow actual default and explicit tenors', () => {
  const {model,intent} = makePlanningFixture('S1');
  for (const days of [1,7,14]) {
    const next=structuredClone(intent); next.financing.tenorDays=days;
    const result=preparePlanningDraft(model,next);
    const plan=result.main.deltas.find(d=>d.plan?.businessType==='interbank_repo_financing').plan;
    assert.equal(plan.repoTerms.tenorDays,days);
    assert.equal(plan.label,automaticInstructionLabel(plan,model.getState().initialData));
    assert.doesNotMatch(plan.label,/AI建议|AI拟单/);
    for (const step of result.main.executionPath) {
      const expectedPlan=result.main.appliedSaved.plans.find(plan=>plan.planId===step.planId);
      assert.equal(step.planLabel,expectedPlan.label);
      assert.equal(step.businessType,expectedPlan.businessType);
    }
  }
});


