import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTideStations, nearestTideStation } from '../src/tideStations';

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
