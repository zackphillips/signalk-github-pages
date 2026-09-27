import { describe, expect, it } from 'vitest';
import {
  bundledTideStations,
  chooseTideStations,
  MAX_TIDE_STATION_NM,
  nearestTideStation,
  TIDE_STATION_CANDIDATES,
  treePosition,
} from '../src/tideStations';

describe('the shipped station table', () => {
  const stations = bundledTideStations();

  it('reads the table the plugin ships', () => {
    expect(stations.length).toBeGreaterThan(20);
  });

  it('picks by distance', () => {
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

  it(`finds nothing farther than ${MAX_TIDE_STATION_NM} NM`, () => {
    // Mid-Mediterranean: the nearest NOAA station is an ocean away, and the
    // chart used to draw its tides as this boat's.
    expect(nearestTideStation(stations, 38.0, 15.0)).toBeNull();
    expect(chooseTideStations(stations, '', { lat: 38.0, lon: 15.0 })).toEqual([]);
  });
});

describe('chooseTideStations', () => {
  const stations = bundledTideStations();

  it('offers the nearest few, nearest first, for the page to fall back through', () => {
    const chosen = chooseTideStations(stations, '', { lat: 37.78, lon: -122.29 });
    expect(chosen).toHaveLength(TIDE_STATION_CANDIDATES);
    expect(chosen[0]).toMatchObject({ id: '9414750', name: 'Alameda', overridden: false });
    expect(chosen.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))).toBe(true);
    // No distance: it changes every cycle underway, and site.json is committed
    // whenever its content changes.
    expect(chosen[0]).not.toHaveProperty('distanceNm');
  });

  it('offers the override alone, whatever the position says', () => {
    expect(chooseTideStations(stations, '9414290', { lat: 37.78, lon: -122.29 })).toEqual([
      expect.objectContaining({ id: '9414290', overridden: true }),
    ]);
  });

  it('still publishes an override the table has never heard of, without a position', () => {
    expect(chooseTideStations(stations, '9999999', null)).toEqual([
      { id: '9999999', name: 'Station 9999999', overridden: true },
    ]);
  });

  it('offers nothing with no position and no override', () => {
    expect(chooseTideStations(stations, '', null)).toEqual([]);
  });
});

describe('treePosition', () => {
  it('reads navigation.position, or nothing', () => {
    expect(
      treePosition({ navigation: { position: { value: { latitude: 1, longitude: 2 } } } }),
    ).toEqual({ lat: 1, lon: 2 });
    expect(treePosition({})).toBeNull();
    expect(treePosition(null)).toBeNull();
  });
});
