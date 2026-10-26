import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiConversation } from './ai-conversation.js';
const context = { userId: 'u1', runDocumentId: 'current', documentRevision: 1, localVersion: 'run-1:1', synced: true };
const body = { requestId: 'request-0001', status: 'completed', simulated: false,
  dialogue: { status: 'answer', answer: '见工具记录。', references: ['call-1'], evidence: [{ callId: 'call-1' }] } };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function client(fetchImpl) { const c = createAiConversation({ autoRecovery: false, fetchImpl, makeId: () => 'request-0001' }); c.setContext(context); return c; }

test('dialogue sends only own document reference and user request, no snapshot or authority', async () => {
  const calls = [];
  const c = client(async (url, init) => { calls.push({ url, init }); return Response.json(body); });
  await c.send('查询现金比例');
  assert.equal(c.snapshot().phase, 'completed');
  assert.deepEqual(JSON.parse(calls[0].init.body), { requestId: 'request-0001', message: '查询现金比例', runDocumentId: 'current', documentRevision: 1 });
  assert.equal(calls[0].init.headers['X-Workspace-User'], 'u1');
  assert.equal(calls[0].init.redirect, 'error');
});
test('clarification followup carries only user turns, not model-produced instructions', async () => {
  const prompts = []; let n = 0;
  const c = client(async (url, init) => { prompts.push(JSON.parse(init.body).message); return Response.json({ ...body,
    dialogue: { ...body.dialogue, status: ++n === 1 ? 'clarification' : 'answer', answer: 'model-untrusted-content' } }); });
  await c.send('安排逆回购'); await c.send('期限7天');
  assert.match(prompts[1], /安排逆回购/); assert.match(prompts[1], /期限7天/);
  assert.doesNotMatch(prompts[1], /model-untrusted/);
});
test('changed local facts or account discard late results and cancel using old owner', async () => {
  for (const update of [{ ...context, localVersion: 'run-1:2', synced: false }, { ...context, userId: 'u2' }]) {
    const wait = deferred(), owners = [];
    const c = client(async (url, init) => {
      if (url.endsWith('/cancel')) { owners.push(init.headers['X-Workspace-User']); return Response.json({ requestId: 'request-0001', status: 'cancelled' }); }
      return wait.promise;
    });
    const pending = c.send('拟单'); c.setContext(update); wait.resolve(Response.json(body)); await pending;
    assert.equal(c.snapshot().result, null); assert.equal(c.snapshot().phase, 'idle'); assert.deepEqual(owners, ['u1']);
  }
});
test('unsaved context and duplicate click cannot trigger provider calls', async () => {
  let calls = 0; const wait = deferred();
  const c = client(async () => { calls++; return wait.promise; });
  c.setContext({ ...context, synced: false }); await c.send('拟单'); assert.equal(calls, 0);
  c.setContext(context); const pending = c.send('拟单'); await c.send('拟单'); assert.equal(calls, 1);
  wait.resolve(Response.json(body)); await pending;
});
test('confirmed cancellation drops late success; failed cancellation keeps the same request recoverable', async () => {
  for (const success of [true, false]) {
    const wait = deferred();
    const c = client(async url => {
      if (!url.endsWith('/cancel')) return wait.promise;
      if (!success) throw new Error('offline');
      return Response.json({ requestId: 'request-0001', status: 'cancelled' });
    });
    const pending = c.send('拟单'); await c.cancel();
    assert.equal(c.snapshot().phase, success ? 'cancelled' : 'error');
    assert.equal(c.snapshot().recoverable, !success);
    if (!success) assert.match(c.snapshot().error, /服务端确认/);
    wait.resolve(Response.json(body)); await pending;
    assert.equal(c.snapshot().phase, success ? 'cancelled' : 'error');
  }
});
test('mock or wrong-request responses never pass for a real dialogue; no automatic retry', async () => {
  for (const patch of [{ simulated: true }, { requestId: 'wrong-id' }, { status: 'failed' }]) {
    let calls = 0; const c = client(async () => { calls++; return Response.json({ ...body, ...patch }); });
    await c.send('拟单'); assert.equal(c.snapshot().phase, 'error'); assert.equal(c.snapshot().result, null); assert.equal(calls, 1);
  }
});

