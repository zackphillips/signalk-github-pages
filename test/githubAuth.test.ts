import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_FILE,
  APP_SLUG_ENV,
  CLIENT_ID_ENV,
  GitHubLogin,
  githubApp,
  installUrl,
  readSignedInSync,
} from '../src/githubAuth';
import { StateStore } from '../src/state';

const APP = { clientId: 'Iv1.test', slug: 'tracker-test' };

/**
 * GitHub's three endpoints, answered from a script: the device code once,
 * then each poll of the token endpoint takes the next answer in the queue.
 */
function fakeGitHub(tokenAnswers: Array<Record<string, unknown> | Error>, login = 'zack') {
  const calls: Array<{ url: string; body: string; auth?: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, body: String(init.body ?? ''), auth: headers.Authorization });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/login/device/code')) {
      return json({
        device_code: 'device-123',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.endsWith('/login/oauth/access_token')) {
      const next = tokenAnswers.shift() ?? { error: 'authorization_pending' };
      if (next instanceof Error) throw next;
      return json(next);
    }
    if (url === 'https://api.github.com/user') return json({ login });
    return json({ message: 'Not Found' }, 404);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-'));
  return { dir, store: new StateStore(dir) };
}

function makeLogin(
  store: StateStore,
  fetchImpl: typeof fetch,
  over: Partial<ConstructorParameters<typeof GitHubLogin>[0]> = {},
) {
  const sleeps: number[] = [];
  const onChange = vi.fn();
  const login = new GitHubLogin({
    store,
    app: APP,
    userAgent: 'test',
    onChange,
    log: () => undefined,
    fetchImpl,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  return { login, onChange, sleeps };
}

describe('GitHubLogin', () => {
  it('shows the code, polls until approved, and keeps the token where only the plugin reads it', async () => {
    const { dir, store } = await tempStore();
    const github = fakeGitHub([
      { error: 'authorization_pending' },
      { error: 'slow_down', interval: 10 },
      { access_token: 'ghu_secret', token_type: 'bearer' },
    ]);
    const { login, onChange, sleeps } = makeLogin(store, github.fetchImpl);

    const started = await login.start();
    expect(started.pending?.userCode).toBe('WXYZ-1234');
    expect(started.pending?.verificationUri).toBe('https://github.com/login/device');
    expect(github.calls[0]!.body).toContain('client_id=Iv1.test');

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    // The interval GitHub gave, then the longer one slow_down asked for.
    expect(sleeps).toEqual([5000, 5000, 10000]);
    const poll = github.calls.find((call) => call.url.endsWith('/access_token'))!;
    expect(poll.body).toContain('device_code=device-123');
    expect(poll.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    expect(poll.body).not.toContain('client_secret');
    expect(github.calls.at(-1)!.auth).toBe('Bearer ghu_secret');

    const described = await login.describe();
    expect(described.account?.login).toBe('zack');
    expect(described.pending).toBeNull();
    expect(JSON.stringify(described)).not.toContain('ghu_secret');

    expect(readSignedInSync(dir)).toMatchObject({ token: 'ghu_secret', login: 'zack' });
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(path.join(dir, ACCOUNT_FILE))).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  it('keeps polling through a dropped connection', async () => {
    const { store } = await tempStore();
    const github = fakeGitHub([new Error('ECONNRESET'), { access_token: 'ghu_ok' }]);
    const { login, onChange } = makeLogin(store, github.fetchImpl);
    await login.start();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect((await login.describe()).account?.login).toBe('zack');
  });

  it.each([
    ['access_denied', 'cancelled'],
    ['expired_token', 'expired'],
    ['device_flow_disabled', 'not enabled'],
  ])('says what %s means and stops', async (code, words) => {
    const { dir, store } = await tempStore();
    const github = fakeGitHub([{ error: code }]);
    const { login, onChange } = makeLogin(store, github.fetchImpl);
    await login.start();
    await vi.waitFor(async () => expect((await login.describe()).error).toContain(words));
    expect((await login.describe()).pending).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(readSignedInSync(dir)).toBeNull();
  });

  it('hands out the same code to a second press while the first is still waiting', async () => {
    const { store } = await tempStore();
    const github = fakeGitHub([]);
    // A poll that never comes back, so the code stays pending.
    const { login } = makeLogin(store, github.fetchImpl, { sleep: () => new Promise(() => undefined) });
    const first = await login.start();
    const second = await login.start();
    expect(second.pending).toEqual(first.pending);
    expect(github.calls.filter((call) => call.url.endsWith('/device/code'))).toHaveLength(1);
  });

  it('notes an expiring token, which the App should never issue', async () => {
    const { dir, store } = await tempStore();
    const github = fakeGitHub([{ access_token: 'ghu_x', expires_in: 28800, refresh_token: 'r' }]);
    const now = new Date('2026-11-13T12:00:00Z');
    const { login, onChange } = makeLogin(store, github.fetchImpl, { now: () => now });
    await login.start();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(readSignedInSync(dir)?.expiresAt).toBe('2026-11-13T20:00:00.000Z');
    // The refresh token is useless without the client secret, so it is not kept.
    expect(await fs.readFile(path.join(dir, ACCOUNT_FILE), 'utf-8')).not.toContain('"r"');
  });

  it('signs out by forgetting the token, and tells the plugin', async () => {
    const { dir, store } = await tempStore();
    await store.writeText(ACCOUNT_FILE, JSON.stringify({ token: 'ghu_a', login: 'zack', signedInAt: '' }));
    const { login, onChange } = makeLogin(store, fakeGitHub([]).fetchImpl);
    expect((await login.describe()).account?.login).toBe('zack');
    const after = await login.signOut();
    expect(after.account).toBeNull();
    expect(readSignedInSync(dir)).toBeNull();
    expect(onChange).toHaveBeenCalledWith(null);
    // Signing out with nobody signed in is not a change.
    await login.signOut();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('abandons a pending sign-in when the person signs out mid-way', async () => {
    const { dir, store } = await tempStore();
    let release: () => void = () => undefined;
    const github = fakeGitHub([{ access_token: 'ghu_late' }]);
    const { login, onChange } = makeLogin(store, github.fetchImpl, {
      sleep: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await login.start();
    await login.signOut();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onChange).not.toHaveBeenCalled();
    expect(readSignedInSync(dir)).toBeNull();
  });

  it('refuses to start without a registered App', async () => {
    const { store } = await tempStore();
    const { login } = makeLogin(store, fakeGitHub([]).fetchImpl, { app: null });
    expect((await login.describe()).available).toBe(false);
    await expect(login.start()).rejects.toThrow('not available');
  });
});

describe('githubApp', () => {
  it('is off with no client ID, and an environment override turns it on', () => {
    expect(githubApp({}, { clientId: '', slug: 's' })).toBeNull();
    expect(githubApp({ [CLIENT_ID_ENV]: 'Iv1.x', [APP_SLUG_ENV]: 'mine' }, { clientId: '', slug: 's' })).toEqual({
      clientId: 'Iv1.x',
      slug: 'mine',
    });
    expect(installUrl(APP)).toBe('https://github.com/apps/tracker-test/installations/new');
  });
});

describe('readSignedInSync', () => {
  it('treats a missing or malformed file as no sign-in', async () => {
    const { dir, store } = await tempStore();
    expect(readSignedInSync(dir)).toBeNull();
    await store.writeText(ACCOUNT_FILE, '{ not json');
    expect(readSignedInSync(dir)).toBeNull();
    await store.writeText(ACCOUNT_FILE, JSON.stringify({ token: 'ghu_a' }));
    expect(readSignedInSync(dir)).toBeNull();
  });
});
