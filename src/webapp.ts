/**
 * The plugin's own HTTP surface: the console webapp's backend.
 *
 * Signal K mounts `public/` — the console page — at `/signalk-github-pages/`,
 * and hands plugins an Express router at `/plugins/signalk-github-pages/`.
 * This is that router. It does four jobs:
 *
 *   GET  /status            what the last cycle did, and what is on the site
 *   GET  /preview/*         the published site, rendered from live plugin data
 *   POST /prune             remove old voyages from the repository
 *   POST /publish           publish now, rather than waiting for the next tick
 *   POST /publish/site      rewrite every frontend file, then publish
 *   GET  /docs              what docs/ holds, and what a maintenance form needs
 *   POST /docs/init         write the starter documents, if there are none
 *   POST /docs/maintenance  add one entry to the top of the maintenance log
 *   GET  /auth              whether the plugin is signed in to GitHub, and as whom
 *   POST /auth/device       start signing in: a code to enter at github.com/login/device
 *   POST /auth/signout      forget the sign-in, or abandon one in progress
 *
 * The preview is the reason the frontend moved out of `public/` and into
 * `site/`: the two directories now mean different things, one served to the
 * boat and one published to GitHub, rather than one directory serving both
 * badly.
 *
 * Express is not a dependency here. The server passes its own router in, and
 * the handful of methods used are declared structurally, so the plugin has
 * nothing to install and nothing to keep in version lockstep.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Passage } from './course';
import { MaintenanceInputError, parseMaintenanceEntry } from './docsSeed';
import { renderPreviewData } from './preview';
import { frontendOptions, template } from './frontend';
import { describePrune, type PruneRequest } from './prune';
import { DocsExistError, type Publisher } from './publisher';
import { localDay } from './time';
import type { PluginConfig } from './config';
import type { Tree } from './snapshot';
import { mergeVesselIdentity, readVesselDetails, type VesselIdentity } from './siteConfig';
import type { StateStore } from './state';
import type { PolarStatus } from './config';
import { appInstallUrl, type GitHubAuth } from './githubAuth';

/** The bits of an Express response this module uses. */
interface Response {
  status: (code: number) => Response;
  json: (body: unknown) => void;
  type: (mime: string) => Response;
  send: (body: string | Buffer) => void;
  set: (field: string, value: string) => void;
}

interface Request {
  params: Record<string, string>;
  body?: unknown;
  path?: string;
  url?: string;
}

type Handler = (request: Request, response: Response) => void | Promise<void>;

export interface Router {
  get: (path: string, handler: Handler) => void;
  post: (path: string, handler: Handler) => void;
}

/** What the console reports back after a publish it asked for. */
export interface PublishNowResult {
  published: boolean;
  files: string[];
  bytes: number;
  commitSha?: string;
  skipped?: string;
}

export interface WebappDeps {
  config: PluginConfig;
  store: StateStore;
  publisher: Publisher;
  identity: VesselIdentity;
  /** Directory holding the published frontend. */
  siteDir: string;
  version: string;
  /** The live self tree, read the same way a cycle reads it. */
  readTree: () => Tree;
  /** The polar CSV and status the last cycle resolved. */
  polars: () => { csv: string; status: PolarStatus | null };
  /** The passage the last cycle read, for the preview's banner. */
  passage: () => Passage | null;
  /**
   * Run a publish cycle now. Supplied by `index.ts`, which is where the
   * async reads a cycle needs — the polar, the history, the course — happen,
   * so this module still never calls the server itself.
   */
  publishNow: (reason: string) => Promise<PublishNowResult>;
  log: (message: string) => void;
}

/** Content types for the handful of extensions the site is made of. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gpx': 'application/gpx+xml',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Resolve a preview path inside `site/`, or null.
 *
 * The path comes off the wire, so it is rejected rather than normalized if it
 * contains a `..` segment: this router runs inside the navigation server's
 * process, and a traversal here reads any file that process can read.
 */