test('classified terminal failures show safe Chinese guidance without becoming recoverable or successful', async () => {
  const cases = [
    ['AI_BUDGET_EXCEEDED', /处理预算/],
    ['AI_PROVIDER_UNAVAILABLE', /无法连接/],
    ['AI_DIALOGUE_INVALID', /依据校验/],
    ['AI_TOOL_FAILED', /测算工具/],
    ['AI_DOCUMENT_STALE', /运行已变化/],
    ['SECRET-KEY forged code', /本次AI请求未完成/],
    ['__proto__', /本次AI请求未完成/],
  ];
  for (const [errorCode, guidance] of cases) {
    const c = client(async () => Response.json({ requestId: 'request-0001', status: 'failed', simulated: false,
      errorCode }));
    await c.send('测算当前指令');
    const state = c.snapshot();
    assert.equal(state.phase, 'error');
    assert.equal(state.result, null);
    assert.equal(state.recoverable, false);
    assert.match(state.error, guidance);
    assert.doesNotMatch(state.error, /SECRET-KEY/);
  }
});

test('terminal diagnostic and request ID reach the UI with safe targeted guidance', async () => {
  for (const [reason,recovery,guidance] of [
    ['reference_stale','refresh_run',/更新.*测算结果/],
    ['reference_missing','retry',/引用缺失/],
    ['required_tool','retry',/必需.*测算依据/],
    ['answer_shape','retry',/结构或内容/],
  ]) {
    const diagnostic={reason,recovery,recovered:false};
    const c=client(async()=>Response.json({requestId:'request-0001',status:'failed',simulated:false,
      errorCode:'AI_DIALOGUE_INVALID',diagnosticReason:reason,diagnostic:{...diagnostic,raw:'SECRET'}}));
    await c.send('原需求');
    const state=c.snapshot();
    assert.equal(state.requestId,'request-0001');
    assert.deepEqual(state.diagnostic,diagnostic);
    assert.equal(state.diagnosticReason,reason);
    assert.match(state.error,guidance);
    assert.doesNotMatch(JSON.stringify(state),/SECRET/);
    assert.equal(state.recoverable,false);
  }
  const c=client(async()=>Response.json({...body,status:'failed',errorCode:'AI_DIALOGUE_INVALID',
    diagnostic:{reason:'SECRET provider output',recovery:'retry',recovered:false}}));
  await c.send('原需求');
  assert.equal(c.snapshot().diagnostic,null);
  assert.doesNotMatch(JSON.stringify(c.snapshot()),/SECRET|补充需求/);
});

test('completed recovered diagnostics reach UI without creating another request', async () => {
  let calls=0;
  const diagnostic={reason:'narrative_amount',recovery:'rewritten_answer',recovered:true};
  const c=client(async()=>{calls++;return Response.json({...body,dialogue:{...body.dialogue,diagnostic}});});
  await c.send('原需求');
  assert.equal(c.snapshot().requestId,'request-0001');
  assert.deepEqual(c.snapshot().diagnostic,diagnostic);
  assert.equal(c.snapshot().phase,'completed');
  assert.equal(calls,1);
});

test('automatic GET recovery uses the stored terminal classification and never replays failed POST', async () => {
  const calls = [];
  const c = createAiConversation({ makeId: () => 'request-0001', recoveryPollMs: 1,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === 'GET') return Response.json({ requestId: 'request-0001', status: 'failed',
        simulated: false, errorCode: 'AI_BUDGET_EXCEEDED' });
      throw new TypeError('response lost');
    } });
  c.setContext(context); await c.send('测算');
  assert.equal(c.snapshot().phase, 'error');
  assert.match(c.snapshot().error, /处理预算/);
  assert.equal(c.snapshot().recoverable, false);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
});
test('lost response retains original ID for explicit replay and blocks accidental new paid attempt', async () => {
  const calls = []; let first = true;
  const c = client(async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (first) { first = false; throw new TypeError('connection lost after submission'); }
    return Response.json(body);
  });
  await c.send('逆回购8亿元');
  assert.equal(c.snapshot().recoverable, true); assert.equal(c.snapshot().requestId, 'request-0001');
  await c.send('重复提交'); assert.equal(calls.length, 1);
  await c.recover(); assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal(c.snapshot().phase, 'completed'); assert.equal(c.snapshot().recoverable, false);
  assert.deepEqual(c.snapshot().userTurns, ['逆回购8亿元']);
});
test('document change destroys recovery so an old request cannot be replayed into the new run', async () => {
  let requests = 0;
  const c = client(async url => {
    if (url.endsWith('/cancel')) return Response.json({ requestId: 'request-0001', status: 'cancelled' });
    requests++; throw new TypeError('offline');
  });
  await c.send('测算'); c.setContext({ ...context, documentRevision: 2, localVersion: 'run-1:2' });
  await c.recover(); assert.equal(requests, 1); assert.equal(c.snapshot().recoverable, false);
});
test('gateway 5xx after acceptance retains ID and only explicit same-ID recovery is permitted', async () => {
  for (const status of [502, 503, 504]) {
    const calls = [];
    const c = client(async (url, init) => {
      calls.push(JSON.parse(init.body));
      return calls.length === 1 ? Response.json({ error: 'UPSTREAM_FAILURE' }, { status }) : Response.json(body);
    });
    await c.send('测算'); assert.equal(c.snapshot().recoverable, true);
    await c.send('重复测算'); assert.equal(calls.length, 1);
    await c.recover(); assert.deepEqual(calls[1], calls[0]); assert.equal(c.snapshot().phase, 'completed');
  }
});

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key,value) => data.set(key,value), removeItem: key => data.delete(key), data };
}
test('tab refresh restores pending original request explicitly, never answers or draft authority', async () => {
  const storage = memoryStorage(); let calls = 0;
  const first = createAiConversation({ autoRecovery: false, pendingStorage: storage, makeId: () => 'request-0001',
    fetchImpl: async () => { throw new TypeError('lost response'); } });
  first.setContext(context); await first.send('保持逆回购目标');
  const recorded = JSON.parse([...storage.data.values()][0]);
  assert.equal(recorded.id, 'request-0001'); assert.equal(recorded.result, undefined);
  const second = createAiConversation({ autoRecovery: false, pendingStorage: storage, fetchImpl: async (url,init) => {
    calls++; assert.equal(JSON.parse(init.body).requestId, recorded.id); return Response.json(body);
  } });
  second.setContext({ ...context, synced: false }); second.setContext(context);
  assert.equal(calls,0); assert.equal(second.snapshot().recoverable,true); assert.equal(second.snapshot().result,null);
  await second.recover(); assert.equal(calls,1); assert.equal(second.snapshot().phase,'completed');
  assert.equal(second.snapshot().requestId, 'request-0001');
  assert.equal([...storage.data.keys()].some(key => key.includes('pending')), false);
  assert.equal(second.snapshot().transcript[0].userMessage, '保持逆回购目标');
});

