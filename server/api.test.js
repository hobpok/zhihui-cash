import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApi } from './api.js';
import { createAccessVerifier } from './auth.js';
import { sqliteD1, seed } from './test-support/sqlite-d1.js';
import { createModel } from '../app/model.js';
import { createDefaultInitialTemplate } from '../app/default-scenario.js';
import { createOriginalInitialTemplate } from '../app/original-scenario.js';
import { RESET_RELEASE } from '../app/release-version.js';

const config = { APP_ORIGIN: 'https://zhihui-cash.pages.dev',
  ACCESS_TEAM_DOMAIN: 'https://workspace-test.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64) };
const keys = await generateKeyPair('RS256');
const resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'local-qa', alg: 'RS256' }] });
const handle = createApi({ authenticate: createAccessVerifier(() => resolver) });
async function setup() {
  const { sqlite, db } = sqliteD1();
  const tokens = [];
  for (let i = 1; i <= 5; i++) {
    seed(sqlite, `u${i}`, `person${i}@example.test`, 'active', i === 1 ? 'admin' : 'member');
    tokens.push(await sign(`person-${i}`, `person${i}@example.test`));
  }
  return { sqlite, env: { ...config, DB: db }, tokens };
}
function sign(subject, email) {
  return new SignJWT({ type: 'app', email }).setProtectedHeader({ alg: 'RS256', kid: 'local-qa' })
    .setIssuer(config.ACCESS_TEAM_DOMAIN).setAudience(config.ACCESS_AUD).setSubject(subject)
    .setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
}
async function call(ctx, user, path, method = 'GET', body, extra = {}) {
  const headers = { 'Cf-Access-Jwt-Assertion': ctx.tokens[user - 1], 'X-Workspace-User': `u${user}`,
    'X-App-Release': RESET_RELEASE, ...extra };
  if (method !== 'GET') { headers.Origin = config.APP_ORIGIN; headers['Content-Type'] = 'application/json'; }
  const res = await handle(new Request(`${config.APP_ORIGIN}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), ctx.env);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  return { status: res.status, body: await res.json() };
}
const mutation = (id, value, expectedRevision = 0) => ({ mutationId: id, expectedRevision, value });

test('five signed users concurrently save/read the same document id without crossing owners', async () => {
  const ctx = await setup();
  try {
    const saved = await Promise.all(ctx.tokens.map((_, i) => call(ctx, i + 1, '/api/documents/settings/profile', 'PUT',
      mutation('first-save-01', { displayName: `用户${i + 1}`, ai: { provider: null, model: null } }))));
    assert.ok(saved.every(r => r.status === 200));
    for (let user = 1; user <= 5; user++) {
      const me = await call(ctx, user, '/api/me'); assert.equal(me.body.user.id, `u${user}`);
      assert.equal(me.body.features.aiAvailable, false);
      const read = await call(ctx, user, '/api/documents/settings/profile');
      assert.equal(read.body.document.value.displayName, `用户${user}`);
      const listed = await call(ctx, user, '/api/documents/settings');
      assert.equal(listed.body.documents.length, 1); assert.equal(listed.body.documents[0].value, undefined);
    }
    const separate = createApi({ authenticate: createAccessVerifier(() => resolver) });
    const recovered = await separate(new Request(`${config.APP_ORIGIN}/api/documents/settings/profile`, {
      headers: { 'Cf-Access-Jwt-Assertion': ctx.tokens[0], 'X-Workspace-User': 'u1' },
    }), ctx.env);
    assert.equal((await recovered.json()).document.value.displayName, '用户1');
  } finally { ctx.sqlite.close(); }
});

test('no identity headers/query/body can read or change another user, including admin', async () => {
  const ctx = await setup();
  try {
    await call(ctx, 2, '/api/documents/template/private2', 'PUT', mutation('template-save2', createDefaultInitialTemplate()));
    assert.equal((await call(ctx, 1, '/api/documents/template/private2', 'GET', undefined, { 'X-User-Id': 'u2' })).status, 404);
    assert.equal((await call(ctx, 1, '/api/documents/template/private2?userId=u2')).status, 400);
    assert.equal((await call(ctx, 1, '/api/documents/settings/profile', 'PUT', { ...mutation('forged-user1', {}), userId: 'u2' })).status, 400);
    await call(ctx, 1, '/api/documents/template/private2', 'DELETE', { expectedRevision: 0, mutationId: 'delete-own-01' });
    assert.equal((await call(ctx, 2, '/api/documents/template/private2')).status, 200);
    ctx.sqlite.prepare("UPDATE members SET status='disabled' WHERE id='u2'").run();
    assert.equal((await call(ctx, 2, '/api/me')).status, 403);
    assert.equal((await call(ctx, 2, '/api/documents/template/private2')).status, 403);
    assert.equal((await call(ctx, 2, '/api/documents/settings/profile', 'PUT', mutation('disabled-new1', {}))).status, 403);
  } finally { ctx.sqlite.close(); }
});

test('binding refuses uninvited or changed subject/email; forged header never authenticates', async () => {
  const ctx = await setup();
  try {
    assert.equal((await call(ctx, 1, '/api/me')).status, 200);
    for (const [sub, email, expected] of [['stranger', 'stranger@example.test', 403],
      ['changed-sub', 'person1@example.test', 403], ['person-1', 'changed@example.test', 403]]) {
      const token = await sign(sub, email);
      assert.equal((await call(ctx, 1, '/api/me', 'GET', undefined, { 'Cf-Access-Jwt-Assertion': token })).status, expected);
    }
    const res = await handle(new Request(`${config.APP_ORIGIN}/api/me`, { headers: { 'X-User-Id': 'u1', 'Cf-Access-Authenticated-User-Email': 'person1@example.test' } }), ctx.env);
    assert.equal(res.status, 401);
    assert.equal((await handle(new Request(`${config.APP_ORIGIN}/api/me`), {})).status, 503);
  } finally { ctx.sqlite.close(); }
});

test('HTTP CAS and idempotency preserve the newer state and deletion tombstone', async () => {
  const ctx = await setup();
  try {
    const url = '/api/documents/settings/profile';
    const first = mutation('revision-first', { displayName: 'first' });
    assert.equal((await call(ctx, 1, url, 'PUT', first)).status, 200);
    assert.equal((await call(ctx, 1, url, 'PUT', first)).body.document.replayed, true);
    assert.equal((await call(ctx, 1, url, 'PUT', mutation('revision-next1', { displayName: 'next' }, 1))).status, 200);
    assert.equal((await call(ctx, 1, url, 'PUT', first)).body.document.revision, 1);
    assert.equal((await call(ctx, 1, url)).body.document.revision, 2);
    assert.equal((await call(ctx, 1, url, 'PUT', mutation('revision-stale', {}, 1))).status, 409);
    assert.equal((await call(ctx, 1, url, 'PUT', mutation('revision-first', { displayName: 'tampered' }))).status, 409);
    assert.equal((await call(ctx, 1, url, 'DELETE', { expectedRevision: 2, mutationId: 'delete-new-01' })).status, 200);
    assert.equal((await call(ctx, 1, url, 'PUT', mutation('stale-create1', {}))).status, 409);
    assert.equal((await call(ctx, 1, url)).status, 404);
  } finally { ctx.sqlite.close(); }
});

test('run snapshots preserve exact simulation facts and reject unsupported archives', async () => {
  const ctx = await setup();
  try {
    const saved = JSON.parse(createModel().serialize());
    assert.equal((await call(ctx, 3, '/api/documents/run/current', 'PUT', mutation('run-save-001', saved))).status, 200);
    assert.deepEqual((await call(ctx, 3, '/api/documents/run/current')).body.document.value, saved);
    assert.equal((await call(ctx, 3, '/api/documents/run/invalid', 'PUT', mutation('run-bad-0001', { uiVersion: 'old' }))).status, 400);
    assert.equal((await call(ctx, 3, '/api/dispatch', 'PUT', {})).status, 404);
  } finally { ctx.sqlite.close(); }
});

test('release upgrade archives the old run, resets demo data once, and preserves settings', async () => {
  const ctx = await setup();
  try {
    const path = '/api/workspace/upgrade';
    const oldRun = JSON.parse(createModel().serialize());
    const oldTemplate = createDefaultInitialTemplate();
    oldTemplate.draftPlans[0].targetYuan = 500000000;
    const settings = { displayName: '自定义经理', preferences: { sortMode: 'liquidity_last' } };
    assert.equal((await call(ctx, 1, '/api/documents/settings/profile', 'PUT', mutation('upgrade-settings', settings))).status, 200);
    assert.equal((await call(ctx, 1, '/api/documents/template/default', 'PUT', mutation('upgrade-template', oldTemplate))).status, 200);
    assert.equal((await call(ctx, 1, '/api/documents/run/current', 'PUT', mutation('upgrade-old-run', oldRun))).status, 200);
    const body = { expectedRunRevision: 1, expectedTemplateRevision: 1 };
    const [first, second] = await Promise.all([
      call(ctx, 1, path, 'POST', body), call(ctx, 1, path, 'POST', body),
    ]);
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.deepEqual([first.body.upgraded, second.body.upgraded].sort(), [false, true]);
    assert.equal(first.body.run.revision, 2);
    assert.equal(second.body.template.revision, 2);
    assert.equal((await call(ctx, 1, '/api/documents/settings/profile')).body.document.value.displayName, '自定义经理');
    assert.equal((await call(ctx, 1, '/api/documents/template/default')).body.document.value.draftPlans[0].targetYuan,
      createDefaultInitialTemplate().draftPlans[0].targetYuan);
    const backups = await call(ctx, 1, '/api/workspace/backups');
    assert.equal(backups.status, 200);
    assert.deepEqual(backups.body.backups.map(row => [row.release, row.runRevision]), [[RESET_RELEASE, 1]]);
    assert.deepEqual((await call(ctx, 1, `/api/workspace/backups/${RESET_RELEASE}`)).body.backup.document.value, oldRun);
    assert.equal((await call(ctx, 2, `/api/workspace/backups/${RESET_RELEASE}`)).status, 404);
    assert.deepEqual((await call(ctx, 1, '/api/documents/run/current/history/1')).body.document.value, oldRun);
    assert.equal((await call(ctx, 1, path, 'POST', body)).body.upgraded, false);
    assert.equal((await call(ctx, 1, '/api/documents/run/current', 'PUT',
      mutation('old-client-save', oldRun, 2), { 'X-App-Release': '6-0.18.2' })).body.error, 'RELEASE_REQUIRED');
  } finally { ctx.sqlite.close(); }
});

test('a previously upgraded account initializes the new sample once and preserves a later original-sample choice', async () => {
  const ctx = await setup();
  try {
    const original = createOriginalInitialTemplate({ businessDate: '2026-10-19' });
    const initialModel = createModel(); initialModel.startFromTemplate(original);
    const beforeOldRelease = JSON.parse(initialModel.serialize());
    await call(ctx, 1, '/api/documents/template/default', 'PUT', mutation('previous-template', original));
    await call(ctx, 1, '/api/documents/run/current', 'PUT', mutation('previous-run', beforeOldRelease));
    // Seed the committed previous-release transaction, including its retained
    // backup and both revision increments, rather than merely faking a marker.
    const previousTemplate = structuredClone(original);
    previousTemplate.label = '6-0.27.1账号原有运行';
    const previousModel = createModel(); previousModel.startFromTemplate(previousTemplate);
    const previousRun = JSON.parse(previousModel.serialize());
    ctx.sqlite.prepare(`INSERT INTO release_upgrades
      (owner_id, release, expected_run_revision, expected_template_revision,
       default_run_json, default_template_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('u1', '6-0.27.1', 1, 1, JSON.stringify(previousRun), JSON.stringify(previousTemplate));
    const oldBackup = (await call(ctx, 1, '/api/workspace/backups/6-0.27.1')).body.backup;
    const upgraded = await call(ctx, 1, '/api/workspace/upgrade', 'POST',
      { expectedRunRevision: 2, expectedTemplateRevision: 2 });
    assert.equal(upgraded.status, 200); assert.equal(upgraded.body.upgraded, true);
    assert.equal(upgraded.body.run.revision, 3); assert.equal(upgraded.body.template.revision, 3);
    assert.equal(upgraded.body.template.value.templateId, 'SIM-DEFAULT-COMPANY-GATES-20261019');
    assert.equal(upgraded.body.run.value.initialData.templateId, 'SIM-DEFAULT-COMPANY-GATES-20261019');
    assert.equal(upgraded.body.run.value.plans.length, 6);
    const backupPath = `/api/workspace/backups/${RESET_RELEASE}`;
    const upgradeBackup = (await call(ctx, 1, backupPath)).body.backup;
    assert.equal(upgradeBackup.document.revision, 2);
    assert.deepEqual(upgradeBackup.document.value, previousRun);

    // Explicitly switching both documents mirrors selecting the original
    // built-in template and creating a fresh run from it in the browser.
    const chosen = createModel(); chosen.startFromTemplate(original);
    const chosenRun = JSON.parse(chosen.serialize());
    assert.equal((await call(ctx, 1, '/api/documents/template/default', 'PUT',
      mutation('choose-original-template', original, 3))).status, 200);
    assert.equal((await call(ctx, 1, '/api/documents/run/current', 'PUT',
      mutation('choose-original-run', chosenRun, 3))).status, 200);
    for (let reopen = 0; reopen < 2; reopen++) {
      const again = await call(ctx, 1, '/api/workspace/upgrade', 'POST',
        { expectedRunRevision: 4, expectedTemplateRevision: 4 });
      assert.equal(again.status, 200); assert.equal(again.body.upgraded, false);
      assert.equal(again.body.run.revision, 4); assert.equal(again.body.template.revision, 4);
      assert.deepEqual(again.body.run.value, chosenRun);
      assert.deepEqual(again.body.template.value, original);
    }
    assert.deepEqual((await call(ctx, 1, backupPath)).body.backup, upgradeBackup);
    assert.deepEqual((await call(ctx, 1, '/api/workspace/backups/6-0.27.1')).body.backup, oldBackup);
    assert.deepEqual(oldBackup.document.value, beforeOldRelease);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM release_upgrades WHERE owner_id = ?').get('u1').n, 2);
  } finally { ctx.sqlite.close(); }
});

test('the immediately previous client cannot reset or overwrite the newly selected run and template', async () => {
  const ctx = await setup();
  try {
    const original = createOriginalInitialTemplate();
    const model = createModel(); model.startFromTemplate(original);
    const run = JSON.parse(model.serialize());
    await call(ctx, 1, '/api/documents/template/default', 'PUT', mutation('selected-template', original));
    await call(ctx, 1, '/api/documents/run/current', 'PUT', mutation('selected-run', run));
    const oldHeaders = { 'X-App-Release': '6-0.27.1' };
    for (const [kind, value] of [['run', run], ['template', original]]) {
      const id = kind === 'run' ? 'current' : 'default';
      const rejected = await call(ctx, 1, `/api/documents/${kind}/${id}`, 'PUT',
        mutation(`previous-client-${kind}`, value, 1), oldHeaders);
      assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'RELEASE_REQUIRED');
      const retained = (await call(ctx, 1, `/api/documents/${kind}/${id}`)).body.document;
      assert.equal(retained.revision, 1); assert.deepEqual(retained.value, value);
    }
    const rejectedUpgrade = await call(ctx, 1, '/api/workspace/upgrade', 'POST',
      { expectedRunRevision: 1, expectedTemplateRevision: 1 }, oldHeaders);
    assert.equal(rejectedUpgrade.status, 409); assert.equal(rejectedUpgrade.body.error, 'RELEASE_REQUIRED');
    assert.deepEqual((await call(ctx, 1, '/api/workspace/backups')).body.backups, []);
  } finally { ctx.sqlite.close(); }
});

