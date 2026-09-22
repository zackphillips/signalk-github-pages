import { describe, expect, it } from 'vitest';
import { crossTrackMeters, PositionRecorder, TrackDecimator } from '../src/track';
import type { PositionFix } from '../src/snapshot';

const START = Date.parse('2026-03-01T18:00:00Z');

/** A fix `seconds` after the start, at a position given in degrees. */
const at = (seconds: number, latitude: number, longitude: number): PositionFix => ({
  latitude,
  longitude,
  timestamp: new Date(START + seconds * 1000).toISOString(),
  speedOverGround: 3,
  courseOverGroundTrue: 0,
});

/** Meters north/east of a reference point, as degrees. */
const METER = 1 / 111_320;
const north = (meters: number) => 37.8 + meters * METER;
const east = (meters: number) => -122.4 + (meters * METER) / Math.cos((37.8 * Math.PI) / 180);

const feed = (decimator: TrackDecimator, fixes: PositionFix[]): PositionFix[] =>
  fixes.flatMap((fix) => decimator.add(fix));

describe('crossTrackMeters', () => {
  it('measures the perpendicular offset from the line', () => {
    const a = { latitude: north(0), longitude: east(0) };
    const b = { latitude: north(0), longitude: east(1000) };
    const off = { latitude: north(50), longitude: east(500) };
    expect(crossTrackMeters(a, b, off)).toBeCloseTo(50, 0);
  });

  it('is zero for a point on the line', () => {
    const a = { latitude: north(0), longitude: east(0) };
    const b = { latitude: north(0), longitude: east(1000) };
    expect(crossTrackMeters(a, b, { latitude: north(0), longitude: east(400) })).toBeCloseTo(0, 1);
  });

  it('measures to the nearer end for a point beyond the segment', () => {
    // Unclamped, a boat that sailed out and came back would measure zero
    // against the infinite line and the hook would vanish from the track.
    const a = { latitude: north(0), longitude: east(0) };
    const b = { latitude: north(0), longitude: east(100) };
    const beyond = { latitude: north(0), longitude: east(400) };
    expect(crossTrackMeters(a, b, beyond)).toBeCloseTo(300, 0);
  });

  it('handles a boat that has not moved', () => {
    const a = { latitude: north(0), longitude: east(0) };
    expect(crossTrackMeters(a, a, { latitude: north(30), longitude: east(0) })).toBeCloseTo(30, 0);
  });
});

