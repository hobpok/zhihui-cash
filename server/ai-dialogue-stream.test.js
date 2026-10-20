import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeAiDialogue } from './ai-dialogue.js';
import { readablePreview, readCompletionStream } from './ai-stream.js';

const resolved = { state:'real_ready', config:{mode:'real',provider:'deepseek',model:'deepseek-flash'},
  credential:'synthetic-test-key' };
const encoder = new TextEncoder();
const usage = {prompt_tokens:10,completion_tokens:5};
function toolsFixture() {
  const ledger = [];
  return { context:{contractVersion:'synthetic-v1'}, definitions:[{type:'function',function:{
    name:'read_metrics',description:'Synthetic metrics',parameters:{type:'object',properties:{},additionalProperties:false}}}],
  execute(name, args) {
    assert.equal(name, 'read_metrics'); assert.deepEqual(args, {});
    const result = {status:'ok',portfolio:{navYuan:100,accountCashYuan:80,businessAvailableYuan:90}};
    ledger.push({toolName:name,result}); return result;
  }, getEvidence:() => structuredClone(ledger) };
}
const event = packet => `data: ${JSON.stringify(packet)}\r\n\r\n`;
const chunk = (delta = {}, finish_reason = null, extra = {}) => ({object:'chat.completion.chunk',
  choices:[{index:0,delta,finish_reason}], ...extra});
const end = (reason = 'stop') => event(chunk({}, reason, {usage})) + 'data: [DONE]\r\n\r\n';
const answer = text => JSON.stringify({kind:'clarification',question:text});
function response(parts, {close = true, onCancel} = {}) {
  return new Response(new ReadableStream({start(controller) {
    for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
    if (close) controller.close();
  }, cancel:onCancel}), {headers:{'Content-Type':'text/event-stream'}});
}
function fetchRounds(rounds, inspect = () => {}) {
  let index = 0;
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, {include_usage:true});
    inspect(body, index);
    const next = rounds[index++];
    assert.ok(next, 'unexpected extra provider round');
    return typeof next === 'function' ? next() : response(next);
  };
}
const invoke = options => invokeAiDialogue({message:'请补充说明',resolved,tools:toolsFixture(),...options});
const validQuestionParts = text => [event(chunk({role:'assistant',content:answer(text)})),end()];

test('preview arrives before provider completion and never publishes JSON, reasoning or nested values', async () => {
  const notices = [];
  let control, completed = false;
  const first = event(chunk({role:'assistant',content:'{"kind":"clarification","question":"正在'}));
  const pending = invoke({onProgress:notice => notices.push(notice),fetchImpl:fetchRounds([() =>
    new Response(new ReadableStream({start(controller) {
      control = controller; controller.enqueue(encoder.encode(first));
    }}), {headers:{'content-type':'text/event-stream'}})])}).then(result => {completed = true; return result;});
  // The HTTP body remains open with neither a finish chunk nor DONE.
  for (let attempt = 0; attempt < 10 && !notices.some(item => item.text === '正在'); attempt++)
    await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(completed, false);
  assert.ok(notices.some(item => item.type === 'preview' && item.text === '正在'));
  control.enqueue(encoder.encode(event(chunk({content:'核对。"}'})) + end()));
  control.close();
  const result = await pending;
  assert.equal(result.text, '正在核对。');
  assert.equal(notices.at(-1).phase, 'validating');
  assert.deepEqual(notices.filter(item => item.type === 'preview').map(item => item.text), ['', '正在', '正在核对。']);
  assert.equal(JSON.stringify(notices).includes('kind'), false);
  assert.equal(readablePreview('{"secret":{"narrative":"不得出现"},"question":"可以展示'), '可以展示');
  assert.equal(readablePreview('{"tool_calls":[{"function":{"arguments":"不得出现"}}]}'), '');
  assert.equal(readablePreview('{"reasoning_content":"不得出现"}'), '');
});

test('UTF-8 bytes, CRLF, JSON escapes and surrogate pairs survive arbitrary transport fragments', async () => {
  const source = event(chunk({role:'assistant',content:'```json\n{"kind":"clarification","question":"中文\\n\\uD83D\\uDE00"}\n```'})) + end();
  const data = encoder.encode(source);
  const notices = [];
  const result = await invoke({onProgress:notice => notices.push(notice),
    fetchImpl:fetchRounds([Array.from(data, byte => new Uint8Array([byte]))])});
  assert.equal(result.text, '中文\n😀');
  assert.ok(notices.some(item => item.text === '中文\n😀'));
  assert.equal(readablePreview('{"question":"\\uD83D'), '');
  assert.equal(readablePreview('{"question":"甲\\uD83D\\uDE'), '甲');
  assert.equal(readablePreview('{"question":"甲\\'), '甲');
});

