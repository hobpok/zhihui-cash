import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from './api.js';
import {createAiService} from './ai-service.js';
import {invokeAiDialogue} from './ai-dialogue.js';
import {createStore} from './storage.js';
import {sqliteD1,seed} from './test-support/sqlite-d1.js';
import {createModel} from '../app/model.js';
import {createBankOrderInitialTemplate} from '../app/default-scenario.js';
import {APP_RELEASE} from '../app/release-version.js';

test('current C02 gap completes through authenticated SSE, persists and replays without provider or run mutation',async()=>{
 const {sqlite,db}=sqliteD1();
 const origin='https://workspace.local.test';
 seed(sqlite,'u1','gap@example.test');
 sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)').run('u1','gap-user','test-salt','test-hash',100000);
 const env={DB:db,APP_ORIGIN:origin,AI_KEY_TEST:'local-test-placeholder',AI_ACCOUNT_CONFIG_JSON:JSON.stringify({u1:{mode:'real',provider:'deepseek',model:'deepseek-flash',keyBinding:'AI_KEY_TEST',dailyLimit:30,timeoutMs:5000}})};
 const model=createModel();model.startFromTemplate(createBankOrderInitialTemplate());model.generateProposal();model.approveProposal();model.sendBatch();
 const instructions=Object.values(model.getState().execution.instructions);
 const financing=instructions.find(i=>i.businessType==='interbank_repo_financing');
 const sale=instructions.find(i=>i.businessType==='cd_sell');
 model.simulateEvent('fill',{instructionId:financing.instructionId,nominalYuan:20e8});
 model.simulateEvent('fill',{instructionId:sale.instructionId,nominalYuan:2e8});
 const saved=JSON.parse(model.serialize()),store=createStore(db);
 await store.putDocument('u1','run','current',{expectedRevision:0,mutationId:'cash-gap-seed-001',value:saved});
 let calls=0,providerCalls=0;
 const ai=createAiService({pollIntervalMs:5,dialogueInvoke:args=>{calls++;return invokeAiDialogue({...args,fetchImpl:async()=>{providerCalls++;throw Error('network forbidden');}});}});
 const api=createApi({ai,authenticate:async()=>({memberId:'u1'})});
 const body={requestId:'current-cash-gap-001',message:'正回购融资还需要成交多少，我才能满足现金比例要求',runDocumentId:'current',documentRevision:1};
 const call=stream=>api(new Request(origin+'/api/ai/dialogue',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Workspace-User':'u1','X-App-Release':APP_RELEASE,...(stream?{Accept:'text/event-stream'}:{})},body:JSON.stringify(body)}),env);
 try{
  const before=await store.readDocument('u1','run','current');
  const response=await call(true);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const frames=(await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(frame=>JSON.parse(frame.split('\ndata: ')[1]));
  const completed=frames.find(f=>f.type==='complete');assert.ok(completed,JSON.stringify(frames));
  assert.equal(sqlite.prepare('SELECT status FROM ai_requests WHERE request_id=?').get(body.requestId).status,'completed');
  const replay=await call(false);assert.equal(replay.status,200);const result=await replay.json();
  assert.equal(result.status,'completed');assert.match(result.text,/3\s*亿/);assert.doesNotMatch(result.text,/还需(?:要)?(?:再)?成交29/);
  assert.deepEqual(result.dialogue.evidence.map(e=>e.name),['read_metrics']);
  assert.equal(result.dialogue.evidence[0].result.currentCashRequirement.additionalFinancingFillYuan,3e8);
  assert.equal(calls,1);assert.equal(providerCalls,0);
  assert.deepEqual(await store.readDocument('u1','run','current'),before);
  const tokens=sqlite.prepare('SELECT input_tokens,output_tokens FROM ai_requests WHERE request_id=?').get(body.requestId);
  assert.equal(tokens.input_tokens,0);assert.equal(tokens.output_tokens,0);
 }finally{sqlite.close();}
});
