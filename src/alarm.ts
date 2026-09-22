/**
 * Telling the boat when publishing has stopped working.
 *
 * Everything this plugin reports goes to `app.debug`, `app.error` and the
 * plugin status line, which are all in the Signal K admin UI — a browser tab
 * nobody has open at sea. A token that expired, an organization that revoked
 * it, a repository renamed: the site simply stops updating, and the first
 * anyone ashore knows is that the boat appears to have stopped.
 *
 * So one thing, and only one, goes into the data model as a notification:
 * publishing has been failing for a while. A notification is not a
 * measurement — it is the mechanism the whole boat already uses to get
 * someone's attention, and it reaches KIP, the chartplotter and any alarm
 * plugin without this one needing to know they exist.
 *
 * This is a deliberate exception to "publish state stays out of the Signal K
 * tree", and the boundary is worth keeping sharp. Cost, commit SHAs, rate
 * limits and per-cycle results stay in the log, because they are telemetry
 * about a plugin and nobody needs an alarm for them. What goes here is the
 * one condition a person would want to be told about while it is happening.
 *
 * ## Why it waits
 *
 * A single failed cycle is normal: a marina hotspot drops, GitHub answers
 * 502, a DNS lookup times out. The next cycle retries and nobody should be
 * woken for it. The alarm fires only once failures have been continuous for
 * `afterMinutes`, which at the underway cadence is fifteen consecutive
 * attempts — by then it is not the weather.
 */

/** What the caller should do to the notification tree, if anything. */
export type AlarmAction =
  | { kind: 'none' }
  | { kind: 'raise'; message: string; failures: number; sinceMinutes: number }
  | { kind: 'clear' };

export interface FailureAlarmOptions {
  /** Minutes of continuous failure before raising. Zero or less disables it. */
  afterMinutes: number;
}

/**
 * Tracks a run of consecutive failures and says when to raise or clear.
 *
 * Pure: it is given the time rather than reading a clock, so the thresholds
 * can be tested without waiting half an hour.
 */
export class FailureAlarm {
  /** When the current unbroken run of failures began, or null if none. */
  private since: Date | null = null;
  private failures = 0;
  private raised = false;

  constructor(private readonly options: FailureAlarmOptions) {}

  /** A cycle failed. */
  recordFailure(now: Date, reason: string): AlarmAction {
    if (this.options.afterMinutes <= 0) return { kind: 'none' };
    if (!this.since) this.since = now;
    this.failures += 1;

    const elapsedMinutes = (now.getTime() - this.since.getTime()) / 60_000;
    if (this.raised || elapsedMinutes < this.options.afterMinutes) return { kind: 'none' };

    this.raised = true;
    const sinceMinutes = Math.round(elapsedMinutes);
    return {
      kind: 'raise',
      failures: this.failures,
      sinceMinutes,
      message:
        `The tracker has not published for ${sinceMinutes} minutes ` +
        `(${this.failures} failed attempts). Last error: ${reason}`,
    };
  }

  /** A cycle succeeded. Clears the run, and the alarm if one was raised. */
  recordSuccess(): AlarmAction {
    const wasRaised = this.raised;
    this.since = null;
    this.failures = 0;
    this.raised = false;
    return wasRaised ? { kind: 'clear' } : { kind: 'none' };
  }

  /** True while the alarm is up, for the plugin status line. */
  isRaised(): boolean {
    return this.raised;
  }
}