test('fragmented tool calls rebuild IDs, names and arguments; tool evidence stays out of previews', async () => {
  const notices = [];
  const rounds = [[
    event(chunk({role:'assistant',content:null,tool_calls:[{index:0,id:'call_',type:'function',function:{name:'read_',arguments:'{'}}]})),
    event(chunk({tool_calls:[{index:0,id:'1',function:{name:'metrics',arguments:'}'}}]})),
    end('tool_calls'),
  ], [event(chunk({content:'{"kind":"answer","references":["call_1"],"narrative":"已核对当前指标。"}'})),end()]];
  const result = await invoke({message:'查看当前指标',onProgress:notice => notices.push(notice),
    fetchImpl:fetchRounds(rounds, (body, index) => {
      if (index === 1) {
        assert.deepEqual(body.messages[2].tool_calls, [{id:'call_1',type:'function',function:{name:'read_metrics',arguments:'{}'}}]);
        assert.equal(body.messages[3].role, 'tool');
      }
    })});
  assert.equal(result.text, '已核对当前指标。');
  assert.deepEqual(result.usage, {inputTokens:20,outputTokens:10});
  assert.ok(notices.some(item => item.phase === 'tools'));
  assert.deepEqual(notices.filter(item => item.type === 'preview' && !item.text).map(item => item.round), [0,1]);
  assert.equal(JSON.stringify(notices).includes('accountCashYuan'), false);
  assert.equal(JSON.stringify(notices).includes('call_1'), false);
});

test('legacy usage-only final chunk remains supported', async () => {
  const result = await invoke({onProgress() {}, fetchImpl:fetchRounds([[
    event(chunk({content:answer('请补充对象。')})),event(chunk({},'stop')),
    event({object:'chat.completion.chunk',choices:[],usage}),'data: [DONE]\n\n',
  ]])});
  assert.deepEqual(result.usage, {inputTokens:10,outputTokens:5});
});

test('repair starts a new preview round and final authority replaces rejected numeric claims', async () => {
  const notices = [];
  const result = await invoke({message:'查看当前指标',onProgress:notice => notices.push(notice),fetchImpl:fetchRounds([
    [event(chunk({tool_calls:[{index:0,id:'m',type:'function',function:{name:'read_metrics',arguments:'{}'}}]})),end('tool_calls')],
    [event(chunk({content:JSON.stringify({kind:'answer',references:['m'],narrative:'实际账户现金999元。'})})),end()],
    [event(chunk({content:JSON.stringify({kind:'answer',references:['m'],narrative:'实际账户现金80元。'})})),end()],
  ], (body, index) => {if (index === 2) assert.equal(body.tools, undefined);})});
  assert.equal(result.text, '实际账户现金80元。');
  const previews = notices.filter(item => item.type === 'preview');
  const rejected = previews.findIndex(item => item.text.includes('999'));
  assert.ok(rejected >= 0);
  assert.deepEqual(previews[rejected + 1], {type:'preview',text:'',round:2});
  assert.equal(JSON.stringify(result).includes('999'), false);
});

test('application/json compatibility returns one full result without simulated typing', async () => {
  const notices = [];
  const result = await invoke({onProgress:notice => notices.push(notice),fetchImpl:fetchRounds([() => new Response(JSON.stringify({
    object:'chat.completion',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:answer('请提供对象。')}}],usage,
  }),{headers:{'content-type':'application/json; charset=utf-8'}})])});
  assert.equal(result.text, '请提供对象。');
  assert.deepEqual(notices.filter(item => item.type === 'preview'), [{type:'preview',text:'',round:0}]);
});

test('sync and async notification errors cannot change validated dialogue', async () => {
  for (const onProgress of [() => {throw new Error('notification failed');}, async () => {throw new Error('notification failed');}]) {
    const result = await invoke({onProgress,fetchImpl:fetchRounds([validQuestionParts('请补充对象。')])});
    assert.equal(result.text, '请补充对象。');
  }
});

