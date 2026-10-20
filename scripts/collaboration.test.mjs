import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createPreviewServer } from './preview.mjs';
import { inspectText, auditIndex } from './check_share_safety.mjs';

test('secret detection reports only location and never the matched credential', () => {
  const credential = 'ghp_' + 'A'.repeat(36);
  const result = inspectText('example.txt', 'first line\n' + credential);
  assert.equal(result[0].rule, 'github-token');
  assert.equal(result[0].line, 2);
  assert.ok(!JSON.stringify(result).includes(credential));
});

test('sharing audit rejects files force-added against the ignore policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhihui-share-test-'));
  try {
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']);
    await writeFile(join(root, '.gitignore'), '.env\n');
    await writeFile(join(root, '.env'), 'SYNTHETIC_FIXTURE=true\n');
    git(['add', '.gitignore']);
    git(['add', '-f', '.env']);
    assert.deepEqual(auditIndex(root).findings, [{ path: '.env', rule: 'excluded-by-sharing-policy' }]);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('zhihui-share-test-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('preview serves only manifest files and cannot expose credentials or a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhihui-preview-test-'));
  let server;
  try {
    await mkdir(join(root, 'dist/cloudflare/app'), { recursive: true });
    await mkdir(join(root, '项目记录'));
    await mkdir(join(root, '.local'));
    await writeFile(join(root, 'dist/cloudflare/app/index.html'), '<p>demo</p>');
    await writeFile(join(root, 'dist/cloudflare/_worker.js'), 'server-only fixture');
    await writeFile(join(root, '.local/private.txt'), 'private fixture');
    await writeFile(join(root, '项目记录/Cloudflare发布包.json'), JSON.stringify({ files: [{ path: 'app/index.html' }] }));
    server = await createPreviewServer(root);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    assert.equal(await (await fetch(base + '/app/')).text(), '<p>demo</p>');
    for (const path of ['/.local/private.txt', '/_worker.js', '/package.json', '/api/me', '/%2e%2e/.local/private.txt']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, path);
      assert.ok(!response.headers.get('content-type').includes('application/json'));
    }
    assert.equal((await fetch(base + '/app/', { method: 'POST' })).status, 405);
    assert.equal(await (await fetch(base + '/app/', { method: 'HEAD' })).text(), '');
    const status = await new Promise((done, reject) => {
      const req = request(base + '/app/', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); done(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
  } finally {
    if (server) await new Promise(done => server.close(done));
    // Only remove the exact temporary directory created above.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('zhihui-preview-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
