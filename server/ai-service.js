import { HttpError } from './errors.js';
import { invokeAiAdapter, normalizeAiOutput } from './ai-adapter.js';
import { publicAiStatus, resolveAiConfig } from './ai-config.js';
import { validateDocument } from './contracts.js';
import { invokeAiDialogue, latestUserRequest, aiDialogueDiagnosticReason, aiDialogueDiagnostic } from './ai-dialogue.js';
import { createPlanningTools } from './planning-tools.js';
import { SINGLE_DAY_DEMO_MODE } from '../app/initial-data.js';

const DAY_MS = 86_400_000;
const RETENTION_MS = 7 * DAY_MS;
const MAX_PROMPT_CHARS = 2000;
const MAX_DIALOGUE_CHARS = 8000;
const MAX_DIALOGUE_BYTES = 32768;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const encoder = new TextEncoder();
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
// Leave room for request metadata so the complete API response stays under 128 KiB.
const MAX_RESULT_BYTES = 120 * 1024;
const MAX_HISTORY_BYTES = 16_000;
const MAX_STORED_BYTES = MAX_RESULT_BYTES + MAX_HISTORY_BYTES + 8192;
const CONTINUITY_VERSION = 1;
// Failure rows persist only allowlisted codes/categories, never provider text or exception details.
const PUBLIC_FAILURE_CODES = new Set([
  'AI_BUDGET_EXCEEDED', 'AI_PROVIDER_UNAVAILABLE', 'AI_PROVIDER_ERROR', 'AI_PROVIDER_INVALID',
  'AI_UNAVAILABLE', 'AI_DIALOGUE_INVALID', 'AI_OUTPUT_INVALID', 'AI_TOOL_FAILED',
  'AI_TOOL_INVALID', 'AI_DOCUMENT_STALE',
]);
function failureCode(error) {
  return PUBLIC_FAILURE_CODES.has(error?.code) ? error.code : 'AI_FAILED';
}
function failureJson(error) {
  const diagnosticReason = aiDialogueDiagnosticReason(error);
  return JSON.stringify({ errorCode: failureCode(error),
    ...(diagnosticReason === 'unknown' ? {} : { diagnosticReason }) });
}
function storedDiagnosticReason(json) {
  try {
    const stored = JSON.parse(json);
    const reason = aiDialogueDiagnosticReason({ code: stored?.errorCode,
      diagnosticReason: stored?.diagnosticReason });
    return reason === 'unknown' ? undefined : reason;
  } catch { return undefined; }
}
function storedFailureCode(json) {
  try {
    const stored = JSON.parse(json);
    return PUBLIC_FAILURE_CODES.has(stored?.errorCode) ? stored.errorCode : 'AI_FAILED';
  } catch { return 'AI_FAILED'; }
}

function statement(db, sql, ...args) { return db.prepare(sql).bind(...args); }
function dayAt(ms) { return new Date(ms).toISOString().slice(0, 10); }
function usage(day, used, limit) { return { day, used, remaining: limit === null ? null : Math.max(0, limit - used) }; }
async function hashPrompt(prompt) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(prompt));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'prompt,requestId'
    || typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)
    || typeof body.prompt !== 'string' || !body.prompt.trim() || [...body.prompt].length > MAX_PROMPT_CHARS
    || encoder.encode(body.prompt).byteLength > 8192) throw new HttpError(400, 'INVALID_AI_REQUEST');
  return body;
}
function validateDialogue(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    !['documentRevision,message,requestId,runDocumentId',
      'documentRevision,message,previousRequestId,requestId,runDocumentId'].includes(Object.keys(body).sort().join(',')) ||
    typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId) ||
    (body.previousRequestId !== undefined &&
      (typeof body.previousRequestId !== 'string' || !REQUEST_ID.test(body.previousRequestId) ||
        body.previousRequestId === body.requestId)) ||
    typeof body.message !== 'string' || !body.message.trim() ||
    [...body.message].length > MAX_DIALOGUE_CHARS || encoder.encode(body.message).byteLength > MAX_DIALOGUE_BYTES ||
    typeof body.runDocumentId !== 'string' || !DOCUMENT_ID.test(body.runDocumentId) ||
    !Number.isSafeInteger(body.documentRevision) || body.documentRevision < 1) {
    throw new HttpError(400, 'INVALID_AI_REQUEST');
  }
  return body;
}
function publicRequest(row, quota) {
  const tokenUsage = row.input_tokens === null || row.output_tokens === null ? null
    : { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) };
  const result = { requestId: row.request_id, status: row.status, simulated: Boolean(row.simulated), usage: quota,
    tokenUsage };
  if (row.status === 'completed') {
    result.text = row.result_text ?? '';
    if (row.operation === 'dialogue') {
      const stored = JSON.parse(row.result_json);
      result.dialogue = stored?.continuityVersion === CONTINUITY_VERSION && stored.continuity && stored.dialogue
        ? stored.dialogue : stored;
    }
  }
  else if (row.status !== 'processing') result.errorCode = row.status === 'failed'
    ? storedFailureCode(row.result_json)
    : { timed_out: 'AI_TIMEOUT', cancelled: 'AI_CANCELLED', expired: 'AI_EXPIRED' }[row.status];
  if (row.status === 'failed') {
    const reason = storedDiagnosticReason(row.result_json);
    if (reason !== undefined) {
      result.diagnosticReason = reason;
      result.diagnostic = aiDialogueDiagnostic({code: result.errorCode, diagnosticReason: reason});
    }
  }
  return result;
}

