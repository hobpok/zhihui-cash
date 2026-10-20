import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './api.js';
import { hashPassword, hashPepperedPassword, SESSION_COOKIE } from './password-auth.js';
import { seed, sqliteD1 } from './test-support/sqlite-d1.js';

const origin = 'https://workspace.local.test';
test('production peppered generated passwords fail closed without the separate secret and reject legacy downgrade', async () => {
  const ctx = await setup();
  const password = 'a'.repeat(32);
  const pepper = 'b'.repeat(43);
  const verifier = await hashPepperedPassword(password, pepper);
  try {
    ctx.sqlite.prepare('UPDATE auth_credentials SET salt=?,password_hash=?,iterations=? WHERE member_id=?')
      .run(verifier.salt, verifier.passwordHash, verifier.iterations, 'u1');
    ctx.env.AUTH_REQUIRE_PEPPER = 'true';
    for (const username of ['user1', 'missing']) {
      assert.equal((await call(ctx, '/api/auth/login', 'POST', { username, password })).status, 503);
    }
    ctx.env.AUTH_PASSWORD_PEPPER = pepper;
    assert.equal((await call(ctx, '/api/auth/login', 'POST', { username: 'user1', password })).status, 200);
    assert.equal((await call(ctx, '/api/auth/login', 'POST', { username: 'user1', password: 'wrong' })).status, 401);
    assert.equal((await call(ctx, '/api/auth/login', 'POST', { username: 'missing', password })).status, 401);
    assert.equal((await call(ctx, '/api/auth/login', 'POST', { username: 'user2', password: 'example-pass-123' })).status, 503);
    ctx.env.AUTH_PASSWORD_PEPPER = 'c'.repeat(43);
    assert.equal((await call(ctx, '/api/auth/login', 'POST', { username: 'user1', password })).status, 401);
  } finally { ctx.sqlite.close(); }
});
async function setup() {
  const { sqlite, db } = sqliteD1();
  const verifier = await hashPassword('example-pass-123');
  for (let i = 1; i <= 5; i++) {
    seed(sqlite, `u${i}`, `old${i}@example.test`, 'active', i === 1 ? 'admin' : 'member');
    sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
      .run(`u${i}`, `user${i}`, verifier.salt, verifier.passwordHash, verifier.iterations);
  }
  return { sqlite, env: { APP_ORIGIN: origin, DB: db }, handle: createApi() };
}
async function call(ctx, path, method = 'GET', body, cookie, user, extra = {}) {
  const headers = { ...extra };
  if (method !== 'GET') headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (user) headers['X-Workspace-User'] = user;
  const response = await ctx.handle(new Request(`${origin}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), ctx.env);
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
}

test('five fixed usernames log in without email; sessions isolate documents and logout revokes', async () => {
  const ctx = await setup();
  try {
    assert.equal((await call(ctx, '/api/me')).status, 401);
    const cookies = [];
    for (let i = 1; i <= 5; i++) {
      const login = await call(ctx, '/api/auth/login', 'POST', { username: `USER${i}`, password: 'example-pass-123' });
      assert.equal(login.status, 200);
      assert.deepEqual(login.body.user, { id: `u${i}`, username: `user${i}`, role: i === 1 ? 'admin' : 'member' });
      assert.match(login.cookie, /HttpOnly; Secure; SameSite=Strict/);
      cookies.push(login.cookie.split(';')[0]);
      const me = await call(ctx, '/api/me', 'GET', undefined, cookies[i - 1]);
      assert.equal(me.body.user.id, `u${i}`);
      const save = await call(ctx, '/api/documents/settings/profile', 'PUT', {
        expectedRevision: 0, mutationId: 'save-profile-01', value: { displayName: `Person ${i}` },
      }, cookies[i - 1], `u${i}`);
      assert.equal(save.status, 200);
    }
    const read = await call(ctx, '/api/documents/settings/profile', 'GET', undefined, cookies[1], 'u2');
    assert.equal(read.body.document.value.displayName, 'Person 2');
    assert.equal((await call(ctx, '/api/documents/settings/profile', 'GET', undefined, cookies[0], 'u2')).status, 409);
    const out = await call(ctx, '/api/auth/logout', 'POST', undefined, cookies[0], 'u1');
    assert.equal(out.status, 200);
    assert.match(out.cookie, new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`));
    assert.equal((await call(ctx, '/api/me', 'GET', undefined, cookies[0])).status, 401);
    assert.equal((await call(ctx, '/api/me', 'GET', undefined, cookies[1])).status, 200);
  } finally { ctx.sqlite.close(); }
});

