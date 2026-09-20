import { describe, expect, it } from 'vitest';
import {
  bucketKey,
  expandPathPatterns,
  HistoryReader,
  instrumentEntriesFromHistory,
  mergeByBucket,
  parseHistoryPosition,
  positionEntriesFromHistory,
  type HistoryApiLike,
  type HistoryValuesResponse,
} from '../src/history';

const HOME = { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 };
const NOW = new Date('2026-03-01T20:00:00Z');

const positionResponse = (
  rows: Array<[string, unknown, number?, number?]>,
): HistoryValuesResponse => ({
  context: 'vessels.self',
  values: [
    { path: 'navigation.position', method: 'first' },
    { path: 'navigation.speedOverGround', method: 'average' },
    { path: 'navigation.courseOverGroundTrue', method: 'average' },
  ],
  data: rows.map((row) => [row[0], row[1], row[2] ?? null, row[3] ?? null]),
});

describe('parseHistoryPosition', () => {
  it('reads the [lon, lat] pair the InfluxDB provider returns', () => {
    expect(parseHistoryPosition([-122.52, 37.92])).toEqual({
      latitude: 37.92,
      longitude: -122.52,
    });
  });

  it('reads an object form too', () => {
    expect(parseHistoryPosition({ latitude: 37.92, longitude: -122.52 })).toEqual({
      latitude: 37.92,
      longitude: -122.52,
    });
  });

  it('rejects a bucket with no fix', () => {
    expect(parseHistoryPosition(null)).toBeNull();
    expect(parseHistoryPosition([null, null])).toBeNull();
    expect(parseHistoryPosition({ latitude: 37.92 })).toBeNull();
  });
});

describe('positionEntriesFromHistory', () => {
  it('builds index entries carrying speed and course', () => {
    const entries = positionEntriesFromHistory(
      positionResponse([['2026-03-01T19:58:00.000Z', [-122.52, 37.92], 4.2, 1.1]]),
      { zones: [], retentionHours: 24, now: NOW },
    );
    expect(entries).toEqual([
      {
        timestamp: '2026-03-01T19:58:00.000Z',
        values: [
          { path: 'navigation.position', value: { latitude: 37.92, longitude: -122.52 } },
          { path: 'navigation.speedOverGround', value: 4.2 },
          { path: 'navigation.courseOverGroundTrue', value: 1.1 },
        ],
      },
    ]);
  });

  it('redacts every historical position inside a privacy zone', () => {
    // The provider stores raw positions, so a zone added after the fact only
    // works if it is applied on the way out — to history as much as to a fix.
    const entries = positionEntriesFromHistory(
      positionResponse([
        ['2026-03-01T19:50:00.000Z', [HOME.lon + 0.0005, HOME.lat + 0.0005], 0.3, 2.2],
        ['2026-03-01T19:55:00.000Z', [-122.52, 37.92], 4.2, 1.1],
      ]),
      { zones: [HOME], retentionHours: 24, now: NOW },
    );
    expect(entries[0]!.values).toEqual([
      { path: 'navigation.position', value: { latitude: HOME.lat, longitude: HOME.lon } },
    ]);
    expect(entries[1]!.values).toHaveLength(3);
  });

  it('drops buckets with no fix and anything past the retention window', () => {
    const entries = positionEntriesFromHistory(
      positionResponse([
        ['2026-02-28T19:00:00.000Z', [-122.4, 37.8]],
        ['2026-03-01T19:00:00.000Z', null, 4.2],
        ['2026-03-01T19:30:00.000Z', [-122.52, 37.92]],
      ]),
      { zones: [], retentionHours: 24, now: NOW },
    );
    expect(entries.map((entry) => entry.timestamp)).toEqual(['2026-03-01T19:30:00.000Z']);
  });
});

