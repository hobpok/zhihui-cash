import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeAiDialogue, aiDialogueDiagnosticReason } from './ai-dialogue.js';
import { makePlanningFixture } from '../app/planning-fixtures.js';
import { createPlanningTools } from './planning-tools.js';
import { createModel } from '../app/model.js';
import { createHistoricalComplexTemplate } from '../app/test-fixtures/historical-complex.js';

const URL = 'https://api.deepseek.com/chat/completions';
const credential = 'private-test-key';
const resolved = { state: 'real_ready', config: { mode: 'real', provider: 'deepseek', model: 'deepseek-flash' }, credential };
const definition = { type: 'function', function: { name: 'read_metrics', description: 'Read metrics',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } };
const diagnosisDefinition = { type: 'function', function: { name: 'diagnose_execution', description: 'Diagnose execution',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } };

function fixture({metricRatio = 0.05, threshold = null} = {}) {
  const ledger = [];
  const calls = [];
  return { calls, context: { contractVersion: 'test-v1', navYuan: 123 }, definitions: [definition],
    execute(name, args) {
      calls.push({ name, args });
      const result = { status: 'ok', portfolio: { navYuan: 123, accountCashYuan: 100,
        businessAvailableYuan: 110 }, currentRules: { rows: [{ ruleId: 'C02', currentValue: metricRatio,
          ...(threshold ? {threshold} : {}), result: 'pass' }] } };
      ledger.push({ toolName: name, result });
      return result;
    }, getEvidence: () => ledger.map(entry => structuredClone(entry)) };
}

function diagnosisFixture({ margin = 2.6 } = {}) {
  const ledger = [];
  const calls = [];
  return { calls, context: { contractVersion: 'test-v1' }, definitions: [definition, diagnosisDefinition],
    execute(name, args) {
      calls.push({ name, args });
      const result = name === 'diagnose_execution'
        ? { status: 'attention', current: {
          c02: { ruleId: 'C02', currentValue: margin < 0 ? 0.045 : 0.076, thresholdRatio: 0.05,
            headroomYuan: margin < 0 ? -250_000_000 : 1_300_000_000,
            marginPercentagePoints: margin, result: margin < 0 ? 'block' : 'pass' },
          cash: { accountCashYuan: 2_100_000_000, businessCashYuan: 3_400_000_000,
            saleUncreditedYuan: 1_300_000_000, governmentBondWithinYearYuan: 400_000_000,
            navYuan: 50_000_000_000 } },
          next: { proposalStatus: null, unarrangedYuan: null, unfinishedYuan: 1_290_000_000,
            proposalBasis: 'saved_proposal_rule_mismatch', savedProposalStatus: 'search_exhausted',
            savedUnarrangedYuan: 1_290_000_000, firstBlockedStep: null },
          unfinishedPlans: [{ planId: 'deposit-1', businessType: 'deposit', label: '甲行存款',
            remainingYuan: 540_000_000, immediateBlockers: [] },
          { planId: 'cd-1', businessType: 'cd_buy', label: '乙行存单',
            remainingYuan: 750_000_000, immediateBlockers: [] }],
          settlementActions: [{ kind: 'receive_cash', amountYuan: 1_300_000_000 }],
          liquidityBridge: { businessCashYuan: 3_400_000_000,
            unreceivedSaleYuan: 1_300_000_000, accountCashYuan: 2_100_000_000,
            remainingOutflowYuan: 1_290_000_000,
            accountCashAfterRemainingOutflowsYuan: 810_000_000,
            businessCashAfterRemainingOutflowsYuan: 2_110_000_000,
            accountCanCoverRemainingOutflows: true,
            projectedC02RatioAfterRemainingOutflows: 0.0502,
            projectedC02HeadroomYuan: 10_000_000,
            projectedC02MarginPercentagePoints: 0.02 },
          gates: { requiresRefresh: true, requiresReapproval: true, pendingReports: 0 },
          recommendations: [
            { text: '刷新执行快照，重新计算逐笔规则和排序、重新审核，再手动下达。' },
            { text: '在投管系统找到卖券指令，点击录入投管回报，选择卖券回款到账并可用；核对实际账户现金，不重复增加现金比例，也不要重复录入成交或结算，并留存银行回单与指令回报的对应关系，避免相同资金被重复计入。' },
          ] }
        : { status: 'ok', currentRules: { rows: [{ ruleId: 'C02', currentValue: 0.076, result: 'pass' }] } };
      ledger.push({ toolName: name, result });
      return result;
    }, getEvidence: () => structuredClone(ledger) };
}

function completion(message, finishReason = 'stop', promptTokens = 10, completionTokens = 5) {
  return { object: 'chat.completion', choices: [{ index: 0, finish_reason: finishReason, message }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } };
}
function toolCall(id = 'call_1', name = 'read_metrics', args = '{}') {
  return { id, type: 'function', function: { name, arguments: args } };
}
function toolTurn(...calls) {
  return completion({ role: 'assistant', content: null, tool_calls: calls }, 'tool_calls');
}
function finalTurn(value) { return completion({ role: 'assistant', content: JSON.stringify(value) }); }
function scriptedFetch(responses, inspect = () => {}) {
  let count = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${credential}`);
    inspect(JSON.parse(options.body), count);
    const data = responses[count++];
    if (!data) throw new Error('unexpected network call');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, get count() { return count; } };
}

test('multi-round tool protocol accumulates usage and cites only executed evidence', async () => {
  const tools = fixture();
  const scripted = scriptedFetch([toolTurn(toolCall()), finalTurn({ kind: 'answer', references: ['call_1'] })],
    (body, index) => {
      assert.equal(body.model, 'deepseek-flash');
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, 2048);
      assert.equal(body.tools[0].function.name, 'read_metrics');
      if (index === 1) {
        assert.equal(body.messages[2].role, 'assistant');
        assert.equal(body.messages[2].tool_calls[0].id, 'call_1');
        assert.equal(body.messages[3].role, 'tool');
        assert.equal(body.messages[3].tool_call_id, 'call_1');
        assert.equal(body.messages[4].role, 'system');
        assert.match(body.messages[4].content, /"callId":"call_1"/);
        assert.match(body.messages[4].content, /references.*call_1/);
      }
    });
  const output = await invokeAiDialogue({ message: '查看当前指标', resolved, tools, fetchImpl: scripted.fetchImpl });
  assert.equal(scripted.count, 2);
  assert.deepEqual(output.usage, { inputTokens: 20, outputTokens: 10 });
  assert.equal(output.simulated, false);
  assert.equal(output.dialogue.status, 'answer');
  assert.deepEqual(output.dialogue.references, ['call_1']);
  assert.deepEqual(output.dialogue.evidence, [{ callId: 'call_1', name: 'read_metrics', result: {
    status: 'ok', portfolio: { navYuan: 123, accountCashYuan: 100, businessAvailableYuan: 110 },
    currentRules: { rows: [{ ruleId: 'C02', currentValue: 0.05, result: 'pass' }] },
  } }]);
  assert.match(output.text, /123/);
  assert.equal(tools.calls.length, 1);
  assert.equal(JSON.stringify(output).includes(credential), false);
  assert.equal(Object.hasOwn(output.dialogue, 'narrative'), false);
});

test('negated or deferred drafting does not force planning for a metric question', async () => {
  const messages = [
    '请查询当前现金比例C02。只查指标，不要拟单。',
    '查询当前现金比例C02，不做拟单。',
    '请查询当前现金比例C02。只查指标，不拟单。',
    '请查询当前现金比例C02，不需要拟单。',
    '请查询当前现金比例C02，不用拟单。',
    '请查询当前现金比例C02，无需拟单。',
    '请查询当前现金比例C02，暂时不要拟单。',
    '先不要拟单，确认后再拟单；现在只查现金比例C02。',
  ];
  for (const message of messages) {
    const tools = fixture();
    tools.definitions.push({type:'function',function:{name:'plan_trades',description:'Plan',
      parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
    const scripted = scriptedFetch([toolTurn(toolCall('metrics')), finalTurn({
      kind:'answer',references:['metrics'],narrative:'当前现金比例为5%。',
    })], (body, index) => {
      if (index === 0) assert.deepEqual(body.tool_choice,
        {type:'function',function:{name:'read_metrics'}}, message);
    });
    const output = await invokeAiDialogue({message,resolved,tools,fetchImpl:scripted.fetchImpl});
    assert.equal(output.dialogue.status, 'answer', message);
    assert.deepEqual(tools.calls.map(call => call.name), ['read_metrics'], message);
  }
});

test('a cash-ratio versus payment-account follow-up uses fresh metrics and a unique tool-name citation', async () => {
  const tools = fixture();
  const history = [{userMessage:'只查询当前现金比例C02和平均剩余期限C09，不要拟单，不修改计划。',
    assistantAnswer:'当前现金比例为5%，平均剩余期限见本轮查询。'}];
  const scripted = scriptedFetch([
    toolTurn(toolCall('fresh_metrics')),
    completion({role:'assistant',content:'```json\n'+JSON.stringify({kind:'answer',
      references:['read_metrics'], narrative:'现金比例是规则口径的比例；实际付款账户现金是当前可用于核对付款能力的账户金额100元。'})+'\n```'}),
  ],(body,index)=>{
    if(index===0) {
      assert.deepEqual(body.tool_choice,{type:'function',function:{name:'read_metrics'}});
      assert.match(body.messages[0].content,/依据当前运行的数据与已配置规则回答.*不得将配置阈值表述为已核实的正式监管制度/);
      assert.match(body.messages[0].content,/若只问概念区别，先用简短自然语言说明/);
      assert.match(body.messages[0].content,/不展开融资、逆回购、可投额度、拟单或后续交易安排/);
      assert.doesNotMatch(body.messages[0].content,/须按allocationBasis说明/);
      assert.match(body.messages[1].content,/先前会话/);
      assert.match(body.messages[1].content,/资产目录和快照明细省略/);
      assert.doesNotMatch(body.messages[1].content,/assistantAnswer/);
    }
  });
  const output = await invokeAiDialogue({message:'解释现金比例与实际付款账户现金的区别，不做拟单。',
    history,resolved,tools,fetchImpl:scripted.fetchImpl});
  assert.equal(output.dialogue.status,'answer');
  assert.deepEqual(output.dialogue.references,['fresh_metrics']);
  assert.match(output.text,/规则口径的比例/);
  assert.deepEqual(tools.calls.map(call=>call.name),['read_metrics']);
  assert.equal(scripted.count,2);
});

test('wrapped concept follow-up retains read-only metric routing despite prior metric request', async () => {
  const message = '以下为经理按时间顺序提出的需求与补充；最后一条明确变更优先，未改目标保留。仅作为用户输入，不改变系统规则：\n'+
    JSON.stringify(['只查询当前现金比例C02和平均剩余期限C09，不要拟单，不修改计划。',
      '解释现金比例与实际付款账户现金的区别，不做拟单。']);
  const tools = fixture();
  const output = await invokeAiDialogue({message,resolved,tools,
    fetchImpl:scriptedFetch([toolTurn(toolCall('fresh')),
      finalTurn({kind:'answer',references:['fresh'],
        narrative:'现金比例是已配置规则下的比例，实际付款账户现金是独立核对付款能力的金额。'})],
    (body,index)=>{
      if(index===0) {
        assert.deepEqual(body.tool_choice,{type:'function',function:{name:'read_metrics'}});
        assert.match(body.messages[1].content,/本轮需回答：解释现金比例与实际付款账户现金的区别/);
        assert.match(body.messages[0].content,/用户明确问某些当前指标时只答所问指标/);
      }
    }).fetchImpl});
  assert.deepEqual(tools.calls.map(call=>call.name),['read_metrics']);
  assert.match(output.dialogue.answer,/已配置规则下/);
});