test('release upgrade rejects stale revisions and rolls back all writes on failure', async () => {
  const ctx = await setup();
  try {
    const oldRun = JSON.parse(createModel().serialize());
    assert.equal((await call(ctx, 1, '/api/documents/run/current', 'PUT',
      mutation('pre-upgrade-old-client', oldRun), { 'X-App-Release': '6-0.18.2' })).body.error,
    'RELEASE_REQUIRED');
    await call(ctx, 1, '/api/documents/run/current', 'PUT', mutation('atomic-old-run', oldRun));
    const path = '/api/workspace/upgrade';
    const body = { expectedRunRevision: 1, expectedTemplateRevision: 0 };
    assert.equal((await call(ctx, 1, path, 'POST', { ...body, expectedRunRevision: 0 })).body.error,
      'REVISION_CONFLICT');
    assert.equal((await call(ctx, 1, '/api/workspace/backups')).body.backups.length, 0);
    ctx.sqlite.exec(`CREATE TRIGGER reject_upgrade_run BEFORE INSERT ON document_receipts
      WHEN NEW.mutation_id LIKE 'release:%:run' BEGIN SELECT RAISE(ABORT, 'forced_failure'); END`);
    assert.equal((await call(ctx, 1, path, 'POST', body)).status, 503);
    assert.equal((await call(ctx, 1, '/api/workspace/backups')).body.backups.length, 0);
    assert.equal((await call(ctx, 1, '/api/documents/run/current')).body.document.revision, 1);
    assert.equal((await call(ctx, 1, '/api/documents/template/default')).status, 404);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM release_upgrades').get().n, 0);
    ctx.sqlite.exec('DROP TRIGGER reject_upgrade_run');
    assert.equal((await call(ctx, 1, path, 'POST', body)).body.upgraded, true);
    assert.equal((await call(ctx, 1, path, 'POST', body,
      { 'X-App-Release': '6-0.18.2' })).body.error, 'RELEASE_REQUIRED');
  } finally { ctx.sqlite.close(); }
});