describe('instrumentEntriesFromHistory', () => {
  const response: HistoryValuesResponse = {
    values: [
      { path: 'navigation.speedOverGround', method: 'average' },
      { path: 'environment.wind.speedApparent', method: 'average' },
      { path: 'navigation.attitude', method: 'average' },
    ],
    data: [
      ['2026-03-01T19:58:00.000Z', 4.2, 7.1, { roll: 0.1, pitch: -0.02 }],
      ['2026-03-01T19:59:00.000Z', 4.4, null, null],
      ['2026-03-01T20:00:00.000Z', null, null, null],
    ],
  };

  it('keeps one entry per bucket and flattens composite values', () => {
    const entries = instrumentEntriesFromHistory(response, { entries: 10 });
    expect(entries).toEqual([
      {
        timestamp: '2026-03-01T19:58:00.000Z',
        values: {
          'navigation.speedOverGround': 4.2,
          'environment.wind.speedApparent': 7.1,
          'navigation.attitude.roll': 0.1,
          'navigation.attitude.pitch': -0.02,
        },
      },
      {
        timestamp: '2026-03-01T19:59:00.000Z',
        values: { 'navigation.speedOverGround': 4.4 },
      },
    ]);
  });

  it('trims to the configured rolling length, keeping the newest', () => {
    const entries = instrumentEntriesFromHistory(response, { entries: 1 });
    expect(entries.map((entry) => entry.timestamp)).toEqual(['2026-03-01T19:59:00.000Z']);
  });

  it('takes the first source that has a value when a path repeats', () => {
    const entries = instrumentEntriesFromHistory(
      {
        values: [
          { path: 'navigation.speedOverGround', method: 'average', $source: 'gps.1' },
          { path: 'navigation.speedOverGround', method: 'average', $source: 'gps.2' },
        ],
        data: [
          ['2026-03-01T19:58:00.000Z', null, 4.4],
          ['2026-03-01T19:59:00.000Z', 4.2, 4.4],
        ],
      },
      { entries: 10 },
    );
    expect(entries.map((entry) => entry.values['navigation.speedOverGround'])).toEqual([
      4.4, 4.2,
    ]);
  });
});

describe('expandPathPatterns', () => {
  it('expands a wildcard against the paths the provider has stored', () => {
    expect(
      expandPathPatterns(
        ['electrical.batteries.*.voltage', 'navigation.speedOverGround'],
        [
          'electrical.batteries.house.voltage',
          'electrical.batteries.start.voltage',
          'electrical.batteries.house.current',
        ],
      ),
    ).toEqual([
      'electrical.batteries.house.voltage',
      'electrical.batteries.start.voltage',
      'navigation.speedOverGround',
    ]);
  });

  it('keeps a literal path the provider has never seen', () => {
    // A sensor that came online five minutes ago is not in the listing yet;
    // asking for it costs one column of nulls.
    expect(expandPathPatterns(['tanks.fuel.0.currentLevel'], [])).toEqual([
      'tanks.fuel.0.currentLevel',
    ]);
  });
});

describe('mergeByBucket', () => {
  const at = (timestamp: string, tag: string) => ({ timestamp, tag });

  it('lets the later series win a shared bucket', () => {
    const merged = mergeByBucket(
      [
        [at('2026-03-01T19:58:03.000Z', 'local'), at('2026-03-01T19:30:00.000Z', 'local')],
        [at('2026-03-01T19:58:00.000Z', 'history')],
      ],
      60,
    );
    expect(merged.map((entry) => entry.tag)).toEqual(['local', 'history']);
  });

  it('keeps buckets only one source has', () => {
    const merged = mergeByBucket(
      [[at('2026-02-28T10:00:00.000Z', 'local')], [at('2026-03-01T19:58:00.000Z', 'history')]],
      60,
    );
    expect(merged).toHaveLength(2);
  });

  it('buckets by resolution, not by exact timestamp', () => {
    expect(bucketKey('2026-03-01T19:58:03.000Z', 60)).toBe(
      bucketKey('2026-03-01T19:58:59.000Z', 60),
    );
    expect(bucketKey('2026-03-01T19:58:03.000Z', 1)).not.toBe(
      bucketKey('2026-03-01T19:58:04.000Z', 1),
    );
  });
});

