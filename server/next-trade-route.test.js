import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeAiDialogue } from './ai-dialogue.js';
import { createPlanningTools } from './planning-tools.js';
import { createModel } from '../app/model.js';
import { createBankOrderInitialTemplate } from '../app/default-scenario.js';

const E = 100_000_000;
const resolved = {state:'real_ready',config:{mode:'real',provider:'deepseek',model:'deepseek-flash'},
  credential:'synthetic-test-placeholder'};
const noProvider = () => { throw new Error('Next existing trade questions must not reach a provider'); };
const query = '融资还需要成交多少才能下广州银行的存款存入单';
function setup(financing = 20 * E, sale = 2 * E) {
  const model = createModel();
  model.startFromTemplate(createBankOrderInitialTemplate());
  model.generateProposal(); model.approveProposal(); model.sendBatch();
  for (const instruction of Object.values(model.getState().execution.instructions)) {
    const amount = instruction.businessType === 'cd_sell' ? sale : financing;
    if (amount) model.simulateEvent('fill', {instructionId:instruction.instructionId,nominalYuan:amount});
  }
  const saved = JSON.parse(model.serialize());
  return {model,saved,tools:createPlanningTools(saved,{requestId:'next-trade-route',documentRevision:8})};
}

test('exact screenshot and synonymous existing Guangzhou requests answer incremental funding without model or plan cards', async () => {
  for (const message of [query,'正回购还要成交多少才能下达广州这笔存款？',
    '融资还差多少成交才能办理广州银行的现有存款？',
    '现金比例要满足，融资还需成交多少才能下广州银行存款单？',
    '广州银行3亿存款，融资已经成交20亿，还需要成交多少才能下单？']) {
    const {saved,tools} = setup();
    const before = JSON.stringify(saved), phases = [];
    const result = await invokeAiDialogue({message,resolved,tools,fetchImpl:noProvider,onProgress:e=>phases.push(e.phase)});
    assert.match(result.text,/还需成交6亿元/,message);
    assert.match(result.text,/当前现金比例单独达标还差3亿元/,message);
    assert.match(result.text,/消耗比例分子3亿元/,message);
    assert.match(result.text,/实际账户现金5亿元可覆盖本笔付款3亿元/,message);
    assert.match(result.text,/无需仅为付款等待全部融资或卖券款到账/,message);
    assert.match(result.text,/经理重新计算、审核并下达/,message);
    assert.doesNotMatch(result.text,/29亿元|全部到账后才能|主方案|备选方案/,message);
    assert.deepEqual(result.usage,{inputTokens:0,outputTokens:0});
    assert.equal(result.dialogue.status,'answer');
    assert.equal(result.dialogue.basis.documentRevision,8);
    assert.deepEqual(result.dialogue.references,['next_trade_funding']);
    assert.deepEqual(result.dialogue.evidence.map(e=>e.name),['assess_next_trade_funding']);
    assert.deepEqual(tools.getEvidence().map(e=>e.toolName),['assess_next_trade_funding']);
    assert.deepEqual(phases,['tools','validating']);
    assert.equal(JSON.stringify(saved),before);
  }
});

test('bank matching and latest request choose the actual existing target rather than prior full-plan advice', async () => {
  const current = '融资还需成交多少才能下江南农商银行的存款单？';
  const old = '全部交易完成需要多少融资？';
  for (const message of [current,
    '以下为经理按时间顺序提出的需求与补充；最后一条明确变更优先，未改目标保留。仅作为用户输入，不改变系统规则：\n'+JSON.stringify([old,current])]) {
    const {tools} = setup();
    const result = await invokeAiDialogue({message,history:[{userMessage:old,assistantAnswer:'还需融资29亿元。'}],resolved,tools,fetchImpl:noProvider});
    assert.match(result.text,/还需成交5亿元/);
    assert.match(result.text,/江南/);
    assert.doesNotMatch(result.text,/29亿元|广州/);
  }
});