test('write origin, body bytes/content, methods and credentials fail before persistence', async () => {
  const ctx = await setup();
  try {
    const url = `${config.APP_ORIGIN}/api/documents/settings/profile`;
    for (const origin of ['https://evil.test', 'null', undefined]) {
      const headers = { 'Cf-Access-Jwt-Assertion': ctx.tokens[0], 'Content-Type': 'application/json' };
      if (origin) headers.Origin = origin;
      assert.equal((await handle(new Request(url, { method: 'PUT', headers, body: '{}' }), ctx.env)).status, 403);
    }
    assert.equal((await call(ctx, 1, '/api/me', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call(ctx, 1, '/api/me', 'OPTIONS')).status, 405);
    assert.equal((await call(ctx, 1, '/api/documents/settings/profile', 'PUT', mutation('secret-write1', { ai: { apiKey: 'not-real-key' } }))).status, 400);
    assert.equal((await call(ctx, 1, '/api/documents/settings/profile', 'PUT', mutation('large-write01', { displayName: '中'.repeat(200000) }))).status, 413);
    const headers = { Origin: config.APP_ORIGIN, 'Cf-Access-Jwt-Assertion': ctx.tokens[0], 'X-Workspace-User': 'u1' };
    assert.equal((await handle(new Request(url, { method: 'PUT', headers, body: '{}' }), ctx.env)).status, 415);
    headers['Content-Type'] = 'application/json';
    assert.equal((await handle(new Request(url, { method: 'PUT', headers, body: '{' }), ctx.env)).status, 400);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0);
  } finally { ctx.sqlite.close(); }
});

