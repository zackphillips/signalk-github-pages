import { describe, expect, it } from 'vitest';
import {
  liveNumericPaths,
  selectInstrumentPaths,
  HistoryReader,
  instrumentEntriesFromHistory,
  isPositionPath,
  type HistoryApiLike,
  type HistoryValuesResponse,
} from '../src/history';

const NOW = new Date('2026-03-01T20:00:00Z');

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
    expect(instrumentEntriesFromHistory(response, { entries: 10 })).toEqual([
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

  it('drops a position a provider returns anyway', () => {
    // The track has one source and one redaction path. A position that came
    // back from a database is not it, whatever asked for it.
    const entries = instrumentEntriesFromHistory(
      {
        values: [
          { path: 'navigation.position', method: 'first' },
          { path: 'navigation.speedOverGround', method: 'average' },
        ],
        data: [['2026-03-01T19:58:00.000Z', [-122.52, 37.92], 4.2]],
      },
      { entries: 10 },
    );
    expect(entries).toEqual([
      {
        timestamp: '2026-03-01T19:58:00.000Z',
        values: { 'navigation.speedOverGround': 4.2 },
      },
    ]);
  });
});

describe('isPositionPath', () => {
  it('covers every path with a position segment, not just the vessel', () => {
    expect(isPositionPath('navigation.position')).toBe(true);
    expect(isPositionPath('navigation.position.latitude')).toBe(true);
    // The anchor drop point and the slip the boat just left.
    expect(isPositionPath('navigation.anchor.position')).toBe(true);
    expect(isPositionPath('navigation.course.previousPoint.position')).toBe(true);
    expect(isPositionPath('navigation.positionAccuracy')).toBe(false);
    expect(isPositionPath('navigation.speedOverGround')).toBe(false);
  });

  it('drops a coordinate pair whatever its path is called', () => {
    const entries = instrumentEntriesFromHistory(
      {
        values: [
          { path: 'navigation.destination.waypoint', method: 'first' },
          { path: 'navigation.speedOverGround', method: 'average' },
        ],
        data: [
          ['2026-03-01T19:58:00.000Z', { latitude: 37.78, longitude: -122.38 }, 4.2],
        ],
      },
      { entries: 10 },
    );
    expect(entries[0]!.values).toEqual({ 'navigation.speedOverGround': 4.2 });
  });
});

