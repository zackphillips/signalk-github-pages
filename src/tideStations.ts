/**
 * The NOAA tide station the site would pick, worked out on the boat.
 *
 * The site does this itself in the browser, from the same
 * `data/tide_stations.json` it ships. The plugin repeats it only for the
 * config page, so the tide override's note can say which station the site is
 * using before anyone decides to override it. Nothing here is published.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { NearestTideStation } from './config';
import { haversineMeters } from './privacy';

interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** The station list the site ships, or none when it will not read. */
export function loadTideStations(siteDir: string): Station[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(siteDir, 'data', 'tide_stations.json'), 'utf-8'),
    );
    const list = Array.isArray(raw?.stations) ? raw.stations : [];
    return list.filter(
      (station: any) =>
        station &&
        typeof station.id === 'string' &&
        Number.isFinite(station.lat) &&
        Number.isFinite(station.lon),
    );
  } catch {
    return [];
  }
}

/**
 * The station nearest a position, by the same rule the site uses: distance
 * and nothing else.
 */
export function nearestTideStation(
  stations: Station[],
  lat: number,
  lon: number,
): NearestTideStation | null {
  let best: { station: Station; meters: number } | null = null;
  for (const station of stations) {
    const meters = haversineMeters(lat, lon, station.lat, station.lon);
    if (!best || meters < best.meters) best = { station, meters };
  }
  if (!best) return null;
  return {
    id: best.station.id,
    name: best.station.name || `Station ${best.station.id}`,
    distanceNm: best.meters / 1852,
  };
}
