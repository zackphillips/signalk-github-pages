import { describe, expect, it } from 'vitest';
import { describePrune, planPrune } from '../src/prune';
import type { TrackMeta } from '../src/gpx';

const track = (date: string): TrackMeta => ({
  date,
  file: `tracks/${date}.gpx`,
  start: `${date}T15:00:00Z`,
  end: `${date}T23:00:00Z`,
  duration_hours: 8,
  points: 240,
  max_speed_kts: 7.2,
  distance_nm: 34.1,
});

// Late afternoon in San Francisco, which is the next UTC day: the case where
// grouping and pruning by the UTC date would disagree with the sailor.
const NOW = new Date('2026-03-10T02:00:00Z');
const TZ = 'America/Los_Angeles';

const DAYS = [
  '2026-01-02',
  '2026-02-14',
  '2026-03-01',
  '2026-03-08',
  '2026-03-09', // "today" in America/Los_Angeles at NOW
];

describe('planPrune', () => {
  const plan = (olderThanDays: number | null, dates = DAYS) =>
    planPrune(dates.map(track), { request: { olderThanDays }, now: NOW, timezone: TZ });

  it('keeps the last N local days and removes what is older', () => {
    const result = plan(7);
    expect(result.today).toBe('2026-03-09');
    expect(result.cutoff).toBe('2026-03-02');
    expect(result.remove.map((t) => t.date)).toEqual(['2026-01-02', '2026-02-14', '2026-03-01']);
    expect(result.keep.map((t) => t.date)).toEqual(['2026-03-08', '2026-03-09']);
  });

  it('draws the cutoff in local days, not from the UTC date', () => {
    // 02:00Z on the 10th is 18:00 on the 9th in California. Pruning by the UTC
    // date would treat the 9th as two days back and take the 8th with it.
    expect(plan(2).remove.map((t) => t.date)).toEqual(['2026-01-02', '2026-02-14', '2026-03-01']);
    expect(plan(2).keep.map((t) => t.date)).toEqual(['2026-03-08', '2026-03-09']);
  });

  it('removes everything except today when asked for all', () => {
    for (const request of [null, 0]) {
      const result = plan(request);
      expect(result.remove.map((t) => t.date)).toEqual(DAYS.slice(0, 4));
      // Today survives: the position index still holds its points and the next
      // cycle would write the file straight back.
      expect(result.keep.map((t) => t.date)).toEqual(['2026-03-09']);
      expect(result.cutoff).toBeNull();
    }
  });

  it('never removes today, whatever the number of days', () => {
    expect(plan(1).remove.map((t) => t.date)).not.toContain('2026-03-09');
  });

  it('names the GPX path from the day, not from the published index', () => {
    // `file` in tracks_index.json is editable on GitHub like anything else in
    // the repository; a deletion must not follow it somewhere else.
    const tampered = [{ ...track('2026-01-02'), file: '../../../docs/secret.md' }];
    const result = planPrune(tampered, {
      request: { olderThanDays: 7 },
      now: NOW,
      timezone: TZ,
    });
    expect(result.paths).toEqual(['data/telemetry/tracks/2026-01-02.gpx']);
  });

  it('sorts a hand-edited index before deciding anything', () => {
    const result = plan(7, ['2026-03-08', '2026-01-02', '2026-03-09', '2026-02-14']);
    expect(result.remove.map((t) => t.date)).toEqual(['2026-01-02', '2026-02-14']);
  });

  it('does nothing to an empty index', () => {
    const result = planPrune([], { request: { olderThanDays: null }, now: NOW, timezone: TZ });
    expect(result.remove).toEqual([]);
    expect(describePrune(result)).toBe('nothing to remove');
  });
});

describe('describePrune', () => {
  it('names the range, for the commit message and the confirmation', () => {
    const many = planPrune(DAYS.map(track), {
      request: { olderThanDays: 7 },
      now: NOW,
      timezone: TZ,
    });
    expect(describePrune(many)).toBe('3 voyages (2026-01-02 to 2026-03-01)');

    const one = planPrune([track('2026-01-02'), track('2026-03-09')], {
      request: { olderThanDays: 7 },
      now: NOW,
      timezone: TZ,
    });
    expect(describePrune(one)).toBe('1 voyage (2026-01-02)');
  });
});
