/**
 * signalk-github-pages — publish vessel telemetry to a GitHub Pages site.
 *
 * The plugin reads the self tree in-process, keeps its rolling state in the
 * plugin data directory, and publishes through the GitHub Git Data API — no
 * checkout, no `git` binary, nothing on disk to rebase.
 *
 * The cost of running inside the server is that a bug here can take down the
 * navigation data hub, so every tick is wrapped: an exception skips one
 * cycle and is reported in the admin UI, and never reaches the server's
 * event loop.
 */
import os from 'node:os';
import path from 'node:path';
import {
  buildConfigSchema,
  pagesUrl,
  resolveOwnerAndName,
  configUiSchema,
  resolveConfig,
  type PluginConfig,
  type PolarStatus,
} from './config';
import { FailureAlarm, type AlarmAction } from './alarm';
import { readPassage, type Passage } from './course';
import { GitHubClient, tokenHint } from './github';
import { HistoryReader } from './history';
import { Publisher } from './publisher';
import { StateStore } from './state';
import { activePolarId, readActivePolar } from './polars';
import { isUnderway, readSelfTree } from './snapshot';
import type { Plugin as ServerPlugin, SignalKApp } from './signalk';
import { NotificationRecorder } from './notificationRecorder';
import { PositionRecorder } from './track';
import { registerRoutes, type Router, type WebappDeps } from './webapp';
import { isValidTimezone } from './time';
import type { VesselIdentity } from './siteConfig';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: PLUGIN_VERSION } = require('../package.json') as { version: string };

/**
 * What this plugin returns to the server.
 *
 * `Plugin` is the server's own interface; the two narrowings are ours.
 * `schema` is a function because the config page shows values derived from
 * the running server, and `registerWithRouter` takes the structural router
 * `webapp.ts` declares rather than the full Express one — the console needs
 * four methods, and nothing here should depend on an Express release.
 */
type TrackerPlugin = Omit<ServerPlugin, 'schema' | 'registerWithRouter'> & {
  schema: () => object;
  registerWithRouter: (router: Router) => void;
};

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
  // Read once and narrow the result. These used to be two calls each, with
  // the `typeof` testing one and the value taken from the other.
  const rawName: unknown = app.getSelfPath?.('name');
  const name = typeof rawName === 'string' ? rawName : '';
  const rawMmsi: unknown = app.getSelfPath?.('mmsi');
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

/** Where the publish-failure notification lives in the tree. */
const NOTIFICATION_PATH = 'tracker.publishFailed';

/**
 * Raise or clear the notification the long way, for a server without the
 * Notifications API. This is what that API writes underneath.
 */
