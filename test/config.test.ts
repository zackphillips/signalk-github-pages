import { describe, expect, it } from 'vitest';
import { isValidTimezone } from '../src/time';
import {
  buildConfigSchema,
  configSchema,
  configUiSchema,
  DEFAULT_HISTORY_RESOLUTION_SECONDS,
  DEFAULT_HISTORY_TIMEOUT_MS,
  POLARS_FIELD_DESCRIPTION,
  DEFAULT_INSTRUMENT_LOG_ENTRIES,
  DEFAULT_INSTRUMENT_LOG_PATHS,
  DEFAULT_INTERVAL_STATIONARY,
  DEFAULT_INTERVAL_UNDERWAY,
  DEFAULT_POSITION_RETENTION_HOURS,
  DEFAULT_STALE_MAX_AGE_MINUTES,
  pagesUrl,
  parsePathList,
  resolveConfig,
  resolveSiteUrl,
  siteBasePath,
} from '../src/config';
import { serverTimezone } from '../src/timezones';
import { COMPLETE_FORM, makeConfig } from './helpers/config';

describe('resolveConfig', () => {
  it('refuses an empty form, naming only what has no sensible default', () => {
    const resolved = resolveConfig({});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual([
      'GitHub repository owner is not set (your username, or the organisation).',
      'GitHub personal access token is not set.',
    ]);
  });

  it('runs on the documented defaults when only the repository is given', () => {
    const resolved = resolveConfig({ github: { owner: 'owner', token: 't' } });
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
  });

  it('defaults nothing that belongs to one particular boat', () => {
    const resolved = resolveConfig({ github: { owner: 'owner', token: 't' } });
    if (!resolved.ok) throw new Error('expected a resolved config');
    // A guessed privacy zone is worse than none: it hides the wrong water.
    expect(resolved.config.privacyZones).toEqual([]);
    expect(resolved.config.site.tideStationOverride).toBe('');
  });

  it('falls back rather than accepting zero or a negative number', () => {
    const config = makeConfig({ positionRetentionHours: 0, interval: { underwayMinutes: -5 } });
    expect(config.positionRetentionHours).toBe(DEFAULT_POSITION_RETENTION_HOURS);
    expect(config.interval.underway).toBe(DEFAULT_INTERVAL_UNDERWAY);
  });

  it('accepts the strings the admin UI hands back for number fields', () => {
    const config = makeConfig({ staleMaxAgeMinutes: '45', positionRetentionHours: '12' });
    expect(config.staleMaxAgeMinutes).toBe(45);
    expect(config.positionRetentionHours).toBe(12);
  });

  it('derives the user site from the owner, so the name is one less box', () => {
    const resolved = resolveConfig({ ...COMPLETE_FORM, github: { owner: 'zack', token: 't' } });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.github.name).toBe('zack.github.io');
    expect(resolved.config.github.repo).toBe('zack/zack.github.io');
  });

  it('takes the typed name only when the override is ticked', () => {
    const form = { ...COMPLETE_FORM, github: { owner: 'zack', name: 'tracker', token: 't' } };
    expect(makeConfig(form).github.repo).toBe('zack/zack.github.io');
    expect(makeConfig({ github: { ...form.github, overrideName: true } }).github.repo)
      .toBe('zack/tracker');
  });

  it('names an override with nothing to override with', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      github: { owner: 'zack', overrideName: true, name: '', token: 't' },
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems.join(' ')).toContain('Override repository name is ticked');
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
      const resolved = resolveConfig({
        ...COMPLETE_FORM,
        github: { owner, overrideName: true, token: 't' },
      });
      expect(resolved.ok, owner).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.config.github.repo, owner).toBe('owner/site');
    }
  });

  it('rejects a name that is not a GitHub name', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      github: { owner: 'own er', overrideName: true, name: 'si te', token: 't' },
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

  it('takes the tide station override as a plain string, or leaves it empty', () => {
    expect(makeConfig().site.tideStationOverride).toBe('');
    expect(makeConfig({ site: { tideStationOverride: '9414290' } }).site.tideStationOverride)
      .toBe('9414290');
    // Trimmed, like every other typed field: a stray space pasted in from a
    // NOAA station listing would otherwise fail to match the ID it names.
    expect(makeConfig({ site: { tideStationOverride: '  9414290  ' } }).site.tideStationOverride)
      .toBe('9414290');
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

  it('keeps the pasted polar table unparsed, with its override flag', () => {
    // Unparsed here: polars.ts decides which table wins, because only it knows
    // what the server had.
    expect(makeConfig().polars).toEqual({ override: false, table: '' });
    expect(makeConfig({ polars: { override: true, table: 'twa/tws;6\n52;4.1\n' } }).polars)
      .toEqual({ override: true, table: 'twa/tws;6\n52;4.1\n' });
    expect(makeConfig({ polars: { table: 'twa/tws;6\n52;4.1\n' } }).polars.override).toBe(false);
  });

  it('ignores the field shapes an unreleased version once used', () => {
    // A bare string for the polar or the timezone, and a cadence in seconds,
    // are shapes only 0.1.x wrote. It was never published, so these fall back
    // to the defaults rather than being carried forward forever.
    const config = makeConfig({
      polars: 'twa/tws;6\n52;4.1\n',
      timezone: 'Europe/Lisbon',
      interval: { underway: 300, stationary: 1800 },
    });
    expect(config.polars).toEqual({ override: false, table: '' });
    expect(config.interval).toEqual({
      underway: DEFAULT_INTERVAL_UNDERWAY,
      stationary: DEFAULT_INTERVAL_STATIONARY,
    });
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

describe('the timezone field', () => {
  const zone = () =>
    (configSchema.properties as any).timezone.dependencies.override.oneOf[1].properties.zone;

  it('offers IANA names, not a free-text box where "PST" looked reasonable', () => {
    expect(zone().enum).toContain('America/Los_Angeles');
    expect(zone().enum).toContain('Pacific/Auckland');
    expect(zone().enum.length).toBeGreaterThan(100);
  });

  it("defaults to the server's own zone rather than to UTC", () => {
    expect(zone().default).toBe(serverTimezone());
    expect(zone().enum[0]).toBe('UTC');
    expect(zone().enumNames).toHaveLength(zone().enum.length);
    expect(makeConfig({ timezone: undefined }).timezone).toBe(serverTimezone());
  });

  it('takes the picked zone only when the override is ticked', () => {
    expect(makeConfig({ timezone: { override: false, zone: 'Pacific/Auckland' } }).timezone)
      .toBe(serverTimezone());
    expect(makeConfig({ timezone: { override: true, zone: 'Pacific/Auckland' } }).timezone)
      .toBe('Pacific/Auckland');
  });

  it('offers only names this runtime can group days by', () => {
    for (const name of zone().enum) {
      expect(isValidTimezone(name), name).toBe(true);
    }
  });
});

describe('buildConfigSchema', () => {
  // What the checkbox says, and what the box it reveals holds.
  const polarNote = (schema: any) => schema.properties.polars.properties.override.description;
  const polarBox = (schema: any) =>
    schema.properties.polars.dependencies.override.oneOf[1].properties.table;

  it('says nothing about a polar before any cycle has run', () => {
    expect(polarNote(buildConfigSchema({ polar: null }))).toBe(
      (configSchema.properties as any).polars.properties.override.description,
    );
    expect(polarBox(buildConfigSchema()).description).toBe(POLARS_FIELD_DESCRIPTION);
  });

  it('names the polar it is publishing', () => {
    const note = polarNote(
      buildConfigSchema({
        polar: {
          source: 'resource',
          summary: '"mermug-orc" from Polar Management, 18 angle(s) x 7 wind speed(s)',
          problems: [],
        },
      }),
    );
    expect(note).toContain('mermug-orc');
    expect(note).toContain('Publishing');
  });

  it('carries the last cycle complaint onto the page', () => {
    const note = polarNote(
      buildConfigSchema({
        polar: {
          source: 'none',
          summary: '"x" is active but could not be read',
          problems: ['Polar not found: x'],
        },
      }),
    );
    expect(note).toContain('Publishing no polar');
    expect(note).toContain('Polar not found: x');
  });

  it('puts what is derived beside the checkbox, where saving cannot overwrite it', () => {
    const built = buildConfigSchema({
      repoName: 'owner.github.io',
      siteUrl: 'https://owner.github.io/',
    }) as any;
    expect(built.properties.github.properties.overrideName.description).toContain(
      'owner.github.io',
    );
    expect(built.properties.site.properties.overrideUrl.description).toContain(
      'https://owner.github.io/',
    );
    // The typed boxes themselves stay empty: a default is submitted with the
    // form, and a derived value written into the config goes stale there.
    expect(
      built.properties.github.dependencies.overrideName.oneOf[1].properties.name.default,
    ).toBe('');
    expect(built.properties.site.dependencies.overrideUrl.oneOf[1].properties.url.default).toBe(
      '',
    );
  });

  it('starts a polar override off from the active polar', () => {
    const built = buildConfigSchema({ polarCsv: 'twa/tws;6\n52;4.1\n' }) as any;
    expect(polarBox(built).default).toBe('twa/tws;6\n52;4.1\n');
  });

  it('never mutates the schema it was built from', () => {
    buildConfigSchema({ polarCsv: 'x', repoName: 'owner.github.io' });
    const base = configSchema.properties as any;
    expect(base.polars.dependencies.override.oneOf[1].properties.table.default).toBe('');
    expect(base.polars.dependencies.override.oneOf[1].properties.table.description).toBe(
      POLARS_FIELD_DESCRIPTION,
    );
    expect(base.github.properties.overrideName.description).not.toContain('owner.github.io');
  });

  it('leaves every other field exactly as it was', () => {
    const built = buildConfigSchema({ polarCsv: 'x' }) as any;
    expect(built.properties.github).toEqual((configSchema.properties as any).github);
    expect(built.properties.privacyZones).toEqual((configSchema.properties as any).privacyZones);
  });
});

describe('the repository fields', () => {
  it('asks only for the owner, and offers the name behind an override', () => {
    const github = (configSchema.properties as any).github;
    expect(github.properties.owner.type).toBe('string');
    expect(github.properties.overrideName.type).toBe('boolean');
    expect(github.dependencies.overrideName.oneOf[1].properties.name.type).toBe('string');
    expect(github.required).toEqual(['owner', 'token']);
  });

  it('offers nothing left over from an old version', () => {
    const github = (configSchema.properties as any).github.properties;
    expect(Object.keys(github).sort()).toEqual(['branch', 'overrideName', 'owner', 'token']);
    expect((configUiSchema as any).github.token['ui:widget']).toBe('password');
  });

  it('shows the name field only once the override is ticked', () => {
    const dependencies = (configSchema.properties as any).github.dependencies;
    const [off, on] = dependencies.overrideName.oneOf;
    expect(off.properties.overrideName.enum).toEqual([false]);
    expect(off.properties.name).toBeUndefined();
    expect(on.properties.overrideName.enum).toEqual([true]);
    expect(on.properties.name.type).toBe('string');
  });

  it('keeps every overridable field out of the form until its box is ticked', () => {
    // A field that is present but read-only is filled from a JSON Schema
    // default, and the admin UI submits defaults: the derived value of the day
    // was saved and shown back for ever. Absent until ticked, there is nothing
    // to save.
    const properties = configSchema.properties as any;
    for (const [section, flag, field] of [
      ['github', 'overrideName', 'name'],
      ['timezone', 'override', 'zone'],
      ['polars', 'override', 'table'],
      ['site', 'overrideUrl', 'url'],
    ] as const) {
      expect(properties[section].properties[field], `${section}.${field}`).toBeUndefined();
      const [off, on] = properties[section].dependencies[flag].oneOf;
      expect(off.properties[field], `${section}.${field}`).toBeUndefined();
      expect(on.properties[field].title, `${section}.${field}`).toBeTruthy();
    }
  });

  it('says what to tick when making the token, and nothing more', () => {
    const description = (configSchema.properties as any).github.properties.token.description;
    expect(description).toContain('Contents');
    expect(description).toContain('Only select repositories');
    expect(description).toContain('organisation');
    // Trimmed to what the token will not work without.
    expect(description.length).toBeLessThan(400);
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

describe('the history provider settings', () => {
  it('defaults to reading the instrument log from whichever provider the server has', () => {
    const config = makeConfig();
    expect(config.history).toEqual({
      enabled: true,
      providerId: '',
      resolutionSeconds: DEFAULT_HISTORY_RESOLUTION_SECONDS,
      timeoutMs: DEFAULT_HISTORY_TIMEOUT_MS,
    });
  });

  it('takes a provider id, a resolution and a timeout from the form', () => {
    const config = makeConfig({
      history: {
        enabled: true,
        providerId: 'signalk-to-influxdb2',
        resolutionSeconds: 30,
        timeoutMs: 5000,
      },
    });
    expect(config.history.providerId).toBe('signalk-to-influxdb2');
    expect(config.history.resolutionSeconds).toBe(30);
    expect(config.history.timeoutMs).toBe(5000);
  });

  it('can be turned off, leaving the plugin to accumulate history itself', () => {
    expect(makeConfig({ history: { enabled: false } }).history.enabled).toBe(false);
  });

  it('floors a timeout too short to reach a database', () => {
    expect(makeConfig({ history: { timeoutMs: 5 } }).history.timeoutMs).toBe(1000);
  });

  it('warns when the log is shorter than one publish interval', () => {
    // Two windows with no overlap: every publish would replace the graph
    // rather than extend it.
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      interval: { underwayMinutes: 10, stationaryMinutes: 60 },
      instrumentLog: { ...COMPLETE_FORM.instrumentLog, entries: 5 },
      history: { resolutionSeconds: 60 },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.warnings.join(' ')).toMatch(
      /instrument log covers 5 min \(60s x 5 entries\), less than the 600s underway/,
    );
  });

  it('says nothing when the log outlasts the cadence, or the provider is off', () => {
    expect(resolveConfig({ ...COMPLETE_FORM }).warnings).toEqual([]);
    expect(
      resolveConfig({
        ...COMPLETE_FORM,
        interval: { underwayMinutes: 10, stationaryMinutes: 60 },
        instrumentLog: { ...COMPLETE_FORM.instrumentLog, entries: 5 },
        history: { enabled: false, resolutionSeconds: 60 },
      }).warnings,
    ).toEqual([]);
  });
});

describe('pagesUrl', () => {
  it('knows a user site from a project site', () => {
    expect(pagesUrl('zackphillips', 'zackphillips.github.io')).toBe(
      'https://zackphillips.github.io/',
    );
    expect(pagesUrl('zackphillips', 'tracker')).toBe('https://zackphillips.github.io/tracker/');
  });

  it('lowercases the host, which GitHub Pages serves in lower case', () => {
    expect(pagesUrl('ZackPhillips', 'Tracker')).toBe('https://zackphillips.github.io/Tracker/');
  });
});

describe('resolveSiteUrl', () => {
  it('derives the Pages URL when the override is not ticked', () => {
    // Whatever is sitting in the box: a derived setting is derived.
    expect(resolveSiteUrl('owner', 'owner.github.io', false, 'https://stale.example/').url).toBe(
      'https://owner.github.io/',
    );
  });

  it('takes a custom domain when it is', () => {
    expect(resolveSiteUrl('owner', 'owner.github.io', true, 'https://mermug.com').url).toBe(
      'https://mermug.com/',
    );
  });

  it('assumes https for an address typed without one', () => {
    expect(resolveSiteUrl('owner', 'owner.github.io', true, 'mermug.com').url).toBe(
      'https://mermug.com/',
    );
  });

  it('falls back to the derived URL rather than publishing a broken one', () => {
    // These end up concatenated into og:image. "undefined/logo.png" in every
    // link preview is worse than the wrong-but-valid GitHub Pages address.
    for (const typed of ['not a url', 'javascript:alert(1)', '']) {
      const resolved = resolveSiteUrl('owner', 'owner.github.io', true, typed);
      expect(resolved.url, typed).toBe('https://owner.github.io/');
      expect(resolved.warnings, typed).toHaveLength(1);
    }
  });
});

describe('siteBasePath', () => {
  it('scopes a project site to its own directory', () => {
    // An installed PWA claiming "/" takes over the owner's whole github.io
    // domain, including every other project site on it.
    expect(siteBasePath('https://owner.github.io/tracker/')).toBe('/tracker/');
    expect(siteBasePath('https://owner.github.io/')).toBe('/');
    expect(siteBasePath('')).toBe('/');
  });
});

describe('the vessel logo', () => {
  it('publishes an uploaded image under the type it arrived as', () => {
    const config = makeConfig({
      site: { logo: 'data:image/png;name=burgee.png;base64,iVBORw0KGgo=' },
    });
    expect(config.site.logo?.path).toBe('data/vessel/logo.png');
    expect(config.site.logo?.mediaType).toBe('image/png');
    expect(config.site.logo?.content.length).toBeGreaterThan(0);
  });

  it('leaves the hand-committed path alone when nothing is set', () => {
    expect(makeConfig().site.logo).toBeNull();
    expect(makeConfig({ site: { logo: '   ' } }).site.logo).toBeNull();
  });

  it('is a config problem rather than a silent drop', () => {
    // A logo that vanishes looks exactly like a logo that did not upload.
    for (const logo of [
      'data:application/pdf;base64,JVBERi0=',
      'https://example.com/logo.png',
      'data:image/png;base64,',
    ]) {
      const resolved = resolveConfig({ ...COMPLETE_FORM, site: { logo } });
      expect(resolved.ok, logo).toBe(false);
    }
  });

  it('takes one of any size: it is uploaded only when its bytes change', () => {
    const big = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`;
    const resolved = resolveConfig({ ...COMPLETE_FORM, site: { logo: big } });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.config.site.logo?.content.length).toBe(3 * 1024 * 1024);
  });
});

describe('the vessel icon', () => {
  it('publishes an uploaded image under its own path, separate from the logo', () => {
    const config = makeConfig({
      site: { icon: 'data:image/svg+xml;base64,PHN2Zy8+' },
    });
    expect(config.site.icon?.path).toBe('data/vessel/icon.svg');
    expect(config.site.icon?.mediaType).toBe('image/svg+xml');
    expect(config.site.icon?.content.length).toBeGreaterThan(0);
    expect(config.site.logo).toBeNull();
  });

  it('falls back to the bundled generic icon when nothing is set', () => {
    expect(makeConfig().site.icon).toBeNull();
    expect(makeConfig({ site: { icon: '   ' } }).site.icon).toBeNull();
  });

  it('is a config problem rather than a silent drop, same as the logo', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      site: { icon: 'https://example.com/icon.png' },
    });
    expect(resolved.ok).toBe(false);
  });
});
