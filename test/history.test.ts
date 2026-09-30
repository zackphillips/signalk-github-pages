import { describe, expect, it } from 'vitest';
import {
  liveNumericPaths,
  liveStatePaths,
  selectInstrumentPaths,
  stateRunsFromHistory,
  HistoryReader,
  instrumentEntriesFromHistory,
  isPositionPath,
  MAX_STATE_LENGTH,
  MAX_STATE_RUNS,
  MAX_STATE_VALUES,
  PATH_CACHE_MS,
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

describe('liveStatePaths', () => {
  it('finds short strings and booleans wherever the boat has them', () => {
    const tree = {
      name: 'Mermug',
      navigation: {
        state: { value: 'moored' },
        speedOverGround: { value: 3.1 },
        destination: { commonName: { value: 'x'.repeat(MAX_STATE_LENGTH + 1) } },
        position: { value: { latitude: 37.8, longitude: -122.4 } },
      },
      steering: { autopilot: { state: { value: 'standby' } } },
      electrical: { switches: { bilge: { state: { value: true } } } },
      notifications: { fire: { value: { state: 'alarm', message: 'Fire' } } },
      sensors: { gps: { name: { value: '   ' } } },
    };
    expect([...liveStatePaths(tree)].sort()).toEqual([
      'electrical.switches.bilge.state',
      'navigation.state',
      'steering.autopilot.state',
    ]);
  });
});

describe('stateRunsFromHistory', () => {
  const at = (minute: number) => `2026-03-01T19:${String(minute).padStart(2, '0')}:00.000Z`;

  it('keeps only the changes, for any path', () => {
    const runs = stateRunsFromHistory({
      values: [
        { path: 'navigation.state', method: 'last' },
        { path: 'steering.autopilot.state', method: 'last' },
      ],
      data: [
        [at(0), 'moored', 'standby'],
        [at(1), 'moored', 'standby'],
        [at(2), 'sailing', null],
        [at(3), 'sailing', 'auto'],
        [at(4), 'moored', 'auto'],
      ],
    });
    expect(runs).toEqual({
      'navigation.state': [
        [at(0), 'moored'],
        [at(2), 'sailing'],
        [at(4), 'moored'],
      ],
      'steering.autopilot.state': [
        [at(0), 'standby'],
        [at(3), 'auto'],
      ],
    });
  });

  it('turns booleans into text and ignores numbers and nulls', () => {
    const runs = stateRunsFromHistory({
      values: [
        { path: 'electrical.switches.bilge.state', method: 'last' },
        { path: 'propulsion.main.revolutions', method: 'last' },
      ],
      data: [
        [at(0), false, 12],
        [at(1), true, 14],
      ],
    });
    expect(runs).toEqual({
      'electrical.switches.bilge.state': [
        [at(0), 'false'],
        [at(1), 'true'],
      ],
    });
  });

  it('drops a path whole when any value is prose, structured or a position', () => {
    const runs = stateRunsFromHistory({
      values: [
        { path: 'navigation.destination.commonName', method: 'last' },
        { path: 'navigation.anchor.position', method: 'last' },
        { path: 'navigation.state', method: 'last' },
      ],
      data: [
        [at(0), 'Half Moon Bay', { latitude: 37.5, longitude: -122.5 }, 'moored'],
        [at(1), 'x'.repeat(MAX_STATE_LENGTH + 1), null, 'moored'],
      ],
    });
    expect(Object.keys(runs)).toEqual(['navigation.state']);
  });

  it('drops an identifier that takes too many values, and caps a flapping switch', () => {
    const ids = Array.from({ length: MAX_STATE_VALUES + 1 }, (_, i) => [at(i), `id-${i}`]);
    const flips = Array.from({ length: MAX_STATE_RUNS + 50 }, (_, i) => [
      `2026-03-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      i % 2 ? 'on' : 'off',
    ]);
    const runs = stateRunsFromHistory({
      values: [
        { path: 'sensors.tag.id', method: 'last' },
        { path: 'electrical.switches.pump.state', method: 'last' },
      ],
      data: ids.map((row, i) => [...row, flips[i]![1]] as any).concat(
        flips.slice(ids.length).map((row) => [row[0], null, row[1]] as any),
      ),
    });
    expect(Object.keys(runs)).toEqual(['electrical.switches.pump.state']);
    expect(runs['electrical.switches.pump.state']!.length).toBeLessThanOrEqual(MAX_STATE_RUNS);
  });
});

describe('HistoryReader', () => {
  const config = {
    enabled: true,
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

  describe('states', () => {
    const TREE = {
      navigation: { speedOverGround: { value: 3 }, state: { value: 'sailing' } },
      steering: { autopilot: { state: { value: 'auto' } } },
    };
    const STATE_DATA = {
      values: [
        { path: 'navigation.state', method: 'last' },
        { path: 'steering.autopilot.state', method: 'last' },
      ],
      data: [
        ['2026-03-01T19:58:00.000Z', 'moored', 'standby'],
        ['2026-03-01T19:59:00.000Z', 'sailing', 'standby'],
      ],
    };

    it('asks for every live string path with last, at a minute at most', async () => {
      const queries: any[] = [];
      const { reader } = makeReader(
        {
          getValues: async (query: any) => {
            queries.push(query);
            const numeric = query.pathSpecs[0].aggregate === 'average';
            return numeric ? { values: [], data: [] } : STATE_DATA;
          },
          getPaths: async () => ['navigation.speedOverGround'],
        },
        { history: { ...config, resolutionSeconds: 240 } },
      );
      const result = await reader.read(NOW, TREE);

      const stateQuery = queries.find((q) => q.pathSpecs[0].aggregate === 'last');
      expect(stateQuery.pathSpecs.map((s: any) => s.path)).toEqual([
        'navigation.state',
        'steering.autopilot.state',
      ]);
      expect(stateQuery.resolution).toBe(60);
      // Whether the provider lists a string path is not what decides.
      expect(result.status === 'ok' && Object.keys(result.states)).toEqual([
        'navigation.state',
        'steering.autopilot.state',
      ]);
    });

    it('keeps the paths that answer when one makes the batch fail', async () => {
      const { reader, logs } = makeReader({
        getValues: async (query: any) => {
          const paths = query.pathSpecs.map((s: any) => s.path);
          if (query.pathSpecs[0].aggregate === 'average') return { values: [], data: [] };
          if (paths.includes('steering.autopilot.state')) throw new Error('not a number');
          return {
            values: [{ path: 'navigation.state', method: 'last' }],
            data: [['2026-03-01T19:58:00.000Z', 'moored']],
          };
        },
        getPaths: async () => ['navigation.speedOverGround'],
      });
      const result = await reader.read(NOW, TREE);

      expect(result.status).toBe('ok');
      expect(result.status === 'ok' && Object.keys(result.states)).toEqual(['navigation.state']);
      expect(logs.join(' ')).toMatch(/1 of 2 path\(s\) answered alone/);
    });

    it('sets a failing path aside, then tries it again after the cache expires', async () => {
      const asked: string[][] = [];
      const { reader } = makeReader({
        getValues: async (query: any) => {
          const paths = query.pathSpecs.map((s: any) => s.path);
          if (query.pathSpecs[0].aggregate === 'average') return { values: [], data: [] };
          asked.push(paths);
          if (paths.includes('steering.autopilot.state')) throw new Error('not a number');
          return { values: [], data: [] };
        },
        getPaths: async () => ['navigation.speedOverGround'],
      });
      await reader.read(NOW, TREE);
      asked.length = 0;
      await reader.read(new Date(NOW.getTime() + 120_000), TREE);
      expect(asked).toEqual([['navigation.state']]);

      asked.length = 0;
      await reader.read(new Date(NOW.getTime() + PATH_CACHE_MS + 1000), TREE);
      expect(asked[0]).toEqual(['navigation.state', 'steering.autopilot.state']);
    });

    it('never costs the numeric log: a provider that refuses strings leaves states empty', async () => {
      const { reader } = makeReader({
        getValues: async (query: any) => {
          if (query.pathSpecs[0].aggregate === 'last') throw new Error('no strings here');
          return {
            values: [{ path: 'navigation.speedOverGround', method: 'average' }],
            data: [['2026-03-01T19:58:00.000Z', 4.2]],
          };
        },
        getPaths: async () => ['navigation.speedOverGround'],
      });
      const result = await reader.read(NOW, TREE);
      expect(result.status).toBe('ok');
      expect(result.status === 'ok' && result.entries).toHaveLength(1);
      expect(result.status === 'ok' && result.states).toEqual({});
    });

    it('asks nothing about states without a tree, or for excluded paths', async () => {
      const queries: any[] = [];
      const api = {
        getValues: async (query: any) => {
          queries.push(query);
          return { values: [], data: [] };
        },
        getPaths: async () => ['navigation.speedOverGround'],
      };
      await makeReader(api).reader.read(NOW);
      await makeReader(api, { exclude: ['navigation.state', 'steering'] }).reader.read(NOW, TREE);
      expect(queries.every((q) => q.pathSpecs[0].aggregate === 'average')).toBe(true);
    });
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
