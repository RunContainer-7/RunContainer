// The relay's HTTP surface: registration, pairing, ticketing and revocation.
//
// Sockets are not here. A phone and a PC each ask for a short-lived room ticket, and the
// managed realtime room carries the frames; this file only decides who is allowed to ask.
//
// Nothing in here needs a deployed Worker to be exercised: the routes take a store, so the
// tests drive them against the memory adapter.

import {
  LIMITS,
  createPairingCode,
  hashPairingCode,
  looksLikeDeviceId,
  looksLikeDeviceKey,
  normaliseCode,
  randomHex,
  sha256Hex,
  signToken,
  timingSafeEqualStrings,
  verifyToken,
} from './pairing.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (text.length > 8192) return null;
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function cleanName(value, fallback) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return text || fallback;
}

export function createRelayHandler({ store, secrets, now = () => Date.now(), logger = () => {} }) {
  const { pepper, ticketSecret, phoneSecret } = secrets;

  function bearer(request) {
    const header = String(request.headers.get('authorization') || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
  }

  // A PC proves itself with the key it registered; the relay only ever holds its hash.
  async function deviceFromRequest(request) {
    const key = bearer(request);
    if (!looksLikeDeviceKey(key)) return null;
    const keyHash = await sha256Hex(key);
    const deviceId = String(request.headers.get('x-rc-device') || '');
    if (!looksLikeDeviceId(deviceId)) return null;
    const device = await store.getDevice(deviceId);
    if (!device) return null;
    return timingSafeEqualStrings(device.keyHash, keyHash) ? device : null;
  }

  async function phoneFromRequest(request) {
    const token = bearer(request);
    if (!token) return null;
    const payload = await verifyToken(phoneSecret, token, now());
    if (!payload || !payload.p) return null;
    const phone = await store.getPhone(payload.p);
    if (!phone || phone.revokedAt) return null;
    return phone;
  }

  async function pairCodeHash(code) {
    return hashPairingCode(pepper, code);
  }

  async function health() {
    return json(200, { ok: true, service: 'rc-relay', stage: 'skeleton' });
  }

  // Once per PC. A second registration with a different key is refused, so a device ID cannot
  // be taken over by whoever asks for it second.
  async function registerDevice(request) {
    const body = await readJson(request);
    if (!body) return json(400, { error: 'Send a JSON body.' });
    const deviceId = String(body.deviceId || '');
    const deviceKey = String(body.deviceKey || '');
    if (!looksLikeDeviceId(deviceId)) return json(400, { error: 'deviceId must be 32 hexadecimal characters.' });
    if (!looksLikeDeviceKey(deviceKey)) return json(400, { error: 'deviceKey must be 32 to 128 URL-safe characters.' });
    const name = cleanName(body.deviceName, 'This PC');
    const keyHash = await sha256Hex(deviceKey);
    const at = now();

    const existing = await store.getDevice(deviceId);
    if (!existing) {
      await store.putDevice({ id: deviceId, keyHash, name, createdAt: at, lastSeenAt: at });
      logger('relay.device.registered');
      return json(201, { ok: true, deviceId, deviceName: name });
    }
    if (!timingSafeEqualStrings(existing.keyHash, keyHash)) {
      return json(409, { error: 'That device id is already registered to another PC.' });
    }
    await store.touchDevice(deviceId, at);
    return json(200, { ok: true, deviceId, deviceName: existing.name });
  }

  // The PC asks for the six digits it will show.
  async function startPairing(request) {
    const device = await deviceFromRequest(request);
    if (!device) return json(401, { error: 'This PC is not registered with the relay.' });
    const code = createPairingCode();
    const at = now();
    // Only one live code per PC: starting again replaces the one already on screen.
    await store.deletePairCodesForDevice(device.id);
    await store.putPairCode({
      id: randomHex(8),
      deviceId: device.id,
      codeHash: await pairCodeHash(code),
      attempts: 0,
      expiresAt: at + LIMITS.CODE_TTL_MS,
      createdAt: at,
    });
    await store.touchDevice(device.id, at);
    return json(200, { code, expiresAt: at + LIMITS.CODE_TTL_MS });
  }

  // The phone is the only unauthenticated caller, so this is where the limits live.
  async function claimPairing(request) {
    const body = await readJson(request);
    if (!body) return json(400, { error: 'Send a JSON body.' });
    const code = normaliseCode(body.code);
    const address = String(request.headers.get('cf-connecting-ip') || 'unknown');
    const at = now();
    const windowStart = Math.floor(at / 3600000) * 3600000;

    const used = await store.countClaims(address, windowStart);
    if (used >= LIMITS.CLAIMS_PER_HOUR) {
      return json(429, { error: 'Too many codes tried from this connection. Wait, then ask the PC for a new code.' });
    }
    await store.recordClaim(address, windowStart);

    if (code.length !== LIMITS.CODE_LENGTH) {
      return json(400, { error: 'Type the six digits shown on the PC.' });
    }

    const row = await store.getPairCodeByHash(await pairCodeHash(code));
    if (!row) return json(404, { error: 'That code is not the one shown on the PC.' });
    if (row.expiresAt <= at) {
      await store.deletePairCode(row.id);
      return json(410, { error: 'That code has expired. Ask the PC for a new one.' });
    }
    if (row.attempts >= LIMITS.MAX_CODE_ATTEMPTS) {
      await store.deletePairCode(row.id);
      return json(429, { error: 'Too many tries for that code. Ask the PC for a new one.' });
    }
    await store.bumpPairCodeAttempts(row.id);

    const device = await store.getDevice(row.deviceId);
    if (!device) {
      await store.deletePairCode(row.id);
      return json(404, { error: 'That PC is no longer registered.' });
    }

    const phoneId = randomHex(12);
    const token = await signToken(phoneSecret, {
      p: phoneId,
      d: device.id,
      exp: at + LIMITS.PHONE_TOKEN_TTL_MS,
    });
    await store.putPhone({
      id: phoneId,
      deviceId: device.id,
      name: cleanName(body.phoneName, 'iPhone'),
      tokenHash: await sha256Hex(token),
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
    });
    // A code is spent on the phone that claimed it, even if a second phone is watching.
    await store.deletePairCode(row.id);
    logger('relay.phone.paired');
    return json(200, {
      token,
      phoneId,
      deviceId: device.id,
      deviceName: device.name,
      expiresAt: at + LIMITS.PHONE_TOKEN_TTL_MS,
    });
  }

  // Both sides ask for a ticket before opening a socket. It names the room and the role, and
  // expires in a minute: a ticket is a handshake, not a session.
  async function issueTicket(request) {
    const device = await deviceFromRequest(request);
    const phone = device ? null : await phoneFromRequest(request);
    if (!device && !phone) return json(401, { error: 'This device or phone is not paired with the relay.' });

    const deviceId = device ? device.id : phone.deviceId;
    const role = device ? 'pc' : 'phone';
    const at = now();
    const ticket = await signToken(ticketSecret, {
      d: deviceId,
      r: role,
      p: device ? null : phone.id,
      exp: at + LIMITS.TICKET_TTL_MS,
    });
    if (phone) await store.touchDevice(deviceId, at);
    return json(200, {
      ticket,
      room: `device:${deviceId}`,
      role,
      expiresAt: at + LIMITS.TICKET_TTL_MS,
    });
  }

  // The PC removes a phone; the compliance path matters more than the happy path.
  async function forgetPhone(request) {
    const device = await deviceFromRequest(request);
    if (!device) return json(401, { error: 'Only the paired PC can remove a phone.' });
    const body = await readJson(request);
    if (!body || !body.phoneId) return json(400, { error: 'Send the phoneId to remove.' });
    const phone = await store.getPhone(String(body.phoneId));
    if (!phone || phone.deviceId !== device.id) return json(404, { error: 'That phone is not paired with this PC.' });
    await store.revokePhone(phone.id, now());
    logger('relay.phone.forgotten');
    return json(200, { ok: true });
  }

  async function listPhones(request) {
    const device = await deviceFromRequest(request);
    if (!device) return json(401, { error: 'Only the paired PC can list its phones.' });
    const phones = await store.listPhones(device.id);
    return json(200, {
      phones: phones.map((phone) => ({
        id: phone.id,
        name: phone.name,
        pairedAt: phone.createdAt,
        revoked: Boolean(phone.revokedAt),
      })),
    });
  }

  // A phone leaving is not a security event, but it should not leave a live token behind.
  async function forgetSelf(request) {
    const phone = await phoneFromRequest(request);
    if (!phone) return json(401, { error: 'This phone is not paired with the relay.' });
    await store.revokePhone(phone.id, now());
    return json(200, { ok: true });
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (pathname === '/health' && method === 'GET') return health();
    if (pathname === '/api/device' && method === 'POST') return registerDevice(request);
    if (pathname === '/api/pair/start' && method === 'POST') return startPairing(request);
    if (pathname === '/api/pair/claim' && method === 'POST') return claimPairing(request);
    if (pathname === '/api/ticket' && method === 'POST') return issueTicket(request);
    if (pathname === '/api/phones' && method === 'GET') return listPhones(request);
    if (pathname === '/api/phones/forget' && method === 'POST') return forgetPhone(request);
    if (pathname === '/api/phones/self' && method === 'POST') return forgetSelf(request);
    if (pathname.startsWith('/api/')) return json(404, { error: 'Unknown endpoint.' });
    return json(404, { error: 'Not found.' });
  };
}
