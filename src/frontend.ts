/**
 * The site frontend, shipped inside the plugin package.
 *
 * `site/` holds the HTML, CSS, JS and icons that GitHub Pages serves. They
 * are written into the repository on first run and after a plugin upgrade,
 * never on a normal telemetry cycle — they do not change between releases,
 * and republishing 700 KB every two minutes over a hotspot would be absurd.
 *
 * Two values inside `assets/constants.js` belong to the adopter rather than to
 * the release, so they are substituted on the way out: the repository the
 * "edit on GitHub" links point at, and the instrument-log length, which must
 * match the publisher or the sparklines read the wrong number of points.
 *
 * `sw.js` gets one too: the plugin version, which names the service worker's
 * shell cache. Without it the cache name is a constant, and a device that has
 * loaded the site once serves that release's HTML and JavaScript forever while
 * the telemetry beside it keeps updating. Old code against new data is what
 * "Data unavailable" on a phone means, with a perfectly good snapshot sitting
 * in the panel underneath it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
    output = output.replace(
      /(GITHUB_REPO:\s*)'[^']*'/,
      `$1'${options.repo.replace(/'/g, "\\'")}'`,
    );
  }
  if (options.branch) {
    output = output.replace(
      /(GITHUB_DEFAULT_BRANCH:\s*)'[^']*'/,
      `$1'${options.branch.replace(/'/g, "\\'")}'`,
    );
  }
  output = output.replace(
    /(INSTRUMENT_LOG_ENTRIES:\s*)\d+/,
    `$1${options.instrumentLogEntries}`,
  );
  return output;
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

/** Substitute the per-adopter values in the two files that carry any. */
function template(repoPath: string, text: string, options: FrontendOptions): string {
  if (repoPath === 'assets/constants.js') return renderConstants(text, options);
  if (repoPath === 'sw.js') return renderServiceWorker(text, options);
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
