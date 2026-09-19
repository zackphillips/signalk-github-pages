import { describe, expect, it } from 'vitest';
import {
  buildDayGpx,
  extractPosFromValues,
  groupPointsByDay,
  makeTrackMeta,
  parseTracksIndex,
  renderTracksIndex,
  updateTracks,
  type TrackPoint,
} from '../src/gpx';
import { formatGpxTime } from '../src/time';
import type { PositionEntry } from '../src/positions';

const HOME = { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 };
const TZ = 'America/Los_Angeles';

const point = (over: Partial<TrackPoint> = {}): TrackPoint => ({
  timestamp: '2026-03-01T18:00:00Z',
  latitude: 37.82,
  longitude: -122.45,
  speed_ms: 4,
  course_rad: Math.PI / 2,
  ...over,
});

const entry = (timestamp: string, lat: number, lon: number): PositionEntry => ({
  timestamp,
  values: [
    { path: 'navigation.position', value: { latitude: lat, longitude: lon } },
    { path: 'navigation.speedOverGround', value: 4 },
    { path: 'navigation.courseOverGroundTrue', value: 1.5 },
  ],
});

describe('formatGpxTime', () => {
  it('normalises an offset to UTC', () => {
    expect(formatGpxTime('2026-03-01T10:00:00-08:00')).toBe('2026-03-01T18:00:00Z');
  });

  it('drops sub-second precision', () => {
    expect(formatGpxTime('2026-03-01T18:00:00.123456Z')).toBe('2026-03-01T18:00:00Z');
  });

  it('treats a missing zone as UTC', () => {
    expect(formatGpxTime('2026-03-01T18:00:00')).toBe('2026-03-01T18:00:00Z');
  });

  it('passes an unparseable value through rather than throwing', () => {
    expect(formatGpxTime('not a time')).toBe('not a time');
  });
});

describe('extractPosFromValues', () => {
  it('reads position, speed and course', () => {
    expect(extractPosFromValues(entry('t', 37.8, -122.4).values)).toEqual({
      lat: 37.8,
      lon: -122.4,
      speed: 4,
      course: 1.5,
    });
  });

  it('returns nulls for missing members', () => {
    expect(
      extractPosFromValues([
        { path: 'navigation.position', value: { latitude: 1, longitude: 2 } },
      ]),
    ).toEqual({ lat: 1, lon: 2, speed: null, course: null });
    expect(extractPosFromValues([])).toEqual({ lat: null, lon: null, speed: null, course: null });
    expect(extractPosFromValues(undefined)).toEqual({ lat: null, lon: null, speed: null, course: null });
  });
});

