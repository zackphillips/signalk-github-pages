/**
 * The Signal K History API as the source of the published history.
 *
 * Without a history provider this plugin *is* the historian: it appends one
 * position and one instrument reading per publish cycle to files in its data
 * directory, so the map track and the sparklines are sampled at the publish
 * cadence — a point every two minutes underway, an hour-wide gap at anchor,
 * and nothing at all from before the plugin was installed or while it was
 * stopped.
 *
 * A server that has a history provider registered (signalk-to-influxdb2 and
 * friends) already holds that history at full rate. Reading it back per cycle
 * gives the site a track at whatever resolution is asked for, survives a
 * restart, a reinstall and a moved data directory, and makes the plugin's own
 * rolling files a cache rather than the record.
 *
 * Two things this module is careful about:
 *
 * - **The provider returns raw positions.** Privacy zones are applied here,
 *   to every point, exactly as they are to a live fix. A zone added after a
 *   passage redacts that passage on the next cycle, because the history is
 *   re-read every time rather than accumulated.
 * - **In-process is not instant.** `getValues` reaches a database that is
 *   usually a container on the same Pi and sometimes a server ashore, so
 *   every call is raced against a timeout. A wedged query skips the history
 *   for one cycle and falls back to local accumulation; it never holds up the
 *   publish.
 */
import { Temporal } from '@js-temporal/polyfill';
import type { PrivacyZone } from './config';
import { pathMatches, type InstrumentLogEntry } from './instrumentLog';
import { buildPositionEntry, pruneAndSort, type PositionEntry } from './positions';
import type { PositionFix } from './snapshot';
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
 * The provider side of the History API, as the server hands it to a plugin.
 *
 * Typed structurally rather than imported from `@signalk/server-api`: the
 * plugin supports servers older than that module's history export, and a
 * missing type there must not stop this one compiling.
 */
export interface HistoryApiLike {
  getValues(query: Record<string, unknown>): Promise<HistoryValuesResponse>;
  getPaths(query: Record<string, unknown>): Promise<string[]>;
}

export interface HistoryHost {
  /** Present from the server release that shipped the History API. */
  getHistoryApi?: (providerId?: string) => Promise<HistoryApiLike>;
}

export interface HistoryConfig {
  enabled: boolean;
  /** Empty means the server's default provider. */
  providerId: string;
  /** Bucket width asked of the provider, in seconds. */
  resolutionSeconds: number;
  timeoutMs: number;
}

/** What one cycle got out of the provider, ready to publish. */
export interface HistorySnapshot {
  positions: PositionEntry[];
  instrument: InstrumentLogEntry[];
  /** Instrument paths actually asked for, after wildcard expansion. */
  requestedPaths: string[];
  /** Provider the values came from, for the log line. */
  providerId: string;
}

const POSITION_PATH = 'navigation.position';

/** A position bucket, however the provider chose to shape it. */
export function parseHistoryPosition(
  value: unknown,
): { latitude: number; longitude: number } | null {
  // The InfluxDB provider returns [lon, lat]; the API's own examples allow an
  // object, so accept both rather than betting on one provider.
  if (Array.isArray(value)) {
    const [lon, lat] = value;
    if (typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon)) {
      return { latitude: lat, longitude: lon };
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const lat = record.latitude ?? record.lat;
    const lon = record.longitude ?? record.lon ?? record.lng;
    if (typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon)) {
      return { latitude: lat, longitude: lon };
    }
  }
  return null;
}

/** Index a row by path, taking the first non-null value for a repeated path. */
function rowByPath(
  values: HistoryValueDescriptor[],
  row: HistoryRow,
): Map<string, unknown> {
  const byPath = new Map<string, unknown>();
  values.forEach((descriptor, index) => {
    const value = row[index + 1];
    if (value === null || value === undefined) return;
    // `sourcePolicy=all` repeats a path once per source. The first source that
    // has a value for this bucket wins; the site shows one line per path.
    if (!byPath.has(descriptor.path)) byPath.set(descriptor.path, value);
  });
  return byPath;
}

/**
 * Turn a position history response into `positions_index.json` entries.
 *
 * Speed and course ride along when the same query asked for them, so a track
 * drawn from history carries the same values a live fix does — including
 * being dropped inside a privacy zone, where a speed alone would say the boat
 * is manoeuvring in the harbour.
 */
