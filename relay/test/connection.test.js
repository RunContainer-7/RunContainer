// The PC client against a real relay, over real sockets.
//
// The unit tests prove the retry policy with a scheduler the test drives; this proves the
// parts only a socket can: a ticket bought over HTTP leads to an upgraded connection, a frame
// arrives, a frame leaves, and a dropped connection is replaced.
//
// Nothing is mocked except the relay itself, which is a small server built from the same
// WebSocket framing helpers the companion server already uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCompanionRelay } = require('../../src/services/companionRelay.js');
const { acceptKey, encodeFrame, parseFrames } = require('../../src/services/companionServer.js');

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function startRelay() {
  const sockets = new Set();
  const received = [];
  const connections = [];
  const state = { deviceId: '', deviceKey: '', rejectTickets: false };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/device' && req.method === 'POST') {
      const body = await readBody(req);
      state.deviceId = body.deviceId;
      state.deviceKey = body.deviceKey;
      return json(res, 201, { ok: true, deviceId: body.deviceId });
    }
    const deviceHeader = String(req.headers['x-rc-device'] || '');
    const authorised = deviceHeader && deviceHeader === state.deviceId;
    if (url.pathname === '/api/pair/start') {
      if (!authorised) return json(res, 401, { error: 'unknown device' });
      return json(res, 200, { code: '424242', expiresAt: Date.now() + 300000 });
    }
    if (url.pathname === '/api/ticket') {
      if (!authorised || state.rejectTickets) return json(res, 401, { error: 'unknown device' });
      return json(res, 200, { ticket: 'ticket-abc', room: `device:${state.deviceId}`, role: 'pc', expiresAt: Date.now() + 60000 });
    }
    return json(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || url.searchParams.get('ticket') !== 'ticket-abc') {
      socket.destroy();
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
      '\r\n',
    ].join('\r\n'));
    sockets.add(socket);
    connections.push({ room: url.searchParams.get('room') });
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let parsed;
      try {
        parsed = parseFrames(buffer);
      } catch {
        return;
      }
      buffer = parsed.rest;
      for (const message of parsed.messages) {
        if (message.opcode === 0x1) received.push(JSON.parse(message.payload.toString('utf8')));
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    // The relay greets the PC, the same way the companion server does.
    socket.write(encodeFrame(JSON.stringify({ type: 'hello', productName: 'RunContainer', apps: [] })));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        received,
        connections,
        relaySockets: sockets,
        dropAll() {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
        },
        rejectTickets() {
          state.rejectTickets = true;
        },
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

async function waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('the PC client pairs, buys a ticket and speaks over a real socket', async (t) => {
  const server = await startRelay();
  t.after(() => server.close());

  let stored = {};
  const messages = [];
  const client = createCompanionRelay({
    baseUrl: server.baseUrl,
    loadState: () => stored,
    saveState: (next) => { stored = next; },
  });
  t.after(() => client.disconnect());
  client.on('message', (event) => messages.push(event.data));
  client.on('unauthorised', () => messages.push('unauthorised'));

  const pairing = await client.startPairing();
  assert.equal(pairing.ok, true);
  assert.equal(pairing.code, '424242', 'the six digits come from the relay, not from the PC');
  assert.match(stored.deviceKey, /^[A-Za-z0-9_-]{32,}$/);

  const connected = await client.connect();
  assert.equal(connected.ok, true);
  await waitFor(() => client.status().connected, { label: 'the socket to open' });

  // The relay's greeting arrived through the socket, not through a stub.
  await waitFor(() => messages.length > 0, { label: 'the hello frame' });
  const hello = JSON.parse(messages[0]);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.productName, 'RunContainer');

  // And the PC can send: the relay parses the masked client frame it actually received.
  assert.equal(client.send({ type: 'apps', apps: [] }), true);
  await waitFor(() => server.received.length > 0, { label: 'the relay to receive a frame' });
  assert.deepEqual(server.received[0], { type: 'apps', apps: [] });

  // The room is the device's own, so one PC can never land in another's.
  assert.equal(server.connections[0].room, `device:${stored.deviceId}`);
});

test('a dropped relay connection is replaced without being asked', async (t) => {
  const server = await startRelay();
  t.after(() => server.close());

  let stored = {};
  const client = createCompanionRelay({
    baseUrl: server.baseUrl,
    loadState: () => stored,
    saveState: (next) => { stored = next; },
  });

  t.after(() => client.disconnect());
  await client.connect();
  await waitFor(() => server.connections.length === 1, { label: 'the first connection' });

  server.dropAll();
  // First backoff step is 1s with jitter; the wait is generous on purpose.
  await waitFor(() => server.connections.length >= 2, { timeoutMs: 6000, label: 'a reconnect' });
  assert.equal(client.status().connected, true);
  assert.equal(client.status().attempt, 0, 'a successful open resets the ladder');
});

test('a relay that stops recognising the PC stops the loop instead of retrying forever', async (t) => {
  const server = await startRelay();
  t.after(() => server.close());

  let stored = {};
  const unauthorised = [];
  const client = createCompanionRelay({
    baseUrl: server.baseUrl,
    loadState: () => stored,
    saveState: (next) => { stored = next; },
  });
  t.after(() => client.disconnect());
  client.on('unauthorised', (event) => unauthorised.push(event));

  await client.connect();
  await waitFor(() => server.connections.length === 1, { label: 'the first connection' });

  // The relay forgets the device and drops the socket: the next ticket is a 401, which must
  // end the loop rather than be retried forever.
  server.rejectTickets();
  server.dropAll();

  await waitFor(() => unauthorised.length === 1, { timeoutMs: 6000, label: 'the unauthorised event' });
  assert.equal(client.status().stopped, true);
  const attempts = server.connections.length;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(server.connections.length, attempts, 'no further connections are attempted');
});
