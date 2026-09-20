/**
 * The site frontend, shipped inside the plugin package.
 *
 * `site/` holds the HTML, CSS, JS and icons that GitHub Pages serves. They
 * are written into the repository on first run and after a plugin upgrade,
 * never on a normal telemetry cycle — they do not change between releases,
 * and republishing 700 KB every two minutes over a hotspot would be absurd.
 *
 * Some of what they contain belongs to the adopter rather than to the release,
 * so it is substituted on the way out.
 *
 * `assets/constants.js` carries the repository the "edit on GitHub" links
 * point at and the instrument-log length, which must match the publisher or
 * the sparklines read the wrong number of points. `sw.js` carries the plugin
 * version, which names the service worker's shell cache: without it the cache
 * name is a constant, and a device that has loaded the site once serves that
 * release's HTML and JavaScript forever while the telemetry beside it keeps
 * updating. Old code against new data is what "Data unavailable" on a phone
 * means, with a perfectly good snapshot sitting in the panel underneath it.
 *
 * `index.html`, `docs.html` and `manifest.json` carry the vessel's identity:
 * the social-preview tags, the home-screen name, the icons and the paths the
 * site is served under. Those cannot be filled in by the page at runtime the
 * way the visible name is — a link pasted into a group chat is unfurled by a
 * crawler that never runs the JavaScript — so they are substituted here, at
 * publish time, from `{{TOKEN}}` placeholders. Every value goes through an
 * escaper chosen by the file's type: a vessel named `Nancy "Nan" Blackett` is
 * a broken attribute in one and a broken document in the other.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { siteBasePath, type PluginConfig } from './config';
import { LEGACY_LOGO_PATH } from './logo';

/**
 * The tab and home-screen icon for a site with no logo set.
 *
 * Shipped in `site/assets/` and deliberately generic. What used to be here
 * were six PNG and ICO files carrying one boat's burgee, published into every
 * adopter's repository under a path the plugin owns and overwrites, so the
 * only way to have your own was to fork the plugin.
 */
export const GENERIC_ICON_PATH = 'assets/icon.svg';

export interface FrontendFile {
  /** Repo-relative destination path. */
  path: string;
  content: string | Buffer;
}

/** Extensions served as text; everything else is uploaded as a binary blob. */
const TEXT_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.svg',
  '.txt',
  '.md',
  '.webmanifest',
  '',
]);

export interface FrontendOptions {
  repo: string;
  branch: string;
  instrumentLogEntries: number;
  /** Plugin version, which names the service worker's shell cache. */
  version: string;
  /** What the boat is called, from the Signal K tree. */
  vesselName: string;
  /** The site's own address, with a trailing slash. */
  siteUrl: string;
  /** Where the logo lives, relative to the site root. */
  logoPath: string;
  /** Tab and home-screen icon: the logo, or the bundled generic one. */
  iconPath: string;
  /** The icon's media type, which the web app manifest declares. */
  iconType: string;
  /** The path the site is served under: `/`, or `/tracker/`. */
  basePath: string;
}

/**
 * What the publisher and the console's preview both need to render `site/`.
 *
 * One function so the preview is the page that will actually be published,
 * down to the link-preview tags — it is the only place the substitutions can
 * be checked before a commit goes out.
 */
export function frontendOptions(
  config: PluginConfig,
  vesselName: string,
  version: string,
): FrontendOptions {
  const logo = config.site.logo;
  return {
    repo: config.github.repo,
    branch: config.github.branch,
    instrumentLogEntries: config.instrumentLog.entries,
    version,
    vesselName,
    siteUrl: config.site.url,
    // With no logo configured the pages still ask for the path the first
    // adopters committed theirs to, and hide the image when it 404s. The icon
    // does not get that second chance, so it falls back to the generic one.
    logoPath: logo?.path ?? LEGACY_LOGO_PATH,
    iconPath: logo?.path ?? GENERIC_ICON_PATH,
    iconType: logo?.mediaType ?? 'image/svg+xml',
    basePath: siteBasePath(config.site.url),
  };
}

