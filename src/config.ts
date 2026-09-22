/**
 * Plugin configuration: the JSON Schema the Signal K admin UI renders, the
 * TypeScript shape it produces, and the resolver that turns a filled-in form
 * into values the rest of the plugin can rely on.
 *
 * The config page is the only place any of this is set. `data/vessel/site.json`
 * in the published repo is an *output* of this file, written for the frontend
 * to read.
 *
 * Six settings are derived rather than typed: the repository name from the
 * owner, the branch, the site address from the repository, the track timezone
 * from the server, the polar table from the Polar Management plugin, and the
 * tide station from the boat's position. Each one has an "Override" checkbox
 * in the Overrides section, and the typed field appears directly beneath it
 * only once that box is ticked — see `shownWhenTicked`. Whether the plugin
 * found a value, and what it was, is written into the checkbox's own
 * description every time the page is opened, so it is current rather than
 * whatever was derived the day the config was last saved.
 *
 * Defaults are the values this tracker has run on for years on a Raspberry
 * Pi. What is *not* defaulted is anything that belongs to one
 * particular boat: privacy zones start empty, and the repo and token have no
 * stand-in.
 */

import { parseIcon, parseLogo, type VesselIcon, type VesselLogo } from './logo';
import { DEFAULT_NOTIFICATION_EXCLUDE } from './notifications';
import { availableTimezones, serverTimezone } from './timezones';

/** One extra button in the site's link row. */
export interface CustomLink {
  label: string;
  url: string;
}

export interface PrivacyZone {
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
}

/** A fully resolved configuration: every required value present. */
export interface PluginConfig {
  github: {
    /** User or organization. */
    owner: string;
    /** Repository name, without the owner. */
    name: string;
    /** `owner/name`, the form the API client and the frontend links want. */
    repo: string;
    branch: string;
    token: string;
  };
  /** Publish cadence in seconds. The config page asks for minutes. */
  interval: {
    underway: number;
    stationary: number;
  };
  privacyZones: PrivacyZone[];
  /** IANA zone tracks are grouped by: the server's, or the one overridden. */
  timezone: string;
  instrumentLog: {
    paths: string[];
    entries: number;
  };
  /** How long raw positions stay in `positions_index.json`. Not configurable. */
  positionRetentionHours: number;
  staleMaxAgeMinutes: number;
  /**
   * Where the instrument log comes from. With a history provider on the
   * server the sparklines are read back from it every cycle; without one —
   * or with this turned off — the site simply has none. The track is not
   * part of this: it is always the plugin's own, from the tree.
   */
  history: {
    enabled: boolean;
    /** Empty means whichever provider the server has as its default. */
    providerId: string;
    resolutionSeconds: number;
    timeoutMs: number;
  };
  /**
   * The polar table. Unticked, the active polar from Polar Management is
   * published and `table` is ignored; ticked, `table` is published instead.
   */
  polars: {
    override: boolean;
    table: string;
  };
  /** How much detail the recorded track keeps. See `track.ts`. */
  track: { detailMeters: number };
  /**
   * Minutes of continuous publish failure before raising a Signal K
   * notification. Zero turns it off. See `alarm.ts`.
   */
  notifyAfterFailureMinutes: number;
  /**
   * Publish `data/telemetry/notifications.json`: the active notifications and
   * the 24-hour firing log behind the site's Notifications panel.
   *
   * It has a switch and the rest of the telemetry does not, because a
   * notification carries a free-text `message` written by whatever plugin
   * raised it, and that message goes to a public website verbatim. Everything
   * else the plugin publishes is a number off a known path.
   */
  publishNotifications: boolean;
  /**
   * Notification paths never published. Empty means publish every one —
   * unlike the captured instrument paths, an empty blacklist is a real
   * answer and must not fall back to the default.
   */
  notificationExclude: string[];
  site: {
    /**
     * The site's own address, with a trailing slash.
     *
     * Derived from the repository unless the override is ticked, which is what
     * a custom domain needs. It is not decoration: the social-preview tags are
     * absolute URLs, and a link shared into a group chat is rendered by a
     * crawler that never runs the page's JavaScript.
     */
    url: string;
    /** The logo to publish, or null to leave `data/vessel/logo.png` alone. */
    logo: VesselLogo | null;
    /**
     * The icon to publish, or null to fall back to the bundled generic one.
     * Separate from the logo: the tab, home-screen and link-preview icon
     * wants a simple square mark, not the same image the status hero shows.
     */
    icon: VesselIcon | null;
    /** Extra buttons in the site's link row, in the order they appear. */
    customLinks: CustomLink[];
    /**
     * The NOAA tide station the site queries instead of the one nearest the
     * boat. Empty means nearest-by-distance, and with no GPS fix either the
     * tide and forecast panels say so rather than showing some other coast's
     * numbers.
     *
     * This replaced a "default position" lat/lon, captured from the boat's
     * own `navigation.position` by a checkbox that read the self tree
     * directly, ahead of the privacy-zone redaction that guards every other
     * position on its way to the repository. A station ID names a public
     * NOAA reference point, not anywhere the boat has been, so there is
     * nothing here for a privacy zone to need to redact.
     */
    tideStationOverride: string;
  };
}

/**
 * Default `instrumentLog.paths`: what the bundled sparklines draw.
 *
 * A path no instrument produces costs nothing — it simply never appears in the
 * log. Every path here is recorded for every entry and re-uploaded on every
 * publish, so the list is worth trimming on a cellular data plan.
 */
export const DEFAULT_INSTRUMENT_LOG_PATHS = [
  'navigation.speedOverGround',
  'navigation.speedThroughWater',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'navigation.attitude.roll',
  'navigation.attitude.pitch',
  'environment.wind.speedApparent',
  'environment.wind.angleApparent',
  'environment.wind.speedTrue',
  'environment.wind.directionTrue',
  'environment.depth.belowTransducer',
  'environment.water.temperature',
  'environment.outside.temperature',
  'environment.outside.pressure',
  'environment.inside.temperature',
  'environment.inside.humidity',
  'electrical.batteries.*.voltage',
  'electrical.batteries.*.current',
  // Both spellings. The Signal K spec puts state of charge under
  // `capacity`, which is what the frontend's battery panel reads and what a
  // spec-compliant producer publishes; the short form is what some others
  // use. Asking for a path no instrument produces costs nothing — it comes
  // back as a column of nulls and never reaches the file — and asking for
  // only the short one meant the battery sparkline never drew on a
  // spec-compliant boat.
  'electrical.batteries.*.capacity.stateOfCharge',
  'electrical.batteries.*.stateOfCharge',
  'electrical.batteries.*.capacity.timeRemaining',
  'electrical.solar.*.panelPower',
  'tanks.*.*.currentLevel',
  'propulsion.*.revolutions',
  'propulsion.*.temperature',
  'propulsion.*.runTime',
];

