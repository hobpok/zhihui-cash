import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeAiDialogue} from './ai-dialogue.js';
import {createPlanningTools} from './planning-tools.js';
import {createModel} from '../app/model.js';
import {createBankOrderInitialTemplate} from '../app/default-scenario.js';

const E=100_000_000;
const resolved={state:'real_ready',config:{mode:'real',provider:'deepseek',model:'deepseek-flash'},
  credential:'synthetic-language-test'};
function savedFixture(change=()=>{}) {
  const template=createBankOrderInitialTemplate({businessDate:'2026-10-25'});
  change(template);
  const model=createModel();model.startFromTemplate(template);
  model.generateProposal();model.approveProposal();model.sendBatch();
  for(const instruction of Object.values(model.getState().execution.instructions))
    model.simulateEvent('fill',{instructionId:instruction.instructionId,
      nominalYuan:instruction.businessType==='cd_sell'?2*E:17*E});
  return JSON.parse(model.serialize());
}
// Independent from the screenshot's 20yi financing: 17+2=19, current gap6,
// Guangzhou3yi requires9 and Jiangnan2yi requires8. Expected values are manual.
const baseline=savedFixture();
let serial=0;
async function ask(message,{saved=baseline,contextChange}={}) {
  const original=JSON.stringify(saved);
  const tools=createPlanningTools(structuredClone(saved),{requestId:`language-${++serial}`,documentRevision:2});
  contextChange?.(tools.context);
  let providerCalls=0;
  const result=await invokeAiDialogue({message,resolved,tools,fetchImpl:async()=>{
    providerCalls++;throw Error('real provider forbidden');
  }});
  assert.equal(providerCalls,0,message);
  assert.equal(JSON.stringify(saved),original,message);
  return result;
}
async function expectNext(message,amount=9*E,options) {
  const result=await ask(message,options);
  assert.equal(result.dialogue.status,'answer',message);
  assert.deepEqual(result.dialogue.evidence.map(item=>item.name),['assess_next_trade_funding'],message);
  assert.equal(result.dialogue.evidence[0].result.nextTradeRequirement.additionalFinancingFillYuan,amount,message);
  assert.equal(result.dialogue.evidence[0].result.currentCashRequirement.additionalFinancingFillYuan,6*E,message);
  assert.match(result.text,/经理重新计算、审核并下达/,message);
  return result;
}

test('negative whole-plan premises stay current-only across clause order and punctuation',async()=>{
  for(const message of [
    '不是要把所有交易都执行完成，只问当前C02达标还差多少融资成交？',
    '当前C02达标还需融资成交多少？不要假设所有交易都已完成。',
    '不看全部计划，只看当前C02：融资还差多少成交才能达标？',
    '当前现金比例达标，融资还需成交多少；不要求所有交易都完成。',
    '不要模拟全部计划完成，融资再成交多少能使当前现金比例达标？',
  ]) {
    const result=await ask(message);
    assert.deepEqual(result.dialogue.evidence.map(item=>item.name),['read_metrics'],message);
    assert.equal(result.dialogue.evidence[0].result.currentCashRequirement.additionalFinancingFillYuan,6*E,message);
  }
});

test('financing facts bind to financing before or after the placement question',async()=>{
  for(const message of [
    '融资还需成交多少才能下广州银行的存款？目前融资已成交17亿元。',
    '融资还需成交多少才能下广州银行的存款？已有融资期限1天，存款不变。',
    '融资已成交17亿元，期限1天；广州银行3亿元90天存款还需要融资成交多少才能下单？',
    '广州银行3亿元90天存款需要融资再成交多少才能下达？已有融资期限1天、已成交17亿元。',
    '已有融资期限1天、已成交17亿元。融资还需成交多少才能下广州银行存款单？',
    '融资已成交17亿元还需成交多少才能下广州银行3亿元90天存款单？',
    // Oral figures remain context; the current ledger is the amount authority.
    '融资还需成交多少才能下广州银行的存款？目前融资已成交20亿元。',
  ]) await expectNext(message);
});

test('not-only current and next asks cite one fresh next-trade assessment covering both',async()=>{
  for(const message of [
    '我不只问当前现金比例达标还差多少融资成交，还要知道能否下广州银行存款单。',
    '我不仅问当前C02达标融资还差多少成交，也要知道能不能下广州银行存款单。',
    '我不是只问当前现金比例达标融资还差多少成交，还要知道能否下广州银行存款单。',
    '融资还需成交多少才能下广州银行的存款单？同时当前现金比例达标还差多少？',
    '不要求所有交易完成，融资还需成交多少才能下广州银行存款单？',
  ]) {
    const result=await expectNext(message);
    assert.match(result.text,/当前现金比例单独达标还差6亿元/,message);
    assert.match(result.text,/还需成交9亿元/,message);
  }
});

