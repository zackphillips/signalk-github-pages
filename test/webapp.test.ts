import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceInputError } from '../src/docsSeed';
import { GitHubClient } from '../src/github';
import { GitHubAuth } from '../src/githubAuth';
import { RepoSetupError } from '../src/repoSetup';
import { Publisher } from '../src/publisher';
import { StateStore } from '../src/state';
import {
  parsePruneRequest,
  readJsonBody,
  registerRoutes,
  resolveSitePath,
  type Router,
  type WebappDeps,
} from '../src/webapp';
import { makeConfig } from './helpers/config';
import { FakeGitHub } from './helpers/fakeGitHub';
const SITE = path.join(__dirname, '..', 'site');

/**
 * A router that records what was registered, in order, and can dispatch to it.
 *
 * Order matters for the preview routes — see the test below — so this keeps
 * the registration sequence rather than a map keyed by path.
 */
function fakeRouter() {
  const routes: Array<{ method: 'get' | 'post'; path: string; handler: any }> = [];
  const router: Router = {
    get: (routePath, handler) => void routes.push({ method: 'get', path: routePath, handler }),
    post: (routePath, handler) => void routes.push({ method: 'post', path: routePath, handler }),
  };

  /** Match the way Express does: in registration order, non-strict slashes. */
  const match = (method: 'get' | 'post', url: string) => {
    const withoutQuery = url.split('?')[0] ?? '';
    return routes.find((route) => {
      if (route.method !== method) return false;
      const pattern = route.path
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/:[A-Za-z]+/g, '[^/]+');
      // Express is not in strict-routing mode: a route without a trailing
      // slash also matches the path with one.
      return new RegExp(`^${pattern}/?$`).test(withoutQuery);
    });
  };

  const call = async (method: 'get' | 'post', url: string, body?: unknown) => {
    const route = match(method, url);
    const sent: any = { status: 200, headers: {} as Record<string, string> };
    const response: any = {
      status: (code: number) => ((sent.status = code), response),
      json: (body: unknown) => void (sent.body = body),
      type: (mime: string) => ((sent.mime = mime), response),
      send: (body: unknown) => void (sent.body = body),
      set: (field: string, value: string) => void (sent.headers[field] = value),
    };
    if (!route) return { ...sent, status: 404, matched: null };
    await route.handler({ params: { 0: '' }, url, body }, response);
    return { ...sent, matched: route.path };
  };

  return { router, routes, call };
}

const deps = (over: Partial<WebappDeps> = {}): WebappDeps =>
  ({
    // A real resolved config, not a stub of one: the preview renders `site/`
    // through the same templating the publisher uses, so it reads the site
    // address and the logo as well as the repository.
    config: makeConfig(),
    store: {} as never,
    publisher: {} as never,
    identity: { name: 'Boat', mmsi: '' },
    siteDir: SITE,
    version: '0.2.0',
    readTree: () => ({}),
    polars: () => ({ csv: '', status: null }),
    passage: () => null,
    repository: () => null,
    checkRepository: async () => {
      throw new Error('not in this test');
    },
    setUpRepository: async () => {
      throw new Error('not in this test');
    },
    publishNow: async () => ({ published: true, files: ['a'], bytes: 10 }),
    log: () => {},
    ...over,
  }) as unknown as WebappDeps;

describe('parsePruneRequest', () => {
  it('reads a day count and the explicit "all"', () => {
    expect(parsePruneRequest('30')).toEqual({ olderThanDays: 30 });
    expect(parsePruneRequest('1')).toEqual({ olderThanDays: 1 });
    expect(parsePruneRequest('all')).toEqual({ olderThanDays: null });
  });

  it('refuses anything else rather than defaulting', () => {
    // Defaulting a typo to "all" would make a mistyped URL the most
    // destructive thing this plugin can do.
    for (const bad of ['', undefined, 'ALL', 'everything', '0', '-5', 'NaN', '7; drop']) {
      expect(() => parsePruneRequest(bad), String(bad)).toThrow(/number of days/);
    }
  });

  it('takes the whole days of a fractional request', () => {
    expect(parsePruneRequest('7.9')).toEqual({ olderThanDays: 7 });
  });
});

describe('resolveSitePath', () => {
  it('serves the index for the directory itself', () => {
    expect(resolveSitePath(SITE, '')).toBe(path.join(SITE, 'index.html'));
    expect(resolveSitePath(SITE, '/')).toBe(path.join(SITE, 'index.html'));
  });

  it('resolves a file inside the site', () => {
    expect(resolveSitePath(SITE, 'assets/app.js')).toBe(path.join(SITE, 'assets', 'app.js'));
  });

  it('refuses to climb out, however it is spelled', () => {
    // This runs inside the navigation server's process: a traversal here
    // reads anything that process can read, ~/.signalk/settings.json included.
    for (const attempt of [
      '../package.json',
      'assets/../../package.json',
      '..%2Fpackage.json',
      '/../../etc/passwd',
      'assets/%2e%2e/%2e%2e/package.json',
    ]) {
      expect(resolveSitePath(SITE, attempt), attempt).toBeNull();
    }
  });

  it('drops the query string before resolving', () => {
    expect(resolveSitePath(SITE, 'assets/app.js?t=123')).toBe(
      path.join(SITE, 'assets', 'app.js'),
    );
  });
});

