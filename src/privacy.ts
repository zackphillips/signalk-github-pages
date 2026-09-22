/**
 * Privacy zones: circles around the home marina (or anywhere else) whose
 * positions never leave the boat unredacted.
 *
 * Two rules:
 *  - the *latest* position inside a zone is published as the zone center, so
 *    the site still shows "at the dock" without showing the slip;
 *  - track points inside a zone are dropped entirely, never snapped to the
 *    center, so a day's GPX doesn't grow a spike of identical points.
 *
 * Every check walks the whole zone list. An early version checked only the
 * first zone, which redacted the map track while writing every other zone's
 * positions straight into the published GPX.
 */
import type { PrivacyZone } from './config';

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters between two WGS-84 points. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(a));
}

export interface ZoneCenter {
  lat: number;
  lon: number;
  name: string;
}

/** Center of the first zone containing the point, or null when it is clear. */
export function privacyZoneCenter(
  zones: PrivacyZone[],
  lat: number,
  lon: number,
): ZoneCenter | null {
  for (const zone of zones) {
    if (haversineMeters(lat, lon, zone.lat, zone.lon) <= zone.radius_m) {
      return { lat: zone.lat, lon: zone.lon, name: zone.name };
    }
  }
  return null;
}

export function isPositionPrivate(
  zones: PrivacyZone[],
  lat: number,
  lon: number,
): boolean {
  return privacyZoneCenter(zones, lat, lon) !== null;
}