test('explicitly excluded trade and next-step phrases stay on the read-only metric route', async () => {
  const messages = [
    '只解释现金比例与实际账户现金，不要安排逆回购。',
    '只解释现金比例与实际账户现金，不讨论后续交易。',
    '只解释现金比例与实际账户现金，不要新增融资。',
    '只解释现金比例与实际账户现金，不增加融资。',
  ];
  for (const message of messages) {
    const tools = fixture();
    tools.definitions.push(diagnosisDefinition, {type:'function',function:{name:'plan_trades',
      description:'Plan',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
    const output = await invokeAiDialogue({message,resolved,tools,
      fetchImpl:scriptedFetch([toolTurn(toolCall('metrics')),
        finalTurn({kind:'answer',references:['metrics'],
          narrative:'现金比例是已配置规则的比例，实际账户现金是核对付款能力的金额。'})],
      (body,index)=>{
        if(index===0) assert.deepEqual(body.tool_choice,
          {type:'function',function:{name:'read_metrics'}},message);
      }).fetchImpl});
    assert.deepEqual(tools.calls.map(call=>call.name),['read_metrics'],message);
    assert.equal(output.dialogue.status,'answer',message);
  }
});

test('positive mixed requests still require planning or execution diagnosis', async () => {
  for (const message of ['不要修改已有计划，新增一笔存款。',
    '不要安排逆回购但新增买券。']) {
    const tools = fixture();
    tools.definitions.push({type:'function',function:{name:'plan_trades',description:'Plan',
      parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
    const execute = tools.execute.bind(tools);
    tools.execute = (name,args,requirements) => {
      if (message.includes('不要安排逆回购')) assert.equal(requirements.requireAutomaticReverseRepo,false);
      return execute(name,args,requirements);
    };
    const output = await invokeAiDialogue({message,resolved,tools,
      fetchImpl:scriptedFetch([toolTurn(toolCall('plan','plan_trades')),
        finalTurn({kind:'answer',references:['plan'],narrative:'已完成本轮只读测算。'})],
      (body,index)=>{
        if(index===0) assert.deepEqual(body.tool_choice,
          {type:'function',function:{name:'plan_trades'}},message);
      }).fetchImpl});
    assert.deepEqual(output.dialogue.references,['plan']);
  }
  const tools = diagnosisFixture();
  const output = await invokeAiDialogue({message:'不讨论后续交易但诊断当前下不去问题。',
    resolved,tools,fetchImpl:scriptedFetch([
      toolTurn(toolCall('diagnosis','diagnose_execution')),
      finalTurn({kind:'answer',references:['diagnosis'],narrative:'当前下达受阻，须核对本轮执行诊断。'}),
    ],(body,index)=>{
      if(index===0) assert.deepEqual(body.tool_choice,
        {type:'function',function:{name:'diagnose_execution'}});
    }).fetchImpl});
  assert.deepEqual(output.dialogue.references,['diagnosis']);
});

test('tool-name citation recovery stays unambiguous and does not bypass numeric evidence', async () => {
  const tools = fixture();
  const ambiguous = scriptedFetch([
    toolTurn(toolCall('first')), toolTurn(toolCall('second')),
    finalTurn({kind:'answer',references:['read_metrics'],narrative:'当前现金比例为5%。'}),
  ]);
  await assert.rejects(invokeAiDialogue({message:'当前指标',resolved,tools,
    fetchImpl:ambiguous.fetchImpl}), error => error.code==='AI_DIALOGUE_INVALID' &&
    aiDialogueDiagnosticReason(error)==='reference_unknown');
  const invalidAmount = scriptedFetch([
    toolTurn(toolCall('fresh')),
    finalTurn({kind:'answer',references:['read_metrics'],narrative:'当前账户现金200元。'}),
    finalTurn({kind:'answer',references:['fresh'],narrative:'当前账户现金100元。'}),
  ]);
  const corrected = await invokeAiDialogue({message:'当前账户现金多少',resolved,tools:fixture(),
    fetchImpl:invalidAmount.fetchImpl});
  assert.equal(corrected.dialogue.answer,'当前账户现金100元。');
  assert.equal(invalidAmount.count,3);
});

test('missing required metric citation recovers a deterministic summary from current tools', async () => {
  const tools = fixture();
  tools.definitions.push({type:'function',function:{name:'review_sorting',description:'Read sort',
    parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
  const output = await invokeAiDialogue({message:'解释当前现金比例与实际账户现金',resolved,tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics','read_metrics')),
      toolTurn(toolCall('sorting','review_sorting')),
      finalTurn({kind:'answer',references:['sorting'],narrative:'现金比例是比例。'}),
    ]).fetchImpl});
  assert.deepEqual(output.dialogue.references,['metrics','sorting']);
  assert.deepEqual(output.dialogue.diagnostic,{reason:'required_reference', recovery:'trusted_summary', recovered:true});
  assert.equal(output.dialogue.narrative,undefined);
});

test('dialogue diagnostic reason is a fixed enum and never echoes input', async () => {
  await assert.rejects(invokeAiDialogue({message:'查看当前指标',resolved,tools:fixture(),
    fetchImpl:scriptedFetch([toolTurn(toolCall('fresh')),
      finalTurn({kind:'answer',references:['private-user-text']})]).fetchImpl}),
  error => error.code==='AI_DIALOGUE_INVALID' &&
    aiDialogueDiagnosticReason(error)==='reference_unknown' &&
    !JSON.stringify(error).includes('private-user-text'));
  assert.equal(aiDialogueDiagnosticReason({code:'AI_DIALOGUE_INVALID',diagnosticReason:'private-user-text'}),'unknown');
  assert.equal(aiDialogueDiagnosticReason(new Error('private-user-text')),'unknown');
});

test('omitted or empty citations recover only a current deterministic summary, never model prose', async () => {
  for (const references of [undefined, []]) {
    const scripted = scriptedFetch([toolTurn(toolCall('fresh')),
      finalTurn({kind:'answer',...(references === undefined ? {} : {references}),
        narrative:'当前账户现金999亿元。SECRET provider prose'})]);
    const result = await invokeAiDialogue({message:'查看当前指标',resolved,tools:fixture(),fetchImpl:scripted.fetchImpl});
    assert.deepEqual(result.dialogue.references,['fresh']);
    assert.deepEqual(result.dialogue.diagnostic,{reason:'reference_missing',recovery:'trusted_summary',recovered:true});
    assert.equal(result.dialogue.narrative,undefined);
    assert.doesNotMatch(result.text,/999|SECRET/);
    assert.equal(scripted.count,2);
  }
});

test('missing citations cannot recover a missing required tool, invalid decision, or invalid latest plan', async () => {
  await assert.rejects(invokeAiDialogue({message:'查看当前指标',resolved,tools:fixture(),
    fetchImpl:scriptedFetch([finalTurn({kind:'answer'})]).fetchImpl}),
  error => aiDialogueDiagnosticReason(error)==='reference_missing');
  await assert.rejects(invokeAiDialogue({message:'下一步',resolved,tools:diagnosisFixture(),
    fetchImpl:scriptedFetch([toolTurn(toolCall()),finalTurn({kind:'answer'})]).fetchImpl}),
  error => aiDialogueDiagnosticReason(error)==='required_tool');
  await assert.rejects(invokeAiDialogue({message:'查看当前指标',resolved,tools:fixture(),
    fetchImpl:scriptedFetch([toolTurn(toolCall()),finalTurn({kind:'answer',approve:true})]).fetchImpl}),
  error => aiDialogueDiagnosticReason(error)==='answer_shape');
  const ledger=[];
  const tools={context:{},definitions:[{...definition,function:{...definition.function,name:'plan_trades'}}],
    execute(name){const result={status:ledger.length ? 'invalid_intent' : 'feasible',
      main:{applicable:false,status:'infeasible'}};ledger.push({toolName:name,result});return result;},
    getEvidence:()=>structuredClone(ledger)};
  await assert.rejects(invokeAiDialogue({message:'新增存款方案',resolved,tools,
    fetchImpl:scriptedFetch([toolTurn(toolCall('old','plan_trades')),
      toolTurn(toolCall('latest','plan_trades')),finalTurn({kind:'answer'})]).fetchImpl}),
  error=>aiDialogueDiagnosticReason(error)==='reference_missing');
});

test('percentage failures are classified separately and retain the trusted summary', async () => {
  const output=await invokeAiDialogue({message:'查看当前指标',resolved,tools:fixture(),
    fetchImpl:scriptedFetch([toolTurn(toolCall('fresh')),
      finalTurn({kind:'answer',references:['fresh'],narrative:'当前现金比例99%。'}),
      finalTurn({kind:'answer',references:['fresh'],narrative:'当前现金比例99%。'})]).fetchImpl});
  assert.deepEqual(output.dialogue.diagnostic,{reason:'narrative_percentage',recovery:'trusted_summary',recovered:true});
  assert.doesNotMatch(output.text,/99%/);
});

test('an explicit superseded simulation citation is rejected rather than recovered as missing', async () => {
  const ledger=[];
  const tools={context:{},definitions:[{...definition,function:{...definition.function,name:'simulate_completion'}}],
    execute(name){const result={status:'ok',terminalStatus:'insufficient_data',pathStatus:'not_verified'};
      ledger.push({toolName:name,result});return result;},getEvidence:()=>structuredClone(ledger)};
  await assert.rejects(invokeAiDialogue({message:'只模拟全部完成后的指标',resolved,tools,
    fetchImpl:scriptedFetch([toolTurn(toolCall('old','simulate_completion')),
      toolTurn(toolCall('latest','simulate_completion')),finalTurn({kind:'answer',references:['old']})]).fetchImpl}),
  error=>aiDialogueDiagnosticReason(error)==='reference_stale');
});

test('explicit whole-plan arrangement and remediation requests force planning, explanations do not', async () => {
  for (const message of ['安排当前全部计划','为当前计划寻找补救方案','请给出补救方案']) {
    const tools=fixture();
    tools.definitions.push({type:'function',function:{name:'plan_trades',description:'Plan',
      parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
    const output=await invokeAiDialogue({message,resolved,tools,
      fetchImpl:scriptedFetch([toolTurn(toolCall('plan','plan_trades')),
        finalTurn({kind:'answer',references:['plan']})],(body,index)=>{
        if(index===0) assert.deepEqual(body.tool_choice,{type:'function',function:{name:'plan_trades'}},message);
      }).fetchImpl});
    assert.deepEqual(output.dialogue.references,['plan']);
  }
  for (const message of ['只解释补救方案，不拟单','先不拟单，解释如何安排当前全部计划']) {
    const output=await invokeAiDialogue({message,resolved,tools:fixture(),
      fetchImpl:scriptedFetch([toolTurn(toolCall('metrics')),
        finalTurn({kind:'answer',references:['metrics']})],(body,index)=>{
        if(index===0) assert.equal(body.tool_choice,'auto',message);
      }).fetchImpl});
    assert.deepEqual(output.dialogue.references,['metrics']);
  }
  const ledger=[];
  const tools={context:{},definitions:[{...definition,function:{...definition.function,name:'simulate_completion'}}],
    execute(name){const result={status:'ok',terminalStatus:'insufficient_data',pathStatus:'not_verified'};
      ledger.push({toolName:name,result});return result;},getEvidence:()=>structuredClone(ledger)};
  const output=await invokeAiDialogue({message:'只模拟全部完成后的指标，先不拟单',resolved,tools,
    fetchImpl:scriptedFetch([toolTurn(toolCall('simulation','simulate_completion')),
      finalTurn({kind:'answer',references:['simulation']})],(body,index)=>{
      if(index===0) assert.deepEqual(body.tool_choice,{type:'function',function:{name:'simulate_completion'}});
    }).fetchImpl});
  assert.deepEqual(output.dialogue.references,['simulation']);
});

test('deterministic recovery visibly marks sale remediation as awaiting manager confirmation', async () => {
  const ledger=[];
  const tools={context:{},definitions:[{...definition,function:{...definition.function,name:'plan_trades'}}],
    execute(name){const result={status:'feasible',main:{applicable:true,status:'feasible'},
      remediation:{requiresManagerConfirmation:true,actions:[{businessType:'bond_sell',targetYuan:100,securityId:'bond'}]}};
      ledger.push({toolName:name,result});return result;},getEvidence:()=>structuredClone(ledger)};
  const output=await invokeAiDialogue({message:'为当前计划寻找补救方案',resolved,tools,
    fetchImpl:scriptedFetch([toolTurn(toolCall('plan','plan_trades')),finalTurn({kind:'answer'})]).fetchImpl});
  assert.match(output.text,/新增1笔卖券，待经理确认/);
  assert.match(output.text,/尚未应用或成交/);
});

test('sale remediation restriction follows user constraints and explicit release', async () => {
  for (const [message,history,disabled] of [
    ['新增存款，不要卖券',undefined,true],
    ['新增存款方案',[{userMessage:'不允许卖出任何债券',assistantAnswer:'已记录约束。'}],true],
    ['新增存款，现在允许卖券',[{userMessage:'不能卖券',assistantAnswer:'已记录约束。'}],false],
  ]) {
    const ledger=[]; let received;
    const tools={context:{},definitions:[{...definition,function:{...definition.function,name:'plan_trades'}}],
      execute(name,args,requirements){received=requirements;const result={status:'feasible',main:{applicable:false,status:'infeasible'}};
        ledger.push({toolName:name,result});return result;},getEvidence:()=>structuredClone(ledger)};
    const output=await invokeAiDialogue({message,history,resolved,tools,
      fetchImpl:scriptedFetch([toolTurn(toolCall('plan','plan_trades')),finalTurn({kind:'answer'})]).fetchImpl});
    assert.equal(received.disableRemediation,disabled);
    assert.equal(output.dialogue.evidence[0].result.main.applicable,false);
  }
});

test('positive drafting still forces planning when an earlier clause only protects existing plans', async () => {
  for (const message of ['请帮我拟单。', '不要修改已有计划，帮我拟单新增一笔存单。']) {
    const tools = fixture();
    tools.definitions.push({type:'function',function:{name:'plan_trades',description:'Plan',
      parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
    await assert.rejects(invokeAiDialogue({message,resolved,tools,
      fetchImpl:scriptedFetch([toolTurn(toolCall('metrics')), finalTurn({
        kind:'answer',references:['metrics'],narrative:'当前现金比例为5%。',
      })], (body, index) => {
        if (index === 0) assert.deepEqual(body.tool_choice,
          {type:'function',function:{name:'plan_trades'}}, message);
      }).fetchImpl}), {code:'AI_DIALOGUE_INVALID'});
  }
});

test('execution questions require cited diagnosis and use validated natural answer', async () => {
  const tools = diagnosisFixture();
  const scripted = scriptedFetch([
    toolTurn(toolCall('metrics', 'read_metrics')),
    toolTurn(toolCall('diagnosis', 'diagnose_execution')),
    finalTurn({ kind: 'answer', references: ['metrics', 'diagnosis'],
      narrative: '卖券成交后，当前C02为7.6%，已计入待收卖券13亿元。实际账户现金21亿元足以支付剩余12.9亿元，无需等待卖券款到账。完成付款后账户现金暂为8.1亿元，C02附条件测算为5.02%；请刷新测算、重新审核并手动下达。' }),
  ], (body, index) => {
    if (index === 0) {
      assert.match(body.messages[0].content, /必须调用diagnose_execution/);
      assert.match(body.messages[0].content, /narrative/);
    }
  });
  const output = await invokeAiDialogue({ message: '为什么下不去？剩余交易下一步怎么操作？',
    resolved, tools, fetchImpl: scripted.fetchImpl });
  assert.deepEqual(tools.calls.map(call => call.name), ['read_metrics', 'diagnose_execution']);
  assert.deepEqual(output.dialogue.references, ['metrics', 'diagnosis']);
  assert.match(output.dialogue.answer, /实际账户现金21亿元足以支付剩余12\.9亿元/);
  assert.doesNotMatch(output.dialogue.answer, /建议按以下顺序操作/);
  assert.match(output.dialogue.narrative, /待收卖券13亿元/);
  assert.match(output.dialogue.narrative, /实际账户现金21亿元足以支付剩余12\.9亿元/);
  assert.equal(output.dialogue.answer, output.dialogue.narrative);
  assert.equal(output.text, output.dialogue.answer);
});

test('execution quick questions require diagnosis and omit duplicate catalogues from model input', async () => {
  for (const message of ['当前指令是否可顺利完成？', '目前指令卡在哪一步？']) {
    const model = createModel(); model.startFromTemplate();
    const saved = model.serialize();
    const tools = createPlanningTools(JSON.parse(saved), {requestId:'quick-status',documentRevision:1});
    const original = structuredClone(tools.context);
    const scripted = scriptedFetch([
      toolTurn(toolCall('diagnosis', 'diagnose_execution')),
      finalTurn({kind:'answer',references:['diagnosis'],narrative:'当前指令需要按逐笔规则与成交前提推进，请重新计算、审核后手动下达。'}),
    ], (body, index) => {
      if (index === 0) assert.deepEqual(body.tool_choice,
        {type:'function',function:{name:'diagnose_execution'}});
      assert.ok(Buffer.byteLength(body.messages[1].content) < 5000);
      assert.doesNotMatch(body.messages[1].content, /"(?:securities|holdings|plans|currentRules)":/);
      assert.match(body.messages[1].content, /省略不代表缺数或零值/);
      if (index === 1) assert.deepEqual(JSON.parse(body.messages[3].content), tools.getEvidence()[0].result);
    });
    const result = await invokeAiDialogue({message,resolved,tools,fetchImpl:scripted.fetchImpl});
    assert.equal(result.dialogue.status,'answer');
    assert.deepEqual(result.dialogue.references,['diagnosis']);
    assert.deepEqual(result.dialogue.evidence[0].result, tools.getEvidence()[0].result);
    assert.deepEqual(tools.context,original);
    assert.equal(model.serialize(),saved);
  }
});

test('funding quick questions retain planning context and protect current fixed targets', async () => {
  for (const message of ['还需要额外融资多少才能完成当前指令？','完成当前指令后，还能安排多少逆回购？']) {
    const tools = diagnosisFixture();
    tools.context.securities = [{securityId:'known-only',label:'指定证券'}];
    tools.definitions.push({type:'function',function:{name:'plan_trades',description:'Plan',
      parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
    const execute = tools.execute;
    tools.execute = (name,args,requirements) => {
      assert.equal(requirements.protectExistingFixedTrades,true);
      return execute(name,args);
    };
    const scripted = scriptedFetch([toolTurn(toolCall('plan','plan_trades')),
      finalTurn({kind:'answer',references:['plan']})], (body,index) => {
        if (index === 0) assert.deepEqual(body.tool_choice,{type:'function',function:{name:'plan_trades'}});
        assert.match(body.messages[1].content, /known-only/);
      });
    const result = await invokeAiDialogue({message,resolved,tools,fetchImpl:scripted.fetchImpl});
    assert.equal(result.dialogue.status,'answer');
    assert.deepEqual(result.dialogue.references,['plan']);
  }
});

test('the diagnosed cumulative token overflow still fails closed at the raised budget', async () => {
  const tools = diagnosisFixture();
  const scripted = scriptedFetch([
    completion({role:'assistant',content:null,tool_calls:[toolCall('diagnosis','diagnose_execution')]},'tool_calls',40000,49),
    completion({role:'assistant',content:JSON.stringify({kind:'answer',references:['diagnosis']})},'stop',40000,576),
  ]);
  await assert.rejects(invokeAiDialogue({message:'当前指令是否可顺利完成？',resolved,tools,
    fetchImpl:scripted.fetchImpl}), {code:'AI_BUDGET_EXCEEDED'});
});

test('arranging a buy within current orders remains planning and permits a new fixed trade', async () => {
  const tools = diagnosisFixture();
  tools.context.securities = [{securityId:'new-security',label:'可买证券'}];
  tools.definitions.push({type:'function',function:{name:'plan_trades',description:'Plan',
    parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
  const execute = tools.execute;
  tools.execute = (name,args,requirements) => {
    assert.equal(requirements.protectExistingFixedTrades,false);
    return execute(name,args);
  };
  const scripted = scriptedFetch([toolTurn(toolCall('plan','plan_trades')),
    finalTurn({kind:'answer',references:['plan']})], (body,index) => {
      if(index === 0) assert.deepEqual(body.tool_choice,{type:'function',function:{name:'plan_trades'}});
      assert.match(body.messages[1].content,/new-security/);
    });
  const output = await invokeAiDialogue({message:'当前指令能否安排一笔存单买入？',resolved,tools,fetchImpl:scripted.fetchImpl});
  assert.equal(output.dialogue.status,'answer');
});

test('blocked existing buy asking for financing and leftover reverse repo requires both diagnosis and planning', async () => {
  const tools = diagnosisFixture();
  tools.definitions.push({type:'function',function:{name:'plan_trades',description:'Plan trades',
    parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
  const message = '现有3亿元买券单受C02、C09约束无法下达，请计算所需融资和剩余资金逆回购分配方案。';
  await assert.rejects(() => invokeAiDialogue({message,resolved,tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('diagnosis','diagnose_execution')),
      finalTurn({kind:'answer',references:['diagnosis'],narrative:'请刷新并重新审核。'}),
    ]).fetchImpl}), {code:'AI_DIALOGUE_INVALID'});
  const freshTools = diagnosisFixture();
  freshTools.definitions.push({type:'function',function:{name:'plan_trades',description:'Plan trades',
    parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
  const output = await invokeAiDialogue({message,resolved,tools:freshTools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('diagnosis','diagnose_execution'),toolCall('plan','plan_trades')),
      finalTurn({kind:'answer',references:['diagnosis','plan'],
        narrative:'已测算候选方案，仍须经理确认、本地复核、重新审核并手动下达。'}),
    ]).fetchImpl});
  assert.deepEqual(freshTools.calls.map(row => row.name),['diagnose_execution','plan_trades']);
  assert.deepEqual(output.dialogue.references,['diagnosis','plan']);
});

test('this existing buy asks for a plan even without explicit blocked wording', async () => {
  const tools = fixture();
  await assert.rejects(() => invokeAiDialogue({
    message:'这笔3亿元的买券单需要融资多少，剩下的钱出逆回购该如何分配？',
    resolved,tools,fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics')),
      finalTurn({kind:'answer',references:['metrics'],narrative:'当前可用现金已查询。'}),
    ]).fetchImpl,
  }),{code:'AI_DIALOGUE_INVALID'});
});

test('existing-order funding request starts with plan and normalizes duplicate order and invented coarse grid', async () => {
  const {model,intent} = makePlanningFixture('S1');
  model.addPlan(intent.fixedPlans[0]);
  const tools = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'existing-order-plan',documentRevision:1});
  const args = {fixedTrades:[{businessType:'cd_buy',securityId:'AI-A-CD-120',
    targetYuan:1_500_000_000}],financing:{unitYuan:100_000_000},
    reverseRepo:{tenorDays:7,unitYuan:100_000_000}};
  const scripted = scriptedFetch([
    toolTurn(toolCall('plan','plan_trades',JSON.stringify(args))),
    finalTurn({kind:'answer',references:['plan'],
      narrative:'当前业务头寸10亿元；已有买券目标已纳入测算。按候选方案执行前，仍须经理确认、重新审核并手动下达。'}),
  ],(body,index) => {
    if (index === 0) assert.deepEqual(body.tool_choice,
      {type:'function',function:{name:'plan_trades'}});
  });
  const output = await invokeAiDialogue({
    message:'这笔买券单需要融资多少，剩下的钱出逆回购该如何分配？',
    resolved,tools,fetchImpl:scripted.fetchImpl,
  });
  assert.equal(scripted.count,2);
  assert.equal(output.dialogue.status,'answer');
  assert.match(output.dialogue.narrative,/当前业务头寸10亿元/);
  const planned = output.dialogue.evidence[0].result;
  assert.deepEqual(planned.intent.fixedTrades,[]);
  assert.equal(planned.intent.financing.unitYuan,1_000_000);
  assert.equal(planned.intent.reverseRepo.unitYuan,1_000_000);
  assert.equal(planned.intent.financing.tenorDays,1);
  assert.equal(planned.intent.reverseRepo.tenorDays,7);
  assert.deepEqual(planned.termAssumptions.map(item => item.source),
    ['business_default','business_default']);
});

test('a tenor-only follow-up keeps the existing-order scope and replans without new fixed trades', async () => {
  const {model,intent} = makePlanningFixture('S1');
  model.addPlan(intent.fixedPlans[0]);
  const tools = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'existing-order-followup',documentRevision:1});
  const args = {fixedTrades:[{businessType:'bond_buy',securityId:'AI-NONBANK-BASKET',
    targetYuan:300_000_000}],financing:{tenorDays:7},reverseRepo:{tenorDays:1}};
  const scripted = scriptedFetch([
    toolTurn(toolCall('plan','plan_trades',JSON.stringify(args))),
    finalTurn({kind:'answer',references:['plan'],
      narrative:'已按新的逆回购期限重新测算；仍需经理确认并审核后下达。'}),
  ],(body,index) => {
    if (index === 0) {
      assert.deepEqual(body.tool_choice,{type:'function',function:{name:'plan_trades'}});
      assert.doesNotMatch(body.messages[1].content,/上一轮逆回购400万元/);
    }
  });
  const output = await invokeAiDialogue({
    message:'逆回购改1天，融资仍7天，其余不变。',
    history:[{userMessage:'这笔买券单需要融资多少，余款如何安排逆回购？',
      assistantAnswer:'上一轮逆回购400万元，期限需确认。'}],
    resolved,tools,fetchImpl:scripted.fetchImpl,
  });
  assert.equal(output.dialogue.status,'answer');
  assert.deepEqual(output.dialogue.evidence[0].result.intent.fixedTrades,[]);
  assert.equal(output.dialogue.evidence[0].result.intent.reverseRepo.tenorDays,1);
});

test('C02-C08 threshold fractions support exact percentage claims', async () => {
  const tools = fixture({metricRatio:0.2, threshold:{operator:'≥',numerator:5,denominator:100}});
  const output = await invokeAiDialogue({ message:'当前比例如何？', resolved, tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics')),
      finalTurn({kind:'answer',references:['metrics'],
        narrative:'当前C02为20%，高于5%的规则下限。'}),
    ]).fetchImpl });
  assert.equal(output.dialogue.narrative, '当前C02为20%，高于5%的规则下限。');
  assert.equal(output.text, output.dialogue.narrative);
  const invalid = await invokeAiDialogue({ message:'当前比例如何？', resolved,
    tools:fixture({metricRatio:0.2,threshold:{operator:'≥',numerator:5,denominator:100}}),
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics')),
      finalTurn({kind:'answer',references:['metrics'],narrative:'C02规则下限为6%。'}),
    ]).fetchImpl });
  assert.equal(Object.hasOwn(invalid.dialogue,'narrative'),false);
});

test('metrics fallback uses readable Chinese amounts and omits tool IDs', async () => {
  const {model} = makePlanningFixture('S1');
  const tools = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'fallback-metrics',documentRevision:1});
  const output = await invokeAiDialogue({message:'查看当前指标',resolved,tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics')),
      finalTurn({kind:'answer',references:['metrics']}),
    ]).fetchImpl });
  assert.match(output.text,/现金比例10%/);
  assert.match(output.text,/平均剩余期限.*天/);
  assert.match(output.text,/亿元/);
  assert.doesNotMatch(output.text,/read_metrics|call_|metrics|\bpass\b|1000000000 元/);
});

test('execution answer cannot cite only current metrics or omit diagnosis call', async () => {
  await assert.rejects(invokeAiDialogue({ message: '还有哪些未完成交易，下一步是什么？', resolved,
    tools: diagnosisFixture(), fetchImpl: scriptedFetch([
      toolTurn(toolCall('metrics', 'read_metrics')),
      finalTurn({ kind: 'answer', references: ['metrics'], narrative: '当前指标正常，可以完成全部交易。' }),
    ]).fetchImpl }), { code: 'AI_DIALOGUE_INVALID' });
  await assert.rejects(invokeAiDialogue({ message: '下一步', resolved,
    tools: diagnosisFixture(), fetchImpl: scriptedFetch([
      finalTurn({ kind: 'clarification', question: '请补充。' }),
    ]).fetchImpl }), { code: 'AI_DIALOGUE_INVALID' });
  await assert.rejects(invokeAiDialogue({ message: '如何完成全部交易？', resolved,
    tools: diagnosisFixture(), fetchImpl: scriptedFetch([
      toolTurn(toolCall('diagnosis_old', 'diagnose_execution')),
      toolTurn(toolCall('diagnosis_new', 'diagnose_execution')),
      finalTurn({ kind: 'answer', references: ['diagnosis_old'], narrative: '请核对到账回报。' }),
    ]).fetchImpl }), { code: 'AI_DIALOGUE_INVALID' });
});

test('unsupported 1% narrative falls back to deterministic 5.02% answer; supported ratios survive', async () => {
  const invalid = await invokeAiDialogue({ message: '下一步如何完成全部交易？', resolved,
    tools: diagnosisFixture(), fetchImpl: scriptedFetch([
      toolTurn(toolCall('diagnosis', 'diagnose_execution')),
      finalTurn({ kind: 'answer', references: ['diagnosis'],
        narrative: '完成余下交易后，5%指标才勉强回到约1%的余量。' }),
    ]).fetchImpl });
  assert.equal(Object.hasOwn(invalid.dialogue, 'narrative'), false);
  assert.match(invalid.dialogue.answer, /现金比例5\.02%/);
  assert.match(invalid.dialogue.answer, /金额余量0\.1亿元/);
  const valid = await invokeAiDialogue({ message: '下一步如何完成全部交易？', resolved,
    tools: diagnosisFixture(), fetchImpl: scriptedFetch([
      toolTurn(toolCall('diagnosis', 'diagnose_execution')),
      finalTurn({ kind: 'answer', references: ['diagnosis'],
        narrative: '卖券成交后C02当前为7.6%，高于5%下限2.6个百分点；完成剩余付款后，附条件估计C02为5.02%，仅高于下限0.02个百分点。卖券款到账不再改善C02。' }),
    ]).fetchImpl });
  assert.match(valid.dialogue.narrative, /7\.6%/);
  assert.match(valid.dialogue.narrative, /5%下限/);
  assert.match(valid.dialogue.narrative, /2\.6个百分点/);
  assert.match(valid.dialogue.narrative, /5\.02%/);
  assert.match(valid.dialogue.narrative, /0\.02个百分点/);
  const wrongUnit = await invokeAiDialogue({ message: '下一步如何完成全部交易？', resolved,
    tools: diagnosisFixture(), fetchImpl: scriptedFetch([
      toolTurn(toolCall('diagnosis', 'diagnose_execution')),
      finalTurn({ kind: 'answer', references: ['diagnosis'], narrative: 'C02高于下限2.6%。' }),
    ]).fetchImpl });
  assert.equal(Object.hasOwn(wrongUnit.dialogue, 'narrative'), false);
});

test('one bounded prose repair corrects unsupported money without rerunning tools', async () => {
  const tools = diagnosisFixture();
  const scripted = scriptedFetch([
    toolTurn(toolCall('diagnosis', 'diagnose_execution')),
    finalTurn({ kind: 'answer', references: ['diagnosis'],
      narrative: '当前C02余量为1.3亿元，剩余付款后为5.02%。' }),
    finalTurn({ kind: 'answer', references: ['diagnosis'],
      narrative: '卖券成交已计入比例现金基数；当前C02为7.6%。实际账户现金足以支付余款，完成后C02附条件测算为5.02%，金额余量0.1亿元。请刷新测算并重新审核。' }),
  ], (body, index) => {
    if (index === 2) {
      assert.equal(Object.hasOwn(body,'tool_choice'),false);
      assert.equal(Object.hasOwn(body,'tools'),false);
      assert.equal(body.messages.length, 2);
      assert.match(body.messages[0].content, /修正上一条未通过数字证据校验/);
      assert.match(body.messages[1].content, /被拒内容/);
      assert.match(body.messages[1].content, /1\.3亿元/);
      assert.match(body.messages[1].content, /"field":"diagnose_execution\.current\.c02/);
      assert.match(body.messages[1].content, /"value":"7\.6%"/);
      assert.match(body.messages[1].content, /"value":"5%"/);
      assert.doesNotMatch(body.messages[1].content, /当前业务上下文|用户完整需求|历史会话/);
      assert.ok(JSON.stringify(body.messages).length < 14000);
    }
  });
  const output = await invokeAiDialogue({ message: '下一步如何完成全部交易？', resolved, tools,
    fetchImpl: scripted.fetchImpl });
  assert.equal(scripted.count, 3);
  assert.deepEqual(tools.calls.map(call => call.name), ['diagnose_execution']);
  assert.match(output.dialogue.narrative, /金额余量0\.1亿元/);
  assert.deepEqual(output.dialogue.diagnostic,{reason:'narrative_amount',recovery:'rewritten_answer',recovered:true});
  assert.match(output.dialogue.answer, /请刷新测算并重新审核/);
  assert.deepEqual(output.usage, { inputTokens: 30, outputTokens: 15 });
});

test('a repair may drop an unrelated citation while retaining required diagnosis', async () => {
  const tools = diagnosisFixture();
  const output = await invokeAiDialogue({message:'下一步如何继续未完成交易？',resolved,tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics','read_metrics')),
      toolTurn(toolCall('diagnosis','diagnose_execution')),
      finalTurn({kind:'answer',references:['metrics','diagnosis'],narrative:'还有99亿元未完成。'}),
      finalTurn({kind:'answer',references:['diagnosis'],
        narrative:'当前C02为7.6%，完成剩余付款后附条件测算为5.02%；请刷新重算并重新审核。'}),
    ]).fetchImpl });
  assert.deepEqual(output.dialogue.references,['diagnosis']);
  assert.match(output.text,/7\.6%/);
  assert.deepEqual(tools.calls.map(item=>item.name),['read_metrics','diagnose_execution']);
});

test('existing-order prose rejects a different known issuer and repairs from the cited target', async () => {
  const ledger = [];
  const tools = {
    context:{contractVersion:'test-v1',banks:[
      {bankId:'CMB',label:'招商银行'},{bankId:'ICBC',label:'工商银行'}],
      securities:[{securityId:'CMB-CD-120',label:'招商银行120天存单'},
        {securityId:'ICBC-CD-120',label:'工商银行120天存单'}]},
    definitions:[{type:'function',function:{name:'plan_trades',description:'Plan',
      parameters:{type:'object',properties:{},required:[],additionalProperties:false}}}],
    execute(name) {
      const result = {status:'feasible',main:{financingYuan:394_000_000,
        reverseRepoYuan:4_000_000},existingFixedTargets:[{businessType:'cd_buy',
        securityId:'CMB-CD-120',securityLabel:'招商银行120天存单',issuerBankId:'CMB',
        issuerBankLabel:'招商银行',targetYuan:300_000_000,remainingYuan:300_000_000}]};
      ledger.push({toolName:name,result});
      return structuredClone(result);
    },
    getEvidence:() => structuredClone(ledger),
  };
  const scripted = scriptedFetch([
    toolTurn(toolCall('plan','plan_trades')),
    finalTurn({kind:'answer',references:['plan'],
      narrative:'这笔工商银行120天存单买券需要新增融资3.94亿元，逆回购400万元。'}),
    finalTurn({kind:'answer',references:['plan'],
      narrative:'这笔招商银行120天存单买券需要新增融资3.94亿元，逆回购400万元。'}),
  ],(body,index) => {
    if (index === 2) {
      assert.equal(Object.hasOwn(body,'tools'),false);
      assert.match(body.messages[1].content,/招商银行120天存单/);
      assert.match(body.messages[1].content,/工商银行/);
      assert.ok(JSON.stringify(body.messages).length < 5000);
    }
  });
  const output = await invokeAiDialogue({message:'这笔买券单需要融资多少，余款逆回购如何分配？',
    resolved,tools,fetchImpl:scripted.fetchImpl});
  assert.equal(scripted.count,3);
  assert.match(output.dialogue.narrative,/招商银行120天存单/);
  assert.doesNotMatch(output.dialogue.narrative,/工商银行/);
});

test('reverse-repo capacity cannot be described as cash remaining after the buy', async () => {
  const ledger = [];
  const tools = {
    context:{contractVersion:'test-v1'},
    definitions:[{type:'function',function:{name:'plan_trades',description:'Plan',
      parameters:{type:'object',properties:{},required:[],additionalProperties:false}}}],
    execute(name) {
      const result = {status:'feasible',currentPortfolio:{businessAvailableYuan:2_110_000_000},
        existingFixedTargets:[{businessType:'cd_buy',securityId:'CMB-CD-120',
          securityLabel:'招商银行120天存单',targetYuan:300_000_000}],
        main:{applicable:true,financingYuan:394_000_000,reverseRepoYuan:4_000_000,
          projectedFinalCashYuan:2_200_000_000},
        allocationBasis:{projectedBusinessBeforeNewReverseRepoYuan:2_204_000_000,
          projectedBusinessAfterPlanYuan:2_200_000_000,c02ReverseRepoCeilingYuan:104_000_000,
          firstExcludedReverseRepoYuan:5_000_000,limitingRuleIds:['C09'],
          reverseRepoLimitIsNotCashBalance:true}};
      ledger.push({toolName:name,result});
      return structuredClone(result);
    },
    getEvidence:() => structuredClone(ledger),
  };
  const scripted = scriptedFetch([
    toolTurn(toolCall('plan','plan_trades')),
    finalTurn({kind:'answer',references:['plan'],narrative:
      '新增融资3.94亿元，扣除买券3亿元后剩余资金仅400万元，故逆回购只能安排400万元。'}),
    finalTurn({kind:'answer',references:['plan'],narrative:
      '新增融资3.94亿元、逆回购400万元。买券后、逆回购前的预计业务头寸为22.04亿元；C02可容纳1.04亿元逆回购，但下一档500万元触发C09限制，因此本方案仅安排400万元逆回购。经理确认主方案后，方案只加入指令区，须手动计算、审核并下达到投管。'}),
  ],(body,index) => {
    if (index === 2) {
      assert.equal(Object.hasOwn(body,'tools'),false);
      assert.match(body.messages[0].content,/可投额度不是买券后现金余额/);
      assert.match(body.messages[1].content,/C09/);
      assert.match(body.messages[1].content,/不是买券后现金余额/);
      assert.match(body.messages[0].content,/只加入指令区.*手动计算、审核并下达到投管/);
      assert.doesNotMatch(body.messages[0].content,/确认并按主方案下单|本地重算、审核并下达/);
      assert.ok(JSON.stringify(body.messages).length < 7500);
    }
  });
  const output = await invokeAiDialogue({message:'这笔买券单需要融资多少，余款逆回购如何分配？',
    resolved,tools,fetchImpl:scripted.fetchImpl});
  assert.equal(scripted.count,3);
  assert.match(output.dialogue.narrative,/C09限制/);
  assert.doesNotMatch(output.dialogue.narrative,/剩余资金仅400万元/);
});

test('a repair cannot drop required diagnosis or introduce a new citation', async () => {
  const tools = diagnosisFixture();
  const output = await invokeAiDialogue({message:'下一步如何继续未完成交易？',resolved,tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics','read_metrics')),
      toolTurn(toolCall('diagnosis','diagnose_execution')),
      finalTurn({kind:'answer',references:['metrics','diagnosis'],narrative:'还有99亿元未完成。'}),
      finalTurn({kind:'answer',references:['metrics'],narrative:'请刷新重算。'}),
    ]).fetchImpl });
  assert.deepEqual(output.dialogue.references,['metrics','diagnosis']);
  assert.equal(Object.hasOwn(output.dialogue,'narrative'),false);
});

test('second unsupported narrative safely falls back after one repair attempt', async () => {
  const tools = diagnosisFixture();
  const scripted = scriptedFetch([
    toolTurn(toolCall('diagnosis', 'diagnose_execution')),
    finalTurn({ kind: 'answer', references: ['diagnosis'], narrative: 'C02余量1.3亿元。' }),
    finalTurn({ kind: 'answer', references: ['diagnosis'], narrative: 'C02余量仍是1.3亿元。' }),
  ]);
  const output = await invokeAiDialogue({ message: '下一步如何完成全部交易？', resolved, tools,
    fetchImpl: scripted.fetchImpl });
  assert.equal(scripted.count, 3);
  assert.equal(Object.hasOwn(output.dialogue, 'narrative'), false);
  assert.match(output.dialogue.answer, /现金比例5\.02%/);
  assert.match(output.dialogue.answer, /实际账户现金21亿元/);
  assert.match(output.dialogue.answer, /比例现金基数34亿元/);
  assert.match(output.dialogue.answer, /刷新执行快照/);
  assert.match(output.dialogue.answer, /避免相同资金被重复计入/);
  assert.doesNotMatch(output.dialogue.answer, /diagnose_execution|read_metrics|call_|attention|1290000000/);
  assert.deepEqual(tools.calls.map(call => call.name), ['diagnose_execution']);
});

test('diagnosis fallback describes a negative C02 margin as below the threshold', async () => {
  const tools = diagnosisFixture({ margin: -0.5 });
  const output = await invokeAiDialogue({ message: '下一步如何处理？', resolved, tools,
    fetchImpl: scriptedFetch([
      toolTurn(toolCall('diagnosis', 'diagnose_execution')),
      finalTurn({ kind: 'answer', references: ['diagnosis'] }),
    ]).fetchImpl });
  assert.match(output.dialogue.answer, /低于下限0\.5个百分点/);
  assert.match(output.dialogue.answer, /金额缺口2\.5亿元/);
  assert.doesNotMatch(output.dialogue.answer, /高于下限-/);
});

test('repair turn cannot execute a tool even if the provider returns a tool call', async () => {
  const tools = diagnosisFixture();
  const scripted = scriptedFetch([
    toolTurn(toolCall('diagnosis', 'diagnose_execution')),
    finalTurn({ kind: 'answer', references: ['diagnosis'], narrative: 'C02余量1.3亿元。' }),
    toolTurn(toolCall('second_diagnosis', 'diagnose_execution')),
  ]);
  const output = await invokeAiDialogue({ message: '下一步如何完成全部交易？', resolved, tools,
    fetchImpl: scripted.fetchImpl });
  assert.equal(scripted.count, 3);
  assert.deepEqual(tools.calls.map(call => call.name), ['diagnose_execution']);
  assert.equal(Object.hasOwn(output.dialogue, 'narrative'), false);
});

test('unverified narrative amounts fall back to evidence; extra fields still fail', async () => {
  for (const narrative of ['另有200万元未完成。', '17.600000001亿元待到账。',
    '1e2亿元待到账。', 'x'.repeat(3001), '<b>执行</b>']) {
    const output = await invokeAiDialogue({ message: '执行诊断', resolved, tools: diagnosisFixture(),
      fetchImpl: scriptedFetch([toolTurn(toolCall('diagnosis', 'diagnose_execution')),
        finalTurn({ kind: 'answer', references: ['diagnosis'], narrative })]).fetchImpl });
    assert.equal(Object.hasOwn(output.dialogue, 'narrative'), false);
    assert.match(output.dialogue.answer, /合计尚余12\.9亿元/);
  }
  await assert.rejects(invokeAiDialogue({ message: '执行诊断', resolved, tools: diagnosisFixture(),
    fetchImpl: scriptedFetch([toolTurn(toolCall('diagnosis', 'diagnose_execution')),
      finalTurn({ kind: 'answer', references: ['diagnosis'], narrative: '还有100万元。', approve: true })]).fetchImpl }),
  { code: 'AI_DIALOGUE_INVALID' });
  const output = await invokeAiDialogue({ message: '查看当前指标', resolved, tools: fixture(),
    fetchImpl: scriptedFetch([toolTurn(toolCall()), finalTurn({ kind: 'answer', references: ['call_1'] })]).fetchImpl });
  assert.equal(Object.hasOwn(output.dialogue, 'narrative'), false);
});

test('repeated calls of the same tool keep distinct call IDs in the reminder and references', async () => {
  const tools = fixture();
  const scripted = scriptedFetch([
    toolTurn(toolCall('metric_first')),
    toolTurn(toolCall('metric_second')),
    finalTurn({ kind: 'answer', references: ['metric_first', 'metric_second'] }),
  ], (body, index) => {
    if (index === 2) {
      const reminder = body.messages.at(-1);
      assert.equal(reminder.role, 'system');
      assert.match(reminder.content, /"callId":"metric_first","name":"read_metrics"/);
      assert.match(reminder.content, /"callId":"metric_second","name":"read_metrics"/);
      assert.match(reminder.content, /"references":\["metric_second"\]/);
    }
  });
  const output = await invokeAiDialogue({ message: '对比当前指标', resolved, tools, fetchImpl: scripted.fetchImpl });
  assert.equal(tools.calls.length, 2);
  assert.deepEqual(output.dialogue.references, ['metric_first', 'metric_second']);
  assert.deepEqual(output.dialogue.evidence.map(row => row.callId), ['metric_first', 'metric_second']);
  assert.equal(scripted.count, 3);
});

test('a later planning result supersedes earlier planning evidence', async () => {
  function planningTools() {
    const ledger = [];
    return { context: { contractVersion: 'test-v1', plans: [{ planId: 'existing-repo' }] },
      definitions: [{ type: 'function', function: { name: 'plan_trades', description: 'Plan main and alternative',
        parameters: { type: 'object', properties: { allowReduceReverseRepo: { type: 'boolean' } },
          required: ['allowReduceReverseRepo'], additionalProperties: false } } }],
      execute(name, args) {
        assert.equal(args.allowReduceReverseRepo, true);
        const result = { status: 'feasible', main: { applicable:true, status: 'feasible', financingYuan: (ledger.length + 1) * 100,
          reverseRepoYuan: 200, projectedFinalCashYuan: 50, requiresTargetChange: false } };
        ledger.push({ toolName: name, result });
        return result;
      }, getEvidence: () => structuredClone(ledger) };
  }
  const turns = decision => [
    toolTurn(toolCall('old_plan', 'plan_trades', '{"allowReduceReverseRepo":true}')),
    toolTurn(toolCall('new_plan', 'plan_trades', '{"allowReduceReverseRepo":true}')),
    finalTurn(decision),
  ];
  await assert.rejects(invokeAiDialogue({ message: '做主备测算', resolved, tools: planningTools(),
    fetchImpl: scriptedFetch(turns({ kind: 'answer', references: ['old_plan'] }), (body, index) => {
      if (index === 0) assert.match(body.messages[0].content, /allowReduceReverseRepo:true/);
    }).fetchImpl }), { code: 'AI_DIALOGUE_INVALID' });
  const output = await invokeAiDialogue({ message: '做主备测算', resolved, tools: planningTools(),
    fetchImpl: scriptedFetch(turns({ kind: 'answer', references: ['new_plan'] }), (body, index) => {
      if (index === 2) assert.match(body.messages.at(-1).content, /最新plan_trades调用ID是new_plan/);
    }).fetchImpl });
  assert.deepEqual(output.dialogue.references, ['new_plan']);
  assert.equal(output.dialogue.evidence[0].result.main.financingYuan, 200);
  assert.match(output.text, /融资0\.000002亿元/);
  assert.doesNotMatch(output.text, /融资0\.000001亿元|plan_trades|new_plan/);
});

test('clarification can finish without a tool call or claimed numeric result', async () => {
  const scripted = scriptedFetch([finalTurn({ kind: 'clarification', question: '请补充逆回购期限。' })]);
  const output = await invokeAiDialogue({ message: '拟定逆回购', resolved, tools: fixture(), fetchImpl: scripted.fetchImpl });
  assert.deepEqual(output.dialogue, { status: 'clarification', answer: '请补充逆回购期限。', references: [], evidence: [],
    basis: { documentRevision: null, runId: null, contractVersion: 'test-v1', knowledgeVersion: null,
      toolVersion: null, versions: null, synthetic: false } });
});

test('missing reverse repo term uses seven days even if model asks to clarify it', async () => {
  const {model,intent} = makePlanningFixture('S1');
  const tools = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'default-reverse-clarification',documentRevision:1});
  const args = {fixedTrades:intent.fixedPlans.map(p => ({businessType:p.businessType,
    securityId:p.securityId,targetYuan:p.targetYuan})),reverseRepo:{}};
  const output = await invokeAiDialogue({
    message:'新增买券，剩余资金安排逆回购。',resolved,tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('plan','plan_trades',JSON.stringify(args))),
      finalTurn({kind:'clarification',question:'请补充逆回购期限。'}),
    ]).fetchImpl,
  });
  assert.equal(output.dialogue.status,'answer');
  assert.deepEqual(output.dialogue.references,['plan']);
  assert.equal(output.dialogue.evidence[0].result.intent.reverseRepo.tenorDays,7);
  assert.match(output.text,/默认7天/);
});

