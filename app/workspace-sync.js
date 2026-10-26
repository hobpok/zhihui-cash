// Per-account synchronization. No cookies, API credentials or login bypasses
// are stored here. A document is never created just because a read failed.
const clone = x => x === undefined ? undefined : structuredClone(x);
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const equal = (a, b) => canonical(a) === canonical(b);
const safe = (kind, id) => ['settings', 'template', 'run'].includes(kind) && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const uuid = () => crypto.randomUUID();

export function createWorkspaceSync({ api, storage, onChange = () => {}, debounceMs = 700 }) {
  let userId = null, generation = 0, globalError = null;
  const documents = new Map(), timers = new Map();
  const clientId = uuid();
  const key = (kind, id) => `${kind}/${id}`;
  const prefix = (user, kind, id) => `zhihui-workspace-v1:${encodeURIComponent(user)}:${kind}:${id}:`;
  const publicEntry = e => ({ kind: e.kind, id: e.id, revision: e.revision, value: clone(e.value),
    status: e.status, error: e.error, loaded: e.loaded, recovery: clone(e.recovery), recoveries: clone(e.recoveries),
    remote: clone(e.remote), localBackupError: e.localBackupError });
  const pendingStates = new Set(['pending', 'saving', 'offline', 'conflict', 'recovery', 'error']);
  function snapshot() { return { userId, error: globalError, documents: [...documents.values()].map(publicEntry),
    pending: [...documents.values()].some(e => pendingStates.has(e.status)) }; }
  function emit() { onChange(snapshot()); }
  function live(e, epoch) { return generation === epoch && documents.get(key(e.kind, e.id)) === e; }
  function cancelTimers() { for (const t of timers.values()) clearTimeout(t); timers.clear(); }
  function disconnect() { generation++; cancelTimers(); documents.clear(); userId = null; globalError = null; emit(); }
  function connect(id) {
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('INVALID_USER');
    disconnect(); userId = id; emit();
  }
  function fault(e, error) {
    if ([401, 403].includes(error.status) || error.code === 'SESSION_CHANGED') {
      disconnect(); globalError = 'REAUTH_REQUIRED'; emit(); return;
    }
    e.error = error.code || 'NETWORK_ERROR';
    e.status = error.status === 409 && error.code === 'REVISION_CONFLICT' ? 'conflict'
      : !error.status || error.status >= 500 ? 'offline' : 'error';
    emit();
  }
  function backups(e) {
    const result = [];
    try {
      const p = prefix(userId, e.kind, e.id);
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i); if (!k?.startsWith(p)) continue;
        try {
          const b = JSON.parse(storage.getItem(k));
          if (b.userId === userId && b.kind === e.kind && b.id === e.id && Number.isSafeInteger(b.revision) && b.revision >= 0 && b.value && typeof b.value === 'object') result.push({ ...b, storageKey: k });
        } catch { /* Keep damaged backups in storage for manual recovery. */ }
      }
    } catch { e.localBackupError = true; }
    return result.sort((a, b) => b.savedAt - a.savedAt);
  }
  function persist(e) {
    try {
      storage.setItem(e.storageKey, JSON.stringify({ userId, kind: e.kind, id: e.id, revision: e.revision,
        value: e.value, mutation: e.mutation, savedAt: Date.now() }));
      e.localBackupError = false;
    } catch { e.localBackupError = true; }
  }
  function removeBackup(k, e) { try { storage.removeItem(k); } catch { e.localBackupError = true; } }
  function getEntry(kind, id) {
    if (!userId || !safe(kind, id)) throw new Error('INVALID_DOCUMENT_OR_USER');
    const e = documents.get(key(kind, id)); if (!e) throw new Error('DOCUMENT_NOT_OPEN'); return e;
  }
  async function read(e, owner) {
    try {
      const result = await api(`/api/documents/${e.kind}/${e.id}`, { method: 'GET', headers: { 'X-Workspace-User': owner } });
      const d = result.document;
      if (!d || !Number.isSafeInteger(d.revision) || d.revision < 1 || d.id !== e.id || d.kind !== e.kind) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE', status: 502 });
      return d;
    } catch (error) {
      if (error.status === 404 && error.code === 'NOT_FOUND') {
        const result = await api(`/api/documents/${e.kind}/${e.id}/history`, { method: 'GET', headers: { 'X-Workspace-User': owner } });
        const latest = result.history?.[0];
        return latest?.deleted ? { id: e.id, kind: e.kind, revision: latest.revision, value: null, deleted: true, updatedAt: latest.updatedAt } : null;
      }
      throw error;
    }
  }
  async function open(kind, id) {
    if (!userId || !safe(kind, id)) throw new Error('INVALID_DOCUMENT_OR_USER');
    const existing = documents.get(key(kind, id));
    if (existing && pendingStates.has(existing.status) && existing.loaded) return publicEntry(existing);
    const epoch = generation, owner = userId;
    const e = { kind, id, revision: 0, value: null, base: null, loaded: false, status: 'loading', error: null,
      storageKey: `${prefix(owner, kind, id)}${clientId}`, mutation: null, flight: null, recovery: null, recoveries: [], remote: null };
    documents.set(key(kind, id), e); emit();
    e.recoveries = backups(e); e.recovery = e.recoveries[0] || null;
    try {
      const d = await read(e, owner); if (!live(e, epoch)) return null;
      e.loaded = true; e.revision = d?.revision ?? 0; e.value = clone(d?.value ?? null); e.base = clone(e.value); e.remote = clone(d);
      // A previous process may have received no response although its write
      // committed. Equal current values need no retry or overwrite.
      e.recoveries = e.recoveries.filter(b => {
        if (d && equal(b.value, d.value)) { removeBackup(b.storageKey, e); return false; } return true;
      });
      e.recovery = e.recoveries[0] || null;
      e.status = e.recovery ? 'recovery' : d ? 'ready' : 'empty'; emit();
    } catch (error) { if (live(e, epoch)) fault(e, error); }
    return live(e, epoch) ? publicEntry(e) : null;
  }
  function schedule(e) {
    const k = key(e.kind, e.id); clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); void save(e); }, debounceMs));
  }
  function stage(kind, id, value) {
    const e = getEntry(kind, id);
    if (!e.loaded || e.resolving || ['conflict', 'recovery', 'loading'].includes(e.status)) throw new Error('RESOLVE_DOCUMENT_FIRST');
    if (!value || typeof value !== 'object') throw new Error('INVALID_DOCUMENT');
    if (equal(value, e.value)) return publicEntry(e);
    e.value = clone(value); e.error = null;
    if (!e.mutation && equal(e.value, e.base)) { e.status = e.revision ? 'ready' : 'empty'; removeBackup(e.storageKey, e); emit(); return publicEntry(e); }
    e.status = e.flight ? 'saving' : 'pending'; persist(e); schedule(e); emit(); return publicEntry(e);
  }
  async function save(e) {
    if (e.flight) return e.flight;
    if (!e.loaded || e.resolving || !['pending', 'offline', 'error'].includes(e.status) || e.value === null) return publicEntry(e);
    const epoch = generation, owner = userId;
    if (!e.mutation) e.mutation = { mutationId: uuid(), expectedRevision: e.revision, value: clone(e.value) };
    const command = clone(e.mutation); persist(e); e.status = 'saving'; emit();
    const flight = (async () => {
      try {
        const result = await api(`/api/documents/${e.kind}/${e.id}`, { method: 'PUT', body: command, headers: { 'X-Workspace-User': owner } });
        if (!live(e, epoch)) return null;
        const d = result.document;
        if (!d || d.revision !== command.expectedRevision + 1 || !equal(d.value, command.value)) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE', status: 502 });
        e.revision = d.revision; e.base = clone(command.value); e.mutation = null; e.error = null;
        if (d.replayed) {
          const current = await read(e, owner); if (!live(e, epoch)) return null;
          if (!current || current.revision !== d.revision) { e.remote = clone(current); e.status = 'conflict'; persist(e); emit(); return publicEntry(e); }
        }
        if (equal(e.value, command.value)) { e.status = 'ready'; removeBackup(e.storageKey, e); }
        else { e.status = 'pending'; persist(e); schedule(e); }
        emit();
      } catch (error) {
        if (!live(e, epoch)) return null;
        if (error.status === 409 && error.code === 'REVISION_CONFLICT') {
          try { const d = await read(e, owner); if (!live(e, epoch)) return null; e.remote = clone(d); }
          catch (readError) { if ([401, 403].includes(readError.status) || readError.code === 'SESSION_CHANGED') { fault(e, readError); return null; } }
        }
        if (live(e, epoch)) fault(e, error);
      } finally { if (live(e, epoch)) e.flight = null; }
      return live(e, epoch) ? publicEntry(e) : null;
    })();
    e.flight = flight; return flight;
  }
  async function flush() {
    cancelTimers();
    // Each flight may be followed by edits made while saving. Drain these in
    // order, but stop on errors/conflicts instead of retrying indefinitely.
    for (const e of [...documents.values()]) {
      if (e.flight) await e.flight;
      while (documents.get(key(e.kind, e.id)) === e && !e.resolving && ['pending', 'offline', 'error'].includes(e.status) && e.loaded && e.value !== null) {
        await save(e); if (e.status !== 'pending') break;
      }
    }
    return snapshot();
  }
  async function resolve(kind, id, choice, { apply } = {}) {
    const e = getEntry(kind, id), epoch = generation, owner = userId;
    if (!['remote', 'local', 'recovery'].includes(choice) || e.flight || e.resolving) throw new Error('INVALID_RESOLUTION');
    if (apply !== undefined && (typeof apply !== 'function' || apply.constructor?.name === 'AsyncFunction'))
      throw new Error('INVALID_RESOLUTION_CALLBACK');
    const desired = clone(choice === 'recovery' ? e.recovery?.value : e.value);
    const blockedStatus = e.status === 'recovery' ? 'recovery' : 'conflict';
    e.resolving = true;
    const timerKey = key(kind, id); clearTimeout(timers.get(timerKey)); timers.delete(timerKey);
    try {
      const latest = await read(e, owner); if (!live(e, epoch)) return null;
      if (choice !== 'remote' && !desired) throw new Error('NO_LOCAL_VALUE');
      if ((latest?.revision ?? 0) !== (e.remote?.revision ?? e.revision)) {
        // The remote side changed after the user reviewed/exported it. Show
        // the new pair and require another explicit decision, never overwrite
        // an unseen version just because a fresh CAS would now succeed.
        e.remote = clone(latest); e.status = 'conflict'; e.error = 'REMOTE_CHANGED_AGAIN';
        emit(); return publicEntry(e);
      }
      const selected = clone(choice === 'remote' ? latest?.value ?? null : desired);
      // Apply the selected model synchronously before consuming any backups or
      // accepting its cloud revision. Failure must leave the old CAS baseline
      // and recovery copies blocked, so a later save cannot revive stale facts.
      if (apply) {
        const result = apply(selected);
        if (result && typeof result.then === 'function') {
          // Observe an accidentally returned promise without allowing it to
          // complete the synchronization transaction.
          Promise.resolve(result).catch(() => {});
          throw new Error('INVALID_RESOLUTION_CALLBACK');
        }
      }
      if (!live(e, epoch)) return null;
      // Export/review is the UI's explicit choice; do not remove other tabs'
      // pending backups. Consume only the selected recovery.
      if (e.recovery) removeBackup(e.recovery.storageKey, e);
      e.recovery = null; e.recoveries = []; e.remote = clone(latest);
      e.revision = latest?.revision ?? 0; e.base = clone(latest?.value ?? null); e.value = clone(e.base);
      e.mutation = null; e.loaded = true; e.error = null; e.status = latest ? 'ready' : 'empty';
      removeBackup(e.storageKey, e);
      e.resolving = false;
      if (choice !== 'remote') stage(kind, id, desired);
      emit(); return publicEntry(e);
    } catch (error) {
      if (live(e, epoch)) {
        if ([401, 403].includes(error.status) || error.code === 'SESSION_CHANGED') fault(e, error);
        else { e.status = blockedStatus; e.error = error.code || error.message || 'RESOLUTION_APPLY_FAILED'; emit(); }
      }
      return live(e, epoch) ? publicEntry(e) : null;
    } finally { if (live(e, epoch)) e.resolving = false; }
  }
  return { connect, open, stage, flush, resolve, disconnect, snapshot };
}
