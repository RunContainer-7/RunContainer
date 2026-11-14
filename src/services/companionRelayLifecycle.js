// The relay lifecycle, taken out of the main process so it can be tested on its own.
//
// It owns the relay instance and the code the PC shows, and nothing else: it does not know
// about sockets, IPC or the UI. main.js passes in storage and a factory for the client, so
// the tests can hand it a fake relay and a fake clock without standing up Electron.

function createCompanionRelayLifecycle({
  loadState = () => ({}),
  saveState = () => {},
  createRelay = () => null,
  logger = () => {},
  now = () => Date.now(),
} = {}) {
  let relay = null;
  let code = null;

  function status() {
    const stored = loadState() || {};
    return {
      enabled: stored.relayEnabled === true,
      address: stored.relayUrl || '',
      code: code?.code || null,
      codeExpiresAt: code?.expiresAt || 0,
      connected: Boolean(relay?.status().connected),
      error: stored.relayError || '',
    };
  }

  async function start(address) {
    const url = String(address || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'The relay address must start with https://' };
    }
    stop();
    relay = createRelay({
      baseUrl: url,
      loadState: () => loadState() || {},
      saveState: (state) => saveState(state),
      logger,
    });
    // The 401 path is the important one: a relay that has forgotten this PC must stop the
    // loop instead of hammering it. Everything else is reporting.
    relay.on('open', () => {
      saveState({ relayError: '' });
    });
    relay.on('close', () => {});
    relay.on('unauthorised', () => {
      stop();
      saveState({ relayEnabled: false, relayError: 'The relay no longer recognises this PC. Turn remote access on again to register it.' });
    });

    const registered = await relay.ensureRegistered();
    if (!registered.ok) {
      const error = registered.error || 'The relay could not be reached.';
      stop();
      saveState({ relayEnabled: false, relayUrl: url, relayError: error });
      return { ok: false, error };
    }
    saveState({ relayUrl: url, relayEnabled: true, relayError: '' });
    const pairing = await relay.startPairing();
    code = pairing.ok ? { code: pairing.code, expiresAt: pairing.expiresAt } : null;
    relay.connect().catch((error) => logger(`Relay connect failed: ${error.message}`));
    return { ok: pairing.ok, code: code?.code || null, error: pairing.ok ? '' : pairing.error };
  }

  function stop() {
    if (relay) {
      try {
        relay.disconnect();
      } catch (error) {
        // A relay that is already gone needs nothing from us.
      }
    }
    relay = null;
    code = null;
  }

  async function restore() {
    const stored = loadState() || {};
    if (stored.relayEnabled && stored.relayUrl) {
      return start(stored.relayUrl);
    }
    return { ok: false, skipped: true };
  }

  async function requestCode() {
    if (!relay) return { ok: false, error: 'Turn remote access on first.' };
    const pairing = await relay.startPairing();
    code = pairing.ok ? { code: pairing.code, expiresAt: pairing.expiresAt } : null;
    return pairing;
  }

  return { status, start, stop, restore, requestCode, current: () => relay, currentCode: () => code };
}

module.exports = { createCompanionRelayLifecycle };
