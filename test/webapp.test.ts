import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parsePruneRequest,
  registerRoutes,
  resolveSitePath,
  type Router,
  type WebappDeps,
} from '../src/webapp';
import { makeConfig } from './helpers/config';
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

describe('the preview routes', () => {
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

describe('while the plugin is stopped', () => {
  it('answers 503 to every button', async () => {
    const stopped = fakeRouter();
    registerRoutes(stopped.router, () => null);
    for (const route of ['/publish', '/publish/site']) {
      expect((await stopped.call('post', route)).status, route).toBe(503);
    }
  });
});
