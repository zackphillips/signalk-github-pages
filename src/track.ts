/**
 * The track, recorded from deltas rather than sampled once a cycle.
 *
 * The plugin used to take one position off the self tree per publish — two
 * minutes apart underway. A tack became a corner, a sequence of short boards
 * became a straight line, and a day of coastal sailing was 240 points of
 * which the interesting ones were missing. Inside the server process the
 * fixes are already arriving as deltas, several a second on a decent GPS, so
 * this subscribes to them instead.
 *
 * ## Why this does not simply record everything
 *
 * The Git Data API uploads whole files. The day's GPX is rewritten on every
 * cycle, so its size is not a one-off cost — it is paid again every two
 * minutes until midnight. Recording at 1 Hz would be ~30k points and a couple
 * of megabytes per cycle by evening, over a hotspot.
 *
 * So fixes are decimated by *shape* rather than by time: a point is kept when
 * dropping it would visibly move the drawn track, and skipped when the line
 * through its neighbours already passes within `detailMetres` of it. On a
 * straight motoring leg that is almost no points; through a tacking duel it
 * is dense where the detail is. The result is a better track than two-minute
 * sampling for fewer points, which is the opposite of the usual trade.
 *
 * One floor stops it being clever at the wrong moment: a fix is kept at least
 * once per publish cycle whatever the shape says, so a slow drift is still
 * recorded and the track is never coarser than the sampling it replaces. The
 * floor follows the cadence rather than being a constant — at anchor that is
 * one fix an hour, as before, and a fixed 120s would have turned a quiet
 * night into 720 points of a boat sitting still. When no delta arrives at
 * all, the publisher falls back to the fix on the tree.
 *
 * ## Privacy
 *
 * Nothing here redacts. Every fix goes into `buildPositionEntry`, which is
 * the one place a position becomes a published value and the one place the
 * privacy zones are applied — recording more fixes must not become a second
 * path to the repository. This module's output is a list of candidates; the
 * publisher decides what a candidate becomes.
 */
import type { SignalKApp } from './signalk';
import type { PositionFix } from './snapshot';

/** Default: a point is dropped when the track would move less than this. */
export const DEFAULT_TRACK_DETAIL_METRES = 15;

/**
 * Cap on the candidate window.
 *
 * Deviation is measured against every unemitted fix, so a leg with no bend
 * in it would grow the window without limit and turn the scan quadratic.
 *
 * At the cap the *newest* fix is committed and the window cleared, which
 * anchors the next segment there and bounds the work. Committing the oldest
 * and dropping one instead — which is what this did first — leaves the
 * window sitting at the cap, so every subsequent fix commits too and the
 * decimator silently degenerates into recording everything: a night at
 * anchor came out as 42601 points of 43200 rather than the couple of dozen
 * the shape deserves.
 *
 * In practice the time floor fires long before this does; the cap only bites
 * when deltas arrive faster than about 5 Hz.
 */
const MAX_WINDOW = 600;

export interface DecimatorOptions {
  detailMetres: number;
  /** A function, because the publish cadence changes with navigation.state. */
  maxIntervalSeconds: number | (() => number);
}

/** Metres per degree of latitude. Good enough for a cross-track of metres. */
const METRES_PER_DEGREE = 111_320;

/**
 * Perpendicular distance from `point` to the segment `start`–`end`, in metres.
 *
 * Equirectangular projection around the segment's latitude: over the hundreds
 * of metres this is ever asked about, the error is far below the tolerance it
 * is compared against, and it avoids trigonometry on every delta.
 */
export function crossTrackMetres(
  start: { latitude: number; longitude: number },
  end: { latitude: number; longitude: number },
  point: { latitude: number; longitude: number },
): number {
  const scale = Math.cos((start.latitude * Math.PI) / 180);
  const x = (p: { longitude: number }) => p.longitude * scale * METRES_PER_DEGREE;
  const y = (p: { latitude: number }) => p.latitude * METRES_PER_DEGREE;

  const ax = x(start);
  const ay = y(start);
  const bx = x(end);
  const by = y(end);
  const px = x(point);
  const py = y(point);

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  // Start and end are the same place: the boat has not moved, so the
  // "deviation" is simply how far the candidate is from that place.
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);

  // Clamped projection, so a point beyond either end measures to that end
  // rather than to the infinite line — which is what makes a hook in the
  // track register instead of reading as on-course.
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Decide which fixes to keep, one delta at a time.
 *
 * Pure and synchronous, so the rule can be tested against a real track
 * without a server or a clock.
 */
export class TrackDecimator {
  /** The last fix committed to the track. */
  private anchor: PositionFix | null = null;
  /** Fixes seen since the anchor, still candidates for being dropped. */
  private window: PositionFix[] = [];

  constructor(private readonly options: DecimatorOptions) {}

