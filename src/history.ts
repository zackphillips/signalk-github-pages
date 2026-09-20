/**
 * The instrument log, read back from a Signal K history provider.
 *
 * The plugin used to be its own historian for this file: one reading per
 * publish cycle, appended to a file in the plugin data directory, so the
 * sparklines were sampled at the publish cadence and a restart, a reinstall
 * or a stopped plugin left a hole nothing could fill. A server with a history
 * provider registered (signalk-to-influxdb2 and friends) already holds all of
 * it at full rate, so the log is now a projection of the database rather than
 * something this plugin accumulates.
 *
 * Positions are deliberately *not* read from here. The track is still built
 * from what the plugin sees on the tree, which keeps the GPX archive working
 * on a server with no provider at all, keeps the whole 24-hour window from
 * being re-uploaded on every cycle, and leaves exactly one code path where a
 * position can reach the repository — the one the privacy zones already
 * guard. Asking a database for raw positions would add a second.
 *
 * Every call is raced against a timeout: `getValues` reaches a database that
 * is usually a container on the same Pi and sometimes a server ashore. A
 * wedged query costs one cycle's sparklines, never the publish.
 */
import { Temporal } from '@js-temporal/polyfill';
import { pathMatches, type InstrumentLogEntry } from './instrumentLog';
import type { SignalKApp } from './signalk';
import { parseTimestamp } from './time';

/** One row: the bucket timestamp, then one value per entry in `values`. */
export type HistoryRow = [string, ...unknown[]];

export interface HistoryValueDescriptor {
  path: string;
  method?: string;
  $source?: string;
}

export interface HistoryValuesResponse {
  context?: string;
  range?: { from: string; to: string };
  values: HistoryValueDescriptor[];
  data: HistoryRow[];
}

/**
 * The provider side of the History API, as this module is willing to use it.
 *
 * Deliberately looser than the server's `HistoryApi`, and the looseness is on
 * the *response* side only. A history provider is a third-party plugin —
 * signalk-to-influxdb2 and friends — so what comes back is another package's
 * output, not the server's, and parsing it tolerantly is the difference
 * between one missing sparkline and a failed cycle. The request side is
 * checked against the server's own types where it is built.
 */
export interface HistoryApiLike {
  getValues(query: Record<string, unknown>): Promise<HistoryValuesResponse>;
  getPaths(query: Record<string, unknown>): Promise<string[]>;
}

/**
 * The server, as far as history is concerned.
 *
 * `getHistoryApi` is optional in the server's own type — it arrived in a
 * specific release and is absent on anything older — so taking the member
 * from there keeps this module honest about the servers it runs on without
 * describing the method a second time.
 */
export type HistoryHost = Partial<Pick<SignalKApp, 'getHistoryApi'>>;

export interface HistoryConfig {
  enabled: boolean;
  /** Empty means the server's default provider. */
  providerId: string;
  /** Bucket width asked of the provider, in seconds. */
  resolutionSeconds: number;
  timeoutMs: number;
}

/**
 * What one cycle got out of the provider.
 *
 * The three states are different publishes, which is why this is a union and
 * not a nullable snapshot:
 *
 * - `ok`: write the log from these entries.
 * - `unavailable`: a provider is configured but did not answer this cycle.
 *   Publish nothing for the log and leave the copy already in the repository,
 *   so a database restart costs freshness, not the graphs.
 * - `none`: no provider, or the setting is off. The log is published empty,
 *   once, so the panels omit sparklines instead of drawing a frozen one.
 */
export type HistoryResult =
  | {
      status: 'ok';
      entries: InstrumentLogEntry[];
      /** Paths actually asked for, after wildcard expansion. */
      requestedPaths: string[];
      /** Provider the values came from, for the log line. */
      providerId: string;
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'none' };

/**
 * Never ask a provider for a position.
 *
 * `navigation.position` and anything under it is the one path whose history
 * this plugin does not want: the track comes from the tree, through the
 * privacy zones. A wildcard in the captured-path list could otherwise match
 * it and put raw positions into a published file that nothing redacts.
 */
