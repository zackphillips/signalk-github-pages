/**
 * Signing in to GitHub from the console, instead of pasting a token.
 *
 * This is the OAuth device flow against a GitHub App. The console asks for a
 * code, the person types it at github.com/login/device on whatever phone is
 * to hand, and the plugin — which has been polling in the background — ends
 * up holding a user access token. There is no redirect and no callback URL,
 * which is what makes it work from a Pi on a boat's wifi that nothing on the
 * internet can reach, and no client secret, which is what makes it possible
 * to ship one app's client ID inside an npm package: the secret is only
 * needed for the web flow, and a refresh of a device-flow token does not ask
 * for it either.
 *
 * The token is narrower than a classic PAT and no wider than a fine-grained
 * one: a GitHub App's user token can do what the app's permissions allow
 * (Contents: read and write), on the repositories the app is installed on,
 * and only where the person signing in could do it themselves.
 *
 * Whether the token expires is the app's setting, not ours, so both are
 * handled. A non-expiring token is stored and used until someone revokes it.
 * An expiring one lasts eight hours and comes with a refresh token good for
 * six months; every refresh invalidates the refresh token it used and issues
 * a new one. That rotation is the dangerous part on a boat. Two requests
 * refreshing at once would spend the same refresh token twice and the second
 * would sign the boat out, so refreshes are serialized. And the new pair is
 * on disk — temp file, fsync, rename — before the new access token is used,
 * so a power cut can lose the sign-in only in the few milliseconds between
 * GitHub answering and the rename.
 *
 * The grant lives in its own file in the plugin data directory, not in the
 * plugin config: the admin UI echoes the config back to any browser that
 * opens the config page, and `state.json` is rewritten on every cycle.
 */
import type { StateStore } from './state';

/**
 * The GitHub App this package signs in with.
 *
 * The client ID is public by design — the device flow is built for clients
 * that cannot keep a secret — so it ships in the package. Empty means this
 * build has no app registered, and the console says so rather than offering
 * a button that cannot work; the personal access token still does.
 */
export const GITHUB_APP = {
  clientId: '',
  /** The app's URL name, for the "install it on your repository" link. */
  slug: 'signalk-github-pages',
};

/** Where the person installs the app on the repository it publishes to. */
export function appInstallUrl(slug: string = GITHUB_APP.slug): string {
  return `https://github.com/apps/${slug}/installations/new`;
}

const GRANT_FILE = 'github-auth.json';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Refresh this long before the access token expires, so a cycle that starts
 * a minute before expiry does not have its last request rejected.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** What is kept on disk. The tokens never leave this module or that file. */
export interface StoredGrant {
  accessToken: string;
  /** Absent when the app issues tokens that do not expire. */
  refreshToken?: string;
  /** ISO time the access token stops working, by this machine's clock. */
  expiresAt?: string;
  /** ISO time the refresh token stops working. */
  refreshExpiresAt?: string;
  /** The GitHub account that signed in, for the console. */
  login?: string;
  signedInAt: string;
}

/** What the console is told. Nothing in here is a credential. */
export type AuthStatus =
  | { state: 'unavailable'; detail: string }
  | { state: 'signed-out'; detail?: string }
  | {
      state: 'pending';
      userCode: string;
      verificationUri: string;
      expiresAt: string;
    }
  | {
      state: 'signed-in';
      login: string | null;
      signedInAt: string;
      /** When the sign-in lapses if the boat never refreshes it. */
      refreshExpiresAt: string | null;
      /** Set once GitHub has turned the token away and no refresh helped. */
      rejected: boolean;
    };

/**
 * Publishing was asked for with nobody signed in.
 *
 * Its own class so the cycle's error message is this sentence rather than a
 * 401 from an empty Authorization header, which would send someone looking
 * for a token they never set.
 */
export class NotSignedInError extends Error {
  constructor(detail?: string) {
    super(
      (detail ? `${detail} ` : '') +
        "Not signed in to GitHub: open the plugin's console (/signalk-github-pages/) " +
        'and sign in, or set a personal access token on the config page.',
    );
    this.name = 'NotSignedInError';
  }
}

