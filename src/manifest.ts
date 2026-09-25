/**
 * Ownership manifest — the allowlist of paths this plugin may write.
 *
 * The published repository is shared with its owner: `docs/` is theirs, the
 * logo is theirs, `assets/custom.css` is theirs, and so are the polars unless
 * the server has an active polar to publish. The plugin writes a manifest
 * listing every path it manages and refuses to put anything outside that list
 * into a commit. It is an allowlist, not a blacklist — anything not named here is the
 * user's by default, including files that do not exist yet.
 */

export interface ManifestOptions {
  /**
   * The Polar Management plugin has an active polar, so `data/vessel/polars.csv`
   * is generated rather than hand-committed. Off by default, which is what
   * keeps a polar file someone committed years ago out of reach of the
   * publisher.
   */
  publishPolars?: boolean;
  /**
   * The path a configured vessel logo is published at, or undefined. Same
   * reasoning as the polars: unset, a logo committed by hand stays out of
   * reach of the publisher.
   */
  publishLogo?: string;
  /** Likewise for the icon, published at a separate path from the logo. */
  publishIcon?: string;
}

export const MANIFEST_PATH = '.tracker-manifest.json';

/** Paths written every cycle, whatever the configuration. */
const TELEMETRY_PATTERNS = ['data/telemetry/**', 'data/vessel/site.json'];

/**
 * Paths this plugin used to write and now only removes.
 *
 * `data/vessel/info.yaml` was the site's vessel configuration before
 * `site.json` replaced it. It is not in `ownedPatterns`, so it does not
 * appear in the published manifest claiming to be maintained — nothing
 * writes it any more. It is here so the one-time deletion that retires it
 * passes the same ownership check every other deletion does.
 *
 * `docs.html`, `assets/docs.js` and `docs/index.json` were the ship's docs
 * reader and its index. The documents under `docs/` were always the owner's
 * and are never touched; only the reader goes, so the site stops linking to
 * a page nothing maintains.
 */
const RETIRED_PATTERNS = [
  'data/vessel/info.yaml',
  'docs.html',
  'assets/docs.js',
  'docs/index.json',
];

/** Retired paths, in the order they should be removed. */
export const RETIRED_PATHS = [...RETIRED_PATTERNS];

/** The polar table, owned only while the server has an active polar. */
export const POLARS_PATTERN = 'data/vessel/polars.csv';

/** Paths written on install and after a version upgrade. Always owned. */
const FRONTEND_PATTERNS = [
  'index.html',
  'sw.js',
  'manifest.json',
  '.nojekyll',
  'assets/**',
  'data/tide_stations.json',
];

/** Never written, even though it sits under an owned directory. */
export const USER_OWNED_EXCEPTIONS = ['assets/custom.css'];

export function ownedPatterns(options: ManifestOptions): string[] {
  const patterns = [MANIFEST_PATH, ...TELEMETRY_PATTERNS, ...FRONTEND_PATTERNS];
  if (options.publishPolars) patterns.push(POLARS_PATTERN);
  if (options.publishLogo) patterns.push(options.publishLogo);
  if (options.publishIcon) patterns.push(options.publishIcon);
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
 * May this plugin delete this path?
 *
 * Everything it owns, plus the paths it has retired. Writing and deleting are
 * separated here because a retired path must be removable without the
 * manifest telling the repository's owner that the plugin still maintains it.
 */
export function isRemovablePath(path: string, options: ManifestOptions): boolean {
  if (isOwnedPath(path, options)) return true;
  if (USER_OWNED_EXCEPTIONS.includes(path)) return false;
  return RETIRED_PATTERNS.some((pattern) => matchesPattern(pattern, path));
}

/**
 * Drop (and report) any path the plugin does not own.
 *
 * Called on the way into every commit. A bug that starts generating a path
 * outside the manifest gets caught here rather than over a user's file.
 */
export function partitionOwned<T extends { path: string }>(
  files: T[],
  options: ManifestOptions,
  { allowRetired = false }: { allowRetired?: boolean } = {},
): { owned: T[]; rejected: T[] } {
  const permitted = allowRetired ? isRemovablePath : isOwnedPath;
  const owned: T[] = [];
  const rejected: T[] = [];
  for (const file of files) {
    (permitted(file.path, options) ? owned : rejected).push(file);
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
    },
    null,
    2,
  )}\n`;
}
