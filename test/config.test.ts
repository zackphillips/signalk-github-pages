import { describe, expect, it } from 'vitest';
import { isValidTimezone } from '../src/time';
import {
  buildConfigSchema,
  configSchema,
  configUiSchema,
  POLARS_FIELD_DESCRIPTION,
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
      'GitHub repository owner is not set (your username, or the organisation).',
      'GitHub repository name is not set (the repository, without the owner).',
      'GitHub personal access token is not set.',
    ]);
  });

  it('runs on the documented defaults when only the repository is given', () => {
    const resolved = resolveConfig({ github: { owner: 'owner', name: 'site', token: 't' } });
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
    const resolved = resolveConfig({ github: { owner: 'owner', name: 'site', token: 't' } });
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

  it('names the repository box that is empty', () => {
    const resolved = resolveConfig({ ...COMPLETE_FORM, github: { owner: 'owner', token: 't' } });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual([
      'GitHub repository name is not set (the repository, without the owner).',
    ]);
  });

  it('does not read the deprecated single repo field any more', () => {
    // It was hidden on the config page and honoured behind the scenes, which
    // meant a config could publish to a repository neither box named.
    const resolved = resolveConfig({ ...COMPLETE_FORM, github: { repo: 'owner/site', token: 't' } });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems.join(' ')).toContain('owner is not set');
  });

  it('splits a repository pasted whole into the owner box', () => {
    for (const owner of ['owner/site', 'https://github.com/owner/site', 'github.com/owner/site.git']) {
      const resolved = resolveConfig({ ...COMPLETE_FORM, github: { owner, token: 't' } });
      expect(resolved.ok, owner).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.config.github.repo, owner).toBe('owner/site');
    }
  });

  it('rejects a name that is not a GitHub name', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      github: { owner: 'own er', name: 'si te', token: 't' },
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems.join(' ')).toContain('is not a GitHub username or organisation');
    expect(resolved.problems.join(' ')).toContain('is not a GitHub repository name');
  });

  it('warns about a token that is plainly not one, without refusing to start', () => {
    const resolved = resolveConfig({ ...COMPLETE_FORM, github: { ...COMPLETE_FORM.github, token: 'hunter2' } });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.warnings.join(' ')).toContain('does not look like one');
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

  it('takes home waters only when both coordinates are there', () => {
    expect(makeConfig().site.defaultLocation).toBeNull();
    expect(
      makeConfig({ site: { defaultLocation: { lat: 37.806, lon: -122.465, label: 'SF Bay' } } })
        .site.defaultLocation,
    ).toEqual({ lat: 37.806, lon: -122.465, label: 'SF Bay' });
    // Half a fix would send the tide lookup somewhere in the ocean; the
    // frontend's own default is the better answer.
    expect(makeConfig({ site: { defaultLocation: { lat: 37.806 } } }).site.defaultLocation)
      .toBeNull();
    expect(makeConfig({ site: { defaultLocation: { lat: 137, lon: -122 } } }).site.defaultLocation)
      .toBeNull();
  });

  it('keeps custom buttons that have both a label and a URL', () => {
    const config = makeConfig({
      site: {
        customLinks: [
          { label: "Ship's Log", url: 'https://iot.openplotter.cloud/log/1' },
          { label: 'Starlink', url: 'http://192.168.100.1/' },
        ],
      },
    });
    expect(config.site.customLinks).toEqual([
      { label: "Ship's Log", url: 'https://iot.openplotter.cloud/log/1' },
      { label: 'Starlink', url: 'http://192.168.100.1/' },
    ]);
  });

  it('drops a half-filled button and says which', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      site: { customLinks: [{ label: 'Nowhere' }, { url: 'https://example.com' }] },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.site.customLinks).toEqual([]);
    expect(resolved.warnings.join(' ')).toContain('needs both a label and a URL');
  });

  it('refuses a button URL that is not http or https', () => {
    // The label and URL are published into info.yaml and the frontend assigns
    // the URL to href: a javascript: entry would run in every visitor's
    // browser.
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      site: {
        customLinks: [
          { label: 'Bad', url: 'javascript:alert(1)' },
          { label: 'Also bad', url: 'data:text/html,<script>alert(1)</script>' },
          { label: 'Fine', url: 'https://example.com' },
        ],
      },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.site.customLinks).toEqual([
      { label: 'Fine', url: 'https://example.com' },
    ]);
    expect(resolved.warnings.join(' ')).toContain('not http:// or https://');
  });

  it('keeps the pasted polar table for the fallback to use', () => {
    // Unparsed here: polars.ts decides whether it is needed at all, because
    // only it knows whether the server had something better.
    expect(makeConfig().polars).toBe('');
    expect(makeConfig({ polars: 'twa/tws;6\n52;4.1\n' }).polars).toBe('twa/tws;6\n52;4.1\n');
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

describe('the timezone dropdown', () => {
  it('offers IANA names, not a free-text box where "PST" looked reasonable', () => {
    const timezone = (configSchema.properties as any).timezone;
    expect(timezone.enum).toContain('America/Los_Angeles');
    expect(timezone.enum).toContain('Pacific/Auckland');
    expect(timezone.enum.length).toBeGreaterThan(100);
  });

  it('leads with UTC, so a boat that has not chosen keeps the old behaviour', () => {
    const timezone = (configSchema.properties as any).timezone;
    expect(timezone.enum[0]).toBe('');
    expect(timezone.default).toBe('');
    expect(timezone.enumNames[0]).toContain('UTC');
    expect(timezone.enumNames).toHaveLength(timezone.enum.length);
  });

  it('offers only names this runtime can group days by', () => {
    for (const zone of (configSchema.properties as any).timezone.enum.slice(1)) {
      expect(isValidTimezone(zone), zone).toBe(true);
    }
  });
});

describe('buildConfigSchema', () => {
  const polarField = (schema: any) => schema.properties.polars.description;

  it('describes the field generically before any cycle has run', () => {
    expect(polarField(buildConfigSchema(null))).toBe(POLARS_FIELD_DESCRIPTION);
    expect(polarField(buildConfigSchema())).toBe(POLARS_FIELD_DESCRIPTION);
  });

  it('says the box is ignored while the server has a polar', () => {
    const description = polarField(
      buildConfigSchema({
        source: 'resource',
        summary: '"mermug-orc" from Polar Management, 18 angle(s) x 7 wind speed(s)',
        problems: [],
      }),
    );
    expect(description).toContain('mermug-orc');
    expect(description).toContain('This box is ignored');
  });

  it('says the box is what the chart draws when nothing is active', () => {
    const description = polarField(
      buildConfigSchema({ source: 'config', summary: 'the table on the config page', problems: [] }),
    );
    expect(description).toContain('No polar is active on the server');
  });

  it('carries the last cycle complaint onto the page', () => {
    const description = polarField(
      buildConfigSchema({
        source: 'none',
        summary: '"x" is active but could not be read',
        problems: ['Polar not found: x'],
      }),
    );
    expect(description).toContain('Nothing is being published');
    expect(description).toContain('Polar not found: x');
  });

  it('leaves every other field exactly as it was', () => {
    const built = buildConfigSchema({ source: 'config', summary: 's', problems: [] }) as any;
    expect(built.properties.github).toBe((configSchema.properties as any).github);
    expect(built.properties.privacyZones).toBe((configSchema.properties as any).privacyZones);
  });
});

describe('the repository fields', () => {
  it('asks for the owner and the name separately', () => {
    const github = (configSchema.properties as any).github;
    expect(github.properties.owner.type).toBe('string');
    expect(github.properties.name.type).toBe('string');
    expect(github.required).toEqual(['owner', 'name', 'token']);
  });

  it('offers two repository boxes and nothing left over from an old version', () => {
    const github = (configSchema.properties as any).github.properties;
    expect(Object.keys(github).sort()).toEqual(['branch', 'name', 'owner', 'token']);
    expect((configUiSchema as any).github.token['ui:widget']).toBe('password');
  });

  it('says what to tick when making the token', () => {
    const description = (configSchema.properties as any).github.properties.token.description;
    expect(description).toContain('Contents');
    expect(description).toContain('Only select repositories');
    expect(description).toContain('organisation');
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
