/**
 * Removing published voyages.
 *
 * Everything else this plugin does is additive: the repository only ever
 * grows, and a year of two-minute cycles is a lot of GPX. This is the one
 * operation that takes something away, so it is deliberate rather than
 * automatic — there is no "retention" setting that quietly drops a passage
 * nobody meant to lose. It runs when someone asks for it in the webapp.
 *
 * What is removed is the per-day GPX file and its row in `tracks_index.json`.
 * The data is still in the repository's git history; what goes is the copy the
 * site serves. Nothing else is touched: `positions_index.json` is already a
 * rolling 24-hour window, and the instrument log has its own length limit.
 *
 * Today is never removed. The position index still holds today's points and
 * the next cycle would write the file straight back, so removing it would
 * report a deletion that undoes itself within two minutes.
 */
import type { TrackMeta } from './gpx';
import { localDay } from './time';

/** Repository directory holding one GPX file per local calendar day. */
export const TRACKS_DIR = 'data/telemetry/tracks';

export interface PruneRequest {
  /**
   * Keep this many days back from today; older days go. Null or zero means
   * every day except today.
   */
  olderThanDays: number | null;
}

export interface PrunePlan {
  /** Days to remove, oldest first. */
  remove: TrackMeta[];
  /** What the index becomes. */
  keep: TrackMeta[];
  /** Repository paths to delete, in the same order as `remove`. */
  paths: string[];
  /** The oldest day kept, or null when everything except today goes. */
  cutoff: string | null;
  /** The day being protected from the prune. */
  today: string;
}

/**
 * Decide what a prune would do, without doing any of it.
 *
 * Split out so the webapp can show the list and the count before anyone
 * commits to it: "remove 43 voyages, 2019-06-02 to 2026-08-14" is a different
 * decision from "remove 2".
 */
export function planPrune(
  tracks: TrackMeta[],
  options: { request: PruneRequest; now: Date; timezone: string },
): PrunePlan {
  const today = localDay(options.now, options.timezone);
  const days = Math.max(0, Math.floor(options.request.olderThanDays ?? 0));

  // The cutoff is a local calendar day, not a timestamp: tracks are grouped by
  // local day, so the boundary has to be drawn in the same units or "older
  // than 7 days" lands mid-afternoon and takes half of an eighth day with it.
  const cutoff = days > 0 ? localDay(new Date(options.now.getTime() - days * 86_400_000), options.timezone) : null;

  const sorted = [...tracks]
    .filter((track) => track && typeof track.date === 'string')
    .sort((a, b) => a.date.localeCompare(b.date));

  const remove: TrackMeta[] = [];
  const keep: TrackMeta[] = [];
  for (const track of sorted) {
    const old = cutoff === null ? true : track.date < cutoff;
    if (old && track.date !== today) remove.push(track);
    else keep.push(track);
  }

  return {
    remove,
    keep,
    // `file` in the index is relative to data/telemetry/; trust the day rather
    // than a path someone could have hand-edited into the published index.
    paths: remove.map((track) => `${TRACKS_DIR}/${track.date}.gpx`),
    cutoff,
    today,
  };
}

/** One line for the commit message and the log. */
export function describePrune(plan: PrunePlan): string {
  if (!plan.remove.length) return 'nothing to remove';
  const first = plan.remove[0]!.date;
  const last = plan.remove[plan.remove.length - 1]!.date;
  const range = first === last ? first : `${first} to ${last}`;
  return `${plan.remove.length} voyage${plan.remove.length === 1 ? '' : 's'} (${range})`;
}
