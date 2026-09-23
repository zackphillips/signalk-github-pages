import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listHistoryProviders } from '../src/history';
import { loadTideStations, nearestTideStation } from '../src/tideStations';

describe('listHistoryProviders', () => {
  const server = (registered: string[], configured?: string) => ({
    getPluginsList: async () =>
      ['signalk-to-influxdb2', 'signalk-parquet', 'signalk-github-pages', 'freeboard-sk'].map(
        (id) => ({ id }),
      ),
    getHistoryApi: (id?: string) =>
      id && registered.includes(id)
        ? Promise.resolve({} as never)
        : Promise.reject(new Error(`History api provider '${id}' not found`)),
    config: { settings: { historyApi: { defaultProvider: configured } } },
  });

  it('finds the providers among the enabled plugins', async () => {
    const found = await listHistoryProviders(
      server(['signalk-to-influxdb2', 'signalk-parquet'], 'signalk-parquet') as never,
    );
    expect(found).toEqual({
      ids: ['signalk-parquet', 'signalk-to-influxdb2'],
      defaultId: 'signalk-parquet',
    });
  });

  it('names a lone provider as the default, and guesses nothing between two', async () => {
    expect((await listHistoryProviders(server(['signalk-parquet']) as never))?.defaultId).toBe(
      'signalk-parquet',
    );
    expect(
      (await listHistoryProviders(server(['signalk-parquet', 'signalk-to-influxdb2']) as never))
        ?.defaultId,
    ).toBeUndefined();
  });

  it('cannot ask a server with no History API or no plugin list', async () => {
    expect(await listHistoryProviders({} as never)).toBeNull();
    expect(
      await listHistoryProviders({ getHistoryApi: () => Promise.reject(new Error('x')) } as never),
    ).toBeNull();
  });
});

describe('nearestTideStation', () => {
  const stations = loadTideStations(path.join(__dirname, '..', 'site'));

  it('reads the list the site ships', () => {
    expect(stations.length).toBeGreaterThan(20);
  });

  it('picks by distance, as the site does', () => {
    const near = nearestTideStation(stations, 37.806, -122.465);
    expect(near?.id).toBe('9414290');
    expect(near?.distanceNm).toBeLessThan(0.1);
  });

  // The hand-written table had "Oakland" as 9418393, which is not a NOAA
  // station, and "Alameda" as Redwood City's ID. A boat in the Oakland
  // Estuary got an HTTP 400 instead of tides.
  it('lands on a real harmonic station in the Oakland Estuary', () => {
    const near = nearestTideStation(stations, 37.78, -122.29);
    expect(near?.id).toBe('9414750');
    expect(near?.name).toBe('Alameda');
    expect(stations.some((s) => s.id === '9418393')).toBe(false);
  });

  it('has nothing to say with no stations', () => {
    expect(nearestTideStation([], 37.8, -122.4)).toBeNull();
  });
});