/** Cadence while `navigation.state` says the boat is moving, in minutes. */
export const DEFAULT_INTERVAL_UNDERWAY_MINUTES = 2;
/** Cadence while moored, anchored, or state unknown, in minutes. */
export const DEFAULT_INTERVAL_STATIONARY_MINUTES = 60;
/** The same two, in the seconds the scheduler runs on. */
export const DEFAULT_INTERVAL_UNDERWAY = DEFAULT_INTERVAL_UNDERWAY_MINUTES * 60;
export const DEFAULT_INTERVAL_STATIONARY = DEFAULT_INTERVAL_STATIONARY_MINUTES * 60;
/**
 * How far back the sparklines plot, in hours.
 *
 * One hour is the shortest window the site's history dropdown offers, and
 * the only one every install can promise. Raising it is what makes the 3, 12
 * and 24 hour windows selectable, at the cost of a longer file uploaded in
 * full on every publish. Zero publishes no log at all, and the panels show
 * current values without graphs.
 */
export const DEFAULT_INSTRUMENT_LOG_HOURS = 1;
/**
 * Most buckets the published log is allowed to hold.
 *
 * The window is a single setting and the bucket width follows from it, so
 * that asking for a day of history cannot quietly make every cycle upload
 * half a megabyte. 24 hours lands on 4-minute buckets and about 130 kB; an
 * hour stays at the 60 s floor. A sparkline card is some 400 px wide, so
 * finer than this is detail nobody can see, paid for every two minutes.
 */
const INSTRUMENT_LOG_MAX_ENTRIES = 360;
/**
 * Default track detail, in meters.
 *
 * A fix is dropped when the line through its neighbors already passes
 * within this of it. 15 m is finer than a GPS fix is repeatable, so the
 * track follows every tack and gybe, while a straight leg costs almost
 * nothing — the whole day's GPX is re-uploaded on every cycle, so points on
 * a straight line are paid for again every two minutes until midnight.
 */
export const DEFAULT_TRACK_DETAIL_METERS = 15;
/**
 * Minutes of continuous failure before the plugin raises a notification.
 *
 * Long enough that a dropped hotspot or a 502 from GitHub passes unremarked
 * — at the underway cadence this is fifteen consecutive failed attempts — and
 * short enough to hear about an expired token on the same passage it expired.
 */
export const DEFAULT_NOTIFY_AFTER_FAILURE_MINUTES = 30;
/**
 * How long raw positions stay in `positions_index.json`: the map's 24-hour
 * track. Not on the config page — past days survive as GPX regardless, and a
 * longer window only makes a file that is uploaded on every cycle bigger.
 */
export const DEFAULT_POSITION_RETENTION_HOURS = 24;
/** Values older than this are dropped from the published snapshot. */
export const DEFAULT_STALE_MAX_AGE_MINUTES = 60;
/**
 * Finest bucket width asked of the history provider, in seconds.
 *
 * One minute is finer than any publish cadence, so nothing is gained by
 * asking for less, and a window short enough to sit at this floor is
 * published at full resolution.
 */
export const HISTORY_RESOLUTION_SECONDS = 60;
/**
 * A history query is a database call; past this the cycle publishes no log
 * and leaves the copy already on the site in place.
 *
 * Not on the config page: a query that has not answered in twenty seconds is
 * a provider in trouble, not a number to tune per boat.
 */
export const HISTORY_TIMEOUT_MS = 20_000;

/**
 * The published log's shape, from the one window setting on the page.
 *
 * Bucket width is rounded up to whole minutes so the spacing reads as a
 * round number in the graphs, and the entry count follows from it. Zero
 * hours means no log: `entries` is still a positive number because the
 * publisher trims by it, but nothing asks the provider for anything.
 */
export function instrumentLogShape(hours: number): {
  entries: number;
  resolutionSeconds: number;
} {
  const windowSeconds = Math.max(0, hours) * 3600;
  const minutes = Math.ceil(windowSeconds / INSTRUMENT_LOG_MAX_ENTRIES / 60);
  const resolutionSeconds = Math.max(HISTORY_RESOLUTION_SECONDS, minutes * 60);
  return {
    entries: Math.max(1, Math.round(windowSeconds / resolutionSeconds)),
    resolutionSeconds,
  };
}

/** Read once: the list is the same for every field that shows it. */
const TIMEZONES = availableTimezones();

/**
 * What to tick when making the token.
 *
 * Only what the token will not work without. "Contents: read and write" is the
 * permission people miss — a token with only Metadata reads fine and fails the
 * first commit with a 403.
 */
export const PAT_GUIDANCE =
  'GitHub > Settings > Developer settings > Personal access tokens > Fine-grained ' +
  'tokens. Repository access: Only select repositories, this one. Repository ' +
  'permissions: Contents "Read and write".';

/**
 * The polar override box's help text.
 *
 * `buildConfigSchema` puts what the last cycle actually found on the checkbox
 * above it, where it is readable whether or not the override is ticked.
 */
export const POLARS_FIELD_DESCRIPTION =
  'Published instead of the active polar from the Polar Management plugin: first ' +
  'line the true wind speeds in knots, then one line per true wind angle in ' +
  'degrees followed by the target boat speeds. Semicolons, commas, tabs or spaces ' +
  'all work, and # starts a comment. A box you have not typed in yet starts off ' +
  'as the active polar, if there is one; empty falls back to the server.';

/** What the last cycle found, for the note under the polar field. */
export interface PolarStatus {
  source: 'resource' | 'config' | 'none';
  /** Human summary, e.g. `"mermug-orc" from Polar Management, 18 angle(s)...`. */
  summary: string;
  problems: string[];
}

/** The NOAA station nearest the boat, for the tide override's note. */
export interface NearestTideStation {
  id: string;
  name: string;
  distanceNm: number;
}