/** What GitHub's OAuth endpoints answer with, errors included (as a 200). */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

/**
 * A device-flow error, in words that say what to do.
 *
 * `authorization_pending` and `slow_down` are not here: they are the normal
 * answers while the person is still typing, not failures.
 */
export function deviceFlowError(code: string | undefined, description?: string): string {
  switch (code) {
    case 'expired_token':
      return 'The code expired before it was entered on GitHub. Start again.';
    case 'access_denied':
      return 'The sign-in was cancelled on GitHub.';
    case 'device_flow_disabled':
      return (
        'Device flow is turned off for this GitHub App. Its owner needs to tick ' +
        '"Enable Device Flow" in the app settings.'
      );
    case 'incorrect_client_credentials':
      return 'GitHub does not recognize this app\'s client ID.';
    case 'unsupported_grant_type':
    case 'incorrect_device_code':
      return `GitHub refused the sign-in (${code}). Start again.`;
    default:
      return `GitHub refused the sign-in: ${description || code || 'no reason given'}.`;
  }
}

export interface GitHubAuthOptions {
  store: Pick<StateStore, 'readText' | 'writeText' | 'remove'>;
  clientId: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
  now?: () => Date;
  /**
   * Waits between polls. Injected so a test can run the whole flow without
   * sitting through GitHub's five-second interval.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Run once after a sign-in lands, to look at the repository and publish. */
  onSignedIn?: () => Promise<void>;
}

interface PendingFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
  cancelled: boolean;
}

export class GitHubAuth {
  private readonly store: GitHubAuthOptions['store'];
  private readonly clientId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private onSignedIn: (() => Promise<void>) | undefined;

  /** Undefined until read from disk; null once read and found empty. */
  private grant: StoredGrant | null | undefined;
  private pending: PendingFlow | null = null;
  /** The poll loop for `pending`, so a test can wait for it to finish. */
  private polling: Promise<void> | null = null;
  private refreshing: Promise<StoredGrant> | null = null;
  private rejected = false;
  /** Why the last flow or refresh ended, for a signed-out console. */
  private lastError: string | undefined;

