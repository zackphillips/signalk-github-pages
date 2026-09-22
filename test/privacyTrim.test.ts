import { describe, expect, it } from 'vitest';
import { renderGpxDocument, trimPrivatePoints, updateTracks } from '../src/gpx';
import { redactStoredEntry, type PositionEntry } from '../src/positions';
import { privacyZoneFingerprint } from '../src/publisher';

const ZONE = { name: 'Home', lat: 37.78, lon: -122.3861, radius_m: 500 };
const INSIDE = { lat: 37.781, lon: -122.3855 };
const OUTSIDE = { lat: 37.8, lon: -122.4 };

const point = (at: { lat: number; lon: number }, timestamp: string) => ({
  timestamp,
  latitude: at.lat,
  longitude: at.lon,
  speed_ms: 3.1,
  course_rad: 1,
});

describe('trimPrivatePoints', () => {
  const gpx = renderGpxDocument(
    [
      point(INSIDE, '2026-09-20T18:00:00Z'),
      point(OUTSIDE, '2026-09-20T19:00:00Z'),
      point(INSIDE, '2026-09-20T20:00:00Z'),
    ],
    '2026-09-20',
    'S.V.Mermug',
  );

  it('takes out exactly the points inside a zone and leaves the rest byte for byte', () => {
    const trim = trimPrivatePoints(gpx, [ZONE]);
    expect(trim.removed).toBe(2);
    expect(trim.kept.map((p) => p.timestamp)).toEqual(['2026-09-20T19:00:00Z']);
    expect(trim.content).not.toContain(`lat="${INSIDE.lat.toFixed(6)}"`);
    // Same document as one rendered from the kept point alone.
    expect(trim.content).toBe(
      renderGpxDocument([point(OUTSIDE, '2026-09-20T19:00:00Z')], '2026-09-20', 'S.V.Mermug'),
    );
  });

  it('reads speed and course back, so the index row is right', () => {
    const [kept] = trimPrivatePoints(gpx, [ZONE]).kept;
    expect(kept!.speed_ms).toBeCloseTo(3.1);
    expect(kept!.course_rad).toBeCloseTo(1, 2);
  });

  it('says so when there is nothing to take out, and changes nothing', () => {
    expect(trimPrivatePoints(gpx, [])).toMatchObject({ content: null, removed: 0 });
    expect(trimPrivatePoints(gpx, [{ ...ZONE, lat: 0, lon: 0 }]).content).toBeNull();
  });

  it('empties a day that never left the zone', () => {
    const atDock = renderGpxDocument(
      [point(INSIDE, '2026-09-21T08:00:00Z'), point(INSIDE, '2026-09-21T09:00:00Z')],
      '2026-09-21',
      'S.V.Mermug',
    );
    const trim = trimPrivatePoints(atDock, [ZONE]);
    expect(trim.kept).toEqual([]);
    expect(trim.removed).toBe(2);
  });
});

describe('redactStoredEntry', () => {
  const entry = (at: { lat: number; lon: number }): PositionEntry => ({
    timestamp: '2026-09-22T19:00:00.000Z',
    values: [
      { path: 'navigation.position', value: { latitude: at.lat, longitude: at.lon } },
      { path: 'navigation.speedOverGround', value: 0.05 },
    ],
  });

  it('moves a stored position a newer zone covers to its center, and drops speed', () => {
    expect(redactStoredEntry(entry(INSIDE), [ZONE])).toEqual({
      timestamp: '2026-09-22T19:00:00.000Z',
      values: [{ path: 'navigation.position', value: { latitude: ZONE.lat, longitude: ZONE.lon } }],
    });
  });

  it('leaves a position outside every zone alone', () => {
    const outside = entry(OUTSIDE);
    expect(redactStoredEntry(outside, [ZONE])).toBe(outside);
  });
});

describe('updateTracks', () => {
  it('never rebuilds a day removed by hand, but always rebuilds today', () => {
    const entries = ['2026-09-21T19:00:00Z', '2026-09-22T19:00:00Z'].map((timestamp) => ({
      timestamp,
      values: [{ path: 'navigation.position', value: { latitude: 37.8, longitude: -122.4 } }],
    }));
    const update = updateTracks(entries, {
      zones: [],
      timezone: 'America/Los_Angeles',
      vesselName: 'S.V.Mermug',
      now: new Date('2026-09-22T20:00:00Z'),
      existingIndex: [],
      publishedDays: new Set(),
      removedDays: new Set(['2026-09-21', '2026-09-22']),
    });
    expect(Object.keys(update.files)).toEqual(['data/telemetry/tracks/2026-09-22.gpx']);
  });
});

describe('privacyZoneFingerprint', () => {
  it('changes with what is hidden, and not with names or order', () => {
    const other = { name: 'Other', lat: 38, lon: -122.5, radius_m: 100 };
    expect(privacyZoneFingerprint([ZONE, other])).toBe(
      privacyZoneFingerprint([{ ...other, name: 'x' }, { ...ZONE, name: 'y' }]),
    );
    expect(privacyZoneFingerprint([ZONE])).not.toBe(
      privacyZoneFingerprint([{ ...ZONE, radius_m: 200 }]),
    );
  });
});
