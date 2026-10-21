import assert from 'node:assert/strict';
import test from 'node:test';
import {executionOrderHintRows,renderExecutionOrderHints} from './execution-order-ui.js';

const YI=100000000;
function fixture(){
  return {plans:[{planId:'deposit',label:'江南存款',businessType:'deposit'},{planId:'buy',label:'江南买存单'},
    {planId:'sale',label:'广州卖存单'},{planId:'guangzhou',label:'广州存款'}],
  execution:{instructions:{dep:{planId:'deposit',nominalYuan:2*YI,filledYuan:0,status:'accepted'},
    buy:{planId:'buy',nominalYuan:YI,filledYuan:0,status:'accepted'},
    sale:{planId:'sale',nominalYuan:2*YI,filledYuan:0,status:'accepted'},
    gz:{planId:'guangzhou',nominalYuan:3*YI,filledYuan:0,status:'accepted'}}}};
}

test('投管成交顺序显示江南整笔存款前置及已接收仍未成交',()=>{
  const state=fixture(),dependencies={buy:[{planId:'deposit',minimumYuan:2*YI,actualYuan:0}]};
  const html=renderExecutionOrderHints(state,'buy',dependencies);
  assert.match(html,/先江南存款累计成交至少2亿（存款须整笔成交），再成交本笔/);
  assert.match(html,/前置已成交0亿 \/ 至少2亿，尚差2亿/);
  assert.match(html,/下达／投管接收不计成交/);
  assert.equal(executionOrderHintRows(state,'buy',dependencies)[0].ready,false);
  assert.match(renderExecutionOrderHints(state,'dep',dependencies),/再成交江南买存单/);
});

test('投管显示广州先卖券后存款及真实部分成交缺口',()=>{
  const dependencies={gz:[{planId:'sale',minimumYuan:2*YI,actualYuan:YI}]};
  const html=renderExecutionOrderHints(fixture(),'gz',dependencies);
  assert.match(html,/先广州卖存单累计成交至少2亿/);
  assert.match(html,/前置已成交1亿 \/ 至少2亿，尚差1亿/);
});

test('前置完成以累计成交金额判断，缺失金额显示待核实',()=>{
  const state=fixture();
  const ready=executionOrderHintRows(state,'buy',{buy:[{planId:'deposit',minimumYuan:2*YI,actualYuan:2*YI}]});
  assert.equal(ready[0].ready,true);assert.match(ready[0].text,/前置已完成/);
  const unknown=executionOrderHintRows(state,'buy',{buy:[{planId:'deposit',minimumYuan:2*YI,actualYuan:null}]});
  assert.equal(unknown[0].ready,false);assert.match(unknown[0].text,/前置状态待核实/);
});

test('没有真实依赖的存单不显示强制存款优先，也不修改执行事实',()=>{
  const state=fixture(),before=structuredClone(state);
  assert.equal(renderExecutionOrderHints(state,'buy',{}),'');
  assert.equal(renderExecutionOrderHints(state,'missing',{}),'');
  assert.deepEqual(state,before);
});

test('前置和后续指令标签安全转义，后续成交完成后不再提示等待',()=>{
  const state=fixture();state.plans[1].label='<img src=x onerror=alert(1)>';
  const deps={buy:[{planId:'deposit',minimumYuan:2*YI,actualYuan:0}]};
  assert.doesNotMatch(renderExecutionOrderHints(state,'dep',deps),/<img/);
  assert.match(renderExecutionOrderHints(state,'dep',deps),/&lt;img/);
  state.execution.instructions.buy.filledYuan=YI;
  assert.equal(renderExecutionOrderHints(state,'dep',deps),'');
});

test('非单日到账依赖明确以实际到账而不是成交衡量',()=>{
  const deps={gz:[{planId:'sale',minimumYuan:2*YI,actualYuan:YI,basis:'cash_available'}]};
  const html=renderExecutionOrderHints(fixture(),'gz',deps);
  assert.match(html,/累计到账可用至少2亿/);
  assert.match(html,/前置已到账可用1亿/);
  assert.doesNotMatch(html,/前置已成交/);
});