  constructor(options: GitHubAuthOptions) {
    this.store = options.store;
    this.clientId = options.clientId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? 'signalk-github-pages';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          // Never hold the server open on shutdown for a sign-in nobody
          // finished.
          setTimeout(resolve, ms).unref?.();
        }));
    this.onSignedIn = options.onSignedIn;
  }

  /** Replaced on every plugin start: what to do after a sign-in depends on the config. */
  setOnSignedIn(hook: (() => Promise<void>) | undefined): void {
    this.onSignedIn = hook;
  }

  get available(): boolean {
    return this.clientId !== '';
  }

  private async load(): Promise<StoredGrant | null> {
    if (this.grant !== undefined) return this.grant;
    const raw = await this.store.readText(GRANT_FILE);
    let parsed: StoredGrant | null = null;
    if (raw !== null) {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value.accessToken === 'string' && value.accessToken) parsed = value;
      } catch {
        // A file that will not parse is no sign-in; the console says signed out.
      }
    }
    this.grant = parsed;
    return parsed;
  }

  private async save(grant: StoredGrant | null): Promise<void> {
    if (grant) {
      await this.store.writeText(GRANT_FILE, `${JSON.stringify(grant, null, 2)}\n`, 0o600);
    } else {
      await this.store.remove(GRANT_FILE);
    }
    this.grant = grant;
  }

  async status(): Promise<AuthStatus> {
    if (this.pending && !this.pending.cancelled) {
      return {
        state: 'pending',
        userCode: this.pending.userCode,
        verificationUri: this.pending.verificationUri,
        expiresAt: new Date(this.pending.expiresAt).toISOString(),
      };
    }
    const grant = await this.load();
    if (grant) {
      return {
        state: 'signed-in',
        login: grant.login ?? null,
        signedInAt: grant.signedInAt,
        refreshExpiresAt: grant.refreshExpiresAt ?? null,
        rejected: this.rejected,
      };
    }
    if (!this.available) {
      return {
        state: 'unavailable',
        detail:
          'This build of the plugin has no GitHub App to sign in with. Use a personal ' +
          'access token on the config page.',
      };
    }
    return this.lastError ? { state: 'signed-out', detail: this.lastError } : { state: 'signed-out' };
  }

  /** True when a sign-in is stored, whether or not GitHub still honors it. */
  async signedIn(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  private async post<T>(url: string, params: Record<string, string>): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        // Without it GitHub answers form-encoded.
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`GitHub answered ${response.status} with something that is not JSON.`);
    }
    // The OAuth endpoints report their own errors in a 200 body; anything else
    // without an `error` field is a transport problem worth its status.
    if (!response.ok && !body?.error) {
      throw new Error(`GitHub answered ${response.status} ${response.statusText}.`);
    }
    return body as T;
  }

  /**
   * Ask GitHub for a code and start polling for the person to enter it.
   *
   * A flow already in progress is returned rather than replaced: the code on
   * the screen is the one someone may be typing, and a second press of the
   * button must not quietly invalidate it.
   */
  async startDeviceFlow(): Promise<AuthStatus> {
    if (!this.available) return this.status();
    if (this.pending && !this.pending.cancelled && this.pending.expiresAt > this.now().getTime()) {
      return this.status();
    }
    const body = await this.post<DeviceCodeResponse>(DEVICE_CODE_URL, {
      client_id: this.clientId,
    });
    if (!body.device_code || !body.user_code) {
      throw new Error(deviceFlowError(body.error, body.error_description));
    }
    this.lastError = undefined;
    const flow: PendingFlow = {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri || 'https://github.com/login/device',
      expiresAt: this.now().getTime() + (body.expires_in ?? 900) * 1000,
      intervalMs: Math.max(1, body.interval ?? 5) * 1000,
      cancelled: false,
    };
    this.pending = flow;
    this.log(`Waiting for code ${flow.userCode} to be entered at ${flow.verificationUri}.`);
    this.polling = this.poll(flow).catch((error: any) => {
      // A disk that would not take the grant, say: the flow is over either
      // way, and the console must not show a code that can no longer work.
      if (this.pending === flow) this.pending = null;
      this.lastError = `Sign-in failed: ${error?.message ?? error}`;
      this.log(this.lastError);
    });
    return this.status();
  }

  /** The poll loop, for tests that need the flow to have finished. */
  async settled(): Promise<void> {
    await this.polling;
  }

  private async poll(flow: PendingFlow): Promise<void> {
    const finish = (error?: string) => {
      if (this.pending === flow) this.pending = null;
      if (error) this.lastError = error;
    };
    while (!flow.cancelled) {
      await this.sleep(flow.intervalMs);
      if (flow.cancelled) return;
      if (this.now().getTime() >= flow.expiresAt) {
        finish(deviceFlowError('expired_token'));
        return;
      }
      let body: TokenResponse;
      try {
        body = await this.post<TokenResponse>(TOKEN_URL, {
          client_id: this.clientId,
          device_code: flow.deviceCode,
          grant_type: DEVICE_GRANT,
        });
      } catch (error: any) {
        // A dropped hotspot is not a failed sign-in: keep polling until the
        // code expires, which GitHub will say in words.
        this.log(`Sign-in poll failed, trying again: ${error?.message ?? error}`);
        continue;
      }
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') {
        // GitHub sends the interval it wants; RFC 8628 says five more seconds
        // when it does not.
        flow.intervalMs = body.interval ? body.interval * 1000 : flow.intervalMs + 5000;
        continue;
      }
      if (body.error || !body.access_token) {
        finish(deviceFlowError(body.error, body.error_description));
        return;
      }
      if (flow.cancelled) return;
      const grant = this.grantFrom(body);
      grant.login = await this.whoAmI(grant.accessToken);
      await this.save(grant);
      this.rejected = false;
      finish();
      this.log(`Signed in to GitHub${grant.login ? ` as ${grant.login}` : ''}.`);
      try {
        await this.onSignedIn?.();
      } catch (error: any) {
        this.log(`After signing in: ${error?.message ?? error}`);
      }
      return;
    }
  }

  private grantFrom(body: TokenResponse, previous?: StoredGrant): StoredGrant {
    const now = this.now().getTime();
    return {
      accessToken: body.access_token!,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      ...(body.expires_in ? { expiresAt: new Date(now + body.expires_in * 1000).toISOString() } : {}),
      ...(body.refresh_token_expires_in
        ? { refreshExpiresAt: new Date(now + body.refresh_token_expires_in * 1000).toISOString() }
        : {}),
      ...(previous?.login ? { login: previous.login } : {}),
      signedInAt: previous?.signedInAt ?? new Date(now).toISOString(),
    };
  }

  /** The account name, for the console. Not knowing it costs a label. */
  private async whoAmI(token: string): Promise<string | undefined> {
    try {
      const response = await this.fetchImpl('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.userAgent,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { login?: unknown };
      return typeof body.login === 'string' ? body.login : undefined;
    } catch {
      return undefined;
    }
  }

  /** Stop a pending flow and forget the stored sign-in. */
  async signOut(): Promise<void> {
    if (this.pending) this.pending.cancelled = true;
    this.pending = null;
    this.rejected = false;
    this.lastError = undefined;
    await this.save(null);
    this.log('Signed out of GitHub.');
  }

  /**
   * The access token to send, refreshed first when it is about to lapse.
   *
   * By this machine's clock, which on a Pi without a working RTC can be
   * wrong after a reboot at sea. `onUnauthorized` is the backstop: a token
   * the clock thought was fine and GitHub did not is refreshed and the
   * request retried once.
   */
  async token(): Promise<string> {
    const grant = await this.load();
    if (!grant) throw new NotSignedInError(this.lastError);
    if (grant.expiresAt && grant.refreshToken) {
      const expires = Date.parse(grant.expiresAt);
      if (!Number.isFinite(expires) || this.now().getTime() >= expires - REFRESH_MARGIN_MS) {
        return (await this.refresh()).accessToken;
      }
    }
    return grant.accessToken;
  }

  /**
   * GitHub turned a request away with a 401. Refresh and say whether to
   * retry, or record that the sign-in is dead.
   */
  async onUnauthorized(): Promise<boolean> {
    const grant = await this.load();
    if (grant?.refreshToken) {
      try {
        await this.refresh();
        return true;
      } catch {
        // `refresh` has already recorded why.
      }
    }
    this.rejected = true;
    return false;
  }

  /** One refresh at a time: the second caller waits for the first's result. */
  private refresh(): Promise<StoredGrant> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<StoredGrant> {
    const grant = await this.load();
    if (!grant) throw new NotSignedInError(this.lastError);
    if (!grant.refreshToken) return grant;
    // Network failures propagate with the grant intact: the refresh token has
    // not been spent, and the next cycle tries again.
    const body = await this.post<TokenResponse>(TOKEN_URL, {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: grant.refreshToken,
    });
    if (body.error || !body.access_token) {
      // GitHub has refused this refresh token for good — spent, expired past
      // its six months, or the app was uninstalled. Keeping it would retry the
      // same refusal every cycle.
      const detail =
        body.error === 'bad_refresh_token'
          ? 'The saved GitHub sign-in has lapsed (it is renewed while the boat publishes, and lasts six months without).'
          : `GitHub would not renew the sign-in: ${body.error_description || body.error || 'no reason given'}.`;
      this.lastError = detail;
      await this.save(null);
      this.log(detail);
      throw new NotSignedInError(detail);
    }
    const next = this.grantFrom(body, grant);
    // On disk before it is used: the old refresh token is already spent.
    await this.save(next);
    this.rejected = false;
    return next;
  }
}
