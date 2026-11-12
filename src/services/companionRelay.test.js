const { createCompanionRelay, BACKOFF_MS, websocketUrlFor } = require('./companionRelay');

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fetchScript(handlers) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, headers: options.headers || {}, body: options.body });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(calls.length);
    }
    return reply(404, { error: 'no handler' });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function socketStub() {
  const socket = {
    sent: [],
    closed: false,
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    send(payload) { socket.sent.push(payload); },
    close() { socket.closed = true; },
    open() { socket.onopen?.(); },
    fail() { socket.onclose?.(); },
  };
  return socket;
}

async function flush() {
  // Let the fetch and socket callbacks inside a scheduled retry settle.
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// A scheduler the test drives by hand. This is why the client takes setTimeout/clearTimeout as
// arguments: the retry policy can be asserted without waiting, and without depending on which
// Jest timer helpers this version happens to have.
function scheduler() {
  const timers = [];
  return {
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      if (timer) timer.cancelled = true;
    },
    pending: () => timers.filter((timer) => !timer.cancelled),
    delays: () => timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms),
    async runNext() {
      const next = timers.find((timer) => !timer.cancelled);
      if (!next) throw new Error('no retry was scheduled');
      next.cancelled = true;
      next.fn();
      await flush();
    },
  };
}

function setup(handlers, extra = {}) {
  const sockets = [];
  let stored = {};
  const fetchImpl = fetchScript(handlers);
  const relay = createCompanionRelay({
    baseUrl: 'https://relay.example/',
    loadState: () => stored,
    saveState: (next) => { stored = next; },
    fetchImpl,
    socketFactory: (url) => {
      const socket = socketStub();
      socket.url = url;
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5, // jitter factor of exactly 1, so a delay is comparable to BACKOFF_MS
    ...extra,
  });
  return { relay, fetchImpl, sockets, saved: () => stored };
}

const TICKET_OK = ['/api/ticket', () => reply(200, { ticket: 't', room: 'device:abc', role: 'pc' })];
const DEVICE_OK = ['/api/device', () => reply(201, { ok: true })];

describe('PC relay client', () => {
  it('generates a device identity once and registers it once', async () => {
    const { relay, fetchImpl, saved } = setup([DEVICE_OK]);

    const first = await relay.ensureRegistered();
    const second = await relay.ensureRegistered();

    expect(first.ok).toBe(true);
    expect(second.deviceId).toBe(first.deviceId);
    expect(fetchImpl.calls.filter((call) => call.url.endsWith('/api/device'))).toHaveLength(1);
    expect(saved().deviceId).toMatch(/^[a-f0-9]{32}$/);
    expect(saved().deviceKey.length).toBeGreaterThanOrEqual(32);
  });

  it('sends the key it was given, never the relay base twice', async () => {
    const { relay, fetchImpl, saved } = setup([DEVICE_OK]);
    await relay.ensureRegistered();
    const registration = JSON.parse(fetchImpl.calls[0].body);
    expect(fetchImpl.calls[0].url).toBe('https://relay.example/api/device');
    expect(registration.deviceKey).toBe(saved().deviceKey);
  });

  it('regenerates the identity if the relay says the id belongs to another PC', async () => {
    let attempt = 0;
    const { relay, saved } = setup([
      ['/api/device', () => {
        attempt += 1;
        return attempt === 1 ? reply(409, { error: 'taken' }) : reply(201, { ok: true });
      }],
    ]);
    const result = await relay.ensureRegistered();
    expect(result.ok).toBe(true);
    expect(attempt).toBe(2);
    expect(saved().deviceId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('shows the code the relay issues, with proof of which PC it is', async () => {
    const { relay, fetchImpl } = setup([
      DEVICE_OK,
      ['/api/pair/start', () => reply(200, { code: '123456', expiresAt: 1000 })],
    ]);

    const result = await relay.startPairing();
    expect(result).toEqual({ ok: true, code: '123456', expiresAt: 1000 });

    const pairingCall = fetchImpl.calls.find((call) => call.url.endsWith('/api/pair/start'));
    expect(pairingCall.headers.authorization).toMatch(/^Bearer /);
    expect(pairingCall.headers['x-rc-device']).toMatch(/^[a-f0-9]{32}$/);
  });

  it('opens one socket with the ticket and room the relay returned', async () => {
    const { relay, sockets } = setup([DEVICE_OK, TICKET_OK]);

    await relay.connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('wss://relay.example/ws?room=device%3Aabc&ticket=t');
    expect(websocketUrlFor('http://localhost:8787', 't', 'r')).toBe('ws://localhost:8787/ws?room=r&ticket=t');
  });

  it('backs off further on every failed reconnect and resets once a socket opens', async () => {
    const sched = scheduler();
    const { relay, sockets } = setup([DEVICE_OK, TICKET_OK], sched);

    await relay.connect();
    expect(sockets).toHaveLength(1);

    sockets[0].fail();
    expect(sched.delays()).toEqual([BACKOFF_MS[0]]);
    await sched.runNext();
    expect(sockets).toHaveLength(2);

    sockets[1].fail();
    expect(sched.delays()).toEqual([BACKOFF_MS[1]]);
    await sched.runNext();
    expect(sockets).toHaveLength(3);

    sockets[2].open();
    expect(relay.status().attempt).toBe(0);

    sockets[2].fail();
    expect(sched.delays()).toEqual([BACKOFF_MS[0]]);
  });

  it('stops asking when the relay no longer recognises this PC', async () => {
    const sched = scheduler();
    const { relay } = setup([
      DEVICE_OK,
      ['/api/ticket', () => reply(401, { error: 'not paired' })],
    ], sched);

    const result = await relay.connect();
    expect(result.ok).toBe(true);
    expect(relay.status().stopped).toBe(true);
    expect(sched.delays()).toEqual([]);
  });

  it('retries when the relay is unreachable rather than giving up', async () => {
    const sched = scheduler();
    let attempts = 0;
    const { relay } = setup([
      DEVICE_OK,
      ['/api/ticket', () => {
        attempts += 1;
        throw new Error('ECONNREFUSED');
      }],
    ], sched);

    await relay.connect();
    expect(attempts).toBe(1);
    await sched.runNext();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(relay.status().stopped).toBe(false);
    expect(sched.delays()).toEqual([BACKOFF_MS[1]]);
  });

  it('cancels a pending reconnect when it is disconnected', async () => {
    const sched = scheduler();
    const { relay, sockets } = setup([DEVICE_OK, TICKET_OK], sched);

    await relay.connect();
    sockets[0].fail();
    expect(sched.delays()).toHaveLength(1);

    relay.disconnect();
    expect(sched.delays()).toEqual([]);
    expect(relay.status().connected).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it('refuses to connect without a relay address instead of throwing', async () => {
    const bare = createCompanionRelay({ baseUrl: '' });
    const result = await bare.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no relay address/i);
  });

  it('sends through the socket only while it is open', async () => {
    const { relay, sockets } = setup([DEVICE_OK, TICKET_OK]);
    expect(relay.send({ type: 'hello' })).toBe(false);
    await relay.connect();
    expect(relay.send({ type: 'hello' })).toBe(true);
    expect(sockets[0].sent[0]).toBe('{"type":"hello"}');
  });
});
