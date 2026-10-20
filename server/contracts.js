import { HttpError } from './errors.js';
import { validateSaved, UI_VERSION } from '../app/model.js';
import { normalizeInitialTemplate } from '../app/initial-data.js';

export const MAX_BODY_BYTES = 512 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new HttpError(400, 'INVALID_DOCUMENT'); };
function exact(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function text(value, limit) { if (typeof value !== 'string' || value.length > limit) fail(); }

// Prevent explicit credentials being smuggled into ordinary documents. This is
// a field guard, not a promise to detect secrets pasted into arbitrary prose.
export function rejectCredentialFields(value, depth = 0) {
  if (depth > 64) fail();
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(api[_-]?(key|token)|authorization|password|secret|client[_-]?secret|bearer[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key)$/i.test(key)) fail();
    rejectCredentialFields(item, depth + 1);
  }
}

export function validateDocument(kind, id, value) {
  if (!['settings', 'template', 'run'].includes(kind) || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) fail();
  if (!object(value)) fail();
  rejectCredentialFields(value);
  if (kind === 'settings') {
    if (id !== 'profile') fail();
    exact(value, ['displayName', 'ai', 'preferences']);
    if (value.displayName !== undefined) text(value.displayName, 80);
    if (value.ai !== undefined) {
      exact(value.ai, ['provider', 'model']);
      for (const key of ['provider', 'model']) if (value.ai[key] !== undefined && value.ai[key] !== null) text(value.ai[key], 120);
    }
    if (value.preferences !== undefined) {
      exact(value.preferences, ['notes', 'sortMode']);
      if (value.preferences.notes !== undefined) text(value.preferences.notes, 4000);
      if (value.preferences.sortMode !== undefined && !['auto', 'reverse_repo_first', 'liquidity_last'].includes(value.preferences.sortMode)) fail();
    }
  } else if (kind === 'template') {
    try {
      const normalized = normalizeInitialTemplate(value);
      if (normalized.provenance.kind !== 'synthetic') fail();
      // Reject fields the normalizer would discard rather than persisting them.
      const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
      if (canonical(normalized) !== canonical(value)) fail();
    } catch { fail(); }
  } else {
    // Only the current envelope is accepted here; legacy migration remains a
    // deliberate client import. Validation does not grant approval/dispatch.
    if (value.uiVersion !== UI_VERSION) fail();
    try { if (!validateSaved(value).ok) fail(); } catch { fail(); }
  }
  return value;
}

export function validateMutation(body, deleting = false) {
  exact(body, deleting ? ['expectedRevision', 'mutationId'] : ['expectedRevision', 'mutationId', 'value']);
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      typeof body.mutationId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.mutationId)) fail();
  if (!deleting && !Object.hasOwn(body, 'value')) fail();
  return body;
}