test('wrong password is generic and rate limited; disabled member and forged identity fail', async () => {
  const ctx = await setup();
  try {
    for (let n = 0; n < 5; n++) {
      const fail = await call(ctx, '/api/auth/login', 'POST', { username: 'user1', password: 'wrong-password' });
      assert.deepEqual({ status: fail.status, body: fail.body }, { status: 401, body: { error: 'INVALID_CREDENTIALS' } });
    }
    assert.equal((await call(ctx, '/api/auth/login', 'POST', { username: 'user1', password: 'example-pass-123' })).status, 429);
    ctx.sqlite.prepare('DELETE FROM auth_failures').run();
    const login = await call(ctx, '/api/auth/login', 'POST', { username: 'user1', password: 'example-pass-123' });
    ctx.sqlite.prepare("UPDATE members SET status='disabled' WHERE id='u1'").run();
    assert.equal((await call(ctx, '/api/me', 'GET', undefined, login.cookie.split(';')[0])).status, 401);
    assert.equal((await call(ctx, '/api/me', 'GET', undefined, undefined, undefined, { 'X-User-Id': 'u2' })).status, 401);
    assert.equal((await call(ctx, '/api/me', 'GET', undefined, undefined, undefined,
      { 'Cf-Access-Jwt-Assertion': 'forged.old.token', 'Cf-Access-Authenticated-User-Email': 'old2@example.test' })).status, 401);
  } finally { ctx.sqlite.close(); }
});

test('expired sessions and password reset revoke old cookies without changing member documents', async () => {
  const ctx = await setup();
  try {
    const first = await call(ctx, '/api/auth/login', 'POST', { username: 'user2', password: 'example-pass-123' });
    const firstCookie = first.cookie.split(';')[0];
    assert.equal((await call(ctx, '/api/documents/settings/profile', 'PUT', {
      expectedRevision: 0, mutationId: 'before-reset-01', value: { displayName: 'unchanged' },
    }, firstCookie, 'u2')).status, 200);
    ctx.sqlite.prepare("UPDATE auth_sessions SET expires_at_ms=0 WHERE member_id='u2'").run();
    assert.equal((await call(ctx, '/api/me', 'GET', undefined, firstCookie)).status, 401);
    const second = await call(ctx, '/api/auth/login', 'POST', { username: 'user2', password: 'example-pass-123' });
    const secondCookie = second.cookie.split(';')[0];
    const newVerifier = await hashPassword('replacement-pass-123');
    ctx.sqlite.prepare('UPDATE auth_credentials SET salt=?,password_hash=?,iterations=? WHERE member_id=?')
      .run(newVerifier.salt, newVerifier.passwordHash, newVerifier.iterations, 'u2');
    ctx.sqlite.prepare("DELETE FROM auth_sessions WHERE member_id='u2'").run();
    assert.equal((await call(ctx, '/api/me', 'GET', undefined, secondCookie)).status, 401);
    assert.equal((await call(ctx, '/api/auth/login', 'POST', { username: 'user2', password: 'example-pass-123' })).status, 401);
    const restored = await call(ctx, '/api/auth/login', 'POST', { username: 'user2', password: 'replacement-pass-123' });
    assert.equal(restored.status, 200);
    assert.equal((await call(ctx, '/api/documents/settings/profile', 'GET', undefined,
      restored.cookie.split(';')[0], 'u2')).body.document.value.displayName, 'unchanged');
  } finally { ctx.sqlite.close(); }
});

test('login requires same origin JSON and a configured HTTPS site', async () => {
  const ctx = await setup();
  try {
    const login = await call(ctx, '/api/auth/login', 'POST', { username: 'user1', password: 'example-pass-123' }, undefined, undefined,
      { Origin: 'https://evil.test' });
    // Helper writes the expected Origin for normal requests; test direct forged Origin.
    const forged = await ctx.handle(new Request(`${origin}/api/auth/login`, {
      method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'example-pass-123' }),
    }), ctx.env);
    assert.equal(login.status, 200);
    assert.equal(forged.status, 403);
    assert.equal((await ctx.handle(new Request(`${origin}/api/me`), { DB: ctx.env.DB })).status, 503);
  } finally { ctx.sqlite.close(); }
});
