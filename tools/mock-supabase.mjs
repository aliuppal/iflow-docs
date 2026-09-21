/**
 * A local stand-in for the parts of Supabase the site uses, so sign-in and the
 * print counter can be developed and tested without a real project or a Google
 * account.
 *
 *   node tools/mock-supabase.mjs [port]        (default 54321)
 *
 * Then point the page at it — on localhost only — with, in the browser console:
 *   window.__IFLOW_CONFIG__ = { supabaseUrl: 'http://localhost:54321', supabaseAnonKey: 'anon-test-key' }
 * and start the site with IFLOW_EXTRA_CONNECT=http://localhost:54321 node serve.mjs
 *
 * What it does honestly, so the tests mean something:
 *   - real HTTP with real CORS preflight handling;
 *   - PKCE: it remembers the code_challenge sent to /authorize and verifies the
 *     code_verifier at /token (S256), so a wrong OAuth implementation fails here;
 *   - the two RPCs apply the same rules as supabase/schema.sql (1..100 per call,
 *     own row only, email from the account, existing name kept).
 * It does NOT test the SQL itself — tools/test-sql.mjs does that against Postgres.
 *
 * Control endpoints (for tests): GET /__mock/state, POST /__mock/reset,
 * POST /__mock/set  { denyNext, failNextRpc, schemaMissing, user: {…} }
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ANON_KEY = 'anon-test-key';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256b64url = (text) => b64url(createHash('sha256').update(text).digest());

function defaults() {
  return {
    user: {
      id: '5d1c0c4e-0000-4000-8000-000000000001',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      avatar: 'https://lh3.googleusercontent.com/a/mock-avatar',
    },
    denyNext: false,
    failNextRpc: false,
    schemaMissing: false,
  };
}

export function startMockSupabase(port = 54321) {
  let opts = defaults();
  const codes = new Map();       // authorization code -> { challenge, method }
  const refreshTokens = new Map();
  const profiles = new Map();    // user id -> profile row
  const log = [];                // every request, for assertions
  let lastAuthorize = null;

  const send = (res, status, body, headers = {}) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(payload);
  };

  const sessionFor = () => {
    const now = Math.floor(Date.now() / 1000);
    const u = opts.user;
    const payload = { sub: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, iat: now, exp: now + 3600, session_id: 'sess-1' };
    const jwt = [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify(payload)), b64url('mock-signature')].join('.');
    const refresh = randomBytes(12).toString('hex');
    refreshTokens.set(refresh, u.id);
    return {
      access_token: jwt,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: refresh,
      user: {
        id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
        email_confirmed_at: new Date().toISOString(),
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { full_name: u.name, name: u.name, avatar_url: u.avatar, picture: u.avatar, email: u.email },
        identities: [], created_at: '2026-01-01T00:00:00Z', updated_at: new Date().toISOString(),
      },
    };
  };

  /** The signed-in user id, or an error response already sent. */
  const authenticate = (req, res) => {
    if (req.headers.apikey !== ANON_KEY) { send(res, 401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }); return null; }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const parts = bearer.split('.');
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!claims.sub || claims.exp < Date.now() / 1000) throw new Error('expired');
      return claims;
    } catch {
      send(res, 401, { code: 'PGRST301', message: 'JWT expired or invalid' });
      return null;
    }
  };

  const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });

  const rpc = async (name, req, res) => {
    const claims = authenticate(req, res);
    if (!claims) return;
    const body = await readBody(req);
    log.push({ rpc: name, body, user: claims.sub });

    if (opts.schemaMissing) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache`, details: null, hint: null });
    if (opts.failNextRpc) { opts.failNextRpc = false; return send(res, 500, { code: 'XX000', message: 'internal error (injected by the mock)' }); }

    const ensure = () => {
      if (!profiles.has(claims.sub)) {
        const u = opts.user;
        profiles.set(claims.sub, {
          id: claims.sub, email: claims.email,
          full_name: (body.p_full_name || u.name || '').slice(0, 200) || null,
          avatar_url: (body.p_avatar_url || u.avatar || '').slice(0, 500) || null,
          documents_printed: 0, print_jobs: 0, last_printed_at: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }
      return profiles.get(claims.sub);
    };

    if (name === 'ensure_profile') return send(res, 200, ensure());

    if (name === 'record_print') {
      const n = body.p_documents;
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        return send(res, 400, { code: '22023', message: 'document count must be between 1 and 100', details: null, hint: null });
      }
      const row = ensure();
      row.documents_printed += n;
      row.print_jobs += 1;
      row.last_printed_at = new Date().toISOString();
      row.updated_at = row.last_printed_at;
      return send(res, 200, row);
    }
    return send(res, 404, { message: 'no such function' });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cors = {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
    const reply = (status, body) => send(res, status, body, cors);

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    log.push({ method: req.method, path: url.pathname });

    // ---- control -------------------------------------------------------
    if (url.pathname === '/__mock/state') return reply(200, { profiles: [...profiles.values()], log, lastAuthorize, opts });
    if (url.pathname === '/__mock/reset') { opts = defaults(); profiles.clear(); codes.clear(); refreshTokens.clear(); log.length = 0; lastAuthorize = null; return reply(200, { ok: true }); }
    if (url.pathname === '/__mock/set') {
      const patch = await readBody(req);
      const { user, ...rest } = patch;
      opts = { ...opts, ...rest, user: { ...opts.user, ...(user || {}) } };
      return reply(200, { ok: true });
    }

    // ---- auth ----------------------------------------------------------
    if (url.pathname === '/auth/v1/authorize') {
      const redirectTo = url.searchParams.get('redirect_to') || '';
      lastAuthorize = Object.fromEntries(url.searchParams.entries());
      const back = new URL(redirectTo);
      if (opts.denyNext) {
        opts.denyNext = false;
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'The user cancelled the Google sign-in');
      } else {
        const code = randomBytes(10).toString('hex');
        codes.set(code, { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method') });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.toString(), ...cors });
      return res.end();
    }

    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      const body = await readBody(req);
      if (grant === 'pkce') {
        const entry = codes.get(body.auth_code);
        if (!entry) return reply(400, { error: 'invalid_grant', error_description: 'unknown or already used authorization code' });
        codes.delete(body.auth_code);   // single use
        const expected = /^s256$/i.test(entry.method) ? sha256b64url(String(body.code_verifier || '')) : String(body.code_verifier || '');
        if (expected !== entry.challenge) return reply(400, { error: 'invalid_grant', error_description: 'code verifier does not match the code challenge' });
        return reply(200, sessionFor());
      }
      if (grant === 'refresh_token') {
        if (!refreshTokens.has(body.refresh_token)) return reply(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
        refreshTokens.delete(body.refresh_token);
        return reply(200, sessionFor());
      }
      return reply(400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/auth/v1/user') {
      const claims = authenticate(req, { writeHead: (s, h) => res.writeHead(s, { ...h, ...cors }), end: (b) => res.end(b) });
      return claims ? reply(200, sessionFor().user) : undefined;
    }
    if (url.pathname === '/auth/v1/logout') { res.writeHead(204, cors); return res.end(); }

    // ---- database functions --------------------------------------------
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (m && req.method === 'POST') {
      return rpc(m[1], req, { writeHead: (s, h) => res.writeHead(s, { ...h, ...cors }), end: (b) => res.end(b) });
    }

    return reply(404, { message: 'not found', path: url.pathname });
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      port,
      url: `http://localhost:${port}`,
      close: () => new Promise((r) => server.close(r)),
      state: () => ({ profiles: [...profiles.values()], log: [...log], lastAuthorize }),
    }));
  });
}

// Run directly: keep serving until Ctrl+C.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 54321;
  startMockSupabase(port).then(({ url }) => {
    console.log(`Mock Supabase listening at ${url}   (anon key: ${ANON_KEY})`);
    console.log('Press Ctrl+C to stop.');
  });
}
