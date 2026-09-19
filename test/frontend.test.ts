import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFrontend, renderConstants } from '../src/frontend';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

describe('renderConstants', () => {
  const source = `var VESSEL_CONSTANTS = Object.freeze({
  GITHUB_REPO: 'zackphillips/zackphillips.github.io',
  GITHUB_DEFAULT_BRANCH: 'main',
  INSTRUMENT_LOG_ENTRIES: 120,
});`;

  it("points the edit links at the adopter's own repository", () => {
    const rendered = renderConstants(source, {
      repo: 'someone/their-site',
      branch: 'gh-pages',
      instrumentLogEntries: 120,
    });
    expect(rendered).toContain("GITHUB_REPO: 'someone/their-site'");
    expect(rendered).toContain("GITHUB_DEFAULT_BRANCH: 'gh-pages'");
  });

  it('keeps the log length in step with the publisher', () => {
    // A mismatch here means the sparklines read the wrong number of points.
    const rendered = renderConstants(source, {
      repo: 'o/r',
      branch: 'main',
      instrumentLogEntries: 240,
    });
    expect(rendered).toContain('INSTRUMENT_LOG_ENTRIES: 240');
  });

  it('still declares the constants with var, which the page depends on', () => {
    // const at the top level of a classic script does not become
    // window.VESSEL_CONSTANTS, and app.js throws on the missing global.
    expect(renderConstants(source, { repo: 'o/r', branch: 'main', instrumentLogEntries: 120 })).toMatch(
      /^var VESSEL_CONSTANTS/,
    );
  });
});

describe('loadFrontend', () => {
  it('maps the bundled files onto their published paths', async () => {
    const files = await loadFrontend(PUBLIC_DIR, {
      repo: 'owner/site',
      branch: 'main',
      instrumentLogEntries: 120,
    });
    const paths = files.map((file) => file.path);
    for (const expected of ['index.html', 'docs.html', 'assets/app.js', 'assets/styles.css', '.nojekyll']) {
      expect(paths, expected).toContain(expected);
    }
  });

  it('reads icons as binary and pages as text', async () => {
    const files = await loadFrontend(PUBLIC_DIR, {
      repo: 'owner/site',
      branch: 'main',
      instrumentLogEntries: 120,
    });
    const icon = files.find((file) => file.path === 'assets/favicon.ico');
    const page = files.find((file) => file.path === 'index.html');
    expect(Buffer.isBuffer(icon?.content)).toBe(true);
    expect(typeof page?.content).toBe('string');
  });

  it("substitutes the adopter's repository into the shipped constants", async () => {
    const files = await loadFrontend(PUBLIC_DIR, {
      repo: 'owner/site',
      branch: 'main',
      instrumentLogEntries: 120,
    });
    const constants = files.find((file) => file.path === 'assets/constants.js');
    expect(String(constants?.content)).toContain("GITHUB_REPO: 'owner/site'");
  });

  it('never ships assets/custom.css, which belongs to the user', async () => {
    await expect(fs.access(path.join(PUBLIC_DIR, 'assets', 'custom.css'))).rejects.toThrow();
  });
});
