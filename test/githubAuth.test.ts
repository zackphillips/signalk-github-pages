import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/github';
import { deviceFlowError, GitHubAuth, NotSignedInError } from '../src/githubAuth';
import { StateStore } from '../src/state';

/**
 * GitHub's OAuth endpoints, scripted: each poll of the token endpoint takes
 * the next answer off `polls`, and each refresh the next off `refreshes`.
 */
class FakeOAuth {
  polls: Array<Record<string, unknown>> = [];
  refreshes: Array<Record<string, unknown>> = [];
  requests: Array<{ url: string; params: Record<string, string> }> = [];
  deviceCode: Record<string, unknown> = {
    device_code: 'dev-1',
    user_code: 'WDJB-MJHT',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  };
  login = 'zack';
  /** What the API answers for a given token: 200 or 401. */
  validTokens = new Set<string>();

  fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const params = Object.fromEntries(new URLSearchParams(init.body ?? ''));
    this.requests.push({ url, params });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url === 'https://github.com/login/device/code') return json(200, this.deviceCode);
    if (url === 'https://github.com/login/oauth/access_token') {
      const queue = params.grant_type === 'refresh_token' ? this.refreshes : this.polls;
      const next = queue.shift() ?? { error: 'authorization_pending' };
      if (next.access_token) this.validTokens.add(String(next.access_token));
      return json(200, next);
    }
    if (url === 'https://api.github.com/user') return json(200, { login: this.login });
    // Anything else is the Git Data API: answer by whether the token is live.
    const token = String(init.headers?.Authorization ?? '').replace(/^Bearer /, '');
    return this.validTokens.has(token)
      ? json(200, { object: { sha: 'abc' } })
      : json(401, { message: 'Bad credentials' });
  }) as unknown as typeof fetch;

  tokenRequests(grant: string) {
    return this.requests.filter((r) => r.params.grant_type === grant);
  }
}

