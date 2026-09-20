import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { renderPreviewData } from '../src/preview';
import { StateStore } from '../src/state';
import { makeConfig } from './helpers/config';

const HOME = { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 };
const NOW = new Date('2026-03-01T20:00:00Z');

const tree = (over: { lat?: number; lon?: number } = {}) => ({
  name: 'S.V.Mermug',
  navigation: {
    position: {
      value: { latitude: over.lat ?? 37.92, longitude: over.lon ?? -122.52 },
      timestamp: '2026-03-01T20:00:00Z',
    },
    speedOverGround: { value: 4.2, timestamp: '2026-03-01T20:00:00Z' },
    state: { value: 'sailing' },
  },
  environment: {
    wind: { speedApparent: { value: 7.1, timestamp: '2026-03-01T20:00:00Z' } },
    // Two days stale: the publisher drops this, and so must the preview.
    depth: { belowTransducer: { value: 12.4, timestamp: '2026-02-01T00:00:00Z' } },
  },
});

describe('renderPreviewData', () => {
  let dataDir: string;
  let store: StateStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-'));
    store = new StateStore(dataDir);
  });
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const render = (over: Record<string, any> = {}, input: Record<string, any> = {}) =>
    renderPreviewData(
      {
        config: makeConfig({ timezone: 'America/Los_Angeles', privacyZones: [HOME], ...over }),
        store,
        identity: { name: 'S.V.Mermug', mmsi: '338543654' },
        now: () => NOW,
      },
      { tree: tree(), polars: '', ...input },
    );

  it('renders the files the frontend fetches', async () => {
    const files = await render();
    expect([...files.keys()].sort()).toEqual([
      'data/telemetry/signalk_latest.json',
      'data/telemetry/tracks_index.json',
      'data/vessel/info.yaml',
    ]);
  });

  it('drops stale values, as the published snapshot does', async () => {
    const snapshot = JSON.parse((await render()).get('data/telemetry/signalk_latest.json')!);
    expect(snapshot.environment.wind.speedApparent.value).toBe(7.1);
    expect(snapshot.environment.depth?.belowTransducer?.value).toBeUndefined();
  });

  it('redacts a position inside a privacy zone', async () => {
    // A preview that showed the true position inside a zone is how you find
    // out the zone was not working only after it had been published.
    const files = await renderPreviewData(
      {
        config: makeConfig({ privacyZones: [HOME] }),
        store,
        identity: { name: 'S.V.Mermug', mmsi: '338543654' },
        now: () => NOW,
      },
      { tree: tree({ lat: HOME.lat + 0.0005, lon: HOME.lon }), polars: '' },
    );
    const snapshot = JSON.parse(files.get('data/telemetry/signalk_latest.json')!);
    expect(snapshot.navigation.position.value.latitude).toBe(HOME.lat);
    expect(snapshot.navigation.position.value.longitude).toBe(HOME.lon);
  });

  it('never writes, so the publisher rolling state is untouched', async () => {
    await render();
    expect(await fs.readdir(dataDir)).toEqual([]);
  });

  it('leaves the caller tree alone', async () => {
    const live = tree();
    await renderPreviewData(
      {
        config: makeConfig({ privacyZones: [HOME] }),
        store,
        identity: { name: 'S.V.Mermug', mmsi: '' },
        now: () => NOW,
      },
      { tree: live, polars: '' },
    );
    // The same object goes on to the real cycle; a preview that had redacted
    // it in place would hide the boat from its own publisher.
    expect(live.environment.depth.belowTransducer.value).toBe(12.4);
  });

  it('serves the state files it has, and rebuilds the days it can', async () => {
    await store.writeText(
      'positions_index.json',
      JSON.stringify({
        positions: [
          {
            timestamp: '2026-03-01T19:00:00Z',
            values: [
              { path: 'navigation.position', value: { latitude: 37.92, longitude: -122.52 } },
              { path: 'navigation.speedOverGround', value: 4.2 },
            ],
          },
        ],
      }),
    );
    await store.writeText('instrument_log.json', '{"entries":[]}');
    const files = await render();
    expect(files.has('data/telemetry/positions_index.json')).toBe(true);
    expect(files.has('data/telemetry/instrument_log.json')).toBe(true);
    // 19:00Z on the 1st is 11:00 in California, still the 1st.
    expect(files.get('data/telemetry/tracks/2026-03-01.gpx')).toContain('<trkpt');
  });

  it('includes the polar table only when there is one', async () => {
    expect((await render()).has('data/vessel/polars.csv')).toBe(false);
    const withPolars = await render({}, { polars: 'twa/tws;6\n52;4.1\n' });
    expect(withPolars.get('data/vessel/polars.csv')).toBe('twa/tws;6\n52;4.1\n');
  });

  it('renders info.yaml from the live tree, not from a published copy', async () => {
    const info = yaml.load((await render()).get('data/vessel/info.yaml')!) as any;
    expect(info.name).toBe('S.V.Mermug');
    expect(info.privacy_zones).toHaveLength(1);
  });
});