/** Placeholder values, before escaping. */
function tokenValues(options: FrontendOptions): Record<string, string> {
  const name = options.vesselName.trim() || 'Vessel';
  return {
    VESSEL_NAME: name,
    SITE_URL: options.siteUrl,
    LOGO_PATH: options.logoPath,
    LOGO_URL: `${options.siteUrl}${options.logoPath}`,
    ICON_PATH: options.iconPath,
    ICON_TYPE: options.iconType,
    BASE_PATH: options.basePath,
  };
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** A JSON string body, without the quotes the template already has. */
const escapeJson = (value: string): string => JSON.stringify(value).slice(1, -1);

/**
 * Replace every `{{TOKEN}}` in the text.
 *
 * An unknown token is left alone rather than blanked: a placeholder visible in
 * the published page is a bug someone reports, where an empty `og:title` is a
 * bug nobody sees until a link looks wrong in a chat window.
 */
export function substituteTokens(
  source: string,
  values: Record<string, string>,
  escape: (value: string) => string,
): string {
  return source.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
    key in values ? escape(values[key] as string) : match,
  );
}

/**
 * Rewrite the per-adopter values in `constants.js`.
 *
 * A string replacement rather than a generated config file: the frontend is
 * a classic-script page where load order already matters, and the fewer moving
 * parts between `constants.js` and `app.js`, the better.
 */
export function renderConstants(source: string, options: FrontendOptions): string {
  let output = source;
  if (options.repo) {
    output = replaceOrThrow(
      output,
      /(GITHUB_REPO:\s*)'[^']*'/,
      `$1'${options.repo.replace(/'/g, "\\'")}'`,
      'GITHUB_REPO',
    );
  }
  if (options.branch) {
    output = replaceOrThrow(
      output,
      /(GITHUB_DEFAULT_BRANCH:\s*)'[^']*'/,
      `$1'${options.branch.replace(/'/g, "\\'")}'`,
      'GITHUB_DEFAULT_BRANCH',
    );
  }
  output = replaceOrThrow(
    output,
    /(INSTRUMENT_LOG_ENTRIES:\s*)\d+/,
    `$1${options.instrumentLogEntries}`,
    'INSTRUMENT_LOG_ENTRIES',
  );
  return output;
}

/**
 * Substitute, or say which setting did not take.
 *
 * These are regexes over a file a human edits, and the shipped values are
 * placeholders. A pattern that stops matching after a reformat used to fail
 * open: the published site kept the placeholder, and every adopter's "edit on
 * GitHub" link pointed at the repository this plugin was written in.
 */
function replaceOrThrow(
  source: string,
  pattern: RegExp,
  replacement: string,
  field: string,
): string {
  if (!pattern.test(source)) {
    throw new Error(
      `site/assets/constants.js has no ${field} line matching ${pattern}; the ` +
        'frontend cannot be published without substituting it.',
    );
  }
  return source.replace(pattern, replacement);
}

/**
 * Name the service worker's shell cache after the release.
 *
 * A new name is a new cache: the worker's activate handler deletes every cache
 * that is not the current one, so publishing a frontend actually replaces the
 * one on the device instead of sitting behind it.
 */
export function renderServiceWorker(source: string, options: FrontendOptions): string {
  return source.replace(
    /(SITE_VERSION\s*=\s*)'[^']*'/,
    `$1'${options.version.replace(/'/g, "\\'")}'`,
  );
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full, base)));
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

/** Files whose `{{TOKEN}}`s are filled in, and how their values are escaped. */
const TOKENISED: Record<string, (value: string) => string> = {
  'index.html': escapeHtml,
  'docs.html': escapeHtml,
  'manifest.json': escapeJson,
};

/** Substitute the per-adopter values in the files that carry any. */
export function template(
  repoPath: string,
  text: string,
  options: FrontendOptions,
): string {
  if (repoPath === 'assets/constants.js') return renderConstants(text, options);
  if (repoPath === 'sw.js') return renderServiceWorker(text, options);
  const escape = TOKENISED[repoPath];
  if (escape) return substituteTokens(text, tokenValues(options), escape);
  return text;
}

/** Read the bundled frontend, ready to hand to the publisher. */
export async function loadFrontend(
  siteDir: string,
  options: FrontendOptions,
): Promise<FrontendFile[]> {
  const relatives = (await walk(siteDir)).sort();
  const files: FrontendFile[] = [];
  for (const relative of relatives) {
    const repoPath = relative.split(path.sep).join('/');
    const buffer = await fs.readFile(path.join(siteDir, relative));
    if (TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      const text = buffer.toString('utf-8');
      files.push({ path: repoPath, content: template(repoPath, text, options) });
    } else {
      files.push({ path: repoPath, content: buffer });
    }
  }
  return files;
}
