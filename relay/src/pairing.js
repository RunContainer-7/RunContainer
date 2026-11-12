// Pairing and token cryptography for the hosted relay.
//
// Kept apart from the HTTP handler and from the database so the security-relevant parts can
// be tested on their own: a wrong comparison here is a phone that should not be paired.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CODE_LENGTH = 6;
const DEVICE_ID_BYTES = 16;
const DEVICE_KEY_BYTES = 32;

export function toBase64Url(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Neither side controls the other's timing, so a plain loop is enough: what matters is that
// the comparison does not stop at the first difference.
export function timingSafeEqualStrings(a, b) {
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function hmacBase64Url(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(message)));
  return toBase64Url(signature);
}

// A token carries its own claims and its own signature, so a ticket can be checked without a
// database read. Anything revocable (a phone) is still looked up: a signature proves who
// minted the token, not that the phone is still allowed.
export async function signToken(secret, payload) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacBase64Url(secret, body);
  return `${body}.${signature}`;
}

export async function verifyToken(secret, token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = await hmacBase64Url(secret, body);
  if (!timingSafeEqualStrings(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
  return payload;
}

// Six digits from the platform's CSPRNG. A predictable code is a code somebody else on our
// site could claim before the person holding the phone does.
export function createPairingCode(randomInt = defaultRandomInt) {
  return String(randomInt(0, 1000000)).padStart(CODE_LENGTH, '0');
}

function defaultRandomInt(min, max) {
  const range = max - min;
  const limit = Math.floor(0xffffffff / range) * range;
  const buffer = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return min + (value % range);
}

export function normaliseCode(code) {
  return String(code || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
}

// The relay stores a hash, never the code: a database dump must not let someone pair, and the
// pepper keeps a six-digit space from being brute-forced offline.
export async function hashPairingCode(pepper, code) {
  return sha256Hex(`${pepper}:${normaliseCode(code)}`);
}

export function looksLikeDeviceId(value) {
  return /^[a-f0-9]{32}$/.test(String(value || ''));
}

export function createDeviceId() {
  return randomHex(DEVICE_ID_BYTES);
}

export function createDeviceKey() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(DEVICE_KEY_BYTES)));
}

export function looksLikeDeviceKey(value) {
  const text = String(value || '');
  if (text.length < 32 || text.length > 128) return false;
  return /^[A-Za-z0-9_-]+$/.test(text);
}

export const LIMITS = {
  CODE_LENGTH,
  CODE_TTL_MS: 5 * 60 * 1000,
  MAX_CODE_ATTEMPTS: 8,
  CLAIMS_PER_HOUR: 30,
  PHONE_TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  TICKET_TTL_MS: 60 * 1000,
};
