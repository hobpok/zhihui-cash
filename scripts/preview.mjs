// Local-only preview of the explicit static build manifest. No API or secrets.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp' };

export async function createPreviewServer(projectRoot = root) {
  const publicRoot = await realpath(resolve(projectRoot, 'dist/cloudflare'));
  const manifest = JSON.parse(await readFile(resolve(projectRoot, '项目记录/Cloudflare发布包.json'), 'utf8'));
  const allowed = new Set(manifest.files.map(row => '/' + row.path));
  return createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); };
    try {
      const port = res.socket.localPort;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return send(403, 'Local preview only');
      if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Read-only preview');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === '/') { res.writeHead(302, { Location: '/app/' }); res.end(); return; }
      const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
      // Plain 404 on /api/me enables the existing anonymous browser-only mode.
      if (!allowed.has(path)) return send(404, 'Not found');
      const target = await realpath(resolve(publicRoot, '.' + path));
      const local = relative(publicRoot, target);
      if (local.startsWith('..') || isAbsolute(local)) return send(404, 'Not found');
      const content = await readFile(target);
      res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { send(500, 'Preview error; rebuild the static package'); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PREVIEW_PORT || 8769);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PREVIEW_PORT must be 1024–65535');
  const server = await createPreviewServer();
  server.on('error', error => { console.error(`Preview failed: ${error.code || 'unknown error'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Local demo: http://127.0.0.1:${port}/app/ (no cloud storage or AI)`));
  const stop = () => server.close();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
