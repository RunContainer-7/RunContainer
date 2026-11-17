// Publishing the PC's pairing code to the hosted companion.
//
// The hosted page used to need the PC's https address typed on the phone before it could
// pair. Instead, the PC registers the six-digit code it is already showing, together with
// its web address, and the page looks the address up from that code. One code, one step.
//
// Nothing here runs unless the web address is on: without it there is no address a hosted
// page could reach, and the local page does not need a lookup.

export const COMPANION_SITE_URL = 'https://runcontainer-companion-x7z9m3.freebuff.page/';

export function connectCodePayload(companion) {
  if (!companion?.running || !companion?.web?.enabled) return null;
  const code = String(companion.code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  let address;
  try {
    address = new URL(String(companion.web.url || ''));
  } catch (error) {
    return null;
  }
  if (address.protocol !== 'https:') return null;
  if (!/(^|\.)ts\.net$/i.test(address.hostname)) return null;
  return { code, target: address.origin };
}

export async function registerCompanionConnectCode(companion, fetchImpl = globalThis.fetch) {
  const payload = connectCodePayload(companion);
  if (!payload || typeof fetchImpl !== 'function') return false;
  try {
    const response = await fetchImpl(`${COMPANION_SITE_URL}api/connect-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    return Boolean(response?.ok);
  } catch (error) {
    // Offline, or the site is down: the QR code and the address still work.
    return false;
  }
}