/** What the plugin knows that the form does not, at the moment it is opened. */
export interface SchemaContext {
  /** `<owner>.github.io`, derived from the saved owner. */
  repoName?: string;
  /** The Pages URL, derived from the saved owner and repository name. */
  siteUrl?: string;
  /**
   * Whether the last cycle reached the branch it publishes to. Null before
   * any cycle has run, which the page says rather than guessing.
   */
  branch?: { name: string; ok: boolean; detail?: string } | null;
  /** What the last cycle resolved for the polar table. */
  polar?: PolarStatus | null;
  /** The active polar rendered as CSV, to start an override off from. */
  polarCsv?: string;
  /** The station the site would pick from the boat's position right now. */
  tideStation?: NearestTideStation | null;
  /**
   * History providers registered on the server, for the provider dropdown.
   * Null when the server cannot be asked (no History API).
   */
  historyProviders?: { ids: string[]; defaultId?: string } | null;
  /**
   * The saved configuration, for settings that have moved between sections.
   *
   * The admin UI fills a field the stored config has no value for from the
   * schema `default` — and submits it. Without this, opening the page on a
   * config written before a setting moved would show the default beside every
   * moved setting, and saving would quietly replace what the boat had been
   * running on.
   */
  saved?: Record<string, any>;
}

/** The marks the Overrides section puts in front of each derived value. */
const FOUND = '✅';
const NOT_FOUND = '⚠️';
const NOT_CHECKED = '⏳';

/**
 * The overrides as a config written before the Overrides section stored them,
 * one flag and one value per setting, each in the section it overrode.
 *
 * Read by `resolveConfig` whenever the new section has not been saved yet, and
 * by `carryForwardMovedSettings` so the page opens with those boxes ticked.
 */
function legacyOverrides(saved: Record<string, any>): Record<string, unknown> {
  const github = saved.github ?? {};
  const site = saved.site ?? {};
  const timezone = saved.timezone ?? {};
  const polars = saved.polars ?? {};
  const branch = str(github.branch);
  const tide = str(site.tideStationOverride);
  return {
    overrideRepository: bool(github.overrideName),
    repository: str(github.name),
    overrideBranch: branch !== '' && branch !== DEFAULT_BRANCH,
    branch: branch && branch !== DEFAULT_BRANCH ? branch : '',
    overrideSiteUrl: bool(site.overrideUrl),
    siteUrl: str(site.url),
    overrideTimezone: bool(timezone.override),
    timezone: str(timezone.zone),
    overridePolar: bool(polars.override),
    polar: typeof polars.table === 'string' ? polars.table : '',
    overrideTideStation: tide !== '',
    tideStation: tide,
  };
}

/**
 * The overrides as `resolveConfig` reads them: the Overrides section once it
 * has been saved, and the old per-section fields until then.
 */
export function readOverrides(input: Record<string, any>): Record<string, unknown> {
  const overrides = input.overrides;
  if (overrides && typeof overrides === 'object') return overrides;
  return legacyOverrides(input);
}

/**
 * Prefill the settings that have moved sections from where they used to be
 * stored, so a config written before the move opens showing its own values.
 *
 * Only the keys the page no longer has a place for are read here;
 * `resolveConfig` reads them too, so the plugin publishes the same settings
 * whether or not anyone has opened the page since the upgrade.
 */
function carryForwardMovedSettings(
  schema: typeof configSchema,
  saved: Record<string, any>,
): void {
  const properties = schema.properties as any;
  const instrumentLog = saved.instrumentLog ?? {};
  const history = saved.history ?? {};
  const notifications = saved.notifications ?? {};
  const track = saved.track ?? {};

  if (num(track.detailMeters) === null && num(track.detailMetres) !== null) {
    properties.track.properties.detailMeters.default = num(track.detailMetres);
  }
  if (zeroOrMore(instrumentLog.hours) === null) {
    const hours = resolveInstrumentLogHours(instrumentLog, history);
    properties.instrumentLog.properties.hours.default = hours;
    if (!str(instrumentLog.providerId) && str(history.providerId)) {
      properties.instrumentLog.properties.providerId.default = str(history.providerId);
    }
  }
  if (notifications.publish === undefined && saved.publishNotifications !== undefined) {
    properties.notifications.properties.publish.default = saved.publishNotifications !== false;
  }
  if (notifications.exclude === undefined && saved.notificationExclude !== undefined) {
    properties.notifications.properties.exclude.default = parsePathList(
      saved.notificationExclude,
    ).join('\n');
  }
  if (
    zeroOrMore(notifications.warnAfterMinutes) === null &&
    zeroOrMore(saved.notifyAfterFailureMinutes) !== null
  ) {
    properties.notifications.properties.warnAfterMinutes.default = zeroOrMore(
      saved.notifyAfterFailureMinutes,
    );
  }

  // The overrides used to sit in the section of the setting they overrode.
  // A config that has never saved the Overrides section opens with the boxes
  // it had ticked still ticked, and the values it had typed behind them.
  if (saved.overrides === undefined) {
    const legacy = legacyOverrides(saved);
    for (const { flag, field } of OVERRIDES) {
      if (legacy[flag] !== true) continue;
      properties.overrides.properties[flag].default = true;
      if (legacy[field]) overrideField(schema, flag, field).default = legacy[field] as string;
    }
  }
}

/**
 * The typed field an "Override" checkbox reveals, for `buildConfigSchema` to
 * fill in.
 *
 * It lives in the ticked branch of a `dependencies` block, which is past
 * where the schema's own types reach; the cast is to that one field.
 */
function overrideField(
  schema: typeof configSchema,
  flag: string,
  field: string,
): { description?: string; default?: string } {
  return (schema.properties.overrides.dependencies as any)[flag].oneOf[1].properties[field];
}

/** The "Override" checkbox itself, whose description carries what is derived. */
function overrideCheckbox(schema: typeof configSchema, flag: string): { description: string } {
  return (schema.properties.overrides.properties as any)[flag];
}

/** Put a found / not-found line in front of a checkbox's own description. */
function annotate(schema: typeof configSchema, flag: string, note: string): void {
  const checkbox = overrideCheckbox(schema, flag);
  checkbox.description = `${note} ${checkbox.description}`;
}