describe('selectInstrumentPaths', () => {
  const STORED = [
    'electrical.batteries.house.voltage',
    'electrical.batteries.fridge.voltage',
    'environment.inside.fridge.temperature',
    'design.length',
    'navigation.course.calcValues.distance',
    'navigation.position',
    'navigation.anchor.position',
    'navigation.speedOverGround',
  ];

  it('logs every stored path the exclusions do not name', () => {
    expect(selectInstrumentPaths(STORED, ['design', 'navigation.course'])).toEqual([
      'electrical.batteries.fridge.voltage',
      'electrical.batteries.house.voltage',
      'environment.inside.fridge.temperature',
      'navigation.speedOverGround',
    ]);
  });

  it('takes wildcards and exact paths, and an empty list excludes nothing but positions', () => {
    expect(
      selectInstrumentPaths(STORED, ['electrical.batteries.*.voltage', 'design.length']),
    ).toEqual([
      'environment.inside.fridge.temperature',
      'navigation.course.calcValues.distance',
      'navigation.speedOverGround',
    ]);
    expect(selectInstrumentPaths(STORED, [])).not.toContain('navigation.anchor.position');
  });

  it('asks only for what the boat is reporting now, when it has the tree', () => {
    const tree = {
      electrical: { batteries: { house: { voltage: { value: 12.7, meta: { units: 'V' } } } } },
      environment: { inside: { fridge: { temperature: { value: 277.1 } } } },
      navigation: {
        speedOverGround: { value: 3.1 },
        attitude: { value: { roll: 0.1, pitch: 0.02, yaw: null } },
        state: { value: 'sailing' },
      },
    };
    const live = liveNumericPaths(tree);
    expect([...live].sort()).toEqual([
      'electrical.batteries.house.voltage',
      'environment.inside.fridge.temperature',
      'navigation.attitude',
      'navigation.attitude.pitch',
      'navigation.attitude.roll',
      'navigation.attitude.yaw',
      'navigation.speedOverGround',
    ]);
    // The fridge bank was unplugged: stored, but not on the boat any more.
    expect(selectInstrumentPaths(STORED, [], live)).toEqual([
      'electrical.batteries.house.voltage',
      'environment.inside.fridge.temperature',
      'navigation.speedOverGround',
    ]);
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
      app: api ? { getHistoryApi: async () => api as HistoryApiLike } : {},
      history: config,
      exclude: [],
      instrumentEntries: 10,
      log: (message: string) => logs.push(message),
      ...overrides,
    });
    return { reader, logs };
  };

  it('reports no provider on a server with no History API', async () => {
    const { reader } = makeReader(null);
    expect(reader.configured).toBe(false);
    expect(await reader.read(NOW)).toEqual({ status: 'none' });
  });

  it('reports no provider when the config turns it off', async () => {
    const { reader } = makeReader(
      { getValues: async () => ({ values: [], data: [] }), getPaths: async () => [] },
      { history: { ...config, enabled: false } },
    );
    expect(reader.configured).toBe(false);
    expect(await reader.read(NOW)).toEqual({ status: 'none' });
  });

  it('asks for exactly the window the log holds, and never for a position', async () => {
    const queries: any[] = [];
    const { reader } = makeReader({
      getValues: async (query: any) => {
        queries.push(query);
        return { values: [], data: [] };
      },
      getPaths: async () => [
        'navigation.speedOverGround',
        'navigation.position',
        'navigation.anchor.position',
      ],
    });
    const result = await reader.read(NOW);

    expect(result.status).toBe('ok');
    expect(queries).toHaveLength(1);
    expect(queries[0].context).toBe('vessels.self');
    expect(queries[0].resolution).toBe(60);
    expect(queries[0].pathSpecs.map((spec: any) => spec.path)).toEqual([
      'navigation.speedOverGround',
    ]);
    // 10 entries x 60 s, ending now.
    expect(queries[0].to.toString()).toBe('2026-03-01T20:00:00Z');
    expect(queries[0].from.toString()).toBe('2026-03-01T19:50:00Z');
  });

  it('logs every stored path not excluded, and caches the listing', async () => {
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
          return [
            'electrical.batteries.house.voltage',
            'electrical.batteries.start.voltage',
            'design.length',
          ];
        },
      },
      { exclude: ['design'] },
    );

    await reader.read(NOW);
    await reader.read(new Date(NOW.getTime() + 120_000));
    expect(pathCalls).toBe(1);
    expect(asked[1]).toEqual([
      'electrical.batteries.house.voltage',
      'electrical.batteries.start.voltage',
    ]);
  });

  it('reports unavailable when a query hangs', async () => {
    const { reader, logs } = makeReader({
      getValues: () => new Promise(() => {}),
      getPaths: async () => ['navigation.speedOverGround'],
    });
    const result = await reader.read(NOW);
    expect(result.status).toBe('unavailable');
    expect(logs.join(' ')).toMatch(/timed out/);
  });

  it('reports unavailable when the provider throws, and recovers afterwards', async () => {
    let fail = true;
    const { reader } = makeReader({
      getValues: async () => {
        if (fail) throw new Error('influxdb is starting');
        return {
          values: [{ path: 'navigation.speedOverGround', method: 'average' }],
          data: [['2026-03-01T19:58:00.000Z', 4.2]],
        };
      },
      getPaths: async () => ['navigation.speedOverGround'],
    });

    expect((await reader.read(NOW)).status).toBe('unavailable');
    fail = false;
    const result = await reader.read(NOW);
    expect(result).toMatchObject({
      status: 'ok',
      providerId: 'default',
      requestedPaths: ['navigation.speedOverGround'],
    });
    expect(result.status === 'ok' && result.entries).toHaveLength(1);
  });

  it('reports unavailable when the provider cannot list its paths', async () => {
    const { reader } = makeReader({ getValues: async () => ({ values: [], data: [] }) });
    const result = await reader.read(NOW);
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(result.status === 'unavailable' && result.reason).toMatch(/cannot list/);
  });
});
