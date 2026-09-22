#!/usr/bin/env node
/**
 * Serve the bundled frontend against sample telemetry.
 *
 * `npm run dev` gives you the published site at http://localhost:8000 without
 * a boat, a Signal K server or a GitHub repository: `site/` is served with the
 * publisher's `{{TOKEN}}` substitutions filled in from the sample vessel, and
 * anything under `data/` falls back to `sample/` when the file is not there.
 * Use it to check a frontend change before it ships in a release.
 */
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [path.join(root, 'site'), path.join(root, 'sample')];
const port = Number(process.env.PORT ?? 8000);

/**
 * Stand-ins for what the plugin substitutes at publish time.
 *
 * Without these the dev server shows raw `{{VESSEL_NAME}}` in the title bar,
 * which is a confusing way to review a CSS change. They are only ever seen
 * here: the publisher fills the same tokens from the boat's own config.
 */
const TOKENS = {
  VESSEL_NAME: 'Sample Vessel',
  SITE_URL: `http://localhost:${port}/`,
  LOGO_PATH: 'data/vessel/logo.png',
  LOGO_URL: `http://localhost:${port}/data/vessel/logo.png`,
  ICON_PATH: 'assets/icon.svg',
  ICON_TYPE: 'image/svg+xml',
  BASE_PATH: '/',
};

const TOKENIZED = new Set(['index.html', 'docs.html', 'manifest.json']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gpx': 'application/gpx+xml',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const relative = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  // Refuse anything that climbs out of the served roots.
  if (relative.split('/').includes('..')) return null;
  for (const base of roots) {
    const candidate = path.join(base, relative);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next root.
    }
  }
  return null;
}

createServer(async (request, response) => {
  const file = await resolve(request.url ?? '/');
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found\n');
    return;
  }
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  };
  const relative = path.relative(roots[0], file).split(path.sep).join('/');
  if (TOKENIZED.has(relative)) {
    const text = (await fs.readFile(file, 'utf-8')).replace(
      /\{\{([A-Z_]+)\}\}/g,
      (match, key) => TOKENS[key] ?? match,
    );
    response.writeHead(200, headers);
    response.end(text);
    return;
  }
  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
}).listen(port, () => {
  console.log(`Serving the tracker on http://localhost:${port}`);
  console.log(`  frontend: ${roots[0]}`);
  console.log(`  sample data: ${roots[1]}`);
});