/**
 * The config schema, with what the plugin currently derives written into the
 * override checkboxes.
 *
 * Signal K calls `plugin.schema()` when the page is opened, so this runs then,
 * not at install: open the page after changing the active polar and it says
 * which one is being published.
 *
 * The derived values go in the descriptions rather than into the fields
 * because a description is read-only text the form cannot save back, while a
 * `default` is submitted with everything else the first time the page is
 * saved — which is how the old read-only boxes came to show a value from
 * whenever the config was last written instead of what is true now. The one
 * `default` still set here is the polar CSV, and it sits in the branch that
 * exists only while Override polar is ticked: a starting point for editing,
 * saved only once the override is genuinely on.
 *
 * Every override opens with a mark saying whether the plugin found the value
 * it would otherwise use: a check when it did, a warning when it did not, an
 * hourglass when no cycle has run to find out.
 */
export function buildConfigSchema(context: SchemaContext = {}): typeof configSchema {
  const { repoName, siteUrl, branch, polar, polarCsv, tideStation, historyProviders, saved } =
    context;
  const schema = JSON.parse(JSON.stringify(configSchema)) as typeof configSchema;

  if (saved) carryForwardMovedSettings(schema, saved);

  annotate(
    schema,
    'overrideRepository',
    repoName
      ? `${FOUND} Derived: publishing to ${repoName}.`
      : `${NOT_FOUND} Not derived: set the repository owner above.`,
  );
  annotate(
    schema,
    'overrideBranch',
    !branch
      ? `${NOT_CHECKED} Not checked yet: no cycle has run.`
      : branch.ok
        ? `${FOUND} Found: the last cycle published to ${branch.name}.`
        : `${NOT_FOUND} Not found: the last cycle could not publish to ${branch.name}` +
          `${branch.detail ? ` (${branch.detail})` : ''}.`,
  );
  annotate(
    schema,
    'overrideSiteUrl',
    siteUrl
      ? `${FOUND} Derived: the site is served at ${siteUrl}.`
      : `${NOT_FOUND} Not derived: set the repository owner above.`,
  );
  annotate(
    schema,
    'overrideTimezone',
    `${FOUND} Found: this server is set to ${serverTimezone()}.`,
  );

  if (!polar) {
    annotate(schema, 'overridePolar', `${NOT_CHECKED} Not checked yet: no cycle has run.`);
  } else {
    const problems = polar.problems.length ? ` ${polar.problems.join(' ')}` : '';
    annotate(
      schema,
      'overridePolar',
      polar.source === 'none'
        ? `${NOT_FOUND} Not found: publishing no polar, ${polar.summary}.${problems}`
        : `${FOUND} Found: publishing ${polar.summary}.${problems}`,
    );
  }
  if (polarCsv) overrideField(schema, 'overridePolar', 'polar').default = polarCsv;

  annotate(
    schema,
    'overrideTideStation',
    tideStation
      ? `${FOUND} Found: ${tideStation.name} (station ${tideStation.id}), ` +
          `${tideStation.distanceNm.toFixed(1)} NM from the boat.`
      : `${NOT_FOUND} Not found: the boat has no GPS position, or no listed station is near it.`,
  );

  // The provider dropdown lists what is registered right now. The saved
  // choice stays selectable even when its plugin is disabled: an enum that no
  // longer holds the saved value fails validation, and the admin UI then
  // refuses to save anything until someone works out why.
  const provider = (schema.properties.instrumentLog.properties as any).providerId;
  const ids = historyProviders?.ids ?? [];
  const current = str(saved?.instrumentLog?.providerId) || str(saved?.history?.providerId);
  const choices = current && !ids.includes(current) ? [...ids, current] : [...ids];
  provider.enum = ['', ...choices];
  provider.enumNames = [
    historyProviders?.defaultId
      ? `Server default (${historyProviders.defaultId})`
      : historyProviders
        ? 'Server default (none registered)'
        : 'Server default',
    ...choices.map((id) => (ids.includes(id) ? id : `${id} (not registered)`)),
  ];

  return schema;
}

/**
 * The derived settings, in the order the Overrides section shows them: each
 * flag is the checkbox, each field the typed value it reveals.
 */
const OVERRIDES = [
  { flag: 'overrideRepository', field: 'repository' },
  { flag: 'overrideBranch', field: 'branch' },
  { flag: 'overrideSiteUrl', field: 'siteUrl' },
  { flag: 'overrideTimezone', field: 'timezone' },
  { flag: 'overridePolar', field: 'polar' },
  { flag: 'overrideTideStation', field: 'tideStation' },
] as const;

/** Branch GitHub Pages publishes from unless the override says otherwise. */
export const DEFAULT_BRANCH = 'main';

/**
 * A derived field's "Override" checkbox, as a JSON Schema dependency: the
 * typed field exists only in the branch where the box is ticked.
 *
 * `dependencies` rather than `if`/`then` because every react-json-schema-form
 * the Signal K admin UI has shipped understands one, and the field is added by
 * the branch rather than grayed out in `properties` because that is the part
 * every version renders the same way. The grayed-out version this replaced had
 * a worse problem than looking inert on an old admin UI: the box was filled
 * from a JSON Schema `default`, the form submits its defaults, and so the
 * derived value of the day was written into the saved config and shown back
 * for ever after. Open the page a month later and the read-only polar box
 * still held the table Polar Management served when the config was last
 * saved — and ticking Override started you off editing that stale copy.
 *
 * A field that is not in the schema is still not dropped from the config: the
 * admin UI leaves form data it cannot see alone, so a typed polar table
 * survives unticking the box and comes back when it is ticked again.
 *
 * The form appends a dependency's field after every property of the object,
 * so without help all six typed boxes would pile up at the bottom of the
 * Overrides section under the last checkbox. `ui:order` in `configUiSchema` is
 * what puts each one directly beneath its own box.
 */
function shownWhenTicked(flag: string, field: string, definition: object) {
  return {
    [flag]: {
      oneOf: [
        { properties: { [flag]: { enum: [false] } } },
        {
          properties: {
            [flag]: { enum: [true] },
            [field]: definition,
          },
        },
      ],
    },
  };
}

