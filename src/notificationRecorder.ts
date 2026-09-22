/**
 * Catching notifications that fire and clear between two publishes.
 *
 * Sampling the tree once a cycle answers "what is wrong now" perfectly and
 * "how often has this been going off" badly. At the stationary cadence the
 * gap between samples is an hour, so a bilge pump that runs for three
 * seconds every ten minutes is invisible — not undercounted, absent — and a
 * high-water alarm that trips and clears while nobody is looking never
 * happened as far as the site is concerned. Those are exactly the firings
 * worth knowing about.
 *
 * Inside the server process the notifications arrive as deltas, so this
 * subscribes to them and records each edge as it happens. The counts stop
 * being a floor and become the real number, for as long as the plugin has
 * been running.
 *
 * ## The same edge rule, applied live
 *
 * A firing is entering an active state, or escalating within one — the rule
 * `updateNotificationLog` applies between cycles, applied between deltas
 * instead. A producer that re-sends an unchanged notification on every delta
 * does not count, which matters far more here: at the tree-sampling cadence
 * a chatty producer was invisible, and at delta rate it would otherwise
 * produce hundreds of firings an hour for a condition that never changed.
 *
 * ## Why the publisher must then stop counting
 *
 * With a recorder running there are two things that could detect the same
 * edge: this, and the cycle-to-cycle comparison in `updateNotificationLog`.
 * Counting both would double every firing that happened to straddle a
 * publish. The recorder is authoritative when it is available, and the
 * publisher passes `countEdges: false` so the comparison only refreshes
 * state. On a server without the streams nothing changes: no recorder, the
 * comparison counts as it always did, and the counts are a floor again.
 */
import {
  isExcludedNotification,
  notificationLevel,
  type NotificationEvent,
  type NotificationLevel,
} from './notifications';
import type { SignalKApp } from './signalk';

/** Ranked so an escalation can be told from a de-escalation. */
const LEVEL_RANK: Record<NotificationLevel, number> = { ok: 0, warn: 1, alert: 2 };

/**
 * Cap on edges held between publishes.
 *
 * The drain interval is the publish interval — an hour at the stationary
 * cadence — and a sensor flapping either side of a threshold can fire on
 * every delta. The published log has its own cap; this one stops a wedged
 * float switch growing the plugin's memory in between, which the other cap
 * cannot do because nothing has published yet.
 */
export const MAX_PENDING_EDGES = 1000;

export interface NotificationRecorderOptions {
  app: Partial<Pick<SignalKApp, 'streambundle'>>;
  /** Paths never published; excluded before an edge is ever recorded. */
  exclude: string[];
  log: (message: string) => void;
  /** Injectable for tests. */
  now?: () => Date;
}

export class NotificationRecorder {
  private readonly unsubscribes: Array<() => void> = [];
  private pending: NotificationEvent[] = [];
  /** Level per path, so an edge can be told from a repeat. */
  private levels = new Map<string, NotificationLevel>();
  private subscribed = false;
  private dropped = 0;

  constructor(private readonly options: NotificationRecorderOptions) {}

  /** Subscribe. Returns false when this server cannot provide the bus. */
  start(): boolean {
    // Every path, because the notification paths are not knowable in
    // advance — a plugin installed next week raises one this code has never
    // seen. `getSelfBus()` with no argument is documented to do exactly
    // that ("if it is not provided the returned stream produces values for
    // all paths") while `@signalk/server-api` types the parameter as
    // required. The cast is that documented gap, not a guess about
    // behavior; the server-api header says its typing is incomplete.
    const streambundle = this.options.app.streambundle;
    const getSelfBus = streambundle?.getSelfBus as
      | ((path?: unknown) => { onValue?: (cb: (delta: unknown) => unknown) => unknown | (() => void) })
      | undefined;
    const bus = streambundle && getSelfBus ? getSelfBus.call(streambundle) : undefined;
    if (!bus || typeof bus.onValue !== 'function') {
      this.options.log(
        'Notification firings are sampled once per publish: this server offers no ' +
          'delta bus, so anything that fires and clears in between is not counted.',
      );
      return false;
    }
    try {
      const off = bus.onValue!((delta: unknown) => {
        try {
          this.observe(delta);
        } catch {
          // A malformed delta is one missed edge, never an exception in the
          // server's event loop: this runs on the navigation data hub.
        }
      });
      // Bacon's onValue returns its own unsubscribe function.
      if (typeof off === 'function') this.unsubscribes.push(off as () => void);
    } catch (error: any) {
      this.stop();
      this.options.log(
        `Could not subscribe to notification deltas (${error?.message ?? error}); ` +
          'firings will be sampled once per publish instead.',
      );
      return false;
    }
    this.subscribed = true;
    this.options.log(
      'Recording notification firings from deltas: one that fires and clears between ' +
        'publishes is counted rather than missed.',
    );
    return true;
  }

  /** Apply the edge rule to one delta from the bus. */
  private observe(delta: unknown): void {
    const record = delta as { path?: unknown; value?: unknown };
    if (typeof record?.path !== 'string') return;
    if (!record.path.startsWith('notifications.')) return;

    const path = record.path.slice('notifications.'.length);
    if (!path || isExcludedNotification(path, this.options.exclude)) return;

    const value = record.value as { state?: unknown; message?: unknown } | null | undefined;
    // A cleared notification arrives as a null value on some producers and as
    // state 'normal' on others. Both mean the same thing: back to ok.
    const level = value ? (notificationLevel(value.state) ?? 'ok') : 'ok';
    const was = this.levels.get(path) ?? 'ok';
    this.levels.set(path, level);

    if (LEVEL_RANK[level] <= LEVEL_RANK[was]) return;
    if (level !== 'warn' && level !== 'alert') return;

    if (this.pending.length >= MAX_PENDING_EDGES) {
      this.dropped += 1;
      return;
    }
    this.pending.push({
      path,
      state: typeof value?.state === 'string' ? value.state.toLowerCase() : level,
      level,
      message: typeof value?.message === 'string' ? value.message : '',
      at: (this.options.now?.() ?? new Date()).toISOString(),
    });
  }

  available(): boolean {
    return this.subscribed;
  }

  /** Take every edge seen since the last call. */
  drain(): NotificationEvent[] {
    const edges = this.pending;
    this.pending = [];
    if (this.dropped) {
      this.options.log(
        `${this.dropped} notification firing(s) dropped since the last publish: more than ` +
          `${MAX_PENDING_EDGES} in one interval, which means something is flapping.`,
      );
      this.dropped = 0;
    }
    return edges;
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
    this.levels.clear();
    this.dropped = 0;
  }
}
