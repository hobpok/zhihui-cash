import {APP_RELEASE} from './release-version.js';

const MAX_WAIT_MS = 90000;

export function createCalculationController({model,onProgress,onComplete,onError,onCancel}) {
  let active = null, serial = 0;
  const cancel = (silent = false) => {
    if (!active) return false;
    const current = active;
    active = null;
    clearTimeout(current.timeout);
    current.worker.terminate();
    if (!silent) onCancel?.();
    return true;
  };
  const start = (pathId = 'AUTO', completeMessage = '已按当前输入重新计算。') => {
    cancel(true);
    const requestId = ++serial;
    const expectedSerialized = model.serialize();
    const state = model.getState();
    let worker;
    try {
      const url = new URL(`./calculation-worker.js?v=${encodeURIComponent(APP_RELEASE)}`, import.meta.url);
      worker = new Worker(url, {type:'module'});
    } catch (error) {
      onError?.(error instanceof Error ? error.message : '无法启动计算线程');
      return false;
    }
    const run = {requestId,worker,expectedSerialized,startedAt:performance.now(),timeout:null};
    active = run;
    const fail = message => {
      if (active !== run) return;
      cancel(true);
      onError?.(message);
    };
    run.timeout = setTimeout(() => fail('计算超过90秒，已停止；可检查输入后重试。'),MAX_WAIT_MS);
    worker.onerror = () => fail('计算线程加载或执行失败，请刷新页面后重试。');
    worker.onmessageerror = () => fail('计算结果无法读取，请刷新页面后重试。');
    worker.onmessage = event => {
      if (active !== run || event.data?.requestId !== requestId) return;
      const {type,progress,result,message} = event.data;
      if (type === 'progress') {
        if (model.serialize() !== expectedSerialized) { fail('计算期间运行数据已变化，旧结果已丢弃；请重新计算。'); return; }
        onProgress?.({...progress,elapsedMs:Math.round(performance.now()-run.startedAt)});
      } else if (type === 'result') {
        cancel(true);
        try {
          model.generateProposal(pathId,{result,expectedSerialized});
          onComplete?.(completeMessage,{...progress,elapsedMs:Math.round(performance.now()-run.startedAt)});
        } catch (error) {
          onError?.(error instanceof Error ? error.message : '计算结果提交失败');
        }
      } else if (type === 'error') fail(message || '计算失败');
    };
    onProgress?.({stage:'启动计算',nodes:0,candidates:0,elapsedMs:0});
    try { worker.postMessage({requestId,state,pathId}); }
    catch (error) { fail(error instanceof Error ? error.message : '计算输入无法传递'); return false; }
    return true;
  };
  return {start,cancel,isRunning:() => active !== null};
}