test('completed conversation survives refresh only for the same account and run, without evidence or secrets', async () => {
  const storage = memoryStorage(); let counter = 0;
  const first = createAiConversation({ pendingStorage:storage, makeId:()=>`request-${++counter}`,
    fetchImpl:async (_,init)=>Response.json({...body,requestId:JSON.parse(init.body).requestId,
      dialogue:{...body.dialogue,answer:'现金核算完成。Bearer secret-value'}}) });
  first.setContext(context); await first.send('第一问'); await first.send('第二问');
  const stored = storage.getItem(`zhihui-ai-transcript-1:${context.userId}`);
  assert.ok(stored); assert.doesNotMatch(stored,/secret-value|"evidence"|"basis"/);
  const restored = createAiConversation({pendingStorage:storage,makeId:()=> 'request-next',
    fetchImpl:async (_,init)=>Response.json({...body,requestId:JSON.parse(init.body).requestId})});
  restored.setContext(context);
  assert.deepEqual(restored.snapshot().transcript.map(x=>x.userMessage),['第一问','第二问']);
  await restored.send('第三问');
  assert.equal(restored.snapshot().transcript.length,3);
  restored.setContext({...context,userId:'u2'});
  assert.deepEqual(restored.snapshot().transcript,[]);
  assert.equal(storage.getItem(`zhihui-ai-transcript-1:${context.userId}`),null);
});

