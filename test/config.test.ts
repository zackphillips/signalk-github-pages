import { describe, expect, it } from 'vitest';
import {
  configError,
  DEFAULT_INSTRUMENT_LOG_PATHS,
  DEFAULT_INTERVAL_STATIONARY,
  DEFAULT_INTERVAL_UNDERWAY,
  normaliseConfig,
} from '../src/config';

describe('normaliseConfig', () => {
  it('fills in the defaults for an empty form', () => {
    const config = normaliseConfig(undefined);
    expect(config.interval).toEqual({
      underway: DEFAULT_INTERVAL_UNDERWAY,
      stationary: DEFAULT_INTERVAL_STATIONARY,
    });
    expect(config.github.branch).toBe('main');
    expect(config.instrumentLog.paths).toEqual(DEFAULT_INSTRUMENT_LOG_PATHS);
    expect(config.privacyZones).toEqual([]);
  });

  it("defaults privacy zones to empty rather than to anyone's home port", () => {
    // The Python daemon hardcoded South Beach Harbor as a fallback, which is
    // exactly wrong for every other boat that installs this.
    expect(normaliseConfig({} as any).privacyZones).toEqual([]);
  });

  it('drops incomplete privacy zones', () => {
    const config = normaliseConfig({
      privacyZones: [
        { name: 'Good', lat: 37.8, lon: -122.4, radius_m: 200 },
        { name: 'No radius', lat: 37.8, lon: -122.4 },
        { name: 'Not a number', lat: 'north', lon: -122.4, radius_m: 200 },
      ],
    } as any);
    expect(config.privacyZones.map((z) => z.name)).toEqual(['Good']);
  });

  it('rejects nonsense intervals in favour of the defaults', () => {
    const config = normaliseConfig({ interval: { underway: -5, stationary: 0 } } as any);
    expect(config.interval.underway).toBe(DEFAULT_INTERVAL_UNDERWAY);
    expect(config.interval.stationary).toBe(DEFAULT_INTERVAL_STATIONARY);
  });
});

describe('configError', () => {
  it('names what is missing before anything is published', () => {
    expect(configError(normaliseConfig({} as any))).toMatch(/repository/);
    expect(configError(normaliseConfig({ github: { repo: 'owner/site' } } as any))).toMatch(
      /token/,
    );
    expect(configError(normaliseConfig({ github: { repo: 'site', token: 't' } } as any))).toMatch(
      /owner\/name/,
    );
    expect(
      configError(normaliseConfig({ github: { repo: 'owner/site', token: 't' } } as any)),
    ).toBeNull();
  });
});
