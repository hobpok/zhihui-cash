import { authenticateSession, appOrigin, loginWithPassword, revokeSession, sessionCookie } from './password-auth.js';
import { HttpError } from './errors.js';
import { createStore } from './storage.js';
import { MAX_BODY_BYTES, validateDocument, validateMutation } from './contracts.js';
import { aiService } from './ai-service.js';
import { createRequestObservability } from './observability.js';
import { RESET_RELEASE } from '../app/release-version.js';
import { dialogueStreamResponse } from './dialogue-stream-response.js';

const streamTasks = new WeakMap();

function response(status, value, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private',
    'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff', ...headers,
  }});
}
async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new HttpError(413, 'BODY_TOO_LARGE');
  if (!request.body) throw new HttpError(400, 'INVALID_JSON');
  const reader = request.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON');
  } finally { reader.releaseLock(); }
}
const storeStatuses = {
  INVALID_INPUT: 400, MEMBER_DISABLED: 403, MEMBER_NOT_FOUND: 403,
  MEMBER_NOT_INVITED: 403, MEMBER_IDENTITY_CONFLICT: 403, ACTIVE_MEMBER_LIMIT: 409,
  STORAGE_QUOTA_EXCEEDED: 409,
  REVISION_CONFLICT: 409, MUTATION_CONFLICT: 409,
  SESSION_CHANGED: 409,
  RELEASE_REQUIRED: 409,
};

// Injectable verifier/store are only for local tests; HTTP headers/env cannot
// select an alternate authentication method.
function mePayload(member) {
  return { user: { id: member.id, username: member.username ?? member.email, role: member.role },
    limits: { activeMembers: 5, documentBytes: MAX_BODY_BYTES },
    features: { cloudStorage: true, aiAvailable: false }, logoutPath: '/api/auth/logout' };
}
function recordAiResult(observation, status) {
  try { observation?.recordAiResult(status); }
  catch { /* Observation must not change the API response. */ }
}

