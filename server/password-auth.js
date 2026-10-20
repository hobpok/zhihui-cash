import { HttpError } from './errors.js';

export const SESSION_COOKIE = '__Host-zhihui_session';
export const SESSION_MS = 12 * 60 * 60 * 1000;
export const PASSWORD_ITERATIONS = 210000;
export const PEPPERED_PASSWORD_ITERATIONS = 100000;
const PEPPER_PREFIX = 'p1$';
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const encoder = new TextEncoder();

function base64url(bytes) {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid encoded bytes');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new Error('Password must have 8–128 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: base64url(salt), passwordHash: base64url(await derive(password, salt, PASSWORD_ITERATIONS)), iterations: PASSWORD_ITERATIONS };
}
async function pepperDigest(bytes, pepper) {
  if (typeof pepper !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pepper)) throw new HttpError(503, 'AUTH_NOT_CONFIGURED');
  const key = await crypto.subtle.importKey('raw', fromBase64url(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
}
// Only for the fixed CSPRNG-generated 192-bit account passwords. The pepper
// must live in a separate secret binding, never beside the database verifiers.
export async function hashPepperedPassword(password, pepper) {
  if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(password)) throw new Error('Expected generated account password');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derive(password, salt, PEPPERED_PASSWORD_ITERATIONS);
  return { salt: base64url(salt), passwordHash: PEPPER_PREFIX + base64url(await pepperDigest(derived, pepper)), iterations: PEPPERED_PASSWORD_ITERATIONS };
}
async function verifyPassword(password, credential, env) {
  const peppered = credential?.password_hash?.startsWith(PEPPER_PREFIX) || env.AUTH_REQUIRE_PEPPER === 'true';
  if (peppered && (typeof env.AUTH_PASSWORD_PEPPER !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(env.AUTH_PASSWORD_PEPPER))) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED');
  }
  if (credential && peppered && (!credential.password_hash.startsWith(PEPPER_PREFIX) || credential.iterations !== PEPPERED_PASSWORD_ITERATIONS)) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED');
  }
  // A fixed dummy verifier keeps absent usernames on the same expensive path.
  const salt = credential ? fromBase64url(credential.salt) : new Uint8Array(16);
  const expected = credential ? fromBase64url(peppered ? credential.password_hash.slice(PEPPER_PREFIX.length) : credential.password_hash) : new Uint8Array(32);
  let actual = await derive(password, salt, credential?.iterations ?? (peppered ? PEPPERED_PASSWORD_ITERATIONS : PASSWORD_ITERATIONS));
  if (peppered) actual = await pepperDigest(actual, env.AUTH_PASSWORD_PEPPER);
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < 32; i++) diff |= actual[i] ^ expected[i];
  return Boolean(credential) && diff === 0;
}
export function appOrigin(env) {
  let url;
  try { url = new URL(env.APP_ORIGIN); } catch { throw new HttpError(503, 'AUTH_NOT_CONFIGURED'); }
  if (url.protocol !== 'https:' || url.origin !== env.APP_ORIGIN || url.username || url.password) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED');
  }
  return url.origin;
}
export function sessionCookie(token, maxAge = Math.floor(SESSION_MS / 1000)) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
function cookieToken(request) {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : null;
}
export async function authenticateSession(request, env) {
  if (new URL(request.url).origin !== appOrigin(env)) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED');
  if (!env.DB) throw new HttpError(503, 'STORAGE_NOT_CONFIGURED');
  const token = cookieToken(request);
  if (!token) throw new HttpError(401, 'AUTH_REQUIRED');
  const row = await env.DB.prepare(`SELECT s.member_id FROM auth_sessions s
    JOIN members m ON m.id = s.member_id
    JOIN auth_credentials c ON c.member_id = m.id
    WHERE s.token_hash = ? AND s.expires_at_ms > ? AND m.status = 'active' LIMIT 1`)
    .bind(await sha256(token), Date.now()).first();
  if (!row) throw new HttpError(401, 'INVALID_SESSION');
  return { memberId: row.member_id };
}
async function failureKey(value) { return sha256(value); }
async function isLimited(db, key, now) {
  const row = await db.prepare('SELECT failures, window_start_ms, locked_until_ms FROM auth_failures WHERE key_hash = ?')
    .bind(key).first();
  return Boolean(row && row.failures >= MAX_FAILURES && row.window_start_ms > now - WINDOW_MS && row.locked_until_ms > now);
}
async function recordFailure(db, key, now) {
  await db.prepare(`INSERT INTO auth_failures(key_hash, failures, window_start_ms, locked_until_ms)
    VALUES(?,1,?,0) ON CONFLICT(key_hash) DO UPDATE SET
    failures = CASE WHEN window_start_ms <= ? THEN 1 ELSE failures + 1 END,
    window_start_ms = CASE WHEN window_start_ms <= ? THEN ? ELSE window_start_ms END,
    locked_until_ms = CASE WHEN window_start_ms <= ? THEN 0
      WHEN failures + 1 >= ? THEN ? ELSE 0 END`)
    .bind(key, now, now - WINDOW_MS, now - WINDOW_MS, now, now - WINDOW_MS, MAX_FAILURES, now + WINDOW_MS).run();
}
export async function loginWithPassword(request, env, { username, password }) {
  if (!env.DB) throw new HttpError(503, 'STORAGE_NOT_CONFIGURED');
  const valid = typeof username === 'string' && /^[a-z][a-z0-9._-]{2,31}$/i.test(username) &&
    typeof password === 'string' && password.length >= 1 && password.length <= 128;
  if (!valid) throw new HttpError(401, 'INVALID_CREDENTIALS');
  const normalized = username.toLowerCase();
  const now = Date.now();
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at_ms <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM auth_failures WHERE window_start_ms <= ? AND locked_until_ms <= ?')
    .bind(now - WINDOW_MS, now).run();
  const userKey = await failureKey(`username:${normalized}`);
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const ipKey = await failureKey(`ip:${ip}`);
  if (await isLimited(env.DB, userKey, now) || await isLimited(env.DB, ipKey, now)) throw new HttpError(429, 'LOGIN_RATE_LIMITED');
  const credential = await env.DB.prepare(`SELECT c.member_id, c.username, c.salt, c.password_hash, c.iterations
    FROM auth_credentials c JOIN members m ON m.id = c.member_id
    WHERE c.username = ? COLLATE NOCASE AND m.status = 'active' LIMIT 1`).bind(normalized).first();
  let accepted = false;
  try { accepted = await verifyPassword(password, credential, env); } catch (error) {
    if (error instanceof HttpError) throw error;
    // Invalid verifiers and unsupported runtime algorithms fail closed.
  }
  if (!accepted) {
    await recordFailure(env.DB, userKey, now);
    await recordFailure(env.DB, ipKey, now);
    throw new HttpError(401, 'INVALID_CREDENTIALS');
  }
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO auth_sessions(token_hash,member_id,created_at_ms,expires_at_ms) VALUES(?,?,?,?)')
    .bind(await sha256(token), credential.member_id, now, now + SESSION_MS).run();
  await env.DB.prepare('DELETE FROM auth_failures WHERE key_hash IN (?,?)').bind(userKey, ipKey).run();
  return { memberId: credential.member_id, token };
}
export async function revokeSession(request, env) {
  const token = cookieToken(request);
  if (token && env.DB) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}