export function isPositionPath(path: string): boolean {
  return path === 'navigation.position' || path.startsWith('navigation.position.');
}

/** Index a row by path, taking the first non-null value for a repeated path. */
function rowByPath(values: HistoryValueDescriptor[], row: HistoryRow): Map<string, unknown> {
  const byPath = new Map<string, unknown>();
  values.forEach((descriptor, index) => {
    const value = row[index + 1];
    if (value === null || value === undefined) return;
    // `sourcePolicy=all` repeats a path once per source. The first source that
    // has a value for this bucket wins; the site draws one line per path.
    if (!byPath.has(descriptor.path)) byPath.set(descriptor.path, value);
  });
  return byPath;
}

/** Turn an instrument history response into `instrument_log.json` entries. */
export function instrumentEntriesFromHistory(
  response: HistoryValuesResponse,
  options: { entries: number },
): InstrumentLogEntry[] {
  const entries: InstrumentLogEntry[] = [];
  for (const row of response.data ?? []) {
    const timestamp = parseTimestamp(row[0]);
    if (!timestamp) continue;
    const values: Record<string, number> = {};
    const byPath = rowByPath(response.values ?? [], row);
    for (const [path, value] of byPath) {
      if (isPositionPath(path)) continue;
      if (typeof value === 'number' && isFinite(value)) {
        values[path] = value;
        continue;
      }
      // A composite value (attitude) contributes one path per numeric member,
      // which is the shape the frontend's sparklines already read.
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
          if (typeof member === 'number' && isFinite(member)) values[`${path}.${key}`] = member;
        }
      }
    }
    // A bucket where every instrument was silent is a gap, not a reading.
    if (Object.keys(values).length === 0) continue;
    entries.push({ timestamp: timestamp.toISOString(), values });
  }
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return entries.slice(-Math.max(1, options.entries));
}

/**
 * Resolve the configured path patterns against what the provider has stored.
 *
 * The allowlist takes `*` for one segment (`electrical.batteries.*.voltage`);
 * the History API takes literal paths. Patterns without a `*` are passed
 * through untouched — a path the provider has never seen costs one column of
 * nulls, which is cheaper than failing to ask for a sensor that came online
 * five minutes ago. Positions are dropped from both halves.
 */
export function expandPathPatterns(patterns: string[], available: string[]): string[] {
  const resolved = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      if (!isPositionPath(pattern)) resolved.add(pattern);
      continue;
    }
    for (const path of available) {
      if (!isPositionPath(path) && pathMatches(pattern, path)) resolved.add(path);
    }
  }
  return [...resolved];
}

/** Reject rather than hang: a provider query is a database call. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface HistoryReaderDeps {
  app: HistoryHost;
  history: HistoryConfig;
  /** The captured-path patterns from the config page. */
  instrumentPaths: string[];
  /** Rolling length of the log, which is also the query window in buckets. */
  instrumentEntries: number;
  log: (message: string) => void;
}

/** How long a wildcard expansion is reused before the paths are listed again. */
export const PATH_CACHE_MS = 15 * 60_000;

export class HistoryReader {
  private api: HistoryApiLike | null = null;
  private pathCache: { paths: string[]; at: number } | null = null;
  /** Logged once per state change, not once per cycle. */
  private lastAvailability: boolean | null = null;

  constructor(private readonly deps: HistoryReaderDeps) {}

  /** False when the config turned it off or the server has no History API. */
  get configured(): boolean {
    return this.deps.history.enabled && typeof this.deps.app.getHistoryApi === 'function';
  }

