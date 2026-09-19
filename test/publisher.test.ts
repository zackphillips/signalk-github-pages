import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { normaliseConfig, type PluginConfig } from '../src/config';
import { GitHubClient } from '../src/github';
import { Publisher } from '../src/publisher';
import { StateStore } from '../src/state';
import { FakeGitHub } from './helpers/fakeGitHub';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HOME = { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 };

const tree = (over: { lat?: number; lon?: number; state?: string; timestamp?: string } = {}) => ({
  name: 'S.V.Mermug',
  navigation: {
    position: {
      value: { latitude: over.lat ?? 37.92, longitude: over.lon ?? -122.52 },
      timestamp: over.timestamp ?? '2026-03-01T20:00:00Z',
    },
    speedOverGround: { value: 4.2, timestamp: over.timestamp ?? '2026-03-01T20:00:00Z' },
    headingTrue: { value: 1.2, timestamp: over.timestamp ?? '2026-03-01T20:00:00Z' },
    state: { value: over.state ?? 'sailing' },
  },
  environment: {
    wind: { speedApparent: { value: 7.1, timestamp: over.timestamp ?? '2026-03-01T20:00:00Z' } },
    depth: { belowTransducer: { value: 12.4, timestamp: '2026-02-01T00:00:00Z' } },
  },
  electrical: { batteries: { house: { voltage: { value: 12.7 } } } },
});

