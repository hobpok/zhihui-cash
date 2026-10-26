import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel,deriveAdvancementGroups} from './model.js';
import {baseTemplate,createScenarios,plan,YI} from '../scripts/robustness-scenarios.mjs';

const start = template => {const m=createModel();m.startFromTemplate(template);return m;};
const rows = groups => Object.values(groups).flat();

test('uncalculated plans remain pending; custom unselected plans are explicitly excluded from that batch',()=>{
  const t=baseTemplate({id:'CLASSIFY-CUSTOM',cash:10,gov:5});
  t.draftPlans=[plan('甲逆回购','reverse_repo',2),plan('乙逆回购','reverse_repo',2)];
  const m=start(t);
  assert.equal(m.getAdvancementGroups().pending.length,2);
  const [a,b]=m.getState().plans;
  m.recalculateDispatchBatch([{planId:a.planId,nominalYuan:2*YI}]);
  const pending=m.getAdvancementGroups().pending;
  assert.deepEqual(pending.map(x=>x.planId),[b.planId]);
  assert.match(pending[0].reason,/未纳入本次自定义批次/);
});

test('partial automatic suggestion exposes the unscheduled remainder without duplicating the arranged amount',()=>{
  const m=start(structuredClone(createScenarios().find(x=>x.id==='R06').template));
  const s=m.generateProposal(),before=m.serialize(),g=m.getAdvancementGroups();
  const remainder=g.restricted.filter(x=>x.status==='calculated_unarranged');
  assert.equal(remainder.length,1);
  assert.equal(remainder[0].nominalYuan,6*YI);
  assert.match(remainder[0].reason,/本次未安排余量6亿/);
  assert.equal(g.pending.length,0);
  assert.equal(rows(g).reduce((n,x)=>n+x.nominalYuan,0),7*YI);
  assert.equal(s.proposal.planCoverage[0].unarrangedYuan,6*YI);
  assert.equal(m.serialize(),before);
});

test('a fully blocked atomic deposit is represented once, with its actual rule reason',()=>{
  const t=baseTemplate({id:'CLASSIFY-DEPOSIT',cash:1,gov:5});
  t.draftPlans=[plan('整笔存款2亿','deposit',2,'DEP-B')];
  const m=start(t);m.generateProposal();
  const g=m.getAdvancementGroups();
  assert.equal(g.pending.length,0);
  assert.equal(rows(g).length,1);
  assert.equal(g.restricted[0].nominalYuan,2*YI);
  assert.match(g.restricted[0].reason,/现金|头寸|资金/);
});

test('an automatic calculation budget boundary is not presented as a plan that was never considered',()=>{
  const t=baseTemplate({id:'CLASSIFY-UNIT',cash:10,gov:5});
  t.draftPlans=[{...plan('单位不整的买券','bond_buy',2,'SHORT'),targetYuan:2*YI+1}];
  const m=start(t);m.generateProposal();
  const g=m.getAdvancementGroups();
  assert.equal(g.pending.length,0);
  assert.equal(g.restricted[0].status,'calculated_unarranged');
  assert.match(g.restricted[0].reason,/单位/);
  m.updatePlan(m.getState().plans[0].planId,{targetYuan:2*YI});
  assert.equal(m.getAdvancementGroups().pending[0].status,'awaiting_calculation');
});

test('old calculated snapshots without per-plan exclusion reasons remain readable and do not invent a rule violation',()=>{
  const m=start(structuredClone(createScenarios().find(x=>x.id==='R06').template));
  const s=m.generateProposal();
  delete s.calculation.trace.search.excludedActions;
  s.proposal.blockers=[];
  const before=structuredClone(s),g=deriveAdvancementGroups(s);
  assert.match(g.restricted.find(x=>x.status==='calculated_unarranged').reason,/未证明不可执行/);
  assert.deepEqual(s,before);
});

test('sent or filled portions are not subtracted a second time from the unscheduled current remainder',()=>{
  const m=start(structuredClone(createScenarios().find(x=>x.id==='R06').template));
  const s=m.generateProposal();m.approveProposal();
  const id=m.send(s.proposal.steps[0].stepId).sentInstructionId;
  assert.equal(m.getState().summary.planBalances[0].arrangeableYuan,6*YI);
  assert.equal(m.getAdvancementGroups().restricted.find(x=>x.status==='calculated_unarranged').nominalYuan,6*YI);
  m.simulateEvent('accepted',{instructionId:id});
  m.simulateEvent('fill',{instructionId:id,nominalYuan:YI});
  assert.equal(m.getAdvancementGroups().restricted.find(x=>x.status==='calculated_unarranged').nominalYuan,6*YI);
});