describe('GitHubAuth', () => {
  let dir: string;
  let store: StateStore;
  let oauth: FakeOAuth;
  let clock: number;
  let slept: number[];

  const makeAuth = (overrides: Partial<ConstructorParameters<typeof GitHubAuth>[0]> = {}) =>
    new GitHubAuth({
      store,
      clientId: 'Iv1.test',
      fetchImpl: oauth.fetch,
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      ...overrides,
    });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghauth-'));
    store = new StateStore(dir);
    oauth = new FakeOAuth();
    clock = Date.parse('2026-09-23T12:00:00Z');
    slept = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('says it is unavailable when this build has no app, rather than offering a button', async () => {
    const auth = makeAuth({ clientId: '' });
    expect((await auth.status()).state).toBe('unavailable');
    expect((await auth.startDeviceFlow()).state).toBe('unavailable');
    expect(oauth.requests).toHaveLength(0);
  });

  it('shows the code, polls until it is entered, and stores the grant', async () => {
    oauth.polls = [
      { error: 'authorization_pending' },
      { access_token: 'ghu_live', token_type: 'bearer' },
    ];
    let signedIn = 0;
    const auth = makeAuth({ onSignedIn: async () => void signedIn++ });

    const started = await auth.startDeviceFlow();
    expect(started).toMatchObject({ state: 'pending', userCode: 'WDJB-MJHT' });
    await auth.settled();

    const status = await auth.status();
    expect(status).toMatchObject({ state: 'signed-in', login: 'zack', rejected: false });
    expect(await auth.token()).toBe('ghu_live');
    expect(signedIn).toBe(1);
    // The device code went only to GitHub, with the grant type the RFC names.
    expect(oauth.tokenRequests('urn:ietf:params:oauth:grant-type:device_code')[0]!.params)
      .toEqual({
        client_id: 'Iv1.test',
        device_code: 'dev-1',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    // At GitHub's interval, not faster.
    expect(slept.every((ms) => ms === 5000)).toBe(true);
  });

  it('never puts a credential in what the console is told', async () => {
    oauth.polls = [{ access_token: 'ghu_secret', refresh_token: 'ghr_secret', expires_in: 28800 }];
    const auth = makeAuth();
    await auth.startDeviceFlow();
    await auth.settled();
    const text = JSON.stringify(await auth.status());
    expect(text).not.toContain('ghu_secret');
    expect(text).not.toContain('ghr_secret');
    expect(text).not.toContain('dev-1');
  });

  it('keeps the grant in a file only this user can read', async () => {
    oauth.polls = [{ access_token: 'ghu_live' }];
    const auth = makeAuth();
    await auth.startDeviceFlow();
    await auth.settled();
    const stat = await fs.stat(path.join(dir, 'github-auth.json'));
    expect(stat.mode & 0o777).toBe(0o600);
    // And a restart reads it back.
    expect(await makeAuth().token()).toBe('ghu_live');
  });

  it('backs off when GitHub says slow_down', async () => {
    oauth.polls = [{ error: 'slow_down', interval: 10 }, { access_token: 'ghu_live' }];
    const auth = makeAuth();
    await auth.startDeviceFlow();
    await auth.settled();
    expect(slept).toEqual([5000, 10000]);
  });

  it('gives a refused sign-in back as words, and stays signed out', async () => {
    oauth.polls = [{ error: 'access_denied' }];
    const auth = makeAuth();
    await auth.startDeviceFlow();
    await auth.settled();
    expect(await auth.status()).toEqual({
      state: 'signed-out',
      detail: 'The sign-in was cancelled on GitHub.',
    });
    await expect(auth.token()).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('stops polling when the code expires', async () => {
    oauth.deviceCode.expires_in = 12;
    const auth = makeAuth();
    await auth.startDeviceFlow();
    await auth.settled();
    expect((await auth.status()).state).toBe('signed-out');
    expect(oauth.tokenRequests('urn:ietf:params:oauth:grant-type:device_code').length).toBe(2);
  });

  it('keeps polling through a dropped connection', async () => {
    let failures = 1;
    const flaky = (async (input: any, init: any) => {
      if (String(input).endsWith('/access_token') && failures-- > 0) {
        throw new TypeError('fetch failed');
      }
      return oauth.fetch(input, init);
    }) as unknown as typeof fetch;
    oauth.polls = [{ access_token: 'ghu_live' }];
    const auth = makeAuth({ fetchImpl: flaky });
    await auth.startDeviceFlow();
    await auth.settled();
    expect((await auth.status()).state).toBe('signed-in');
  });

  it('returns the code already on screen when the button is pressed twice', async () => {
    const auth = makeAuth();
    oauth.polls = [];
    const first = await auth.startDeviceFlow();
    oauth.deviceCode = { ...oauth.deviceCode, user_code: 'OTHER-CODE', device_code: 'dev-2' };
    expect(await auth.startDeviceFlow()).toEqual(first);
    await auth.signOut();
    await auth.settled();
  });

  it('says what to do about device flow being switched off for the app', () => {
    expect(deviceFlowError('device_flow_disabled')).toContain('Enable Device Flow');
  });

  describe('with expiring tokens', () => {
    const signIn = async (auth: GitHubAuth) => {
      oauth.polls = [
        {
          access_token: 'ghu_1',
          refresh_token: 'ghr_1',
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        },
      ];
      await auth.startDeviceFlow();
      await auth.settled();
    };

    it('refreshes shortly before expiry, and puts the new pair on disk first', async () => {
      const auth = makeAuth();
      await signIn(auth);
      expect(await auth.token()).toBe('ghu_1');

      clock += 8 * 3600_000 - 60_000; // a minute before the eight hours are up
      oauth.refreshes = [
        { access_token: 'ghu_2', refresh_token: 'ghr_2', expires_in: 28800, refresh_token_expires_in: 15897600 },
      ];
      expect(await auth.token()).toBe('ghu_2');
      expect(oauth.tokenRequests('refresh_token')[0]!.params).toEqual({
        client_id: 'Iv1.test',
        grant_type: 'refresh_token',
        refresh_token: 'ghr_1',
      });
      // No client secret anywhere: a device-flow token refreshes without one.
      expect(JSON.stringify(oauth.requests)).not.toContain('client_secret');
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'github-auth.json'), 'utf-8'));
      expect(onDisk).toMatchObject({ accessToken: 'ghu_2', refreshToken: 'ghr_2', login: 'zack' });
    });

    it('spends a refresh token once, however many requests want a token at the same time', async () => {
      const auth = makeAuth();
      await signIn(auth);
      clock += 9 * 3600_000;
      oauth.refreshes = [
        { access_token: 'ghu_2', refresh_token: 'ghr_2', expires_in: 28800 },
        // A second refresh would spend ghr_1 again, and GitHub would refuse it.
        { error: 'bad_refresh_token' },
      ];
      const tokens = await Promise.all([auth.token(), auth.token(), auth.token()]);
      expect(tokens).toEqual(['ghu_2', 'ghu_2', 'ghu_2']);
      expect(oauth.tokenRequests('refresh_token')).toHaveLength(1);
    });

    it('keeps the grant when the refresh cannot reach GitHub', async () => {
      const auth = makeAuth();
      await signIn(auth);
      clock += 9 * 3600_000;
      const offline = makeAuth({
        fetchImpl: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      });
      await expect(offline.token()).rejects.toThrow('fetch failed');
      expect((await offline.status()).state).toBe('signed-in');
      // Back in range, the same refresh token still works.
      oauth.refreshes = [{ access_token: 'ghu_2', refresh_token: 'ghr_2', expires_in: 28800 }];
      expect(await makeAuth().token()).toBe('ghu_2');
    });

    it('signs out, and says why, when GitHub will not renew it', async () => {
      const auth = makeAuth();
      await signIn(auth);
      clock += 9 * 3600_000;
      oauth.refreshes = [{ error: 'bad_refresh_token' }];
      await expect(auth.token()).rejects.toBeInstanceOf(NotSignedInError);
      const status = await auth.status();
      expect(status.state).toBe('signed-out');
      expect(status.state === 'signed-out' && status.detail).toMatch(/lapsed/);
      await expect(fs.access(path.join(dir, 'github-auth.json'))).rejects.toThrow();
    });

    it('refreshes and retries once when GitHub refuses a token the clock thought was fine', async () => {
      const auth = makeAuth();
      await signIn(auth);
      // The Pi's clock is behind: by it, ghu_1 has hours left. GitHub disagrees.
      oauth.validTokens.delete('ghu_1');
      oauth.refreshes = [{ access_token: 'ghu_2', refresh_token: 'ghr_2', expires_in: 28800 }];
      const client = new GitHubClient({
        repo: 'owner/site',
        branch: 'main',
        token: () => auth.token(),
        onUnauthorized: () => auth.onUnauthorized(),
        fetchImpl: oauth.fetch,
      });
      expect(await client.getRef()).toBe('abc');
      expect(client.takeStats().requests).toBe(2);
    });
  });

  it('marks a non-expiring token GitHub refuses as rejected, and does not loop', async () => {
    oauth.polls = [{ access_token: 'ghu_live' }];
    const auth = makeAuth();
    await auth.startDeviceFlow();
    await auth.settled();
    oauth.validTokens.clear();
    const client = new GitHubClient({
      repo: 'owner/site',
      branch: 'main',
      token: () => auth.token(),
      onUnauthorized: () => auth.onUnauthorized(),
      fetchImpl: oauth.fetch,
    });
    await expect(client.getRef()).rejects.toMatchObject({ status: 401 });
    expect(client.takeStats().requests).toBe(1);
    expect(await auth.status()).toMatchObject({ state: 'signed-in', rejected: true });
  });

  it('forgets the sign-in on sign-out', async () => {
    oauth.polls = [{ access_token: 'ghu_live' }];
    const auth = makeAuth();
    await auth.startDeviceFlow();
    await auth.settled();
    await auth.signOut();
    expect((await auth.status()).state).toBe('signed-out');
    expect((await makeAuth().status()).state).toBe('signed-out');
  });
});
