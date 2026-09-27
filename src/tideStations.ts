/**
 * The NOAA tide station the site queries, chosen on the boat.
 *
 * The site used to ship the whole station table and pick the nearest in the
 * browser, while this module repeated the same search for the config page's
 * note: two implementations of one rule, and 100 kB on every first visit. The
 * choice is made here now, from the published (redacted) position, and
 * `site.json` carries the few stations the page needs. The table ships with
 * the plugin, in `data/`, and is never published.
 *
 * A few, not one, because NOAA retires and suspends stations and the table
 * cannot know which have: the page tries them nearest first and draws the
 * first that answers, rather than a header over an HTTP 400 for as long as
 * the nearest stays broken.
 *
 * The table is NOAA's harmonic stations: the US and its territories. A boat
 * anywhere else used to be given whichever of them was least far away, which
 * in the Mediterranean is thousands of miles, and the chart drew that coast's
 * tides as the boat's. Past `MAX_TIDE_STATION_NM` there is no station, and the
 * panel says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { NearestTideStation } from './config';
import { haversineMeters } from './privacy';

export interface TideStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** One entry of what `site.json` publishes as `tide_stations`. */
export interface PublishedTideStation {
  id: string;
  name: string;
  /**
   * Absent for an overridden ID the table does not have. Distance is not
   * published: it changes every cycle underway, and `site.json` is committed
   * whenever its content changes. The page works it out from the position.
   */
  lat?: number;
  lon?: number;
  /** Picked on the config page rather than by distance. */
  overridden: boolean;
}

/**
 * Farthest a station can be and still count as the boat's, in nautical miles.
 *
 * Enough to reach a station across a wide bay or a stretch of open coast, and
 * short of drawing the next region's tides: NOAA's stations are rarely more
 * than 20 NM apart along a US coastline, so a boat beyond 50 is not in waters
 * the table covers.
 */
export const MAX_TIDE_STATION_NM = 50;

/** Stations offered to the page, nearest first, for it to fall back through. */
export const TIDE_STATION_CANDIDATES = 3;

/** Where the table ships: beside `dist/`, not in the published `site/`. */
export const TIDE_STATIONS_FILE = path.join(__dirname, '..', 'data', 'tide_stations.json');

/** The station table, or none when it will not read. */
export function loadTideStations(file: string = TIDE_STATIONS_FILE): TideStation[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
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

let bundled: TideStation[] | undefined;

/** The shipped table, read once. */
export function bundledTideStations(): TideStation[] {
  bundled ??= loadTideStations();
  return bundled;
}

/**
 * Stations by distance from a position, nearest first, out to `maxNm`.
 */
export function tideStationsNear(
  stations: TideStation[],
  lat: number,
  lon: number,
  maxNm: number = MAX_TIDE_STATION_NM,
): Array<TideStation & { distanceNm: number }> {
  return stations
    .map((station) => ({
      ...station,
      name: station.name || `Station ${station.id}`,
      distanceNm: haversineMeters(lat, lon, station.lat, station.lon) / 1852,
    }))
    .filter((station) => station.distanceNm <= maxNm)
    .sort((a, b) => a.distanceNm - b.distanceNm);
}

/** The station nearest a position, or null when none is within `maxNm`. */
export function nearestTideStation(
  stations: TideStation[],
  lat: number,
  lon: number,
  maxNm: number = MAX_TIDE_STATION_NM,
): NearestTideStation | null {
  const [nearest] = tideStationsNear(stations, lat, lon, maxNm);
  return nearest ? { id: nearest.id, name: nearest.name, distanceNm: nearest.distanceNm } : null;
}

/** `navigation.position` off a (redacted) tree, or null. */
export function treePosition(tree: unknown): { lat: number; lon: number } | null {
  const value = (tree as any)?.navigation?.position?.value;
  const lat = Number(value?.latitude);
  const lon = Number(value?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/**
 * The stations the site queries, in the order it tries them: the override
 * alone when one is set, whatever the position says, else the nearest few
 * within range of the position. Empty when there is neither.
 *
 * The override wins because a person who typed one has usually picked it over
 * the nearest by straight-line distance for a reason — the water behind a
 * headland — and it is not fallen back from: a station someone chose failing
 * is a thing to see, not to paper over with another. An ID the table has never
 * heard of is still published, with no position, so it gets its tide
 * predictions and nothing else.
 */
export function chooseTideStations(
  stations: TideStation[],
  overrideId: string,
  position: { lat: number; lon: number } | null,
): PublishedTideStation[] {
  if (overrideId) {
    const known = stations.find((station) => station.id === overrideId);
    return [
      known
        ? { id: known.id, name: known.name || `Station ${known.id}`, lat: known.lat, lon: known.lon, overridden: true }
        : { id: overrideId, name: `Station ${overrideId}`, overridden: true },
    ];
  }
  if (!position) return [];
  return tideStationsNear(stations, position.lat, position.lon)
    .slice(0, TIDE_STATION_CANDIDATES)
    .map((station) => ({
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      overridden: false,
    }));
}