test('one missing outer JSON brace is repaired before ordinary evidence validation', async () => {
  const incomplete = JSON.stringify({kind:'answer',references:['metrics'],
    narrative:'当前账户现金100元。'}).slice(0,-1);
  const output = await invokeAiDialogue({message:'查看当前指标',resolved,tools:fixture(),
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics')),
      completion({role:'assistant',content:incomplete}),
    ]).fetchImpl });
  assert.equal(output.text,'当前账户现金100元。');
  assert.deepEqual(output.dialogue.references,['metrics']);
});

test('a missing brace cannot bypass numeric checks and gets one prose repair', async () => {
  const tools = fixture();
  const incomplete = JSON.stringify({kind:'answer',references:['metrics'],
    narrative:'当前账户现金2亿元。'}).slice(0,-1);
  const scripted = scriptedFetch([
    toolTurn(toolCall('metrics')),
    completion({role:'assistant',content:incomplete}),
    finalTurn({kind:'answer',references:['metrics'],narrative:'当前账户现金100元。'}),
  ],(body,index)=>{if(index===2) {
    assert.equal(Object.hasOwn(body,'tool_choice'),false);
    assert.equal(Object.hasOwn(body,'tools'),false);
  }});
  const output = await invokeAiDialogue({message:'查看当前指标',resolved,tools,
    fetchImpl:scripted.fetchImpl});
  assert.equal(scripted.count,3);
  assert.equal(output.text,'当前账户现金100元。');
  assert.equal(tools.calls.length,1);
});

