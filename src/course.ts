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
 */
import type { CourseInfo, SignalKApp } from './signalk';

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
): Promise<Passage | null> {
  if (typeof app.getCourse !== 'function') return null;
  try {
    return passageFromCourse(await app.getCourse());
  } catch (error: any) {
    onProblem(`Could not read the course: ${error?.message ?? error}`);
    return null;
  }
}
