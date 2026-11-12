import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  createDeviceId,
  createDeviceKey,
  createPairingCode,
  hashPairingCode,
  looksLikeDeviceId,
  looksLikeDeviceKey,
  normaliseCode,
  signToken,
  timingSafeEqualStrings,
  verifyToken,
} from '../src/pairing.js';

const SECRET = 'test-secret-not-the-deployed-one';

test('a signed token verifies and carries its claims', async () => {
  const token = await signToken(SECRET, { p: 'phone-1', d: 'device-1', exp: Date.now() + 60000 });
  const payload = await verifyToken(SECRET, token);
  assert.equal(payload.p, 'phone-1');
  assert.equal(payload.d, 'device-1');
});

test('a token signed with another secret does not verify', async () => {
  const token = await signToken('somebody-elses-secret', { p: 'phone-1', exp: Date.now() + 60000 });
  assert.equal(await verifyToken(SECRET, token), null);
});

test('a modified token does not verify', async () => {
  const token = await signToken(SECRET, { p: 'phone-1', d: 'device-a', exp: Date.now() + 60000 });
  const [body, signature] = token.split('.');
  // Flip a character of the payload: the signature no longer describes it.
  const tampered = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}.${signature}`;
  assert.equal(await verifyToken(SECRET, tampered), null);
});

test('a valid token expires on its own claims, not on a clock it chooses', async () => {
  const exp = Date.now() + 1000;
  const token = await signToken(SECRET, { p: 'phone-1', exp });
  assert.ok(await verifyToken(SECRET, token, exp - 1));
  assert.equal(await verifyToken(SECRET, token, exp), null);
  assert.equal(await verifyToken(SECRET, token, exp + 60000), null);
});

test('an expired or malformed token is refused rather than throwing', async () => {
  assert.equal(await verifyToken(SECRET, ''), null);
  assert.equal(await verifyToken(SECRET, 'not-a-token'), null);
  assert.equal(await verifyToken(SECRET, 'a.b.c'), null);
  const notJson = await signToken(SECRET, { exp: Date.now() + 60000 });
  assert.ok(await verifyToken(SECRET, notJson));
});

test('six digits are generated from a six-digit space, including leading zeros', () => {
  assert.equal(createPairingCode(() => 0), '000000');
  assert.equal(createPairingCode(() => 7), '000007');
  assert.equal(createPairingCode(() => 999999), '999999');
});

test('the code is normalised before it is compared', () => {
  assert.equal(normaliseCode(' 12 34 56 '), '123456');
  assert.equal(normaliseCode('12-34-56'), '123456');
  assert.equal(normaliseCode('1234567'), '123456');
  assert.equal(normaliseCode(''), '');
});

test('the stored hash is peppered and never the code itself', async () => {
  const one = await hashPairingCode('pepper-a', '123456');
  const two = await hashPairingCode('pepper-b', '123456');
  assert.notEqual(one, two);
  assert.match(one, /^[a-f0-9]{64}$/);
  assert.ok(!one.includes('123456'));
  assert.equal(one, await hashPairingCode('pepper-a', '123456'));
});

test('comparison is length-checked and content-checked', () => {
  assert.equal(timingSafeEqualStrings('abc', 'abc'), true);
  assert.equal(timingSafeEqualStrings('abc', 'abd'), false);
  assert.equal(timingSafeEqualStrings('abc', 'abcdef'), false);
});

test('device ids and keys are shaped as the routes expect', () => {
  const id = createDeviceId();
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(looksLikeDeviceId(id), true);
  assert.equal(looksLikeDeviceId('not-a-device'), false);
  assert.equal(looksLikeDeviceId('A'.repeat(32)), false, 'uppercase is not the generated shape');

  const key = createDeviceKey();
  assert.equal(looksLikeDeviceKey(key), true);
  assert.equal(looksLikeDeviceKey('short'), false);
  assert.equal(looksLikeDeviceKey('has spaces in it and is long enough to pass'), false);
});

test('the pairing window is short and the attempts are few', () => {
  assert.equal(LIMITS.CODE_LENGTH, 6);
  assert.ok(LIMITS.CODE_TTL_MS <= 10 * 60 * 1000);
  assert.ok(LIMITS.MAX_CODE_ATTEMPTS <= 10);
  assert.ok(LIMITS.CLAIMS_PER_HOUR <= 60);
});