test('same run revision keeps visible history but drops stale model continuity and request ID', async () => {
  const storage=memoryStorage(); let count=0; const calls=[];
  const fetchImpl=async (_,init)=>{const payload=JSON.parse(init.body);calls.push(payload);
    return Response.json({...body,requestId:payload.requestId});};
  const first=createAiConversation({pendingStorage:storage,makeId:()=>`request-${++count}`,fetchImpl});
  first.setContext(context); await first.send('旧快照问题');
  const changed={...context,documentRevision:2,localVersion:'run-1:2'};
  first.setContext(changed);
  assert.equal(first.snapshot().transcript.length,1);
  assert.equal(first.snapshot().transcript[0].basisRevision,1);
  assert.deepEqual(first.snapshot().userTurns,[]);
  const restored=createAiConversation({pendingStorage:storage,makeId:()=>`request-${++count}`,fetchImpl});
  restored.setContext(changed);
  assert.equal(restored.snapshot().transcript.length,1);
  assert.deepEqual(restored.snapshot().userTurns,[]);
  await restored.send('新快照问题');
  assert.equal(calls.at(-1).previousRequestId,undefined);
  assert.equal(calls.at(-1).message,'新快照问题');
  assert.equal(restored.snapshot().transcript.length,2);
  restored.setContext({...changed,runDocumentId:'another'});
  assert.deepEqual(restored.snapshot().transcript,[]);
});
test('refresh recovery rejects altered basis or malformed, expired records and isolates accounts', async () => {
  for (const mutate of [row => { row.context.documentRevision++; }, row => { row.prompt = 'altered'; },
    row => { row.savedAt -= 86400001; }, row => { row.nextTurns = [42]; }]) {
    const storage = memoryStorage();
    const first = createAiConversation({ autoRecovery: false,pendingStorage:storage,makeId:()=> 'request-0001',fetchImpl:async()=>{throw new Error('offline');}});
    first.setContext(context);await first.send('测算');
    const key=[...storage.data.keys()][0],row=JSON.parse(storage.getItem(key));mutate(row);storage.setItem(key,JSON.stringify(row));
    const second = createAiConversation({ autoRecovery: false,pendingStorage:storage,fetchImpl:()=>assert.fail('must not call')});
    second.setContext({...context,userId:'u2'});assert.equal(second.snapshot().recoverable,false);
    second.setContext(context);assert.equal(second.snapshot().recoverable,false);assert.equal(storage.data.size,0);
  }
});
test('explicit reset and logout remove pending recovery; denied session storage remains usable', async () => {
  const storage=memoryStorage(); const c=createAiConversation({ autoRecovery: false,pendingStorage:storage,makeId:()=> 'request-0001',fetchImpl:async url=>{
    if(url.endsWith('/cancel'))return Response.json({requestId:'request-0001',status:'cancelled'});throw new Error('offline');
  }});
  c.setContext(context);await c.send('测算');c.reset();assert.equal(storage.data.size,0);assert.equal(c.snapshot().recoverable,false);
  await c.send('测算');c.setContext(null);assert.equal(storage.data.size,0);
  const denied={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}};
  const d=createAiConversation({ autoRecovery: false,pendingStorage:denied,makeId:()=> 'request-0001',fetchImpl:async()=>Response.json(body)});
  d.setContext(context);await d.send('查询');assert.equal(d.snapshot().phase,'completed');
});

test('lost response is recovered automatically using GET then same accepted ID, without a connection probe', async () => {
  const calls = []; let submitted = 0, polls = 0;
  const c = createAiConversation({ makeId: () => 'request-0001', recoveryPollMs: 1,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === 'GET') return Response.json({ requestId: 'request-0001', status: ++polls === 1 ? 'processing' : 'completed', simulated: false });
      assert.equal(JSON.parse(init.body).requestId, 'request-0001');
      if (++submitted === 1) throw new TypeError('response lost');
      return Response.json(body);
    } });
  c.setContext(context); await c.send('新增存款并测算');
  assert.equal(c.snapshot().phase, 'completed'); assert.equal(submitted, 2); assert.equal(polls, 2);
  assert.equal(calls.some(x => x.url === '/api/ai/requests'), false);
});

test('automatic recovery never POSTs again when the original ID was not accepted', async () => {
  let posts = 0;
  const c = createAiConversation({ makeId: () => 'request-0001', fetchImpl: async (_, init) => {
    if (init.method === 'GET') return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    posts++; throw new TypeError('offline');
  } });
  c.setContext(context); await c.send('测算');
  assert.equal(posts, 1); assert.equal(c.snapshot().recoverable, true);
});

test('confirmed cancel releases caller even when the transport ignores abort', async () => {
  const c = createAiConversation({ makeId: () => 'request-0001', fetchImpl: async url => {
    if (url.endsWith('/cancel')) return Response.json({ requestId: 'request-0001', status: 'cancelled' });
    return new Promise(() => {});
  } });
  c.setContext(context); const pending = c.send('测算'); await c.cancel(); await pending;
  assert.equal(c.snapshot().phase, 'cancelled');
});

test('server timeout after automatic recovery frees input without a connection test', async () => {
  let posts = 0;
  const c = createAiConversation({ makeId: () => 'request-0001', fetchImpl: async (_, init) => {
    if (init.method === 'GET') return Response.json({ requestId: 'request-0001', status: 'timed_out', simulated: false, errorCode: 'AI_TIMEOUT' });
    posts++; throw new TypeError('response lost');
  } });
  c.setContext(context); await c.send('测算');
  assert.equal(c.snapshot().phase, 'error'); assert.equal(c.snapshot().recoverable, false); assert.equal(posts, 1);
});

