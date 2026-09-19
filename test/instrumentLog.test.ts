import { describe, expect, it } from 'vitest';
import {
  appendInstrumentEntry,
  applyPathAllowlist,
  collectNumericValues,
  pathMatches,
} from '../src/instrumentLog';

const TREE = {
  navigation: {
    speedOverGround: { value: 4.2, timestamp: '2026-03-01T12:00:00Z' },
    position: { value: { latitude: 37.8, longitude: -122.4 } },
    state: { value: 'sailing' },
    attitude: { value: { roll: 0.12, pitch: -0.03, yaw: 1.1 } },
  },
  electrical: {
    batteries: {
      house: { voltage: { value: 12.6 }, current: { value: -4.2 } },
      start: { voltage: { value: 13.1 } },
    },
  },
  notifications: { mob: { value: { state: 'normal', message: 'x' } } },
};

describe('collectNumericValues', () => {
  it('flattens numeric leaves to dotted paths', () => {
    const values = collectNumericValues(TREE);
    expect(values['navigation.speedOverGround']).toBe(4.2);
    expect(values['electrical.batteries.house.voltage']).toBe(12.6);
    expect(values['electrical.batteries.start.voltage']).toBe(13.1);
  });

  it('expands composite values one path per member', () => {
    const values = collectNumericValues(TREE);
    expect(values['navigation.position.latitude']).toBe(37.8);
    expect(values['navigation.attitude.roll']).toBe(0.12);
  });

  it('ignores strings and non-numeric members', () => {
    const values = collectNumericValues(TREE);
    expect(values['navigation.state']).toBeUndefined();
    expect(values['notifications.mob.state']).toBeUndefined();
  });
});

describe('pathMatches', () => {
  it('matches exactly', () => {
    expect(pathMatches('navigation.speedOverGround', 'navigation.speedOverGround')).toBe(true);
    expect(pathMatches('navigation.speedOverGround', 'navigation.speedThroughWater')).toBe(false);
  });

  it('treats * as exactly one segment', () => {
    expect(pathMatches('electrical.batteries.*.voltage', 'electrical.batteries.house.voltage')).toBe(true);
    expect(pathMatches('electrical.batteries.*.voltage', 'electrical.batteries.house.a.voltage')).toBe(false);
  });
});

describe('applyPathAllowlist', () => {
  it('keeps only the allowlisted paths', () => {
    // This is the whole point of the allowlist: the unfiltered tree carried
    // ~167 paths per entry and a ~1 MB file, which the Git Data API uploads
    // in full on every cycle instead of as a delta.
    const filtered = applyPathAllowlist(collectNumericValues(TREE), [
      'navigation.speedOverGround',
      'electrical.batteries.*.voltage',
    ]);
    expect(Object.keys(filtered).sort()).toEqual([
      'electrical.batteries.house.voltage',
      'electrical.batteries.start.voltage',
      'navigation.speedOverGround',
    ]);
  });

  it('keeps everything when the list is empty', () => {
    const all = collectNumericValues(TREE);
    expect(applyPathAllowlist(all, [])).toBe(all);
  });
});

describe('appendInstrumentEntry', () => {
  const options = { paths: ['navigation.speedOverGround'], entries: 3 };

  it('appends one entry per cycle', () => {
    const log = appendInstrumentEntry([], new Date('2026-03-01T12:00:00Z'), TREE, options);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toEqual({
      timestamp: '2026-03-01T12:00:00.000Z',
      values: { 'navigation.speedOverGround': 4.2 },
    });
  });

  it('trims to the rolling window, keeping the newest', () => {
    const existing = ['a', 'b', 'c'].map((id) => ({ timestamp: id, values: {} }));
    const log = appendInstrumentEntry(existing, new Date('2026-03-01T12:00:00Z'), TREE, options);
    expect(log.entries).toHaveLength(3);
    expect(log.entries[0]!.timestamp).toBe('b');
    expect(log.entries[2]!.timestamp).toBe('2026-03-01T12:00:00.000Z');
  });

  it('stamps a schema version so a mismatched frontend can tell', () => {
    expect(appendInstrumentEntry([], new Date(), TREE, options).schema_version).toBe(1);
  });
});
