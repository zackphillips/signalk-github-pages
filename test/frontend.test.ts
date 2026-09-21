import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  frontendOptions,
  loadFrontend,
  renderConstants,
  renderServiceWorker,
  substituteTokens,
  template,
  type FrontendOptions,
} from '../src/frontend';
import { makeConfig } from './helpers/config';

const SITE_DIR = path.join(__dirname, '..', 'site');

/** Complete options; each test overrides the part it is about. */
const options = (overrides: Partial<FrontendOptions> = {}): FrontendOptions => ({
  repo: 'owner/site',
  branch: 'main',
  version: '1.2.3',
  vesselName: 'Vessel',
  siteUrl: 'https://owner.github.io/site/',
  logoPath: 'data/vessel/logo.png',
  iconPath: 'assets/icon.svg',
  iconType: 'image/svg+xml',
  basePath: '/site/',
  ...overrides,
});

describe('renderConstants', () => {
  const source = `var VESSEL_CONSTANTS = Object.freeze({
  GITHUB_REPO: 'OWNER/REPO',
  GITHUB_DEFAULT_BRANCH: 'main',
});`;

  it("points the edit links at the adopter's own repository", () => {
    const rendered = renderConstants(
      source,
      options({ repo: 'someone/their-site', branch: 'gh-pages' }),
    );
    expect(rendered).toContain("GITHUB_REPO: 'someone/their-site'");
    expect(rendered).toContain("GITHUB_DEFAULT_BRANCH: 'gh-pages'");
  });

  it('still declares the constants with var, which the page depends on', () => {
    // const at the top level of a classic script does not become
    // window.VESSEL_CONSTANTS, and app.js throws on the missing global.
    expect(renderConstants(source, options())).toMatch(/^var VESSEL_CONSTANTS/);
  });

  it('refuses to publish a constants file it could not substitute', () => {
    // Failing open here shipped the placeholder, and every adopter's "edit on
    // GitHub" link pointed at whatever repository the placeholder named.
    expect(() => renderConstants('var VESSEL_CONSTANTS = {};', options())).toThrow(
      /GITHUB_REPO/,
    );
  });
});

