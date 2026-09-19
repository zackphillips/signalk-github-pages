import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTRUMENT_LOG_ENTRIES,
  DEFAULT_INSTRUMENT_LOG_PATHS,
  DEFAULT_INTERVAL_STATIONARY,
  DEFAULT_INTERVAL_UNDERWAY,
  DEFAULT_POSITION_RETENTION_HOURS,
  DEFAULT_STALE_MAX_AGE_MINUTES,
  DEFAULT_THEME,
  parsePathList,
  resolveConfig,
} from '../src/config';
import { COMPLETE_FORM, makeConfig } from './helpers/config';

describe('resolveConfig', () => {
  it('refuses an empty form, naming only what has no sensible default', () => {
    const resolved = resolveConfig({});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual([
      'GitHub repository (owner/name) is not set.',
      'GitHub personal access token is not set.',
    ]);
  });

  it('runs on the documented defaults when only the repository is given', () => {
    const resolved = resolveConfig({ github: { repo: 'owner/site', token: 't' } });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.interval).toEqual({
      underway: DEFAULT_INTERVAL_UNDERWAY,
      stationary: DEFAULT_INTERVAL_STATIONARY,
    });
    expect(resolved.config.positionRetentionHours).toBe(DEFAULT_POSITION_RETENTION_HOURS);
    expect(resolved.config.staleMaxAgeMinutes).toBe(DEFAULT_STALE_MAX_AGE_MINUTES);
    expect(resolved.config.instrumentLog.entries).toBe(DEFAULT_INSTRUMENT_LOG_ENTRIES);
    expect(resolved.config.instrumentLog.paths).toEqual(DEFAULT_INSTRUMENT_LOG_PATHS);
    expect(resolved.config.site.theme).toBe(DEFAULT_THEME);
  });

  it('defaults nothing that belongs to one particular boat', () => {
    const resolved = resolveConfig({ github: { repo: 'owner/site', token: 't' } });
    if (!resolved.ok) throw new Error('expected a resolved config');
    // A guessed privacy zone or timezone is worse than none: one hides the
    // wrong water, the other splits tracks on the wrong midnight.
    expect(resolved.config.privacyZones).toEqual([]);
    expect(resolved.config.timezone).toBe('');
    expect(resolved.config.site.marinetrafficShipId).toBe('');
    expect(resolved.config.site.uscgNumber).toBe('');
    expect(resolved.config.site.hullNumber).toBe('');
  });

  it('falls back rather than accepting zero or a negative number', () => {
    const config = makeConfig({ positionRetentionHours: 0, interval: { underway: -5 } });
    expect(config.positionRetentionHours).toBe(DEFAULT_POSITION_RETENTION_HOURS);
    expect(config.interval.underway).toBe(DEFAULT_INTERVAL_UNDERWAY);
  });

  it('falls back on a theme the bundled stylesheet does not implement', () => {
    // The enum once carried names from a stale comment; picking one left the
    // page unstyled.
    expect(makeConfig({ site: { theme: 'deep-sea' } }).site.theme).toBe(DEFAULT_THEME);
    expect(makeConfig({ site: { theme: 'mermug' } }).site.theme).toBe('mermug');
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

  it('names how many privacy zones are incomplete', () => {
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

  it('accepts a fully specified form', () => {
    const config = makeConfig();
    expect(config.interval).toEqual({ underway: 120, stationary: 3600 });
    expect(config.instrumentLog.entries).toBe(120);
    expect(config.buildDocsIndex).toBe(true);
  });

  it('still fails on a privacy zone that would hide nothing', () => {
    // Not a default question: the operator believes a position is redacted.
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      privacyZones: [{ name: 'No radius', lat: 37.8, lon: -122.4 }],
    });
    expect(resolved.ok).toBe(false);
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