function sendNotification(app: SignalKApp, state: 'warn' | 'normal', message: string): void {
  app.handleMessage('signalk-github-pages', {
    updates: [
      {
        values: [
          {
            path: `notifications.${NOTIFICATION_PATH}`,
            // `visual` only: this plugin failing to reach GitHub is not a
            // reason to sound the boat's alarm in the middle of the night.
            value: { state, message, method: state === 'warn' ? ['visual'] : [] },
          },
        ],
      },
    ],
  } as never);
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

module.exports = function (app: SignalKApp): TrackerPlugin {
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  // What the last cycle found for the polar table. Kept out here so it
  // survives a stop/start and so the config page can report it.
  let polarStatus: PolarStatus | null = null;
  // The CSV the last cycle resolved, for the preview. Not read from the
  // resource again on a preview request: a page open must not be able to make
  // the boat do work it would not otherwise do.
  let polarCsv = '';
  // The passage the last cycle read, for the console's preview. Same rule as
  // the polar CSV: a page open must not make the boat call the Course API.
  let passage: Passage | null = null;
  // Set on start, cleared on stop: the console's routes are registered once,
  // when the server loads the plugin, and answer 503 while it is not running.
  let webapp: WebappDeps | null = null;
  // Subscribed on start, unsubscribed on stop. Null while the plugin is not
  // running, and left null on a server that cannot provide the streams.
  let recorder: PositionRecorder | null = null;
  // Subscribed on start when the plugin publishes notifications at all.
  let notifications: NotificationRecorder | null = null;
  // Unsubscribe for the navigation.state watch, or undefined when not watching.
  let stateUnsubscribe: (() => void) | undefined;

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
   * The derived values the config page shows beside their override
   * checkboxes. Read when the page is opened, so they are current.
   *
   * The repository name comes from the saved options rather than from the
   * running config, because the page is worth opening on a plugin that is
   * disabled or has never started.
   *
   * `readPluginOptions()` is not the mirror image of `savePluginOptions()`:
   * you save a configuration, and you read back the whole stored file —
   * `{ enabled, configuration }`. Reading it as though it were the
   * configuration found no owner on any server, which left every derived note
   * blank and made the override checkboxes look like they did nothing.
   */
  const schemaContext = () => {
    let owner = '';
    let savedGithub: Record<string, any> = {};
    try {
      const saved = app.readPluginOptions?.() as Record<string, any> | undefined;
      const configuration = (saved?.configuration ?? {}) as Record<string, any>;
      savedGithub = configuration.github ?? {};
      const value = savedGithub.owner;
      if (typeof value === 'string') owner = value.trim();
    } catch {
      // Nothing saved yet: the notes stay quiet until the owner is set.
    }
    // The site address is shown derived the same way the publisher derives it,
    // project site included, so the box says what a link preview will actually
    // resolve against before anyone ticks the override.
    const repo = resolveOwnerAndName(
      owner,
      savedGithub.name,
      savedGithub.overrideName === true,
    );
    return {
      repoName: owner ? `${owner}.github.io` : '',
      siteUrl: repo.owner && repo.name ? pagesUrl(repo.owner, repo.name) : '',
      polar: polarNote(),
      polarCsv,
    };
  };

  const plugin: TrackerPlugin = {
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

      /**
       * The one thing this plugin puts into the data model.
       *
       * Two ways to say it, because the Notifications API arrived in a
       * specific server release and this plugin runs on older ones. The
       * fallback writes the same notification with `handleMessage`, which
       * every server has had for years and which is what the API does
       * underneath.
       */
      const alarm = new FailureAlarm({ afterMinutes: config.notifyAfterFailureMinutes });
      let alarmId: string | null = null;
      const applyAlarm = (action: AlarmAction) => {
        try {
          if (action.kind === 'raise') {
            app.error(action.message);
            if (app.notifications?.raise) {
              alarmId = app.notifications.raise({
                state: 'warn' as never,
                message: action.message,
                path: NOTIFICATION_PATH as never,
              });
            } else {
              sendNotification(app, 'warn', action.message);
            }
          } else if (action.kind === 'clear') {
            app.debug('Publishing recovered; clearing the failure notification.');
            if (app.notifications?.clear && alarmId) {
              app.notifications.clear(alarmId as never);
              alarmId = null;
            } else {
              sendNotification(app, 'normal', 'Publishing has recovered.');
            }
          }
        } catch (error: any) {
          // A server that will not take the notification is not a reason to
          // stop publishing; the log still carries the failure.
          app.error(`Could not update the publish notification: ${error?.message ?? error}`);
        }
      };

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
      // The track comes from navigation.position deltas rather than from one
      // sample per cycle, so a tack is a tack rather than a corner. A server
      // that will not hand over the streams falls back to the tree fix, which
      // is what this plugin did before.
      recorder = new PositionRecorder({
        app,
        detailMetres: config.track.detailMetres,
        maxIntervalSeconds: config.interval.stationary,
        log: (message) => app.debug(message),
      });
      if (!recorder.start()) recorder = null;

      // Notification firings are edges, and sampling the tree once a cycle
      // misses any that fire and clear in between — at the stationary
      // cadence, an hour of them. Subscribing catches the bilge pump that
      // runs for three seconds every ten minutes, which is exactly the one
      // worth counting.
      if (config.publishNotifications) {
        notifications = new NotificationRecorder({
          app,
          exclude: config.notificationExclude,
          log: (message) => app.debug(message),
        });
        if (!notifications.start()) notifications = null;
      }

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

      /**
       * One publish cycle, on demand.
       *
       * The console's button and the `tracker.publishNow` PUT handler both
       * land here rather than duplicating the reads a cycle needs. It does
       * not touch the timer: a manual publish is an extra cycle, not a
       * replacement for the next scheduled one, so pressing the button
       * twice cannot leave the plugin without a timer running.
       */
      const publishNow = async (reason: string) => {
        if (stopped) return { published: false, files: [], bytes: 0, skipped: 'not running' };
        const tree = readSelfTree(app);
        if (Object.keys(tree).length === 0) {
          return { published: false, files: [], bytes: 0, skipped: 'no Signal K data yet' };
        }
        app.debug(`Publishing on request (${reason}).`);
        passage = await readPassage(app, (problem) => app.error(problem));
        const result = await publisher.runCycle(tree, {
          polars: await polarsCsv(tree),
          history: await history.read(new Date()),
          passage,
          fixes: recorder?.drain(),
          notificationEdges: notifications?.drain(),
          recordingNotifications: notifications?.available() === true,
        });
        return {
          published: result.published,
          files: result.files,
          bytes: result.bytes,
          commitSha: result.commitSha,
        };
      };

      /**
       * Publish as soon as the boat starts or stops moving.
       *
       * Without this, leaving the dock is invisible for up to an hour: the
       * stationary timer was set when the boat was still moored, and nothing
       * shortens it. The cadence already keys off `navigation.state`, so the
       * transition is exactly the moment worth publishing — someone ashore
       * watching for a departure sees it within a cycle rather than within
       * the interval that was appropriate before it happened.
       *
       * Only the transition fires, never the repeats: `navigation.state`
       * arrives as a delta on every update from signalk-autostate, and
       * publishing on each of those would ignore the cadence entirely.
       */
      let lastUnderway: boolean | null = null;
      const watchState = () => {
        const stream = app.streambundle?.getSelfStream?.('navigation.state' as never);
        if (!stream || typeof stream.onValue !== 'function') return;
        try {
          const off = stream.onValue((value: unknown) => {
            if (stopped) return;
            const underway = isUnderway(typeof value === 'string' ? value.toLowerCase() : null);
            if (lastUnderway === null) {
              lastUnderway = underway;
              return;
            }
            if (underway === lastUnderway) return;
            lastUnderway = underway;
            app.debug(
              `navigation.state changed to ${underway ? 'underway' : 'not underway'}; ` +
                'publishing now rather than waiting for the next tick.',
            );
            // Reschedule too: the pending timer was set for the cadence that
            // applied before the transition, which is the wrong one now.
            if (timer) clearTimeout(timer);
            void publishNow(`navigation.state went ${underway ? 'underway' : 'stationary'}`)
              .catch((error: any) => app.error(`Publish on state change failed: ${error?.message ?? error}`))
              .finally(() => schedule(underway ? config.interval.underway : config.interval.stationary));
          });
          if (typeof off === 'function') stateUnsubscribe = off;
        } catch (error: any) {
          app.debug(`Not watching navigation.state (${error?.message ?? error}).`);
        }
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
          // The recorder's time floor is the publish cadence, so the track is
          // never sparser than one fix per cycle and never denser than that
          // when the boat is not moving.
          recorder?.setPublishInterval(seconds);
          // Both fetched here rather than inside the publisher, so a cycle
          // stays a pure function of the data it is given and a provider that
          // hangs is one skipped history read rather than a failed publish.
          passage = await readPassage(app, (problem) => app.error(problem));
          const result = await publisher.runCycle(tree, {
            polars: await polarsCsv(tree),
            history: await history.read(new Date()),
            passage,
            fixes: recorder?.drain(),
            notificationEdges: notifications?.drain(),
            recordingNotifications: notifications?.available() === true,
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
          // A cycle that got as far as deciding there was nothing to publish
          // reached GitHub and read HEAD, so it counts as working.
          applyAlarm(alarm.recordSuccess());
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
          applyAlarm(alarm.recordFailure(new Date(), message));
        }
        schedule(seconds);
      };

      /**
       * `tracker.publishNow` as a PUT, so anything on the boat can ask for a
       * publish: a KIP button, a Node-RED flow, a physical switch wired
       * through a plugin. Useful on departure, and after an MOB, when the
       * next scheduled cycle could be an hour away at the stationary
       * cadence.
       *
       * This is input, not state. Publish results stay in the log and the
       * plugin status line — nothing here writes cost or commit SHAs into
       * the data model.
       */
      if (typeof app.registerPutHandler === 'function') {
        try {
          app.registerPutHandler('vessels.self', 'tracker.publishNow', (_context, _path, _value, callback) => {
            void publishNow('a PUT to tracker.publishNow')
              .then((result) =>
                callback({
                  state: 'COMPLETED',
                  statusCode: 200,
                  message: result.published
                    ? `Published ${result.files.length} file(s).`
                    : (result.skipped ?? 'Nothing to publish.'),
                }),
              )
              .catch((error: any) =>
                callback({
                  state: 'COMPLETED',
                  statusCode: 502,
                  message: `Publish failed: ${error?.message ?? error}`,
                }),
              );
            // Asynchronous by nature: a cycle is several round trips to
            // GitHub, and the server expects PENDING while that happens.
            return { state: 'PENDING' };
          });
        } catch (error: any) {
          app.error(`Could not register the publish-now PUT handler: ${error?.message ?? error}`);
        }
      }

      webapp = {
        config,
        store,
        publisher,
        identity,
        siteDir: path.join(__dirname, '..', 'site'),
        version: PLUGIN_VERSION,
        readTree: () => readSelfTree(app),
        polars: () => ({ csv: polarCsv, status: polarStatus }),
        passage: () => passage,
        publishNow,
        log: (message) => app.debug(message),
      };

      void (async () => {
        try {
          await publisher.seed();
        } catch (error: any) {
          app.error(`Could not seed state from the repository: ${error?.message ?? error}`);
        }
        await tick();
        watchState();
      })();
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      webapp = null;
      passage = null;
      recorder?.stop();
      recorder = null;
      notifications?.stop();
      notifications = null;
      try {
        stateUnsubscribe?.();
      } catch {
        // Unsubscribing a stream that is already gone is not a problem.
      }
      stateUnsubscribe = undefined;
      app.setPluginStatus('Stopped');
    },

    /** The console's backend. Signal K mounts it once, for the server's life. */
    registerWithRouter(router: Router) {
      registerRoutes(router, () => webapp);
    },
  };

  return plugin;
};
