import {
  COMPANION_SITE_URL,
  connectCodePayload,
  registerCompanionConnectCode,
} from './companionConnectCode';

function companion(overrides = {}) {
  return Object.assign({
    running: true,
    code: '123456',
    web: { enabled: true, url: 'https://desktop-abc.tail1234.ts.net' },
  }, overrides);
}

describe('connect code payload', () => {
  it('sends the six digits with the PC address', () => {
    expect(connectCodePayload(companion())).toEqual({
      code: '123456',
      target: 'https://desktop-abc.tail1234.ts.net',
    });
  });

  it('reduces the address to its origin so a stray path cannot be registered', () => {
    const payload = connectCodePayload(companion({
      web: { enabled: true, url: 'https://desktop-abc.tail1234.ts.net/some/path?x=1' },
    }));
    expect(payload.target).toBe('https://desktop-abc.tail1234.ts.net');
  });

  it('stays quiet when the companion is off, the web address is off, or the code is not six digits', () => {
    expect(connectCodePayload(companion({ running: false }))).toBeNull();
    expect(connectCodePayload(companion({ web: { enabled: false, url: 'https://a.b.ts.net' } }))).toBeNull();
    expect(connectCodePayload(companion({ code: '12' }))).toBeNull();
    expect(connectCodePayload(companion({ code: null }))).toBeNull();
  });

  it('refuses an address a hosted page could never reach', () => {
    expect(connectCodePayload(companion({ web: { enabled: true, url: 'http://192.168.1.20:7878' } }))).toBeNull();
    expect(connectCodePayload(companion({ web: { enabled: true, url: 'https://example.com' } }))).toBeNull();
    expect(connectCodePayload(companion({ web: { enabled: true, url: '' } }))).toBeNull();
  });
});

describe('registering the connect code', () => {
  it('posts the code to the hosted site', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    };
    await expect(registerCompanionConnectCode(companion(), fetchImpl)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${COMPANION_SITE_URL}api/connect-code`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      code: '123456',
      target: 'https://desktop-abc.tail1234.ts.net',
    });
  });

  it('reports failure instead of throwing when the site is unreachable', async () => {
    const fetchImpl = async () => { throw new Error('offline'); };
    await expect(registerCompanionConnectCode(companion(), fetchImpl)).resolves.toBe(false);
  });

  it('does not call the site when there is nothing to register', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true }; };
    await expect(registerCompanionConnectCode(companion({ running: false }), fetchImpl)).resolves.toBe(false);
    expect(called).toBe(false);
  });
});
