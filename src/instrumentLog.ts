/**
 * `instrument_log.json` — the rolling numeric history every sparkline reads.
 *
 * One entry per publish cycle: `{timestamp, values: {path: number}}`, holding
 * only numeric leaves whose path is on the allowlist. The allowlist is the
 * whole point: the unfiltered log carried ~167 paths per entry and the file
 * reached ~1 MB, which is a delta over `git push` but a full base64 upload
 * over the Git Data API. See DEFAULT_INSTRUMENT_LOG_PATHS.
 */
import type { Tree } from './snapshot';

/** Keys that carry plumbing rather than a child path. */
const SKIP_KEYS = new Set(['value', 'meta', 'values', 'pgn', '$source', 'source', 'timestamp']);

/** Flatten every numeric leaf of a Signal K tree to `path -> number`. */
export function collectNumericValues(node: any, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;

  const value = (node as any).value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (prefix) out[prefix] = value;
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Composite values (position, attitude) contribute one path per member.
    for (const [key, sub] of Object.entries(value)) {
      if (typeof sub === 'number' && Number.isFinite(sub)) {
        out[prefix ? `${prefix}.${key}` : key] = sub;
      }
    }
  }

  for (const [key, child] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      collectNumericValues(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

/** Does `path` match `pattern`, where `*` stands for exactly one segment? */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (!pattern.includes('*')) return false;
  const patternParts = pattern.split('.');
  const pathParts = path.split('.');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part === '*' || part === pathParts[i]);
}

/** Keep only the paths the frontend actually draws. An empty list keeps all. */
export function applyPathAllowlist(
  values: Record<string, number>,
  patterns: string[],
): Record<string, number> {
  if (!patterns.length) return values;
  const kept: Record<string, number> = {};
  for (const [path, value] of Object.entries(values)) {
    if (patterns.some((pattern) => pathMatches(pattern, path))) kept[path] = value;
  }
  return kept;
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

/** Append one reading and trim to the rolling window. */
export function appendInstrumentEntry(
  existing: InstrumentLogEntry[],
  timestamp: Date,
  blob: Tree,
  options: { paths: string[]; entries: number },
): InstrumentLog {
  const values = applyPathAllowlist(collectNumericValues(blob), options.paths);
  const entries = [...existing, { timestamp: timestamp.toISOString(), values }];
  return {
    schema_version: INSTRUMENT_LOG_SCHEMA_VERSION,
    entries: entries.slice(-Math.max(1, options.entries)),
  };
}
