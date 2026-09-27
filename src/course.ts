/**
 * The passage banner, from the Course API.
 *
 * The banner used to be a `passage:` block hand-edited into `info.yaml` from
 * the GitHub web UI before departure and deleted on arrival. It was the last
 * thing on the site that needed a person to type something into a file, and
 * like every hand-maintained field it was wrong whenever someone forgot: a
 * boat that had been home for a fortnight still said it was bound for Santa
 * Cruz.
 *
 * The server already knows. Activate a waypoint or a route on the plotter and
 * the Course API has the destination, the point departed from and the moment
 * navigation started — `startTime` is exactly the "departed" field, with no
 * state for this plugin to keep. Clear the destination on arrival, which is
 * what everyone does anyway, and the banner goes away by itself.
 *
 * ## Two things this deliberately does not publish
 *
 * **Positions.** `nextPoint.position` and `previousPoint.position` are raw
 * coordinates. A boat that departs from its home slip would put that slip on
 * a public website through a path the privacy zones do not guard — they
 * redact `navigation.position` on its way into the snapshot and the track,
 * and nothing about a course. Only names are published, and a point with no
 * name contributes nothing rather than falling back to its coordinates.
 *
 * **The ETA.** `targetArrivalTime` is recomputed from speed made good on
 * every update, so publishing it would rewrite `site.json` on every cycle for
 * a number that moves by a minute. The file is rewritten only when its
 * content changes, and this is what keeps that true.
 *
 * ## A course nobody cleared
 *
 * Clearing the destination on arrival is what everyone does, until they do
 * not, and then the banner says the boat is bound for Santa Cruz from its own
 * slip for as long as the plotter stays on — the hand-edited `info.yaml`
 * failure again, with the server as the one that forgot. `staleCourseReason`
 * drops a course the boat is plainly done with:
 *
 * - **Arrived.** The boat is inside the destination's arrival circle. The
 *   server advances a route past a waypoint it reaches; a single waypoint just
 *   sits there, reached.
 * - **Stopped.** The course has been active for more than
 *   `STALE_COURSE_HOURS` and the boat is not underway now. Age alone would
 *   take the banner down in the middle of a three-day delivery; not moving
 *   alone would take it down at a lunch stop. Both together is a boat home
 *   with the plotter still pointing somewhere. A passage with a night at
 *   anchor comes back the next morning, because the course is still active
 *   and the boat is moving again. On a server with no `navigation.state`
 *   the boat never reads as underway, so this is age alone: twelve hours.
 *
 * The course itself is left as it is: clearing it is the plotter's business,
 * and this only decides what the public page says.
 */
import { haversineMeters } from './privacy';
import type { CourseInfo, SignalKApp } from './signalk';
import { isUnderway, navigationState, type Tree } from './snapshot';

/** What the banner shows. Every field is optional; all-empty means no banner. */
export interface Passage {
  /** Where the boat departed from, when the course names it. */
  from?: string;
  /** The destination: the next point's name, or the route's. */
  to?: string;
  /** ISO-8601 instant navigation started, straight from `startTime`. */
  departed?: string;
  /** Route being followed, when it is a route rather than a single point. */
  route?: string;
}

/** Hours a course can be active, with the boat not underway, before it is dropped. */
export const STALE_COURSE_HOURS = 12;

/**
 * Arrival radius when the course has none: 0.1 NM, the default most plotters
 * ship for their own arrival alarm.
 */
const DEFAULT_ARRIVAL_METERS = 185;

/**
 * Why a course is one the boat is done with, or null when it is live.
 *
 * `tree` is the raw self tree: the position is compared with the destination
 * here and goes nowhere else.
 */
export function staleCourseReason(
  course: CourseInfo | null | undefined,
  tree: Tree | undefined,
  now: Date,
): string | null {
  if (!course) return null;

  const here = tree?.navigation?.position?.value;
  const there = course.nextPoint?.position;
  if (
    Number.isFinite(here?.latitude) &&
    Number.isFinite(here?.longitude) &&
    Number.isFinite(there?.latitude) &&
    Number.isFinite(there?.longitude)
  ) {
    const radius = course.arrivalCircle > 0 ? course.arrivalCircle : DEFAULT_ARRIVAL_METERS;
    const meters = haversineMeters(here.latitude, here.longitude, there!.latitude, there!.longitude);
    if (meters <= radius) return 'the boat is inside the destination\'s arrival circle';
  }

  // Without a tree there is nothing to say the boat is stopped.
  if (!tree) return null;
  const started = Date.parse(course.startTime ?? '');
  const state = navigationState(tree);
  if (
    Number.isFinite(started) &&
    now.getTime() - started > STALE_COURSE_HOURS * 3_600_000 &&
    !isUnderway(state)
  ) {
    return (
      `the course has been active for more than ${STALE_COURSE_HOURS} hours and the boat ` +
      `is ${state ?? 'not reporting navigation.state'}`
    );
  }
  return null;
}

/** The server, as far as the course is concerned. */
export type CourseHost = Partial<Pick<SignalKApp, 'getCourse'>>;

function name(value: string | undefined | null): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

/**
 * Map what the Course API reports onto the banner's four fields.
 *
 * Split out from the read so the mapping is testable without a server.
 */
export function passageFromCourse(course: CourseInfo | null | undefined): Passage | null {
  if (!course) return null;

  const route = name(course.activeRoute?.name);
  const passage: Passage = {};
  const to = name(course.nextPoint?.name) ?? route;
  if (to) passage.to = to;
  if (route) passage.route = route;

  const from = name(course.previousPoint?.name);
  if (from) passage.from = from;

  // A start time on its own is not a passage: the banner would read "departed
  // at 09:14" with no indication of where from or to.
  const departed = name(course.startTime);
  if (departed && (passage.to || passage.from)) passage.departed = departed;

  return passage.to || passage.from ? passage : null;
}

/**
 * Read the current passage, or null when nothing is being navigated to.
 *
 * Never throws: the Course API is absent on older servers and can reject on a
 * current one, and neither is a reason to fail a publish. A passage that
 * could not be read is simply no banner this cycle.
 */
export async function readPassage(
  app: CourseHost,
  onProblem: (message: string) => void = () => {},
  context: { tree?: Tree; now?: Date; onStale?: (reason: string) => void } = {},
): Promise<Passage | null> {
  if (typeof app.getCourse !== 'function') return null;
  try {
    const course = await app.getCourse();
    const stale = staleCourseReason(course, context.tree, context.now ?? new Date());
    if (stale) {
      context.onStale?.(stale);
      return null;
    }
    return passageFromCourse(course);
  } catch (error: any) {
    onProblem(`Could not read the course: ${error?.message ?? error}`);
    return null;
  }
}