export const configSchema = {
  type: 'object',
  required: ['github'],
  properties: {
    github: {
      type: 'object',
      title: 'GitHub repository',
      description:
        'The repository name, branch and site address follow from the owner; each ' +
        'can be changed under Overrides.',
      required: ['owner', 'token'],
      properties: {
        owner: {
          type: 'string',
          title: 'Repository owner',
          description: 'Your GitHub username, or the organization that owns the repository.',
        },
        token: {
          type: 'string',
          title: 'Personal access token',
          description: PAT_GUIDANCE,
        },
      },
    },
    interval: {
      type: 'object',
      title: 'Publish cadence',
      properties: {
        underwayMinutes: {
          type: 'number',
          title: 'Underway interval (minutes)',
          description: 'Used when navigation.state is sailing or motoring.',
          default: DEFAULT_INTERVAL_UNDERWAY_MINUTES,
        },
        stationaryMinutes: {
          type: 'number',
          title: 'Stationary interval (minutes)',
          description: 'Used when moored, anchored, or the state is unknown.',
          default: DEFAULT_INTERVAL_STATIONARY_MINUTES,
        },
      },
    },
    privacyZones: {
      type: 'array',
      title: 'Privacy zones',
      description:
        'Positions inside any of these circles are published as the zone center ' +
        'and left out of the GPX tracks. Changing a zone rechecks every published ' +
        'track on the next cycle and trims whatever falls inside it. Empty means ' +
        'nothing is hidden.',
      items: {
        type: 'object',
        required: ['lat', 'lon', 'radius_m'],
        properties: {
          name: { type: 'string', title: 'Name' },
          lat: { type: 'number', title: 'Latitude' },
          lon: { type: 'number', title: 'Longitude' },
          radius_m: { type: 'number', title: 'Radius (meters)' },
        },
      },
      default: [],
    },
    instrumentLog: {
      type: 'object',
      title: 'Instruments (sparklines)',
      description:
        'The rolling log the sparklines are drawn from, read back every cycle from a ' +
        'Signal K history provider (signalk-to-influxdb2, for example). With no ' +
        'provider the site shows current values and omits the graphs. The map track ' +
        "is not part of this: it is always the plugin's own.",
      properties: {
        paths: {
          type: 'string',
          title: 'Captured paths',
          description:
            'One Signal K path per line. "*" matches one path segment, and lines ' +
            'starting with # are comments. navigation.position is never asked for: ' +
            'the track comes from the boat, through the privacy zones.',
          default: DEFAULT_INSTRUMENT_LOG_PATHS.join('\n'),
        },
        hours: {
          type: 'number',
          title: 'History window (hours)',
          description:
            'How far back the sparklines plot. The site offers 1, 3, 12 and 24 hour ' +
            'views and marks any longer than this "not logged", so 24 makes all four ' +
            'available. Bucket width follows the window, so the published file stays ' +
            'about the same size however long it is. Zero publishes no log at all.',
          default: DEFAULT_INSTRUMENT_LOG_HOURS,
        },
        providerId: {
          type: 'string',
          title: 'History provider',
          description:
            'The history providers registered on this server. The server default is ' +
            'the one chosen in the server settings; pick another only when more than ' +
            'one is registered.',
          default: '',
        },
      },
    },
    staleMaxAgeMinutes: {
      type: 'number',
      title: 'Stale value cutoff (minutes)',
      description:
        'Values older than this are dropped from the published snapshot, so the site ' +
        'shows them as unavailable rather than as current.',
      default: DEFAULT_STALE_MAX_AGE_MINUTES,
    },
    track: {
      type: 'object',
      title: 'Track',
      properties: {
        detailMeters: {
          type: 'number',
          title: 'Track detail (meters)',
          description:
            'A fix is kept when dropping it would move the drawn track by more than ' +
            'this, and at least once per publish cycle. Smaller follows a tack more ' +
            'closely and uploads more; larger is cheaper on a hotspot.',
          default: DEFAULT_TRACK_DETAIL_METERS,
        },
      },
    },
    notifications: {
      type: 'object',
      title: 'Notifications',
      properties: {
        publish: {
          type: 'boolean',
          title: 'Publish notifications',
          description:
            'Publish active notifications and how often each has fired over the last ' +
            '24 hours. A notification message is free text from whichever plugin ' +
            'raised it, published verbatim — turn this off if yours say anything you ' +
            'would not put on a public page.',
          default: true,
        },
        exclude: {
          type: 'string',
          title: 'Never published',
          description:
            'One notification path per line, without the "notifications." prefix. ' +
            '"*" matches one segment and a parent excludes its subtree, so "server" ' +
            'drops every server notification. Empty publishes every one.',
          default: DEFAULT_NOTIFICATION_EXCLUDE.join('\n'),
        },
        warnAfterMinutes: {
          type: 'number',
          title: 'Warn after this many minutes of failure',
          description:
            'Raise notifications.tracker.publishFailed once publishing has been ' +
            'failing for this long, so an expired token reaches KIP or the ' +
            'chartplotter rather than only the server log. Zero turns it off.',
          default: DEFAULT_NOTIFY_AFTER_FAILURE_MINUTES,
        },
      },
    },
    site: {
      type: 'object',
      title: 'Site details',
      description:
        'Name, MMSI, callsign, registrations and dimensions are read from the Signal K ' +
        'tree every cycle and written into data/vessel/site.json.',
      properties: {
        logo: {
          type: 'string',
          // `format: data-url` is what makes react-json-schema-form render a
          // file picker and hand back `data:image/png;base64,...`; the
          // ui:schema asks for the same widget by name, because the two have
          // been spelled differently across the versions the Signal K admin UI
          // has shipped. A renderer that understands neither shows a text box,
          // which still takes a pasted data URL.
          format: 'data-url',
          title: 'Vessel logo',
          description:
            'Shown beside the name at the top of the site and in the footer. PNG, ' +
            'JPEG, WebP or SVG. Empty falls back to data/vessel/logo.png if you have ' +
            'committed one. The tab and home-screen icon is set separately, below.',
          default: '',
        },
        icon: {
          type: 'string',
          format: 'data-url',
          title: 'Vessel icon',
          description:
            'The browser tab icon, the home-screen icon, and the image a shared link ' +
            'unfurls to in a chat app. A simple square mark works best. PNG, JPEG, ' +
            'WebP or SVG. Empty falls back to a generic tracker icon.',
          default: '',
        },
        customLinks: {
          type: 'array',
          title: 'Custom buttons',
          description:
            'Buttons added to the link row at the top of the site, in this order. ' +
            'Only http:// and https:// links are published.',
          items: {
            type: 'object',
            required: ['label', 'url'],
            properties: {
              label: { type: 'string', title: 'Button label' },
              url: { type: 'string', title: 'URL' },
            },
          },
          default: [],
        },
      },
    },
    overrides: {
      type: 'object',
      title: 'Overrides',
      description:
        'Settings the plugin works out for itself. Each says whether it found a value ' +
        `(${FOUND} found, ${NOT_FOUND} not found, ${NOT_CHECKED} not checked yet). Tick ` +
        'a box to type your own instead.',
      dependencies: {
        ...shownWhenTicked('overrideRepository', 'repository', {
          type: 'string',
          title: 'Repository name',
          description:
            'The repository to publish to, without the owner. A project site — e.g. ' +
            '"tracker", served at /tracker/ — goes here.',
          default: '',
        }),
        ...shownWhenTicked('overrideBranch', 'branch', {
          type: 'string',
          title: 'Branch',
          description: 'The branch GitHub Pages publishes from.',
          default: '',
        }),
        ...shownWhenTicked('overrideSiteUrl', 'siteUrl', {
          type: 'string',
          title: 'Site address',
          description:
            'Where the published site is served, e.g. https://example.com/. It is what ' +
            'a link preview in a chat app resolves images and titles against.',
          default: '',
        }),
        ...shownWhenTicked('overrideTimezone', 'timezone', {
          type: 'string',
          enum: ['UTC', ...TIMEZONES],
          enumNames: ['UTC', ...TIMEZONES],
          title: 'Track timezone',
          description: 'The calendar day GPX tracks are grouped by.',
          default: serverTimezone(),
        }),
        ...shownWhenTicked('overridePolar', 'polar', {
          type: 'string',
          title: 'Polar table',
          description: POLARS_FIELD_DESCRIPTION,
          default: '',
        }),
        ...shownWhenTicked('overrideTideStation', 'tideStation', {
          type: 'string',
          title: 'Tide station',
          description:
            'A NOAA station ID (e.g. 9414290). The tide and 48-hour conditions panels ' +
            'use it instead of the station nearest the boat.',
          default: '',
        }),
      },
      properties: {
        overrideRepository: {
          type: 'boolean',
          title: 'Override repository name',
          description: 'Publish to a repository other than <owner>.github.io.',
          default: false,
        },
        overrideBranch: {
          type: 'boolean',
          title: 'Override branch',
          description: `Publish to a branch other than ${DEFAULT_BRANCH}.`,
          default: false,
        },
        overrideSiteUrl: {
          type: 'boolean',
          title: 'Override site address',
          description: 'Publish under a custom domain rather than the GitHub Pages URL.',
          default: false,
        },
        overrideTimezone: {
          type: 'boolean',
          title: 'Override track timezone',
          description: "Group tracks by a zone other than the server's.",
          default: false,
        },
        overridePolar: {
          type: 'boolean',
          title: 'Override polar',
          description: 'Publish a table typed here instead of the active polar.',
          default: false,
        },
        overrideTideStation: {
          type: 'boolean',
          title: 'Override tide station',
          description: 'Use one NOAA station rather than the one nearest the boat.',
          default: false,
        },
      },
    },
  },
};

