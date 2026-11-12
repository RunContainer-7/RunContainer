// The relay Worker entry. Everything with a decision in it lives in app.js; this file only
// binds the platform's storage and secrets and hands over the request.
//
// Plain fetch handler, no framework: the surface is eight endpoints and a room binding.

import { createRelayHandler } from './app.js';
import { createD1Store } from './store.js';

export default {
  async fetch(request, env) {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: 'The relay has no database bound.' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const handle = createRelayHandler({
      store: createD1Store(env.DB),
      secrets: {
        pepper: env.PAIRING_PEPPER || '',
        ticketSecret: env.TICKET_SECRET || '',
        phoneSecret: env.PHONE_TOKEN_SECRET || '',
      },
      logger: (event) => console.log(event),
    });
    if (!env.PAIRING_PEPPER || !env.TICKET_SECRET || !env.PHONE_TOKEN_SECRET) {
      // A missing secret would silently sign tokens with an empty key, which is worse than
      // being down: refuse everything instead.
      return new Response(JSON.stringify({ error: 'The relay is not configured.' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return handle(request);
  },
};
