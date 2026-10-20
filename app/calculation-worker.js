import {calculate} from './engine.js';

self.onmessage = event => {
  const {requestId, state, pathId} = event.data ?? {};
  if (!Number.isSafeInteger(requestId) || !state || typeof state !== 'object') return;
  try {
    const result = calculate(state, {pathId, onProgress: progress => {
      self.postMessage({type:'progress',requestId,progress});
    }});
    self.postMessage({type:'result',requestId,result});
  } catch (error) {
    self.postMessage({type:'error',requestId,message:error instanceof Error ? error.message : '计算失败'});
  }
};