  /** The instrument history behind one publish cycle. */
  async read(now: Date): Promise<HistoryResult> {
    if (!this.configured) return { status: 'none' };
    const { history, log } = this.deps;
    try {
      const api = await this.resolveApi();
      const { entries, requestedPaths } = await this.readInstruments(api, now);
      this.announce(true);
      return {
        status: 'ok',
        entries,
        requestedPaths,
        providerId: history.providerId || 'default',
      };
    } catch (error: any) {
      // A provider that is down, still starting, or slow is not a failed
      // cycle. Drop the resolved API so the next cycle asks the server again
      // — a restarted plugin hands out a new instance.
      this.api = null;
      const reason = error?.message ?? String(error);
      this.announce(false, reason);
      log(`History provider did not answer this cycle: ${reason}`);
      return { status: 'unavailable', reason };
    }
  }

  private announce(available: boolean, detail?: string): void {
    if (this.lastAvailability === available) return;
    this.lastAvailability = available;
    this.deps.log(
      available
        ? `History provider ${this.deps.history.providerId || '(server default)'} is answering; ` +
            'the instrument log is being read back from it.'
        : `History provider stopped answering (${detail ?? 'no detail'}); ` +
            'leaving the published instrument log as it is until it returns.',
    );
  }

  private async resolveApi(): Promise<HistoryApiLike> {
    if (this.api) return this.api;
    const { app, history } = this.deps;
    const api = await withTimeout(
      app.getHistoryApi!(history.providerId || undefined),
      history.timeoutMs,
      'getHistoryApi',
    );
    if (!api || typeof api.getValues !== 'function') {
      throw new Error('the server returned no usable history provider');
    }
    this.api = api;
    return api;
  }

  /** `{from, to}` as the History API wants them, in whole seconds. */
  private range(now: Date, windowSeconds: number): { from: Temporal.Instant; to: Temporal.Instant } {
    const to = Temporal.Instant.from(now.toISOString());
    return { from: to.subtract({ seconds: Math.max(1, Math.round(windowSeconds)) }), to };
  }

  private async readInstruments(
    api: HistoryApiLike,
    now: Date,
  ): Promise<{ entries: InstrumentLogEntry[]; requestedPaths: string[] }> {
    const { history, instrumentPaths, instrumentEntries } = this.deps;
    const available = await this.availablePaths(api, now);
    const requestedPaths = expandPathPatterns(instrumentPaths, available);
    if (requestedPaths.length === 0) return { entries: [], requestedPaths };

    // The log holds `entries` readings at the configured bucket width, so the
    // window is exactly as long as the file is: asking for more would throw
    // away every bucket past the trim.
    const windowSeconds = history.resolutionSeconds * instrumentEntries;
    const response = await withTimeout(
      api.getValues({
        ...this.range(now, windowSeconds),
        context: 'vessels.self',
        resolution: history.resolutionSeconds,
        pathSpecs: requestedPaths.map((path) => ({
          path,
          aggregate: 'average',
          parameter: [],
        })),
      }),
      history.timeoutMs,
      'history getValues',
    );
    return {
      entries: instrumentEntriesFromHistory(response, { entries: instrumentEntries }),
      requestedPaths,
    };
  }

  /**
   * Paths the provider has stored, for expanding `*` patterns.
   *
   * Listed over the last day rather than the log window: a bank that was
   * quiet for the last hour is still a bank, and the listing is cached so
   * this costs one query every 15 minutes, not one per cycle.
   */
  private async availablePaths(api: HistoryApiLike, now: Date): Promise<string[]> {
    const { history, instrumentPaths, log } = this.deps;
    if (!instrumentPaths.some((pattern) => pattern.includes('*'))) return [];
    if (this.pathCache && now.getTime() - this.pathCache.at < PATH_CACHE_MS) {
      return this.pathCache.paths;
    }
    if (typeof api.getPaths !== 'function') return [];
    const paths = await withTimeout(
      api.getPaths({ ...this.range(now, 24 * 3600) }),
      history.timeoutMs,
      'history getPaths',
    );
    const list = Array.isArray(paths) ? paths.filter((path) => typeof path === 'string') : [];
    this.pathCache = { paths: list, at: now.getTime() };
    log(`History: ${list.length} path(s) stored, expanding the wildcard patterns against them.`);
    return list;
  }
}