describe('readJsonBody', () => {
  it('takes the body Signal K already parsed', () => {
    expect(readJsonBody({ body: { title: 'Oil change' } })).toEqual({ title: 'Oil change' });
  });

  it('parses a body that arrived as text or as a buffer', () => {
    expect(readJsonBody({ body: '{"title":"Oil change"}' })).toEqual({ title: 'Oil change' });
    expect(readJsonBody({ body: Buffer.from('{"title":"Oil change"}') })).toEqual({
      title: 'Oil change',
    });
  });

  it('says so when no body arrived, rather than blaming the form', () => {
    // Without this, a server that does not parse JSON bodies reports "a
    // maintenance entry needs a title" over a form that plainly has one.
    for (const request of [{}, { body: undefined }, { body: '' }, { body: 'not json' }]) {
      expect(() => readJsonBody(request), JSON.stringify(request)).toThrow(
        MaintenanceInputError,
      );
    }
  });
});
describe('the preview routes', () => {
  it('answers the sign-in routes while the plugin is stopped', async () => {
    // A fresh install is stopped until it has an owner, and signing in first
    // must still work. Every other route says 503.
    const { router, call } = fakeRouter();
    const auth = new GitHubAuth({ store: { readText: async () => null } as never, clientId: '' });
    registerRoutes(router, () => null, () => auth);
    const result = await call('get', '/auth');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ state: 'unavailable', publishingWith: null, repo: null });
    expect((await call('get', '/status')).status).toBe(503);
  });

  it('says which credential the running plugin publishes with', async () => {
    const { router, call } = fakeRouter();
    const auth = new GitHubAuth({ store: { readText: async () => null } as never, clientId: 'Iv1.x' });
    registerRoutes(router, () => deps(), () => auth);
    const result = await call('get', '/auth');
    expect(result.body).toMatchObject({
      state: 'signed-out',
      publishingWith: 'token',
      installUrl: 'https://github.com/apps/signalk-github-pages/installations/new',
    });
  });

  it('answers a refused repository setup with the links that do it by hand', async () => {
    const { router, call } = fakeRouter();
    const links = { create: 'https://github.com/new?name=site' };
    registerRoutes(router, () =>
      deps({
        setUpRepository: async () => {
          throw new RepoSetupError('GitHub would not let the app create owner/site (HTTP 403).', links);
        },
      }),
    );
    const result = await call('post', '/repo/setup');
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'GitHub would not let the app create owner/site (HTTP 403).',
      links,
    });
  });

  it('serves the site for /preview/ rather than redirecting to itself', async () => {
    // Express does not run in strict-routing mode, so `/preview` also matches
    // `/preview/`. Registered first, it answered `/preview/` with a redirect
    // to `preview/`, the browser resolved that against `/preview/` to get
    // `/preview/preview/`, and the console's iframe showed "Not found".
    const { router, call } = fakeRouter();
    registerRoutes(router, () => deps());
    const result = await call('get', '/preview/');
    expect(result.matched).toBe('/preview/*');
    expect(result.status).toBe(200);
  });

  it('still redirects the bare path, which needs the trailing slash', async () => {
    const { router, call } = fakeRouter();
    registerRoutes(router, () => deps());
    const result = await call('get', '/preview');
    expect(result.matched).toBe('/preview');
    expect(result.status).toBe(302);
    expect(result.headers.Location).toBe('preview/');
  });

  it('registers the wildcard before the bare path, which is what makes that work', () => {
    const { router, routes } = fakeRouter();
    registerRoutes(router, () => deps());
    const paths = routes.map((route) => route.path);
    expect(paths.indexOf('/preview/*')).toBeLessThan(paths.indexOf('/preview'));
  });
});