function normalizeDialogueOutput(output, continuity) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || output.simulated !== false) {
    throw new Error('invalid dialogue output');
  }
  const normalized = normalizeAiOutput({ text: output.text, usage: output.usage });
  const dialogue = output.dialogue && { ...output.dialogue };
  if (!dialogue || typeof dialogue !== 'object' || Array.isArray(dialogue) ||
    typeof dialogue.status !== 'string' || dialogue.status.length > 64 ||
    typeof dialogue.answer !== 'string' || dialogue.answer.length > 4000 ||
    !Array.isArray(dialogue.references) || !Array.isArray(dialogue.evidence)) {
    throw new Error('invalid dialogue result');
  }
  if (dialogue.diagnostic) {
    const reason = aiDialogueDiagnosticReason({code:'AI_DIALOGUE_INVALID', diagnosticReason:dialogue.diagnostic.reason});
    const recovery = dialogue.diagnostic.recovery;
    if (reason !== 'unknown' && dialogue.diagnostic.recovered === true &&
        ['trusted_summary','rewritten_answer'].includes(recovery)) {
      dialogue.diagnostic = {reason, recovery, recovered:true};
    } else delete dialogue.diagnostic;
  }
  const json = JSON.stringify({ continuityVersion: CONTINUITY_VERSION, dialogue, continuity });
  if (!json || encoder.encode(json).byteLength > MAX_STORED_BYTES ||
    encoder.encode(JSON.stringify({ ...normalized, simulated: false, dialogue })).byteLength > MAX_RESULT_BYTES) {
    throw new Error('dialogue result too large');
  }
  return { ...normalized, resultJson: json };
}

function historyText(value, maxChars, maxBytes) {
  if (typeof value !== 'string') return '';
  let result = '';
  let size = 0;
  let chars = 0;
  for (const char of value) {
    if (chars >= maxChars) break;
    const charSize = encoder.encode(char).byteLength;
    if (size + charSize > maxBytes) break;
    result += char;
    size += charSize;
    chars++;
  }
  return result;
}

function boundedHistory(items) {
  const history = items.slice(-3).map(item => ({
    userMessage: historyText(item.userMessage, 2000, 6000),
    assistantAnswer: historyText(item.assistantAnswer, 4000, 9000),
  }));
  while (history.length && encoder.encode(JSON.stringify(history)).byteLength > MAX_HISTORY_BYTES) history.shift();
  return history;
}

