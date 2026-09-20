/**
 * `notifications.json` — what the boat is shouting about, and how often.
 *
 * Signal K keeps notifications at `notifications.<path>`, each one a leaf whose
 * value is `{state, message, method}`. The state alone is a point-in-time fact
 * and the site already publishes one of those every cycle in
 * `signalk_latest.json`; what it could not answer is "has the bilge pump alarm
 * been going off all night?". That needs a history, so this module keeps one.
 *
 * Two things are published together, and they answer different questions:
 *
 * - `active` is the current set, straight off the tree. It is what the banner
 *   raises and it is as fresh as the last publish.
 * - `events` is the firing log: one entry each time a notification *entered*
 *   an active state, or escalated within it. The frontend counts those over
 *   1, 3, 12 and 24 hours.
 *
 * ## What "fired" means here, and what it does not
 *
 * A firing is an edge, not a sample. An alarm that comes on and stays on for
 * six hours is one firing, not 180 — counting samples would make the number a
 * function of the publish cadence, which changes with `navigation.state`, so
 * the same alarm would score 30x higher underway than at anchor. Escalation
 * (warn → alarm) counts as a new firing, because it is a new thing to know.
 * A producer that re-stamps an unchanged notification every delta does not,
 * for the same reason.
 *
 * The flip side, and it is worth being honest about it in the UI: anything
 * that fires *and clears* between two publishes is never seen at all. At the
 * dock that gap is the stationary interval — an hour by default. These counts
 * are a floor, not a total.
 */
import { parseTimestamp } from './time';

export const NOTIFICATIONS_SCHEMA_VERSION = 1;

/** The longest window the frontend offers, and therefore what is retained. */
export const NOTIFICATION_RETENTION_HOURS = 24;

/**
 * Cap on retained firings.
 *
 * A sensor flapping either side of a zone boundary can fire on every cycle;
 * at the underway cadence that is 720 events a day from one path. The cap is
 * what keeps a stuck float switch from growing the file without bound — the
 * count shown is then a floor, which it already was.
 */
export const MAX_NOTIFICATION_EVENTS = 500;

export type NotificationLevel = 'ok' | 'warn' | 'alert';

/** Signal K notification states, mapped onto the three the site paints with. */
const STATE_LEVELS: Record<string, NotificationLevel> = {
  normal: 'ok',
  nominal: 'ok',
  warn: 'warn',
  caution: 'warn',
  alert: 'alert',
  alarm: 'alert',
  emergency: 'alert',
};

/** Ranked so an escalation can be told from a de-escalation. */
const LEVEL_RANK: Record<NotificationLevel, number> = { ok: 0, warn: 1, alert: 2 };

export function notificationLevel(state: unknown): NotificationLevel | null {
  if (typeof state !== 'string') return null;
  return STATE_LEVELS[state.toLowerCase()] ?? null;
}

/** Active means "worth raising": anything the level map does not call ok. */
export function isActiveState(state: unknown): boolean {
  const level = notificationLevel(state);
  return level === 'warn' || level === 'alert';
}

/** One notification as the tree currently reports it. */
export interface ObservedNotification {
  /** The path with its `notifications.` prefix stripped. */
  path: string;
  /** The raw Signal K state, kept verbatim so the UI can show alarm vs alert. */
  state: string;
  level: NotificationLevel;
  message: string;
  method: string[];
  timestamp: string | null;
}

/** One firing: the moment a notification became active, or escalated. */
export interface NotificationEvent {
  path: string;
  state: string;
  level: 'warn' | 'alert';
  message: string;
  /** When this plugin observed the edge, not when the producer stamped it. */
  at: string;
}

/** Per-path memory, so the next cycle can tell an edge from a continuation. */
export interface NotificationSeen {
  state: string;
  level: NotificationLevel;
  /** When this state was first observed — the "since" an active row shows. */
  since: string;
  /** Last cycle that saw this path at all, for pruning. */
  at: string;
}

export interface NotificationLog {
  schema_version: number;
  /** When this log started collecting; counts before it are not knowable. */
  started: string;
  events: NotificationEvent[];
  seen: Record<string, NotificationSeen>;
}

const emptyLog = (now: Date): NotificationLog => ({
  schema_version: NOTIFICATIONS_SCHEMA_VERSION,
  started: now.toISOString(),
  events: [],
  seen: {},
});

/** Keys on a Signal K leaf that are metadata, not child notification paths. */
const LEAF_KEYS = new Set([
  'value',
  'timestamp',
  '$source',
  'source',
  'meta',
  'pgn',
  'sentence',
]);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Flatten `tree.notifications` into a list.
 *
 * Recursive rather than depth-limited: notification paths mirror data paths,
 * so `notifications.electrical.batteries.house.capacity.stateOfCharge` is a
 * perfectly ordinary five-deep leaf. A node can carry both a value and
 * children — `notifications.navigation` may be a notification in its own right
 * and the parent of `notifications.navigation.anchor` — so both are walked.
 */
export function readNotifications(tree: unknown): ObservedNotification[] {
  const root = (tree as any)?.notifications;
  if (!root || typeof root !== 'object') return [];

  const found: ObservedNotification[] = [];
  const walk = (node: any, path: string[]): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const value = node.value;
    const level = notificationLevel(value?.state);
    if (level && path.length) {
      found.push({
        path: path.join('.'),
        state: String(value.state).toLowerCase(),
        level,
        message: typeof value.message === 'string' ? value.message : '',
        method: asStringArray(value.method),
        timestamp: typeof node.timestamp === 'string' ? node.timestamp : null,
      });
    }
    for (const [key, child] of Object.entries(node)) {
      if (LEAF_KEYS.has(key)) continue;
      walk(child, [...path, key]);
    }
  };
  walk(root, []);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

