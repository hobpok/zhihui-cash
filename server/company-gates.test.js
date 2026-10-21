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
  for(const [bankId,rate,opening,deposit] of [
    ['SIM-BANK-GZ',8,7900000000,300000000],
    ['SIM-BANK-JNRCB',6,5800000000,200000000]]) {
    const order=result.depositOrderEvidence.find(r=>r.bankId===bankId);
    assert.equal(order.thresholdNumerator/order.thresholdDenominator,rate/100);
    assert.equal(order.limitYuan,rate*1000000000);
    assert.equal(order.openingExposureYuan,opening);
    assert.equal(order.depositYuan,deposit);
    if(bankId==='SIM-BANK-GZ') {
      assert.equal(order.mode,'cd_sale_before_deposit');
      assert.equal(order.depositFirstGate.result,'block');
      assert.equal(order.depositFirstGate.afterYuan,8200000000);
      assert.equal(order.saleRemainingYuan,200000000);
      assert.equal(order.saleFirstExposureYuan,7700000000);
      assert.equal(order.saleFirstDepositGate.afterYuan,8000000000);
      assert.equal(order.saleFirstDepositGate.result,'pass');
      assert.equal(order.depositIndivisible,true);
    } else {
      assert.equal(order.cdYuan,100000000);
      assert.equal(order.depositFirstGate.result,'pass');
      assert.equal(order.cdFirstDepositGate.result,'block');
    }
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
      assert.match(body.messages[0].content,/每笔存款不可拆分/);
      assert.match(body.messages[0].content,/实际成交，已下达、已接收都不算完成前置/);
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
  assert.match(result.dialogue.answer,/79亿元／该行季度净资产1000亿元＝7.9%/);
  assert.match(result.dialogue.answer,/整笔存款3亿元后为82亿元（8.2%）/);
  assert.match(result.dialogue.answer,/先卖CD2亿元并实际成交后.*77亿元（7.7%）/);
  assert.match(result.dialogue.answer,/80亿元（8%），恰好等于上限，允许/);
  assert.match(result.dialogue.answer,/原敞口5.8%，先存款后6%，再买CD后6.1%/);
  assert.match(result.dialogue.answer,/换序先买CD后5.9%，再存整笔后6.1%/);
  assert.match(result.dialogue.answer,/每笔存款不可拆分，整笔全做或全不做/);
  assert.match(result.dialogue.answer,/公司10%.*本基金存款＋CD／NAV≤5%/);
  assert.match(result.dialogue.answer,/切换样例只换数据，不回退规则/);
  assert.equal(calls,2);assert.equal(model.serialize(),before);
});

test('Guangzhou sale releases company exposure only for actual fills, never acceptance or dispatch',()=>{
  const {model}=fixture();
  const sale=model.getState().plans.find(plan=>plan.businessType==='cd_sell' && plan.issuerId==='SIM-BANK-GZ');
  assert.equal(sale.targetYuan,200000000);
  const order=()=>createPlanningTools(JSON.parse(model.serialize()),
    {requestId:'company-sale-fill-facts',documentRevision:1}).execute('simulate_completion',{})
    .depositOrderEvidence.find(row=>row.mode==='cd_sale_before_deposit' && row.bankId==='SIM-BANK-GZ');
  const funding=model.getState().plans.find(plan=>plan.businessType==='interbank_repo_financing');
  const fundingProposal=model.generateProposal();model.approveProposal();
  const fundingStep=fundingProposal.proposal.steps.find(row=>row.planId===funding.planId && !row.blocked);
  const fundingInstructionId=model.send(fundingStep.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:fundingInstructionId});
  model.simulateEvent('fill',{instructionId:fundingInstructionId,nominalYuan:funding.targetYuan});
  const proposal=model.generateProposal();model.approveProposal();
  const step=proposal.proposal.steps.find(row=>row.planId===sale.planId && !row.blocked);
  assert.ok(step);
  const instructionId=model.send(step.stepId).sentInstructionId;
  assert.ok(instructionId);
  model.simulateEvent('accepted',{instructionId});
  const accepted=order();
  assert.equal(accepted.openingExposureYuan,7900000000);
  assert.equal(accepted.saleFilledYuan,0);
  assert.equal(accepted.saleLockedYuan,200000000);
  assert.equal(accepted.depositFirstGate.afterYuan,8200000000);
  assert.equal(accepted.depositFirstGate.result,'block');
  model.simulateEvent('fill',{instructionId,nominalYuan:100000000});
  const partial=order();
  assert.equal(partial.openingExposureYuan,7800000000);
  assert.equal(partial.saleRemainingYuan,100000000);
  assert.equal(partial.depositFirstGate.afterYuan,8100000000);
  assert.equal(partial.depositFirstGate.result,'block');
  assert.equal(partial.saleFirstDepositGate.afterYuan,8000000000);
  model.simulateEvent('fill',{instructionId,nominalYuan:100000000});
  const filled=order();
  assert.equal(filled.openingExposureYuan,7700000000);
  assert.equal(filled.saleRemainingYuan,0);
  assert.equal(filled.saleFilledYuan,200000000);
  assert.equal(filled.depositFirstGate.afterYuan,8000000000);
  assert.equal(filled.depositFirstGate.result,'pass');
});

