import { describe, expect, it } from 'vitest';
import { MAX_PENDING_EDGES, NotificationRecorder } from '../src/notificationRecorder';
import {
  DEFAULT_NOTIFICATION_EXCLUDE,
  parseNotificationLog,
  readNotifications,
  updateNotificationLog,
} from '../src/notifications';

const NOW = new Date('2026-03-01T20:00:00Z');

/** A Bacon-like self bus, driven by hand. */
function fakeBus() {
  const listeners: Array<(delta: unknown) => void> = [];
  let unsubscribed = 0;
  return {
    unsubscribed: () => unsubscribed,
    push: (path: string, value: unknown) => listeners.forEach((l) => l({ path, value })),
    pushRaw: (delta: unknown) => listeners.forEach((l) => l(delta)),
    app: {
      streambundle: {
        getSelfBus: () => ({
          onValue: (listener: (delta: unknown) => void) => {
            listeners.push(listener);
            return () => {
              unsubscribed += 1;
            };
          },
        }),
      },
    },
  };
}

const make = (bus: ReturnType<typeof fakeBus>, exclude: string[] = [], logs: string[] = []) =>
  new NotificationRecorder({
    app: bus.app as never,
    exclude,
    log: (message) => logs.push(message),
    now: () => NOW,
  });

describe('NotificationRecorder', () => {
  it('records a firing that would be invisible to once-a-cycle sampling', () => {
    // The whole point: a bilge pump that runs for three seconds every ten
    // minutes never appears in a tree sampled at the publish cadence.
    const bus = fakeBus();
    const recorder = make(bus);
    expect(recorder.start()).toBe(true);

    bus.push('notifications.electrical.bilgePump', { state: 'alert', message: 'Bilge running' });
    bus.push('notifications.electrical.bilgePump', { state: 'normal', message: 'Bilge idle' });

    const edges = recorder.drain();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      path: 'electrical.bilgePump',
      level: 'alert',
      state: 'alert',
      message: 'Bilge running',
    });
    // Drained, so the next cycle does not publish it again.
    expect(recorder.drain()).toEqual([]);
  });

  it('counts an edge, not every delta a chatty producer sends', () => {
    // At delta rate a producer re-sending an unchanged notification would
    // otherwise score hundreds of firings an hour for one condition.
    const bus = fakeBus();
    const recorder = make(bus);
    recorder.start();
    for (let i = 0; i < 50; i++) {
      bus.push('notifications.tanks.blackwater.bow.currentLevel', {
        state: 'warn',
        message: 'Holding tank above 50%',
      });
    }
    expect(recorder.drain()).toHaveLength(1);
  });

  it('counts an escalation but not a de-escalation', () => {
    const bus = fakeBus();
    const recorder = make(bus);
    recorder.start();
    bus.push('notifications.environment.depth', { state: 'warn', message: 'Shoaling' });
    bus.push('notifications.environment.depth', { state: 'alarm', message: 'Shallow' });
    bus.push('notifications.environment.depth', { state: 'warn', message: 'Shoaling' });
    const edges = recorder.drain();
    expect(edges.map((e) => e.level)).toEqual(['warn', 'alert']);
  });

  it('treats a cleared notification as ok, however the producer spells it', () => {
    // Some producers clear with state 'normal', others by sending null.
    const bus = fakeBus();
    const recorder = make(bus);
    recorder.start();
    bus.push('notifications.a', { state: 'alarm', message: 'x' });
    bus.push('notifications.a', null);
    bus.push('notifications.a', { state: 'alarm', message: 'x' });
    expect(recorder.drain()).toHaveLength(2);

    bus.push('notifications.b', { state: 'warn', message: 'y' });
    bus.push('notifications.b', { state: 'normal', message: 'y' });
    bus.push('notifications.b', { state: 'warn', message: 'y' });
    expect(recorder.drain()).toHaveLength(2);
  });

  it('never records an excluded path', () => {
    const bus = fakeBus();
    const recorder = make(bus, DEFAULT_NOTIFICATION_EXCLUDE);
    recorder.start();
    bus.push('notifications.server.history.defaultProvider', { state: 'warn', message: 'none' });
    bus.push('notifications.environment.depth', { state: 'alarm', message: 'Shallow' });
    expect(recorder.drain().map((e) => e.path)).toEqual(['environment.depth']);
  });

  it('ignores deltas that are not notifications', () => {
    const bus = fakeBus();
    const recorder = make(bus);
    recorder.start();
    bus.push('navigation.position', { latitude: 37.8, longitude: -122.4 });
    bus.push('notificationsomething.else', { state: 'alarm' });
    bus.pushRaw({ value: { state: 'alarm' } });
    bus.pushRaw(null);
    bus.pushRaw('nonsense');
    expect(recorder.drain()).toEqual([]);
  });

  it('caps what it holds between publishes, and says how much it dropped', () => {
    // The drain interval is the publish interval — an hour at the dock — and
    // a wedged float switch can fire on every delta.
    const logs: string[] = [];
    const bus = fakeBus();
    const recorder = make(bus, [], logs);
    recorder.start();
    for (let i = 0; i < MAX_PENDING_EDGES + 25; i++) {
      bus.push(`notifications.flap.${i}`, { state: 'alarm', message: 'x' });
    }
    expect(recorder.drain()).toHaveLength(MAX_PENDING_EDGES);
    expect(logs.join(' ')).toContain('25 notification firing(s) dropped');
  });

  it('reports unavailable on a server with no bus, rather than throwing', () => {
    const logs: string[] = [];
    const recorder = new NotificationRecorder({
      app: {} as never,
      exclude: [],
      log: (m) => logs.push(m),
    });
    expect(recorder.start()).toBe(false);
    expect(recorder.available()).toBe(false);
    expect(logs.join(' ')).toContain('sampled once per publish');
  });

  it('unsubscribes on stop', () => {
    const bus = fakeBus();
    const recorder = make(bus);
    recorder.start();
    recorder.stop();
    expect(bus.unsubscribed()).toBe(1);
    expect(recorder.available()).toBe(false);
  });
});

describe('the recorder and the cycle comparison together', () => {
  const tree = {
    notifications: {
      environment: { depth: { value: { state: 'alarm', message: 'Shallow' } } },
    },
  };

  it('counts a firing once, not twice, when both could see it', () => {
    // The recorder sees the edge live; the next cycle's tree comparison sees
    // the same path newly active. Counting both would double every firing
    // that straddled a publish.
    const bus = fakeBus();
    const recorder = make(bus);
    recorder.start();
    bus.push('notifications.environment.depth', { state: 'alarm', message: 'Shallow' });
    const recorded = recorder.drain();
    expect(recorded).toHaveLength(1);

    const { log } = updateNotificationLog(
      parseNotificationLog(null, NOW),
      readNotifications(tree),
      NOW,
      { recorded, countEdges: false },
    );
    expect(log.events.filter((e) => e.path === 'environment.depth')).toHaveLength(1);
    // The comparison still refreshes state, so the row knows it is active.
    expect(log.seen['environment.depth']?.level).toBe('alert');
  });

  it('still counts from the comparison when no recorder is running', () => {
    const { log } = updateNotificationLog(
      parseNotificationLog(null, NOW),
      readNotifications(tree),
      NOW,
    );
    expect(log.events.filter((e) => e.path === 'environment.depth')).toHaveLength(1);
  });
});
