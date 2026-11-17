// The hosted companion's Worker.
//
// It serves the page and, for anything under /pc, forwards the request to the PC the
// person named. The PC is reached at its own https address (Tailscale Funnel), so the
// browser never needs CORS or a mixed-content exception: the site's own origin makes the
// request, and this Worker makes the hop to the PC.
//
// Only https://…ts.net is accepted (plus loopback for local Wrangler testing). That is
// deliberate: an unrestricted proxy would let this origin be used to reach anything.

const PC_PATH = '/pc';

function allowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || /(^|\.)ts\.net$/.test(host);
}

function upstreamUrl(requestUrl) {
  const target = requestUrl.searchParams.get('target');
  if (!target) return null;
  let parsed;
  try {
    parsed = new URL(target);
  } catch (error) {
    return null;
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (!allowedHost(parsed.hostname)) return null;
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null;
  if (parsed.username || parsed.password) return null;
  return parsed;
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
    if (url.pathname !== PC_PATH) {
      return env.ASSETS.fetch(request);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    const target = upstreamUrl(url);
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