test('deposit/CD shorthand and indivisibility questions require fresh tools and reject split-deposit prose',async()=>{
  for(const message of ['广州存款和CD为什么要先卖后存，能否反过来？',
    '存款能不能拆分成几笔，先做一部分？']) {
    const {tools}=fixture();let calls=0;
    const fetchImpl=async(_url,options)=>{
      const body=JSON.parse(options.body);
      if(calls===0) assert.deepEqual(body.tool_choice,{type:'function',function:{name:'simulate_completion'}});
      const response=calls++===0
        ? {role:'assistant',content:null,tool_calls:[{id:'fresh-order',type:'function',
          function:{name:'simulate_completion',arguments:'{}'}}]}
        : {role:'assistant',content:JSON.stringify({kind:'answer',references:['fresh-order'],
          narrative:'广州可以先存1亿元，再卖CD，剩余存款后补。'})};
      return new Response(JSON.stringify({object:'chat.completion',choices:[{index:0,message:response,
        finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}),
      {status:200,headers:{'Content-Type':'application/json'}});
    };
    const output=await invokeAiDialogue({message,tools,fetchImpl,resolved:{state:'real_ready',
      config:{mode:'real',provider:'deepseek',model:'deepseek-flash'},credential:'synthetic-test-only'}});
    assert.deepEqual(output.dialogue.references,['fresh-order']);
    assert.match(output.dialogue.answer,/每笔存款不可拆分，整笔全做或全不做/);
    assert.match(output.dialogue.answer,/先卖CD2亿元并实际成交后/);
    assert.doesNotMatch(output.dialogue.answer,/广州可以先存1亿元|剩余存款后补/);
    assert.equal(calls,2);
  }
});

test('an accepted unfilled deposit explains its real pending state instead of treating reservation as completion',async()=>{
  const {model}=fixture();
  // Isolate Jiangnan's pending deposit from Guangzhou's separate sale prerequisite.
  for(const plan of [...model.getState().plans])
    if(plan.issuerId==='SIM-BANK-GZ') model.deletePlan(plan.planId);
  const funding=model.getState().plans.find(plan=>plan.businessType==='interbank_repo_financing');
  let proposal=model.generateProposal();model.approveProposal();
  const fundingStep=proposal.proposal.steps.find(row=>row.planId===funding.planId && !row.blocked);
  const fundingId=model.send(fundingStep.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:fundingId});
  model.simulateEvent('fill',{instructionId:fundingId,nominalYuan:funding.targetYuan});
  model.simulateEvent('cash_available',{instructionId:fundingId,amountYuan:funding.targetYuan,
    cashFlowId:'FIN-PENDING-DEPOSIT'});
  const deposit=model.getState().plans.find(plan=>plan.businessType==='deposit' && plan.issuerId==='SIM-BANK-JNRCB');
  proposal=model.generateProposal();model.approveProposal();
  const depositStep=proposal.proposal.steps.find(row=>row.planId===deposit.planId && !row.blocked);
  const depositId=model.send(depositStep.stepId).sentInstructionId;
  model.simulateEvent('accepted',{instructionId:depositId});
  const before=model.serialize();
  const tools=createPlanningTools(JSON.parse(before),{requestId:'pending-deposit-order',documentRevision:1});
  let calls=0;
  const fetchImpl=async()=>{
    const message=calls++===0 ? {role:'assistant',content:null,tool_calls:[{id:'pending-order',type:'function',
      function:{name:'simulate_completion',arguments:'{}'}}]} : {role:'assistant',content:JSON.stringify({
      kind:'answer',references:['pending-order'],narrative:'存款已下达，所以CD已可以成交。'})};
    return new Response(JSON.stringify({object:'chat.completion',choices:[{index:0,message,
      finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}),
    {status:200,headers:{'Content-Type':'application/json'}});
  };
  const output=await invokeAiDialogue({message:'江南存款和CD为什么需要先后顺序？我已经下达存款了。',
    tools,fetchImpl,resolved:{state:'real_ready',config:{mode:'real',provider:'deepseek',model:'deepseek-flash'},
      credential:'synthetic-test-only'}});
  assert.match(output.dialogue.answer,/江南农商银行相关存款或存单已有成交或在途/);
  assert.match(output.dialogue.answer,/当前计量敞口60亿元（6%），含已下达买入预占/);
  assert.match(output.dialogue.answer,/存款意向2亿元，已成交0亿元，在途未成交2亿元/);
  assert.match(output.dialogue.answer,/依赖先存款的CD买入须等存款整笔实际成交/);
  assert.doesNotMatch(output.dialogue.answer,/所以CD已可以成交/);
  assert.equal(model.serialize(),before);
  assert.equal(calls,2);
});