  private static time(fix: PositionFix): number {
    const parsed = fix.timestamp ? Date.parse(fix.timestamp) : NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Offer a fix. Returns the fixes that should be recorded, in order.
   *
   * Usually empty: most deltas on a straight course are dropped. It returns
   * a list rather than a single fix because committing a corner also commits
   * everything the window was holding behind it.
   */
  add(fix: PositionFix): PositionFix[] {
    if (!this.anchor) {
      this.anchor = fix;
      return [fix];
    }

    const maxInterval =
      typeof this.options.maxIntervalSeconds === 'function'
        ? this.options.maxIntervalSeconds()
        : this.options.maxIntervalSeconds;
    const elapsed = TrackDecimator.time(fix) - TrackDecimator.time(this.anchor);
    if (elapsed >= maxInterval * 1000) {
      // Too long since the last kept fix. Keep this one whatever the shape
      // says, so a boat drifting slowly at anchor still leaves a track.
      return this.commit(fix);
    }

    // Would the straight line from the anchor to this fix pass close enough
    // to everything in between? If so, none of them need recording.
    const worst = this.window.reduce(
      (most, candidate) => {
        const deviation = crossTrackMetres(this.anchor!, fix, candidate);
        return deviation > most.deviation ? { candidate, deviation } : most;
      },
      { candidate: null as PositionFix | null, deviation: 0 },
    );

    if (worst.candidate && worst.deviation > this.options.detailMetres) {
      // The track bends here. Commit the point that bends it most, and start
      // measuring again from there — this fix stays a candidate.
      const index = this.window.indexOf(worst.candidate);
      const kept = worst.candidate;
      this.anchor = kept;
      this.window = this.window.slice(index + 1);
      this.window.push(fix);
      return [kept];
    }

    this.window.push(fix);
    if (this.window.length >= MAX_WINDOW) return this.commit(fix);
    return [];
  }

  /** Commit `fix` and forget the window behind it. */
  private commit(fix: PositionFix): PositionFix[] {
    this.anchor = fix;
    this.window = [];
    return [fix];
  }

  /** The most recent fix seen, kept or not. */
  latest(): PositionFix | null {
    return this.window[this.window.length - 1] ?? this.anchor;
  }
}

/** Anything that can hand out a self stream: the server, or a test double. */
export type TrackHost = Partial<Pick<SignalKApp, 'streambundle'>>;

export interface RecorderOptions {
  app: TrackHost;
  detailMetres: number;
  maxIntervalSeconds: number;
  log: (message: string) => void;
}

/** A position with the two values the track carries alongside it. */
function toFix(
  value: unknown,
  speedOverGround: number | null,
  heading: number | null,
  timestamp: string,
): PositionFix | null {
  if (!value || typeof value !== 'object') return null;
  const { latitude, longitude } = value as { latitude?: unknown; longitude?: unknown };
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude, timestamp, speedOverGround, courseOverGroundTrue: heading };
}

/**
 * Subscribe to position deltas and accumulate a decimated track.
 *
 * Nothing here is required: a server without `streambundle` — or one where
 * the subscription throws — leaves `available()` false, and the publisher
 * falls back to one fix per cycle off the tree, which is what this plugin
 * did before.
 */
export class PositionRecorder {
  private readonly decimator: TrackDecimator;
  private readonly unsubscribes: Array<() => void> = [];
  private pending: PositionFix[] = [];
  private speedOverGround: number | null = null;
  private heading: number | null = null;
  private subscribed = false;
  private maxIntervalSeconds: number;

  constructor(private readonly options: RecorderOptions) {
    this.maxIntervalSeconds = options.maxIntervalSeconds;
    this.decimator = new TrackDecimator({
      detailMetres: options.detailMetres,
      maxIntervalSeconds: () => this.maxIntervalSeconds,
    });
  }

  /**
   * Follow the publish cadence.
   *
   * The time floor is the publish interval rather than a constant, so the
   * track is never sparser than the one-fix-per-cycle sampling this replaced
   * and never denser either when nothing is happening: at anchor that is one
   * fix an hour, as before, plus whatever the boat's actual swinging earns.
   * A constant 120s would have turned a quiet night at anchor into 720
   * points of a boat sitting still.
   */
  setPublishInterval(seconds: number): void {
    this.maxIntervalSeconds = Math.max(1, seconds);
  }

  private listen(path: string, onValue: (value: unknown) => void): void {
    const stream = this.options.app.streambundle?.getSelfStream?.(path as never);
    if (!stream || typeof stream.onValue !== 'function') {
      throw new Error(`no self stream for ${path}`);
    }
    // Bacon's onValue returns its own unsubscribe function.
    const off = stream.onValue((value: unknown) => {
      try {
        onValue(value);
      } catch {
        // A malformed delta is one skipped fix, never a thrown exception in
        // the server's event loop: this runs on the navigation data hub.
      }
    });
    if (typeof off === 'function') this.unsubscribes.push(off);
  }

  /** Subscribe. Returns false when this server cannot provide the streams. */
  start(): boolean {
    try {
      this.listen('navigation.speedOverGround', (value) => {
        this.speedOverGround = typeof value === 'number' ? value : null;
      });
      // headingTrue, not courseOverGroundTrue: it is what the published GPX
      // has always carried and what the frontend's course arrow reads.
      this.listen('navigation.headingTrue', (value) => {
        this.heading = typeof value === 'number' ? value : null;
      });
      this.listen('navigation.position', (value) => {
        const fix = toFix(value, this.speedOverGround, this.heading, new Date().toISOString());
        if (fix) this.pending.push(...this.decimator.add(fix));
      });
    } catch (error: any) {
      this.stop();
      this.options.log(
        `Recording the track from deltas is not available (${error?.message ?? error}); ` +
          'falling back to one fix per publish cycle.',
      );
      return false;
    }
    this.subscribed = true;
    this.options.log(
      `Recording the track from navigation.position deltas, keeping a fix when the ` +
        `track would move more than ${this.options.detailMetres} m, and at least ` +
        'once per publish cycle.',
    );
    return true;
  }

  available(): boolean {
    return this.subscribed;
  }

  /** Take everything recorded since the last call. */
  drain(): PositionFix[] {
    const fixes = this.pending;
    this.pending = [];
    return fixes;
  }

  stop(): void {
    for (const off of this.unsubscribes.splice(0)) {
      try {
        off();
      } catch {
        // Unsubscribing a stream that is already gone is not a problem.
      }
    }
    this.subscribed = false;
    this.pending = [];
  }
}