/** Admin-UI hints: which boxes are passwords, and which are textareas. */
export const configUiSchema = {
  github: { token: { 'ui:widget': 'password' } },
  site: { logo: { 'ui:widget': 'file' }, icon: { 'ui:widget': 'file' } },
  instrumentLog: { paths: { 'ui:widget': 'textarea', 'ui:options': { rows: 12 } } },
  notifications: { exclude: { 'ui:widget': 'textarea', 'ui:options': { rows: 4 } } },
  overrides: {
    // Each typed box directly under its own checkbox. A name the schema does
    // not currently have — every typed box while its override is unticked —
    // is skipped by the form, and "*" catches anything added later.
    'ui:order': [...OVERRIDES.flatMap(({ flag, field }) => [flag, field]), '*'],
    polar: { 'ui:widget': 'textarea', 'ui:options': { rows: 12 } },
  },
};

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

/**
 * A number the page is allowed to set to zero, where zero is an answer
 * rather than an empty box: no history window, no failure alarm.
 *
 * `num` rejects it along with the negatives and the blanks, which is how
 * "Zero turns it off" came to mean "fall back to thirty minutes".
 */
function zeroOrMore(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  // The admin UI hands back a string for a number field often enough to matter.
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Parse the free-form path list: one path per line, `#` comments allowed.
 *
 * An array is accepted too, so a config written against the array form of
 * this field still loads.
 */
export function parsePathList(value: unknown): string[] {
  const lines = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === 'string'
      ? value.split(/[\r\n,]+/)
      : [];
  const seen = new Set<string>();
  for (const line of lines) {
    const path = line.trim();
    if (!path || path.startsWith('#')) continue;
    seen.add(path);
  }
  return [...seen];
}

/** GitHub's own rule for a user or organization name. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** And for a repository name. */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Strip what people paste instead of a bare name: a browser URL, a clone URL,
 * a trailing slash, a `.git` suffix.
 */
function stripRepoUrl(value: string): string {
  return value
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

export interface OwnerAndName {
  owner: string;
  name: string;
  problems: string[];
}

/**
 * Resolve the repository.
 *
 * The name is `<owner>.github.io` — the user site, which is what almost every
 * install wants — unless the override is ticked, in which case the typed name
 * is used. A pasted URL or an `owner/name` in either box is split rather than
 * rejected: it was the most common setup mistake, and it used to fail only on
 * the first publish.
 */
export function resolveOwnerAndName(
  rawOwner: unknown,
  rawName: unknown,
  override = false,
): OwnerAndName {
  const problems: string[] = [];
  let owner = stripRepoUrl(str(rawOwner));
  let typed = stripRepoUrl(str(rawName));

  // "owner/name" pasted into either box.
  if (owner.includes('/')) {
    const [first, ...rest] = owner.split('/');
    owner = first ?? '';
    if (!typed) typed = rest.join('/');
  }
  if (typed.includes('/')) {
    const parts = typed.split('/');
    typed = parts[parts.length - 1] ?? '';
    if (!owner) owner = parts[0] ?? '';
  }

  if (!owner) {
    problems.push('GitHub repository owner is not set (your username, or the organization).');
  } else if (!OWNER_PATTERN.test(owner)) {
    problems.push(`GitHub repository owner "${owner}" is not a GitHub username or organization.`);
  }

  const name = override ? typed : owner ? `${owner}.github.io` : '';
  if (override && !name) {
    problems.push(
      'Override repository name is ticked but no repository name is set; untick it to ' +
        'publish to <owner>.github.io.',
    );
  } else if (name && !NAME_PATTERN.test(name)) {
    problems.push(`GitHub repository name "${name}" is not a GitHub repository name.`);
  }
  return { owner, name, problems };
}

/**
 * The URL GitHub Pages serves a repository at.
 *
 * `<owner>.github.io` is the user site and is served at the domain root;
 * anything else is a project site under a path of its own. Lowercased because
 * the hostname is, and a mixed-case one in a link preview resolves to a 404 on
 * some clients.
 */
export function pagesUrl(owner: string, name: string): string {
  return /\.github\.io$/i.test(name)
    ? `https://${name.toLowerCase()}/`
    : `https://${owner.toLowerCase()}.github.io/${name}/`;
}

/**
 * The site's address: derived from the repository, or the typed one.
 *
 * Normalized to a trailing slash and an explicit scheme, because it is
 * concatenated with relative paths to build the absolute URLs in the
 * social-preview tags. A typed value that will not parse falls back to the
 * derived one with a warning rather than publishing `undefined/logo.png` into
 * everyone's link previews.
 */
export function resolveSiteUrl(
  owner: string,
  name: string,
  override: unknown,
  typed: unknown,
): { url: string; warnings: string[] } {
  const derived = owner && name ? pagesUrl(owner, name) : '';
  if (!bool(override)) return { url: derived, warnings: [] };

  const raw = str(typed);
  if (!raw) {
    return {
      url: derived,
      warnings: [
        'Override site address is ticked but no address is set; using ' +
          `${derived || 'the derived GitHub Pages URL'} instead.`,
      ],
    };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return {
      url: derived,
      warnings: [`The site address "${raw}" is not a URL; using ${derived} instead.`],
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      url: derived,
      warnings: [
        `The site address "${raw}" is not an http:// or https:// URL; using ` +
          `${derived} instead.`,
      ],
    };
  }
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`;
  return { url: parsed.toString(), warnings: [] };
}

/**
 * The path the site is served under, with both slashes: `/` or `/tracker/`.
 *
 * The web app manifest's `start_url` and `scope` are absolute paths, and a
 * project site that claims `/` takes over the owner's whole github.io domain
 * in an installed PWA.
 */
export function siteBasePath(siteUrl: string): string {
  try {
    const path = new URL(siteUrl).pathname;
    return path.endsWith('/') ? path : `${path}/`;
  } catch {
    return '/';
  }
}

/** A token that is plainly not a token, caught before the first 401. */
function tokenWarning(token: string): string | null {
  if (/^(github_pat_|ghp_|gho_|ghs_|ghu_)/.test(token)) return null;
  return (
    'The personal access token does not look like one (fine-grained tokens start ' +
    'with "github_pat_", classic tokens with "ghp_"). Publishing will fail with ' +
    'HTTP 401 if it is wrong.'
  );
}

export interface ResolvedConfig {
  ok: true;
  config: PluginConfig;
  /** Settings that resolved, but not to what the user probably meant. */
  warnings: string[];
}

export interface UnresolvedConfig {
  ok: false;
  /** One line per missing or invalid setting, in the order of the form. */
  problems: string[];
  warnings: string[];
}

/**
 * Keep the custom buttons that are actually buttons.
 *
 * The scheme check is not tidiness: the label and URL are published into
 * `site.json` and the frontend assigns the URL straight to `href`, so a
 * `javascript:` entry here would be a script running on every visitor's
 * browser. http and https only, and the frontend checks again on the way in.
 */
export function resolveCustomLinks(value: unknown): {
  links: CustomLink[];
  warnings: string[];
} {
  const links: CustomLink[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(value)) return { links, warnings };
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const label = str((entry as any).label);
    const url = str((entry as any).url);
    if (!label && !url) continue;
    if (!label || !url) {
      warnings.push(
        `Custom button "${label || url}" needs both a label and a URL; it was skipped.`,
      );
      continue;
    }
    if (!/^https?:\/\//i.test(url)) {
      warnings.push(
        `Custom button "${label}" has a URL that is not http:// or https://; it was skipped.`,
      );
      continue;
    }
    links.push({ label, url });
  }
  return { links, warnings };
}