describe('publishing on request', () => {
  it('runs a cycle for POST /publish and reports what it did', async () => {
    const publishNow = vi.fn(async () => ({
      published: true,
      files: ['data/telemetry/signalk_latest.json'],
      bytes: 2048,
      commitSha: 'abc1234',
    }));
    const { router, call } = fakeRouter();
    registerRoutes(router, () => deps({ publishNow }));
    const result = await call('post', '/publish');
    expect(publishNow).toHaveBeenCalledOnce();
    expect(result.body).toMatchObject({ published: true, commitSha: 'abc1234' });
  });

  it('forces the frontend to be rewritten before publishing, for /publish/site', async () => {
    const order: string[] = [];
    const forceFrontendRepublish = vi.fn(async () => void order.push('force'));
    const publishNow = vi.fn(async () => {
      order.push('publish');
      return { published: true, files: [], bytes: 0 };
    });
    const { router, call } = fakeRouter();
    registerRoutes(router, () =>
      deps({ publishNow, publisher: { forceFrontendRepublish } as never }),
    );
    await call('post', '/publish/site');
    // The other way round would publish the old frontend and only rewrite it
    // on the *next* cycle, which is not what the button says.
    expect(order).toEqual(['force', 'publish']);
  });

  it('answers 503 rather than throwing when the plugin is stopped', async () => {
    const { router, call } = fakeRouter();
    registerRoutes(router, () => null);
    expect((await call('post', '/publish')).status).toBe(503);
  });

  it('keeps every GET free of side effects', () => {
    // A phone left on the preview page must not roll the publisher forward.
    // Publishing is a POST for that reason; this pins it.
    const { router, routes } = fakeRouter();
    registerRoutes(router, () => deps());
    const mutating = routes.filter((route) => /publish|prune/.test(route.path));
    for (const route of mutating.filter((r) => r.method === 'get')) {
      expect(route.path, `${route.path} must not mutate`).toMatch(/^\/prune\//);
    }
    expect(routes.some((r) => r.method === 'post' && r.path === '/publish')).toBe(true);
  });
});

/**
 * The docs routes, driven the way Signal K drives them.
 *
 * A real publisher over the in-memory GitHub, because the thing worth pinning
 * down is the status code each outcome gets: that is what the console page
 * reads to tell "already initialized" from "something went wrong".
 */
describe('the docs routes', () => {
  let dataDir: string;
  let fake: FakeGitHub;
  let router: ReturnType<typeof fakeRouter>;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skgp-routes-'));
    fake = new FakeGitHub({
      repo: 'owner/site',
      branch: 'main',
      files: { 'README.md': '# Site\n' },
    });
    const config = makeConfig({ timezone: { override: true, zone: 'America/Los_Angeles' } });
    const store = new StateStore(dataDir);
    const publisher = new Publisher({
      client: new GitHubClient({
        repo: 'owner/site',
        branch: 'main',
        token: 'token',
        fetchImpl: fake.fetch,
      }),
      store,
      config,
      identity: { name: 'S.V.Mermug', mmsi: '338543654' },
      siteDir: SITE,
      seedDir: path.join(__dirname, '..', 'seed'),
      version: '0.1.0',
      log: () => {},
    });

    router = fakeRouter();
    registerRoutes(router.router, () =>
      deps({
        config: config as never,
        store,
        publisher,
        readTree: () => ({ propulsion: { main: { runTime: { value: 4_336_200 } } } }) as never,
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('reports an empty docs directory, with the form values the page needs', async () => {
    const result = await router.call('get', '/docs');
    expect(result.body.initialized).toBe(false);
    expect(result.body.missing).toEqual(['docs/AGENTS.md', 'docs/ships-docs.md']);
    // The engine-hours box left the form, and its prefill with it.
    expect(result.body.engineHours).toBeUndefined();
    expect(result.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.body.docsUrl).toBe('https://owner.github.io/site/docs.html');
  });

  it('initializes once, and a second press writes nothing', async () => {
    expect((await router.call('post', '/docs/init')).body.created).toEqual([
      'docs/AGENTS.md',
      'docs/ships-docs.md',
    ]);

    const second = await router.call('post', '/docs/init');
    expect(second.body.created).toEqual([]);
    expect(second.body.skipped).toEqual(['docs/AGENTS.md', 'docs/ships-docs.md']);
    expect((await router.call('get', '/docs')).body.canInitialize).toBe(false);
  });

  it('answers 409, not 500, over documents the boat already has', async () => {
    fake.commitFile('docs/mob.md', '# Man Overboard\n');
    const result = await router.call('post', '/docs/init');
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/already in docs/);
  });

  it('adds a maintenance entry and answers 201', async () => {
    const result = await router.call('post', '/docs/maintenance', {
      title: 'Replaced the impeller',
      date: '2026-03-01',
      engineHours: 1204.5,
    });
    expect(result.status).toBe(201);
    expect(result.body.created).toBe(true);
    expect(fake.files.get('docs/maintenance/log.md')).toContain(
      '## 2026-03-01: Replaced the impeller',
    );
  });

  it('answers 400 for a form the plugin cannot use, and writes nothing', async () => {
    const before = fake.commits.length;
    const result = await router.call('post', '/docs/maintenance', { title: '  ' });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/needs a title/);
    expect(fake.commits.length).toBe(before);
  });

  it('answers 503 while the plugin is stopped', async () => {
    const stopped = fakeRouter();
    registerRoutes(stopped.router, () => null);
    expect((await stopped.call('post', '/docs/init')).status).toBe(503);
  });
});