describe('TrackDecimator', () => {
  const options = { detailMeters: 15, maxIntervalSeconds: 120 };

  it('keeps the first fix', () => {
    const decimator = new TrackDecimator(options);
    expect(decimator.add(at(0, north(0), east(0)))).toHaveLength(1);
  });

  it('drops everything on a straight leg', () => {
    // A mile of motoring dead straight, sampled every second. None of it
    // needs recording: the line between the ends passes through all of it.
    const decimator = new TrackDecimator(options);
    const fixes = Array.from({ length: 100 }, (_, i) => at(i, north(0), east(i * 3)));
    const kept = feed(decimator, fixes);
    expect(kept).toHaveLength(1); // just the first
  });

  it('keeps the corner when the track bends', () => {
    const decimator = new TrackDecimator(options);
    // East for 300 m, then hard north for 300 m: a tack.
    const leg1 = Array.from({ length: 30 }, (_, i) => at(i, north(0), east(i * 10)));
    const leg2 = Array.from({ length: 30 }, (_, i) => at(30 + i, north(i * 10), east(300)));
    const kept = feed(decimator, [...leg1, ...leg2]);

    // The corner is recorded, not smoothed into a diagonal.
    const atCorner = kept.some(
      (fix) =>
        Math.abs(fix.longitude - east(290)) < 20 * METER &&
        Math.abs(fix.latitude - north(0)) < 20 * METER,
    );
    expect(atCorner).toBe(true);
    // ...and it does not cost many points to say so.
    expect(kept.length).toBeLessThan(10);
  });

  it('records a slalom at higher resolution than a straight line', () => {
    const straight = new TrackDecimator(options);
    const weaving = new TrackDecimator(options);
    const n = 120;
    const straightKept = feed(
      straight,
      Array.from({ length: n }, (_, i) => at(i, north(0), east(i * 5))),
    );
    const weavingKept = feed(
      weaving,
      // ±40 m either side of the rhumb line, which is a series of tacks.
      Array.from({ length: n }, (_, i) => at(i, north(i % 2 ? 40 : -40), east(i * 5))),
    );
    expect(weavingKept.length).toBeGreaterThan(straightKept.length * 5);
  });

  it('keeps a fix once the publish interval has passed, however still the boat', () => {
    // A boat at anchor produces deltas that go nowhere. Shape alone would
    // record nothing at all, and the day would have no track.
    const decimator = new TrackDecimator(options);
    decimator.add(at(0, north(0), east(0)));
    const quiet = feed(
      decimator,
      Array.from({ length: 110 }, (_, i) => at(i + 1, north(0), east(0))),
    );
    expect(quiet).toHaveLength(0);
    expect(decimator.add(at(130, north(0), east(0)))).toHaveLength(1);
  });

  it('follows the cadence when the interval is a function of it', () => {
    // At anchor the floor is the stationary interval, so a quiet hour is one
    // fix and not thirty. A constant 120s would be 720 points a day of a
    // boat sitting still.
    let interval = 3600;
    const decimator = new TrackDecimator({
      detailMeters: 15,
      maxIntervalSeconds: () => interval,
    });
    decimator.add(at(0, north(0), east(0)));
    expect(feed(decimator, [at(200, north(0), east(0)), at(3000, north(0), east(0))])).toHaveLength(0);
    interval = 120;
    expect(decimator.add(at(3100, north(0), east(0)))).toHaveLength(1);
  });

  it('does not degenerate into keeping everything once the window fills', () => {
    // The window cap used to commit the oldest candidate and drop one, which
    // left the window sitting at the cap so every subsequent fix committed
    // too. A night at anchor came out as 42601 points of 43200.
    const decimator = new TrackDecimator({ detailMeters: 15, maxIntervalSeconds: 3600 });
    const kept = feed(
      decimator,
      // 12 hours at 1 Hz swinging on a 30 m scope: the shape is real, the
      // volume is not. Neither the time floor nor a straight line applies.
      Array.from({ length: 12 * 3600 }, (_, i) =>
        at(i, north(30 * Math.cos(i / 900)), east(30 * Math.sin(i / 900))),
      ),
    );
    expect(kept.length).toBeLessThan(500);
    // ...but it still records the swing rather than a single point.
    expect(kept.length).toBeGreaterThan(10);
  });

  it('never reorders what it keeps', () => {
    const decimator = new TrackDecimator(options);
    const kept = feed(
      decimator,
      Array.from({ length: 200 }, (_, i) =>
        at(i, north(Math.sin(i / 4) * 60), east(i * 6)),
      ),
    );
    const times = kept.map((fix) => Date.parse(fix.timestamp!));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

/** A Bacon-like stream of one path, driven by hand. */
function fakeStream() {
  const listeners: Array<(value: unknown) => void> = [];
  let unsubscribed = 0;
  return {
    unsubscribed: () => unsubscribed,
    push: (value: unknown) => listeners.forEach((listener) => listener(value)),
    stream: {
      onValue: (listener: (value: unknown) => void) => {
        listeners.push(listener);
        return () => {
          unsubscribed += 1;
        };
      },
    },
  };
}

describe('PositionRecorder', () => {
  const host = (streams: Record<string, any>) => ({
    streambundle: { getSelfStream: (path: string) => streams[path] },
  });

  it('records positions, pairing them with the latest speed and heading', () => {
    const position = fakeStream();
    const speed = fakeStream();
    const heading = fakeStream();
    const recorder = new PositionRecorder({
      app: host({
        'navigation.position': position.stream,
        'navigation.speedOverGround': speed.stream,
        'navigation.headingTrue': heading.stream,
      }) as never,
      detailMeters: 15,
      maxIntervalSeconds: 120,
      log: () => {},
    });
    expect(recorder.start()).toBe(true);

    speed.push(3.2);
    heading.push(1.1);
    position.push({ latitude: 37.8, longitude: -122.4 });
    const drained = recorder.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      latitude: 37.8,
      longitude: -122.4,
      speedOverGround: 3.2,
      courseOverGroundTrue: 1.1,
    });
    // Draining takes them away, so a cycle never republishes the same fix.
    expect(recorder.drain()).toHaveLength(0);
  });

  it('ignores a delta that is not a position', () => {
    const position = fakeStream();
    const recorder = new PositionRecorder({
      app: host({
        'navigation.position': position.stream,
        'navigation.speedOverGround': fakeStream().stream,
        'navigation.headingTrue': fakeStream().stream,
      }) as never,
      detailMeters: 15,
      maxIntervalSeconds: 120,
      log: () => {},
    });
    recorder.start();
    for (const bad of [null, undefined, 'somewhere', {}, { latitude: 37.8 }, { latitude: NaN, longitude: 1 }]) {
      position.push(bad);
    }
    expect(recorder.drain()).toEqual([]);
  });

  it('reports unavailable on a server with no streams, rather than throwing', () => {
    const messages: string[] = [];
    const recorder = new PositionRecorder({
      app: {} as never,
      detailMeters: 15,
      maxIntervalSeconds: 120,
      log: (message) => messages.push(message),
    });
    expect(recorder.start()).toBe(false);
    expect(recorder.available()).toBe(false);
    expect(messages.join(' ')).toContain('falling back to one fix per publish cycle');
  });

  it('unsubscribes every stream on stop', () => {
    const position = fakeStream();
    const speed = fakeStream();
    const heading = fakeStream();
    const recorder = new PositionRecorder({
      app: host({
        'navigation.position': position.stream,
        'navigation.speedOverGround': speed.stream,
        'navigation.headingTrue': heading.stream,
      }) as never,
      detailMeters: 15,
      maxIntervalSeconds: 120,
      log: () => {},
    });
    recorder.start();
    recorder.stop();
    expect(position.unsubscribed() + speed.unsubscribed() + heading.unsubscribed()).toBe(3);
    expect(recorder.available()).toBe(false);
  });
});
