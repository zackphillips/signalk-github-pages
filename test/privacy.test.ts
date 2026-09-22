import { describe, expect, it } from 'vitest';
import { haversineMeters, isPositionPrivate, privacyZoneCenter } from '../src/privacy';

const SOUTH_BEACH = { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 };
const SANTA_CRUZ = { name: 'Santa Cruz Harbor', lat: 36.9636, lon: -122.0011, radius_m: 300 };

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters(37.78, -122.38, 37.78, -122.38)).toBe(0);
  });

  it('matches a minute of latitude to within the spherical-earth error', () => {
    // A nautical mile is 1852 m by definition; a spherical earth puts a
    // minute of latitude ~1.2 m over that, which is well inside what a
    // privacy radius cares about.
    expect(haversineMeters(37, -122, 37 + 1 / 60, -122)).toBeCloseTo(1853, 0);
  });
});

describe('privacyZoneCenter', () => {
  it('returns the center for a position inside the zone', () => {
    expect(privacyZoneCenter([SOUTH_BEACH], 37.78025, -122.38585)).toEqual({
      lat: SOUTH_BEACH.lat,
      lon: SOUTH_BEACH.lon,
      name: SOUTH_BEACH.name,
    });
  });

  it('returns null just outside the radius', () => {
    // ~400 m north of the center.
    expect(privacyZoneCenter([SOUTH_BEACH], 37.7838, -122.385804)).toBeNull();
  });

  it('checks every zone, not just the first', () => {
    // Regression: an early version checked zone[0] only, which redacted the
    // map track while writing every other zone's positions into the GPX.
    expect(isPositionPrivate([SOUTH_BEACH, SANTA_CRUZ], 36.9636, -122.0011)).toBe(true);
  });

  it('treats an empty zone list as no redaction', () => {
    expect(isPositionPrivate([], 37.7802069, -122.385804)).toBe(false);
  });
});