test('storage failure exposes no underlying SQL or user data', async () => {
  const ctx = await setup();
  try {
    const broken = createApi({ authenticate: createAccessVerifier(() => resolver), storeFactory: () => { throw new Error('private SQL fixture'); } });
    const res = await broken(new Request(`${config.APP_ORIGIN}/api/me`, { headers: { 'Cf-Access-Jwt-Assertion': ctx.tokens[0] } }), ctx.env);
    assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: 'SERVICE_UNAVAILABLE' });
  } finally { ctx.sqlite.close(); }
});

test('document, history and usage requests pin the verified workspace user; me discovers identity', async () => {
  const ctx = await setup();
  try {
    const paths = ['/api/documents/settings', '/api/documents/settings/profile',
      '/api/documents/settings/profile/history', '/api/documents/settings/profile/history/1', '/api/usage'];
    for (const path of paths) {
      for (const userHeader of [undefined, 'u2']) {
        const headers = { 'Cf-Access-Jwt-Assertion': ctx.tokens[0] };
        if (userHeader) headers['X-Workspace-User'] = userHeader;
        const result = await handle(new Request(`${config.APP_ORIGIN}${path}`, { headers }), ctx.env);
        assert.equal(result.status, 409);
        assert.deepEqual(await result.json(), { error: 'SESSION_CHANGED' });
      }
    }
    const me = await handle(new Request(`${config.APP_ORIGIN}/api/me`, {
      headers: { 'Cf-Access-Jwt-Assertion': ctx.tokens[1], 'X-Workspace-User': 'u1' },
    }), ctx.env);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, 'u2');
    for (const method of ['PUT', 'DELETE']) {
      const result = await call(ctx, 2, '/api/documents/settings/profile', method,
        method === 'PUT' ? mutation('session-stale1', {}) : { expectedRevision: 0, mutationId: 'session-stale2' },
        { 'X-Workspace-User': 'u1' });
      assert.deepEqual(result, { status: 409, body: { error: 'SESSION_CHANGED' } });
    }
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM document_receipts').get().n, 0);
  } finally { ctx.sqlite.close(); }
});