/**
 * How far back the sparklines plot, in hours.
 *
 * The page asks for this one number. A config written before the instrument
 * log and the history provider became a single section stored the window as
 * `entries x resolutionSeconds` in two sections, with a switch of its own —
 * read that back into hours, so an upgrade keeps publishing the window it was
 * publishing rather than silently dropping to the default.
 */
function resolveInstrumentLogHours(
  instrumentLog: Record<string, any>,
  history: Record<string, any>,
): number {
  const typed = zeroOrMore(instrumentLog.hours);
  if (typed !== null) return typed;
  if (history.enabled === false) return 0;
  const entries = num(instrumentLog.entries);
  if (entries === null) return DEFAULT_INSTRUMENT_LOG_HOURS;
  return (entries * (num(history.resolutionSeconds) ?? HISTORY_RESOLUTION_SECONDS)) / 3600;
}

/**
 * Notification paths never published.
 *
 * Empty is a real answer — publish every one — so it must not fall back to
 * the default the way an empty path list does. That holds for the key this
 * setting had before it moved into the notifications section too: only a
 * config that has never carried either gets the default.
 */
function notificationExclude(
  notifications: Record<string, any>,
  input: Record<string, any>,
): string[] {
  const value = notifications.exclude ?? input.notificationExclude;
  return value === undefined ? [...DEFAULT_NOTIFICATION_EXCLUDE] : parsePathList(value);
}

/** The track timezone: the server's, unless the override is ticked. */
export function resolveTimezone(overrides: Record<string, unknown>): string {
  if (overrides.overrideTimezone === true) return str(overrides.timezone) || serverTimezone();
  return serverTimezone();
}

/** The polar table override: whether it is on, and what is in the box. */
export function resolvePolars(overrides: Record<string, unknown>): {
  override: boolean;
  table: string;
} {
  return {
    override: bool(overrides.overridePolar),
    table: typeof overrides.polar === 'string' ? overrides.polar : '',
  };
}

/** Cadence in seconds, from the minutes the config page asks for. */
function intervalSeconds(minutes: unknown, fallbackSeconds: number): number {
  const fromMinutes = num(minutes);
  if (fromMinutes !== null) return Math.max(1, Math.round(fromMinutes * 60));
  return fallbackSeconds;
}