describe('Publisher', () => {
  let dataDir: string;
  let fake: FakeGitHub;
  let store: StateStore;
  let logs: string[];

  const makePublisher = (overrides: Partial<PluginConfig> = {}, now = '2026-03-01T20:00:00Z') => {
    const config = normaliseConfig({
      github: { repo: 'owner/site', branch: 'main', token: 'token' },
      timezone: 'America/Los_Angeles',
      privacyZones: [HOME],
      instrumentLog: { paths: ['navigation.speedOverGround', 'electrical.batteries.*.voltage'], entries: 5 },
      ...overrides,
    } as any);
    return new Publisher({
      client: new GitHubClient({
        repo: 'owner/site',
        branch: 'main',
        token: 'token',
        fetchImpl: fake.fetch,
      }),
      store,
      config,
      identity: { name: 'S.V.Mermug', mmsi: '338543654' },
      publicDir: PUBLIC_DIR,
      version: '0.1.0',
      log: (message) => logs.push(message),
      now: () => new Date(now),
    });
  };

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skgp-'));
    store = new StateStore(dataDir);
    logs = [];
    fake = new FakeGitHub({
      repo: 'owner/site',
      branch: 'main',
      files: {
        'README.md': '# Site\n',
        'docs/mob-procedure.md': '---\ncategory: Operations\n---\n# Man Overboard\n\nStop the boat.\n',
        'docs/_template.md': '# Draft\n',
      },
    });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('publishes telemetry, the frontend, the config and the docs index on the first cycle', async () => {
    const publisher = makePublisher();
    await publisher.seed();
    const result = await publisher.runCycle(tree());

    expect(result.published).toBe(true);
    for (const expected of [
      'data/telemetry/signalk_latest.json',
      'data/telemetry/positions_index.json',
      'data/telemetry/instrument_log.json',
      'data/telemetry/tracks_index.json',
      'data/telemetry/tracks/2026-03-01.gpx',
      'data/vessel/info.yaml',
      'docs/index.json',
      'index.html',
      'assets/app.js',
      '.tracker-manifest.json',
    ]) {
      expect(fake.files.has(expected), expected).toBe(true);
    }
    expect(result.rejected).toEqual([]);
    // Files that belong to the user are untouched.
    expect(fake.files.get('README.md')).toBe('# Site\n');
  });

  it('does not republish the frontend on a later cycle', async () => {
    const publisher = makePublisher();
    await publisher.seed();
    await publisher.runCycle(tree());
    const second = await publisher.runCycle(tree({ timestamp: '2026-03-01T20:02:00Z' }));

    expect(second.files).not.toContain('assets/app.js');
    expect(second.files).toContain('data/telemetry/signalk_latest.json');
    // Nor the config, which only changes when the config page changes.
    expect(second.files).not.toContain('data/vessel/info.yaml');
  });

  it('drops stale readings from the published snapshot', async () => {
    const publisher = makePublisher();
    await publisher.runCycle(tree());
    const snapshot = JSON.parse(fake.files.get('data/telemetry/signalk_latest.json')!);
    expect(snapshot.environment.wind.speedApparent.value).toBe(7.1);
    // A month-old depth reading must not be presented as the current depth.
    expect(snapshot.environment.depth?.belowTransducer?.value).toBeUndefined();
  });

  it('publishes the zone centre and no track at all from inside a privacy zone', async () => {
    const publisher = makePublisher();
    const result = await publisher.runCycle(tree({ lat: HOME.lat + 0.0005, lon: HOME.lon }));

    expect(result.privacyZone).toBe('South Beach Harbor');
    const snapshot = JSON.parse(fake.files.get('data/telemetry/signalk_latest.json')!);
    expect(snapshot.navigation.position.value).toEqual({
      latitude: HOME.lat,
      longitude: HOME.lon,
    });
    const positions = JSON.parse(fake.files.get('data/telemetry/positions_index.json')!);
    expect(positions.positions[0].values).toHaveLength(1);
    expect(fake.files.has('data/telemetry/tracks/2026-03-01.gpx')).toBe(false);
  });

  it('paces itself off navigation.state', () => {
    const publisher = makePublisher();
    expect(publisher.intervalSeconds(tree({ state: 'sailing' }))).toBe(120);
    expect(publisher.intervalSeconds(tree({ state: 'moored' }))).toBe(3600);
    expect(publisher.intervalSeconds({})).toBe(3600);
  });

  it('keeps only the allowlisted instrument paths', async () => {
    const publisher = makePublisher();
    await publisher.runCycle(tree());
    const log = JSON.parse(fake.files.get('data/telemetry/instrument_log.json')!);
    expect(Object.keys(log.entries[0].values).sort()).toEqual([
      'electrical.batteries.house.voltage',
      'navigation.speedOverGround',
    ]);
  });

  it('writes info.yaml for the frontend and preserves a passage edited on GitHub', async () => {
    const publisher = makePublisher();
    await publisher.runCycle(tree());
    const first = yaml.load(fake.files.get('data/vessel/info.yaml')!) as any;
    expect(first.name).toBe('S.V.Mermug');
    expect(first.privacy_zones).toHaveLength(1);

    fake.commitFile(
      'data/vessel/info.yaml',
      yaml.dump({ ...first, passage: { from: 'SF', to: 'Santa Cruz' } }),
    );
    const changed = makePublisher({ site: { theme: 'deep-sea' } } as any);
    await changed.runCycle(tree());
    const second = yaml.load(fake.files.get('data/vessel/info.yaml')!) as any;
    expect(second.theme).toBe('deep-sea');
    expect(second.passage).toEqual({ from: 'SF', to: 'Santa Cruz' });
  });

  it('builds the docs index from the published Markdown, skipping drafts', async () => {
    const publisher = makePublisher();
    await publisher.runCycle(tree());
    const index = JSON.parse(fake.files.get('docs/index.json')!);
    expect(index.docs.map((entry: any) => entry.slug)).toEqual(['mob-procedure']);
    expect(index.docs[0].category).toBe('Operations');
    expect(index.docs[0].description).toBe('Stop the boat.');
  });

  it('rebuilds the docs index when a document changes, and not otherwise', async () => {
    const publisher = makePublisher();
    await publisher.runCycle(tree());
    const second = await publisher.runCycle(tree());
    expect(second.files).not.toContain('docs/index.json');

    fake.commitFile('docs/anchoring.md', '# Anchoring\n\nDrop it.\n');
    const third = await publisher.runCycle(tree());
    expect(third.files).toContain('docs/index.json');
    const index = JSON.parse(fake.files.get('docs/index.json')!);
    expect(index.docs.map((entry: any) => entry.slug).sort()).toEqual([
      'anchoring',
      'mob-procedure',
    ]);
  });

  it('seeds its rolling state from the repository after a reinstall', async () => {
    // Without this, the first commit after a reinstall truncates the day's
    // track back to a single point.
    fake.commitFile(
      'data/telemetry/positions_index.json',
      JSON.stringify({
        positions: [
          {
            timestamp: '2026-03-01T19:00:00Z',
            values: [{ path: 'navigation.position', value: { latitude: 37.9, longitude: -122.5 } }],
          },
        ],
      }),
    );
    const publisher = makePublisher();
    await publisher.seed();
    await publisher.runCycle(tree());
    const positions = JSON.parse(fake.files.get('data/telemetry/positions_index.json')!);
    expect(positions.positions).toHaveLength(2);
  });

  it('survives a cycle with no position at all', async () => {
    const publisher = makePublisher();
    const result = await publisher.runCycle({ navigation: { state: { value: 'moored' } } });
    expect(result.published).toBe(true);
    expect(fake.files.has('data/telemetry/positions_index.json')).toBe(false);
    expect(fake.files.has('data/telemetry/instrument_log.json')).toBe(true);
  });

  it('freezes yesterday once the local day rolls over', async () => {
    const yesterday = makePublisher({}, '2026-03-01T20:00:00Z');
    await yesterday.seed();
    await yesterday.runCycle(tree({ timestamp: '2026-03-01T20:00:00Z' }));
    const frozen = fake.files.get('data/telemetry/tracks/2026-03-01.gpx')!;

    // Next day, local time: the old file must not be rebuilt from whatever
    // is left of it in the 24-hour position window.
    const today = makePublisher({}, '2026-03-02T20:00:00Z');
    const result = await today.runCycle(tree({ timestamp: '2026-03-02T20:00:00Z' }));
    expect(result.files).toContain('data/telemetry/tracks/2026-03-02.gpx');
    expect(result.files).not.toContain('data/telemetry/tracks/2026-03-01.gpx');
    expect(fake.files.get('data/telemetry/tracks/2026-03-01.gpx')).toBe(frozen);
  });
});
