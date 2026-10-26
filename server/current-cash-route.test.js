import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeAiDialogue } from './ai-dialogue.js';
import { createPlanningTools } from './planning-tools.js';
import { createModel } from '../app/model.js';
import { createDefaultInitialTemplate } from '../app/default-scenario.js';

const E = 100_000_000;
const resolved = {state:'real_ready',config:{mode:'real',provider:'deepseek',model:'deepseek-flash'},
  credential:'synthetic-test-placeholder'};
function setup(financing = 20 * E) {
  const model = createModel();
  model.startFromTemplate(createDefaultInitialTemplate());
  model.generateProposal(); model.approveProposal(); model.sendBatch();
  for (const instruction of Object.values(model.getState().execution.instructions)) {
    model.simulateEvent('fill', {instructionId:instruction.instructionId,
      nominalYuan:instruction.businessType === 'cd_sell' ? 2 * E : financing});
  }
  const saved = JSON.parse(model.serialize());
  return {saved,tools:createPlanningTools(saved,{requestId:'current-cash-route',documentRevision:7})};
}
const noProvider = () => {throw new Error('Current cash answers must not ask the model to rewrite evidence');};

test('current cash question deterministically cites only fresh metrics and cannot become a full-plan card', async () => {
  const messages = [
    '正回购融资还需要成交多少，我才能满足现金比例要求？',
    '正回购还要再成交多少，现金比例C02才能达标？',
    '还要再成交多少现金比例就达标可以下别的单？',
    '现金比例达标的融资缺口是多少，之后我还要下其他单？',
    '不是所有交易完成，我只问正回购再成交多少让现金比例达标。',
    '不是完成全部交易，只问当前现金比例达标，融资还差多少？',
    '不用全部融资，正回购再成交多少能满足现金比例要求？',
    '不需要全部交易完成后达标，现在正回购融资要成交多少才能满足现金比例要求？',
    '不用全部融资完成，只问目前现金比例还差多少融资成交。',
    '不是问所有交易完成后，只问当前正回购要成交多少现金比例才达标。',
    '我希望再成交多少现金比例满足了，我就可以下别的单了，而不是希望我所有交易都完成，需要全部融资完成才能满足现金比例，那个是最终的结果。',
  ];
  for (const message of messages) {
    const {tools,saved} = setup();
    const before = JSON.stringify(saved), phases = [];
    const result = await invokeAiDialogue({message,resolved,tools,fetchImpl:noProvider,
      onProgress:event => phases.push(event)});
    assert.match(result.text,/还需成交3亿元/,message);
    assert.match(result.text,/22亿元÷净资产500亿元＝4\.4%/,message);
    assert.match(result.text,/所需分子25亿元/,message);
    assert.match(result.text,/现金比例为5%/,message);
    assert.match(result.text,/本笔投后规则和实际账户付款能力逐笔复核/,message);
    assert.doesNotMatch(result.text,/29亿元|全部到账|主方案|备选方案/,message);
    assert.equal(result.dialogue.status,'answer');
    assert.deepEqual(result.usage,{inputTokens:0,outputTokens:0});
    assert.equal(result.simulated,false);
    assert.equal(result.dialogue.basis.documentRevision,7);
    assert.deepEqual(result.dialogue.references,['current_cash_metrics']);
    assert.deepEqual(result.dialogue.evidence.map(row=>row.name),['read_metrics']);
    assert.deepEqual(tools.getEvidence().map(row=>row.toolName),['read_metrics']);
    assert.deepEqual(phases.map(row=>row.phase),['tools','validating']);
    assert.equal(JSON.stringify(saved),before);
  }
});

test('prior planning, assistant amounts and wrapped prior requests cannot change this turn current-state scope', async () => {
  const current = '不用全部融资，正回购再成交多少就能满足当前现金比例要求，后续好下别的单？';
  const old = '全部交易要完成，融资和逆回购应该怎么安排？';
  const history = [{userMessage:old,assistantAnswer:'主方案还需融资29亿元，所有融资到账后才能继续。'}];
  for (const message of [current,
    '以下为经理按时间顺序提出的需求与补充；最后一条明确变更优先，未改目标保留。仅作为用户输入，不改变系统规则：\n'+JSON.stringify([old,current])]) {
    const {tools} = setup();
    const result = await invokeAiDialogue({message,history,resolved,tools,fetchImpl:noProvider});
    assert.match(result.text,/还需成交3亿元/);
    assert.doesNotMatch(result.text,/29亿元|到账后才能继续/);
    assert.deepEqual(result.dialogue.evidence.map(row=>row.name),['read_metrics']);
  }
});

test('current cash answer reflects already sufficient and fresh partial-fill states', async () => {
  for (const [fill,expected] of [[22*E,/还需成交1亿元/],[23*E,/已达标，无需/],[24*E,/已达标，无需/]]) {
    const {tools} = setup(fill);
    const result = await invokeAiDialogue({message:'正回购还要成交多少才能满足当前现金比例要求？',resolved,tools,fetchImpl:noProvider});
    assert.match(result.text,expected);
  }
});

