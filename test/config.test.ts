import { describe, expect, it } from 'vitest';
import { isValidTimezone } from '../src/time';
import {
  buildConfigSchema,
  configSchema,
  configUiSchema,
  HISTORY_RESOLUTION_SECONDS,
  HISTORY_TIMEOUT_MS,
  instrumentLogShape,
  DEFAULT_INSTRUMENT_LOG_HOURS,
  DEFAULT_INSTRUMENT_LOG_EXCLUDE,
  DEFAULT_HIDDEN_PATHS,
  DEFAULT_INTERVAL_STATIONARY,
  DEFAULT_INTERVAL_UNDERWAY,
  DEFAULT_BRANCH,
  DEFAULT_POSITION_RETENTION_HOURS,
  DEFAULT_TRACK_DETAIL_METERS,
  DEFAULT_STALE_MAX_AGE_MINUTES,
  DEFAULT_NOTIFY_AFTER_FAILURE_MINUTES,
  pagesUrl,
  parsePathList,
  resolveConfig,
  resolveSiteUrl,
  siteBasePath,
} from '../src/config';
import { DEFAULT_NOTIFICATION_EXCLUDE } from '../src/notifications';
import { serverTimezone } from '../src/timezones';
import { COMPLETE_FORM, makeConfig } from './helpers/config';