describe('buildDayGpx', () => {
  it('writes one trkpt per point with six-decimal coordinates', () => {
    const gpx = buildDayGpx([point(), point({ latitude: 37.833333333 })], '2026-03-01', 'Mermug');
    expect(gpx.match(/<trkpt /g)).toHaveLength(2);
    expect(gpx).toContain('lat="37.833333"');
    expect(gpx).toContain('lon="-122.450000"');
  });

  it('writes speed in m/s and course in degrees', () => {
    const gpx = buildDayGpx([point({ speed_ms: 4.567, course_rad: Math.PI })], '2026-03-01', 'Mermug');
    expect(gpx).toContain('<gpxtpx:speed>4.567</gpxtpx:speed>');
    expect(gpx).toContain('<gpxtpx:course>180.0</gpxtpx:course>');
  });

  it('wraps course into 0-360', () => {
    const gpx = buildDayGpx([point({ course_rad: 3 * Math.PI })], '2026-03-01', 'Mermug');
    expect(gpx).toContain('<gpxtpx:course>180.0</gpxtpx:course>');
  });

  it('omits the extensions block when there is no speed or course', () => {
    const gpx = buildDayGpx([point({ speed_ms: null, course_rad: null })], '2026-03-01', 'Mermug');
    expect(gpx).not.toContain('extensions');
  });

  it('names the track after the vessel and the day', () => {
    const gpx = buildDayGpx([point()], '2026-03-01', 'S.V.Mermug');
    expect(gpx).toContain('<name>S.V.Mermug — 2026-03-01</name>');
  });

  it('escapes a vessel name containing XML metacharacters', () => {
    const gpx = buildDayGpx([point()], '2026-03-01', 'Salt & Pepper');
    expect(gpx).toContain('creator="Salt &amp; Pepper"');
    expect(gpx).not.toMatch(/creator="Salt & /);
  });
});

describe('makeTrackMeta', () => {
  const points = [
    point({ timestamp: '2026-03-01T18:00:00Z', latitude: 37.8, longitude: -122.4, speed_ms: 2 }),
    point({ timestamp: '2026-03-01T19:30:00Z', latitude: 37.9, longitude: -122.4, speed_ms: 5.5 }),
  ];

  it('describes the file and the day', () => {
    const meta = makeTrackMeta('2026-03-01', points);
    expect(meta.date).toBe('2026-03-01');
    expect(meta.file).toBe('tracks/2026-03-01.gpx');
    expect(meta.points).toBe(2);
    expect(meta.start).toBe('2026-03-01T18:00:00Z');
    expect(meta.end).toBe('2026-03-01T19:30:00Z');
  });

  it('computes duration in hours', () => {
    expect(makeTrackMeta('2026-03-01', points).duration_hours).toBe(1.5);
  });

  it('converts peak speed to knots', () => {
    expect(makeTrackMeta('2026-03-01', points).max_speed_kts).toBe(10.7);
  });

  it('sums distance in nautical miles', () => {
    // 0.1 degrees of latitude is ~6 nm.
    expect(makeTrackMeta('2026-03-01', points).distance_nm).toBeCloseTo(6, 1);
  });
});

describe('groupPointsByDay', () => {
  it('groups by local calendar day, not by UTC date', () => {
    // 2026-03-01T22:00Z is 14:00 on the US west coast — the middle of the
    // sailing day. Grouping by the UTC date would cut the day in half here.
    const entries = [
      entry('2026-03-01T22:00:00Z', 37.9, -122.5),
      entry('2026-03-02T02:00:00Z', 37.95, -122.55),
    ];
    const byDay = groupPointsByDay(entries, { zones: [], timezone: TZ });
    expect([...byDay.keys()]).toEqual(['2026-03-01']);
    expect(byDay.get('2026-03-01')).toHaveLength(2);
  });

  it('splits at local midnight', () => {
    const entries = [
      entry('2026-03-02T07:30:00Z', 37.9, -122.5),
      entry('2026-03-02T08:30:00Z', 37.95, -122.55),
    ];
    const byDay = groupPointsByDay(entries, { zones: [], timezone: TZ });
    expect([...byDay.keys()].sort()).toEqual(['2026-03-01', '2026-03-02']);
  });

  it('drops points inside a privacy zone instead of snapping them to the centre', () => {
    const entries = [
      entry('2026-03-01T18:00:00Z', HOME.lat, HOME.lon),
      entry('2026-03-01T19:00:00Z', 37.9, -122.5),
    ];
    const byDay = groupPointsByDay(entries, { zones: [HOME], timezone: TZ });
    expect(byDay.get('2026-03-01')).toHaveLength(1);
  });
});

describe('updateTracks', () => {
  const base = {
    zones: [HOME],
    timezone: TZ,
    vesselName: 'Mermug',
    existingIndex: [],
    publishedDays: new Set<string>(),
  };

  it('writes a GPX file and an index row for a new day', () => {
    const now = new Date('2026-03-01T20:00:00Z'); // 12:00 local
    const update = updateTracks([entry('2026-03-01T18:00:00Z', 37.9, -122.5)], { ...base, now });
    expect(Object.keys(update.files)).toEqual(['data/telemetry/tracks/2026-03-01.gpx']);
    expect(update.index.map((t) => t.date)).toEqual(['2026-03-01']);
  });

  it('rewrites today every cycle so the track grows through the day', () => {
    const now = new Date('2026-03-01T20:00:00Z');
    const update = updateTracks([entry('2026-03-01T18:00:00Z', 37.9, -122.5)], {
      ...base,
      now,
      publishedDays: new Set(['2026-03-01']),
    });
    expect(Object.keys(update.files)).toContain('data/telemetry/tracks/2026-03-01.gpx');
  });

  it('leaves an already-published past day alone', () => {
    // The position index only holds 24 hours; rebuilding yesterday from what
    // is left of it would truncate a day that is complete in the repository.
    const now = new Date('2026-03-02T20:00:00Z');
    const update = updateTracks([entry('2026-03-01T18:00:00Z', 37.9, -122.5)], {
      ...base,
      now,
      publishedDays: new Set(['2026-03-01']),
      existingIndex: [
        {
          date: '2026-03-01',
          file: 'tracks/2026-03-01.gpx',
          start: '2026-03-01T15:00:00Z',
          end: '2026-03-01T23:00:00Z',
          duration_hours: 8,
          points: 200,
          max_speed_kts: 7.2,
          distance_nm: 31,
        },
      ],
    });
    expect(update.files).toEqual({});
    expect(update.index[0]!.points).toBe(200);
  });

  it('writes a past day that was never published', () => {
    const now = new Date('2026-03-02T20:00:00Z');
    const update = updateTracks([entry('2026-03-01T18:00:00Z', 37.9, -122.5)], { ...base, now });
    expect(Object.keys(update.files)).toEqual(['data/telemetry/tracks/2026-03-01.gpx']);
  });

  it('keeps every position inside a privacy zone out of the published track', () => {
    const now = new Date('2026-03-01T20:00:00Z');
    const update = updateTracks([entry('2026-03-01T18:00:00Z', HOME.lat, HOME.lon)], {
      ...base,
      now,
    });
    expect(update.files).toEqual({});
  });
});

describe('tracks index round trip', () => {
  it('reads back what it writes, and tolerates the older bare list', () => {
    const tracks = [
      {
        date: '2026-03-01',
        file: 'tracks/2026-03-01.gpx',
        start: '2026-03-01T18:00:00Z',
        end: '2026-03-01T19:00:00Z',
        duration_hours: 1,
        points: 2,
        max_speed_kts: 5,
        distance_nm: 3,
      },
    ];
    expect(parseTracksIndex(renderTracksIndex(tracks))).toEqual(tracks);
    expect(parseTracksIndex(JSON.stringify(tracks))).toEqual(tracks);
    expect(parseTracksIndex('{broken')).toEqual([]);
    expect(parseTracksIndex(null)).toEqual([]);
  });
});
