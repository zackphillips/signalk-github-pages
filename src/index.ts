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
import { configSchema, resolveConfig, type PluginConfig } from './config';
import { GitHubClient } from './github';
import { Publisher } from './publisher';
import { StateStore } from './state';
import { readSelfTree, type SelfTreeSource } from './snapshot';
import { isValidTimezone } from './time';
import type { VesselIdentity } from './vesselInfo';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: PLUGIN_VERSION } = require('../package.json') as { version: string };

interface SignalKApp extends SelfTreeSource {
  debug: (message: string) => void;
  error: (message: string) => void;
  setPluginStatus: (message: string) => void;
  setPluginError: (message: string) => void;
  getDataDirPath: () => string;
  config?: { settings?: { port?: number; ssl?: boolean } };
}

interface Plugin {
  id: string;
  name: string;
  description: string;
  schema: unknown;
  start: (options: unknown) => void;
  stop: () => void;
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

module.exports = function (app: SignalKApp): Plugin {
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;

  const plugin: Plugin = {
    id: 'signalk-github-pages',
    name: 'GitHub Pages vessel tracker',
    description:
      'Publishes position, tracks and instrument history to a GitHub Pages site.',
    schema: configSchema,

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
          `tracks grouped by ${config.timezone || 'UTC'}.`,
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
      const publisher = new Publisher({
        client,
        store,
        config,
        identity: readIdentity(app),
        publicDir: path.join(__dirname, '..', 'public'),
        version: PLUGIN_VERSION,
        log: (message) => app.debug(message),
      });

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
          const result = await publisher.runCycle(tree);
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
            `Publish cycle failed, retrying in ${seconds}s: ${message}${detail}`,
          );
          app.setPluginError(
            `Last cycle failed at ${formatClock(new Date())}Z: ${message}. Retrying in ${Math.round(seconds / 60)} min.`,
          );
        }
        schedule(seconds);
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
      app.setPluginStatus('Stopped');
    },
  };

  return plugin;
};