test('other malformed final JSON is still rejected', async () => {
  await assert.rejects(invokeAiDialogue({message:'查看当前指标',resolved,tools:fixture(),
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics')),
      completion({role:'assistant',content:'{"kind":"answer",references:["metrics"]'}),
    ]).fetchImpl}),{code:'AI_DIALOGUE_INVALID'});
});

test('bounded prior turns provide context without becoming evidence', async () => {
  const history = [{ userMessage: '先看存款方案。', assistantAnswer: '请明确存款对象。' }];
  const scripted = scriptedFetch([finalTurn({ kind: 'clarification', question: '请提供这笔存款的具体银行和期限。' })],
    body => {
      assert.match(body.messages[1].content, /先看存款方案/);
      assert.match(body.messages[0].content, /历史只用于理解代词/);
      assert.match(body.messages[0].content, /简单问题直接简答/);
    });
  const output = await invokeAiDialogue({ message: '那这笔呢？', history, resolved, tools: fixture(),
    fetchImpl: scripted.fetchImpl });
  assert.equal(output.dialogue.status, 'clarification');
  await assert.rejects(invokeAiDialogue({ message: '继续', history: [{ userMessage: 'a', assistantAnswer: '<b>x</b>' }],
    resolved, tools: fixture(), fetchImpl: scripted.fetchImpl }), { code: 'AI_PROMPT_INVALID' });
});