/** Read a log this plugin wrote, or start a fresh one. */
export function parseNotificationLog(
  raw: string | null | undefined,
  now: Date,
): NotificationLog {
  if (!raw) return emptyLog(now);
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return emptyLog(now);
  }
  const events = Array.isArray(payload?.events)
    ? payload.events.filter(
        (event: any) =>
          event && typeof event.path === 'string' && typeof event.at === 'string',
      )
    : [];
  const seen =
    payload?.seen && typeof payload.seen === 'object' && !Array.isArray(payload.seen)
      ? payload.seen
      : {};
  return {
    schema_version: NOTIFICATIONS_SCHEMA_VERSION,
    started: typeof payload?.started === 'string' ? payload.started : now.toISOString(),
    events,
    seen,
  };
}

export interface NotificationUpdate {
  log: NotificationLog;
  /** What fired on this cycle alone — what the plugin logs, not the total. */
  fired: NotificationEvent[];
}

/**
 * Fold this cycle's observations into the log and return the new one.
 *
 * Pure: it neither reads nor writes the state directory, which is what lets
 * the console preview call it without moving the publisher's state under a
 * cycle that is about to run.
 *
 * `fired` is returned rather than left to be inferred from the event count:
 * the same call prunes the far end of the window, so a cycle where one alarm
 * fired and three old events aged out is a net of minus two.
 */
export function updateNotificationLog(
  previous: NotificationLog,
  observed: ObservedNotification[],
  now: Date,
  options: { retentionHours?: number; maxEvents?: number } = {},
): NotificationUpdate {
  const retentionHours = options.retentionHours ?? NOTIFICATION_RETENTION_HOURS;
  const maxEvents = options.maxEvents ?? MAX_NOTIFICATION_EVENTS;
  const at = now.toISOString();
  const cutoff = now.getTime() - retentionHours * 3_600_000;

  const seen: Record<string, NotificationSeen> = {};
  const fired: NotificationEvent[] = [];

  for (const item of observed) {
    const before = previous.seen[item.path];
    const wasLevel = before?.level ?? 'ok';
    // An edge is entering an active state, or climbing within one. Staying
    // put is not an edge however often the producer re-sends it, and neither
    // is falling back — a clear is the end of a firing, not a new one.
    const escalated = LEVEL_RANK[item.level] > LEVEL_RANK[wasLevel];
    if (escalated && (item.level === 'warn' || item.level === 'alert')) {
      fired.push({
        path: item.path,
        state: item.state,
        level: item.level,
        message: item.message,
        at,
      });
    }
    seen[item.path] = {
      state: item.state,
      level: item.level,
      since: before && before.state === item.state ? before.since : at,
      at,
    };
  }

  // A path that has dropped out of the tree entirely is remembered until it
  // falls out of the retention window, so a notification that disappears and
  // comes back within the hour is not counted as a second firing.
  for (const [path, before] of Object.entries(previous.seen)) {
    if (seen[path]) continue;
    const lastAt = parseTimestamp(before.at);
    if (lastAt && lastAt.getTime() >= cutoff) seen[path] = before;
  }

  const events = [...previous.events, ...fired]
    .filter((event) => {
      const ts = parseTimestamp(event.at);
      return ts !== null && ts.getTime() >= cutoff;
    })
    .sort((a, b) => a.at.localeCompare(b.at));

  return {
    log: {
      schema_version: NOTIFICATIONS_SCHEMA_VERSION,
      started: previous.started,
      events: events.length > maxEvents ? events.slice(events.length - maxEvents) : events,
      seen,
    },
    fired,
  };
}

/** The log as it is kept in the plugin data dir. */
export function renderNotificationLog(log: NotificationLog): string {
  return `${JSON.stringify(log, null, 2)}\n`;
}

export interface ActiveNotification extends ObservedNotification {
  /** When this state began, as far as the log has watched. */
  since: string | null;
}

/**
 * The published file: the active set, the firing log, and how far back the
 * log actually reaches.
 *
 * `sampled_since` is the honest bound on the counts. A plugin restarted ten
 * minutes ago cannot say what fired overnight, and a UI that showed "0 in 24h"
 * for it would be inventing a quiet night.
 */
export function renderNotifications(
  log: NotificationLog,
  observed: ObservedNotification[],
  now: Date,
  options: { retentionHours?: number } = {},
): string {
  const retentionHours = options.retentionHours ?? NOTIFICATION_RETENTION_HOURS;
  const windowStart = new Date(now.getTime() - retentionHours * 3_600_000);
  const started = parseTimestamp(log.started) ?? now;
  const active: ActiveNotification[] = observed
    .filter((item) => item.level === 'warn' || item.level === 'alert')
    .map((item) => ({ ...item, since: log.seen[item.path]?.since ?? null }))
    .sort((a, b) =>
      LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.path.localeCompare(b.path),
    );

  return `${JSON.stringify(
    {
      schema_version: NOTIFICATIONS_SCHEMA_VERSION,
      generated: now.toISOString(),
      window_hours: retentionHours,
      sampled_since: (started > windowStart ? started : windowStart).toISOString(),
      active,
      events: log.events,
    },
    null,
    2,
  )}\n`;
}