describe('HistoryReader', () => {
  const config = {
    enabled: true,
    providerId: '',
    resolutionSeconds: 60,
    timeoutMs: 50,
  };

  const makeReader = (
    api: Partial<HistoryApiLike> | null,
    overrides: Record<string, any> = {},
  ) => {
    const logs: string[] = [];
    const reader = new HistoryReader({
      app: api
        ? { getHistoryApi: async () => api as HistoryApiLike }
        : {},
      history: config,
      zones: [],
      positionRetentionHours: 24,
      instrumentPaths: ['navigation.speedOverGround'],
      instrumentEntries: 10,
      log: (message: string) => logs.push(message),
      ...overrides,
    });
    return { reader, logs };
  };

  it('returns null on a server with no History API', async () => {
    const { reader } = makeReader(null);
    expect(reader.configured).toBe(false);
    expect(await reader.snapshot(NOW)).toBeNull();
  });

  it('returns null when the config turns it off', async () => {
    const { reader } = makeReader(
      { getValues: async () => ({ values: [], data: [] }), getPaths: async () => [] },
      { history: { ...config, enabled: false } },
    );
    expect(reader.configured).toBe(false);
    expect(await reader.snapshot(NOW)).toBeNull();
  });

  it('asks for the retention window of positions and the log window of instruments', async () => {
    const queries: any[] = [];
    const { reader } = makeReader({
      getValues: async (query: any) => {
        queries.push(query);
        return { values: [], data: [] };
      },
      getPaths: async () => [],
    });
    await reader.snapshot(NOW);

    expect(queries).toHaveLength(2);
    expect(queries[0].context).toBe('vessels.self');
    expect(queries[0].resolution).toBe(60);
    expect(queries[0].pathSpecs.map((spec: any) => spec.path)).toEqual([
      'navigation.position',
      'navigation.speedOverGround',
      'navigation.courseOverGroundTrue',
    ]);
    // 24 h of positions; 10 entries x 60 s of instruments.
    expect(queries[0].to.toString()).toBe('2026-03-01T20:00:00Z');
    expect(queries[0].from.toString()).toBe('2026-02-28T20:00:00Z');
    expect(queries[1].from.toString()).toBe('2026-03-01T19:50:00Z');
  });

  it('expands wildcards through getPaths and caches the listing', async () => {
    let pathCalls = 0;
    const asked: string[][] = [];
    const { reader } = makeReader(
      {
        getValues: async (query: any) => {
          asked.push(query.pathSpecs.map((spec: any) => spec.path));
          return { values: [], data: [] };
        },
        getPaths: async () => {
          pathCalls += 1;
          return ['electrical.batteries.house.voltage', 'electrical.batteries.start.voltage'];
        },
      },
      { instrumentPaths: ['electrical.batteries.*.voltage'] },
    );

    await reader.snapshot(NOW);
    await reader.snapshot(new Date(NOW.getTime() + 120_000));
    expect(pathCalls).toBe(1);
    expect(asked[1]).toEqual([
      'electrical.batteries.house.voltage',
      'electrical.batteries.start.voltage',
    ]);
  });

  it('falls back to local accumulation when a query hangs', async () => {
    const { reader, logs } = makeReader({
      getValues: () => new Promise(() => {}),
      getPaths: async () => [],
    });
    expect(await reader.snapshot(NOW)).toBeNull();
    expect(logs.join(' ')).toMatch(/timed out/);
  });

  it('falls back when the provider throws, and recovers afterwards', async () => {
    let fail = true;
    const { reader } = makeReader({
      getValues: async () => {
        if (fail) throw new Error('influxdb is starting');
        return {
          values: [{ path: 'navigation.position', method: 'first' }],
          data: [['2026-03-01T19:58:00.000Z', [-122.52, 37.92]]],
        };
      },
      getPaths: async () => [],
    });

    expect(await reader.snapshot(NOW)).toBeNull();
    fail = false;
    const snapshot = await reader.snapshot(NOW);
    expect(snapshot?.positions).toHaveLength(1);
    expect(snapshot?.providerId).toBe('default');
  });
});