test('a new planning request beginning with next step does not require execution diagnosis', async () => {
  const output = await invokeAiDialogue({ message: '下一步新增一笔存款，请给主备方案。', resolved,
    tools: fixture(), fetchImpl: scriptedFetch([
      finalTurn({ kind: 'clarification', question: '请明确存款银行、期限和意向金额。' }),
    ]).fetchImpl });
  assert.equal(output.dialogue.status, 'clarification');
});

test('a proposed new trade needs a successful planning result, not only current metrics', async () => {
  await assert.rejects(invokeAiDialogue({ message: '新增一笔存款，请给主备方案。', resolved,
    tools: fixture(), fetchImpl: scriptedFetch([
      toolTurn(toolCall('metrics')),
      finalTurn({ kind: 'answer', references: ['metrics'], narrative: '可以新增这笔存款。' }),
    ]).fetchImpl }), { code: 'AI_DIALOGUE_INVALID' });
});

test('an unrequested zero reverse repo cannot bypass missing tenor in a new trade request', async () => {
  const {model} = makePlanningFixture('S1');
  const tools = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'zero-bypass',documentRevision:1});
  const output = await invokeAiDialogue({message:'新增一笔存单，按现有业务口径给我方案。',resolved,tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('invalid_zero','plan_trades',JSON.stringify({
        fixedTrades:[{businessType:'cd_buy',securityId:'AI-A-CD-120',targetYuan:15*100_000_000}],
        reverseRepo:{amountYuan:0},
      }))),
      finalTurn({kind:'clarification',question:'请明确新增逆回购的期限；未指定金额时会按约束安排余款。'}),
    ]).fetchImpl });
  assert.equal(output.dialogue.status,'clarification');
  assert.match(tools.getEvidence()[0].result.errors[0],/不可用零目标规避余款安排/);
  const explicitTools = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'explicit-zero',documentRevision:1});
  const explicit = await invokeAiDialogue({message:'我明确不做逆回购，只新增这笔存单。',
    resolved,tools:explicitTools,fetchImpl:scriptedFetch([
      toolTurn(toolCall('zero_plan','plan_trades',JSON.stringify({
        fixedTrades:[{businessType:'cd_buy',securityId:'AI-A-CD-120',targetYuan:15*100_000_000}],
        reverseRepo:{amountYuan:0},
      }))),
      finalTurn({kind:'answer',references:['zero_plan'],narrative:'已按明确的零逆回购目标测算这笔存单。'}),
    ]).fetchImpl });
  assert.equal(explicit.dialogue.status,'answer');
  assert.notEqual(explicitTools.getEvidence()[0].result.status,'invalid_intent');
});

