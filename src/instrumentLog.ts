/**
 * `instrument_log.json` — the numeric history every sparkline reads.
 *
 * `{timestamp, values: {path: number}}` per bucket, oldest first. The file
 * used to be accumulated here, one entry per publish cycle, off the self
 * tree; it is now a projection of whatever the server's history provider
 * holds, assembled in `history.ts`. What is left in this module is the shape
 * the frontend reads and the pattern matcher the captured-path list needs,
 * because that list is now a query rather than a filter.
 *
 * The list is still the whole bandwidth cost of a cycle: every path in it is
 * published for every entry, in full, on every publish. See
 * DEFAULT_INSTRUMENT_LOG_PATHS.
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

export interface InstrumentLogEntry {
  timestamp: string;
  values: Record<string, number>;
}

export interface InstrumentLog {
  schema_version: number;
  entries: InstrumentLogEntry[];
}

export const INSTRUMENT_LOG_SCHEMA_VERSION = 1;

/**
 * The file as it is published.
 *
 * Written without indentation: it is the largest file in a publish and nobody
 * reads it by hand.
 */
export function renderInstrumentLog(entries: InstrumentLogEntry[]): string {
  const log: InstrumentLog = {
    schema_version: INSTRUMENT_LOG_SCHEMA_VERSION,
    entries,
  };
  return `${JSON.stringify(log)}\n`;
}