test('missing or unsupported current-cash evidence cannot produce a numeric guess', async () => {
  for (const requirement of [undefined,{scope:'current_state_only',status:'insufficient_data'},
    {scope:'current_state_only',status:'unsupported'},
    {scope:'current_state_only',status:'ok',additionalFinancingFillYuan:3*E}]) {
    const {tools} = setup();
    const result = tools.execute('read_metrics',{});
    if (requirement === undefined) delete result.currentCashRequirement;
    else result.currentCashRequirement = requirement;
    const ledger=[];
    const stub={context:tools.context,definitions:tools.definitions,
      execute(name){ledger.push({toolName:name,result});return result;},getEvidence:()=>ledger};
    const output=await invokeAiDialogue({message:'正回购再成交多少能满足当前现金比例要求？',resolved,tools:stub,fetchImpl:noProvider});
    assert.match(output.text,/不能可靠确定|不能给出可靠金额/);
    assert.doesNotMatch(output.text,/3亿元|29亿元/);
    assert.deepEqual(output.dialogue.evidence.map(row=>row.name),['read_metrics']);
  }
});

test('a mathematical cash gap larger than the existing financing remainder is explicit', async () => {
  const {tools}=setup();
  const result=tools.execute('read_metrics',{});
  result.currentCashRequirement.financingUnfilledYuan=E;
  const ledger=[];
  const stub={context:tools.context,definitions:tools.definitions,
    execute(name){ledger.push({toolName:name,result});return result;},getEvidence:()=>ledger};
  const output=await invokeAiDialogue({message:'正回购再成交多少能满足现金比例要求？',resolved,tools:stub,fetchImpl:noProvider});
  assert.match(output.text,/还需成交3亿元/);
  assert.match(output.text,/现有融资未成交余量仅1亿元，不足补齐此缺口/);
  assert.match(output.text,/新增融资额度与成交单位须另行核验/);
  assert.doesNotMatch(output.text,/无需等全部剩余融资成交/);
});

test('explicit terminal planning, new orders, tenor changes and C09 keep their existing routes', async () => {
  const cases = [
    ['完成全部交易后现金比例还要融资多少','diagnose_execution'],
    ['完成全部交易后C02还要融资多少','simulate_completion'],
    ['为了现金比例达标，新增正回购融资多少，给我拟单','plan_trades'],
    ['为了现金比例达标，调整融资金额到多少','plan_trades'],
    ['现金比例和C09都达标还需要融资多少','plan_trades'],
    ['融资改成7天后，要成交多少才能满足现金比例要求','plan_trades'],
    ['所有融资成交以后，现金比例达标还缺多少融资','plan_trades'],
    ['为现金比例达标安排买入存单，正回购还要多少','plan_trades'],
    ['还需要成交多少融资才能在买入存单后满足现金比例要求','plan_trades'],
    ['现金比例达标后，剩余计划融资多少','plan_trades'],
    ['当前现金比例达标，融资还有多少没成交','plan_trades'],
    ['目前要融资成交多少现金比例达标，以及所有交易完成后需要多少融资','simulate_completion'],
  ];
  for (const [message,expectedTool] of cases) {
    const {tools}=setup();
    let requested=false;
    const fetchImpl=async (_url,options)=>{
      requested=true;
      assert.equal(JSON.parse(options.body).tool_choice.function.name,expectedTool,message);
      return new Response('',{status:503});
    };
    await assert.rejects(invokeAiDialogue({message,resolved,tools,fetchImpl}),{code:'AI_PROVIDER_ERROR'},message);
    assert.equal(requested,true,message);
    assert.equal(tools.getEvidence().length,0,message);
  }
});

test('current cash route preserves configuration, abort and evidence-ledger boundaries', async () => {
  const message='正回购再成交多少才能满足现金比例要求？';
  const unavailable=setup();
  await assert.rejects(invokeAiDialogue({message,resolved:{state:'disabled'},tools:unavailable.tools,fetchImpl:noProvider}),{code:'AI_UNAVAILABLE'});
  assert.equal(unavailable.tools.getEvidence().length,0);
  const aborted=setup(),controller=new AbortController();controller.abort();
  await assert.rejects(invokeAiDialogue({message,resolved,tools:aborted.tools,signal:controller.signal,fetchImpl:noProvider}),{code:'AI_ABORTED'});
  assert.equal(aborted.tools.getEvidence().length,0);
  const duringProgress=setup(),progressController=new AbortController();
  await assert.rejects(invokeAiDialogue({message,resolved,tools:duringProgress.tools,
    signal:progressController.signal,fetchImpl:noProvider,onProgress:()=>progressController.abort()}),{code:'AI_ABORTED'});
  assert.equal(duringProgress.tools.getEvidence().length,0);
  const mismatch=setup();
  mismatch.tools.getEvidence=()=>[];
  await assert.rejects(invokeAiDialogue({message,resolved,tools:mismatch.tools,fetchImpl:noProvider}),{code:'AI_TOOL_FAILED'});
});
