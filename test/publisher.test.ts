import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { GitHubClient } from '../src/github';
import { DocsExistError, INSTRUMENT_LOG_WARN_BYTES, Publisher } from '../src/publisher';
import { StateStore } from '../src/state';
import { makeConfig } from './helpers/config';
import { FakeGitHub } from './helpers/fakeGitHub';

const SITE_DIR = path.join(__dirname, '..', 'site');
const SEED_DIR = path.join(__dirname, '..', 'seed');
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

/** A history result as the reader would hand one back. */
const fromHistory = (entries: Array<{ timestamp: string; values: Record<string, number> }>) =>
  ({
    status: 'ok' as const,
    entries,
    requestedPaths: Object.keys(entries[0]?.values ?? {}),
    providerId: 'signalk-to-influxdb2',
  });

const LOG_ENTRIES = [
  { timestamp: '2026-03-01T19:58:00.000Z', values: { 'navigation.speedOverGround': 4.2 } },
  { timestamp: '2026-03-01T19:59:00.000Z', values: { 'navigation.speedOverGround': 4.4 } },
];

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
      siteDir: SITE_DIR,
      seedDir: SEED_DIR,
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
    const result = await publisher.runCycle(tree(), { history: fromHistory(LOG_ENTRIES) });

    expect(result.published).toBe(true);
    for (const expected of [
      'data/telemetry/signalk_latest.json',
      'data/telemetry/positions_index.json',
      'data/telemetry/instrument_log.json',
      'data/telemetry/tracks_index.json',
      'data/telemetry/tracks/2026-03-01.gpx',
      'data/vessel/site.json',
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
    expect(second.files).not.toContain('data/vessel/site.json');
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

  it('publishes the instrument log the history provider returned', async () => {
    const publisher = makePublisher();
    const result = await publisher.runCycle(tree(), { history: fromHistory(LOG_ENTRIES) });

    expect(result.files).toContain('data/telemetry/instrument_log.json');
    const log = JSON.parse(fake.files.get('data/telemetry/instrument_log.json')!);
    expect(log.entries).toEqual(LOG_ENTRIES);
  });

  it('publishes no instrument log at all when the provider did not answer', async () => {
    // The copy already on the site is the last good one: a sparkline a few
    // minutes stale beats a blank panel every time the database restarts.
    const publisher = makePublisher();
    await publisher.runCycle(tree(), { history: fromHistory(LOG_ENTRIES) });
    const published = fake.files.get('data/telemetry/instrument_log.json');

    const result = await publisher.runCycle(tree({ timestamp: '2026-03-01T20:02:00Z' }), {
      history: { status: 'unavailable', reason: 'influxdb is starting' },
    });
    expect(result.files).not.toContain('data/telemetry/instrument_log.json');
    expect(fake.files.get('data/telemetry/instrument_log.json')).toBe(published);
  });

  it('empties the instrument log once when there is no provider', async () => {
    const publisher = makePublisher();
    const first = await publisher.runCycle(tree(), { history: { status: 'none' } });
    expect(first.files).toContain('data/telemetry/instrument_log.json');
    expect(JSON.parse(fake.files.get('data/telemetry/instrument_log.json')!).entries).toEqual([]);

    // And not again on every cycle after that.
    const second = await publisher.runCycle(tree({ timestamp: '2026-03-01T20:02:00Z' }), {
      history: { status: 'none' },
    });
    expect(second.files).not.toContain('data/telemetry/instrument_log.json');
  });

  it('builds the track from the tree, not from the provider', async () => {
    // The position index is the plugin's own: one point per cycle, from the
    // fix it saw, through the privacy zones.
    const publisher = makePublisher();
    await publisher.runCycle(tree({ timestamp: '2026-03-01T19:00:00Z', lat: 37.9, lon: -122.5 }), {
      history: fromHistory(LOG_ENTRIES),
    });
    await publisher.runCycle(tree(), { history: fromHistory(LOG_ENTRIES) });

    const positions = JSON.parse(fake.files.get('data/telemetry/positions_index.json')!);
    expect(positions.positions.map((entry: any) => entry.timestamp)).toEqual([
      '2026-03-01T19:00:00.000Z',
      '2026-03-01T20:00:00.000Z',
    ]);
  });

  it('writes site.json for the frontend, and rewrites it only when it changes', async () => {
    const publisher = makePublisher();
    await publisher.runCycle(tree());
    const first = JSON.parse(fake.files.get('data/vessel/site.json')!);
    expect(first.schema_version).toBe(1);
    expect(first.privacy_zones).toHaveLength(1);

    const changed = makePublisher({
      site: { customLinks: [{ label: 'Starlink', url: 'https://example.com/' }] },
    });
    await changed.runCycle(tree());
    const second = JSON.parse(fake.files.get('data/vessel/site.json')!);
    expect(second.custom_links).toEqual([{ label: 'Starlink', url: 'https://example.com/' }]);
  });

  it('publishes the passage it is handed, and drops it when the course clears', async () => {
    const publisher = makePublisher();
    await publisher.runCycle(tree(), {
      passage: { to: 'Santa Cruz', departed: '2026-03-01T16:00:00Z' },
    });
    expect(JSON.parse(fake.files.get('data/vessel/site.json')!).passage).toEqual({
      to: 'Santa Cruz',
      departed: '2026-03-01T16:00:00Z',
    });

    // Arriving and clearing the destination takes the banner down by itself:
    // nobody has to remember to delete anything.
    await publisher.runCycle(tree(), { passage: null });
    expect(JSON.parse(fake.files.get('data/vessel/site.json')!).passage).toBeUndefined();
  });

  it('leaves the boat out of site.json, because the snapshot already carries it', async () => {
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
    const site = JSON.parse(fake.files.get('data/vessel/site.json')!);
    // Derived from the registrations tree, so the frontend does not have to.
    expect(site.uscg_number).toBe('1024168');
    // In signalk_latest.json, every one of them.
    expect(site.name).toBeUndefined();
    expect(site.callsign).toBeUndefined();
    expect(site.design).toBeUndefined();
    const snapshot = JSON.parse(fake.files.get('data/telemetry/signalk_latest.json')!);
    expect(snapshot.name).toBe('S.V.Mermug');
    expect(snapshot.communication.callsignVhf).toBe('WDL1234');
  });

  it('picks up a vessel name that only arrives after the plugin started', async () => {
    // A cold boot runs the first cycle before the first product-information
    // frame; an identity read once at start would stay "Vessel" until restart.
    // The GPX creator is where that name still lands.
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
      siteDir: SITE_DIR,
      seedDir: SEED_DIR,
      version: '0.1.0',
      log: (message) => logs.push(message),
      now: () => new Date('2026-03-01T20:00:00Z'),
    });
    const { name: _dropped, ...anonymous } = tree();
    await publisher.runCycle(anonymous);
    const gpxPath = [...fake.files.keys()].find((key) => key.endsWith('.gpx'))!;
    expect(fake.files.get(gpxPath)).toContain('Vessel');

    await publisher.runCycle(tree());
    expect(fake.files.get(gpxPath)).toContain('S.V.Mermug');
  });

  it('publishes the active polar once, and claims the path while it has one', async () => {
    const polars = 'twa/tws;6;10\n52;4.1;5.8\n90;5;6.7\n';
    const publisher = makePublisher();
    const first = await publisher.runCycle(tree(), { polars });
    expect(first.files).toContain('data/vessel/polars.csv');
    expect(fake.files.get('data/vessel/polars.csv')).toBe(polars);
    expect(JSON.parse(fake.files.get('.tracker-manifest.json')!).owned).toContain(
      'data/vessel/polars.csv',
    );

    const second = await publisher.runCycle(tree(), { polars });
    expect(second.files).not.toContain('data/vessel/polars.csv');
  });

  it('does not re-upload a polar table the repository already has', async () => {
    const polars = 'twa/tws;6;10\n52;4.1;5.8\n';
    fake.commitFile('data/vessel/polars.csv', polars);
    const publisher = makePublisher();
    await publisher.seed();
    const result = await publisher.runCycle(tree(), { polars });
    expect(result.files).not.toContain('data/vessel/polars.csv');
  });

  it('leaves a hand-committed polars.csv alone when no polar is active', async () => {
    fake.commitFile('data/vessel/polars.csv', 'twa/tws;6\n52;4.1\n');
    const publisher = makePublisher();
    const result = await publisher.runCycle(tree());
    expect(result.files).not.toContain('data/vessel/polars.csv');
    expect(fake.files.get('data/vessel/polars.csv')).toBe('twa/tws;6\n52;4.1\n');
    expect(JSON.parse(fake.files.get('.tracker-manifest.json')!).owned).not.toContain(
      'data/vessel/polars.csv',
    );
  });

  it('stops claiming polars.csv when the active polar is cleared, without deleting it', async () => {
    const polars = 'twa/tws;6;10\n52;4.1;5.8\n';
    const publisher = makePublisher();
    await publisher.runCycle(tree(), { polars });
    const after = await publisher.runCycle(tree());
    expect(after.files).not.toContain('data/vessel/polars.csv');
    expect(fake.files.get('data/vessel/polars.csv')).toBe(polars);
    expect(JSON.parse(fake.files.get('.tracker-manifest.json')!).owned).not.toContain(
      'data/vessel/polars.csv',
    );
  });

  describe('notifications', () => {
    const alarmed = (state: string, message = 'Shallow') => ({
      ...tree(),
      notifications: {
        environment: {
          depth: {
            belowTransducer: {
              value: { state, message },
              timestamp: '2026-03-01T19:59:00Z',
            },
          },
        },
      },
    });

    it('publishes the active set and the firing log', async () => {
      const publisher = makePublisher();
      const result = await publisher.runCycle(alarmed('alarm'));
      expect(result.files).toContain('data/telemetry/notifications.json');
      const payload = JSON.parse(fake.files.get('data/telemetry/notifications.json')!);
      expect(payload.active).toEqual([
        expect.objectContaining({
          path: 'environment.depth.belowTransducer',
          state: 'alarm',
          level: 'alert',
          message: 'Shallow',
        }),
      ]);
      expect(payload.events).toHaveLength(1);
    });

    it('counts a firing once however many cycles the alarm stays up', async () => {
      // The whole point of the edge rule: the cadence halves and doubles with
      // navigation.state, and the count must not move with it.
      const publisher = makePublisher();
      await publisher.runCycle(alarmed('normal'));
      await publisher.runCycle(alarmed('alarm'));
      await publisher.runCycle(alarmed('alarm'));
      await publisher.runCycle(alarmed('alarm'));
      const payload = JSON.parse(fake.files.get('data/telemetry/notifications.json')!);
      expect(payload.events).toHaveLength(1);
      expect(payload.active).toHaveLength(1);
    });

    it('keeps the firing log across a restart', async () => {
      await makePublisher().runCycle(alarmed('normal'));
      await makePublisher().runCycle(alarmed('alarm'));
      // A new Publisher over the same data dir is what a server restart is.
      await makePublisher().runCycle(alarmed('alarm'));
      const payload = JSON.parse(fake.files.get('data/telemetry/notifications.json')!);
      expect(payload.events).toHaveLength(1);
    });

    it('reports firings and the active set on the status line', async () => {
      const publisher = makePublisher();
      await publisher.runCycle(alarmed('normal'));
      logs.length = 0;
      await publisher.runCycle(alarmed('alarm'));
      expect(logs.some((line) => line.includes('1 fired this cycle'))).toBe(true);
      expect(logs.some((line) => line.includes('1 active'))).toBe(true);
    });

    it('publishes nothing and claims nothing when the setting is off', async () => {
      const publisher = makePublisher({ publishNotifications: false });
      const result = await publisher.runCycle(alarmed('alarm'));
      expect(result.files).not.toContain('data/telemetry/notifications.json');
      expect(fake.files.has('data/telemetry/notifications.json')).toBe(false);
      expect(await store.readText('notifications_log.json')).toBeNull();
    });
  });


  describe("the ship's docs", () => {
    /** A repository with the frontend published but no documents at all. */
    const empty = () => {
      fake = new FakeGitHub({
        repo: 'owner/site',
        branch: 'main',
        files: { 'README.md': '# Site\n', 'index.html': '<!doctype html>' },
      });
      return makePublisher();
    };

    it('reports what docs/ holds, ignoring drafts and agent instructions', async () => {
      fake.commitFile('docs/AGENTS.md', '# Agents\n');
      const status = await makePublisher().docsStatus();

      expect(status.initialized).toBe(true);
      // docs/_template.md is a draft and docs/AGENTS.md is not a document.
      expect(status.documentPaths).toEqual(['docs/mob-procedure.md']);
      expect(status.missing).toEqual(['docs/ships-docs.md']);
      expect(status.maintenanceLog).toEqual({ path: 'docs/maintenance/log.md', exists: false });
    });

    it('writes the starter set into a repository with no documents', async () => {
      const publisher = empty();
      const before = fake.commits.length;
      const result = await publisher.initializeDocs();

      expect(result.created).toEqual(['docs/AGENTS.md', 'docs/ships-docs.md']);
      expect(fake.commits.length).toBe(before + 1);
      expect(fake.files.get('docs/ships-docs.md')).toContain('S.V.Mermug');
      expect(fake.files.get('docs/ships-docs.md')).toContain('owner/site');
      expect(fake.files.get('docs/AGENTS.md')).toContain('AGENTS.md');
      expect(result.status.initialized).toBe(true);
    });

    it('refuses outright once the repository has a document of its own', async () => {
      // The fixture repository already carries docs/mob-procedure.md. A boat
      // with its own docs does not want this plugin's opinion about them, and
      // the refusal is what makes the button safe to press twice.
      const publisher = makePublisher();
      const before = fake.commits.length;

      await expect(publisher.initializeDocs()).rejects.toBeInstanceOf(DocsExistError);
      expect(fake.commits.length).toBe(before);
      expect(fake.files.has('docs/ships-docs.md')).toBe(false);
    });

    it('completes a half-written starter set without touching the half that is there', async () => {
      const publisher = empty();
      fake.commitFile('docs/AGENTS.md', '# My own agent rules\n');
      const result = await publisher.initializeDocs();

      expect(result.created).toEqual(['docs/ships-docs.md']);
      expect(result.skipped).toEqual(['docs/AGENTS.md']);
      expect(fake.files.get('docs/AGENTS.md')).toBe('# My own agent rules\n');
    });

    it('still offers the starter set to a repository whose only doc is the log', async () => {
      // Logging an oil change before pressing the button must not lock the
      // starter set out: the log is the plugin's own doing, not evidence that
      // the boat has documentation of its own.
      const publisher = empty();
      await publisher.addMaintenanceEntry({ date: '2026-03-01', title: 'Oil change' });
      const status = await publisher.docsStatus();

      expect(status.initialized).toBe(true);
      expect(status.ownDocuments).toBe(0);
      expect(status.canInitialize).toBe(true);
      expect((await publisher.initializeDocs()).created).toEqual([
        'docs/AGENTS.md',
        'docs/ships-docs.md',
      ]);
      expect(fake.files.get('docs/maintenance/log.md')).toContain('## 2026-03-01: Oil change');
    });

    it('starts the maintenance log with the first entry', async () => {
      const publisher = makePublisher();
      const result = await publisher.addMaintenanceEntry({
        date: '2026-03-01',
        title: 'Replaced the raw-water impeller',
        system: 'Engine',
        engineHours: 1204.5,
      });

      expect(result.created).toBe(true);
      expect(result.path).toBe('docs/maintenance/log.md');
      const log = fake.files.get('docs/maintenance/log.md')!;
      expect(log).toContain('category: Maintenance');
      expect(log).toContain('## 2026-03-01: Replaced the raw-water impeller');
      expect(log).toContain('- Engine hours: 1204.5');
      expect(fake.commits[fake.commits.length - 1]!.message).toBe(
        'Maintenance 2026-03-01: Replaced the raw-water impeller',
      );
    });

    it('adds later entries at the top, keeping what is already logged', async () => {
      const publisher = makePublisher();
      await publisher.addMaintenanceEntry({ date: '2026-02-01', title: 'Oil change' });
      // Edited on GitHub between the two entries: the published copy is read
      // back every time, so nothing here is composed against a local cache.
      fake.commitFile(
        'docs/maintenance/log.md',
        `${fake.files.get('docs/maintenance/log.md')}\nA note added from a phone.\n`,
      );
      const result = await publisher.addMaintenanceEntry({
        date: '2026-03-01',
        title: 'New impeller',
      });

      expect(result.created).toBe(false);
      const log = fake.files.get('docs/maintenance/log.md')!;
      const headings = [...log.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
      expect(headings).toEqual(['2026-03-01: New impeller', '2026-02-01: Oil change']);
      expect(log).toContain('A note added from a phone.');
    });

    it('writes nothing but the log when an entry is added', async () => {
      const publisher = makePublisher();
      const before = new Map(fake.files);
      await publisher.addMaintenanceEntry({ date: '2026-03-01', title: 'Oil change' });

      const changed = [...fake.files.entries()].filter(
        ([path, contents]) => before.get(path) !== contents,
      );
      expect(changed.map(([path]) => path)).toEqual(['docs/maintenance/log.md']);
    });

    it('never writes a document on a normal cycle', async () => {
      // The manifest is what enforces this, and it is the reason the console's
      // two writes are the only way into docs/ at all.
      const publisher = makePublisher();
      await publisher.seed();
      const result = await publisher.runCycle(tree(), { history: fromHistory(LOG_ENTRIES) });

      expect(result.files.filter((file) => /^docs\/.*\.md$/.test(file))).toEqual([]);
      expect(result.files).toContain('docs/index.json');
    });
  });

  describe('pruning voyages', () => {
    const INDEX = {
      schema_version: 1,
      tracks: ['2026-01-02', '2026-02-14', '2026-02-28', '2026-03-01'].map((date) => ({
        date,
        file: `tracks/${date}.gpx`,
        start: `${date}T15:00:00Z`,
        end: `${date}T23:00:00Z`,
        duration_hours: 8,
        points: 240,
        max_speed_kts: 7.2,
        distance_nm: 34.1,
      })),
    };

    /** A repository that already carries four days, and state to match. */
    const seeded = async () => {
      for (const track of INDEX.tracks) {
        fake.commitFile(`data/telemetry/${track.file}`, `<gpx>${track.date}</gpx>`);
      }
      fake.commitFile('data/telemetry/tracks_index.json', JSON.stringify(INDEX));
      await store.writeText('tracks_index.json', JSON.stringify(INDEX));
      await store.mergeState({ publishedDays: INDEX.tracks.map((t) => t.date) });
      return makePublisher({ timezone: 'America/Los_Angeles' });
    };

    it('lists what is published, newest first', async () => {
      const publisher = await seeded();
      expect((await publisher.listTracks()).map((t) => t.date)).toEqual([
        '2026-03-01',
        '2026-02-28',
        '2026-02-14',
        '2026-01-02',
      ]);
    });

    it('removes the GPX files and rewrites the index in one commit', async () => {
      const publisher = await seeded();
      const before = fake.commits.length;
      const { plan, commitSha } = await publisher.pruneTracks({ olderThanDays: 7 });

      expect(plan.remove.map((t) => t.date)).toEqual(['2026-01-02', '2026-02-14']);
      expect(commitSha).toBeTruthy();
      expect(fake.commits.length).toBe(before + 1);
      expect(fake.commits[fake.commits.length - 1]!.message).toBe(
        'Remove 2 voyages (2026-01-02 to 2026-02-14)',
      );
      expect(fake.files.has('data/telemetry/tracks/2026-01-02.gpx')).toBe(false);
      expect(fake.files.has('data/telemetry/tracks/2026-02-14.gpx')).toBe(false);
      // What is kept is untouched, including today's.
      expect(fake.files.get('data/telemetry/tracks/2026-03-01.gpx')).toBe('<gpx>2026-03-01</gpx>');
      const index = JSON.parse(fake.files.get('data/telemetry/tracks_index.json')!);
      expect(index.tracks.map((t: any) => t.date)).toEqual(['2026-02-28', '2026-03-01']);
    });

    it('lets a pruned day come back, by dropping it from publishedDays', async () => {
      // publishedDays exists to stop a past day being rebuilt from a position
      // index that no longer covers it. Leaving a pruned day in it would be a
      // day that could never return even with its points still in the window.
      const publisher = await seeded();
      await publisher.pruneTracks({ olderThanDays: 7 });
      expect((await store.readState()).publishedDays).toEqual(['2026-02-28', '2026-03-01']);
    });

    it('commits nothing when there is nothing old enough', async () => {
      const publisher = await seeded();
      const before = fake.commits.length;
      const { plan, commitSha } = await publisher.pruneTracks({ olderThanDays: 365 });
      expect(plan.remove).toEqual([]);
      expect(commitSha).toBeUndefined();
      expect(fake.commits.length).toBe(before);
    });

    it('keeps today when asked to remove everything', async () => {
      const publisher = await seeded();
      const { plan } = await publisher.pruneTracks({ olderThanDays: null });
      expect(plan.remove.map((t) => t.date)).toEqual(['2026-01-02', '2026-02-14', '2026-02-28']);
      expect(fake.files.get('data/telemetry/tracks/2026-03-01.gpx')).toBeTruthy();
    });

    it('skips a voyage file that is already gone rather than failing the prune', async () => {
      // The Git Data API rejects the whole tree with a 422 if one entry names
      // a path the base tree does not have. A day deleted by hand on GitHub
      // would otherwise take the rest of the prune down with it.
      const publisher = await seeded();
      fake.files.delete('data/telemetry/tracks/2026-01-02.gpx');
      const { plan, commitSha } = await publisher.pruneTracks({ olderThanDays: 7 });
      expect(commitSha).toBeTruthy();
      expect(plan.remove.map((t) => t.date)).toEqual(['2026-01-02', '2026-02-14']);
      expect(fake.files.has('data/telemetry/tracks/2026-02-14.gpx')).toBe(false);
      // Both days leave the index, whether or not their file was still there.
      const index = JSON.parse(fake.files.get('data/telemetry/tracks_index.json')!);
      expect(index.tracks.map((t: any) => t.date)).toEqual(['2026-02-28', '2026-03-01']);
      expect(logs.join(' ')).toContain('already gone');
    });

    it('does not disturb anything else in the repository', async () => {
      const publisher = await seeded();
      fake.commitFile('docs/passage-notes.md', '# Notes');
      await publisher.pruneTracks({ olderThanDays: null });
      expect(fake.files.get('docs/passage-notes.md')).toBe('# Notes');
    });
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
    const result = await publisher.runCycle(
      { navigation: { state: { value: 'moored' } } },
      { history: fromHistory(LOG_ENTRIES) },
    );
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

describe('cycle accounting', () => {
  let dataDir: string;
  let fake: FakeGitHub;
  let logs: string[];

  /** A history answer of `entries` buckets, each carrying `paths` values. */
  const historyOf = (entries: number, paths: number) => {
    const values: Record<string, number> = {};
    for (let i = 0; i < paths; i += 1) values[`electrical.batteries.bank${i}.voltage`] = 12.6;
    return fromHistory(
      Array.from({ length: entries }, (_unused, index) => ({
        timestamp: `2026-03-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
        values,
      })),
    );
  };

  const run = async (config: Record<string, any> = {}, logEntries = 2) => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skgp-stats-'));
    fake = new FakeGitHub({ repo: 'owner/site', branch: 'main' });
    logs = [];
    const publisher = new Publisher({
      client: new GitHubClient({
        repo: 'owner/site',
        branch: 'main',
        token: 'token',
        fetchImpl: fake.fetch,
      }),
      store: new StateStore(dataDir),
      config: makeConfig({ buildDocsIndex: false, ...config }),
      identity: { name: 'S.V.Mermug', mmsi: '338543654' },
      siteDir: SITE_DIR,
      seedDir: SEED_DIR,
      version: '0.1.0',
      log: (message) => logs.push(message),
      now: () => new Date('2026-03-01T20:00:00Z'),
    });
    const result = await publisher.runCycle(tree(), {
      history: historyOf(logEntries, logEntries > 2 ? 120 : 1),
    });
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
    // A log the size one gets from asking for every bank at a fine
    // resolution, which is when the upload starts to matter.
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
