const { createCompanionRelayLifecycle } = require('./companionRelayLifecycle');

function makeRelay(overrides = {}) {
  const handlers = {};
  const relay = {
    status: jest.fn(() => ({ connected: false })),
    on: jest.fn((event, handler) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
      return () => {};
    }),
    emit: (event, payload) => (handlers[event] || []).forEach((handler) => handler(payload)),
    ensureRegistered: jest.fn(async () => ({ ok: true })),
    startPairing: jest.fn(async () => ({ ok: true, code: '123456', expiresAt: 1000 })),
    connect: jest.fn(async () => ({ ok: true })),
    disconnect: jest.fn(),
    ...overrides,
  };
  return { relay, handlers };
}

describe('companionRelayLifecycle', () => {
  it('starts a relay for a valid https address', async () => {
    const { relay } = makeRelay();
    const saveState = jest.fn();
    const loadState = jest.fn(() => ({}));
    const createRelay = jest.fn(() => relay);
    const lifecycle = createCompanionRelayLifecycle({ loadState, saveState, createRelay });
    const result = await lifecycle.start('https://relay.example/');
    expect(createRelay).toHaveBeenCalled();
    expect(relay.ensureRegistered).toHaveBeenCalled();
    expect(relay.startPairing).toHaveBeenCalled();
    expect(relay.connect).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, code: '123456' });
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ relayUrl: 'https://relay.example', relayEnabled: true }));
  });

  it('rejects an address that is not http(s)', async () => {
    const { relay } = makeRelay();
    const createRelay = jest.fn(() => relay);
    const lifecycle = createCompanionRelayLifecycle({ createRelay });
    const result = await lifecycle.start('not-a-url');
    expect(result.ok).toBe(false);
    expect(createRelay).not.toHaveBeenCalled();
  });

  it('stops and clears the current relay', async () => {
    const { relay } = makeRelay();
    const lifecycle = createCompanionRelayLifecycle({ createRelay: () => relay });
    await lifecycle.start('https://relay.example');
    lifecycle.stop();
    expect(relay.disconnect).toHaveBeenCalled();
    expect(lifecycle.current()).toBeNull();
    expect(lifecycle.currentCode()).toBeNull();
    expect(lifecycle.status().connected).toBe(false);
  });

  it('restores only when previously enabled', async () => {
    const { relay } = makeRelay();
    const createRelay = jest.fn(() => relay);
    const disabled = createCompanionRelayLifecycle({ loadState: () => ({ relayEnabled: false }), createRelay });
    expect((await disabled.restore()).skipped).toBe(true);
    expect(createRelay).not.toHaveBeenCalled();

    const enabled = createCompanionRelayLifecycle({ loadState: () => ({ relayEnabled: true, relayUrl: 'https://relay.example' }), createRelay });
    const result = await enabled.restore();
    expect(createRelay).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('stops and disables on the unauthorised (401) path', async () => {
    const { relay, handlers } = makeRelay();
    const saveState = jest.fn();
    const lifecycle = createCompanionRelayLifecycle({ loadState: () => ({}), saveState, createRelay: () => relay });
    await lifecycle.start('https://relay.example');
    // Trigger the 401 path the way the client does.
    (handlers.unauthorised || []).forEach((handler) => handler({ error: 'gone' }));
    expect(relay.disconnect).toHaveBeenCalled();
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ relayEnabled: false }));
    expect(lifecycle.current()).toBeNull();
  });

  it('reports status from stored state', () => {
    const lifecycle = createCompanionRelayLifecycle({ loadState: () => ({ relayEnabled: true, relayUrl: 'https://relay.example', relayError: 'boom' }) });
    expect(lifecycle.status()).toMatchObject({ enabled: true, address: 'https://relay.example', error: 'boom' });
  });
});