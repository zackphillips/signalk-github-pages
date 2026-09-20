import { describe, expect, it } from 'vitest';
import { FailureAlarm } from '../src/alarm';

const t = (minutes: number) => new Date(Date.parse('2026-03-01T18:00:00Z') + minutes * 60_000);

describe('FailureAlarm', () => {
  it('says nothing about a single failed cycle', () => {
    // A dropped hotspot or a 502 from GitHub is normal and the next cycle
    // retries. Nobody should be woken for it.
    const alarm = new FailureAlarm({ afterMinutes: 30 });
    expect(alarm.recordFailure(t(0), 'HTTP 502')).toEqual({ kind: 'none' });
    expect(alarm.isRaised()).toBe(false);
  });

  it('raises once failures have been continuous for long enough', () => {
    const alarm = new FailureAlarm({ afterMinutes: 30 });
    for (let minute = 0; minute < 30; minute += 2) {
      expect(alarm.recordFailure(t(minute), 'HTTP 401'), `minute ${minute}`).toEqual({
        kind: 'none',
      });
    }
    const action = alarm.recordFailure(t(30), 'HTTP 401: Bad credentials');
    expect(action.kind).toBe('raise');
    if (action.kind !== 'raise') throw new Error('unreachable');
    expect(action.failures).toBe(16);
    expect(action.sinceMinutes).toBe(30);
    expect(action.message).toContain('HTTP 401: Bad credentials');
    expect(alarm.isRaised()).toBe(true);
  });

  it('raises once, not on every cycle after that', () => {
    // Otherwise an expired token re-raises every two minutes all night.
    const alarm = new FailureAlarm({ afterMinutes: 30 });
    alarm.recordFailure(t(0), 'boom');
    expect(alarm.recordFailure(t(31), 'boom').kind).toBe('raise');
    expect(alarm.recordFailure(t(33), 'boom')).toEqual({ kind: 'none' });
    expect(alarm.recordFailure(t(90), 'boom')).toEqual({ kind: 'none' });
  });

  it('clears when publishing recovers, and only if it had raised', () => {
    const alarm = new FailureAlarm({ afterMinutes: 30 });
    // Nothing raised yet: recovery is not worth a notification.
    alarm.recordFailure(t(0), 'boom');
    expect(alarm.recordSuccess()).toEqual({ kind: 'none' });

    alarm.recordFailure(t(10), 'boom');
    expect(alarm.recordFailure(t(41), 'boom').kind).toBe('raise');
    expect(alarm.recordSuccess()).toEqual({ kind: 'clear' });
    expect(alarm.isRaised()).toBe(false);
  });

  it('starts the clock again after a success, so a flapping link never fires', () => {
    // Fail for 25 minutes, succeed, fail for 25 more. That is not half an
    // hour of continuous failure and must not raise.
    const alarm = new FailureAlarm({ afterMinutes: 30 });
    alarm.recordFailure(t(0), 'boom');
    expect(alarm.recordFailure(t(25), 'boom')).toEqual({ kind: 'none' });
    alarm.recordSuccess();
    alarm.recordFailure(t(26), 'boom');
    expect(alarm.recordFailure(t(50), 'boom')).toEqual({ kind: 'none' });
    expect(alarm.recordFailure(t(57), 'boom').kind).toBe('raise');
  });

  it('is off when the threshold is zero', () => {
    const alarm = new FailureAlarm({ afterMinutes: 0 });
    for (let minute = 0; minute < 600; minute += 2) {
      expect(alarm.recordFailure(t(minute), 'boom')).toEqual({ kind: 'none' });
    }
    expect(alarm.isRaised()).toBe(false);
  });
});