test('HTTP history reads metadata and exact values with deletion; usage and versions stay private', async () => {
  const ctx = await setup();
  try {
    const path = '/api/documents/settings/profile';
    assert.equal((await call(ctx, 1, `${path}/history`)).status, 200);
    assert.deepEqual((await call(ctx, 1, `${path}/history`)).body.history, []);
    assert.equal((await call(ctx, 1, `${path}/history/1`)).status, 404);
    const first = await call(ctx, 1, path, 'PUT', mutation('history-first1', { displayName: 'first' }));
    for (let i = 1; i <= 11; i++) await call(ctx, 1, path, 'PUT', mutation(`history-save-${i}`, { displayName: `save ${i}` }, i));
    const deleted = await call(ctx, 1, path, 'DELETE', { expectedRevision: 12, mutationId: 'history-delete' });
    const history = (await call(ctx, 1, `${path}/history`)).body.history;
    assert.deepEqual(history.map(row => row.revision), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    assert.deepEqual(Object.keys(history[0]).sort(), ['deleted', 'revision', 'updatedAt']);
    assert.equal(history[0].deleted, true);
    assert.deepEqual((await call(ctx, 1, `${path}/history/13`)).body.document, {
      id: 'profile', kind: 'settings', revision: 13, value: null, deleted: true, updatedAt: deleted.body.document.updatedAt,
    });
    assert.deepEqual((await call(ctx, 1, `${path}/history/12`)).body.document.value, { displayName: 'save 11' });
    assert.equal((await call(ctx, 1, `${path}/history/1`)).status, 404);
    assert.equal((await call(ctx, 1, path)).status, 404);
    const replay = await call(ctx, 1, path, 'PUT', mutation('history-first1', { displayName: 'first' }));
    assert.deepEqual(replay.body.document, { ...first.body.document, replayed: true });
    assert.deepEqual((await call(ctx, 2, `${path}/history`)).body.history, []);
    assert.equal((await call(ctx, 2, `${path}/history/12`)).status, 404);
    const usage = (await call(ctx, 1, '/api/usage')).body;
    assert.equal(usage.usage.documents, 1);
    assert.equal(usage.usage.receipts, 13);
    assert.equal(usage.usage.historyVersions, 10);
    assert.equal(usage.limits.historyBytes, 16 * 1024 * 1024);
    assert.equal((await call(ctx, 2, '/api/usage')).body.usage.historyVersions, 0);
    assert.equal((await call(ctx, 1, `${path}/history`, 'PUT', mutation('history-noedit', {}))).status, 405);
    assert.equal((await call(ctx, 1, '/api/usage', 'DELETE', { expectedRevision: 0, mutationId: 'usage-noedit' })).status, 405);
    assert.equal((await call(ctx, 1, `${path}/history/9007199254740992`)).status, 400);
    ctx.sqlite.prepare("UPDATE members SET status='disabled' WHERE id='u1'").run();
    assert.equal((await call(ctx, 1, `${path}/history`)).status, 403);
    assert.equal((await call(ctx, 1, `${path}/history/12`)).status, 403);
    assert.equal((await call(ctx, 1, '/api/usage')).status, 403);
  } finally { ctx.sqlite.close(); }
});
