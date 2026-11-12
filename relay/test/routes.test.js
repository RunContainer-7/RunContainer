// The routes, driven end to end against the in-memory store: register, pair, ticket, revoke.
// No Worker and no D1, so the security behaviour is tested on every commit rather than only
// when something is deployed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRelayHandler } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { createDeviceId, createDeviceKey, LIMITS } from '../src/pairing.js';

function harness(clock = { at: Date.now() }) {
  const store = createMemoryStore();
  const handle = createRelayHandler({
    store,
    secrets: { pepper: 'pepper', ticketSecret: 'ticket-secret', phoneSecret: 'phone-secret' },
    now: () => clock.at,
  });
  const call = (path, { method = 'GET', body, headers = {} } = {}) => handle(new Request(`https://relay.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { store, handle, call, clock };
}

function pcHeaders(deviceId, deviceKey) {
  return { authorization: `Bearer ${deviceKey}`, 'x-rc-device': deviceId };
}

async function registered(deviceName = 'Study PC') {
  const deviceId = createDeviceId();
  const deviceKey = createDeviceKey();
  const env = harness();
  const response = await env.call('/api/device', { method: 'POST', body: { deviceId, deviceKey, deviceName } });
  assert.equal(response.status, 201);
  return { ...env, deviceId, deviceKey, headers: pcHeaders(deviceId, deviceKey) };
}

async function paired() {
  const env = await registered();
  const start = await env.call('/api/pair/start', { method: 'POST', headers: env.headers });
  const { code } = await start.json();
  const claim = await env.call('/api/pair/claim', {
    method: 'POST',
    body: { code, phoneName: 'Ari phone' },
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  });
  const claimBody = await claim.json();
  return { ...env, code, claim, claimBody };
}

test('a device registers once and cannot be taken over', async () => {
  const env = await registered();
  const again = await env.call('/api/device', {
    method: 'POST',
    body: { deviceId: env.deviceId, deviceKey: env.deviceKey, deviceName: 'Renamed' },
  });
  assert.equal(again.status, 200, 'the same key registers again harmlessly');

  const squatter = await env.call('/api/device', {
    method: 'POST',
    body: { deviceId: env.deviceId, deviceKey: createDeviceKey(), deviceName: 'Not mine' },
  });
  assert.equal(squatter.status, 409);
});

test('registration rejects a device id or key that is not the expected shape', async () => {
  const env = harness();
  const badId = await env.call('/api/device', { method: 'POST', body: { deviceId: 'short', deviceKey: createDeviceKey() } });
  assert.equal(badId.status, 400);
  const badKey = await env.call('/api/device', { method: 'POST', body: { deviceId: createDeviceId(), deviceKey: 'short' } });
  assert.equal(badKey.status, 400);
});

test('only the registered PC can start a pairing', async () => {
  const env = await registered();
  const unauthorised = await env.call('/api/pair/start', { method: 'POST' });
  assert.equal(unauthorised.status, 401);

  const wrongKey = await env.call('/api/pair/start', {
    method: 'POST',
    headers: { authorization: `Bearer ${createDeviceKey()}`, 'x-rc-device': env.deviceId },
  });
  assert.equal(wrongKey.status, 401);

  const ok = await env.call('/api/pair/start', { method: 'POST', headers: env.headers });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).code, /^\d{6}$/);
});

test('a phone claims the code once and gets a token bound to that PC', async () => {
  const { claim, claimBody, deviceId, code } = await paired();
  assert.equal(claim.status, 200);
  assert.match(claimBody.token, /^[A-Za-z0-9_-]+\./);
  assert.equal(claimBody.deviceId, deviceId);
  assert.equal(claimBody.deviceName, 'Study PC');

  // The same code cannot pair a second phone.
  const replay = await harness().call('/api/pair/claim', { method: 'POST', body: { code } });
  assert.equal(replay.status, 404);
});

test('a wrong code is refused, counted, and the count is capped', async () => {
  const env = await registered();
  const wrong = await env.call('/api/pair/claim', {
    method: 'POST',
    body: { code: '000000' },
    headers: { 'cf-connecting-ip': '198.51.100.4' },
  });
  assert.equal(wrong.status, 404);
  assert.deepEqual(await wrong.json(), { error: 'That code is not the one shown on the PC.' });
});

test('an expired code says expired, not wrong', async () => {
  const env = await registered();
  const start = await env.call('/api/pair/start', { method: 'POST', headers: env.headers });
  const { code } = await start.json();
  env.clock.at += LIMITS.CODE_TTL_MS + 1;
  const claim = await env.call('/api/pair/claim', { method: 'POST', body: { code } });
  assert.equal(claim.status, 410);
});

test('starting a pairing again replaces the code on screen', async () => {
  const env = await registered();
  const first = await (await env.call('/api/pair/start', { method: 'POST', headers: env.headers })).json();
  const second = await (await env.call('/api/pair/start', { method: 'POST', headers: env.headers })).json();
  const stale = await env.call('/api/pair/claim', { method: 'POST', body: { code: first.code } });
  const fresh = await env.call('/api/pair/claim', { method: 'POST', body: { code: second.code } });
  assert.equal(stale.status, 404);
  assert.equal(fresh.status, 200);
});

test('one address cannot walk six digits: the hourly limit stops it', async () => {
  const env = harness();
  let limited = false;
  for (let attempt = 0; attempt <= LIMITS.CLAIMS_PER_HOUR; attempt += 1) {
    const response = await env.call('/api/pair/claim', {
      method: 'POST',
      body: { code: '123456' },
      headers: { 'cf-connecting-ip': '192.0.2.55' },
    });
    if (response.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true);
});

test('a ticket names the room and the role for each side', async () => {
  const { call, headers, claimBody } = await paired();
  const pc = await (await call('/api/ticket', { method: 'POST', headers })).json();
  assert.equal(pc.role, 'pc');
  assert.equal(pc.room, `device:${claimBody.deviceId}`);
  assert.match(pc.ticket, /^[A-Za-z0-9_-]+\./);

  const phone = await (await call('/api/ticket', { method: 'POST', headers: { authorization: `Bearer ${claimBody.token}` } })).json();
  assert.equal(phone.role, 'phone');
  assert.equal(phone.room, pc.room);
});

test('no credential, no ticket', async () => {
  const { call } = await paired();
  const anonymous = await call('/api/ticket', { method: 'POST' });
  assert.equal(anonymous.status, 401);
  const invented = await call('/api/ticket', { method: 'POST', headers: { authorization: 'Bearer a.b' } });
  assert.equal(invented.status, 401);
});

test('the PC can remove a phone, and the token dies with it', async () => {
  const { call, headers, claimBody } = await paired();
  const before = await call('/api/ticket', { method: 'POST', headers: { authorization: `Bearer ${claimBody.token}` } });
  assert.equal(before.status, 200);

  const forget = await call('/api/phones/forget', { method: 'POST', headers, body: { phoneId: claimBody.phoneId } });
  assert.equal(forget.status, 200);

  const after = await call('/api/ticket', { method: 'POST', headers: { authorization: `Bearer ${claimBody.token}` } });
  assert.equal(after.status, 401);
});

test('a PC cannot remove another PC\'s phone', async () => {
  const mine = await paired();
  const theirs = await paired();
  const response = await mine.call('/api/phones/forget', {
    method: 'POST',
    headers: mine.headers,
    body: { phoneId: theirs.claimBody.phoneId },
  });
  assert.equal(response.status, 404);
});

test('the phone can leave on its own', async () => {
  const { call, claimBody } = await paired();
  const left = await call('/api/phones/self', { method: 'POST', headers: { authorization: `Bearer ${claimBody.token}` } });
  assert.equal(left.status, 200);
  const after = await call('/api/ticket', { method: 'POST', headers: { authorization: `Bearer ${claimBody.token}` } });
  assert.equal(after.status, 401);
});

test('the PC can list the phones paired with it, with no tokens in the answer', async () => {
  const { call, headers, claimBody } = await paired();
  const response = await call('/api/phones', { headers });
  const body = await response.json();
  assert.equal(body.phones.length, 1);
  assert.equal(body.phones[0].id, claimBody.phoneId);
  assert.equal(body.phones[0].name, 'Ari phone');
  assert.ok(!JSON.stringify(body).includes(claimBody.token));
  assert.equal(Object.keys(body.phones[0]).sort().join(','), 'id,name,pairedAt,revoked');
});

test('unknown endpoints answer 404 rather than falling through', async () => {
  const { call } = await paired();
  assert.equal((await call('/api/nothing')).status, 404);
  assert.equal((await call('/nothing')).status, 404);
  assert.equal((await call('/health')).status, 200);
});
