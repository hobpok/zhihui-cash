import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createAccessVerifier } from './auth.js';

export const testEnv = {
  APP_ORIGIN: 'https://zhihui-cash.pages.dev',
  ACCESS_TEAM_DOMAIN: 'https://workspace-test.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64),
};
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256' };
let calls = 0;
const verify = createAccessVerifier(url => {
  calls++; assert.equal(url.href, `${testEnv.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  return createLocalJWKSet({ keys: [jwk] });
});
async function token(overrides = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: testEnv.ACCESS_TEAM_DOMAIN, aud: [testEnv.ACCESS_AUD],
    sub: 'person-1', email: 'First@Example.test', type: 'app', iat: now - 10, exp: now + 60, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).sign(key);
}
const request = jwt => new Request(`${testEnv.APP_ORIGIN}/api/me`, { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });
const rejects = (fn, code) => assert.rejects(fn, error => error.code === code);

test('signed human Access session returns only verified identity; resolver cached', async () => {
  assert.deepEqual(await verify(request(await token()), testEnv), { issuer: testEnv.ACCESS_TEAM_DOMAIN, subject: 'person-1', email: 'first@example.test' });
  await verify(request(await token()), testEnv); assert.equal(calls, 1);
});
test('missing configuration fails closed even with forged identity/dev headers', async () => {
  const req = new Request(`${testEnv.APP_ORIGIN}/api/me`, { headers: { 'X-User-Id': 'admin', 'Cf-Access-Authenticated-User-Email': 'admin@example.test' } });
  await rejects(() => verify(req, {}), 'AUTH_NOT_CONFIGURED');
  await rejects(() => verify(req, testEnv), 'AUTH_REQUIRED');
  await rejects(() => verify(req, { ...testEnv, ACCESS_TEAM_DOMAIN: 'https://evil.test' }), 'AUTH_NOT_CONFIGURED');
  await rejects(() => verify(req, { ...testEnv, APP_ORIGIN: 'http://localhost:8768' }), 'AUTH_NOT_CONFIGURED');
});
test('rejects bad signature, issuer, audience, expiry, future nbf and future iat', async () => {
  const wrong = await generateKeyPair('RS256');
  await rejects(() => verify(request('not.a.token'), testEnv), 'INVALID_SESSION');
  await rejects(async () => verify(request(await token({}, wrong.privateKey)), testEnv), 'INVALID_SESSION');
  for (const claims of [{ iss: 'https://other.cloudflareaccess.com' }, { aud: ['b'.repeat(64)] },
    { exp: 1 }, { nbf: Math.floor(Date.now()/1000) + 100 }, { iat: Math.floor(Date.now()/1000) + 1000 }]) {
    await rejects(async () => verify(request(await token(claims)), testEnv), 'INVALID_SESSION');
  }
});
test('rejects service tokens, missing required human claims and invalid temporal interval', async () => {
  for (const claims of [{ sub: '' }, { type: 'org' }, { email: undefined }, { exp: undefined }, { email: 'not-an-email' }, { exp: 100, iat: 200 }]) {
    await rejects(async () => verify(request(await token(claims)), testEnv), 'INVALID_SESSION');
  }
});
test('a production token cannot be used on alternate preview host', async () => {
  const req = new Request('https://preview.zhihui-cash.pages.dev/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await token() } });
  await rejects(() => verify(req, testEnv), 'ORIGIN_NOT_ALLOWED');
});
test('JWKS outages reject instead of granting fallback identity', async () => {
  const offline = createAccessVerifier(() => async () => { throw new TypeError('offline'); });
  await rejects(async () => offline(request(await token()), testEnv), 'AUTH_UNAVAILABLE');
});
