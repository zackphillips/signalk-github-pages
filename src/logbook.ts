/**
 * The logbook: `data/telemetry/logbook/<day>.json`, from signalk-logbook.
 *
 * Writing a log entry is not this plugin's job. `@meri-imperiumi/signalk-logbook`
 * already does it well: a page in the admin UI for entries at sea, crew and
 * skipper, an automatic entry every hour underway, sail and engine changes,
 * alarms. It keeps one YAML file per UTC day in its own data directory and
 * leaves getting them off the boat to someone else. This module is that
 * someone else: it reads those files and publishes them, one JSON file per
 * *local* day, so the voyage card for a day shows that day's log.
 *
 * Local rather than UTC for the same reason the tracks are: an evening sail on
 * the US west coast is two UTC days, and the voyage it belongs to is one.
 *
 * Every entry is rebuilt from a list of known fields rather than copied and
 * pruned. A logbook entry carries a position and the active waypoint's
 * position, and the track is the one route a position takes to the site,
 * through the privacy zones. Copying the entry and deleting those two would
 * publish whatever position-shaped field a later logbook release adds.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { localDay } from './time';

/** The plugin id signalk-logbook registers, which names its data directory. */
export const LOGBOOK_PLUGIN_ID = 'signalk-logbook';

/** Where the published days live in the repository. */
export const LOGBOOK_PREFIX = 'data/telemetry/logbook/';

export const logbookPath = (day: string): string => `${LOGBOOK_PREFIX}${day}.json`;

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.yml$/;
const PUBLISHED_DAY = /^data\/telemetry\/logbook\/(\d{4}-\d{2}-\d{2})\.json$/;

/** The day a published logbook path is for, or null. */
export function logbookDay(repoPath: string): string | null {
  return PUBLISHED_DAY.exec(repoPath)?.[1] ?? null;
}

/**
 * signalk-logbook's data directory, beside this plugin's own.
 *
 * Signal K gives every plugin `plugin-config-data/<id>/`, so the logbook's is
 * a sibling of the one `app.getDataDirPath()` returns here.
 */
export function logbookDir(ownDataDir: string): string {
  return path.join(path.dirname(ownDataDir), LOGBOOK_PLUGIN_ID);
}

/** An entry as signalk-logbook wrote it. Loosely typed: it is another plugin's file. */
export type RawLogEntry = Record<string, unknown>;

export interface LogbookRead {
  entries: RawLogEntry[];
  /** Files that would not parse, one line each, for the log. */
  problems: string[];
}

/**
 * Reads the logbook's day files, re-parsing only the ones that changed.
 *
 * A year aboard is a few hundred small files and the cadence is two minutes,
 * so a file is parsed again only when its size or modification time moves.
 * The instance lives as long as the plugin does.
 */
export class LogbookReader {
  private readonly cache = new Map<
    string,
    { mtimeMs: number; size: number; entries: RawLogEntry[]; problem?: string }
  >();

  /** Null when the logbook plugin has never written anything on this server. */
  async read(dir: string): Promise<LogbookRead | null> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    }

    const seen = new Set<string>();
    const entries: RawLogEntry[] = [];
    const problems: string[] = [];
    for (const name of names.filter((file) => DAY_FILE.test(file)).sort()) {
      seen.add(name);
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;

      let cached = this.cache.get(name);
      if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
        cached = { mtimeMs: stat.mtimeMs, size: stat.size, ...parseDayFile(name, await fs.readFile(file, 'utf-8')) };
        this.cache.set(name, cached);
      }
      entries.push(...cached.entries);
      if (cached.problem) problems.push(cached.problem);
    }
    for (const name of this.cache.keys()) if (!seen.has(name)) this.cache.delete(name);
    return { entries, problems };
  }
}

function parseDayFile(name: string, text: string): { entries: RawLogEntry[]; problem?: string } {
  if (!text.trim()) return { entries: [] };
  try {
    const parsed = parse(text);
    if (!Array.isArray(parsed)) return { entries: [], problem: `${name} is not a list of entries.` };
    return {
      entries: parsed.filter((entry): entry is RawLogEntry => !!entry && typeof entry === 'object'),
    };
  } catch (error: any) {
    return { entries: [], problem: `${name} will not parse: ${error?.message ?? error}` };
  }
}