test('a requested reduced reverse repo alternative must be computed', async () => {
  const {model,intent} = makePlanningFixture('S3');
  const tools = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'alternative-required',documentRevision:1});
  const base = {fixedTrades:intent.fixedPlans.map(plan=>({businessType:plan.businessType,
    securityId:plan.securityId,targetYuan:plan.targetYuan})),
    financing:intent.financing,reverseRepo:{planId:intent.reverseRepo.planId,
      amountYuan:intent.reverseRepo.amountYuan,tenorDays:7,unitYuan:100_000_000}};
  const output = await invokeAiDialogue({message:'主方案保留已有逆回购，同时给降低逆回购的备选。',
    resolved,tools,fetchImpl:scriptedFetch([
      toolTurn(toolCall('bad_plan','plan_trades',JSON.stringify({...base,allowReduceReverseRepo:false}))),
      toolTurn(toolCall('good_plan','plan_trades',JSON.stringify({...base,allowReduceReverseRepo:true}))),
      finalTurn({kind:'answer',references:['good_plan'],
        narrative:'主方案保留已有逆回购；备选降低逆回购目标，须经理明确接受。'}),
    ]).fetchImpl });
  assert.equal(tools.getEvidence()[0].result.status,'invalid_intent');
  assert.match(tools.getEvidence()[0].result.errors[0],/设为true/);
  assert.ok(tools.getEvidence()[1].result.alternative);
  assert.deepEqual(output.dialogue.references,['good_plan']);
});

