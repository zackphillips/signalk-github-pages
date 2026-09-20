import { describe, expect, it } from 'vitest';
import {
  MAX_NOTIFICATION_EVENTS,
  isActiveState,
  notificationLevel,
  parseNotificationLog,
  readNotifications,
  renderNotifications,
  updateNotificationLog,
  type NotificationLog,
  type ObservedNotification,
} from '../src/notifications';

const NOW = new Date('2026-03-01T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

const observe = (
  path: string,
  state: string,
  message = '',
): ObservedNotification => ({
  path,
  state,
  level: notificationLevel(state)!,
  message,
  method: [],
  timestamp: null,
});

const fresh = (now = NOW): NotificationLog => parseNotificationLog(null, now);

/** Fold a sequence of [minutesAgo, observations] into a log. */
const replay = (
  steps: Array<[number, ObservedNotification[]]>,
  start: NotificationLog = fresh(at(24 * 60)),
): NotificationLog =>
  steps.reduce(
    (log, [minutes, observed]) => updateNotificationLog(log, observed, at(minutes)).log,
    start,
  );

describe('readNotifications', () => {
  it('flattens the notifications branch into paths without the prefix', () => {
    const found = readNotifications({
      notifications: {
        environment: {
          depth: {
            belowTransducer: {
              value: { state: 'alarm', message: 'Shallow', method: ['sound'] },
              timestamp: '2026-03-01T11:59:00Z',
            },
          },
        },
      },
    });
    expect(found).toEqual([
      {
        path: 'environment.depth.belowTransducer',
        state: 'alarm',
        level: 'alert',
        message: 'Shallow',
        method: ['sound'],
        timestamp: '2026-03-01T11:59:00Z',
      },
    ]);
  });

  it('reads a node that is both a notification and a parent of one', () => {
    // notifications.navigation.anchor can be raised while
    // notifications.navigation.anchor.currentRadius is raised separately, and
    // a walk that stopped at the first value would drop the deeper one.
    const found = readNotifications({
      notifications: {
        navigation: {
          anchor: {
            value: { state: 'warn', message: 'Anchor watch' },
            timestamp: '2026-03-01T11:00:00Z',
            currentRadius: {
              value: { state: 'alarm', message: 'Dragging' },
              timestamp: '2026-03-01T11:30:00Z',
            },
          },
        },
      },
    });
    expect(found.map((item) => item.path)).toEqual([
      'navigation.anchor',
      'navigation.anchor.currentRadius',
    ]);
  });

  it('ignores a tree with no notifications, and a leaf with no state', () => {
    expect(readNotifications({})).toEqual([]);
    expect(readNotifications({ notifications: { foo: { value: { message: 'hi' } } } })).toEqual([]);
    expect(readNotifications({ notifications: { foo: { value: { state: 'bogus' } } } })).toEqual([]);
  });
});

describe('notificationLevel', () => {
  it('maps every state Signal K defines onto one of three levels', () => {
    expect(notificationLevel('normal')).toBe('ok');
    expect(notificationLevel('nominal')).toBe('ok');
    expect(notificationLevel('warn')).toBe('warn');
    expect(notificationLevel('ALARM')).toBe('alert');
    expect(notificationLevel('emergency')).toBe('alert');
    expect(notificationLevel('made up')).toBeNull();
    expect(isActiveState('normal')).toBe(false);
    expect(isActiveState('warn')).toBe(true);
  });
});

describe('updateNotificationLog', () => {
  it('counts an edge into an active state, once', () => {
    const log = replay([
      [60, [observe('a', 'normal')]],
      [50, [observe('a', 'alarm', 'Bilge high')]],
      [40, [observe('a', 'alarm', 'Bilge high')]],
      [30, [observe('a', 'alarm', 'Bilge high')]],
    ]);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({ path: 'a', state: 'alarm', level: 'alert' });
  });

  it('does not count a sample: the cadence must not change the number', () => {
    // The same six hours of one continuous alarm, sampled every two minutes
    // underway and every hour at the dock, has to score the same.
    const underway = replay(
      Array.from({ length: 180 }, (_, i): [number, ObservedNotification[]] => [
        360 - i * 2,
        [observe('a', 'alarm')],
      ]),
    );
    const anchored = replay(
      Array.from({ length: 6 }, (_, i): [number, ObservedNotification[]] => [
        360 - i * 60,
        [observe('a', 'alarm')],
      ]),
    );
    expect(underway.events).toHaveLength(1);
    expect(anchored.events).toHaveLength(1);
  });

  it('counts a re-arm after a clear as a second firing', () => {
    const log = replay([
      [60, [observe('a', 'alarm')]],
      [50, [observe('a', 'normal')]],
      [40, [observe('a', 'alarm')]],
    ]);
    expect(log.events).toHaveLength(2);
  });

  it('counts an escalation but not a de-escalation', () => {
    const log = replay([
      [60, [observe('a', 'warn')]],
      [50, [observe('a', 'alarm')]],
      [40, [observe('a', 'warn')]],
    ]);
    expect(log.events.map((event) => event.state)).toEqual(['warn', 'alarm']);
  });

  it('ignores a producer that re-stamps an unchanged notification', () => {
    const restamped = (timestamp: string) => ({ ...observe('a', 'alarm'), timestamp });
    const log = replay([
      [60, [restamped('2026-03-01T11:00:00Z')]],
      [50, [restamped('2026-03-01T11:10:00Z')]],
      [40, [restamped('2026-03-01T11:20:00Z')]],
    ]);
    expect(log.events).toHaveLength(1);
  });

  it('does not re-fire a notification that drops out of the tree and returns', () => {
    // A producer restarting takes its notification with it. That is not the
    // alarm clearing, and the alarm coming back is not a new firing.
    const log = replay([
      [60, [observe('a', 'alarm')]],
      [50, []],
      [40, [observe('a', 'alarm')]],
    ]);
    expect(log.events).toHaveLength(1);
  });

  it('holds `since` across an unchanged state and moves it on a change', () => {
    const log = replay([
      [60, [observe('a', 'warn')]],
      [50, [observe('a', 'warn')]],
      [40, [observe('a', 'alarm')]],
    ]);
    expect(log.seen.a.since).toBe(at(40).toISOString());
  });

  it('drops events past the retention window', () => {
    const log = replay([
      [26 * 60, [observe('a', 'alarm')]],
      [25 * 60, [observe('a', 'normal')]],
      [60, [observe('a', 'alarm')]],
    ]);
    expect(log.events).toHaveLength(1);
    expect(log.events[0].at).toBe(at(60).toISOString());
  });

  it('caps the log so a flapping sensor cannot grow the file without bound', () => {
    let log = fresh(at(24 * 60));
    // One flap per minute for twelve hours: 360 firings at the default cap of
    // 500 is under it, so push it well past.
    for (let i = 0; i < 1400; i++) {
      const minutes = 1400 - i;
      log = updateNotificationLog(
        log,
        [observe('a', i % 2 === 0 ? 'alarm' : 'normal')],
        at(minutes),
      ).log;
    }
    expect(log.events.length).toBe(MAX_NOTIFICATION_EVENTS);
    // The cap keeps the newest, which is what a "last hour" count reads. The
    // loop clears on its last step, so the newest firing is the one before it.
    expect(log.events[log.events.length - 1].at).toBe(at(2).toISOString());
  });

  it('reports what fired on this cycle, not the net change in the log', () => {
    // A cycle can fire one alarm and age three events out at the same time.
    const seeded = replay([
      [24 * 60 + 5, [observe('old', 'alarm')]],
      [24 * 60 + 4, [observe('old', 'normal')]],
      [24 * 60 + 3, [observe('old', 'alarm')]],
    ]);
    const { log, fired } = updateNotificationLog(seeded, [observe('new', 'warn')], NOW);
    expect(fired.map((event) => event.path)).toEqual(['new']);
    expect(log.events.map((event) => event.path)).toEqual(['new']);
  });
});

describe('parseNotificationLog', () => {
  it('starts fresh on missing, unparseable or foreign content', () => {
    for (const raw of [null, '', 'not json', '{"events": "nope"}']) {
      const log = parseNotificationLog(raw, NOW);
      expect(log.events).toEqual([]);
      expect(log.seen).toEqual({});
      expect(log.started).toBe(NOW.toISOString());
    }
  });

  it('round-trips a log it wrote', () => {
    const written = replay([[60, [observe('a', 'alarm')]]]);
    const read = parseNotificationLog(`${JSON.stringify(written)}\n`, NOW);
    expect(read.events).toEqual(written.events);
    expect(read.started).toBe(written.started);
  });
});

describe('renderNotifications', () => {
  const observed = [observe('b', 'warn', 'Tank filling'), observe('a', 'alarm', 'Shallow')];
  const log = replay([
    [90, [observe('a', 'alarm'), observe('b', 'normal')]],
    [60, [observe('a', 'alarm'), observe('b', 'warn')]],
  ]);
  const payload = JSON.parse(renderNotifications(log, observed, NOW));

  it('puts the worst active notification first', () => {
    expect(payload.active.map((item: any) => item.path)).toEqual(['a', 'b']);
  });

  it('carries when each active state began', () => {
    expect(payload.active[0].since).toBe(at(90).toISOString());
    expect(payload.active[1].since).toBe(at(60).toISOString());
  });

  it('bounds the counts by how far back the log actually reaches', () => {
    // A plugin started ninety minutes ago cannot say the night was quiet.
    expect(payload.sampled_since).toBe(at(24 * 60).toISOString());
    const young = JSON.parse(
      renderNotifications(fresh(at(30)), observed, NOW),
    );
    expect(young.sampled_since).toBe(at(30).toISOString());
  });

  it('omits a notification that has gone back to normal from `active`', () => {
    const cleared = JSON.parse(renderNotifications(log, [observe('a', 'normal')], NOW));
    expect(cleared.active).toEqual([]);
    expect(cleared.events.length).toBeGreaterThan(0);
  });
});
