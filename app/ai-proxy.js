// Connectivity preparation only: no planning, approvals, trade state or secrets.
const copy = value => structuredClone(value);
export const AI_PROBE_TEXT = '请只回复“连接测试成功”，不要生成交易建议。';
const errors = {
  AI_TIMEOUT: '请求超时，请稍后重新测试。',
  AI_CANCELLED: '请求已取消。',
  AI_BUSY: '本账号已有请求进行中，请等待或取消后再试。',
  AI_REQUEST_ACTIVE: '本账号已有请求进行中，请等待或取消后再试。',
  AI_DAILY_LIMIT: '今日测试次数已用完，请在额度重置后再试。',
  AI_QUOTA_EXCEEDED: '今日测试次数已用完，请在额度重置后再试。',
  AI_NOT_CONFIGURED: '尚未配置可调用服务。',
  AI_UNAVAILABLE: '服务尚不可用，请检查配置状态。',
  AI_PROVIDER_UNSUPPORTED: '当前服务商尚未接入。',
  AI_REQUEST_CONFLICT: '请求标识冲突，请刷新状态后重试。',
  AI_INVALID_RESPONSE: '服务返回格式不符合约定，本次未采用。',
  AI_OUTPUT_INVALID: '服务返回格式不符合约定，本次未采用。',
  AI_REQUEST_EXPIRED: '此前请求已过期，请刷新状态后重新测试。',
  AI_UPSTREAM_ERROR: '服务暂时不可用，请稍后再试。',
  AI_FAILED: '服务未返回有效结果，请稍后再试。',
};
export function aiErrorText(error) {
  if (error?.code === 'NETWORK_TIMEOUT') return '连接等待超时，服务端可能仍在处理；请刷新状态后检查。';
  if (error?.status === 401 || error?.status === 403 || error?.code === 'SESSION_CHANGED') return '登录状态已变化，请重新登录。';
  if (errors[error?.code]) return errors[error.code];
  if (error?.status === 429) return '调用次数已达限制，请稍后再试。';
  if (error?.status === 409) return '本账号已有请求或请求状态发生变化，请刷新状态。';
  return '连接未完成，请检查网络或稍后重试。';
}

