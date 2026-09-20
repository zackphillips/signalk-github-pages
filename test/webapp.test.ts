import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/github';
import { Publisher } from '../src/publisher';
import { StateStore } from '../src/state';
import { registerRoutes, type Router } from '../src/webapp';
import { makeConfig } from './helpers/config';
import { FakeGitHub } from './helpers/fakeGitHub';
import { MaintenanceInputError } from '../src/docsSeed';
import { pagesUrl, parsePruneRequest, readJsonBody, resolveSitePath } from '../src/webapp';

const SITE = path.join(__dirname, '..', 'site');

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

describe('pagesUrl', () => {
  it('knows a user site from a project site', () => {
    expect(pagesUrl('zackphillips', 'zackphillips.github.io')).toBe(
      'https://zackphillips.github.io/',
    );
    expect(pagesUrl('zackphillips', 'tracker')).toBe('https://zackphillips.github.io/tracker/');
  });

  it('lowercases the host, which GitHub Pages serves in lower case', () => {
    expect(pagesUrl('ZackPhillips', 'Tracker')).toBe('https://zackphillips.github.io/Tracker/');
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

/**
 * The docs routes, driven the way Signal K drives them.
 *
 * A stand-in router and response rather than a running Express: what is
 * actually worth testing here is the status code each outcome gets, because
 * that is what the console page reads to decide between "already initialized"
 * and "something went wrong".
 */
describe('the docs routes', () => {
  let dataDir: string;
  let fake: FakeGitHub;
  let routes: Map<string, (request: any, response: any) => Promise<void> | void>;

  const capture = () => {
    const sent: { status: number; body: any } = { status: 200, body: undefined };
    const response: any = {
      status(code: number) {
        sent.status = code;
        return response;
      },
      json(body: unknown) {
        sent.body = body;
      },
      type() {
        return response;
      },
      send(body: unknown) {
        sent.body = body;
      },
      set() {},
    };
    return { sent, response };
  };

  const call = async (key: string, request: any = { params: {} }) => {
    const { sent, response } = capture();
    await routes.get(key)!(request, response);
    return sent;
  };

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skgp-routes-'));
    fake = new FakeGitHub({
      repo: 'owner/site',
      branch: 'main',
      files: { 'README.md': '# Site\n' },
    });
    const config = makeConfig({ timezone: { override: true, zone: 'America/Los_Angeles' } });
    const publisher = new Publisher({
      client: new GitHubClient({
        repo: 'owner/site',
        branch: 'main',
        token: 'token',
        fetchImpl: fake.fetch,
      }),
      store: new StateStore(dataDir),
      config,
      identity: { name: 'S.V.Mermug', mmsi: '338543654' },
      siteDir: SITE,
      seedDir: path.join(__dirname, '..', 'seed'),
      version: '0.1.0',
      log: () => {},
    });

    routes = new Map();
    const router: Router = {
      get: (routePath, handler) => routes.set(`GET ${routePath}`, handler as any),
      post: (routePath, handler) => routes.set(`POST ${routePath}`, handler as any),
    };
    registerRoutes(router, () => ({
      config,
      store: new StateStore(dataDir),
      publisher,
      identity: { name: 'S.V.Mermug', mmsi: '338543654' },
      siteDir: SITE,
      version: '0.1.0',
      readTree: () => ({ propulsion: { main: { runTime: { value: 4_336_200 } } } }) as any,
      polars: () => ({ csv: '', status: null }),
      log: () => {},
    }));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('reports an empty docs directory, with the form values the page needs', async () => {
    const sent = await call('GET /docs');
    expect(sent.body.initialized).toBe(false);
    expect(sent.body.missing).toEqual(['docs/AGENTS.md', 'docs/ships-docs.md']);
    expect(sent.body.engineHours).toEqual([{ engine: 'main', hours: 1204.5 }]);
    expect(sent.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.body.docsUrl).toBe('https://owner.github.io/site/docs.html');
  });

  it('initializes once, and a second press writes nothing', async () => {
    expect((await call('POST /docs/init')).body.created).toEqual([
      'docs/AGENTS.md',
      'docs/ships-docs.md',
    ]);

    const second = await call('POST /docs/init');
    expect(second.body.created).toEqual([]);
    expect(second.body.skipped).toEqual(['docs/AGENTS.md', 'docs/ships-docs.md']);
    expect((await call('GET /docs')).body.canInitialize).toBe(false);
  });

  it('answers 409, not 500, over documents the boat already has', async () => {
    fake.commitFile('docs/mob.md', '# Man Overboard\n');
    const sent = await call('POST /docs/init');
    expect(sent.status).toBe(409);
    expect(sent.body.error).toMatch(/already in docs/);
  });

  it('adds a maintenance entry and answers 201', async () => {
    const sent = await call('POST /docs/maintenance', {
      params: {},
      body: { title: 'Replaced the impeller', date: '2026-03-01', engineHours: 1204.5 },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.created).toBe(true);
    expect(fake.files.get('docs/maintenance/log.md')).toContain(
      '## 2026-03-01: Replaced the impeller',
    );
  });

  it('answers 400 for a form the plugin cannot use, and writes nothing', async () => {
    const before = fake.commits.length;
    const sent = await call('POST /docs/maintenance', { params: {}, body: { title: '  ' } });
    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/needs a title/);
    expect(fake.commits.length).toBe(before);
  });

  it('answers 503 while the plugin is stopped', async () => {
    const stopped = new Map<string, any>();
    registerRoutes(
      {
        get: (routePath, handler) => stopped.set(`GET ${routePath}`, handler),
        post: (routePath, handler) => stopped.set(`POST ${routePath}`, handler),
      },
      () => null,
    );
    const { sent, response } = capture();
    await stopped.get('POST /docs/init')({ params: {} }, response);
    expect(sent.status).toBe(503);
  });
});
