import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate} from './engine.js';
import {createModel} from './model.js';
import {createCalculationController} from './calculation-controller.js';

test('实际搜索进度累计到返回结果，不展示虚构比例', () => {
  const model=createModel();
  const progress=[];
  const result=calculate(model.getState(),{pathId:'AUTO',onProgress:item=>progress.push(item)});
  assert.deepEqual(result,calculate(model.getState(),{pathId:'AUTO'}));
  assert.ok(progress.some(item=>item.stage==='计算候选'));
  assert.equal(progress.at(-1).stage,'计算完成');
  assert.equal(progress.at(-1).nodes,result.trace.search.nodes);
  assert.equal(progress.at(-1).candidates,result.trace.search.exploredCandidates);
  assert.ok(progress.every(item=>!Object.hasOwn(item,'percent')));
});

test('Worker 启动失败及线程错误后可再次计算', () => {
  const originalWorker=globalThis.Worker;
  const errors=[];
  let shouldThrow=true, latest;
  globalThis.Worker=class {
    constructor(){if(shouldThrow)throw new Error('startup');latest=this;}
    postMessage(message){this.request=message;}
    terminate(){this.terminated=true;}
  };
  try {
    const model={serialize:()=>'{"revision":1}',getState:()=>({}),generateProposal:()=>{}};
    const controller=createCalculationController({model,onError:message=>errors.push(message)});
    assert.equal(controller.start(),false);
    assert.equal(controller.isRunning(),false);
    shouldThrow=false;
    assert.equal(controller.start(),true);
    latest.onerror();
    assert.equal(latest.terminated,true);
    assert.equal(controller.isRunning(),false);
    assert.equal(controller.start(),true);
    latest.onmessageerror();
    assert.equal(latest.terminated,true);
    assert.equal(controller.isRunning(),false);
    assert.equal(controller.start(),true);
    controller.cancel(true);
    assert.equal(errors.length,3);
  } finally {globalThis.Worker=originalWorker;}
});

test('重复请求、取消与状态变化拒绝旧 Worker 结果', () => {
  const originalWorker=globalThis.Worker;
  const instances=[];
  class FakeWorker {
    constructor(){this.terminated=false;instances.push(this);}
    postMessage(message){this.request=message;}
    terminate(){this.terminated=true;}
    emit(type,more={}){this.onmessage?.({data:{type,requestId:this.request.requestId,...more}});}
  }
  globalThis.Worker=FakeWorker;
  try {
    let snapshot='original',commits=0,failures=0,cancels=0;
    const model={serialize:()=>snapshot,getState:()=>({scenarioId:'TEST'}),generateProposal(_path,{expectedSerialized}){
      assert.equal(expectedSerialized,snapshot);commits++;
    }};
    const controller=createCalculationController({model,onError:()=>failures++,onCancel:()=>cancels++});
    controller.start();const first=instances.at(-1);
    controller.start();const second=instances.at(-1);
    assert.equal(first.terminated,true);
    first.emit('result',{result:{}});
    assert.equal(commits,0);
    snapshot='changed';
    second.emit('progress',{progress:{stage:'计算候选',nodes:5,candidates:1}});
    assert.equal(second.terminated,true);
    assert.equal(failures,1);
    second.emit('result',{result:{}});
    assert.equal(commits,0);
    controller.start();const third=instances.at(-1);
    controller.cancel();third.emit('result',{result:{}});
    assert.equal(commits,0);
    assert.equal(cancels,1);
    controller.start();instances.at(-1).emit('result',{result:{}});
    assert.equal(commits,1);
    assert.equal(controller.isRunning(),false);
  } finally {globalThis.Worker=originalWorker;}
});