describe('resolveConfig', () => {
  it('refuses an empty form, naming only what has no sensible default', () => {
    const resolved = resolveConfig({});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual([
      'GitHub repository owner is not set (your username, or the organization).',
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
    expect(resolved.config.instrumentLog.exclude).toEqual(DEFAULT_INSTRUMENT_LOG_EXCLUDE);
    expect(resolved.config.instrumentLog.entries).toBe(
      instrumentLogShape(DEFAULT_INSTRUMENT_LOG_HOURS).entries,
    );
  });

  it('defaults nothing that belongs to one particular boat', () => {
    const resolved = resolveConfig({ github: { owner: 'owner', token: 't' } });
    if (!resolved.ok) throw new Error('expected a resolved config');
    // A guessed privacy zone is worse than none: it hides the wrong water.
    expect(resolved.config.privacyZones).toEqual([]);
    expect(resolved.config.site.tideStationOverride).toBe('');
  });

  it('falls back rather than accepting zero or a negative number', () => {
    const config = makeConfig({ interval: { underwayMinutes: -5 } });
    expect(config.interval.underway).toBe(DEFAULT_INTERVAL_UNDERWAY);
  });

  it('runs the operational constants whatever a saved config says', () => {
    // Off the config page: tuning with one right answer for every boat.
    const config = makeConfig({
      positionRetentionHours: 6,
      staleMaxAgeMinutes: 5,
      track: { detailMeters: 100 },
      notifications: { warnAfterMinutes: 0 },
      instrumentLog: { providerId: 'signalk-to-influxdb2' },
    });
    expect(config.positionRetentionHours).toBe(DEFAULT_POSITION_RETENTION_HOURS);
    expect(config.staleMaxAgeMinutes).toBe(DEFAULT_STALE_MAX_AGE_MINUTES);
    expect(config.track.detailMeters).toBe(DEFAULT_TRACK_DETAIL_METERS);
    expect(config.notifyAfterFailureMinutes).toBe(DEFAULT_NOTIFY_AFTER_FAILURE_MINUTES);
    expect(config.history).not.toHaveProperty('providerId');
    const properties = configSchema.properties as any;
    expect(properties.track).toBeUndefined();
    expect(properties.staleMaxAgeMinutes).toBeUndefined();
    expect(properties.notifications.properties.warnAfterMinutes).toBeUndefined();
    expect(properties.instrumentLog.properties.providerId).toBeUndefined();
    expect(properties.paths.properties.notGraphed).toBeUndefined();
  });

  it('keeps a zero where zero is an answer rather than an empty box', () => {
    expect(makeConfig({ instrumentLog: { hours: 0 } }).history.enabled).toBe(false);
  });

  it('accepts the strings the admin UI hands back for number fields', () => {
    const config = makeConfig({ interval: { underwayMinutes: '5' }, instrumentLog: { hours: '3' } });
    expect(config.interval.underway).toBe(300);
    expect(config.instrumentLog.entries).toBe(180);
  });

  it('derives the user site from the owner, so the name is one less box', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      github: { owner: 'zack', token: 't' },
      overrides: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.github.name).toBe('zack.github.io');
    expect(resolved.config.github.repo).toBe('zack/zack.github.io');
    expect(resolved.config.github.branch).toBe(DEFAULT_BRANCH);
  });

  it('takes the typed name only when the override is ticked', () => {
    const github = { owner: 'zack', token: 't' };
    expect(makeConfig({ github, overrides: { repository: 'tracker' } }).github.repo)
      .toBe('zack/zack.github.io');
    expect(
      makeConfig({ github, overrides: { overrideRepository: true, repository: 'tracker' } })
        .github.repo,
    ).toBe('zack/tracker');
  });

  it('takes the typed branch only when the override is ticked', () => {
    expect(makeConfig({ overrides: { branch: 'gh-pages' } }).github.branch).toBe('main');
    expect(
      makeConfig({ overrides: { overrideBranch: true, branch: ' gh-pages ' } }).github.branch,
    ).toBe('gh-pages');
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      overrides: { overrideBranch: true, branch: '' },
    });
    if (!resolved.ok) throw new Error('expected a resolved config');
    expect(resolved.config.github.branch).toBe('main');
    expect(resolved.warnings.join(' ')).toContain('Override branch is ticked');
  });

  it('names an override with nothing to override with', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      github: { owner: 'zack', token: 't' },
      overrides: { overrideRepository: true, repository: '' },
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems.join(' ')).toContain('Override repository name is ticked');
  });

  it('does not read the deprecated single repo field any more', () => {
    // It was hidden on the config page and honored behind the scenes, which
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
        github: { owner, token: 't' },
        overrides: { overrideRepository: true },
      });
      expect(resolved.ok, owner).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.config.github.repo, owner).toBe('owner/site');
    }
  });

  it('rejects a name that is not a GitHub name', () => {
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      github: { owner: 'own er', token: 't' },
      overrides: { overrideRepository: true, repository: 'si te' },
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems.join(' ')).toContain('is not a GitHub username or organization');
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
    // Two hours at the 60 s floor.
    expect(config.instrumentLog.entries).toBe(120);
    expect(config.history.resolutionSeconds).toBe(60);
  });

  it('takes the tide station only when its override is ticked', () => {
    const tide = (overrides: object) => makeConfig({ overrides }).site.tideStationOverride;
    expect(makeConfig().site.tideStationOverride).toBe('');
    expect(tide({ tideStation: '9414290' })).toBe('');
    expect(tide({ overrideTideStation: true, tideStation: '9414290' })).toBe('9414290');
    // Trimmed, like every other typed field: a stray space pasted in from a
    // NOAA station listing would otherwise fail to match the ID it names.
    expect(tide({ overrideTideStation: true, tideStation: '  9414290  ' })).toBe('9414290');
  });

  it('reads the overrides from the Overrides section and nowhere else', () => {
    const resolved = resolveConfig({
      github: { owner: 'zack', overrideName: true, name: 'tracker', branch: 'x', token: 't' },
      timezone: { override: true, zone: 'Pacific/Auckland' },
      site: { overrideUrl: true, url: 'example.com', tideStationOverride: '9414290' },
    });
    if (!resolved.ok) throw new Error(resolved.problems.join(' '));
    const { config } = resolved;
    expect(config.github.repo).toBe('zack/zack.github.io');
    expect(config.github.branch).toBe('main');
    expect(config.timezone).toBe(serverTimezone());
    expect(config.site.url).toBe('https://zack.github.io/');
    expect(config.site.tideStationOverride).toBe('');
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

  it('ignores a polar table saved while there was an override for one', () => {
    // The polar is Polar Management's. A table typed before the override was
    // removed stays in the saved file and is read by nothing.
    const table = 'twa/tws;6\n52;4.1\n';
    for (const saved of [
      { overrides: { overridePolar: true, polar: table } },
      { polars: { override: true, table } },
    ]) {
      expect(makeConfig(saved)).not.toHaveProperty('polars');
    }
  });

  it('ignores the field shapes an unreleased version once used', () => {
    // A bare string for the timezone, and a cadence in seconds,
    // are shapes only 0.1.x wrote. It was never published, so these fall back
    // to the defaults rather than being carried forward forever.
    const config = makeConfig({
      timezone: 'Europe/Lisbon',
      interval: { underway: 300, stationary: 1800 },
    });
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
    (configSchema.properties as any).overrides.dependencies.overrideTimezone.oneOf[1].properties
      .timezone;

  it('offers IANA names, not a free-text box where "PST" looked reasonable', () => {
    expect(zone().enum).toContain('America/Los_Angeles');
    expect(zone().enum).toContain('Pacific/Auckland');
    expect(zone().enum.length).toBeGreaterThan(100);
  });

  it("defaults to the server's own zone rather than to UTC", () => {
    expect(zone().default).toBe(serverTimezone());
    expect(zone().enum[0]).toBe('UTC');
    expect(zone().enumNames).toHaveLength(zone().enum.length);
    expect(makeConfig({ overrides: {} }).timezone).toBe(serverTimezone());
  });

  it('takes the picked zone only when the override is ticked', () => {
    expect(
      makeConfig({ overrides: { overrideTimezone: false, timezone: 'Pacific/Auckland' } })
        .timezone,
    ).toBe(serverTimezone());
    expect(
      makeConfig({ overrides: { overrideTimezone: true, timezone: 'Pacific/Auckland' } })
        .timezone,
    ).toBe('Pacific/Auckland');
  });

  it('offers only names this runtime can group days by', () => {
    for (const name of zone().enum) {
      expect(isValidTimezone(name), name).toBe(true);
    }
  });
});
describe('buildConfigSchema', () => {
  // A checkbox's description, and the box it reveals.
  const note = (schema: any, flag: string) => schema.properties.overrides.properties[flag].description;
  const box = (schema: any, flag: string, field: string) =>
    schema.properties.overrides.dependencies[flag].oneOf[1].properties[field];

  it('marks every override found, not found, or not checked', () => {
    const found = buildConfigSchema({
      repoName: 'owner.github.io',
      siteUrl: 'https://owner.github.io/',
      branch: { name: 'main', ok: true },
      tideStation: { id: '9414290', name: 'San Francisco', distanceNm: 2.34 },
    });
    for (const flag of [
      'overrideRepository',
      'overrideBranch',
      'overrideSiteUrl',
      'overrideTimezone',
      'overrideTideStation',
    ]) {
      expect(note(found, flag), flag).toMatch(/^✅ /);
    }
    expect(note(found, 'overrideRepository')).toContain('owner.github.io');
    expect(note(found, 'overrideSiteUrl')).toContain('https://owner.github.io/');
    expect(note(found, 'overrideTideStation')).toContain('San Francisco (station 9414290), 2.3 NM');

    const missing = buildConfigSchema({
      branch: { name: 'main', ok: false, detail: 'HTTP 404' },
      tideStation: null,
    });
    expect(note(missing, 'overrideRepository')).toMatch(/^⚠/);
    expect(note(missing, 'overrideBranch')).toContain('could not publish to main (HTTP 404)');
    expect(note(missing, 'overrideTideStation')).toMatch(/^⚠/);
    expect(note(buildConfigSchema(), 'overrideBranch')).toMatch(/^⏳/);
  });

  it('keeps what is derived out of the typed boxes, where saving would freeze it', () => {
    const built = buildConfigSchema({
      repoName: 'owner.github.io',
      siteUrl: 'https://owner.github.io/',
    }) as any;
    expect(box(built, 'overrideRepository', 'repository').default).toBe('');
    expect(box(built, 'overrideSiteUrl', 'siteUrl').default).toBe('');
  });

  it('never mutates the schema it was built from', () => {
    buildConfigSchema({ repoName: 'owner.github.io' });
    expect(box(configSchema, 'overrideRepository', 'repository').default).toBe('');
    expect(note(configSchema, 'overrideRepository')).not.toContain('owner.github.io');
  });

  it('leaves every other field exactly as it was', () => {
    const built = buildConfigSchema({ repoName: 'owner.github.io' }) as any;
    expect(built.properties.github).toEqual((configSchema.properties as any).github);
    expect(built.properties.privacyZones).toEqual((configSchema.properties as any).privacyZones);
  });
});

describe('the Overrides section', () => {
  const overrides = (configSchema.properties as any).overrides;
  const pairs = [
    ['overrideRepository', 'repository'],
    ['overrideBranch', 'branch'],
    ['overrideSiteUrl', 'siteUrl'],
    ['overrideTimezone', 'timezone'],
    ['overrideTideStation', 'tideStation'],
  ] as const;

  it('holds every override, and no other section has one', () => {
    expect(Object.keys(overrides.properties)).toEqual(pairs.map(([flag]) => flag));
    for (const [name, section] of Object.entries(configSchema.properties as any)) {
      if (name === 'overrides') continue;
      expect((section as any).dependencies, name).toBeUndefined();
      for (const key of Object.keys((section as any).properties ?? {})) {
        expect(key, `${name}.${key}`).not.toMatch(/^override/i);
      }
    }
  });

  it('asks only for the owner and the token in the repository section', () => {
    const github = (configSchema.properties as any).github;
    expect(Object.keys(github.properties).sort()).toEqual(['owner', 'token']);
    expect(github.required).toEqual(['owner', 'token']);
    expect((configUiSchema as any).github.token['ui:widget']).toBe('password');
  });

  it('keeps every typed box out of the form until its checkbox is ticked', () => {
    // A field that is present but read-only is filled from a JSON Schema
    // default, and the admin UI submits defaults: the derived value of the day
    // was saved and shown back forever. Absent until ticked, there is nothing
    // to save.
    for (const [flag, field] of pairs) {
      expect(overrides.properties[field], field).toBeUndefined();
      const [off, on] = overrides.dependencies[flag].oneOf;
      expect(off.properties[flag].enum, flag).toEqual([false]);
      expect(off.properties[field], field).toBeUndefined();
      expect(on.properties[flag].enum, flag).toEqual([true]);
      expect(on.properties[field].title, field).toBeTruthy();
      expect(overrides.properties[flag].default, flag).toBe(false);
    }
  });

  it('puts each typed box directly beneath its own checkbox', () => {
    // The form appends dependency fields after every property, so without an
    // order all six boxes would land under the last checkbox.
    const order = (configUiSchema as any).overrides['ui:order'];
    for (const [flag, field] of pairs) {
      expect(order.indexOf(field), field).toBe(order.indexOf(flag) + 1);
    }
    expect(order[order.length - 1]).toBe('*');
  });

  it('says what to tick when making the token, and nothing more', () => {
    const description = (configSchema.properties as any).github.properties.token.description;
    expect(description).toContain('Contents');
    expect(description).toContain('Only select repositories');
    expect(description).not.toMatch(/organi[sz]ation/i);
    // Trimmed to what the token will not work without.
    expect(description.length).toBeLessThan(300);
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

  it('treats an empty or missing value as no paths', () => {
    expect(parsePathList('   \n#only a comment\n')).toEqual([]);
    expect(parsePathList(undefined)).toEqual([]);
  });
});

describe('the Paths section', () => {
  it('hides the notification defaults and nothing else out of the box', () => {
    const config = makeConfig();
    expect(config.hiddenPaths).toEqual(DEFAULT_HIDDEN_PATHS);
    expect(config.notificationExclude).toEqual(DEFAULT_NOTIFICATION_EXCLUDE);
    expect(config.publishNotifications).toBe(true);
  });

  it('takes notifications out of the same list, as full paths', () => {
    const config = makeConfig({
      paths: { hide: 'environment.rpi\nnotifications.server\nnotifications.*.bilge' },
    });
    expect(config.hiddenPaths).toEqual([
      'environment.rpi',
      'notifications.server',
      'notifications.*.bilge',
    ]);
    expect(config.notificationExclude).toEqual(['server', '*.bilge']);
    // A hidden path is never logged either, and a notification line is not
    // an instrument path at all.
    expect(config.instrumentLog.exclude).toContain('environment.rpi');
    expect(config.instrumentLog.exclude).not.toContain('notifications.server');
  });

  it('turns notifications off when the whole subtree is hidden', () => {
    expect(makeConfig({ paths: { hide: 'notifications' } }).publishNotifications).toBe(false);
  });

  it('treats an empty list as an answer, not as the default', () => {
    const config = makeConfig({ paths: { hide: '' } });
    expect(config.hiddenPaths).toEqual([]);
    expect(config.notificationExclude).toEqual([]);
    expect(config.instrumentLog.exclude).toEqual(DEFAULT_INSTRUMENT_LOG_EXCLUDE);
  });

});

describe('the instrument log settings', () => {
  it('logs everything but the fixed exclusions and the hidden paths', () => {
    expect(makeConfig({ instrumentLog: {} }).instrumentLog.exclude).toEqual([
      ...DEFAULT_INSTRUMENT_LOG_EXCLUDE,
    ]);
    expect(
      makeConfig({ paths: { hide: 'environment.rpi\nnotifications.server' } }).instrumentLog
        .exclude,
    ).toEqual([...DEFAULT_INSTRUMENT_LOG_EXCLUDE, 'environment.rpi']);
  });

  it('defaults to an hour from the server default provider', () => {
    const config = makeConfig({ instrumentLog: {} });
    expect(config.history).toEqual({
      enabled: true,
      resolutionSeconds: HISTORY_RESOLUTION_SECONDS,
      timeoutMs: HISTORY_TIMEOUT_MS,
    });
    expect(config.instrumentLog.entries).toBe(60);
  });

  it('takes the bucket width from the window, rather than asking twice', () => {
    // One setting, because what matters is how far back the graphs go. The
    // bucket width follows so that a day of history cannot quietly make every
    // cycle upload half a megabyte.
    expect(instrumentLogShape(1)).toEqual({ entries: 60, resolutionSeconds: 60 });
    expect(instrumentLogShape(3)).toEqual({ entries: 180, resolutionSeconds: 60 });
    expect(instrumentLogShape(6)).toEqual({ entries: 360, resolutionSeconds: 60 });
    expect(instrumentLogShape(12)).toEqual({ entries: 360, resolutionSeconds: 120 });
    expect(instrumentLogShape(24)).toEqual({ entries: 360, resolutionSeconds: 240 });
  });

  it('shapes the log from the window', () => {
    const config = makeConfig({ instrumentLog: { hours: 12 } });
    expect(config.history.resolutionSeconds).toBe(120);
    expect(config.instrumentLog.entries).toBe(360);
  });

  it('publishes no log at all when the window is zero', () => {
    expect(makeConfig({ instrumentLog: { hours: 0 } }).history.enabled).toBe(false);
  });

  it('warns when the window is shorter than one publish interval', () => {
    // Two windows with no overlap: every publish would replace the graph
    // rather than extend it.
    const resolved = resolveConfig({
      ...COMPLETE_FORM,
      interval: { underwayMinutes: 180, stationaryMinutes: 60 },
      instrumentLog: { ...COMPLETE_FORM.instrumentLog, hours: 1 },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.warnings.join(' ')).toMatch(
      /history window is 60 min, less than the 10800s underway/,
    );
  });

  it('says nothing when the log outlasts the cadence, or there is no log', () => {
    expect(resolveConfig({ ...COMPLETE_FORM }).warnings).toEqual([]);
    expect(
      resolveConfig({
        ...COMPLETE_FORM,
        interval: { underwayMinutes: 180, stationaryMinutes: 60 },
        instrumentLog: { ...COMPLETE_FORM.instrumentLog, hours: 0 },
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