export function createAiService({ invoke = invokeAiAdapter, dialogueInvoke = invokeAiDialogue,
  toolsFactory = createPlanningTools, now = Date.now, pollIntervalMs = 500 } = {}) {
  async function usageFor(db, memberId, limit) {
    const day = dayAt(now());
    const row = await statement(db, 'SELECT COUNT(*) AS used FROM ai_requests WHERE member_id=? AND accepted_day=?', memberId, day).first();
    return usage(day, Number(row?.used ?? 0), limit);
  }
  async function requestRow(db, memberId, requestId) {
    return statement(db, 'SELECT request_id,prompt_hash,operation,status,result_text,result_json,lease_until_ms,simulated,input_tokens,output_tokens FROM ai_requests WHERE member_id=? AND request_id=?', memberId, requestId).first();
  }
  async function requestRowAfterReservation(db, memberId, requestId) {
    // A successful INSERT is authoritative, but a status read may briefly return
    // no row. Retry once before deciding whether it is safe to start the adapter.
    return await requestRow(db, memberId, requestId) ??
      await requestRow(db, memberId, requestId);
  }
  async function previousHistory(db, memberId, body, saved) {
    if (!body.previousRequestId) return [];
    const row = await requestRow(db, memberId, body.previousRequestId);
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    if (row.operation !== 'dialogue' || row.status !== 'completed' || !row.result_json) {
      throw new HttpError(409, 'AI_HISTORY_UNAVAILABLE');
    }
    let stored;
    try { stored = JSON.parse(row.result_json); } catch { throw new HttpError(409, 'AI_HISTORY_UNAVAILABLE'); }
    if (stored?.continuityVersion !== CONTINUITY_VERSION || !stored.continuity || !stored.dialogue) {
      throw new HttpError(409, 'AI_HISTORY_UNAVAILABLE');
    }
    const continuity = stored?.continuity;
    if (continuity.runDocumentId !== body.runDocumentId ||
      continuity.documentRevision !== body.documentRevision ||
      continuity.runId !== (saved.context?.runId ?? null)) {
      throw new HttpError(409, 'AI_HISTORY_STALE');
    }
    if (!Array.isArray(continuity.history) || continuity.history.length > 3 ||
      continuity.history.some(item => !item || typeof item.userMessage !== 'string' ||
        typeof item.assistantAnswer !== 'string') ||
      typeof continuity.userMessage !== 'string' ||
      !['answer', 'answered', 'clarification', 'unsupported'].includes(stored.dialogue?.status) ||
      typeof stored.dialogue.answer !== 'string') {
      throw new HttpError(409, 'AI_HISTORY_UNAVAILABLE');
    }
    const assistantAnswer = typeof stored.dialogue.narrative === 'string' && stored.dialogue.narrative.trim()
      ? stored.dialogue.narrative : stored.dialogue.answer;
    return boundedHistory([...continuity.history,
      { userMessage: continuity.userMessage, assistantAnswer }]);
  }
  async function runDocument(db, memberId, id, revision) {
    const row = await statement(db, `SELECT revision,value_json FROM documents
      WHERE owner_id=? AND kind='run' AND id=? AND deleted=0
      AND EXISTS (SELECT 1 FROM members WHERE id=? AND status='active')`, memberId, id, memberId).first();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    if (Number(row.revision) !== revision) throw new HttpError(409, 'AI_DOCUMENT_STALE');
    let value;
    try { value = JSON.parse(row.value_json); validateDocument('run', id, value); }
    catch { throw new HttpError(409, 'AI_DOCUMENT_INVALID'); }
    if (value.initialData?.demoMode !== SINGLE_DAY_DEMO_MODE || value.progressId !== 'initial') {
      throw new HttpError(409, 'AI_RUN_UNSUPPORTED');
    }
    return value;
  }
  async function profileNotes(db, memberId) {
    const row = await statement(db, `SELECT value_json FROM documents WHERE owner_id=? AND kind='settings'
      AND id='profile' AND deleted=0`, memberId).first();
    if (!row) return '';
    try {
      const value = JSON.parse(row.value_json);
      validateDocument('settings', 'profile', value);
      return value.preferences?.notes ?? '';
    } catch { return ''; }
  }
  async function expireStale(db, memberId) {
    const time = now();
    await statement(db, "UPDATE ai_requests SET status='expired' WHERE member_id=? AND status='processing' AND lease_until_ms<=?", memberId, time).run();
  }
  async function cleanup(db) {
    await statement(db, 'DELETE FROM ai_requests WHERE expires_at_ms<=? AND status<>\'processing\'', now()).run();
  }
  function config(env, memberId) {
    const resolved = resolveAiConfig(env, memberId);
    const publicConfig = publicAiStatus(resolved);
    const limit = publicConfig.dailyLimit;
    const timeoutMs = publicConfig.timeoutMs;
    return { resolved, publicConfig, limit, timeoutMs };
  }
  async function status(db, env, memberId) {
    const { publicConfig, limit } = config(env, memberId);
    await expireStale(db, memberId);
    const active = await statement(db, "SELECT request_id FROM ai_requests WHERE member_id=? AND status IN ('processing','cancelled') AND lease_until_ms>? LIMIT 1", memberId, now()).first();
    return {
      status: publicConfig.state, simulated: publicConfig.state === 'mock_ready',
      provider: publicConfig.provider, model: publicConfig.model,
      limits: { dailyRequests: limit, timeoutMs: publicConfig.timeoutMs, maxPromptChars: MAX_PROMPT_CHARS },
      usage: await usageFor(db, memberId, limit), activeRequestId: active?.request_id ?? null,
    };
  }
  async function getRequest(db, env, memberId, requestId) {
    const { limit } = config(env, memberId);
    await expireStale(db, memberId);
    const row = await requestRow(db, memberId, requestId);
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    const { text, dialogue, ...metadata } = publicRequest(row, await usageFor(db, memberId, limit));
    return metadata;
  }
  async function cancel(db, env, memberId, requestId) {
    const { limit } = config(env, memberId);
    await statement(db, "UPDATE ai_requests SET status='cancelled',result_text=NULL,result_json=NULL WHERE member_id=? AND request_id=? AND status='processing'", memberId, requestId).run();
    const row = await requestRow(db, memberId, requestId);
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    return publicRequest(row, await usageFor(db, memberId, limit));
  }
  async function submitOperation(db, env, memberId, rawBody, operation, observation = null, onProgress = null) {
    const body = operation === 'dialogue' ? validateDialogue(rawBody) : validate(rawBody);
    const { resolved, publicConfig, limit, timeoutMs } = config(env, memberId);
    const promptHash = await hashPrompt(operation === 'dialogue'
      ? JSON.stringify(['dialogue', body.message, body.runDocumentId, body.documentRevision,
        ...(body.previousRequestId ? [body.previousRequestId] : [])]) : body.prompt);
    let saved;
    if (operation === 'dialogue') saved = await runDocument(db, memberId, body.runDocumentId, body.documentRevision);
    await expireStale(db, memberId);
    await cleanup(db);
    let existing = await requestRow(db, memberId, body.requestId);
    if (existing) {
      if (existing.operation !== operation || existing.prompt_hash !== promptHash) throw new HttpError(409, 'REQUEST_ID_CONFLICT');
      return { httpStatus: existing.status === 'processing' ? 202 : 200,
        value: publicRequest(existing, await usageFor(db, memberId, limit)) };
    }
    const history = operation === 'dialogue' ? await previousHistory(db, memberId, body, saved) : [];
    if (operation === 'dialogue' ? publicConfig.state !== 'real_ready'
      : publicConfig.state !== 'mock_ready' && publicConfig.state !== 'real_ready') throw new HttpError(503, 'AI_NOT_CONFIGURED');
    const time = now();
    const deadlineMs = time + timeoutMs;
    const day = dayAt(time);
    const simulated = publicConfig.state === 'mock_ready' ? 1 : 0;
    const initialTokens = simulated ? 0 : null;
    // The optional quota and active-request predicates run inside one SQLite INSERT.
    // D1 serializes the write even when separate Workers receive a request together.
    const reserveSql = `INSERT OR IGNORE INTO ai_requests
      (member_id,request_id,prompt_hash,operation,status,result_text,accepted_day,created_at_ms,lease_until_ms,expires_at_ms,simulated,input_tokens,output_tokens)
      SELECT ?,?,?,?,'processing',NULL,?,?,?,?,?,?,?
      WHERE (? IS NULL OR (SELECT COUNT(*) FROM ai_requests WHERE member_id=? AND accepted_day=?) < ?)
        AND NOT EXISTS (SELECT 1 FROM ai_requests WHERE member_id=? AND status IN ('processing','cancelled') AND lease_until_ms>?)
        ${operation === 'dialogue' ? `AND EXISTS (SELECT 1 FROM documents WHERE owner_id=? AND kind='run' AND id=?
          AND revision=? AND deleted=0)` : ''}`;
    const reserved = await statement(db, reserveSql, memberId, body.requestId, promptHash, operation, day, time,
      deadlineMs + 5000, time + RETENTION_MS, simulated, initialTokens, initialTokens,
      limit, memberId, day, limit, memberId, time,
      ...(operation === 'dialogue' ? [memberId, body.runDocumentId, body.documentRevision] : [])).run();
    if (Number(reserved.meta?.changes ?? 0) !== 1) {
      existing = await requestRow(db, memberId, body.requestId);
      if (existing) {
        if (existing.operation !== operation || existing.prompt_hash !== promptHash) throw new HttpError(409, 'REQUEST_ID_CONFLICT');
        return { httpStatus: existing.status === 'processing' ? 202 : 200,
          value: publicRequest(existing, await usageFor(db, memberId, limit)) };
      }
      const currentUsage = await usageFor(db, memberId, limit);
      if (currentUsage.remaining === 0) throw new HttpError(429, 'AI_DAILY_LIMIT');
      if (operation === 'dialogue') await runDocument(db, memberId, body.runDocumentId, body.documentRevision);
      throw new HttpError(409, 'AI_REQUEST_ACTIVE');
    }

    // A concurrent cancellation may arrive between reservation and invocation.
    const beforeInvocation = await requestRowAfterReservation(db, memberId, body.requestId);
    if (!beforeInvocation) throw new HttpError(503, 'AI_UNAVAILABLE');
    if (beforeInvocation.status !== 'processing') {
      if (beforeInvocation.status === 'cancelled')
        await statement(db, "UPDATE ai_requests SET lease_until_ms=0 WHERE member_id=? AND request_id=? AND status='cancelled'", memberId, body.requestId).run();
      return { httpStatus: 200, value: publicRequest(beforeInvocation, await usageFor(db, memberId, limit)) };
    }
    if (operation === 'dialogue') {
      try { saved = await runDocument(db, memberId, body.runDocumentId, body.documentRevision); }
      catch (error) {
        await statement(db, "UPDATE ai_requests SET status='failed',result_text=NULL,result_json=?,lease_until_ms=0 WHERE member_id=? AND request_id=? AND status='processing'",
          failureJson(['NOT_FOUND', 'AI_DOCUMENT_STALE', 'AI_DOCUMENT_INVALID', 'AI_RUN_UNSUPPORTED'].includes(error?.code)
            ? { code: 'AI_DOCUMENT_STALE' } : error), memberId, body.requestId).run();
        return { httpStatus: 200, value: publicRequest(await requestRow(db, memberId, body.requestId), await usageFor(db, memberId, limit)) };
      }
    }
    const controller = new AbortController();
    let timer;
    let poll;
    let pollActive = false;
    let pollStopped = false;
    let finish;
    const interrupted = new Promise(resolve => { finish = resolve; });
    let outcome;
    let generationStartedAt = null;
    if (now() >= deadlineMs) {
      controller.abort();
      outcome = { kind: 'timed_out' };
    } else {
      timer = setTimeout(() => {
        pollStopped = true;
        controller.abort(); finish({ kind: 'timed_out' });
      }, Math.max(0, deadlineMs - now()));
      poll = setInterval(() => {
        if (pollStopped || pollActive) return;
        pollActive = true;
        requestRow(db, memberId, body.requestId).then(row => {
          if (!pollStopped && row?.status === 'cancelled') {
            pollStopped = true;
            controller.abort(); finish({ kind: 'cancelled' });
          }
        }).catch(() => {
          // An unsuccessful or empty status read does not prove cancellation.
          // The deadline and final conditional UPDATE protect this request.
        }).finally(() => { pollActive = false; });
      }, pollIntervalMs);
      try {
        if (observation) generationStartedAt = performance.now();
        const invocation = Promise.resolve().then(async () => operation === 'dialogue'
          ? dialogueInvoke({ message: body.message, resolved, signal: controller.signal,
            history, ...(typeof onProgress === 'function' ? { onProgress: event => {
              if (controller.signal.aborted || pollStopped) return;
              try { onProgress(event); } catch { /* Preview transport cannot change the durable result. */ }
            } } : {}),
            tools: toolsFactory(saved, { requestId: body.requestId, documentRevision: body.documentRevision,
              notes: await profileNotes(db, memberId) }) })
          : invoke({ prompt: body.prompt, resolved, signal: controller.signal }))
          .then(value => ({ kind: 'completed', value }), error => ({ kind: 'failed', error }));
        outcome = await Promise.race([invocation, interrupted]);
      } finally {
        pollStopped = true;
        clearTimeout(timer); clearInterval(poll);
      }
    }
    if (outcome.kind !== 'completed') controller.abort();
    let resultText = null;
    let resultJson = null;
    let tokenUsage = { inputTokens: initialTokens, outputTokens: initialTokens };
    if (outcome.kind === 'completed') {
      try {
        if (outcome.value?.simulated !== Boolean(simulated)) throw new Error('unexpected adapter mode');
        const normalized = operation === 'dialogue' ? normalizeDialogueOutput(outcome.value, {
          runDocumentId: body.runDocumentId, documentRevision: body.documentRevision,
          runId: saved.context?.runId ?? null,
          userMessage: historyText(latestUserRequest(body.message), 2000, 6000), history,
        })
          : normalizeAiOutput({ text: outcome.value.text, usage: outcome.value.usage });
        resultText = normalized.text;
        resultJson = normalized.resultJson ?? null;
        tokenUsage = normalized.usage;
      } catch (error) { outcome = { kind: 'failed', error }; }
    }
    const finalStatus = resultText !== null ? 'completed' : outcome.kind === 'timed_out' ? 'timed_out'
      : outcome.kind === 'cancelled' ? 'cancelled' : 'failed';
    if (generationStartedAt !== null) {
      try { observation?.recordAiGeneration(finalStatus, performance.now() - generationStartedAt); }
      catch { /* Performance observation cannot change request finalization. */ }
    }
    if (finalStatus === 'failed') resultJson = failureJson(outcome.error);
    await statement(db, `UPDATE ai_requests SET status=?,result_text=?,result_json=?,input_tokens=?,output_tokens=?,lease_until_ms=0
      WHERE member_id=? AND request_id=? AND status='processing' AND lease_until_ms>?
      AND EXISTS (SELECT 1 FROM members WHERE id=? AND status='active')
      ${operation === 'dialogue' ? `AND EXISTS (SELECT 1 FROM documents WHERE owner_id=? AND kind='run'
        AND id=? AND revision=? AND deleted=0)` : ''}`,
    finalStatus, resultText, resultJson, tokenUsage.inputTokens, tokenUsage.outputTokens,
    memberId, body.requestId, now(), memberId,
    ...(operation === 'dialogue' ? [memberId, body.runDocumentId, body.documentRevision] : [])).run();
    if (operation === 'dialogue') {
      await statement(db, `UPDATE ai_requests SET status='failed',result_text=NULL,result_json=?,lease_until_ms=0
        WHERE member_id=? AND request_id=? AND status='processing'
        AND EXISTS (SELECT 1 FROM members WHERE id=? AND status='active')
        AND NOT EXISTS (SELECT 1 FROM documents WHERE owner_id=? AND kind='run' AND id=? AND revision=? AND deleted=0)`,
      failureJson({ code: 'AI_DOCUMENT_STALE' }), memberId, body.requestId, memberId, memberId, body.runDocumentId, body.documentRevision).run();
    }
    await statement(db, "UPDATE ai_requests SET status='cancelled',result_text=NULL,result_json=NULL,lease_until_ms=0 WHERE member_id=? AND request_id=? AND status='processing' AND NOT EXISTS (SELECT 1 FROM members WHERE id=? AND status='active')",
      memberId, body.requestId, memberId).run();
    await statement(db, "UPDATE ai_requests SET lease_until_ms=0 WHERE member_id=? AND request_id=? AND status='cancelled'", memberId, body.requestId).run();
    const row = await requestRowAfterReservation(db, memberId, body.requestId);
    if (!row) throw new HttpError(503, 'AI_UNAVAILABLE');
    return { httpStatus: 200, value: publicRequest(row, await usageFor(db, memberId, limit)) };
  }
  const submit = (db, env, memberId, body, observation) => submitOperation(db, env, memberId, body, 'probe', observation);
  const submitDialogue = (db, env, memberId, body, observation, onProgress) => submitOperation(db, env, memberId, body, 'dialogue', observation, onProgress);
  return { status, submit, submitDialogue, cancel, getRequest };
}

export const aiService = createAiService();
