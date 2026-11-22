// The hosted companion's Worker.
//
// It serves the page, remembers which PC a six-digit code belongs to, and forwards
// /pc requests to that PC. The PC keeps its own https address (Tailscale Funnel), so the
// browser never needs CORS or a mixed-content exception: the site's own origin makes the
// request, and this Worker makes the hop.
//
// The code lookup exists so the phone types one code instead of a URL. The PC posts its
// current pairing code with its web address; the phone sends that code to /api/pair and
// to /api/connect-code, and everything else follows from it.

const PC_PATH = '/pc';
const CONNECT_PATH = '/api/connect-code';
// The PC's pairing code expires after five minutes; the mapping lives a minute longer so a
// phone that starts typing just under the wire is not refused.
const CODE_TTL_MS = 6 * 60 * 1000;
// Best effort, per isolate: 6 digits is a small space, so a plain loop over codes could
// reveal addresses. This makes that loop slow without adding a write per lookup.
const LOOKUPS_PER_MINUTE = 30;
const lookups = new Map();

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// `allowLocal` is only true when this Worker is itself being called on localhost, so a
// production deploy cannot be talked into proxying to its own loopback.
function normaliseTarget(value, allowLocal) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (error) {
    return '';
  }
  const loopback = isLoopback(parsed.hostname);
  if (!/(^|\.)ts\.net$/i.test(parsed.hostname) && !(allowLocal && loopback)) return '';
  if (parsed.protocol !== 'https:' && !(allowLocal && loopback && parsed.protocol === 'http:')) return '';
  if (parsed.username || parsed.password) return '';
  return parsed.origin;
}

function upstreamUrl(requestUrl, allowLocal) {
  const target = normaliseTarget(requestUrl.searchParams.get('target'), allowLocal);
  return target ? new URL(target) : null;
}

function upstreamHeaders(request) {
  const headers = new Headers(request.headers);
  // The PC's companion server authorises a paired phone by its token, not by a browser
  // session. Removing these keeps the site's own origin and cookies out of the PC, and
  // lets the PC treat the call as the same kind of client it already accepts.
  for (const name of ['host', 'origin', 'referer', 'cookie', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto']) {
    headers.delete(name);
  }
  return headers;
}

function corsHeaders(extra) {
  return Object.assign({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  }, extra || {});
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      // The PC's Settings window posts here from the app's own origin, which may be a
      // local dev server or a file origin. The endpoint holds no session and returns
      // nothing about anyone else, so a wildcard origin is the honest header.
      ...corsHeaders(),
    }, extra || {}),
  });
}

let schemaReady = null;
function ensureSchema(env) {
  if (!env || !env.DB) return Promise.reject(new Error('The connect-code database is not attached.'));
  if (!schemaReady) {
    schemaReady = env.DB
      .prepare('CREATE TABLE IF NOT EXISTS connect_codes (code TEXT PRIMARY KEY, target TEXT NOT NULL, expires_at INTEGER NOT NULL)')
      .run()
      .catch((error) => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

async function registerCode(request, env, allowLocal) {
  let body = null;
  try { body = await request.json(); } catch (error) { body = null; }
  const code = String(body?.code || '').replace(/\D/g, '');
  const target = normaliseTarget(body?.target, allowLocal);
  if (!/^\d{6}$/.test(code)) return json({ error: 'A connect code is six digits.' }, 400);
  if (!target) return json({ error: 'Only an https://…ts.net PC address can be registered.' }, 400);
  try {
    await ensureSchema(env);
    const now = Date.now();
    const expiresAt = now + CODE_TTL_MS;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM connect_codes WHERE expires_at < ?').bind(now),
      env.DB.prepare('INSERT INTO connect_codes (code, target, expires_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET target = excluded.target, expires_at = excluded.expires_at').bind(code, target, expiresAt),
    ]);
    return json({ code, target, expiresAt });
  } catch (error) {
    return json({ error: 'The code could not be stored.' }, 503);
  }
}

async function lookupCode(request, env) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) return json({ error: 'A connect code is six digits.' }, 400);
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now();
  const hit = lookups.get(ip);
  if (!hit || hit.reset <= now) {
    lookups.set(ip, { count: 1, reset: now + 60 * 1000 });
  } else if (hit.count >= LOOKUPS_PER_MINUTE) {
    return json({ error: 'Too many codes tried. Wait a minute and try again.' }, 429);
  } else {
    hit.count += 1;
  }
  try {
    await ensureSchema(env);
    const row = await env.DB.prepare('SELECT target, expires_at FROM connect_codes WHERE code = ?').bind(code).first();
    if (!row || Number(row.expires_at) <= now) {
      return json({ error: 'That code is not active.' }, 404);
    }
    return json({ code, target: row.target, expiresAt: Number(row.expires_at) });
  } catch (error) {
    return json({ error: 'The code could not be read.' }, 503);
  }
}

async function handleConnectCode(request, env, allowLocal) {
  // A 204 cannot carry a body; building one with a body throws and becomes a 502.
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === 'POST') return registerCode(request, env, allowLocal);
  if (request.method === 'GET') return lookupCode(request, env);
  return json({ error: 'Use GET or POST.' }, 405);
}

async function proxyWebSocket(request, target) {
  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: { Upgrade: 'websocket' },
    });
  } catch (error) {
    return new Response('The PC could not be reached. Check that RunContainer is running and the address is current.', { status: 502 });
  }
  const upstreamSocket = upstream.webSocket;
  if (!upstreamSocket) {
    return new Response('The PC refused the control connection.', { status: 502 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  upstreamSocket.accept();

  server.addEventListener('message', (event) => {
    try { upstreamSocket.send(event.data); } catch (error) { /* already closed */ }
  });
  upstreamSocket.addEventListener('message', (event) => {
    try { server.send(event.data); } catch (error) { /* already closed */ }
  });
  const closeBoth = (source, other) => {
    source.addEventListener('close', (event) => {
      try { other.close(event.code, event.reason); } catch (error) { /* already closed */ }
    });
  };
  closeBoth(server, upstreamSocket);
  closeBoth(upstreamSocket, server);
  server.addEventListener('error', () => {
    try { upstreamSocket.close(1011, 'Proxy error'); } catch (error) { /* already closed */ }
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function proxyHttp(request, target) {
  const headers = upstreamHeaders(request);
  const init = {
    method: request.method,
    headers,
    redirect: 'follow',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  let response;
  try {
    response = await fetch(target.toString(), init);
  } catch (error) {
    return new Response(JSON.stringify({ error: 'The PC could not be reached. Check that RunContainer is running and the address is current.' }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const out = new Response(response.body, response);
  out.headers.set('cache-control', 'no-store');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowLocal = isLoopback(url.hostname);
    // The installed icon opens /app/; a typed or shared /app goes there too, instead of
    // depending on the asset server's own trailing-slash redirect.
    if (url.pathname === '/app') {
      url.pathname = '/app/';
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname === CONNECT_PATH) return handleConnectCode(request, env, allowLocal);
    if (url.pathname !== PC_PATH) {
      return env.ASSETS.fetch(request);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    const target = upstreamUrl(url, allowLocal);
    if (!target) {
      return new Response('Only an https://…ts.net PC address can be reached from this site.', {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const upgrade = String(request.headers.get('upgrade') || '').toLowerCase();
    if (upgrade === 'websocket') return proxyWebSocket(request, target);
    return proxyHttp(request, target);
  },
};