test('followups reference the last successful server request and support more than four turns', async () => {
  let count = 0; const sent = [];
  const c = createAiConversation({ makeId: () => `request-${++count}`, fetchImpl: async (_, init) => {
    const input = JSON.parse(init.body); sent.push(input);
    return Response.json({ ...body, requestId: input.requestId });
  } });
  c.setContext(context);
  for (let n = 0; n < 6; n++) await c.send(`第${n + 1}次调整`);
  assert.equal(c.snapshot().phase, 'completed'); assert.equal(sent.length, 6);
  assert.equal(sent[0].previousRequestId, undefined);
  assert.equal(sent[5].previousRequestId, 'request-5');
  c.setContext({ ...context, documentRevision: 2 }); await c.send('新快照');
  assert.equal(sent[6].previousRequestId, undefined);
});

test('restoring a pending request never extends its original retention time', async () => {
  const storage = memoryStorage();
  const first = createAiConversation({ autoRecovery: false, pendingStorage: storage,
    makeId: () => 'request-0001', fetchImpl: async () => { throw new TypeError('offline'); } });
  first.setContext(context); await first.send('测算');
  const key = [...storage.data.keys()][0], record = JSON.parse(storage.getItem(key));
  record.savedAt -= 3600000; storage.setItem(key, JSON.stringify(record));
  const restored = createAiConversation({ pendingStorage: storage }); restored.setContext(context);
  assert.equal(restored.snapshot().recoverable, true);
  assert.equal(JSON.parse(storage.getItem(key)).savedAt, record.savedAt);
});

test('elapsed time grows while analysing and freezes when the answer completes', async () => {
  let currentTime = 1000000;
  const wait = deferred();
  const c = createAiConversation({ now: () => currentTime, makeId: () => 'request-0001',
    fetchImpl: async () => wait.promise });
  c.setContext(context);
  const pending = c.send('测算');
  assert.equal(c.snapshot().startedAt, 1000000);
  currentTime += 2300;
  assert.equal(c.snapshot().elapsedMs, 2300);
  wait.resolve(Response.json(body)); await pending;
  assert.equal(c.snapshot().completedAt, currentTime);
  currentTime += 10000;
  assert.equal(c.snapshot().elapsedMs, 2300);
});

test('refresh recovery uses original start time, and failure retains the request text', async () => {
  let currentTime = 1000000;
  const storage = memoryStorage();
  const first = createAiConversation({ autoRecovery: false, now: () => currentTime, pendingStorage: storage,
    makeId: () => 'request-0001', fetchImpl: async () => { throw new TypeError('offline'); } });
  first.setContext(context); await first.send('保留原目标');
  currentTime += 7000;
  const restored = createAiConversation({ now: () => currentTime, pendingStorage: storage });
  restored.setContext(context);
  assert.equal(restored.snapshot().recoverable, true);
  assert.equal(restored.snapshot().pendingMessage, '保留原目标');
  assert.equal(restored.snapshot().startedAt, 1000000);
  assert.equal(restored.snapshot().elapsedMs, 7000);
});

test('cancel stops local waiting immediately; unconfirmed server cancel blocks new paid submission', async () => {
  let currentTime = 1000000, posts = 0;
  const cancelWait = deferred();
  const c = createAiConversation({ autoRecovery: false, now: () => currentTime,
    makeId: () => 'request-0001', fetchImpl: async (url, init) => {
      if (url.endsWith('/cancel')) return cancelWait.promise;
      posts++;
      if (posts === 1) return new Promise(() => {});
      assert.equal(JSON.parse(init.body).requestId, 'request-0001');
      return Response.json(body);
    } });
  c.setContext(context);
  const pending = c.send('测算当前指令');
  const cancelling = c.cancel();
  assert.equal(c.snapshot().phase, 'cancelling');
  await pending;
  currentTime += 3000;
  assert.equal(c.snapshot().elapsedMs, 3000);
  cancelWait.reject(new TypeError('offline'));
  await cancelling;
  assert.equal(c.snapshot().phase, 'error');
  assert.equal(c.snapshot().recoverable, true);
  assert.equal(c.snapshot().pendingMessage, '测算当前指令');
  await c.send('再发一次'); assert.equal(posts, 1);
  await c.recover(); assert.equal(posts, 2);
  assert.equal(c.snapshot().phase, 'completed');
});

