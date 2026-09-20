import { describe, expect, it } from 'vitest';
import {
  isOwnedPath,
  isRemovablePath,
  matchesPattern,
  ownedPatterns,
  partitionOwned,
  renderManifest,
} from '../src/manifest';

const FULL = { buildDocsIndex: true };

describe('matchesPattern', () => {
  it('matches a literal path', () => {
    expect(matchesPattern('index.html', 'index.html')).toBe(true);
    expect(matchesPattern('index.html', 'docs.html')).toBe(false);
  });

  it('treats ** as any number of segments', () => {
    expect(matchesPattern('data/telemetry/**', 'data/telemetry/tracks/2026-03-01.gpx')).toBe(true);
    expect(matchesPattern('data/telemetry/**', 'data/vessel/logo.png')).toBe(false);
  });
});

describe('ownership', () => {
  it('owns the telemetry, the frontend and the generated config', () => {
    for (const path of [
      'data/telemetry/positions_index.json',
      'data/telemetry/tracks/2026-03-01.gpx',
      'data/vessel/site.json',
      'docs/index.json',
      'assets/app.js',
      'index.html',
      '.nojekyll',
    ]) {
      expect(isOwnedPath(path, FULL), path).toBe(true);
    }
  });

  it('does not own a path it has retired, but may still delete it', () => {
    // info.yaml is the file site.json replaced. It must not appear in the
    // published manifest claiming to be maintained — nothing writes it — but
    // the one-time deletion that removes it goes through the same ownership
    // check as every other deletion, so it has to pass that one.
    expect(isOwnedPath('data/vessel/info.yaml', FULL)).toBe(false);
    expect(ownedPatterns(FULL)).not.toContain('data/vessel/info.yaml');
    expect(isRemovablePath('data/vessel/info.yaml', FULL)).toBe(true);
    // A retirement is not a licence to delete the user's files.
    expect(isRemovablePath('docs/mob-procedure.md', FULL)).toBe(false);
    expect(isRemovablePath('assets/custom.css', FULL)).toBe(false);
  });

  it("never owns the user's own files", () => {
    for (const path of [
      'docs/mob-procedure.md',
      'data/vessel/logo.png',
      'data/vessel/polars.csv',
      'README.md',
      'CNAME',
      '.github/workflows/pages.yml',
    ]) {
      expect(isOwnedPath(path, FULL), path).toBe(false);
    }
  });

  it('carves assets/custom.css out of the assets directory it otherwise owns', () => {
    expect(isOwnedPath('assets/styles.css', FULL)).toBe(true);
    expect(isOwnedPath('assets/custom.css', FULL)).toBe(false);
  });

  it('leaves the polar table alone until the server has an active polar', () => {
    // A polars.csv committed by hand years ago is not the plugin's to rewrite.
    expect(isOwnedPath('data/vessel/polars.csv', FULL)).toBe(false);
    expect(isOwnedPath('data/vessel/polars.csv', { ...FULL, publishPolars: true })).toBe(true);
  });

  it('drops the docs index when the Action maintains it instead', () => {
    const minimal = { buildDocsIndex: false };
    expect(isOwnedPath('docs/index.json', minimal)).toBe(false);
    // The frontend is always the plugin's: there is no setting for it.
    expect(isOwnedPath('assets/app.js', minimal)).toBe(true);
    expect(isOwnedPath('data/telemetry/positions_index.json', minimal)).toBe(true);
  });
});

describe('partitionOwned', () => {
  it('separates what may be published from what may not', () => {
    const { owned, rejected } = partitionOwned(
      [{ path: 'data/telemetry/signalk_latest.json' }, { path: 'docs/mob-procedure.md' }],
      FULL,
    );
    expect(owned.map((f) => f.path)).toEqual(['data/telemetry/signalk_latest.json']);
    expect(rejected.map((f) => f.path)).toEqual(['docs/mob-procedure.md']);
  });
});

describe('renderManifest', () => {
  it('lists the owned patterns and the exceptions', () => {
    const manifest = JSON.parse(
      renderManifest({ ...FULL, version: '0.1.0', generated: '2026-03-01T12:00:00Z' }),
    );
    expect(manifest.owned).toContain('data/telemetry/**');
    expect(manifest.owned).not.toContain('data/vessel/polars.csv');
    expect(
      JSON.parse(
        renderManifest({
          ...FULL,
          publishPolars: true,
          version: '0.1.0',
          generated: '2026-03-01T12:00:00Z',
        }),
      ).owned,
    ).toContain('data/vessel/polars.csv');
    expect(manifest.user_owned_exceptions).toEqual(['assets/custom.css']);
    expect(manifest.version).toBe('0.1.0');
  });
});
