// Streaming transport is transient. Only the reconstructed completion enters
// the existing schema, budget, tool and final-evidence validation pipeline.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
const invalid = () => Object.assign(new Error('AI_PROVIDER_INVALID'), { code:'AI_PROVIDER_INVALID' });
const aborted = () => Object.assign(new Error('AI_ABORTED'), { code:'AI_ABORTED' });

function stringPrefix(source, start) {
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '"') return { value, end:i + 1, complete:true };
    if (char.charCodeAt(0) < 32) return { value:'', end:i, complete:false };
    if (char !== '\\') { value += char; continue; }
    const escaped = source[++i];
    if (escaped === undefined) break;
    if (escaped === 'u') {
      const hex = source.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const escapes = { '"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t' };
      if (!Object.hasOwn(escapes, escaped)) break;
      value += escapes[escaped];
    }
  }
  // Do not publish half of a surrogate pair when a unicode escape is split.
  return { value:value.replace(/[\ud800-\udbff]$/, ''), end:source.length, complete:false };
}

/** Read only an allowlisted top-level JSON string; never nested/tool content. */
export function readablePreview(content) {
  let source = content.trimStart();
  if (source.startsWith('```')) {
    const opening = /^```(?:json)?\s*\n/i.exec(source);
    if (!opening) return '';
    source = source.slice(opening[0].length).trimStart();
  }
  if (source[0] !== '{') return '';
  let depth = 1;
  let expectKey = true;
  for (let i = 1; i < source.length;) {
    const char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === '"') {
      const token = stringPrefix(source, i);
      if (depth === 1 && expectKey) {
        if (!token.complete) return '';
        let next = token.end;
        while (/\s/.test(source[next] ?? '') && next < source.length) next++;
        if (source[next] !== ':') return '';
        next++;
        while (/\s/.test(source[next] ?? '') && next < source.length) next++;
        if (['narrative','question','reason'].includes(token.value) && source[next] === '"') {
          const text = stringPrefix(source, next).value;
          return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 3000);
        }
        expectKey = false;
        i = next;
      } else {
        if (!token.complete) return '';
        i = token.end;
      }
      continue;
    }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') { depth--; if (depth <= 0) return ''; }
    else if (char === ',' && depth === 1) expectKey = true;
    i++;
  }
  return '';
}

export async function readCompletionStream(response, { signal, onContent,
  maxResponseBytes = 65_536, maxCalls = 8, idleTimeoutMs = 30_000 } = {}) {
  const maxWireBytes = maxResponseBytes * 16; // SSE envelopes can exceed content many times.
  const length = response?.headers?.get?.('content-length');
  if (length != null && /^\d+$/.test(length) && Number(length) > maxWireBytes) throw invalid();
  if (!response?.body || typeof response.body.getReader !== 'function') throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal:true });
  const message = { role:'assistant', content:null };
  const calls = [];
  let wireBytes = 0, contentBytes = 0, lines = '', dataLines = [];
  let done = false, finish = null, usage = null, chunks = 0;
  const checkAbort = () => { if (signal?.aborted) throw aborted(); };
  const addText = value => {
    if (typeof value !== 'string') throw invalid();
    contentBytes += encoder.encode(value).byteLength;
    if (contentBytes > maxResponseBytes) throw invalid();
    return value;
  };
  function event() {
    checkAbort();
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    if (raw === '[DONE]') {
      if (!finish || !usage) throw invalid();
      done = true;
      return;
    }
    if (done) throw invalid();
    let packet;
    try { packet = JSON.parse(raw); } catch { throw invalid(); }
    if (!object(packet) || packet.object !== 'chat.completion.chunk' ||
        !Array.isArray(packet.choices) || packet.choices.length > 1 ||
        (!packet.choices.length && (!finish || !object(packet.usage)))) throw invalid();
    if (packet.usage != null) {
      if (usage !== null || !object(packet.usage) ||
          (packet.choices.length && packet.choices[0]?.finish_reason == null)) throw invalid();
      usage = packet.usage;
    }
    if (!packet.choices.length) return; // Legacy usage-only terminal chunk.
    const choice = packet.choices[0];
    const delta = choice?.delta;
    if (!object(choice) || choice.index !== 0 || !object(delta) || finish) throw invalid();
    if (delta.role != null && delta.role !== 'assistant') throw invalid();
    if (delta.reasoning_content != null && delta.reasoning_content !== '') throw invalid();
    if (delta.content != null) {
      message.content = (message.content ?? '') + addText(delta.content);
      onContent?.(message.content);
    }
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > maxCalls) throw invalid();
      for (const part of delta.tool_calls) {
        if (!object(part) || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= maxCalls) throw invalid();
        const call = calls[part.index] ??= { id:'', type:'function', function:{ name:'', arguments:'' } };
        if (part.type != null && part.type !== 'function') throw invalid();
        if (part.id != null) call.id += addText(part.id);
        if (part.function != null) {
          if (!object(part.function)) throw invalid();
          if (part.function.name != null) call.function.name += addText(part.function.name);
          if (part.function.arguments != null) call.function.arguments += addText(part.function.arguments);
        }
      }
    }
    if (choice.finish_reason != null) {
      if (!['stop','tool_calls'].includes(choice.finish_reason)) throw invalid();
      finish = choice.finish_reason;
    }
  }
  async function read() {
    checkAbort();
    let timer, listener;
    const interrupt = new Promise((_, reject) => {
      listener = () => reject(aborted());
      signal?.addEventListener('abort', listener, { once:true });
      timer = setTimeout(() => reject(invalid()), idleTimeoutMs);
    });
    try { return await Promise.race([reader.read(), interrupt]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', listener); }
  }
  try {
    while (!done) {
      if (++chunks > 16_384) throw invalid();
      const chunk = await read();
      checkAbort();
      if (chunk.done) { decoder.decode(); throw invalid(); } // DONE is mandatory.
      if (!(chunk.value instanceof Uint8Array)) throw invalid();
      wireBytes += chunk.value.byteLength;
      if (wireBytes > maxWireBytes) throw invalid();
      lines += decoder.decode(chunk.value, { stream:true });
      let end;
      while ((end = lines.indexOf('\n')) !== -1) {
        const line = lines.slice(0, end).replace(/\r$/, '');
        lines = lines.slice(end + 1);
        if (!line) event();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        // SSE comments, event, id and retry fields do not contain message data.
        if (done) break;
      }
    }
    checkAbort();
    if (calls.length) {
      if (Array.from({length:calls.length}, (_, index) => calls[index]).some(call => !call)) throw invalid();
      message.tool_calls = calls;
    }
    return { object:'chat.completion', choices:[{ index:0, finish_reason:finish, message }], usage };
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (error?.code === 'AI_PROVIDER_INVALID' || error?.code === 'AI_ABORTED') throw error;
    throw invalid();
  } finally {
    // Cancel even after DONE: the terminal marker is authoritative and a peer
    // need not keep the request alive by leaving its HTTP body open.
    Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}
