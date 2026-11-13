/**
 * Signing in with GitHub, by the OAuth device flow.
 *
 * The web flow does not fit a plugin: it redirects the browser to a callback
 * URL registered in advance, and every boat's server is at a different
 * address, most of them `.local` names nothing outside the boat resolves. It
 * also needs a client secret, which an npm package cannot keep. The device
 * flow needs neither. The plugin asks GitHub for a code, the console shows it,
 * the person enters it at github.com/login/device on any device, and the
 * plugin polls until GitHub hands it a token. The only thing shipped is the
 * App's client ID, which is public by design.
 *
 * It is a GitHub App rather than an OAuth App because of what the token can
 * reach. An OAuth App's only usable scope is `repo` (or `public_repo`): every
 * repository the person can push to. A GitHub App's user token reaches only
 * the repositories the App is installed on, with only the permissions the App
 * asks for (Contents: read and write), which is the fine-grained token the
 * README asks for, made in two clicks instead of a form.
 *
 * The App is registered with "Expire user authorization tokens" turned off.
 * Refreshing a user token takes the client secret, which this cannot hold, so
 * an expiring token would end every boat's publishing eight hours after
 * sign-in. A token that does come back with an expiry is kept and used, and
 * the console says when it runs out.
 *
 * Nothing here runs while nobody is signing in: no timer, no request. Polling
 * starts when someone presses the button and ends when GitHub answers, the
 * code expires, or the person signs out. And nothing here hands the token to
 * anything but the plugin: `describe()` is what the console sees, and it
 * carries the login and the code, never the token.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { StateStore } from './state';

/** The App the plugin signs in through. The client ID is public by design. */
export interface GitHubAppIdentity {
  clientId: string;
  /** The App's URL name: github.com/apps/<slug>. */
  slug: string;
}

/**
 * The registered App, owned by the plugin's maintainer. An empty client ID
 * turns sign-in off and leaves the personal access token as the only route.
 */
export const GITHUB_APP: GitHubAppIdentity = {
  clientId: 'Iv23ligwOrc5lVnNBIZR',
  slug: 'signalk-github-pages',
};

/** Overrides for testing against an App of one's own. */
export const CLIENT_ID_ENV = 'SIGNALK_GITHUB_PAGES_CLIENT_ID';
export const APP_SLUG_ENV = 'SIGNALK_GITHUB_PAGES_APP_SLUG';

/** The App to sign in through, or null when sign-in is not available. */
export function githubApp(
  env: Record<string, string | undefined> = process.env,
  builtIn: GitHubAppIdentity = GITHUB_APP,
): GitHubAppIdentity | null {
  const clientId = (env[CLIENT_ID_ENV] ?? '').trim() || builtIn.clientId;
  const slug = (env[APP_SLUG_ENV] ?? '').trim() || builtIn.slug;
  return clientId ? { clientId, slug } : null;
}

/** Where a person installs the App on a repository, choosing which one. */
export function installUrl(app: GitHubAppIdentity): string {
  return `https://github.com/apps/${app.slug}/installations/new`;
}

/** Where a person revokes the plugin's access. Revoking takes the secret, so it is theirs to do. */
export const AUTHORIZATIONS_URL = 'https://github.com/settings/apps/authorizations';

/** A completed sign-in, as kept in the data directory. */
export interface SignedInAccount {
  token: string;
  login: string;
  signedInAt: string;
  /** Only when the App hands out expiring tokens, which it should not. */
  expiresAt?: string;
}

/** Relative to the plugin data directory. */
export const ACCOUNT_FILE = path.join('auth', 'github.json');

function parseAccount(raw: unknown): SignedInAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.token !== 'string' || !value.token) return null;
  if (typeof value.login !== 'string' || !value.login) return null;
  return {
    token: value.token,
    login: value.login,
    signedInAt: typeof value.signedInAt === 'string' ? value.signedInAt : '',
    ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
  };
}

/**
 * The saved sign-in, read synchronously, because `start` is synchronous and
 * `resolveConfig` needs the token before anything else happens. A file that
 * is missing or unreadable is no sign-in; the config problem that follows
 * says what to do.
 */
