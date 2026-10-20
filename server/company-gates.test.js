import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel} from '../app/model.js';
import {createDefaultInitialTemplate} from '../app/default-scenario.js';
import {createPlanningTools} from './planning-tools.js';
import {invokeAiDialogue} from './ai-dialogue.js';

const fixture=()=>{
  const model=createModel();
  model.startFromTemplate(createDefaultInitialTemplate({businessDate:'2026-10-19'}));
  const before=model.serialize();
  const tools=createPlanningTools(JSON.parse(before),{requestId:'company-gates-local',documentRevision:1});
  return {model,before,tools};
};

test('actual AI completion tools expose separate 8% and 6% order evidence without mutating the run',()=>{
  const {model,before,tools}=fixture();
  const result=tools.execute('simulate_completion',{});
  assert.equal(result.terminalStatus,'feasible');
  assert.equal(result.pathStatus,'conditional_candidate');
  assert.equal(result.projectedFinalCashYuan,500000000);
  assert.equal(result.projectedFinalAccountCashYuan,500000000);
  for(const [bankId,rate,opening,deposit,cd] of [
    ['SIM-BANK-GZ',8,7900000000,100000000,200000000],
    ['SIM-BANK-JNRCB',6,5800000000,200000000,100000000]]) {
    const order=result.depositOrderEvidence.find(r=>r.bankId===bankId);
    assert.equal(order.thresholdNumerator/order.thresholdDenominator,rate/100);
    assert.equal(order.limitYuan,rate*1000000000);
    assert.equal(order.openingExposureYuan,opening);
    assert.equal(order.depositYuan,deposit);assert.equal(order.cdYuan,cd);
    assert.equal(order.depositFirstGate.result,'pass');
    assert.equal(order.cdFirstDepositGate.result,'block');
  }
  assert.ok(result.finalRules.rows.every(r=>r.ruleId!=='C04-DEPOSIT'));
  assert.equal(model.serialize(),before);
});

test('local scripted dialogue explains the real new scenario with both thresholds and no provider call',async()=>{
  const {model,before,tools}=fixture();let calls=0;
  const resolved={state:'real_ready',config:{mode:'real',provider:'deepseek',model:'deepseek-flash'},credential:'synthetic-test-only'};
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);
    if(calls===0) {
      assert.match(body.messages[0].content,/该银行配置上限/);
      assert.match(body.messages[0].content,/存款、存单及银行债/);
    }
    const message=calls++===0 ? {role:'assistant',content:null,tool_calls:[{id:'company-sim',type:'function',function:{name:'simulate_completion',arguments:'{}'}}]}:
      {role:'assistant',content:JSON.stringify({kind:'answer',references:['company-sim'],narrative:'按本轮测算核对顺序。'})};
    assert.ok(calls<=2);
    return new Response(JSON.stringify({object:'chat.completion',choices:[{index:0,message,finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const result=await invokeAiDialogue({message:'广州和江南的存款与存单为什么要先后排序？交换顺序会怎样？不拟新单。',resolved,tools,fetchImpl});
  assert.match(result.dialogue.answer,/8%闸门/);assert.match(result.dialogue.answer,/6%闸门/);
  assert.match(result.dialogue.answer,/广州银行/);assert.match(result.dialogue.answer,/江南农商/);
  assert.match(result.dialogue.answer,/新增存款被闸门阻断/);
  assert.equal(calls,2);assert.equal(model.serialize(),before);
});
