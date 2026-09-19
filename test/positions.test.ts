import { describe, expect, it } from 'vitest';
import {
  buildPositionEntry,
  parsePositionIndex,
  pruneAndSort,
  renderPositionIndex,
} from '../src/positions';

const NOW = new Date('2026-03-01T12:00:00Z');
const ZONES = [{ name: 'Home', lat: 37.7802069, lon: -122.385804, radius_m: 200 }];

const fix = (over: Partial<Parameters<typeof buildPositionEntry>[0]> = {}) => ({
  latitude: 37.9,
  longitude: -122.5,
  timestamp: '2026-03-01T11:59:00Z',
  speedOverGround: 4.1,
  courseOverGroundTrue: 1.2,
  ...over,
});

describe('buildPositionEntry', () => {
  it('records position, speed and course when clear of every zone', () => {
    const entry = buildPositionEntry(fix(), ZONES, NOW);
    expect(entry.timestamp).toBe('2026-03-01T11:59:00.000Z');
    expect(entry.values.map((v) => v.path)).toEqual([
      'navigation.position',
      'navigation.speedOverGround',
      'navigation.courseOverGroundTrue',
    ]);
  });

  it('publishes the zone centre and drops speed and course inside a zone', () => {
    // Speed and course at the dock would leak that the boat is manoeuvring in
    // the harbour, which is the thing the zone exists to hide.
    const entry = buildPositionEntry(
      fix({ latitude: 37.78025, longitude: -122.38585 }),
      ZONES,
      NOW,
    );
    expect(entry.values).toEqual([
      { path: 'navigation.position', value: { latitude: 37.7802069, longitude: -122.385804 } },
    ]);
  });

  it('falls back to the cycle time when the fix has no timestamp', () => {
    expect(buildPositionEntry(fix({ timestamp: null }), ZONES, NOW).timestamp).toBe(
      NOW.toISOString(),
    );
  });
});

describe('pruneAndSort', () => {
  const entry = (timestamp: string) => ({ timestamp, values: [] });

  it('drops entries past the retention window', () => {
    const kept = pruneAndSort(
      [entry('2026-02-28T11:00:00Z'), entry('2026-03-01T11:00:00Z')],
      NOW,
      24,
    );
    expect(kept.map((e) => e.timestamp)).toEqual(['2026-03-01T11:00:00Z']);
  });

  it('orders oldest first', () => {
    const kept = pruneAndSort(
      [entry('2026-03-01T11:30:00Z'), entry('2026-03-01T09:00:00Z')],
      NOW,
      24,
    );
    expect(kept.map((e) => e.timestamp)).toEqual([
      '2026-03-01T09:00:00Z',
      '2026-03-01T11:30:00Z',
    ]);
  });

  it('drops entries with an unparseable timestamp', () => {
    expect(pruneAndSort([entry('not a date')], NOW, 24)).toEqual([]);
  });
});

describe('parsePositionIndex', () => {
  it('reads the wrapped form this plugin writes', () => {
    const json = renderPositionIndex([{ timestamp: '2026-03-01T11:00:00Z', values: [] }]);
    expect(parsePositionIndex(json)).toHaveLength(1);
    expect(JSON.parse(json).schema_version).toBe(1);
  });

  it('reads a bare list, which is what the Python daemon once wrote', () => {
    expect(parsePositionIndex('[{"timestamp":"2026-03-01T11:00:00Z","values":[]}]')).toHaveLength(1);
  });

  it('returns an empty list for missing or corrupt input', () => {
    expect(parsePositionIndex(null)).toEqual([]);
    expect(parsePositionIndex('{oops')).toEqual([]);
  });
});
