// The D1 adapter against real SQLite.
//
// The memory adapter proves the routes; this proves the SQL. D1 is SQLite with a different
// client, so `node:sqlite` is close enough to catch what a hand-written fake cannot: a column
// alias the route relies on, a missing index column, a bind of the wrong arity, `NULL` where a
// route expects null, and the ON CONFLICT upsert behind the hourly claim cap.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createRelayHandler } from '../src/app.js';
import { createD1Store } from '../src/store.js';
import { createDeviceId, createDeviceKey, LIMITS } from '../src/pairing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');

// The three methods the adapter uses, over node:sqlite, with D1's shapes: first() resolves
// undefined for no row, run() resolves a result object, all() resolves { results }.
function d1OverSqlite(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      const bound = {
        params: [],
        bind(...params) {
          bound.params = params;
          return bound;
        },
        async first() {
          return statement.get(...bound.params) ?? null;
        },
        async run() {
          statement.run(...bound.params);
          return { success: true };
        },
        async all() {
          return { results: statement.all(...bound.params) };
        },
      };
      return bound;
    },
  };
}

function harness(clock = { at: Date.now() }) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const handle = createRelayHandler({
    store: createD1Store(d1OverSqlite(db)),
    secrets: { pepper: 'pepper', ticketSecret: 'ticket-secret', phoneSecret: 'phone-secret' },
    now: () => clock.at,
  });
  const call = (route, { method = 'GET', body, headers = {} } = {}) => handle(new Request(`https://relay.test${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { db, call, clock };
}

async function registered() {
  const env = harness();
  const deviceId = createDeviceId();
  const deviceKey = createDeviceKey();
  const response = await env.call('/api/device', { method: 'POST', body: { deviceId, deviceKey, deviceName: 'Study PC' } });
  assert.equal(response.status, 201);
  return { ...env, deviceId, deviceKey, headers: { authorization: `Bearer ${deviceKey}`, 'x-rc-device': deviceId } };
}

test('the schema applies cleanly to a fresh database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  for (const table of ['claim_attempts', 'devices', 'pair_codes', 'phones']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
});

test('a device is stored by hash, never by key', async () => {
  const env = await registered();
  const row = env.db.prepare('SELECT id, key_hash AS keyHash, name FROM devices').get();
  assert.equal(row.id, env.deviceId);
  assert.match(row.keyHash, /^[a-f0-9]{64}$/);
  assert.ok(!row.keyHash.includes(env.deviceKey));
  assert.equal(row.name, 'Study PC');
});

test('the pairing code is stored peppered, not as the digits', async () => {
  const env = await registered();
  const start = await env.call('/api/pair/start', { method: 'POST', headers: env.headers });
  const { code } = await start.json();
  const row = env.db.prepare('SELECT code_hash AS codeHash, attempts, expires_at AS expiresAt FROM pair_codes').get();
  assert.match(row.codeHash, /^[a-f0-9]{64}$/);
  assert.ok(!row.codeHash.includes(code));
  assert.equal(row.attempts, 0);
  assert.ok(row.expiresAt > env.clock.at);
});

test('a full pairing runs through SQLite: pair, ticket, revoke', async () => {
  const env = await registered();
  const start = await (await env.call('/api/pair/start', { method: 'POST', headers: env.headers })).json();
  const claim = await env.call('/api/pair/claim', {
    method: 'POST',
    body: { code: start.code, phoneName: 'Ari phone' },
    headers: { 'cf-connecting-ip': '203.0.113.77' },
  });
  assert.equal(claim.status, 200);
  const claimBody = await claim.json();

  const phoneRow = env.db.prepare('SELECT id, device_id AS deviceId, name, revoked_at AS revokedAt FROM phones').get();
  assert.equal(phoneRow.deviceId, env.deviceId);
  assert.equal(phoneRow.name, 'Ari phone');
  assert.equal(phoneRow.revokedAt, null, 'a fresh phone is not revoked');

  const codeLeft = env.db.prepare('SELECT COUNT(*) AS total FROM pair_codes').get();
  assert.equal(codeLeft.total, 0, 'a claimed code is deleted');

  const phoneTicket = await env.call('/api/ticket', { method: 'POST', headers: { authorization: `Bearer ${claimBody.token}` } });
  assert.equal(phoneTicket.status, 200);
  assert.equal((await phoneTicket.json()).room, `device:${env.deviceId}`);

  const tickets = await env.call('/api/tickets-not-a-thing', { method: 'POST' });
  assert.equal(tickets.status, 404);

  const pcTicket = await env.call('/api/ticket', { method: 'POST', headers: env.headers });
  assert.equal((await pcTicket.json()).role, 'pc');

  const forget = await env.call('/api/phones/forget', { method: 'POST', headers: env.headers, body: { phoneId: claimBody.phoneId } });
  assert.equal(forget.status, 200);
  const revoked = env.db.prepare('SELECT revoked_at AS revokedAt FROM phones WHERE id = ?').get(claimBody.phoneId);
  assert.ok(revoked.revokedAt > 0);

  const afterRevoke = await env.call('/api/ticket', { method: 'POST', headers: { authorization: `Bearer ${claimBody.token}` } });
  assert.equal(afterRevoke.status, 401);
});

test('wrong codes are counted in the table and delete the code at the cap', async () => {
  const env = await registered();
  const start = await (await env.call('/api/pair/start', { method: 'POST', headers: env.headers })).json();

  let wrong = '000000';
  for (let attempt = 0; attempt < LIMITS.MAX_CODE_ATTEMPTS; attempt += 1) {
    if (wrong === start.code) wrong = '999999';
    const response = await env.call('/api/pair/claim', {
      method: 'POST',
      body: { code: wrong },
      headers: { 'cf-connecting-ip': `10.2.0.${attempt}` },
    });
    assert.equal(response.status, 404);
    const row = env.db.prepare('SELECT attempts FROM pair_codes').get();
    if (attempt < LIMITS.MAX_CODE_ATTEMPTS - 1) {
      assert.equal(row.attempts, attempt + 1, `the table must record attempt ${attempt + 1}`);
    }
  }

  const left = env.db.prepare('SELECT COUNT(*) AS total FROM pair_codes').get();
  assert.equal(left.total, 0, 'the code is deleted once the cap is reached');

  // The real code is dead now, and SQLite agrees with the route.
  const real = await env.call('/api/pair/claim', {
    method: 'POST',
    body: { code: start.code },
    headers: { 'cf-connecting-ip': '10.2.0.200' },
  });
  assert.equal(real.status, 404);
});

test('the hourly claim counter upserts on the same address and hour', async () => {
  const env = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await env.call('/api/pair/claim', {
      method: 'POST',
      body: { code: '123456' },
      headers: { 'cf-connecting-ip': '198.51.100.9' },
    });
  }
  const rows = env.db.prepare('SELECT address, count FROM claim_attempts').all();
  assert.equal(rows.length, 1, 'one row per address per hour, not one per claim');
  assert.equal(rows[0].count, 3);
});
