/**
 * signalk-github-pages — publish vessel telemetry to a GitHub Pages site.
 *
 * The plugin replaces a Python daemon that polled the server over HTTP, wrote
 * into a git checkout on the Pi and pushed every couple of minutes. It reads
 * the same data in-process, keeps its rolling state in the plugin data
 * directory, and publishes through the GitHub Git Data API — no checkout, no
 * `git` binary, nothing on disk to rebase.
 *
 * The cost of moving in-process is that a bug here can take down the server
 * that a separate process could not touch, so every tick is wrapped: an
 * exception skips one cycle and is reported in the admin UI, and never
 * reaches the server's event loop.
 */
import os from 'node:os';
import path from 'node:path';
import {
  buildConfigSchema,
  configUiSchema,
  resolveConfig,
  type PluginConfig,
  type PolarStatus,
} from './config';
import { GitHubClient, tokenHint } from './github';
import { HistoryReader, type HistoryHost } from './history';
import { Publisher } from './publisher';
import { StateStore } from './state';
import { activePolarId, readActivePolar, type PolarResourceSource } from './polars';
import { extractPositionFix, readSelfTree, type SelfTreeSource } from './snapshot';
import { registerRoutes, type Router, type WebappDeps } from './webapp';
import { isValidTimezone } from './time';
import { readVesselDetails, type VesselIdentity } from './vesselInfo';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: PLUGIN_VERSION } = require('../package.json') as { version: string };

interface SignalKApp extends SelfTreeSource, PolarResourceSource, HistoryHost {
  debug: (message: string) => void;
  error: (message: string) => void;
  setPluginStatus: (message: string) => void;
  setPluginError: (message: string) => void;
  getDataDirPath: () => string;
  /** Write the config back, for the "set to the current position" checkbox. */
  savePluginOptions?: (options: unknown, callback: (error: unknown) => void) => void;
  /** The saved config, for the derived fields the schema shows read-only. */
  readPluginOptions?: () => unknown;
  config?: { settings?: { port?: number; ssl?: boolean } };
}

interface Plugin {
  id: string;
  name: string;
  description: string;
  schema: unknown;
  uiSchema: unknown;
  start: (options: unknown) => void;
  stop: () => void;
  /** Signal K mounts this at /plugins/signalk-github-pages. */
  registerWithRouter: (router: Router) => void;
}

