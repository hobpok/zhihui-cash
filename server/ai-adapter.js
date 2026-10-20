const MAX_PROMPT_CHARS = 4000;
const MAX_TEXT_CHARS = 4000;
const MAX_TOKEN_COUNT = 1000000;
const MAX_RESPONSE_BYTES = 65536;
const MAX_OUTPUT_TOKENS = 1024;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro']);

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Only plain text and bounded token counts cross the adapter boundary. */
export function normalizeAiOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output) ||
      Object.keys(output).some(key => !['text', 'usage'].includes(key))) throw adapterError('AI_OUTPUT_INVALID');
  const { text, usage } = output;
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
      /<\/?[a-z][^>]*>/i.test(text)) throw adapterError('AI_OUTPUT_INVALID');
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) ||
      Object.keys(usage).length !== 2 ||
      !Object.hasOwn(usage, 'inputTokens') || !Object.hasOwn(usage, 'outputTokens') ||
      !Object.values(usage).every(value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_COUNT)) {
    throw adapterError('AI_OUTPUT_INVALID');
  }
  return { text: text.trim(), usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
}

async function mockAdapter({ signal }) {
  if (signal?.aborted) throw adapterError('AI_ABORTED');
  const output = { text: '离线响应检查通过，未调用AI服务。',
    usage: { inputTokens: 0, outputTokens: 0 } };
  if (signal?.aborted) throw adapterError('AI_ABORTED');
  return output;
}

function checkAbort(signal) {
  if (signal?.aborted) throw adapterError('AI_ABORTED');
}

async function boundedJson(response, signal) {
  const length = response.headers?.get?.('content-length');
  if (length !== null && length !== undefined && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    throw adapterError('AI_PROVIDER_INVALID');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw adapterError('AI_PROVIDER_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw adapterError('AI_PROVIDER_INVALID');
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw adapterError('AI_PROVIDER_INVALID');
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (signal?.aborted) throw adapterError('AI_ABORTED');
    if (error?.code === 'AI_PROVIDER_INVALID') throw error;
    throw adapterError('AI_PROVIDER_INVALID');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw adapterError('AI_PROVIDER_INVALID'); }
}

async function deepseekAdapter({ prompt, config, credential, signal, fetchImpl }) {
  if (config?.provider !== 'deepseek' || !DEEPSEEK_MODELS.has(config.model) ||
      typeof credential !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(credential)) {
    throw adapterError('AI_UNAVAILABLE');
  }
  checkAbort(signal);
  let response;
  try {
    response = await fetchImpl(DEEPSEEK_URL, {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'disabled' }, stream: false, max_tokens: MAX_OUTPUT_TOKENS }),
    });
  } catch {
    if (signal?.aborted) throw adapterError('AI_ABORTED');
    throw adapterError('AI_PROVIDER_UNAVAILABLE');
  }
  checkAbort(signal);
  // Never follow a redirect with a bearer credential; never parse provider error bodies.
  if (!response || response.status !== 200 || response.redirected ||
      (response.url && response.url !== DEEPSEEK_URL)) throw adapterError('AI_PROVIDER_ERROR');
  const data = await boundedJson(response, signal);
  checkAbort(signal);
  const choice = data?.choices?.[0];
  if (data?.object !== 'chat.completion' || !Array.isArray(data.choices) || data.choices.length !== 1 ||
      choice?.finish_reason !== 'stop' || choice?.message?.role !== 'assistant' ||
      (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 0)) ||
      (choice.message.reasoning_content != null && choice.message.reasoning_content !== '') ||
      typeof choice.message.content !== 'string' || !data.usage || typeof data.usage !== 'object') {
    throw adapterError('AI_PROVIDER_INVALID');
  }
  const output = { text: choice.message.content,
    usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } };
  return normalizeAiOutput(output);
}

/** Injectable adapters are for code-level tests. HTTP input never selects one. */
export async function invokeAiAdapter({ prompt, resolved, signal, adapters, fetchImpl = globalThis.fetch }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) throw adapterError('AI_PROMPT_INVALID');
  const mock = resolved?.state === 'mock_ready' && resolved.config?.mode === 'mock';
  const real = resolved?.state === 'real_ready' && resolved.config?.mode === 'real' &&
    resolved.config?.provider === 'deepseek';
  if (!mock && !real) throw adapterError('AI_UNAVAILABLE');
  const adapter = mock ? (adapters?.mock ?? mockAdapter) : (adapters?.deepseek ?? deepseekAdapter);
  if (typeof adapter !== 'function') throw adapterError('AI_UNAVAILABLE');
  checkAbort(signal);
  const output = await adapter({ prompt, config: resolved.config, credential: resolved.credential, signal, fetchImpl });
  checkAbort(signal);
  return { ...normalizeAiOutput(output), simulated: mock };
}