export function readSignedInSync(dataDir: string): SignedInAccount | null {
  try {
    return parseAccount(JSON.parse(readFileSync(path.join(dataDir, ACCOUNT_FILE), 'utf-8')));
  } catch {
    return null;
  }
}

/** A code waiting to be entered. */
export interface PendingSignIn {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

/** What the console is shown. Never the token. */
export interface SignInDescription {
  available: boolean;
  installUrl: string | null;
  authorizationsUrl: string;
  account: { login: string; signedInAt: string; expiresAt?: string } | null;
  pending: PendingSignIn | null;
  error: string | null;
}

export interface GitHubLoginOptions {
  store: Pick<StateStore, 'readJson' | 'writeText' | 'remove'>;
  app: GitHubAppIdentity | null;
  userAgent: string;
  /** Called after a sign-in lands or a sign-out, so the plugin can restart on the new token. */
  onChange: (account: SignedInAccount | null) => void;
  log: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_TIMEOUT_MS = 30_000;
/** RFC 8628: on `slow_down`, add five seconds to the interval. */
const SLOW_DOWN_SECONDS = 5;

/** What each terminal error from the token endpoint means for the person. */
const TOKEN_ERRORS: Record<string, string> = {
  expired_token: 'The code expired before it was entered. Start again for a new one.',
  access_denied: 'Sign-in was cancelled on GitHub.',
  device_flow_disabled: 'Device flow is not enabled on the GitHub App.',
  incorrect_client_credentials: 'GitHub does not recognize this App’s client ID.',
  incorrect_device_code: 'GitHub did not recognize the code. Start again.',
  unsupported_grant_type: 'GitHub refused the device grant.',
};

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class GitHubLogin {
  private account: SignedInAccount | null = null;
  private loaded = false;
  private pending: PendingSignIn | null = null;
  private error: string | null = null;
  /** Bumped by every start and sign-out, so a superseded poll stops quietly. */
  private generation = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly options: GitHubLoginOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? sleepFor;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.account = parseAccount(await this.options.store.readJson<unknown>(ACCOUNT_FILE, null));
    this.loaded = true;
  }

  async describe(): Promise<SignInDescription> {
    await this.load();
    if (this.pending && Date.parse(this.pending.expiresAt) <= this.now().getTime()) {
      this.pending = null;
      this.error ??= TOKEN_ERRORS.expired_token!;
    }
    const app = this.options.app;
    return {
      available: app !== null,
      installUrl: app ? installUrl(app) : null,
      authorizationsUrl: AUTHORIZATIONS_URL,
      account: this.account
        ? {
            login: this.account.login,
            signedInAt: this.account.signedInAt,
            ...(this.account.expiresAt ? { expiresAt: this.account.expiresAt } : {}),
          }
        : null,
      pending: this.pending,
      error: this.error,
    };
  }

  /**
   * Ask GitHub for a code and start polling for the token in the background.
   *
   * A code still waiting to be entered is returned again rather than
   * replaced: two presses of the button, or two phones, must not leave
   * someone typing a code GitHub has already superseded.
   */
  async start(): Promise<SignInDescription> {
    const app = this.options.app;
    if (!app) throw new Error('Sign-in with GitHub is not available in this release.');
    if (this.pending && Date.parse(this.pending.expiresAt) > this.now().getTime()) {
      return this.describe();
    }
    const generation = ++this.generation;
    this.error = null;
    const body = await this.post(DEVICE_CODE_URL, { client_id: app.clientId });
    if (typeof body.error === 'string') {
      throw new Error(TOKEN_ERRORS[body.error] ?? `GitHub refused the sign-in: ${describeError(body)}`);
    }
    const deviceCode = body.device_code;
    const userCode = body.user_code;
    if (typeof deviceCode !== 'string' || typeof userCode !== 'string') {
      throw new Error('GitHub did not return a sign-in code.');
    }
    const expiresIn = positive(body.expires_in, 900);
    this.pending = {
      userCode,
      verificationUri:
        typeof body.verification_uri === 'string' ? body.verification_uri : 'https://github.com/login/device',
      expiresAt: new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
    };
    this.options.log(`GitHub sign-in started; waiting for code ${userCode} to be entered.`);
    void this.poll(generation, app, deviceCode, positive(body.interval, 5)).catch((error: any) => {
      // poll() catches its own failures; this is the belt for the braces,
      // because an unhandled rejection here would reach the server's process.
      if (generation === this.generation) this.fail(`Sign-in failed: ${error?.message ?? error}`);
    });
    return this.describe();
  }

