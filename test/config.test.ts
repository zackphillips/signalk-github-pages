import { describe, expect, it } from 'vitest';
import { parsePathList, resolveConfig } from '../src/config';
import { COMPLETE_FORM, makeConfig } from './helpers/config';

describe('resolveConfig', () => {
  it('refuses an empty form and names every missing setting at once', () => {
    // One restart per missing field is a miserable way to configure a plugin
    // over a boat's wifi.
    const resolved = resolveConfig({});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    const joined = resolved.problems.join(' | ');
    for (const expected of [
      'repository',
      'token',
      'Underway interval',
      'Stationary interval',
      'Instrument log paths',
      'entries retained',
      'Position retention',
      'Stale value cutoff',
    ]) {
      expect(joined, expected).toContain(expected);
    }
  });

  it('has no numeric defaults to fall back on', () => {
    // Deliberate: an interval or a retention window is one boat's cellular
    // plan, and a default here publishes at someone else's cadence.
    const resolved = resolveConfig({ ...COMPLETE_FORM, interval: { underway: 120 } });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual(['Stationary interval (seconds) is not set.']);
  });

  it('rejects zero and negative numbers rather than treating them as set', () => {
    const resolved = resolveConfig({ ...COMPLETE_FORM, positionRetentionHours: 0 });
    expect(resolved.ok).toBe(false);
  });

  it('accepts the strings the admin UI hands back for number fields', () => {
    const config = makeConfig({ staleMaxAgeMinutes: '45', positionRetentionHours: '12' });
    expect(config.staleMaxAgeMinutes).toBe(45);
    expect(config.positionRetentionHours).toBe(12);
  });

  it('requires owner/name for the repository', () => {
    const resolved = resolveConfig({ ...COMPLETE_FORM, github: { repo: 'site', token: 't' } });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems[0]).toContain('owner/name');
  });

  it("defaults privacy zones to empty rather than to anyone else's home port", () => {
    expect(makeConfig().privacyZones).toEqual([]);
  });

  it('reports incomplete privacy zones instead of silently hiding nothing', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      privacyZones: [
        { name: 'Good', lat: 37.8, lon: -122.4, radius_m: 200 },
        { name: 'No radius', lat: 37.8, lon: -122.4 },
      ],
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems[0]).toContain('1 privacy zone(s) are incomplete');
  });

  it('accepts a complete form', () => {
    const config = makeConfig();
    expect(config.interval).toEqual({ underway: 120, stationary: 3600 });
    expect(config.instrumentLog.entries).toBe(120);
    expect(config.site.theme).toBe('mermug');
    expect(config.buildDocsIndex).toBe(true);
  });
});

describe('parsePathList', () => {
  it('reads one path per line', () => {
    expect(parsePathList('navigation.speedOverGround\nenvironment.wind.speedApparent')).toEqual([
      'navigation.speedOverGround',
      'environment.wind.speedApparent',
    ]);
  });

  it('ignores blank lines, comments and surrounding whitespace', () => {
    expect(
      parsePathList('  navigation.speedOverGround  \n\n# the wind ones\nenvironment.wind.speedApparent\n'),
    ).toEqual(['navigation.speedOverGround', 'environment.wind.speedApparent']);
  });

  it('de-duplicates', () => {
    expect(parsePathList('a.b\na.b\n')).toEqual(['a.b']);
  });

  it('still accepts an array, so an older config keeps loading', () => {
    expect(parsePathList(['a.b', 'c.d'])).toEqual(['a.b', 'c.d']);
  });

  it('treats an empty or missing value as no paths', () => {
    expect(parsePathList('   \n#only a comment\n')).toEqual([]);
    expect(parsePathList(undefined)).toEqual([]);
  });
});
