// Optional, request-scoped performance counters. Only fixed labels and numbers leave this module.
const ROUTES = Object.freeze({
  login: 'auth_login', logout: 'auth_logout', me: 'me', upgrade: 'workspace_upgrade',
  backups: 'workspace_backups', backup: 'workspace_backup', aiStatus: 'ai_status',
  aiProbe: 'ai_probe', aiDialogue: 'ai_dialogue', aiRequest: 'ai_request',
  aiCancel: 'ai_cancel', usage: 'usage', documents: 'documents', other: 'other',
});
const AI_STATUSES = new Set(['processing', 'completed', 'failed', 'timed_out', 'cancelled', 'expired']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const asNonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const milliseconds = value => Math.round(Math.max(0, value) * 10) / 10;

export function routeCategory(pathname) {
  if (pathname === '/api/auth/login') return ROUTES.login;
  if (pathname === '/api/auth/logout') return ROUTES.logout;
  if (pathname === '/api/me') return ROUTES.me;
  if (pathname === '/api/workspace/upgrade') return ROUTES.upgrade;
  if (pathname === '/api/workspace/backups') return ROUTES.backups;
  if (/^\/api\/workspace\/backups\/[a-zA-Z0-9_.-]{1,80}$/.test(pathname)) return ROUTES.backup;
  if (pathname === '/api/ai/status') return ROUTES.aiStatus;
  if (pathname === '/api/ai/requests') return ROUTES.aiProbe;
  if (pathname === '/api/ai/dialogue') return ROUTES.aiDialogue;
  if (/^\/api\/ai\/requests\/[A-Za-z0-9_-]{8,80}\/cancel$/.test(pathname)) return ROUTES.aiCancel;
  if (/^\/api\/ai\/requests\/[A-Za-z0-9_-]{8,80}$/.test(pathname)) return ROUTES.aiRequest;
  if (pathname === '/api/usage') return ROUTES.usage;
  if (/^\/api\/documents(?:\/|$)/.test(pathname)) return ROUTES.documents;
  return ROUTES.other;
}

export function createRequestObservability(env, request, {
  clock = () => performance.now(),
  log = record => console.info(JSON.stringify(record)),
  traceId = () => crypto.randomUUID(),
} = {}) {
  if (env?.PERF_OBSERVABILITY !== 'true') return null;
  const readClock = () => {
    try { const value = clock(); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  };
  const start = readClock();
  const route = routeCategory(new URL(request.url).pathname);
  const method = METHODS.has(request.method) ? request.method : 'OTHER';
  // Server-generated UUIDs contain no caller-provided information.
  let trace = null;
  try {
    const generated = traceId();
    if (typeof generated === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generated)) {
      trace = generated;
    }
  } catch { /* A trace ID is optional; business work must continue. */ }
  const counters = { d1Executions: 0, d1WallMs: 0, d1RowsRead: 0, d1RowsWritten: 0,
    d1RowsReadMetaCount: 0, d1RowsWrittenMetaCount: 0, d1TimingCount: 0 };
  let aiResult = null;
  let aiGenerationMs = null;
  const rawStatements = new WeakMap();

  function addMeta(value) {
    const meta = value?.meta;
    const read = asNonnegative(meta?.rows_read);
    const written = asNonnegative(meta?.rows_written);
    if (read !== null) { counters.d1RowsRead += read; counters.d1RowsReadMetaCount++; }
    if (written !== null) { counters.d1RowsWritten += written; counters.d1RowsWrittenMetaCount++; }
  }
  async function measured(invoke, count = 1, batch = false) {
    const began = readClock();
    try {
      const result = await invoke();
      try {
        if (batch && Array.isArray(result)) result.forEach(addMeta);
        else addMeta(result);
      } catch { /* Metadata is optional and must not change a D1 result. */ }
      return result;
    } finally {
      counters.d1Executions += count;
      const ended = readClock();
      if (began !== null && ended !== null) {
        counters.d1WallMs += Math.max(0, ended - began);
        counters.d1TimingCount++;
      }
    }
  }
  function wrapStatement(statement) {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args) => wrapStatement(target.bind(...args));
        if (['first', 'all', 'run', 'raw'].includes(property)) {
          return (...args) => measured(() => target[property](...args));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    rawStatements.set(proxy, statement);
    return proxy;
  }
  function wrapDb(db) {
    if (!db) return db;
    return new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return (...args) => wrapStatement(target.prepare(...args));
        if (property === 'batch') return statements => measured(
          () => target.batch(statements.map(statement => rawStatements.get(statement) ?? statement)),
          statements.length, true);
        if (property === 'exec') return (...args) => measured(() => target.exec(...args));
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  function recordAiResult(status) {
    aiResult = AI_STATUSES.has(status) ? status : null;
  }
  function recordAiGeneration(status, elapsedMs) {
    recordAiResult(status);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) aiGenerationMs = milliseconds(elapsedMs);
  }
  function finish(response) {
    const end = readClock();
    const wallMs = start !== null && end !== null ? milliseconds(end - start) : null;
    const record = {
      event: 'api_performance', traceId: trace, route, method,
      httpStatus: response.status, wallMs,
      d1Executions: counters.d1Executions,
      d1WallMs: counters.d1TimingCount ? milliseconds(counters.d1WallMs) : null,
      d1WallTimingCount: counters.d1TimingCount,
      d1KnownRowsRead: counters.d1RowsReadMetaCount ? counters.d1RowsRead : null,
      d1KnownRowsWritten: counters.d1RowsWrittenMetaCount ? counters.d1RowsWritten : null,
      d1RowsReadMetaCount: counters.d1RowsReadMetaCount,
      d1RowsWrittenMetaCount: counters.d1RowsWrittenMetaCount,
      aiResult, aiGenerationMs,
    };
    try {
      if (trace) response.headers.set('X-Trace-Id', trace);
      const timing = [wallMs === null ? null : `app;dur=${wallMs}`,
        record.d1WallMs === null ? null : `d1;dur=${record.d1WallMs}`].filter(Boolean).join(', ');
      if (timing) response.headers.set('Server-Timing', timing);
    } catch { /* Immutable headers must not change the response. */ }
    try { log(record); } catch { /* Telemetry must never change an API outcome. */ }
    return response;
  }
  function streamHeaders(response) {
    // End-to-end duration is only logged when the stream ends; it cannot be put in headers already sent.
    try { if (trace) response.headers.set('X-Trace-Id', trace); } catch { /* Optional observation. */ }
    return response;
  }
  return { wrapDb, recordAiResult, recordAiGeneration, finish, streamHeaders };
}