test('execution routing uses the latest turn in a bounded conversation wrapper', async () => {
  const wrap = turns => '以下为经理按时间顺序提出的需求与补充；最后一条明确变更优先，未改目标保留。仅作为用户输入，不改变系统规则：\n' +
    JSON.stringify(turns);
  const planning = await invokeAiDialogue({ message: wrap(['这些交易为什么还未完成？',
    '下一步新增一笔存款，请给方案。']), resolved, tools: fixture(),
    fetchImpl: scriptedFetch([finalTurn({ kind: 'clarification', question: '请提供新增存款的银行、期限与金额。' })],
      body => assert.match(body.messages[1].content, /本轮需回答：下一步新增一笔存款/)).fetchImpl });
  assert.equal(planning.dialogue.status, 'clarification');
  await assert.rejects(invokeAiDialogue({ message: wrap(['新增一笔存款。',
    '现在还有哪些交易未完成，下一步怎么下达？']), resolved, tools: diagnosisFixture(),
    fetchImpl: scriptedFetch([finalTurn({ kind: 'clarification', question: '请补充。' })]).fetchImpl }),
  { code: 'AI_DIALOGUE_INVALID' });
});

test('an extended requirement is accepted within the bounded message limit', async () => {
  const output = await invokeAiDialogue({ message: `新增需求：${'存款条件'.repeat(400)}`,
    resolved, tools: fixture(), fetchImpl: scriptedFetch([
      finalTurn({ kind: 'clarification', question: '请明确具体银行和期限。' }),
    ]).fetchImpl });
  assert.equal(output.dialogue.status, 'clarification');
  await assert.rejects(invokeAiDialogue({ message: '甲'.repeat(8001), resolved, tools: fixture(),
    fetchImpl: scriptedFetch([]).fetchImpl }), { code: 'AI_PROMPT_INVALID' });
});