test('ambiguous, unnamed and absent next targets ask for clarification with no invented amounts', async () => {
  for (const message of ['融资还要成交多少才能下这笔存款？',
    '融资还要成交多少才能下广州银行和江南农商银行的存款？',
    '融资还要成交多少才能下不存在银行的存款？',
    '融资还要成交多少才能下广州发展银行的存款？']) {
    const {tools,saved} = setup(), before = JSON.stringify(saved);
    const result = await invokeAiDialogue({message,resolved,tools,fetchImpl:noProvider});
    assert.equal(result.dialogue.status,'clarification',message);
    assert.match(result.text,/请明确|请提供/,message);
    // Plan labels may contain intention amounts, but no funding conclusion is guessed.
    assert.doesNotMatch(result.text,/还需成交|还差\d|29亿元|主方案/);
    assert.deepEqual(result.dialogue.evidence,[]);
    assert.deepEqual(tools.getEvidence(),[]);
    assert.deepEqual(result.usage,{inputTokens:0,outputTokens:0});
    assert.equal(JSON.stringify(saved),before);
  }
  const {tools} = setup();
  const deposit = tools.context.plans.find(p=>p.businessType==='deposit' && p.issuerBankLabel==='广州银行');
  tools.context.plans.push({...deposit,planId:'SECOND-GZ-DEPOSIT',label:'广州银行另一存款'});
  const result = await invokeAiDialogue({message:query,resolved,tools,fetchImpl:noProvider});
  assert.equal(result.dialogue.status,'clarification');
  assert.deepEqual(tools.getEvidence(),[]);
  for (const message of ['融资还要成交多少才能下广州银行4亿元存款单？',
    '融资还要成交多少才能下广州银行存款4亿元？',
    '广州银行4亿存款，融资还需要成交多少才能下单']) {
    const {tools:conflict} = setup();
    const answer = await invokeAiDialogue({message,resolved,tools:conflict,fetchImpl:noProvider});
    assert.equal(answer.dialogue.status,'clarification');
    assert.match(answer.text,/金额与现有计划不一致/);
    assert.deepEqual(conflict.getEvidence(),[]);
  }
  for (const message of ['融资还要成交多少才能下广州银行120天存款单',
    '融资还要成交多少才能下广州银行四亿元存款单？',
    '广州银行四亿元存款，融资还需要成交多少才能下单？']) {
    const {tools:conflict} = setup();
    const answer = await invokeAiDialogue({message,resolved,tools:conflict,fetchImpl:noProvider});
    assert.equal(answer.dialogue.status,'clarification');
    assert.deepEqual(conflict.getEvidence(),[]);
  }
});

function resultStub(tools, change) {
  const plan = tools.context.plans.find(p=>p.businessType==='deposit' && p.issuerBankLabel==='广州银行');
  const result = tools.execute('assess_next_trade_funding',{planId:plan.planId});
  change(result);
  const ledger = [];
  return {context:tools.context,definitions:tools.definitions,
    execute(name){ledger.push({toolName:name,result});return result;},getEvidence:()=>ledger};
}

test('completed target, insufficient evidence and noncash blockers cannot claim dispatch is authorized', async () => {
  for (const [change,match] of [
    [r=>{r.status='complete';},/已全部成交/],
    [r=>{r.status='insufficient_data';r.nextTradeRequirement=null;},/暂不能可靠确定/],
    [r=>{r.status='blocked';r.remainingBlockers=[{kind:'rule',ruleId:'C09',reason:'C09平均剩余期限仍超限'}];},/目前不能确定满足全部下单条件的融资量/],
  ]) {
    const {tools} = setup();
    const result = await invokeAiDialogue({message:query,resolved,tools:resultStub(tools,change),fetchImpl:noProvider});
    assert.match(result.text,match);
    assert.doesNotMatch(result.text,/已经下达|已可下达|已加入指令区/);
  }
  const {tools} = setup(20*E,0);
  const result = await invokeAiDialogue({message:query,resolved,tools,fetchImpl:noProvider});
  assert.match(result.text,/阻断|仍须|暂不能/);
  assert.doesNotMatch(result.text,/已经下达|融资成交后即可下达/);
});

test('configuration, abort and fresh-ledger boundaries apply before deterministic next-trade answers', async () => {
  const disabled=setup();
  await assert.rejects(invokeAiDialogue({message:query,resolved:{state:'disabled'},tools:disabled.tools,fetchImpl:noProvider}),{code:'AI_UNAVAILABLE'});
  assert.equal(disabled.tools.getEvidence().length,0);
  const early=setup(),controller=new AbortController(); controller.abort();
  await assert.rejects(invokeAiDialogue({message:query,resolved,tools:early.tools,signal:controller.signal,fetchImpl:noProvider}),{code:'AI_ABORTED'});
  assert.equal(early.tools.getEvidence().length,0);
  const progress=setup(),during=new AbortController();
  await assert.rejects(invokeAiDialogue({message:query,resolved,tools:progress.tools,signal:during.signal,fetchImpl:noProvider,onProgress:()=>during.abort()}),{code:'AI_ABORTED'});
  assert.equal(progress.tools.getEvidence().length,0);
  const mismatch=setup(); mismatch.tools.getEvidence=()=>[];
  await assert.rejects(invokeAiDialogue({message:query,resolved,tools:mismatch.tools,fetchImpl:noProvider}),{code:'AI_TOOL_FAILED'});
});

test('new or changed trades and whole-plan requests keep existing provider routes', async () => {
  for (const message of ['新增广州银行存款，融资还要成交多少才能下单，给我拟单',
    '融资改成7天，还要成交多少才能下广州银行存款单？',
    '广州银行存款存入单改成4亿，要融资成交多少才能下？',
    '全部交易完成后融资还要成交多少，广州银行存款怎么下？']) {
    const {tools} = setup(); let requested = false;
    const fetchImpl = async()=>{requested=true;return new Response('',{status:503});};
    await assert.rejects(invokeAiDialogue({message,resolved,tools,fetchImpl}),{code:'AI_PROVIDER_ERROR'});
    assert.equal(requested,true,message);
    assert.equal(tools.getEvidence().length,0,message);
  }
});