  /**
   * Forget the token. GitHub keeps the authorization until the person
   * revokes it — doing that takes the client secret — which the console
   * links to.
   */
  async signOut(): Promise<SignInDescription> {
    await this.load();
    this.generation += 1;
    this.pending = null;
    this.error = null;
    const had = this.account !== null;
    await this.options.store.remove(ACCOUNT_FILE);
    this.account = null;
    if (had) {
      this.options.log('Signed out of GitHub.');
      this.options.onChange(null);
    }
    return this.describe();
  }

  private async poll(
    generation: number,
    app: GitHubAppIdentity,
    deviceCode: string,
    intervalSeconds: number,
  ): Promise<void> {
    let interval = intervalSeconds;
    while (generation === this.generation && this.pending) {
      await this.sleep(interval * 1000);
      if (generation !== this.generation || !this.pending) return;
      if (Date.parse(this.pending.expiresAt) <= this.now().getTime()) {
        this.fail(TOKEN_ERRORS.expired_token!);
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await this.post(TOKEN_URL, {
          client_id: app.clientId,
          device_code: deviceCode,
          grant_type: DEVICE_GRANT,
        });
      } catch (error: any) {
        // A dropped hotspot is not a failed sign-in. Keep asking until the
        // code expires; GitHub remembers the approval in the meantime.
        this.options.log(`GitHub sign-in poll failed, retrying: ${error?.message ?? error}`);
        continue;
      }
      if (generation !== this.generation) return;
      const code = typeof body.error === 'string' ? body.error : '';
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') {
        interval = positive(body.interval, interval + SLOW_DOWN_SECONDS);
        continue;
      }
      if (code) {
        this.fail(TOKEN_ERRORS[code] ?? `GitHub refused the sign-in: ${describeError(body)}`);
        return;
      }
      if (typeof body.access_token !== 'string' || !body.access_token) {
        this.fail('GitHub answered without a token.');
        return;
      }
      await this.complete(generation, body.access_token, body.expires_in);
      return;
    }
  }

  private async complete(generation: number, token: string, expiresIn: unknown): Promise<void> {
    let login: string;
    try {
      login = await this.readLogin(token);
    } catch (error: any) {
      this.fail(`Signed in, but could not read the GitHub account: ${error?.message ?? error}`);
      return;
    }
    if (generation !== this.generation) return;
    const now = this.now();
    const account: SignedInAccount = {
      token,
      login,
      signedInAt: now.toISOString(),
    };
    if (typeof expiresIn === 'number' && expiresIn > 0) {
      account.expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
      this.options.log(
        `The GitHub App issued a token that expires at ${account.expiresAt}; publishing stops then. ` +
          'The App should have token expiry turned off.',
      );
    }
    // Stored before anything relies on it: a restart that reads the file
    // must find the token the console has just reported.
    await this.options.store.writeText(ACCOUNT_FILE, `${JSON.stringify(account, null, 2)}\n`, {
      mode: 0o600,
    });
    this.account = account;
    this.loaded = true;
    this.pending = null;
    this.error = null;
    this.options.log(`Signed in to GitHub as ${login}.`);
    this.options.onChange(account);
  }

  private fail(message: string): void {
    this.pending = null;
    this.error = message;
    this.options.log(message);
  }

  private async readLogin(token: string): Promise<string> {
    const response = await this.fetchImpl(USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.options.userAgent,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { login?: unknown };
    if (typeof body.login !== 'string' || !body.login) throw new Error('no login in the answer');
    return body.login;
  }

  private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.options.userAgent,
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Handled below: a body that is not JSON is not an answer.
    }
    if (body && typeof body === 'object') return body as Record<string, unknown>;
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function describeError(body: Record<string, unknown>): string {
  return typeof body.error_description === 'string' ? body.error_description : String(body.error);
}