export function resolveSitePath(siteDir: string, requested: string): string | null {
  const clean = decodeURIComponent(requested.split('?')[0] ?? '').replace(/^\/+/, '');
  const relative = clean === '' ? 'index.html' : clean;
  if (relative.split('/').some((segment) => segment === '..')) return null;
  const resolved = path.resolve(siteDir, relative);
  // Belt and braces: a symlink or an encoding trick that survives the check
  // above still has to land inside the directory.
  const root = path.resolve(siteDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

/**
 * Mount the console's routes.
 *
 * `deps` is a function rather than a value because Signal K registers the
 * router once per server lifetime while a plugin can be enabled and disabled
 * many times. Resolving it per request means the routes always see the
 * configuration the running plugin was started with, and a request that
 * arrives while it is stopped gets a 503 that says so rather than a stack
 * trace from a publisher that no longer exists.
 */
export function registerRoutes(
  router: Router,
  deps: () => WebappDeps | null,
  auth?: () => GitHubAuth,
): void {
  const fail = (response: Response, error: any, status = 500) => {
    const message = error?.message ?? String(error);
    deps()?.log(`Webapp request failed: ${message}`);
    response.status(status).json({ error: message });
  };
  /** A bad prune argument is the caller's mistake, not the plugin's. */
  const badRequest = (error: any) => /is not a number of days/.test(error?.message ?? '');

  /** Resolve the running plugin, or answer 503 and stop. */
  const running = (response: Response): WebappDeps | null => {
    const current = deps();
    if (!current) {
      response.status(503).json({ error: 'The plugin is not running.' });
      return null;
    }
    return current;
  };

  /**
   * The sign-in, which does not need the plugin running.
   *
   * A fresh install is stopped until it has a repository owner, and the
   * person setting it up should be able to sign in in whichever order they
   * get to things. So these answer from `auth` alone, and `publishingWith`
   * is null when there is no running config to say which credential it uses.
   */
  if (auth) {
    const authStatus = async () => {
      const current = deps();
      return {
        ...(await auth().status()),
        publishingWith: current ? current.config.github.auth : null,
        repo: current ? current.config.github.repo : null,
        installUrl: appInstallUrl(),
      };
    };

    router.get('/auth', async (_request, response) => {
      try {
        response.json(await authStatus());
      } catch (error) {
        fail(response, error);
      }
    });

    // POSTs, like every other route that makes the boat do something: this
    // one asks GitHub for a code and polls until it is entered.
    router.post('/auth/device', async (_request, response) => {
      try {
        await auth().startDeviceFlow();
        response.json(await authStatus());
      } catch (error) {
        fail(response, error, 502);
      }
    });

    router.post('/auth/signout', async (_request, response) => {
      try {
        await auth().signOut();
        response.json(await authStatus());
      } catch (error) {
        fail(response, error);
      }
    });
  }

  router.get('/status', async (_request, response) => {
    const current = running(response);
    if (!current) return;
    const { config, store, publisher, version } = current;
    try {
      const state = await store.readState();
      const polars = current.polars();
      response.json({
        version,
        repo: config.github.repo,
        branch: config.github.branch,
        siteUrl: config.site.url,
        repoUrl: `https://github.com/${config.github.repo}`,
        lastCommit: state.lastCommit ?? null,
        lastPublishedAt: state.lastPublishedAt ?? null,
        timezone: config.timezone,
        privacyZones: config.privacyZones.length,
        polars: polars.status,
        tracks: await publisher.listTracks(),
      });
    } catch (error) {
      fail(response, error);
    }
  });

  /** What a prune would take, so the page can name it before it happens. */
  router.get('/prune/:days', async (request, response) => {
    const current = running(response);
    if (!current) return;
    try {
      const plan = await current.publisher.planTrackPrune(
        parsePruneRequest(request.params.days),
      );
      response.json({
        remove: plan.remove.map((track) => track.date),
        keep: plan.keep.map((track) => track.date),
        cutoff: plan.cutoff,
        today: plan.today,
        summary: describePrune(plan),
      });
    } catch (error) {
      fail(response, error, badRequest(error) ? 400 : 500);
    }
  });

  router.post('/prune/:days', async (request, response) => {
    const current = running(response);
    if (!current) return;
    try {
      const { plan, commitSha } = await current.publisher.pruneTracks(
        parsePruneRequest(request.params.days),
      );
      response.json({
        removed: plan.remove.map((track) => track.date),
        remaining: plan.keep.length,
        commitSha: commitSha ?? null,
        summary: describePrune(plan),
      });
    } catch (error) {
      fail(response, error, badRequest(error) ? 400 : 500);
    }
  });

  /**
   * Publish now, rather than waiting for the next tick.
   *
   * A POST, and that matters: every GET route here is free of side effects,
   * because a phone left on the preview page must not be able to roll the
   * publisher's state forward or make the boat fetch anything. A button
   * someone pressed is the opposite — a deliberate instruction — and this is
   * the only thing on the page that spends the boat's bandwidth on request.
   */
  router.post('/publish', async (_request, response) => {
    const current = running(response);
    if (!current) return;
    try {
      response.json(await current.publishNow('the console'));
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * What `docs/` holds, and the boat's local day for the maintenance form to
   * open on.
   */
  router.get('/docs', async (_request, response) => {
    const current = running(response);
    if (!current) return;
    try {
      const status = await current.publisher.docsStatus();
      response.json({
        ...status,
        today: localDay(new Date(), current.config.timezone),
        repoUrl: `https://github.com/${current.config.github.repo}`,
        // config.site.url rather than deriving it here: it is the same value
        // unless a custom domain is set, and if one is, that is the address
        // the docs actually live at.
        docsUrl: `${current.config.site.url}docs.html`,
      });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Rewrite every frontend file on the next publish, then publish.
   *
   * An upgrade already republishes the frontend by itself — the fingerprint
   * that gates it carries the plugin version — so this is for what a version
   * number cannot see: a file deleted by hand on GitHub, a commit that landed
   * half-way, a repository rolled back to an older state.
   */
  router.post('/publish/site', async (_request, response) => {
    const current = running(response);
    if (!current) return;
    try {
      await current.publisher.forceFrontendRepublish();
      response.json(await current.publishNow('a full site rewrite from the console'));
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Write the starter documents into a repository that has none.
   *
   * 409, not 500, when documents already exist: the button was pressed on a
   * boat whose docs are already written, which is a state to report rather
   * than a failure to investigate.
   */
  router.post('/docs/init', async (_request, response) => {
    const current = running(response);
    if (!current) return;
    try {
      response.json(await current.publisher.initializeDocs());
    } catch (error) {
      fail(response, error, error instanceof DocsExistError ? 409 : 500);
    }
  });

  router.post('/docs/maintenance', async (request, response) => {
    const current = running(response);
    if (!current) return;
    try {
      const entry = parseMaintenanceEntry(readJsonBody(request), {
        today: localDay(new Date(), current.config.timezone),
      });
      response.status(201).json(await current.publisher.addMaintenanceEntry(entry));
    } catch (error) {
      fail(response, error, error instanceof MaintenanceInputError ? 400 : 500);
    }
  });

  // Everything under /preview is the site itself. `data/**` is rendered from
  // the plugin's live state; every other path is a file out of `site/`, with
  // the same substitutions the publisher makes on the way to GitHub.
  // Registration order is load-bearing here, so the wildcard goes first and
  // the bare `/preview` redirect is registered at the end of this function.
  //
  // Express does not run in strict-routing mode, so `/preview` also matches
  // `/preview/` — the exact path that redirect sends the browser to. With
  // the redirect registered first, a request for `/preview/` was answered
  // with `Location: preview/`, which the browser resolved against
  // `/preview/` to give `/preview/preview/`, and the console's iframe showed
  // "Not found" instead of the site.
  router.get('/preview/*', async (request, response) => {
    // Taken from the URL rather than from the wildcard parameter: Express 4
    // and 5 disagree about what `*` binds to, and `req.url` inside a mounted
    // router is the same string on both.
    const fromUrl = (request.url ?? '').replace(/^\/preview\/?/, '').split('?')[0] ?? '';
    const requested = fromUrl || String((request.params as any)[0] ?? '');
    const current = running(response);
    if (!current) return;
    const { config, store, siteDir, version, identity } = current;
    try {
      // The configured logo and icon, straight from the config rather than
      // from the repository: they are the published files the plugin holds
      // as bytes, and the preview is where someone checks each looks right
      // before it is committed.
      if (config.site.logo && requested === config.site.logo.path) {
        response.type(config.site.logo.mediaType).send(config.site.logo.content);
        return;
      }
      if (config.site.icon && requested === config.site.icon.path) {
        response.type(config.site.icon.mediaType).send(config.site.icon.content);
        return;
      }

      if (requested.startsWith('data/')) {
        const files = await renderPreviewData(
          { config, store, identity: current.identity },
          {
            tree: current.readTree(),
            polars: current.polars().csv,
            passage: current.passage(),
          },
        );
        const contents = files.get(requested);
        if (contents !== undefined) {
          response.type(TYPES[path.extname(requested)] ?? 'text/plain').send(contents);
          return;
        }
        // Not everything under data/ is telemetry: the tide-station table ships
        // with the frontend and is published from site/, so fall through to the
        // file rather than reporting it missing.
      }

      const file = resolveSitePath(siteDir, requested);
      if (!file) {
        response.status(400).type('text/plain').send('Bad path');
        return;
      }
      const buffer = await fs.readFile(file).catch(() => null);
      if (buffer === null) {
        response
          .status(404)
          .type('text/plain')
          .send(
            requested.startsWith('data/')
              ? `Not rendered locally: ${requested}`
              : 'Not found',
          );
        return;
      }
      const extension = path.extname(file).toLowerCase();
      response.type(TYPES[extension] ?? 'application/octet-stream');
      // The service worker would cache the preview under the server's own
      // origin and keep serving it after the plugin was upgraded, or gone. A
      // preview is a look at the current state, so it gets a worker that
      // installs, unregisters itself and caches nothing.
      if (requested === 'sw.js') {
        response.send(
          '// Preview build: the real service worker is published to GitHub Pages.\n' +
            'self.addEventListener("install", () => self.skipWaiting());\n' +
            'self.addEventListener("activate", (event) => {\n' +
            '  event.waitUntil(self.registration.unregister());\n' +
            '});\n',
        );
        return;
      }
      if (extension === '.js' || extension === '.html' || extension === '.css' ||
          extension === '.json') {
        // The same substitutions the publisher makes, through the same
        // function: the preview is there to show what a commit would put on
        // the site, and an untemplated one would show raw {{TOKEN}}s in the
        // page title while the published copy read correctly.
        const identityNow = mergeVesselIdentity(identity, readVesselDetails(current.readTree()));
        const text = buffer.toString('utf-8');
        response.send(
          template(requested, text, frontendOptions(config, identityNow.name, version)),
        );
        return;
      }
      response.send(buffer);
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * The bare form, without the trailing slash.
   *
   * Only reached when the path really has no slash, because the wildcard
   * above has already claimed `/preview/`. Every relative URL in the page
   * would otherwise resolve one level too high.
   */
  router.get('/preview', (_request, response) => {
    response.set('Location', 'preview/');
    response.status(302).send('');
  });
}

/**
 * `/prune/all`, `/prune/30`, or `/prune/2026-09-18` for one day.
 *
 * Anything else is rejected rather than read as a default. "All" is the most
 * destructive thing this plugin can be asked to do, and a typo in a URL is not
 * a reason to do it.
 */
export function parsePruneRequest(days: string | undefined): PruneRequest {
  if (days === 'all') return { olderThanDays: null };
  if (days && /^\d{4}-\d{2}-\d{2}$/.test(days)) return { olderThanDays: null, date: days };
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`"${days}" is not a number of days or "all".`);
  }
  return { olderThanDays: Math.floor(parsed) };
}

/**
 * The POST body, however this server's Express handed it over.
 *
 * Signal K parses JSON bodies for the whole app, so the normal case is an
 * object that is already parsed. A server that does not — an older release, a
 * proxy in front, a `text/plain` content type from a hand-rolled request —
 * would otherwise land in the validator as `undefined` and come back as "a
 * maintenance entry needs a title", which sends the reader looking at the
 * wrong end of the problem.
 */
export function readJsonBody(request: { body?: unknown }): unknown {
  const body = request.body;
  if (Buffer.isBuffer(body)) return parseJsonBody(body.toString('utf-8'));
  if (typeof body === 'string') return parseJsonBody(body);
  if (body && typeof body === 'object') return body;
  throw new MaintenanceInputError(
    'This request arrived without a JSON body. Send Content-Type: application/json.',
  );
}

function parseJsonBody(text: string): unknown {
  if (!text.trim()) {
    throw new MaintenanceInputError('This request arrived with an empty body.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MaintenanceInputError('The request body is not valid JSON.');
  }
}