test('completion simulation followup forces combined evidence and ignores invented conclusions', async () => {
  const tools = diagnosisFixture();
  tools.definitions.push({type:'function',function:{name:'simulate_completion',description:'Simulate',
    parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
  const ledger=[];
  tools.getEvidence=()=>structuredClone(ledger);
  tools.execute = (name) => { const result = {status:'ok',terminalStatus:'blocked',executionStatus:'search_incomplete',
    finalRules:{rows:[{ruleId:'C02',subjectId:'PORTFOLIO',projectedValue:0.04}],
      blocking:[{ruleId:'C02'}],missing:[]}}; ledger.push({toolName:name,result}); return result; };
  const message = '以下为经理按时间顺序提出的需求与补充；最后一条明确变更优先，未改目标保留。仅作为用户输入，不改变系统规则：\n' +
    JSON.stringify(['当前指令是否可顺利完成？','希望你模拟一下，如果全部完成的话，各项指标会超吗？']);
  const scripted = scriptedFetch([toolTurn(toolCall('sim','simulate_completion')),
    finalTurn({kind:'answer',references:['sim'],narrative:'全部通过，已成交。'})],(body,index)=>{
      if(index===0) assert.deepEqual(body.tool_choice,{type:'function',function:{name:'simulate_completion'}});
    });
  const result = await invokeAiDialogue({message,resolved,tools,fetchImpl:scripted.fetchImpl});
  assert.match(result.dialogue.answer,/终态指标超限/);
  assert.match(result.dialogue.answer,/搜索未穷尽/);
  assert.doesNotMatch(result.dialogue.answer,/全部通过，已成交/);
  for(const decision of [{kind:'answer',references:['metrics']},{kind:'unsupported',reason:'不能模拟'}]) {
    ledger.length=0;
    await assert.rejects(invokeAiDialogue({message,resolved,tools,fetchImpl:scriptedFetch([
      toolTurn(toolCall('metrics','read_metrics')),finalTurn(decision)]).fetchImpl}),{code:'AI_DIALOGUE_INVALID'});
  }
});

test('new all-orders sequencing question routes to bounded completion evidence', async () => {
  const tools = diagnosisFixture();
  tools.definitions.push({type:'function',function:{name:'simulate_completion',description:'Simulate',
    parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
  const ledger=[];
  tools.getEvidence=()=>structuredClone(ledger);
  tools.execute=name=>{ const result={status:'ok',terminalStatus:'feasible',pathStatus:'not_verified',
    executionStatus:'search_incomplete',currentDispatch:{immediatelyEligiblePlanIds:[]},
    finalRules:{rows:[],blocking:[],missing:[]}};
    ledger.push({toolName:name,result}); return result; };
  const scripted=scriptedFetch([toolTurn(toolCall('sim','simulate_completion')),
    finalTurn({kind:'answer',references:['sim'],narrative:'已找到合理顺序，全部可执行。'})],
  (body,index)=>{if(index===0)assert.deepEqual(body.tool_choice,
    {type:'function',function:{name:'simulate_completion'}});});
  const output=await invokeAiDialogue({message:'当前所有指令是否有合理顺序可全部完成？',
    resolved,tools,fetchImpl:scripted.fetchImpl});
  assert.match(output.dialogue.answer,/尚未验证出覆盖全部目标/);
  assert.doesNotMatch(output.dialogue.answer,/已找到合理顺序/);
});

function completionEvidenceFixture({navYuan=110_000_000_000, openingYuan=6_000_000_000,
  depositYuan=600_000_000, cdYuan=100_000_000, governmentYuan=2_510_000_000,
  finalAccountYuan=0} = {}) {
  const limitYuan = navYuan * 6 / 100;
  const finalExposureYuan = openingYuan + depositYuan + cdYuan;
  const ledger=[];
  const calls=[];
  const result={status:'ok',terminalStatus:'feasible',pathStatus:'conditional_candidate',
    executionStatus:'waiting_conditions',projectedFinalCashYuan:0,
    projectedFinalAccountCashYuan:finalAccountYuan,
    accountCashProjection:{status:'conditional',currentAccountCashYuan:3_000_000_000,
      projectedFinalAccountCashYuan:finalAccountYuan},
    cashRatioBasis:{governmentBondWithinOneYearYuan:governmentYuan,
      projectedBusinessCashYuan:0,numeratorYuan:governmentYuan,
      denominatorYuan:50_000_000_000,projectedValue:governmentYuan/50_000_000_000},
    currentDispatch:{immediatelyEligiblePlanIds:['sell']},
    depositOrderEvidence:[{bankId:'bank',bankLabel:'建设银行',depositPlanId:'deposit',
      cdPlanIds:['cd'],openingExposureYuan:openingYuan,quarterlyNetAssetsYuan:navYuan,
      thresholdNumerator:6,thresholdDenominator:100,limitYuan,depositYuan,cdYuan,
      depositFirstExposureYuan:openingYuan+depositYuan,
      depositFirstFinalExposureYuan:finalExposureYuan,
      cdFirstIntermediateExposureYuan:openingYuan+cdYuan,
      cdFirstExposureYuan:finalExposureYuan,
      depositFirstGate:{result:'pass',beforeYuan:openingYuan,
        afterYuan:openingYuan+depositYuan,limitYuan},
      cdFirstDepositGate:{result:'block',beforeYuan:openingYuan+cdYuan,
        afterYuan:finalExposureYuan,limitYuan}}],
    executionPath:[{planId:'sell',planLabel:'卖出政府债',nominalYuan:1_300_000_000,
      machineConditions:[{kind:'holding_confirmed'}]},
      {planId:'deposit',planLabel:'建设银行存款',nominalYuan:depositYuan,
        machineConditions:[{kind:'funds_available'},{kind:'filled'}]},
      {planId:'cd',planLabel:'建设银行存单',nominalYuan:cdYuan,
        machineConditions:[{kind:'funds_available'}]}],
    finalRules:{rows:[{ruleId:'C01',subjectId:'PORTFOLIO',projectedValue:0},
      {ruleId:'C02',subjectId:'PORTFOLIO',projectedValue:governmentYuan/50_000_000_000,
        numeratorYuan:governmentYuan,denominatorYuan:50_000_000_000},
      {ruleId:'C09',subjectId:'PORTFOLIO',projectedValue:89.41518547140649}],
      blocking:[],missing:[]}};
  return {calls,result,context:{contractVersion:'test-v1'},definitions:[
    {type:'function',function:{name:'simulate_completion',description:'Simulate',
      parameters:{type:'object',properties:{},required:[],additionalProperties:false}}}],
    execute(name){calls.push(name);ledger.push({toolName:name,result});return structuredClone(result);},
    getEvidence:()=>structuredClone(ledger)};
}

test('three original follow-ups answer order, deposit gate and final cash from fresh simulation evidence', async () => {
  const prompts=[
    '当前所有指令是否有合理顺序可全部完成？请给出顺序和必要前提，保持现有金额与期限，不拟新单，不修改计划。',
    '接着刚才的分析，为什么成都农商银行存款与存单要这样排序？如果交换先后顺序会怎样？不要改变金额或拟新单。',
    '继续追问：按这个顺序全部成交并结算后，头寸和实际现金是否都为0？这是否意味着现金比例C02也为0？同时说明平均剩余期限C09。不拟新单。',
  ];
  const history=[];
  for(let index=0;index<prompts.length;index++) {
    const tools=completionEvidenceFixture();
    const scripted=scriptedFetch([toolTurn(toolCall('sim','simulate_completion')),
      finalTurn({kind:'answer',references:['sim'],narrative:'全部已成交，现金比例为0%。'})],
    (body,call)=>{if(call===0)assert.deepEqual(body.tool_choice,
      {type:'function',function:{name:'simulate_completion'}});});
    const output=await invokeAiDialogue({message:prompts[index],history,resolved,tools,
      fetchImpl:scripted.fetchImpl});
    assert.deepEqual(tools.calls,['simulate_completion']);
    assert.deepEqual(output.dialogue.references,['sim']);
    assert.doesNotMatch(output.dialogue.answer,/全部已成交|现金比例为0%/);
    if(index===0) {
      assert.match(output.dialogue.answer,/1\. 卖出政府债/);
      assert.match(output.dialogue.answer,/2\. 建设银行存款/);
      assert.match(output.dialogue.answer,/3\. 建设银行存单/);
      assert.match(output.dialogue.answer,/可用资金及实际账户付款能力/);
    } else if(index===1) {
      assert.match(output.dialogue.answer,/6%闸门/);
      assert.match(output.dialogue.answer,/原敞口60亿元/);
      assert.match(output.dialogue.answer,/先做存款6亿元后为66亿元/);
      assert.match(output.dialogue.answer,/先买存单后敞口为61亿元/);
      assert.match(output.dialogue.answer,/新增存款被闸门阻断/);
    } else {
      assert.match(output.dialogue.answer,/业务头寸0亿元，实际账户现金0亿元/);
      assert.match(output.dialogue.answer,/一年内政府债25.1亿元/);
      assert.match(output.dialogue.answer,/C02为5.02%/);
      assert.match(output.dialogue.answer,/C09平均剩余期限为89\.41518547140649天/);
    }
    history.push({userMessage:prompts[index],assistantAnswer:output.dialogue.answer});
  }
});

test('completion wording follows changed evidence and withholds unsupported account cash', async () => {
  const tools=completionEvidenceFixture({navYuan:100_000_000_000,openingYuan:5_500_000_000,
    depositYuan:500_000_000,cdYuan:200_000_000,governmentYuan:2_600_000_000});
  const message='建设银行存款和存单为何这个顺序，交换先后会怎样？';
  const order=await invokeAiDialogue({message,resolved,tools,fetchImpl:scriptedFetch([
    toolTurn(toolCall('sim','simulate_completion')),
    finalTurn({kind:'answer',references:['sim']})]).fetchImpl});
  assert.match(order.dialogue.answer,/原敞口55亿元/);
  assert.match(order.dialogue.answer,/先做存款5亿元后为60亿元/);
  assert.match(order.dialogue.answer,/先买存单后敞口为57亿元/);
  assert.match(order.dialogue.answer,/再做整笔存款后为62亿元/);
  assert.doesNotMatch(order.dialogue.answer,/66亿元|67亿元/);
  const committedTools=completionEvidenceFixture();
  committedTools.result.depositOrderEvidence[0].orderComparable=false;
  const committed=await invokeAiDialogue({message,resolved,tools:committedTools,
    fetchImpl:scriptedFetch([toolTurn(toolCall('sim','simulate_completion')),
      finalTurn({kind:'answer',references:['sim']})]).fetchImpl});
  assert.match(committed.dialogue.answer,/已有成交或在途/);
  assert.doesNotMatch(committed.dialogue.answer,/新增存款被闸门阻断/);
  const cashTools=completionEvidenceFixture({governmentYuan:2_600_000_000});
  cashTools.result.accountCashProjection.status='insufficient_data';
  cashTools.result.projectedFinalAccountCashYuan=null;
  const cash=await invokeAiDialogue({message:'全部成交结算后实际现金、C02和C09是多少？',
    resolved,tools:cashTools,fetchImpl:scriptedFetch([
      toolTurn(toolCall('sim','simulate_completion')),
      finalTurn({kind:'answer',references:['sim']})]).fetchImpl});
  assert.match(cash.dialogue.answer,/实际账户现金尚不能/);
  assert.match(cash.dialogue.answer,/一年内政府债26亿元/);
  assert.match(cash.dialogue.answer,/C02为5.2%/);
});

test('an improving path with uncovered targets is described as partial', async () => {
  const tools=completionEvidenceFixture();
  tools.result.executionStatus='improving';
  tools.result.conditionalUnarrangedYuan=100_000_000;
  tools.result.unmetTargets=[{planId:'remaining',unarrangedYuan:100_000_000}];
  const output=await invokeAiDialogue({message:'所有指令是否有合理顺序可全部完成？请给出步骤。',
    resolved,tools,fetchImpl:scriptedFetch([
      toolTurn(toolCall('sim','simulate_completion')),
      finalTurn({kind:'answer',references:['sim'],narrative:'全部指令可以完成。'})]).fetchImpl});
  assert.match(output.dialogue.answer,/有界搜索只找到局部改善路径，仍有目标未覆盖/);
  assert.match(output.dialogue.answer,/已找到的局部改善步骤（仍有目标未覆盖）/);
  assert.match(output.dialogue.answer,/1\. 卖出政府债/);
  assert.doesNotMatch(output.dialogue.answer,/条件完成路径|已验证的条件候选顺序|全部指令可以完成/);
});

test('historical nine-plan fixture completes the original three questions through real read-only tools', async () => {
  const model=createModel();
  model.startFromTemplate(createHistoricalComplexTemplate({businessDate:'2026-10-13'}));
  const snapshot=JSON.parse(model.serialize());
  const serialized=model.serialize();
  const prompts=[
    '当前所有指令是否有合理顺序可全部完成？请给出顺序和必要前提，保持现有金额与期限，不拟新单，不修改计划。',
    '接着刚才的分析，为什么建设银行存款与存单要这样排序？如果交换先后顺序会怎样？不要改变金额或拟新单。',
    '继续追问：按这个顺序全部成交并结算后，头寸和实际现金是否都为0？这是否意味着现金比例C02也为0？同时说明平均剩余期限C09。不拟新单。',
  ];
  const history=[];
  for(let index=0;index<prompts.length;index++) {
    const tools=createPlanningTools(snapshot,{requestId:`dialogue-completion-${index}`,
      documentRevision:1});
    const output=await invokeAiDialogue({message:prompts[index],history,resolved,tools,
      fetchImpl:scriptedFetch([toolTurn(toolCall('sim','simulate_completion')),
        finalTurn({kind:'answer',references:['sim'],narrative:'已经全部完成。'})]).fetchImpl});
    const answer=output.dialogue.answer;
    assert.deepEqual(output.dialogue.references,['sim']);
    assert.equal(output.dialogue.evidence[0].name,'simulate_completion');
    assert.doesNotMatch(answer,/已经全部完成/);
    if(index===0) {
      assert.match(answer,/已验证的条件候选顺序/);
      assert.match(answer,/9\. 银行间逆回购/);
      assert.ok(answer.indexOf('4. 存入成都农商银行')<answer.indexOf('5. 买入成都农商银行新存单'));
      assert.doesNotMatch(answer,/确认融资额度/);
    } else if(index===1) {
      assert.match(answer,/成都农商银行季度净资产1100亿元/);
      assert.match(answer,/先做存款6亿元后为66亿元/);
      assert.match(answer,/先买存单后敞口为61亿元/);
      assert.match(answer,/再做整笔存款后为67亿元；超过66亿元，新增存款被闸门阻断/);
    } else {
      assert.match(answer,/业务头寸0亿元，实际账户现金0亿元/);
      assert.match(answer,/一年内政府债25\.1亿元/);
      assert.match(answer,/C02为5\.02%/);
      assert.match(answer,/C09平均剩余期限为89\.415185/);
    }
    history.push({userMessage:prompts[index],assistantAnswer:answer});
  }
  assert.equal(model.serialize(),serialized);
});

test('columnar rule transport preserves every cell and authoritative evidence', async () => {
  const {model} = makePlanningFixture('S3');
  const tools = createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'columnar',documentRevision:1});
  let checked = false;
  await invokeAiDialogue({message:'查看指标',resolved,tools,
    fetchImpl:scriptedFetch([
      toolTurn(toolCall('rules','read_metrics')),
      finalTurn({kind:'answer',references:['rules']}),
    ], (body,index) => {
      if(index !== 1) return;
      const view = JSON.parse(body.messages.find(row=>row.role==='tool').content);
      const original = tools.getEvidence()[0].result;
      const table = view.currentRules.rows;
      assert.equal(table.format,'columnar-rules-v1');
      const restored = table.values.map(values=>Object.fromEntries(table.columns.map((key,i)=>[key,values[i]])));
      assert.deepEqual(restored,original.currentRules.rows);
      assert.deepEqual({...view.currentRules,rows:restored},original.currentRules);
      assert.ok(JSON.stringify(view).length < JSON.stringify(original).length);
      assert.ok(Array.isArray(original.currentRules.rows));
      checked = true;
    }).fetchImpl});
  assert.equal(checked,true);
});

test('unknown tool, forbidden tool name, malformed arguments and schema extras never execute', async () => {
  for (const call of [
    toolCall('a', 'applyConfirmedDraft'),
    toolCall('a', 'unknown_tool'),
    toolCall('a', 'read_metrics', '{bad'),
    toolCall('a', 'read_metrics', '{"extra":1}'),
  ]) {
    const tools = fixture();
    const scripted = scriptedFetch([toolTurn(call)]);
    await assert.rejects(invokeAiDialogue({ message: '查看指标', resolved, tools, fetchImpl: scripted.fetchImpl }),
      error => error.code === 'AI_TOOL_INVALID' && error.message === 'AI_TOOL_INVALID');
    assert.equal(tools.calls.length, 0);
  }
});

test('duplicate call IDs are rejected before executing a tool batch', async () => {
  const tools = fixture();
  const scripted = scriptedFetch([toolTurn(toolCall('same'), toolCall('same'))]);
  await assert.rejects(invokeAiDialogue({ message: '查看指标', resolved, tools, fetchImpl: scripted.fetchImpl }),
    { code: 'AI_TOOL_INVALID' });
  assert.equal(tools.calls.length, 0);
});

test('unsupported references and answer without evidence are rejected', async () => {
  for (const responses of [
    [finalTurn({ kind: 'answer', references: [] })],
    [toolTurn(toolCall()), finalTurn({ kind: 'answer', references: ['fake'] })],
    [toolTurn(toolCall()), finalTurn({ kind: 'answer', references: ['call_1'], amountYuan: 123 })],
  ]) {
    await assert.rejects(invokeAiDialogue({ message: '查看指标', resolved, tools: fixture(),
      fetchImpl: scriptedFetch(responses).fetchImpl }), { code: 'AI_DIALOGUE_INVALID' });
  }
});

test('request and tool-call budgets stop unbounded loops', async () => {
  const toolResponses = Array.from({ length: 6 }, (_, index) => toolTurn(toolCall(`call_${index}`)));
  const scripted = scriptedFetch(toolResponses);
  await assert.rejects(invokeAiDialogue({ message: '查看指标', resolved, tools: fixture(), fetchImpl: scripted.fetchImpl }),
    { code: 'AI_BUDGET_EXCEEDED' });
  assert.equal(scripted.count, 6);
  const six = Array.from({ length: 6 }, (_, index) => toolCall(`call_${index}`));
  const tooMany = scriptedFetch([toolTurn(...six), toolTurn(toolCall('call_7'),toolCall('call_8'),toolCall('call_9'))]);
  await assert.rejects(invokeAiDialogue({ message: '查看指标', resolved, tools: fixture(), fetchImpl: tooMany.fetchImpl }),
    { code: 'AI_BUDGET_EXCEEDED' });
});

test('cancellation shares the provided signal and never starts the tool', async () => {
  const controller = new AbortController();
  const tools = fixture();
  const fetchImpl = async (_, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort();
    throw new Error(`network failure with ${credential}`);
  };
  await assert.rejects(invokeAiDialogue({ message: '查看指标', resolved, signal: controller.signal, tools, fetchImpl }),
    error => error.code === 'AI_ABORTED' && !error.message.includes(credential));
  assert.equal(tools.calls.length, 0);
});

test('redirect and oversized response are rejected without parsing provider body', async () => {
  const redirect = async () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.example/' } });
  await assert.rejects(invokeAiDialogue({ message: '查看指标', resolved, tools: fixture(), fetchImpl: redirect }),
    { code: 'AI_PROVIDER_ERROR' });
  const oversized = async () => new Response('x', { status: 200, headers: { 'content-length': '1000000' } });
  await assert.rejects(invokeAiDialogue({ message: '查看指标', resolved, tools: fixture(), fetchImpl: oversized }),
    { code: 'AI_PROVIDER_INVALID' });
});