export function positionEntriesFromHistory(
  response: HistoryValuesResponse,
  options: { zones: PrivacyZone[]; retentionHours: number; now: Date },
): PositionEntry[] {
  const entries: PositionEntry[] = [];
  for (const row of response.data ?? []) {
    const timestamp = parseTimestamp(row[0]);
    if (!timestamp) continue;
    const byPath = rowByPath(response.values ?? [], row);
    const position = parseHistoryPosition(byPath.get(POSITION_PATH));
    if (!position) continue;

    const speed = byPath.get('navigation.speedOverGround');
    const course = byPath.get('navigation.courseOverGroundTrue');
    const fix: PositionFix = {
      latitude: position.latitude,
      longitude: position.longitude,
      timestamp: timestamp.toISOString(),
      speedOverGround: typeof speed === 'number' && isFinite(speed) ? speed : null,
      courseOverGroundTrue: typeof course === 'number' && isFinite(course) ? course : null,
    };
    entries.push(buildPositionEntry(fix, options.zones, timestamp));
  }
  return pruneAndSort(entries, options.now, options.retentionHours);
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
      if (typeof value === 'number' && isFinite(value)) {
        values[path] = value;
        continue;
      }
      // Composite values (attitude, position) contribute one path per numeric
      // member, the same flattening `collectNumericValues` does on the tree.
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
 * five minutes ago.
 */
export function expandPathPatterns(patterns: string[], available: string[]): string[] {
  const resolved = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      resolved.add(pattern);
      continue;
    }
    for (const path of available) {
      if (pathMatches(pattern, path)) resolved.add(path);
    }
  }
  return [...resolved];
}

/** A timestamp rounded down to a bucket, so two sources agree on one sample. */
export function bucketKey(timestamp: string, resolutionSeconds: number): string {
  const parsed = parseTimestamp(timestamp);
  if (!parsed) return timestamp;
  const width = Math.max(1, resolutionSeconds) * 1000;
  return String(Math.floor(parsed.getTime() / width));
}

/**
 * Combine time series from least to most authoritative, one entry per bucket.
 *
 * The locally accumulated files are not thrown away when a provider appears:
 * a database installed last week has nothing from the passage before it, and
 * dropping to its window would shorten a track that is already published.
 * Where both have a bucket the provider wins, and the live reading wins over
 * both — it is the freshest, and on a boat that is the one that matters.
 */
export function mergeByBucket<T extends { timestamp: string }>(
  series: T[][],
  resolutionSeconds: number,
): T[] {
  const byBucket = new Map<string, T>();
  for (const list of series) {
    for (const entry of list) byBucket.set(bucketKey(entry.timestamp, resolutionSeconds), entry);
  }
  return [...byBucket.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
  zones: PrivacyZone[];
  positionRetentionHours: number;
  instrumentPaths: string[];
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

  /**
   * The history behind one publish cycle, or null to fall back to local
   * accumulation.
   *
   * Null is a normal answer: no provider registered, none configured, the
   * database still starting, a query that timed out. The caller publishes
   * what it has rather than blanking the site.
   */
  async snapshot(now: Date): Promise<HistorySnapshot | null> {
    if (!this.configured) return null;
    const { history, log } = this.deps;
    try {
      const api = await this.resolveApi();
      const positions = await this.readPositions(api, now);
      const { entries, requestedPaths } = await this.readInstruments(api, now);
      this.announce(true);
      return {
        positions,
        instrument: entries,
        requestedPaths,
        providerId: history.providerId || 'default',
      };
    } catch (error: any) {
      // A provider that is down, still starting, or slow is not a failed
      // cycle: drop to local accumulation and try again next time.
      this.api = null;
      this.announce(false, error?.message ?? String(error));
      log(`History provider unavailable this cycle: ${error?.message ?? error}`);
      return null;
    }
  }

  private announce(available: boolean, detail?: string): void {
    if (this.lastAvailability === available) return;
    this.lastAvailability = available;
    this.deps.log(
      available
        ? `History provider ${this.deps.history.providerId || '(server default)'} is answering; ` +
            'publishing history read back from it rather than accumulated locally.'
        : `History provider stopped answering (${detail ?? 'no detail'}); ` +
            'publishing locally accumulated history until it returns.',
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

  private async readPositions(api: HistoryApiLike, now: Date): Promise<PositionEntry[]> {
    const { history, zones, positionRetentionHours } = this.deps;
    const response = await withTimeout(
      api.getValues({
        ...this.range(now, positionRetentionHours * 3600),
        context: 'vessels.self',
        resolution: history.resolutionSeconds,
        pathSpecs: [
          { path: POSITION_PATH, aggregate: 'first', parameter: [] },
          { path: 'navigation.speedOverGround', aggregate: 'average', parameter: [] },
          { path: 'navigation.courseOverGroundTrue', aggregate: 'average', parameter: [] },
        ],
      }),
      history.timeoutMs,
      'history getValues (positions)',
    );
    return positionEntriesFromHistory(response, {
      zones,
      retentionHours: positionRetentionHours,
      now,
    });
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
    // window is exactly as long as the file is — asking for more would throw
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
      'history getValues (instruments)',
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