test('truncated stream, missing finish or usage, malformed packets and invalid UTF-8 fail closed', async () => {
  const cases = [
    [event(chunk({content:answer('请补充对象。')}))],
    [event(chunk({content:answer('请补充对象。')})), 'data: [DONE]\n\n'],
    [event(chunk({content:answer('请补充对象。')})),event(chunk({},'stop')),'data: [DONE]\n\n'],
    ['data: {bad json}\n\n'],
    [new Uint8Array([0xc3,0x28])],
    [event(chunk({content:answer('请补充对象。')})),event(chunk({},'length',{usage})),'data: [DONE]\n\n'],
    [event(chunk({reasoning_content:'private reasoning'})),end()],
    [event(chunk({content:answer('请补充对象。')},null,{usage})),end()],
    [event(chunk({tool_calls:[{index:1,id:'bad',type:'function',function:{name:'read_metrics',arguments:'{}'}}]})),end('tool_calls')],
  ];
  for (const parts of cases) await assert.rejects(invoke({onProgress() {},fetchImpl:fetchRounds([parts])}), {code:'AI_PROVIDER_INVALID'});
});

test('bad tool argument fragments still pass through original schema validation before execution', async () => {
  const tools = toolsFixture(); let executed = false;
  tools.execute = () => {executed = true;};
  await assert.rejects(invoke({tools,onProgress() {},fetchImpl:fetchRounds([[
    event(chunk({tool_calls:[{index:0,id:'bad',type:'function',function:{name:'read_metrics',arguments:'{"extra":true}'}}]})),end('tool_calls'),
  ]])}), {code:'AI_TOOL_INVALID'});
  assert.equal(executed, false);
});

test('streamed usage is mandatory and existing per-request token budgets still apply', async () => {
  const parts = [event(chunk({content:answer('请补充对象。')})),
    event(chunk({},'stop',{usage:{prompt_tokens:10,completion_tokens:2049}})),'data: [DONE]\n\n'];
  await assert.rejects(invoke({onProgress() {},fetchImpl:fetchRounds([parts])}), {code:'AI_PROVIDER_INVALID'});
});

test('abort during an open provider stream cancels its reader and returns no final decision', async () => {
  const controller = new AbortController(); let cancelled = false;
  const notices = [];
  const pending = invoke({signal:controller.signal,onProgress:notice => notices.push(notice),fetchImpl:fetchRounds([() =>
    response([event(chunk({content:'{"question":"尚未完成'}))],{close:false,onCancel() {cancelled = true;}})])});
  for (let attempt = 0; attempt < 10 && !notices.some(item => item.text === '尚未完成'); attempt++)
    await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, {code:'AI_ABORTED'});
  assert.equal(cancelled, true);
});

test('stream reader retains idle timeout and independent wire/reconstructed byte limits', async () => {
  let cancelled = false;
  await assert.rejects(readCompletionStream(response([], {close:false,onCancel() {cancelled = true;}}),{idleTimeoutMs:5}), {code:'AI_PROVIDER_INVALID'});
  assert.equal(cancelled, true);
  await assert.rejects(readCompletionStream(response([event(chunk({content:'a'.repeat(20)})),end()]), {maxResponseBytes:10}), {code:'AI_PROVIDER_INVALID'});
  await assert.rejects(readCompletionStream(response([':'.repeat(1000)]), {maxResponseBytes:10}), {code:'AI_PROVIDER_INVALID'});
});

test('DONE terminates a body left open by provider without waiting for HTTP EOF', async () => {
  let cancelled = false;
  const result = await invoke({onProgress() {},fetchImpl:fetchRounds([() => response(validQuestionParts('请补充对象。'),
    {close:false,onCancel() {cancelled = true;}})])});
  assert.equal(result.text, '请补充对象。');
  assert.equal(cancelled, true);
});

test('abort raised by notification stops additional events within the same transport chunk', async () => {
  const controller = new AbortController();
  const previews = [];
  await assert.rejects(invoke({signal:controller.signal,onProgress(notice) {
    if (notice.type === 'preview' && notice.text) {previews.push(notice.text); controller.abort();}
  },fetchImpl:fetchRounds([[
    event(chunk({content:'{"kind":"clarification","question":"第一段'})) +
    event(chunk({content:'第二段"}'})) + end(),
  ]])}), {code:'AI_ABORTED'});
  assert.deepEqual(previews, ['第一段']);
});