/** First non-internal IPv4 address — the one a browser on the boat LAN uses. */
function lanAddress(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

/**
 * What only the server process knows: the address the site links back to, and
 * an MMSI to fall back on. Everything else about the boat — callsign,
 * registrations, dimensions — is read off the tree on every cycle, where it
 * arrives after the plugin has already started.
 */
function readIdentity(app: SignalKApp): VesselIdentity {
  const name = typeof app.getSelfPath?.('name') === 'string' ? app.getSelfPath!('name') : '';
  const rawMmsi = app.getSelfPath?.('mmsi');
  const mmsi =
    typeof rawMmsi === 'string' && rawMmsi
      ? rawMmsi
      : (app.selfId ?? '').replace(/^urn:mrn:imo:mmsi:/, '');
  const ssl = app.config?.settings?.ssl === true;
  return {
    name: name || 'Vessel',
    mmsi: /^\d{9}$/.test(mmsi) ? mmsi : '',
    signalk: {
      host: lanAddress(),
      port: String(app.config?.settings?.port ?? (ssl ? 3443 : 3000)),
      protocol: ssl ? 'https' : 'http',
    },
  };
}

function formatClock(date: Date): string {
  return date.toISOString().slice(11, 16);
}

/**
 * Where this start expects the instrument log to come from.
 *
 * Worth a line in the log because the two answers produce visibly different
 * sites — sparklines at the configured resolution, or no sparklines at all —
 * and because "no History API on this server" is the answer on every server
 * without a history provider installed, which is most of them. The track is
 * not part of this: it is always the plugin's own.
 */
function historySetting(app: SignalKApp, config: PluginConfig): string {
  if (!config.history.enabled) return 'no instrument log (history provider turned off)';
  if (typeof app.getHistoryApi !== 'function') {
    return 'no instrument log (this server has no History API)';
  }
  const minutes = Math.round(
    (config.history.resolutionSeconds * config.instrumentLog.entries) / 60,
  );
  return (
    `instrument log from ${config.history.providerId || 'the default'} history provider ` +
    `at ${config.history.resolutionSeconds}s x ${config.instrumentLog.entries} entries (${minutes} min)`
  );
}

module.exports = function (app: SignalKApp): Plugin {
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  // What the last cycle found for the polar table. Kept out here so it
  // survives a stop/start and so the config page can report it.
  let polarStatus: PolarStatus | null = null;
  // The CSV the last cycle resolved, for the preview. Not read from the
  // resource again on a preview request: a page open must not be able to make
  // the boat do work it would not otherwise do.
  let polarCsv = '';
  // Set on start, cleared on stop: the console's routes are registered once,
  // when the server loads the plugin, and answer 503 while it is not running.
  let webapp: WebappDeps | null = null;

  /**
   * What to tell the config page about the polar table.
   *
   * After a cycle this is what actually happened. Before one — a fresh
   * install, or the plugin disabled — the self tree still says whether Polar
   * Management has something active, which is the half of the answer that
   * decides what the read-only box on that page shows.
   */
  const polarNote = (): PolarStatus | null => {
    if (polarStatus) return polarStatus;
    try {
      const id = activePolarId(readSelfTree(app));
      if (id) {
        return {
          source: 'resource',
          summary: `"${id}" from Polar Management (not read yet — no cycle has run)`,
          problems: [],
        };
      }
    } catch {
      // A server that will not hand over a tree tells us nothing; say nothing.
    }
    return null;
  };

  /**
   * The derived values the config page shows read-only beside their override
   * checkboxes. Read when the page is opened, so they are current.
   *
   * The repository name comes from the saved options rather than from the
   * running config, because the page is worth opening on a plugin that is
   * disabled or has never started.
   */
  const schemaContext = () => {
    let details: ReturnType<typeof readVesselDetails> = {};
    try {
      details = readVesselDetails(readSelfTree(app));
    } catch {
      // A server that will not hand over a tree leaves the boxes empty.
    }
    let owner = '';
    try {
      const saved = app.readPluginOptions?.() as Record<string, any> | undefined;
      const value = saved?.github?.owner;
      if (typeof value === 'string') owner = value.trim();
    } catch {
      // Nothing saved yet: the box stays empty until the owner is.
    }
    return {
      repoName: owner ? `${owner}.github.io` : '',
      polar: polarNote(),
      polarCsv,
      uscgNumber: details.uscgNumber,
      hullNumber: details.hullNumber,
    };
  };

  /**
   * "Set to the current position", which is a checkbox because a JSON Schema
   * form has no buttons.
   *
   * Ticked, it copies `navigation.position` into the coordinates and unticks
   * itself, so the next time the page is opened it shows the captured fix
   * rather than a control that would capture a different one. Saving the
   * config is what makes it stick; without a fix it is left ticked and the
   * plugin says why.
   */
  const captureCurrentPosition = (options: unknown): void => {
    const input = (options ?? {}) as Record<string, any>;
    if (input.site?.defaultLocation?.useCurrentPosition !== true) return;
    if (typeof app.savePluginOptions !== 'function') {
      app.error('This server cannot save plugin options, so the current position was not captured.');
      return;
    }
    const fix = extractPositionFix(readSelfTree(app));
    if (!fix) {
      app.error('No navigation.position yet, so the default position was not set.');
      return;
    }
    const saved = {
      ...input,
      site: {
        ...input.site,
        defaultLocation: {
          ...input.site.defaultLocation,
          useCurrentPosition: false,
          lat: Math.round(fix.latitude * 1e6) / 1e6,
          lon: Math.round(fix.longitude * 1e6) / 1e6,
        },
      },
    };
    // Mutated in place as well as saved: `start` carries on with `options`,
    // so this cycle publishes the position the checkbox just captured.
    input.site.defaultLocation = saved.site.defaultLocation;
    app.savePluginOptions(saved, (error: unknown) => {
      if (error) app.error(`Could not save the captured position: ${(error as any)?.message ?? error}`);
      else app.debug(`Default position set to ${saved.site.defaultLocation.lat}, ${saved.site.defaultLocation.lon}.`);
    });
  };

  const plugin: Plugin = {
    id: 'signalk-github-pages',
    name: 'GitHub Pages Vessel Tracker',
    description:
      'Publishes position, tracks and instrument history to a GitHub Pages site.',
    // A function, not an object: Signal K calls it when the page is opened, so
    // the derived fields show what the plugin would publish right now.
    schema: () => buildConfigSchema(schemaContext()),
    uiSchema: configUiSchema,

    start(options: unknown) {
      stopped = false;

      try {
        captureCurrentPosition(options);
      } catch (error: any) {
        app.error(`Could not capture the current position: ${error?.message ?? error}`);
      }

      const resolved = resolveConfig(options);
      if (!resolved.ok) {
        // Nothing numeric has a default, so an unconfigured install stops here
        // rather than publishing at a cadence nobody chose. Report every
        // missing field at once: one restart per field is a miserable way to
        // set this up over a boat's wifi.
        for (const problem of resolved.problems) app.error(`Config: ${problem}`);
        app.setPluginError(
          resolved.problems.length === 1
            ? resolved.problems[0]!
            : `${resolved.problems.length} settings need attention: ${resolved.problems.join(' ')}`,
        );
        return;
      }
      const config: PluginConfig = resolved.config;
      // Warnings resolve to something usable, so they never stop a start; they
      // are the settings most likely to be the reason the site looks wrong.
      for (const warning of resolved.warnings) app.error(`Config: ${warning}`);

      if (config.timezone && !isValidTimezone(config.timezone)) {
        app.error(
          `Unknown timezone "${config.timezone}"; grouping tracks by UTC day instead.`,
        );
      }

      app.debug(
        `Starting: ${config.github.repo}@${config.github.branch}, ` +
          `${config.interval.underway}s underway / ${config.interval.stationary}s stationary, ` +
          `${config.instrumentLog.paths.length} instrument path pattern(s) x ` +
          `${config.instrumentLog.entries} entries, ` +
          `${config.positionRetentionHours}h position retention, ` +
          `${config.staleMaxAgeMinutes}min stale cutoff, ` +
          `${config.privacyZones.length} privacy zone(s), ` +
          `${historySetting(app, config)}, ` +
          `tracks grouped by ${config.timezone}.`,
      );
      if (config.privacyZones.length === 0) {
        app.debug('No privacy zones set: every position is published exactly as received.');
      }

      const store = new StateStore(app.getDataDirPath());
      const client = new GitHubClient({
        repo: config.github.repo,
        branch: config.github.branch,
        token: config.github.token,
        userAgent: `signalk-github-pages/${PLUGIN_VERSION}`,
      });
      const history = new HistoryReader({
        app,
        history: config.history,
        instrumentPaths: config.instrumentLog.paths,
        instrumentEntries: config.instrumentLog.entries,
        log: (message) => app.debug(message),
      });
      const identity = readIdentity(app);
      const publisher = new Publisher({
        client,
        store,
        config,
        identity,
        siteDir: path.join(__dirname, '..', 'site'),
        seedDir: path.join(__dirname, '..', 'seed'),
        version: PLUGIN_VERSION,
        log: (message) => app.debug(message),
      });

      // The polar table belongs to the Polar Management plugin: it stores polars
      // as Signal K `polars` resources and points at the selected one from
      // `polars.activePolar`. Read it every cycle so a re-import or a switch to
      // a different polar reaches the site without restarting anything. The
      // table on our own config page takes over only when Override polar is
      // ticked.
      //
      // Problems are logged only when they change. A polar that will not
      // convert would otherwise say so every two minutes for as long as it is
      // selected, which buries everything else in the log.
      let lastPolarReport = '';
      const polarsCsv = async (tree: ReturnType<typeof readSelfTree>): Promise<string> => {
        const { csv, source, problems, summary } = await readActivePolar(
          app,
          tree,
          config.polars,
        );
        polarStatus = { source, summary, problems };
        polarCsv = csv;
        const report = `${source}|${summary}|${problems.join(' ')}`;
        if (report !== lastPolarReport) {
          lastPolarReport = report;
          for (const problem of problems) app.error(`Polar table: ${problem}`);
          app.debug(
            source === 'none' ? `Publishing no polars: ${summary}.` : `Polars from ${summary}.`,
          );
        }
        return csv;
      };

      const schedule = (seconds: number) => {
        if (stopped) return;
        timer = setTimeout(() => {
          void tick();
        }, seconds * 1000);
        // Publishing must never hold the server open on shutdown.
        timer.unref?.();
      };

      const tick = async () => {
        if (stopped) return;
        let seconds = config.interval.stationary;
        try {
          const tree = readSelfTree(app);
          if (Object.keys(tree).length === 0) {
            // No self data yet: the server is still starting, or nothing is
            // producing deltas. Publishing an empty snapshot would blank the
            // site, so wait for the next tick instead.
            app.setPluginStatus('Waiting for Signal K data');
            schedule(config.interval.stationary);
            return;
          }
          seconds = publisher.intervalSeconds(tree);
          // Both fetched here rather than inside the publisher, so a cycle
          // stays a pure function of the data it is given and a provider that
          // hangs is one skipped history read rather than a failed publish.
          const result = await publisher.runCycle(tree, {
            polars: await polarsCsv(tree),
            history: await history.read(new Date()),
          });
          const where = result.privacyZone
            ? `in ${result.privacyZone}`
            : (result.state ?? 'state unknown');
          const size = `${(result.bytes / 1024).toFixed(0)} kB`;
          app.setPluginStatus(
            result.published
              ? `Published ${formatClock(new Date())}Z (${result.files.length} files, ${size}), ` +
                  `${where}, next in ${Math.round(seconds / 60)} min`
              : `Nothing to publish, ${where}, next in ${Math.round(seconds / 60)} min`,
          );
        } catch (error: any) {
          // One bad cycle is a skipped update, not a dead plugin: a 502 from
          // GitHub, a truncated body or a wedged hotspot all retry next tick.
          const message = error?.message ?? String(error);
          const detail = error?.status ? ` (HTTP ${error.status}: ${error.body ?? ''})` : '';
          app.error(
            `Publish cycle failed, retrying in ${seconds}s: ${message}${detail}` +
              tokenHint(error?.status, config.github.repo),
          );
          app.setPluginError(
            `Last cycle failed at ${formatClock(new Date())}Z: ${message}. Retrying in ${Math.round(seconds / 60)} min.`,
          );
        }
        schedule(seconds);
      };

      webapp = {
        config,
        store,
        publisher,
        identity,
        siteDir: path.join(__dirname, '..', 'site'),
        version: PLUGIN_VERSION,
        readTree: () => readSelfTree(app),
        polars: () => ({ csv: polarCsv, status: polarStatus }),
        log: (message) => app.debug(message),
      };

      void (async () => {
        try {
          await publisher.seed();
        } catch (error: any) {
          app.error(`Could not seed state from the repository: ${error?.message ?? error}`);
        }
        await tick();
      })();
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      webapp = null;
      app.setPluginStatus('Stopped');
    },

    /** The console's backend. Signal K mounts it once, for the server's life. */
    registerWithRouter(router: Router) {
      registerRoutes(router, () => webapp);
    },
  };

  return plugin;
};
