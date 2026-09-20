import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { GitHubClient } from '../src/github';
import { INSTRUMENT_LOG_WARN_BYTES, Publisher } from '../src/publisher';
import { StateStore } from '../src/state';
import { makeConfig } from './helpers/config';
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

  const makePublisher = (overrides: Record<string, any> = {}, now = '2026-03-01T20:00:00Z') => {
    const config = makeConfig({
      privacyZones: [HOME],
      instrumentLog: {
        paths: 'navigation.speedOverGround\nelectrical.batteries.*.voltage\n',
        entries: 5,
      },
      ...overrides,
    });
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
    const changed = makePublisher({ site: { theme: 'bright' } });
    await changed.runCycle(tree());
    const second = yaml.load(fake.files.get('data/vessel/info.yaml')!) as any;
    expect(second.theme).toBe('bright');
    expect(second.passage).toEqual({ from: 'SF', to: 'Santa Cruz' });
  });

  it('fills info.yaml from the Signal K tree, not from the config page', async () => {
    const publisher = makePublisher();
    await publisher.runCycle({
      ...tree(),
      name: 'S.V.Mermug',
      mmsi: '338543654',
      communication: { callsignVhf: 'WDL1234' },
      registrations: {
        national: { usa: { registrationNumber: '1024168', description: 'USCG documentation' } },
      },
      design: { draft: { value: { maximum: 2.13 } }, beam: { value: 3.99 } },
    });
    const info = yaml.load(fake.files.get('data/vessel/info.yaml')!) as any;
    expect(info.callsign).toBe('WDL1234');
    expect(info.uscg_number).toBe('1024168');
    expect(info.design).toEqual({ draft_max_m: 2.13, beam_m: 3.99 });
  });

  it('picks up a vessel name that only arrives after the plugin started', async () => {
    // A cold boot runs the first cycle before the first product-information
    // frame; an identity read once at start would stay "Vessel" until restart.
    const publisher = new Publisher({
      client: new GitHubClient({
        repo: 'owner/site',
        branch: 'main',
        token: 'token',
        fetchImpl: fake.fetch,
      }),
      store,
      config: makeConfig(),
      identity: { name: 'Vessel', mmsi: '' },
      publicDir: PUBLIC_DIR,
      version: '0.1.0',
      log: (message) => logs.push(message),
      now: () => new Date('2026-03-01T20:00:00Z'),
    });
    const { name: _dropped, ...anonymous } = tree();
    await publisher.runCycle(anonymous);
    expect((yaml.load(fake.files.get('data/vessel/info.yaml')!) as any).name).toBe('Vessel');

    await publisher.runCycle(tree());
    expect((yaml.load(fake.files.get('data/vessel/info.yaml')!) as any).name).toBe('S.V.Mermug');
  });

  it('publishes a polar table pasted into the config, once', async () => {
    const publisher = makePublisher({ polars: 'twa/tws;6;10\n52;4.1;5.8\n90;5.0;6.7\n' });
    const first = await publisher.runCycle(tree());
    expect(first.files).toContain('data/vessel/polars.csv');
    expect(fake.files.get('data/vessel/polars.csv')).toBe('twa/tws;6;10\n52;4.1;5.8\n90;5;6.7\n');
    expect(JSON.parse(fake.files.get('.tracker-manifest.json')!).owned).toContain(
      'data/vessel/polars.csv',
    );

    const second = await publisher.runCycle(tree());
    expect(second.files).not.toContain('data/vessel/polars.csv');
  });

  it('does not re-upload a polar table the repository already has', async () => {
    const polars = 'twa/tws;6;10\n52;4.1;5.8\n';
    fake.commitFile('data/vessel/polars.csv', polars);
    const publisher = makePublisher({ polars });
    await publisher.seed();
    const result = await publisher.runCycle(tree());
    expect(result.files).not.toContain('data/vessel/polars.csv');
  });

  it('leaves a hand-committed polars.csv alone when the config has none', async () => {
    fake.commitFile('data/vessel/polars.csv', 'twa/tws;6\n52;4.1\n');
    const publisher = makePublisher();
    const result = await publisher.runCycle(tree());
    expect(result.files).not.toContain('data/vessel/polars.csv');
    expect(fake.files.get('data/vessel/polars.csv')).toBe('twa/tws;6\n52;4.1\n');
    expect(JSON.parse(fake.files.get('.tracker-manifest.json')!).owned).not.toContain(
      'data/vessel/polars.csv',
    );
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

  it('publishes a track read back from the history provider, not just the live fix', async () => {
    const publisher = makePublisher();
    const result = await publisher.runCycle(tree(), {
      providerId: 'signalk-to-influxdb2',
      requestedPaths: ['navigation.speedOverGround'],
      positions: [
        {
          timestamp: '2026-03-01T19:00:00.000Z',
          values: [
            { path: 'navigation.position', value: { latitude: 37.9, longitude: -122.5 } },
          ],
        },
        {
          timestamp: '2026-03-01T19:30:00.000Z',
          values: [
            { path: 'navigation.position', value: { latitude: 37.91, longitude: -122.51 } },
          ],
        },
      ],
      instrument: [
        { timestamp: '2026-03-01T19:00:00.000Z', values: { 'navigation.speedOverGround': 3.9 } },
        { timestamp: '2026-03-01T19:30:00.000Z', values: { 'navigation.speedOverGround': 4.0 } },
      ],
    });

    expect(result.published).toBe(true);
    const positions = JSON.parse(fake.files.get('data/telemetry/positions_index.json')!);
    // Two from history plus the live fix, oldest first.
    expect(positions.positions.map((entry: any) => entry.timestamp)).toEqual([
      '2026-03-01T19:00:00.000Z',
      '2026-03-01T19:30:00.000Z',
      '2026-03-01T20:00:00.000Z',
    ]);
    const log = JSON.parse(fake.files.get('data/telemetry/instrument_log.json')!);
    expect(log.entries.map((entry: any) => entry.values['navigation.speedOverGround'])).toEqual([
      3.9, 4.0, 4.2,
    ]);
    // The GPX drawn for the day follows the history, not the publish cadence.
    expect(fake.files.get('data/telemetry/tracks/2026-03-01.gpx')).toContain(
      'lat="37.900000"',
    );
  });

  it('lets the live reading win the bucket it shares with the provider', async () => {
    // The newest bucket in a database is up to one resolution behind; the
    // sparkline has to end at what the boat is doing now.
    const publisher = makePublisher();
    await publisher.runCycle(tree(), {
      providerId: 'default',
      requestedPaths: [],
      positions: [],
      instrument: [
        { timestamp: '2026-03-01T20:00:30.000Z', values: { 'navigation.speedOverGround': 9.9 } },
      ],
    });
    const log = JSON.parse(fake.files.get('data/telemetry/instrument_log.json')!);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].values['navigation.speedOverGround']).toBe(4.2);
  });

  it('keeps locally accumulated history the provider does not have', async () => {
    // A database installed this week holds nothing from last week's passage,
    // and switching to it must not shorten a track already published.
    const publisher = makePublisher();
    await publisher.runCycle(tree({ timestamp: '2026-03-01T19:00:00Z', lat: 37.9, lon: -122.5 }));
    const result = await publisher.runCycle(tree(), {
      providerId: 'default',
      requestedPaths: [],
      positions: [
        {
          timestamp: '2026-03-01T19:45:00.000Z',
          values: [
            { path: 'navigation.position', value: { latitude: 37.91, longitude: -122.51 } },
          ],
        },
      ],
      instrument: [],
    });

    expect(result.published).toBe(true);
    const positions = JSON.parse(fake.files.get('data/telemetry/positions_index.json')!);
    expect(positions.positions.map((entry: any) => entry.timestamp)).toEqual([
      '2026-03-01T19:00:00.000Z',
      '2026-03-01T19:45:00.000Z',
      '2026-03-01T20:00:00.000Z',
    ]);
  });

  it('redacts a history position that falls inside a privacy zone', async () => {
    const publisher = makePublisher();
    await publisher.runCycle(tree(), {
      providerId: 'default',
      requestedPaths: [],
      positions: [
        {
          // Already redacted upstream by positionEntriesFromHistory; what is
          // checked here is that the publisher does not re-expand it.
          timestamp: '2026-03-01T19:30:00.000Z',
          values: [
            { path: 'navigation.position', value: { latitude: HOME.lat, longitude: HOME.lon } },
          ],
        },
      ],
      instrument: [],
    });
    const positions = JSON.parse(fake.files.get('data/telemetry/positions_index.json')!);
    expect(positions.positions[0].values).toEqual([
      { path: 'navigation.position', value: { latitude: HOME.lat, longitude: HOME.lon } },
    ]);
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

describe('cycle accounting', () => {
  let dataDir: string;
  let fake: FakeGitHub;
  let logs: string[];

  const run = async (config: Record<string, any> = {}, seededEntries = 0) => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skgp-stats-'));
    fake = new FakeGitHub({ repo: 'owner/site', branch: 'main' });
    logs = [];
    if (seededEntries > 0) {
      // A log that has been running for days, which is when the size starts
      // to matter.
      const values: Record<string, number> = {};
      for (let i = 0; i < 120; i += 1) values[`electrical.batteries.bank${i}.voltage`] = 12.6;
      await new StateStore(dataDir).writeText(
        'instrument_log.json',
        JSON.stringify({
          schema_version: 1,
          entries: Array.from({ length: seededEntries }, (_unused, index) => ({
            timestamp: `2026-03-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
            values,
          })),
        }),
      );
    }
    const publisher = new Publisher({
      client: new GitHubClient({
        repo: 'owner/site',
        branch: 'main',
        token: 'token',
        fetchImpl: fake.fetch,
      }),
      store: new StateStore(dataDir),
      config: makeConfig({ publishFrontend: false, buildDocsIndex: false, ...config }),
      identity: { name: 'S.V.Mermug', mmsi: '338543654' },
      publicDir: PUBLIC_DIR,
      version: '0.1.0',
      log: (message) => logs.push(message),
      now: () => new Date('2026-03-01T20:00:00Z'),
    });
    const result = await publisher.runCycle(tree());
    await fs.rm(dataDir, { recursive: true, force: true });
    return { result, logs };
  };

  it('reports what the cycle cost on the wire', async () => {
    const { result } = await run();
    expect(result.bytes).toBeGreaterThan(0);
    // Request bodies are base64 JSON, so they are always larger than the
    // content — that gap is the reason the path allowlist exists.
    expect(result.requests.bytesUploaded).toBeGreaterThan(result.bytes);
    expect(result.requests.requests).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ranks the published files by size, largest first', async () => {
    const { result } = await run();
    const sizes = result.fileSizes.map((file) => file.bytes);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(result.fileSizes.map((file) => file.path)).toContain(
      'data/telemetry/instrument_log.json',
    );
  });

  it('logs the commit, the size and the API call count', async () => {
    const { logs } = await run();
    const published = logs.find((line) => line.startsWith('Published '));
    expect(published).toMatch(/file\(s\)/);
    expect(published).toMatch(/API call\(s\)/);
    expect(published).toMatch(/request bodies/);
  });

  it('warns, with the hourly cost and the fix, once the log dominates a cycle', async () => {
    const { result, logs } = await run(
      { instrumentLog: { paths: 'electrical.batteries.*.voltage', entries: 200 } },
      200,
    );
    const logFile = result.fileSizes.find(
      (file) => file.path === 'data/telemetry/instrument_log.json',
    )!;
    expect(logFile.bytes).toBeGreaterThan(INSTRUMENT_LOG_WARN_BYTES);
    const warning = logs.find((line) => line.includes('uploaded in full'))!;
    expect(warning).toContain('per hour');
    expect(warning).toContain('Shorten the captured-path list');
  });

  it('stays quiet about size when the log is small', async () => {
    const { logs } = await run();
    expect(logs.some((line) => line.includes('uploaded in full'))).toBe(false);
  });
});
