// The PC side of the hosted relay.
//
// This is the half of the companion that dials out, so no port is ever opened: the PC asks the
// relay for a room ticket, opens one outbound WebSocket, and reconnects with bounded backoff
// when it drops. It owns identity (device id and key), the code it shows, and the socket. It
// does not decide what a message means — companionServer does — and it does not draw anything.
//
// Everything that touches the outside world is injectable, so the retry policy can be tested
// without a network and without waiting on a real clock.

const crypto = require('crypto');

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const TICKET_PATH = '/api/ticket';

function normaliseBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function websocketUrlFor(base, ticket, room) {
  const secure = /^https:/i.test(base);
  const host = base.replace(/^https?:\/\//i, '');
  return `${secure ? 'wss' : 'ws'}://${host}/ws?room=${encodeURIComponent(room)}&ticket=${encodeURIComponent(ticket)}`;
}

function createCompanionRelay({
  baseUrl,
  loadState = () => ({}),
  saveState = () => {},
  fetchImpl = (...args) => fetch(...args),
  socketFactory = (url) => new WebSocket(url),
  now = () => Date.now(),
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (handle) => clearTimeout(handle),
  random = () => Math.random(),
  logger = () => {},
} = {}) {
  const base = normaliseBase(baseUrl);
  const listeners = new Map();
  let state = { deviceId: '', deviceKey: '', deviceName: 'This PC' };
  let socket = null;
  let reconnectTimer = null;
  let attempt = 0;
  let stopped = true;
  let lastError = '';

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function emit(event, payload) {
    for (const handler of listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (error) {
        logger(`relay.listener.failed ${error.message}`);
      }
    }
  }

  function hydrate() {
    const stored = loadState() || {};
    state = {
      deviceId: String(stored.deviceId || ''),
      deviceKey: String(stored.deviceKey || ''),
      deviceName: String(stored.deviceName || 'This PC'),
      // Remembered so a restart does not re-register a PC that is already registered.
      registered: Boolean(stored.registered),
    };
  }

  function persist() {
    saveState({
      deviceId: state.deviceId,
      deviceKey: state.deviceKey,
      deviceName: state.deviceName,
      registered: Boolean(state.registered),
      savedAt: now(),
    });
  }

  async function call(route, { method = 'POST', body, auth = true } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth) {
      headers.authorization = `Bearer ${state.deviceKey}`;
      headers['x-rc-device'] = state.deviceId;
    }
    let response;
    try {
      response = await fetchImpl(`${base}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      lastError = `The relay could not be reached: ${error.message}`;
      return { ok: false, status: 0, network: true, body: null };
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch (error) {
      parsed = null;
    }
    if (!response.ok) lastError = parsed?.error || `The relay answered ${response.status}.`;
    return { ok: response.ok, status: response.status, body: parsed };
  }

  // Once per PC. The key is generated here and only its hash reaches the relay.
  async function ensureRegistered() {
    hydrate();
    if (!state.deviceId) state.deviceId = crypto.randomBytes(16).toString('hex');
    if (!state.deviceKey) state.deviceKey = crypto.randomBytes(32).toString('base64url');
    if (state.registered) return { ok: true, deviceId: state.deviceId };

    const result = await call('/api/device', {
      auth: false,
      body: { deviceId: state.deviceId, deviceKey: state.deviceKey, deviceName: state.deviceName },
    });
    if (!result.ok) {
      // A 409 means this id already belongs to another key: regenerate rather than argue.
      if (result.status === 409) {
        state.deviceId = crypto.randomBytes(16).toString('hex');
        state.deviceKey = crypto.randomBytes(32).toString('base64url');
        const retry = await call('/api/device', {
          auth: false,
          body: { deviceId: state.deviceId, deviceKey: state.deviceKey, deviceName: state.deviceName },
        });
        if (!retry.ok) return { ok: false, error: lastError };
        state.registered = true;
        persist();
        return { ok: true, deviceId: state.deviceId };
      }
      return { ok: false, error: lastError, network: Boolean(result.network) };
    }
    state.registered = true;
    persist();
    return { ok: true, deviceId: state.deviceId };
  }

  // The six digits the PC shows. Asking again replaces whatever is on screen.
  async function startPairing() {
    const registered = await ensureRegistered();
    if (!registered.ok) return { ok: false, error: registered.error };
    const result = await call('/api/pair/start');
    if (!result.ok) return { ok: false, error: lastError, status: result.status };
    return { ok: true, code: result.body?.code, expiresAt: result.body?.expiresAt };
  }

  async function getTicket() {
    const registered = await ensureRegistered();
    if (!registered.ok) return { ok: false, error: registered.error, network: Boolean(registered.network) };
    const result = await call(TICKET_PATH);
    if (result.ok) return { ok: true, ...result.body };
    return { ok: false, status: result.status, error: lastError, unauthorised: result.status === 401 };
  }

  function clearReconnect() {
    if (reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function closeSocket() {
    if (!socket) return;
    const closing = socket;
    socket = null;
    try {
      closing.onopen = null;
      closing.onclose = null;
      closing.onmessage = null;
      closing.onerror = null;
      closing.close();
    } catch (error) {
      // A socket that is already gone needs nothing from us.
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const step = Math.min(attempt, BACKOFF_MS.length - 1);
    // Jitter keeps a relay restart from bringing every PC back at the same instant.
    const delay = Math.round(BACKOFF_MS[step] * (0.8 + random() * 0.4));
    attempt += 1;
    logger(`relay.reconnect.in ${delay}ms`);
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      open().catch(() => {
        scheduleReconnect();
      });
    }, delay);
  }

  async function open() {
    if (stopped) return;
    const ticket = await getTicket();
    if (!ticket.ok) {
      if (ticket.unauthorised) {
        // The relay does not recognise this PC any more: retrying would hammer it forever.
        stopped = true;
        emit('unauthorised', { error: ticket.error });
        return;
      }
      emit('ticket.failed', { error: ticket.error });
      scheduleReconnect();
      return;
    }

    const url = websocketUrlFor(base, ticket.ticket, ticket.room);
    let opened;
    try {
      opened = socketFactory(url);
    } catch (error) {
      lastError = error.message;
      scheduleReconnect();
      return;
    }
    socket = opened;
    emit('connecting', { room: ticket.room });

    opened.onopen = () => {
      attempt = 0;
      lastError = '';
      logger('relay.socket.open');
      emit('open', { room: ticket.room });
    };
    opened.onmessage = (event) => {
      // The relay is a pipe: what arrives is the companion protocol, handed on untouched.
      emit('message', event);
    };
    opened.onerror = () => {
      // onclose follows; one visible state is enough.
    };
    opened.onclose = () => {
      if (socket === opened) socket = null;
      if (stopped) return;
      logger('relay.socket.closed');
      emit('close', {});
      scheduleReconnect();
    };
  }

  async function connect() {
    if (!base) return { ok: false, error: 'No relay address is configured.' };
    stopped = false;
    return open().then(() => ({ ok: true })).catch((error) => ({ ok: false, error: error.message }));
  }

  function disconnect() {
    stopped = true;
    clearReconnect();
    closeSocket();
    emit('stopped', {});
  }

  function status() {
    hydrate();
    return {
      base,
      deviceId: state.deviceId,
      registered: Boolean(state.registered),
      connected: Boolean(socket),
      attempt,
      stopped,
      error: lastError,
    };
  }

  function send(payload) {
    if (!socket || typeof socket.send !== 'function') return false;
    try {
      socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    } catch (error) {
      return false;
    }
  }

  return { on, connect, disconnect, ensureRegistered, startPairing, getTicket, status, send };
}

module.exports = { createCompanionRelay, BACKOFF_MS, websocketUrlFor, normaliseBase };
