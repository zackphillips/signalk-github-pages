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
import { isExcludedPath, type InstrumentLogEntry } from './instrumentLog';
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
      /** Paths actually asked for: stored, live on the boat, and not excluded. */
      requestedPaths: string[];
      /** Provider the values came from, for the log line. */
      providerId: string;
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'none' };

/**
 * Never ask a provider for a position.
 *
 * The track comes from the tree, through the privacy zones; a position read
 * back from the database would reach a published file that nothing redacts.
 * Any path with a `position` segment is one: `navigation.position`, but also
 * `navigation.anchor.position` (the drop point, often inside the zone) and
 * `navigation.course.previousPoint.position` (the slip the boat just left).
 * With the instrument log capturing everything the provider has stored, the
 * old rule — `navigation.position` alone — would have published both.
 * `hasCoordinates` catches the positions that are not named as one.
 */
export function isPositionPath(path: string): boolean {
  return path.split('.').includes('position');
}

/** A value shaped like a position, whatever its path is called. */
function hasCoordinates(value: object): boolean {
  return 'latitude' in value || 'longitude' in value;
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
        if (hasCoordinates(value)) continue;
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
 * Every path the provider has stored, less the excluded ones and positions.
 *
 * The instrument log used to be an allowlist, so a sensor someone added —
 * a second battery bank, a fridge thermometer — had history in the database
 * and no sparkline until someone also typed its path into the config page.
 * Now what the provider has is what the site gets, and the config page lists
 * what to leave out.
 */
export function selectInstrumentPaths(
  available: string[],
  exclude: string[],
  live?: ReadonlySet<string>,
): string[] {
  return [...new Set(available)]
    .filter(
      (path) =>
        !isPositionPath(path) &&
        !isExcludedPath(path, exclude) &&
        (live === undefined || live.has(path)),
    )
    .sort();
}

/**
 * The paths the boat is reporting a number for right now.
 *
 * "Found" means found on the boat, not merely in the database: a provider
 * keeps every path it has ever stored, including the sensor that was
 * unplugged in March, and asking for all of them was once ~167 paths a bucket
 * and a megabyte a file. A path with a numeric value on the self tree — or an
 * object of numbers, like attitude — is one the site can show beside its
 * sparkline, so it is the one worth its bytes.
 */
export function liveNumericPaths(tree: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown, path: string[]): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if ('value' in record) {
      const value = record.value;
      const numeric =
        (typeof value === 'number' && Number.isFinite(value)) ||
        (!!value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.values(value as Record<string, unknown>).some(
            (member) => typeof member === 'number' && Number.isFinite(member),
          ));
      if (numeric && path.length) {
        found.add(path.join('.'));
        // A provider may store a composite by its members instead.
        if (value && typeof value === 'object') {
          for (const key of Object.keys(value as object)) found.add([...path, key].join('.'));
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'value' || key === 'meta' || key === 'values' || key.startsWith('$')) continue;
      walk(child, [...path, key]);
    }
  };
  walk(tree, []);
  return found;
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

/** The members `listHistoryProviders` reads, all optional on older servers. */
export type ProviderListHost = HistoryHost & Partial<Pick<SignalKApp, 'getPluginsList' | 'config'>>;

/**
 * The history providers registered on the server, for the config page's
 * dropdown.
 *
 * The server keeps its registry private — the only published way to read it
 * is an HTTP route that may need a login — so each enabled plugin is asked
 * for in turn: `getHistoryApi(id)` resolves for a provider and rejects for
 * anything else. In-process, so a whole plugin list costs a few microtasks.
 *
 * Null means the question cannot be asked on this server (no History API, or
 * no plugin list), which the page renders as a bare "Server default".
 */
export async function listHistoryProviders(
  app: ProviderListHost,
): Promise<{ ids: string[]; defaultId?: string } | null> {
  if (typeof app.getHistoryApi !== 'function' || typeof app.getPluginsList !== 'function') {
    return null;
  }
  let plugins: Array<{ id: string }>;
  try {
    plugins = await app.getPluginsList(true);
  } catch {
    return null;
  }
  const ids: string[] = [];
  for (const plugin of plugins ?? []) {
    if (!plugin || typeof plugin.id !== 'string') continue;
    const found = await withTimeout(app.getHistoryApi(plugin.id), 2_000, 'provider probe').then(
      () => true,
      () => false,
    );
    if (found) ids.push(plugin.id);
  }
  // The server's own rule: the configured provider when it is registered,
  // otherwise whichever registered first. Registration order is not
  // visible from here, so a lone provider is the only other certain answer.
  const configured = app.config?.settings?.historyApi?.defaultProvider;
  const defaultId =
    configured && ids.includes(configured) ? configured : ids.length === 1 ? ids[0] : undefined;
  return { ids: ids.sort(), defaultId };
}

export interface HistoryReaderDeps {
  app: HistoryHost;
  history: HistoryConfig;
  /** Paths never logged, from the config page. Positions are never logged either. */
  exclude: string[];
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

  /**
   * The instrument history behind one publish cycle.
   *
   * `tree` is the self tree this cycle publishes; only paths it carries a
   * number for are asked for. Left out, every stored path not excluded is.
   */
  async read(now: Date, tree?: unknown): Promise<HistoryResult> {
    if (!this.configured) return { status: 'none' };
    const { history, log } = this.deps;
    try {
      const api = await this.resolveApi();
      const { entries, requestedPaths } = await this.readInstruments(api, now, tree);
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
    tree?: unknown,
  ): Promise<{ entries: InstrumentLogEntry[]; requestedPaths: string[] }> {
    const { history, exclude, instrumentEntries } = this.deps;
    const available = await this.availablePaths(api, now);
    const requestedPaths = selectInstrumentPaths(
      available,
      exclude,
      tree === undefined ? undefined : liveNumericPaths(tree),
    );
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
   * Paths the provider has stored: the list the instrument log is built from.
   *
   * Listed over the last day rather than the log window: a bank that was
   * quiet for the last hour is still a bank, and the listing is cached so
   * this costs one query every 15 minutes, not one per cycle. A provider that
   * cannot list its paths gives the site no sparklines, and says so.
   */
  private async availablePaths(api: HistoryApiLike, now: Date): Promise<string[]> {
    const { history, exclude, log } = this.deps;
    if (this.pathCache && now.getTime() - this.pathCache.at < PATH_CACHE_MS) {
      return this.pathCache.paths;
    }
    if (typeof api.getPaths !== 'function') {
      throw new Error('the history provider cannot list the paths it has stored');
    }
    const paths = await withTimeout(
      api.getPaths({ ...this.range(now, 24 * 3600) }),
      history.timeoutMs,
      'history getPaths',
    );
    const list = Array.isArray(paths) ? paths.filter((path) => typeof path === 'string') : [];
    this.pathCache = { paths: list, at: now.getTime() };
    const logged = selectInstrumentPaths(list, exclude).length;
    log(
      `History: ${list.length} path(s) stored; logging ${logged}, leaving out ` +
        `${list.length - logged} excluded or position path(s).`,
    );
    return list;
  }
}