test('excluded banks do not compete with the requested bank in either clause order',async()=>{
  for(const message of [
    '不是广州银行，我问融资还需要成交多少才能下江南农商银行这笔存款？',
    '融资还需成交多少才能下江南农商银行的存款单，不是广州银行的那笔？',
    '融资还需成交多少才能下存款单？不是广州银行的那笔。',
    '不要广州银行的那笔，融资还需成交多少才能下江南的存款单？',
  ]) await expectNext(message,8*E);
  const both=await ask('融资还需成交多少才能下广州银行和江南农商银行的存款单？');
  assert.equal(both.dialogue.status,'clarification');assert.deepEqual(both.dialogue.evidence,[]);
});

test('negative change instructions preserve existing-target scope and bank identity',async()=>{
  for(const message of [
    '不要修改任何金额和期限，仅问融资还需成交多少才能下广州银行3亿元90天存款。',
    '不要修改广州银行的存款，融资还需成交多少才能下广州银行3亿元90天存款？',
    '融资不改，存款不变，融资还需成交多少才能下广州银行的存款单？',
  ]) await expectNext(message);
});

test('explicit target amounts and tenors retain conflict and ambiguity protection',async()=>{
  for(const message of [
    '融资还需成交多少才能下广州银行4亿元存款单？',
    '融资还需成交多少才能下广州银行存款4亿元？',
    '融资还需成交多少才能下广州银行3亿元120天存款单？',
    '融资还需成交多少才能下广州银行四亿元存款单？',
    '融资还需成交多少才能下广州银行存款？计划金额不是3亿而是4亿。',
    '融资还需成交多少才能下广州银行存款？期限不是90天而是120天。',
    '融资还需成交多少才能下广州银行存款？融资已成交17亿，存款金额不是3亿而是4亿。',
    '融资还需成交多少才能下广州银行存款？融资期限1天，存款期限不是90天而是120天。',
    '融资还需成交多少才能下广州银行存款？账户现金5亿，存款金额不是3亿而是4亿。',
    '融资还需成交多少才能下广州银行存款？融资已成交17亿，计划金额不是3亿而是4亿。',
    '融资还需成交多少才能下广州银行存款？金额4亿元。',
  ]) {
    const result=await ask(message);
    assert.equal(result.dialogue.status,'clarification',message);
    assert.deepEqual(result.dialogue.evidence,[],message);
  }
});

test('a correction uses only the asserted value, never the rejected amount or tenor',async()=>{
  await expectNext('融资还需成交多少才能下广州银行存款？融资已成交17亿，存款金额不是4亿而是3亿。');
  await expectNext('融资还需成交多少才能下广州银行存款？融资期限1天，存款期限不是120天而是90天。');
});

test('new trades and positive changes cannot enter existing-target assessment',async()=>{
  for(const message of [
    '新增广州银行3亿存款，融资还需成交多少才能下单？',
    '广州银行存款改成4亿元，融资还需成交多少才能下单？',
    '广州银行存款改4亿元，融资还需成交多少才能下单？',
    '融资改3天，融资还需成交多少才能下广州银行存款单？',
    '广州银行存款期限改120天，融资还需成交多少才能下单？',
    '不要修改已有计划，但新增广州银行存款，融资还需成交多少才能下单？',
    '新增广州银行存款不需要逆回购，融资还需成交多少才能下单？',
    '不要新增逆回购但新增广州银行存款，融资还需成交多少才能下单？',
  ]) {
    const tools=createPlanningTools(structuredClone(baseline),{requestId:`planning-${++serial}`,documentRevision:2});
    let calls=0;
    await assert.rejects(invokeAiDialogue({message,resolved,tools,fetchImpl:async(_url,options)=>{
      calls++;assert.equal(JSON.parse(options.body).tool_choice.function.name,'plan_trades',message);
      return new Response('',{status:503});
    }}),{code:'AI_PROVIDER_ERROR'},message);
    assert.equal(calls,1,message);assert.deepEqual(tools.getEvidence(),[],message);
  }
});

test('literal bank labels and aliases containing regular-expression characters are data',async()=>{
  for(const label of ['测试(银行','A.*银行']) {
    const saved=savedFixture(template=>{
      template.banks.find(bank=>bank.bankId==='SIM-BANK-GZ').label=label;
    });
    await expectNext(`融资还需成交多少才能下${label}的存款单？`,9*E,{saved});
  }
  const saved=savedFixture(template=>{
    template.banks.find(bank=>bank.bankId==='SIM-BANK-GZ').label='A.*银行';
  });
  const absent=await ask('融资还需成交多少才能下Axyz银行的存款单？',{saved});
  assert.equal(absent.dialogue.status,'clarification');assert.deepEqual(absent.dialogue.evidence,[]);
});

test('a different deposit amount recomputes from the current ledger rather than a memorized answer',async()=>{
  const saved=savedFixture(template=>{
    const plan=template.draftPlans.find(plan=>plan.businessType==='deposit'&&plan.securityId==='SIM-JNRCB-DEP-NEW');
    plan.targetYuan=1.5*E;plan.label='江南农商银行存款1.5亿90天';
  });
  await expectNext('已有融资17亿元1天；融资还需成交多少才能下江南农商银行1.5亿元90天存款？',7.5*E,{saved});
});