const streamFrame = (type, value = {}, id = 'request-0001') =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, requestId: id, ...value })}\r\n\r\n`;
const completeFrame = (value = body) => streamFrame('complete', { value, httpStatus: 200 });
const tick = () => new Promise(resolve => setImmediate(resolve));
function controlledStream() {
  let controller, cancelled = false;
  const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  return { response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    push(value) { controller.enqueue(typeof value === 'string' ? new TextEncoder().encode(value) : value); },
    end() { controller.close(); }, get cancelled() { return cancelled; } };
}

test('real stream displays cumulative preview before completion, without final authority or persisted preview', async () => {
  const wire = controlledStream(), storage = memoryStorage(), snapshots = [];
  const c = createAiConversation({ makeId: () => 'request-0001', pendingStorage: storage,
    onChange: value => snapshots.push(value), fetchImpl: async (_, init) => {
      assert.equal(init.headers.Accept, 'text/event-stream'); return wire.response;
    } });
  c.setContext(context); const pending = c.send('给出方案');
  wire.push(streamFrame('phase', { phase: 'generating' }));
  wire.push(streamFrame('preview', { text: '正在核算主方案。', round: 0 })); await tick();
  assert.equal(c.snapshot().previewText, '正在核算主方案。');
  assert.equal(c.snapshot().streamPhase, 'generating');
  assert.equal(c.snapshot().result, null); assert.deepEqual(c.snapshot().transcript, []);
  assert.doesNotMatch([...storage.data.values()].join(''), /正在核算主方案/);
  wire.push(streamFrame('preview', { text: '正在核算主方案。还需检查约束。', round: 0 }));
  wire.push(streamFrame('phase', { phase: 'validating' })); await tick();
  assert.equal(c.snapshot().streamPhase, 'validating'); assert.equal(c.snapshot().result, null);
  wire.push(completeFrame()); await pending;
  assert.equal(c.snapshot().phase, 'completed'); assert.deepEqual(c.snapshot().result, body.dialogue);
  assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().transcript.length, 1);
  assert.ok(snapshots.some(value => value.previewText && value.result === null));
  assert.equal(wire.cancelled, true); // complete ends local consumption immediately.
});

test('UTF-8 and CRLF can split at every byte, and a new generation round can clear preview', async () => {
  const wire = controlledStream(), previews = [];
  const c = createAiConversation({ makeId: () => 'request-0001', fetchImpl: async () => wire.response,
    onChange: value => { if (value.phase === 'running') previews.push(value.previewText); } });
  c.setContext(context); const pending = c.send('方案');
  const data = new TextEncoder().encode(': keepalive\r\n\r\n' +
    streamFrame('preview', { text: '中文金额与条件', round: 0 }) +
    streamFrame('preview', { text: '', round: 1 }) +
    streamFrame('preview', { text: '重新生成正文', round: 1 }) + completeFrame());
  for (const byte of data) wire.push(Uint8Array.of(byte));
  await pending;
  assert.equal(c.snapshot().phase, 'completed');
  assert.ok(previews.includes('中文金额与条件'));
  assert.ok(previews.indexOf('') < previews.lastIndexOf('重新生成正文'));
});

test('truncated stream clears temporary text and recovers only the accepted original ID', async () => {
  const wire = controlledStream(), calls = [];
  const c = createAiConversation({ makeId: () => 'request-0001', fetchImpl: async (url, init) => {
    calls.push({ url, ...init });
    if (init.method === 'GET') {
      assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().result, null);
      return Response.json({ requestId: 'request-0001', status: 'completed', simulated: false });
    }
    return calls.length === 1 ? wire.response : Response.json(body);
  } });
  c.setContext(context); const pending = c.send('保持原需求');
  wire.push(streamFrame('preview', { text: '尚未核验', round: 0 })); await tick();
  wire.push(completeFrame().slice(0, -2)); wire.end(); await pending;
  assert.deepEqual(calls.map(value => value.method), ['POST', 'GET', 'POST']);
  assert.deepEqual(JSON.parse(calls[0].body), JSON.parse(calls[2].body));
  assert.equal(calls[2].headers.Accept, undefined); assert.equal(c.snapshot().phase, 'completed');
  assert.equal(c.snapshot().previewText, '');
});

test('SSE 4xx rejection clears preview and never replays or becomes recoverable', async () => {
  for (const httpStatus of [400, 409]) {
    const wire = controlledStream(); let calls = 0;
    const c = createAiConversation({ makeId: () => 'request-0001', fetchImpl: async () => { calls++; return wire.response; } });
    c.setContext(context); const pending = c.send('方案');
    wire.push(streamFrame('preview', { text: '临时方案', round: 0 })); await tick();
    wire.push(streamFrame('error', { error: 'AI_DIALOGUE_INVALID', httpStatus })); await pending;
    assert.equal(c.snapshot().phase, 'error'); assert.match(c.snapshot().error, /依据校验/);
    assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().result, null);
    assert.equal(c.snapshot().recoverable, false); assert.equal(calls, 1);
    assert.deepEqual(c.snapshot().transcript, []);
  }
});

test('SSE terminal failed completion and error frames preserve safe diagnostics and original ID', async () => {
  const diagnostic={reason:'reference_stale',recovery:'refresh_run',recovered:false};
  for (const type of ['complete','error']) {
    const wire=controlledStream(); let calls=0;
    const c=createAiConversation({makeId:()=> 'request-0001',fetchImpl:async()=>{calls++;return wire.response;}});
    c.setContext(context);const pending=c.send('原需求');
    wire.push(streamFrame('preview',{text:'临时未验证答复',round:0}));await tick();
    wire.push(type==='complete' ? completeFrame({requestId:'request-0001',status:'failed',simulated:false,
      errorCode:'AI_DIALOGUE_INVALID',diagnostic}) : streamFrame('error',{
      error:'AI_DIALOGUE_INVALID',httpStatus:409,diagnostic:{...diagnostic,raw:'SECRET'}}));
    await pending;
    assert.equal(c.snapshot().phase,'error');
    assert.equal(c.snapshot().requestId,'request-0001');
    assert.deepEqual(c.snapshot().diagnostic,diagnostic);
    assert.match(c.snapshot().error,/更新.*测算结果/);
    assert.equal(c.snapshot().previewText,'');
    assert.equal(c.snapshot().recoverable,false);
    assert.doesNotMatch(JSON.stringify(c.snapshot()),/SECRET/);
    assert.equal(calls,1);
  }
});

test('SSE 503 after persisted completion recovers the original ID without another generation', async () => {
  const wire = controlledStream(), calls = [], ids = new Set(); let invocations = 0, createdIds = 0;
  const c = createAiConversation({ makeId: () => { createdIds++; return 'request-0001'; },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      if (init.method === 'GET') {
        assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().result, null);
        return Response.json({ requestId: 'request-0001', status: 'completed', simulated: false });
      }
      const input = JSON.parse(init.body);
      if (!ids.has(input.requestId)) { ids.add(input.requestId); invocations++; return wire.response; }
      return Response.json(body);
    } });
  c.setContext(context); const pending = c.send('原需求');
  wire.push(streamFrame('preview', { text: '临时正文', round: 0 })); await tick();
  wire.push(streamFrame('error', { error: 'SERVICE_UNAVAILABLE', httpStatus: 503 })); await pending;
  assert.deepEqual(calls.map(value => value.method), ['POST', 'GET', 'POST']);
  assert.deepEqual(JSON.parse(calls[0].body), JSON.parse(calls[2].body));
  assert.equal(calls[2].headers.Accept, undefined);
  assert.equal(createdIds, 1); assert.equal(invocations, 1); assert.equal(ids.size, 1);
  assert.equal(c.snapshot().phase, 'completed'); assert.equal(c.snapshot().recoverable, false);
  assert.equal(c.snapshot().previewText, ''); assert.deepEqual(c.snapshot().result, body.dialogue);
});

test('SSE 5xx with failed recovery retains the original ID and blocks new submissions', async () => {
  for (const httpStatus of [500, 502, 503, 504]) {
    const wire = controlledStream(), calls = []; let createdIds = 0;
    const c = createAiConversation({ makeId: () => { createdIds++; return 'request-0001'; },
      fetchImpl: async (url, init) => {
        calls.push({ url, ...init });
        if (init.method === 'GET') return Response.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
        return wire.response;
      } });
    c.setContext(context); const pending = c.send('原需求');
    wire.push(streamFrame('preview', { text: '未校验正文', round: 0 })); await tick();
    wire.push(streamFrame('error', { error: 'SERVICE_UNAVAILABLE', httpStatus })); await pending;
    assert.equal(c.snapshot().phase, 'error'); assert.equal(c.snapshot().recoverable, true);
    assert.equal(c.snapshot().requestId, 'request-0001'); assert.equal(c.snapshot().previewText, '');
    assert.equal(c.snapshot().result, null); assert.deepEqual(c.snapshot().transcript, []);
    await c.send('重复发送');
    assert.deepEqual(calls.map(value => value.method), ['POST', 'GET']); assert.equal(createdIds, 1);
  }
});

test('completed SSE result classified as provider failure remains terminal without GET recovery', async () => {
  const wire = controlledStream(); let calls = 0;
  const c = createAiConversation({ makeId: () => 'request-0001',
    fetchImpl: async () => { calls++; return wire.response; } });
  c.setContext(context); const pending = c.send('原需求');
  wire.push(streamFrame('preview', { text: '未校验正文', round: 0 })); await tick();
  wire.push(completeFrame({ requestId: 'request-0001', status: 'failed', simulated: false,
    errorCode: 'AI_PROVIDER_ERROR' })); await pending;
  assert.equal(c.snapshot().phase, 'error'); assert.equal(c.snapshot().recoverable, false);
  assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().result, null);
  assert.equal(calls, 1);
});

test('preview cannot bypass final response validation', async () => {
  for (const value of [{ ...body, simulated: true }, { ...body, dialogue: { answer: '缺少校验结构' } }]) {
    const wire = controlledStream(), c = client(async () => wire.response);
    const pending = c.send('方案');
    wire.push(streamFrame('preview', { text: '可行方案', round: 0 })); await tick();
    wire.push(completeFrame(value)); await pending;
    assert.equal(c.snapshot().phase, 'error'); assert.equal(c.snapshot().result, null);
    assert.equal(c.snapshot().previewText, ''); assert.deepEqual(c.snapshot().transcript, []);
  }
});

test('cancel aborts stream body consumption and late complete cannot replace cancellation', async () => {
  const wire = controlledStream(), c = client(async url => url.endsWith('/cancel')
    ? Response.json({ requestId: 'request-0001', status: 'cancelled' }) : wire.response);
  const pending = c.send('方案'); wire.push(streamFrame('preview', { text: '临时正文', round: 0 })); await tick();
  const cancelling = c.cancel();
  assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().phase, 'cancelling');
  await cancelling; await pending;
  assert.equal(wire.cancelled, true); assert.equal(c.snapshot().phase, 'cancelled');
  assert.equal(c.snapshot().result, null); assert.deepEqual(c.snapshot().transcript, []);
});

test('a non-cooperative body reader cannot deliver late preview or complete after cancellation', async () => {
  const firstRead = deferred(), lateRead = deferred(); let reads = 0, cancellations = 0;
  const response = { ok: true, headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    body: { getReader: () => ({ read: () => ++reads === 1 ? firstRead.promise : lateRead.promise,
      cancel: async () => { cancellations++; }, releaseLock() {} }) } };
  const c = client(async url => url.endsWith('/cancel')
    ? Response.json({ requestId: 'request-0001', status: 'cancelled' }) : response);
  const pending = c.send('方案'); await tick();
  firstRead.resolve({ done: false, value: new TextEncoder().encode(streamFrame('preview', { text: '旧正文', round: 0 })) });
  await tick(); assert.equal(c.snapshot().previewText, '旧正文');
  await c.cancel(); await pending;
  lateRead.resolve({ done: false, value: new TextEncoder().encode(
    streamFrame('preview', { text: '迟到正文', round: 0 }) + completeFrame()) }); await tick();
  assert.ok(cancellations > 0); assert.equal(c.snapshot().phase, 'cancelled');
  assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().result, null);
});

test('account, run version and new session changes immediately discard streaming preview', async () => {
  for (const change of [c => c.setContext({ ...context, userId: 'u2' }),
    c => c.setContext({ ...context, localVersion: 'run-1:2' }), c => c.reset()]) {
    const wire = controlledStream(), c = client(async url => url.endsWith('/cancel')
      ? Response.json({ requestId: 'request-0001', status: 'cancelled' }) : wire.response);
    const pending = c.send('方案'); wire.push(streamFrame('preview', { text: '旧正文', round: 0 })); await tick();
    assert.equal(c.snapshot().previewText, '旧正文'); change(c); await pending;
    assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().result, null);
    assert.equal(c.snapshot().phase, 'idle'); assert.equal(wire.cancelled, true);
  }
});

test('malformed, mismatched and excessive SSE frames are bounded and never produce final results', async () => {
  const cases = [streamFrame('preview', { text: 'wrong owner', round: 0 }, 'wrong-id'),
    'event: malicious\ndata: {}\n\n', 'retry: 1\ndata: {}\n\n',
    streamFrame('preview', { text: 'x'.repeat(16001), round: 0 }),
    streamFrame('preview', { text: 'old round', round: -1 }),
    'data: ' + 'x'.repeat(262145), Uint8Array.of(0xff, 0x0a, 0x0a),
    ': heartbeat\n\n'.repeat(2049), new Uint8Array(4 * 1024 * 1024 + 1)];
  for (const frame of cases) {
    const wire = controlledStream(), c = client(async () => wire.response);
    const pending = c.send('方案'); wire.push(frame); wire.end(); await pending;
    assert.equal(c.snapshot().phase, 'error'); assert.equal(c.snapshot().result, null);
    assert.equal(c.snapshot().previewText, ''); assert.equal(c.snapshot().recoverable, true);
  }
});

test('stream negotiation also accepts legacy JSON and minimal fake fetch responses', async () => {
  const c = client(async (_, init) => {
    assert.equal(init.headers.Accept, 'text/event-stream');
    return { ok: true, status: 200, json: async () => body };
  });
  await c.send('旧响应'); assert.equal(c.snapshot().phase, 'completed');
  assert.equal(c.snapshot().previewText, ''); assert.deepEqual(c.snapshot().result, body.dialogue);
});

