/**
 * Zero-dependency static server for local development.
 *   node serve.mjs [port]
 *
 * ES modules need an http origin (file:// is blocked by CORS), so the site is
 * served rather than opened directly. Nothing is proxied or uploaded.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2]) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * Apply the catch-all headers from vercel.json (CSP and friends) so the site is
 * developed and tested under the same policy it is deployed with; a policy that
 * only exists in production is a policy that breaks in production.
 */
let policyHeaders = {};
try {
  const config = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
  const rule = (config.headers || []).find((h) => h.source === '/(.*)');
  if (rule) policyHeaders = Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));
} catch {
  /* no vercel.json: serve without a policy */
}

/**
 * Testing against a local stand-in for Supabase (tools/mock-supabase.mjs)
 * needs its origin allowed. IFLOW_EXTRA_CONNECT="http://localhost:54321" adds it
 * to connect-src for this dev server only; the deployed policy is untouched.
 */
if (process.env.IFLOW_EXTRA_CONNECT && policyHeaders['content-security-policy']) {
  policyHeaders['content-security-policy'] = policyHeaders['content-security-policy']
    .replace(/connect-src ([^;]*)/, (_, sources) => `connect-src ${sources} ${process.env.IFLOW_EXTRA_CONNECT}`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Keep the served tree inside ROOT.
    const target = join(ROOT, normalize(pathname).replace(/^([/\\])+/, ''));
    if (!target.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && target !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    res.writeHead(200, {
      ...policyHeaders,
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(code === 404 ? 'Not found' : `Error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`iFlow Docs running at http://localhost:${PORT}/`);
  console.log('Press Ctrl+C to stop.');
});