describe('substituteTokens', () => {
  it('escapes a value for the file it is going into', () => {
    const name = 'Nancy "Nan" Blackett';
    expect(
      substituteTokens('<meta content="{{VESSEL_NAME}}" />', { VESSEL_NAME: name }, (v) =>
        v.replace(/"/g, '&quot;'),
      ),
    ).toBe('<meta content="Nancy &quot;Nan&quot; Blackett" />');
  });

  it('leaves an unknown token alone rather than blanking it', () => {
    // A visible {{TOKEN}} is a bug someone reports; an empty og:title is one
    // nobody sees until a shared link looks wrong.
    expect(substituteTokens('{{NOPE}}', { VESSEL_NAME: 'x' }, (v) => v)).toBe('{{NOPE}}');
  });
});

describe('template', () => {
  it('fills the social-preview tags a crawler reads without running the page', () => {
    const source =
      '<meta property="og:title" content="{{VESSEL_NAME}} — Live Vessel Tracker" />\n' +
      '<meta property="og:url" content="{{SITE_URL}}" />\n' +
      '<meta property="og:image" content="{{LOGO_URL}}" />';
    const rendered = template(
      'index.html',
      source,
      options({ vesselName: 'Mermug', siteUrl: 'https://example.com/' }),
    );
    expect(rendered).toContain('content="Mermug — Live Vessel Tracker"');
    expect(rendered).toContain('content="https://example.com/"');
    expect(rendered).toContain('content="https://example.com/data/vessel/logo.png"');
  });

  it('escapes a vessel name for HTML rather than breaking the attribute', () => {
    const rendered = template(
      'index.html',
      '<meta content="{{VESSEL_NAME}}" />',
      options({ vesselName: 'Nancy "Nan" Blackett' }),
    );
    expect(rendered).toContain('&quot;Nan&quot;');
    expect(rendered).not.toContain('"Nan"');
  });

  it('escapes a vessel name for JSON, so the manifest still parses', () => {
    const rendered = template(
      'manifest.json',
      '{ "short_name": "{{VESSEL_NAME}}" }',
      options({ vesselName: 'Nancy "Nan" Blackett' }),
    );
    expect(JSON.parse(rendered).short_name).toBe('Nancy "Nan" Blackett');
  });

  it('scopes an installed project site to its own path', () => {
    // start_url "/" on a project site takes over the owner's whole github.io
    // domain once the page is added to a home screen.
    const rendered = template(
      'manifest.json',
      '{ "start_url": "{{BASE_PATH}}", "scope": "{{BASE_PATH}}" }',
      options({ basePath: '/tracker/' }),
    );
    expect(JSON.parse(rendered)).toEqual({ start_url: '/tracker/', scope: '/tracker/' });
  });

  it('leaves a file that carries no tokens untouched', () => {
    expect(template('assets/styles.css', 'body { color: red }', options())).toBe(
      'body { color: red }',
    );
  });
});

describe('frontendOptions', () => {
  it('falls back to the hand-committed logo path and the generic icon', () => {
    const resolved = frontendOptions(makeConfig(), 'Vessel', '1.0.0');
    expect(resolved.logoPath).toBe('data/vessel/logo.png');
    expect(resolved.iconPath).toBe('assets/icon.svg');
    expect(resolved.iconType).toBe('image/svg+xml');
  });

  it('uses a configured logo for the image, and the generic icon when none is set', () => {
    const config = makeConfig({
      site: { logo: 'data:image/svg+xml;base64,PHN2Zy8+' },
    });
    const resolved = frontendOptions(config, 'Vessel', '1.0.0');
    expect(resolved.logoPath).toBe('data/vessel/logo.svg');
    expect(resolved.iconPath).toBe('assets/icon.svg');
    expect(resolved.iconType).toBe('image/svg+xml');
  });

  it('uses a configured icon independently of the logo', () => {
    const config = makeConfig({
      site: {
        logo: 'data:image/png;base64,iVBORw0KGgo=',
        icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      },
    });
    const resolved = frontendOptions(config, 'Vessel', '1.0.0');
    expect(resolved.logoPath).toBe('data/vessel/logo.png');
    expect(resolved.iconPath).toBe('data/vessel/icon.svg');
    expect(resolved.iconType).toBe('image/svg+xml');
  });

  it('derives the site address and base path from the repository', () => {
    const resolved = frontendOptions(makeConfig(), 'Vessel', '1.0.0');
    expect(resolved.siteUrl).toBe('https://owner.github.io/site/');
    expect(resolved.basePath).toBe('/site/');
  });
});

describe('loadFrontend', () => {
  it('maps the bundled files onto their published paths', async () => {
    const files = await loadFrontend(SITE_DIR, options());
    const paths = files.map((file) => file.path);
    for (const expected of [
      'index.html',
      'docs.html',
      'manifest.json',
      'assets/app.js',
      'assets/styles.css',
      'assets/icon.svg',
      '.nojekyll',
    ]) {
      expect(paths, expected).toContain(expected);
    }
  });

  it('reads an image as binary and a page as text', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<title>{{VESSEL_NAME}}</title>');
    await fs.writeFile(path.join(dir, 'burgee.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const files = await loadFrontend(dir, options({ vesselName: 'Mermug' }));
    const image = files.find((file) => file.path === 'burgee.png');
    const page = files.find((file) => file.path === 'index.html');
    expect(Buffer.isBuffer(image?.content)).toBe(true);
    expect(page?.content).toBe('<title>Mermug</title>');
  });

  it("substitutes the adopter's repository into the shipped constants", async () => {
    const files = await loadFrontend(SITE_DIR, options({ repo: 'owner/site' }));
    const constants = files.find((file) => file.path === 'assets/constants.js');
    expect(String(constants?.content)).toContain("GITHUB_REPO: 'owner/site'");
  });

  it('leaves no placeholder in anything it publishes', async () => {
    // A {{TOKEN}} reaching the repository is a page that names nobody's boat.
    const files = await loadFrontend(SITE_DIR, options({ vesselName: 'Mermug' }));
    for (const file of files) {
      if (typeof file.content !== 'string') continue;
      expect(file.content, file.path).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  it('never ships assets/custom.css, which belongs to the user', async () => {
    await expect(fs.access(path.join(SITE_DIR, 'assets', 'custom.css'))).rejects.toThrow();
  });
});

describe('renderServiceWorker', () => {
  const source = `const SITE_VERSION  = '0.0.0-dev';\nconst SHELL_CACHE = \`tracker-shell-\${SITE_VERSION}\`;`;

  it('names the shell cache after the release', () => {
    // A constant cache name is why a phone kept serving one release's HTML and
    // JavaScript against the next release's telemetry, for as long as it had
    // ever loaded the site.
    const rendered = renderServiceWorker(source, options({ version: '0.2.0' }));
    expect(rendered).toContain("SITE_VERSION  = '0.2.0'");
    expect(rendered).not.toContain('0.0.0-dev');
  });
});

describe('the shipped service worker', () => {
  const read = async () => fs.readFile(path.join(SITE_DIR, 'sw.js'), 'utf-8');

  it('carries a SITE_VERSION for the publisher to substitute', async () => {
    expect(await read()).toMatch(/SITE_VERSION\s*=\s*'[^']*'/);
  });

  it('never caches published data ahead of the network', async () => {
    const source = await read();
    // info.yaml used to be pre-cached with the shell, so a config change on
    // the boat never reached a device that had visited before.
    expect(source).not.toContain("'/data/vessel/info.yaml'");
    expect(source).toContain("url.pathname.startsWith('/data/')");
  });

  it('gets the version substituted on the way into the repository', async () => {
    const files = await loadFrontend(SITE_DIR, options({ version: '9.9.9' }));
    const worker = files.find((file) => file.path === 'sw.js');
    expect(String(worker?.content)).toContain("'9.9.9'");
  });
});
