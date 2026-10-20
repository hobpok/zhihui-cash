const MODES = new Set(['disabled', 'mock', 'real']);
const CONFIG_KEYS = new Set(['mode', 'provider', 'model', 'keyBinding', 'dailyLimit', 'timeoutMs']);
const DEFAULT_DAILY_LIMIT = 30;
const DEFAULT_TIMEOUT_MS = 10000;
const DEEPSEEK_MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

function result(state, config = null, credential = null) {
  const resolved = { state, config };
  // Deliberately non-enumerable: diagnostics or accidental JSON serialization
  // of the internal resolution cannot expose a live provider credential.
  Object.defineProperty(resolved, 'credential', { value: credential, enumerable: false });
  return resolved;
}

function invalid() { return result('config_invalid'); }

/** Resolve only the stable member ID's server-side entry. No client settings are consulted. */
export function resolveAiConfig(env, memberId) {
  const raw = env?.AI_ACCOUNT_CONFIG_JSON;
  if (raw === undefined || raw === null || raw === '') return result('unconfigured');
  if (typeof raw !== 'string' || raw.length > 16384 || !validText(memberId, 80)) return invalid();
  let accounts;
  try { accounts = JSON.parse(raw); } catch { return invalid(); }
  if (!object(accounts) || Object.keys(accounts).length > 5 ||
      Object.keys(accounts).some(id => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) return invalid();
  if (!Object.hasOwn(accounts, memberId)) return result('unconfigured');
  const entry = accounts[memberId];
  if (!object(entry) || Object.keys(entry).some(key => !CONFIG_KEYS.has(key)) || !MODES.has(entry.mode)) return invalid();
  const dailyLimit = entry.dailyLimit === undefined ? DEFAULT_DAILY_LIMIT : entry.dailyLimit;
  const timeoutMs = entry.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : entry.timeoutMs;
  if ((dailyLimit !== null && (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000)) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 90000) return invalid();
  if (entry.provider !== undefined && !validText(entry.provider, 64)) return invalid();
  if (entry.model !== undefined && !validText(entry.model, 120)) return invalid();
  if (entry.keyBinding !== undefined &&
      (typeof entry.keyBinding !== 'string' || !/^AI_KEY_[A-Z0-9_]{1,64}$/.test(entry.keyBinding))) return invalid();
  const config = {
    mode: entry.mode,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    keyBinding: entry.keyBinding ?? null,
    dailyLimit,
    timeoutMs,
  };
  if (entry.mode === 'disabled') {
    // Disabled entries must not be mistaken for a partially ready provider.
    if (entry.keyBinding !== undefined) return invalid();
    return result('disabled', config);
  }
  if (entry.mode === 'mock') {
    if (entry.provider !== 'mock' || entry.keyBinding !== undefined) return invalid();
    config.model ??= 'connectivity-v1';
    return result('mock_ready', config);
  }
  if (!entry.provider || !entry.model || !entry.keyBinding || entry.provider === 'mock') return invalid();
  if (entry.provider === 'deepseek' && !DEEPSEEK_MODELS.has(entry.model)) return invalid();
  const credential = env[entry.keyBinding];
  if (typeof credential !== 'string' || !credential.trim()) return result('credential_missing', config);
  // A bearer value must be one printable ASCII token, never a header fragment.
  if (!/^[\x21-\x7e]{1,512}$/.test(credential)) return invalid();
  if (entry.provider === 'deepseek') return result('real_ready', config, credential);
  return result('provider_unsupported', config, credential);
}

/** Safe to serialize in /api/me or /api/ai/status. Never includes binding names or secrets. */
export function publicAiStatus(resolved) {
  const { state, config } = resolved;
  return {
    state,
    mode: config?.mode ?? null,
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    dailyLimit: config?.dailyLimit === undefined ? DEFAULT_DAILY_LIMIT : config.dailyLimit,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
