/**
 * `instrument_log.json` — the numeric history every sparkline reads.
 *
 * `{timestamp, values: {path: number}}` per bucket, oldest first. The file
 * used to be accumulated here, one entry per publish cycle, off the self
 * tree; it is now a projection of whatever the server's history provider
 * holds, assembled in `history.ts`. What is left in this module is the shape
 * the frontend reads and the pattern matchers the exclusion lists need.
 *
 * Every path the provider has stored is logged unless it is excluded, and
 * every logged path is published for every entry, in full, on every publish.
 * See DEFAULT_INSTRUMENT_LOG_EXCLUDE.
 */

/** Does `path` match `pattern`, where `*` stands for exactly one segment? */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (!pattern.includes('*')) return false;
  const patternParts = pattern.split('.');
  const pathParts = path.split('.');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part === '*' || part === pathParts[i]);
}

/**
 * Does a path match any exclusion pattern?
 *
 * Three ways to match, because a blacklist is worth being generous about:
 * the exact path; a `*` wildcard for one segment; and a prefix, so `design`
 * excludes the whole `design.*` subtree without anyone enumerating it. The
 * notification exclusions and the instrument log exclusions both use it.
 */
export function isExcludedPath(path: string, patterns: string[]): boolean {
  return patterns.some(
    (pattern) =>
      pathMatches(pattern, path) ||
      path.startsWith(`${pattern}.`) ||
      pathMatches(`${pattern}.*`, path),
  );
}

export interface InstrumentLogEntry {
  timestamp: string;
  values: Record<string, number>;
}

/**
 * A categorical path's history as runs: `[timestamp, value]` at each change,
 * oldest first. A run lasts until the next one starts, and the last lasts to
 * the end of the log. Paths that never change are a single run, which is what
 * keeps a week of `moored` at one entry rather than one per bucket.
 */
export type StateRun = [timestamp: string, value: string];
export type StateRuns = Record<string, StateRun[]>;

export interface InstrumentLog {
  schema_version: number;
  entries: InstrumentLogEntry[];
  /** Left out when the boat reports no categorical paths. */
  states?: StateRuns;
}

export const INSTRUMENT_LOG_SCHEMA_VERSION = 1;

/**
 * The file as it is published.
 *
 * Written without indentation: it is the largest file in a publish and nobody
 * reads it by hand. `states` is an additive key, present only when there is
 * something in it, so a log without categorical paths is byte for byte what
 * it was before they existed and nothing republishes on upgrade.
 */
export function renderInstrumentLog(
  entries: InstrumentLogEntry[],
  states: StateRuns = {},
): string {
  const log: InstrumentLog = {
    schema_version: INSTRUMENT_LOG_SCHEMA_VERSION,
    entries,
    ...(Object.keys(states).length ? { states } : {}),
  };
  return `${JSON.stringify(log)}\n`;
}