export function createApi({ authenticate = authenticateSession, storeFactory = createStore, ai = aiService,
  observabilityFactory = createRequestObservability } = {}) {
  async function handleCore(request, env, observation) {
    try {
      const origin = appOrigin(env);
      const url = new URL(request.url);
      if (url.origin !== origin) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED');
      if (url.search) throw new HttpError(400, 'QUERY_NOT_SUPPORTED');
      const source = request.headers.get('sec-fetch-site');
      if (source === 'cross-site' || source === 'same-site') throw new HttpError(403, 'CROSS_ORIGIN_DENIED');
      if (request.method !== 'GET' && request.headers.get('origin') !== origin) throw new HttpError(403, 'CROSS_ORIGIN_DENIED');
      if (url.pathname === '/api/auth/login') {
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        const body = await readBody(request, 2048);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['username', 'password'].includes(key))) {
          throw new HttpError(400, 'INVALID_INPUT');
        }
        const { memberId, token } = await loginWithPassword(request, env, body);
        const member = await storeFactory(env.DB).getMemberById(memberId);
        if (!member) throw new HttpError(401, 'INVALID_CREDENTIALS');
        return response(200, mePayload(member), { 'Set-Cookie': sessionCookie(token) });
      }
      if (url.pathname === '/api/auth/logout') {
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        await revokeSession(request, env);
        return response(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
      }
      if (!['GET', 'PUT', 'DELETE', 'POST'].includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      const identity = await authenticate(request, env);
      if (!env.DB) throw new HttpError(503, 'STORAGE_NOT_CONFIGURED');
      const store = storeFactory(env.DB);
      const member = identity.memberId ? await store.getMemberById(identity.memberId)
        : await store.getMember(identity.issuer, identity.subject, identity.email);
      if (!member || member.status !== 'active') throw new HttpError(403, 'MEMBER_NOT_INVITED');
      if (url.pathname === '/api/me' && request.method === 'GET') {
        return response(200, mePayload(member));
      }
      if (request.headers.get('x-workspace-user') !== member.id) throw new HttpError(409, 'SESSION_CHANGED');
      if (url.pathname === '/api/workspace/upgrade') {
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        if (request.headers.get('x-app-release') !== RESET_RELEASE) throw new HttpError(409, 'RELEASE_REQUIRED');
        const body = await readBody(request, 256);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).sort().join(',') !== 'expectedRunRevision,expectedTemplateRevision' ||
            !Number.isSafeInteger(body.expectedRunRevision) || body.expectedRunRevision < 0 ||
            !Number.isSafeInteger(body.expectedTemplateRevision) || body.expectedTemplateRevision < 0) {
          throw new HttpError(400, 'INVALID_INPUT');
        }
        return response(200, await store.upgradeRelease(member.id, body));
      }
      if (url.pathname === '/api/workspace/backups') {
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        return response(200, { backups: await store.listReleaseBackups(member.id) });
      }
      const backupMatch = /^\/api\/workspace\/backups\/([a-zA-Z0-9_.-]{1,80})$/.exec(url.pathname);
      if (backupMatch) {
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        const backup = await store.readReleaseBackup(member.id, backupMatch[1]);
        if (!backup) throw new HttpError(404, 'NOT_FOUND');
        return response(200, { backup });
      }
      if (url.pathname === '/api/ai/status') {
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        return response(200, await ai.status(env.DB, env, member.id));
      }
      if (url.pathname === '/api/ai/requests') {
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        const result = await ai.submit(env.DB, env, member.id, await readBody(request, 8192), observation);
        recordAiResult(observation, result.value?.status);
        return response(result.httpStatus, result.value);
      }
      if (url.pathname === '/api/ai/dialogue') {
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        const body = await readBody(request, 32768);
        if (request.headers.get('accept')?.split(',').some(value => value.trim().split(';')[0] === 'text/event-stream')) {
          if (typeof body?.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(body.requestId))
            throw new HttpError(400, 'INVALID_INPUT');
          const stream = dialogueStreamResponse({ requestId: body?.requestId,
            run: onProgress => ai.submitDialogue(env.DB, env, member.id, body, observation, onProgress),
            onResult: status => recordAiResult(observation, status) });
          streamTasks.set(stream.response, stream.task);
          return stream.response;
        }
        const result = await ai.submitDialogue(env.DB, env, member.id, body, observation);
        recordAiResult(observation, result.value?.status);
        return response(result.httpStatus, result.value);
      }
      const aiRequest = /^\/api\/ai\/requests\/([A-Za-z0-9_-]{8,80})(\/cancel)?$/.exec(url.pathname);
      if (aiRequest) {
        if (aiRequest[2]) {
          if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
          const result = await ai.cancel(env.DB, env, member.id, aiRequest[1]);
          recordAiResult(observation, result.status);
          return response(200, result);
        }
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        const result = await ai.getRequest(env.DB, env, member.id, aiRequest[1]);
        recordAiResult(observation, result.status);
        return response(200, result);
      }
      if (request.method === 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      if (url.pathname === '/api/usage') {
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        return response(200, await store.getUsage(member.id));
      }
      const match = /^\/api\/documents\/(settings|template|run)(?:\/([a-zA-Z0-9_-]{1,80})(?:\/history(?:\/([1-9][0-9]*))?)?)?$/.exec(url.pathname);
      if (!match) throw new HttpError(404, 'NOT_FOUND');
      const [, kind, id, historyRevision] = match;
      const historyPath = id && url.pathname.includes(`${id}/history`);
      if (!id) {
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        return response(200, { documents: await store.listDocuments(member.id, kind) });
      }
      if (historyPath) {
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        if (historyRevision) {
          const document = await store.readHistory(member.id, kind, id, Number(historyRevision));
          if (!document) throw new HttpError(404, 'NOT_FOUND');
          return response(200, { document });
        }
        return response(200, await store.listHistory(member.id, kind, id));
      }
      if (request.method === 'GET') {
        const document = await store.readDocument(member.id, kind, id);
        if (!document) throw new HttpError(404, 'NOT_FOUND');
        return response(200, { document });
      }
      const deleting = request.method === 'DELETE';
      if (kind !== 'settings' && request.headers.get('x-app-release') !== RESET_RELEASE) {
        throw new HttpError(409, 'RELEASE_REQUIRED');
      }
      const mutation = validateMutation(await readBody(request), deleting);
      if (!deleting) validateDocument(kind, id, mutation.value);
      const document = await store[deleting ? 'deleteDocument' : 'putDocument'](member.id, kind, id, mutation);
      return response(200, { document });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (storeStatuses[error.code] ?? 503);
      // Never echo SQL, JWTs, emails, saved values, or underlying exceptions.
      return response(status, { error: status === 503 && !(error instanceof HttpError) ? 'SERVICE_UNAVAILABLE' : error.code });
    }
  }
  return async function handle(request, env, executionContext = null) {
    let observation = null;
    let requestEnv = env;
    try {
      const candidate = observabilityFactory(env, request);
      if (candidate) {
        const wrappedDb = env?.DB ? candidate.wrapDb(env.DB) : null;
        if (env?.DB && (!wrappedDb || typeof wrappedDb.prepare !== 'function')) throw new Error('Invalid observation DB wrapper');
        requestEnv = env?.DB ? { ...env, DB: wrappedDb } : env;
        observation = candidate;
      }
    } catch { /* Use the original environment if telemetry setup fails. */ }
    const result = await handleCore(request, requestEnv, observation);
    const streamTask = streamTasks.get(result);
    if (streamTask) {
      try { observation?.streamHeaders?.(result); } catch { /* Optional observation. */ }
      const finished = streamTask.finally(() => {
        try { observation?.finish(result); } catch { /* Optional observation. */ }
      });
      try { executionContext?.waitUntil(finished); } catch { /* Local bridges need no execution context. */ }
      return result;
    }
    if (!observation) return result;
    try { return observation.finish(result); }
    catch { return result; }
  };
}
export const handleApi = createApi();