export function createAiProxy({ fetchImpl = (...args) => fetch(...args), onChange = () => {},
  onAuthError = () => {}, requestTimeoutMs = 40000, makeId = () => crypto.randomUUID() } = {}) {
  let owner = null, epoch = 0, active = null, refreshId = 0;
  let state = { config: null, phase: 'idle', result: null, error: '', cancelError: '' };
  const snapshot = () => copy({ ...state, userId: owner, requestId: active?.id ?? null,
    requestMode: active ? active.simulated ? 'mock_ready' : 'real_ready' : null });
  const emit = () => onChange(snapshot());
  const current = (userId, generation) => owner === userId && epoch === generation;
  async function request(path, { userId, generation, method = 'GET', body, signal, timeoutMs = 10000 } = {}) {
    const control = new AbortController();
    let timedOut = false;
    const abort = () => control.abort();
    const timer = setTimeout(() => { timedOut = true; control.abort(); }, timeoutMs);
    if (signal?.aborted) control.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: control.signal, headers: { 'X-Workspace-User': userId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let data;
      try { data = await response.json(); } catch { throw Object.assign(new Error('Invalid response'), { code: 'AI_INVALID_RESPONSE' }); }
      if (!response.ok) {
        const error = Object.assign(new Error('AI request failed'), { code: data?.error, status: response.status });
        if (current(userId, generation) && ([401, 403].includes(response.status) || error.code === 'SESSION_CHANGED')) onAuthError(error);
        throw error;
      }
      return data;
    } catch (error) {
      if (timedOut) throw Object.assign(new Error('Timeout'), { code: 'NETWORK_TIMEOUT' });
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function setUser(userId) {
    const old = active, oldOwner = owner, oldEpoch = epoch;
    owner = userId; epoch++; refreshId++; active = null;
    if (old) {
      old.control.abort();
      // The old owner header prevents a changed cookie from cancelling the next account's work.
      void request(`/api/ai/requests/${encodeURIComponent(old.id)}/cancel`, {
        method: 'POST', userId: oldOwner, generation: oldEpoch,
      }).catch(() => {});
    }
    state = { config: null, phase: 'idle', result: null, error: '', cancelError: '' }; emit();
  }
  async function refresh() {
    if (!owner) return;
    const userId = owner, generation = epoch, id = ++refreshId;
    try {
      const config = await request('/api/ai/status', { userId, generation });
      if (!current(userId, generation) || id !== refreshId) return;
      if (!config || typeof (config.state ?? config.status) !== 'string' || !config.limits || !config.usage) {
        throw Object.assign(new Error('Invalid status'), { code: 'AI_INVALID_RESPONSE' });
      }
      state.config = config; if (state.phase === 'idle') state.error = ''; emit();
    } catch (error) {
      if (current(userId, generation) && id === refreshId) { state.error = aiErrorText(error); emit(); }
    }
  }
  async function run() {
    if (!owner || active) return;
    const mode = state.config?.state ?? state.config?.status;
    if (!['mock_ready', 'real_ready'].includes(mode)) { state.error = '请先检查配置，服务可用后再测试。'; emit(); return; }
    const userId = owner, generation = epoch;
    const entry = { id: makeId(), control: new AbortController(), simulated: mode === 'mock_ready' }; active = entry;
    state.phase = 'running'; state.result = null; state.error = ''; state.cancelError = ''; emit();
    try {
      const result = await request('/api/ai/requests', { userId, generation, method: 'POST',
        body: { requestId: entry.id, prompt: AI_PROBE_TEXT }, signal: entry.control.signal, timeoutMs: requestTimeoutMs });
      if (!current(userId, generation) || active !== entry) return;
      if (result?.requestId !== entry.id) throw Object.assign(new Error('Invalid response'), { code: 'AI_INVALID_RESPONSE' });
      if (result?.status === 'cancelled') { state.phase = 'cancelled'; return; }
      if (['failed','timed_out','expired','processing'].includes(result?.status)) {
        const code = { failed: result.errorCode || 'AI_UPSTREAM_ERROR', timed_out: 'AI_TIMEOUT', expired: 'AI_REQUEST_EXPIRED', processing: 'AI_REQUEST_ACTIVE' }[result.status];
        throw Object.assign(new Error('Request not completed'), { code });
      }
      if (result?.status !== 'completed' || result.requestId !== entry.id || result.simulated !== entry.simulated || typeof result.text !== 'string' || result.text.length > 8000) {
        throw Object.assign(new Error('Invalid response'), { code: 'AI_INVALID_RESPONSE' });
      }
      state.phase = 'completed'; state.result = { text: result.text, simulated: entry.simulated };
    } catch (error) {
      if (!current(userId, generation) || active !== entry) return;
      state.phase = error.code === 'AI_CANCELLED' ? 'cancelled' : 'error'; state.error = state.phase === 'cancelled' ? '' : aiErrorText(error);
    } finally {
      if (current(userId, generation)) {
        if (active === entry) { active = null; emit(); }
        void refresh();
      }
    }
  }
  async function cancel() {
    const id = active?.id ?? state.config?.activeRequestId;
    if (!owner || !id || state.phase === 'cancelling') return;
    const userId = owner, generation = epoch, entry = active;
    state.phase = 'cancelling'; state.cancelError = ''; emit();
    try {
      const result = await request(`/api/ai/requests/${encodeURIComponent(id)}/cancel`, { userId, generation, method: 'POST' });
      if (!current(userId, generation)) return;
      if (active && active !== entry) return;
      if (result.requestId !== id || typeof result.status !== 'string') throw Object.assign(new Error('Invalid cancel'), { code: 'AI_INVALID_RESPONSE' });
      if (['cancelled', 'cancel_requested'].includes(result.status)) {
        // Keep the original response open until the executor acknowledges the
        // cancellation, then its final refresh releases the displayed busy slot.
        if (active === entry) active = null;
        state.phase = 'cancelled'; state.result = null; state.error = ''; emit();
      } else if (!active) { state.phase = state.result ? 'completed' : 'idle'; emit(); }
      else { state.phase = 'running'; emit(); }
    } catch (error) {
      if (current(userId, generation)) {
        state.phase = active ? 'running' : state.result ? 'completed' : 'error';
        state.cancelError = '取消尚未确认。' + aiErrorText(error); emit();
      }
    } finally { if (current(userId, generation)) void refresh(); }
  }
  return { snapshot, setUser, refresh, run, cancel };
}
