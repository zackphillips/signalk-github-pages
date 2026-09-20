/**
 * Ownership manifest — the allowlist of paths this plugin may write.
 *
 * The published repository is shared with its owner: the docs are theirs, the
 * logo is theirs, `assets/custom.css` is theirs, and so are the polars unless
 * the server has an active polar to publish. The plugin writes a manifest
 * listing every path it manages and refuses to put anything outside that list
 * into a commit. It is an allowlist, not a blacklist — anything not named here is the
 * user's by default, including files that do not exist yet.
 */

export interface ManifestOptions {
  /** The plugin maintains docs/index.json (off when the Action does it). */
  buildDocsIndex: boolean;
  /**
   * The Polar Management plugin has an active polar, so `data/vessel/polars.csv`
   * is generated rather than hand-committed. Off by default, which is what
   * keeps a polar file someone committed years ago out of reach of the
   * publisher.
   */
  publishPolars?: boolean;
}

export const MANIFEST_PATH = '.tracker-manifest.json';

/** Paths written every cycle, whatever the configuration. */
const TELEMETRY_PATTERNS = ['data/telemetry/**', 'data/vessel/info.yaml'];

/** The polar table, owned only while the server has an active polar. */
export const POLARS_PATTERN = 'data/vessel/polars.csv';

/** Paths written on install and after a version upgrade. Always owned. */
const FRONTEND_PATTERNS = [
  'index.html',
  'docs.html',
  'sw.js',
  'manifest.json',
  '.nojekyll',
  'assets/**',
  'data/tide_stations.json',
];

/** Never written, even though it sits under an owned directory. */
export const USER_OWNED_EXCEPTIONS = ['assets/custom.css'];

/**
 * Paths the console may write once, on request, and never again.
 *
 * Seeded is not owned. These are documents: the plugin creates them when a
 * person asks it to and the path does not exist yet, and from that moment
 * they belong to the owner like every other file under `docs/`. No cycle
 * writes them, nothing rewrites them on upgrade, and deleting one is not
 * undone by the next publish. They are listed in the manifest so the answer
 * to "what put this here?" is in the repository rather than in a changelog.
 */
export const SEEDED_PATTERNS = [
  'docs/AGENTS.md',
  'docs/ships-docs.md',
  'docs/maintenance/log.md',
];

export function ownedPatterns(options: ManifestOptions): string[] {
  const patterns = [MANIFEST_PATH, ...TELEMETRY_PATTERNS, ...FRONTEND_PATTERNS];
  if (options.buildDocsIndex) patterns.push('docs/index.json');
  if (options.publishPolars) patterns.push(POLARS_PATTERN);
  return patterns;
}

/** Glob match supporting `*` (one segment) and `**` (any number of segments). */
export function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  const escaped = pattern
    .split('**')
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*');
  return new RegExp(`^${escaped}$`).test(path);
}

export function isOwnedPath(path: string, options: ManifestOptions): boolean {
  if (USER_OWNED_EXCEPTIONS.includes(path)) return false;
  return ownedPatterns(options).some((pattern) => matchesPattern(pattern, path));
}

/**
 * Drop (and report) any path the plugin does not own.
 *
 * Called on the way into every commit. A bug that starts generating a path
 * outside the manifest gets caught here rather than over a user's docs.
 */
export function partitionOwned<T extends { path: string }>(
  files: T[],
  options: ManifestOptions,
): { owned: T[]; rejected: T[] } {
  const owned: T[] = [];
  const rejected: T[] = [];
  for (const file of files) {
    (isOwnedPath(file.path, options) ? owned : rejected).push(file);
  }
  return { owned, rejected };
}

export function renderManifest(
  options: ManifestOptions & { version: string; generated: string },
): string {
  return `${JSON.stringify(
    {
      generator: 'signalk-github-pages',
      version: options.version,
      generated: options.generated,
      note:
        'Paths listed under "owned" are written by the Signal K plugin and will ' +
        'be overwritten. Everything else in this repository belongs to you.',
      owned: ownedPatterns(options),
      user_owned_exceptions: USER_OWNED_EXCEPTIONS,
      seeded_note:
        'Paths listed under "seeded" are created once, from the plugin console, ' +
        'only when they do not already exist. They are yours after that: nothing ' +
        'here rewrites or deletes them. The maintenance log is appended to, at ' +
        'the top, when you add an entry from the console.',
      seeded: SEEDED_PATTERNS,
    },
    null,
    2,
  )}\n`;
}