/**
 * Validate the admin-UI payload and produce a complete config, or the list of
 * everything that stops the plugin publishing.
 *
 * Missing numbers fall back to the documented defaults — the schema supplies
 * them in the admin UI, and this repeats the fallback for a config written
 * before a field existed. What has no fallback is what belongs to one boat:
 * the repository and the token. A privacy zone missing its radius is fatal
 * too: a half-entered zone hides nothing while looking like it does, and the
 * failure mode is a published position someone believed was redacted.
 *
 * Every problem is reported at once: filling one field, restarting, and being
 * told about the next one is a miserable way to configure a plugin over a
 * boat's wifi.
 */
export function resolveConfig(raw: unknown): ResolvedConfig | UnresolvedConfig {
  const input = (raw ?? {}) as Record<string, any>;
  const github = input.github ?? {};
  const interval = input.interval ?? {};
  const instrumentLog = input.instrumentLog ?? {};
  // A config written before the merge kept these in sections of their own.
  const history = input.history ?? {};
  const notifications = input.notifications ?? {};
  const track = input.track ?? {};
  const site = input.site ?? {};
  const overrides = readOverrides(input);
  const problems: string[] = [];

  const warnings: string[] = [];

  const { owner, name, problems: repoProblems } = resolveOwnerAndName(
    github.owner,
    overrides.repository,
    bool(overrides.overrideRepository),
  );
  problems.push(...repoProblems);

  const typedBranch = str(overrides.branch);
  if (bool(overrides.overrideBranch) && !typedBranch) {
    warnings.push(
      `Override branch is ticked but no branch is set; publishing to ${DEFAULT_BRANCH}.`,
    );
  }
  const branch = (bool(overrides.overrideBranch) && typedBranch) || DEFAULT_BRANCH;

  const token = typeof github.token === 'string' ? github.token.trim() : '';
  if (!token) problems.push('GitHub personal access token is not set.');
  else {
    const warning = tokenWarning(token);
    if (warning) warnings.push(warning);
  }

  const customLinkResult = resolveCustomLinks(site.customLinks);
  const customLinks = customLinkResult.links;
  warnings.push(...customLinkResult.warnings);

  const siteUrlResult = resolveSiteUrl(
    owner,
    name,
    overrides.overrideSiteUrl,
    overrides.siteUrl,
  );
  warnings.push(...siteUrlResult.warnings);

  // A logo or icon that will not decode is fatal rather than a warning: it is
  // the one setting whose failure is invisible on the config page, and the
  // site would go on showing the previous image — or a broken one — while the
  // page said a new one was set.
  const logoResult = parseLogo(site.logo);
  problems.push(...logoResult.problems);
  const iconResult = parseIcon(site.icon);
  problems.push(...iconResult.problems);

  const zones: PrivacyZone[] = Array.isArray(input.privacyZones)
    ? input.privacyZones
        .filter((zone: any) => zone && typeof zone === 'object')
        .map((zone: any) => ({
          name: str(zone.name),
          lat: Number(zone.lat),
          lon: Number(zone.lon),
          radius_m: Number(zone.radius_m),
        }))
        .filter(
          (zone: PrivacyZone) =>
            Number.isFinite(zone.lat) &&
            Number.isFinite(zone.lon) &&
            Number.isFinite(zone.radius_m) &&
            zone.radius_m > 0,
        )
    : [];
  const droppedZones = Array.isArray(input.privacyZones)
    ? input.privacyZones.length - zones.length
    : 0;
  if (droppedZones > 0) {
    problems.push(
      `${droppedZones} privacy zone(s) are incomplete (each needs a latitude, ` +
        'longitude and a radius in meters) and would hide nothing.',
    );
  }

  if (problems.length) return { ok: false, problems, warnings };

  const paths = parsePathList(instrumentLog.paths);

  const underway = intervalSeconds(interval.underwayMinutes, DEFAULT_INTERVAL_UNDERWAY);
  const hours = resolveInstrumentLogHours(instrumentLog, history);
  const { entries, resolutionSeconds } = instrumentLogShape(hours);
  if (hours > 0 && hours * 3600 < underway) {
    // The log would not even span one publish interval, so every cycle would
    // publish a graph with no overlap with the last one.
    warnings.push(
      `The history window is ${Math.round(hours * 60)} min, less than the ` +
        `${Math.round(underway)}s underway publish interval, so the sparklines will ` +
        'jump rather than scroll.',
    );
  }

  return {
    ok: true,
    warnings,
    config: {
      github: {
        owner,
        name,
        repo: `${owner}/${name}`,
        branch,
        token,
      },
      interval: {
        underway,
        stationary: intervalSeconds(interval.stationaryMinutes, DEFAULT_INTERVAL_STATIONARY),
      },
      privacyZones: zones,
      timezone: resolveTimezone(overrides),
      instrumentLog: {
        paths: paths.length ? paths : DEFAULT_INSTRUMENT_LOG_PATHS,
        entries,
      },
      polars: resolvePolars(overrides),
      positionRetentionHours: DEFAULT_POSITION_RETENTION_HOURS,
      staleMaxAgeMinutes: num(input.staleMaxAgeMinutes) ?? DEFAULT_STALE_MAX_AGE_MINUTES,
      history: {
        enabled: hours > 0,
        providerId: str(instrumentLog.providerId) || str(history.providerId),
        resolutionSeconds,
        timeoutMs: HISTORY_TIMEOUT_MS,
      },
      track: {
        detailMeters: Math.max(
          1,
          num(track.detailMeters) ?? num(track.detailMetres) ?? DEFAULT_TRACK_DETAIL_METERS,
        ),
      },
      notifyAfterFailureMinutes:
        zeroOrMore(notifications.warnAfterMinutes) ??
        zeroOrMore(input.notifyAfterFailureMinutes) ??
        DEFAULT_NOTIFY_AFTER_FAILURE_MINUTES,
      publishNotifications:
        (notifications.publish ?? input.publishNotifications) !== false,
      // No fallback to the default when the box is empty. For the captured
      // instrument paths an empty list means "nothing would be logged", so
      // the default stands in; for a blacklist it means "publish all of
      // them", which is a choice the adopter is allowed to make.
      notificationExclude: notificationExclude(notifications, input),
      site: {
        url: siteUrlResult.url,
        logo: logoResult.logo,
        icon: iconResult.icon,
        customLinks,
        tideStationOverride: bool(overrides.overrideTideStation)
          ? str(overrides.tideStation)
          : '',
      },
    },
  };
}