/** One published entry. Units are the logbook's own: knots, degrees, hPa, NM. */
export interface LogEntry {
  datetime: string;
  category: string;
  origin: string;
  text?: string;
  author?: string;
  end?: boolean;
  log?: number;
  heading?: number;
  course?: number;
  speed?: { sog?: number; stw?: number };
  barometer?: number;
  wind?: { speed?: number; direction?: number };
  observations?: { seaState?: number; cloudCoverage?: number; visibility?: number };
  engine?: { hours?: number };
  vhf?: string;
  crewNames?: string[];
  skipperName?: string;
}

export interface LogbookOptions {
  timezone: string;
  crewNames: boolean;
}

/**
 * The entries signalk-logbook writes on its own when the crew changes. Their
 * text is the names, so publishing them with the crew switched off would
 * publish the names anyway.
 */
const CREW_CHANGE = [
  /^Crew changed to /,
  / joined the crew$/,
  / left the crew$/,
  / took over as skipper$/,
];

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Drops the keys whose value is undefined; undefined for an object left empty. */
function compact<T extends object>(value: T): T | undefined {
  const kept = Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
  return Object.keys(kept).length ? kept : undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * One entry, rebuilt field by field, or null when it is not to be published.
 *
 * `origin` and `category` fall back the way signalk-logbook's own reader does:
 * an entry with an author was written by a person.
 */
export function publishedEntry(raw: RawLogEntry, options: LogbookOptions): LogEntry | null {
  if (typeof raw.datetime !== 'string' && !(raw.datetime instanceof Date)) return null;
  const when = new Date(raw.datetime);
  if (Number.isNaN(when.getTime())) return null;

  const author = text(raw.author);
  const origin = text(raw.origin) ?? (author ? 'manual' : 'auto');
  const body = text(raw.text);
  if (!options.crewNames && origin === 'auto' && body && CREW_CHANGE.some((re) => re.test(body))) {
    return null;
  }

  const speed = record(raw.speed);
  const wind = record(raw.wind);
  const observations = record(raw.observations);
  const engine = record(raw.engine);
  const crew = Array.isArray(raw.crewNames)
    ? raw.crewNames.map(text).filter((name): name is string => !!name)
    : undefined;

  return compact<LogEntry>({
    datetime: when.toISOString(),
    category: text(raw.category) ?? 'navigation',
    origin,
    text: body,
    author: options.crewNames ? author : undefined,
    end: raw.end === true ? true : undefined,
    log: number(raw.log),
    heading: number(raw.heading),
    course: number(raw.course),
    speed: compact({ sog: number(speed.sog), stw: number(speed.stw) }),
    barometer: number(raw.barometer),
    wind: compact({ speed: number(wind.speed), direction: number(wind.direction) }),
    observations: compact({
      seaState: number(observations.seaState),
      cloudCoverage: number(observations.cloudCoverage),
      visibility: number(observations.visibility),
    }),
    engine: compact({ hours: number(engine.hours) }),
    vhf: typeof raw.vhf === 'string' || typeof raw.vhf === 'number' ? String(raw.vhf) : undefined,
    crewNames: options.crewNames && crew?.length ? crew : undefined,
    skipperName: options.crewNames ? text(raw.skipperName) : undefined,
  }) as LogEntry;
}

/**
 * Every day's published file, keyed by local day.
 *
 * The output is a pure function of the entries and the options, so a day
 * nobody touched renders byte for byte the same and costs no commit.
 */
export function renderLogbookDays(
  entries: RawLogEntry[],
  options: LogbookOptions,
): Map<string, string> {
  const byDay = new Map<string, LogEntry[]>();
  for (const raw of entries) {
    const entry = publishedEntry(raw, options);
    if (!entry) continue;
    const day = localDay(new Date(entry.datetime), options.timezone);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(entry);
  }

  const files = new Map<string, string>();
  for (const [day, dayEntries] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    dayEntries.sort((a, b) => a.datetime.localeCompare(b.datetime));
    files.set(
      day,
      `${JSON.stringify({ schema_version: 1, date: day, entries: dayEntries }, null, 2)}\n`,
    );
  }
  return files;
}
