/**
 * Plugin configuration: the JSON Schema the Signal K admin UI renders, the
 * TypeScript shape it produces, and the resolver that turns a filled-in form
 * into values the rest of the plugin can rely on.
 *
 * The config page is the only place any of this is set. `data/vessel/info.yaml`
 * in the published repo is an *output* of this file, written for the frontend
 * to read.
 *
 * Four settings are derived rather than typed: the repository name from the
 * owner, the track timezone from the server, the polar table from the Polar
 * Management plugin, and the USCG and hull numbers from the Signal K
 * registrations. Each one has an "Override" checkbox beside it that switches
 * the field from derived to typed. The derived value is what the plugin uses
 * whenever the box is unticked, whatever is sitting in the field.
 *
 * Defaults are the values this tracker has run on for years on a Raspberry
 * Pi. What is *not* defaulted is anything that belongs to one
 * particular boat: privacy zones start empty, and the repo and token have no
 * stand-in.
 */

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
    /** User or organisation. */
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
  buildDocsIndex: boolean;
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
  site: {
    /** Extra buttons in the site's link row, in the order they appear. */
    customLinks: CustomLink[];
    /** Ticked, the typed number wins over the Signal K registrations. */
    overrideUscgNumber: boolean;
    uscgNumber: string;
    overrideHullNumber: boolean;
    hullNumber: string;
    /**
     * Where the site looks before it has a fix: the tide station it picks and
     * the map it opens on. Null means it waits for one — the tide and forecast
     * panels say so rather than showing some other coast's numbers.
     */
    defaultLocation: { lat: number; lon: number; label: string } | null;
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
 * Rolling length of the instrument log, in buckets.
 *
 * At the default 60 s resolution this is the last hour, which is the shortest
 * window the site's history dropdown offers and the only one it can promise
 * on a default install. The frontend plots whatever it is given, so raising
 * this is what makes the 3, 12 and 24 hour windows selectable — at the cost
 * of uploading every entry in full on every publish. 24 hours at 60 s is 1440
 * entries, roughly half a megabyte a cycle: worth it on a dock, not on a
 * hotspot, which is why the default stays an hour and the choice is the
 * adopter's.
 */
export const DEFAULT_INSTRUMENT_LOG_ENTRIES = 60;
/** How long raw positions stay in `positions_index.json`. */
export const DEFAULT_POSITION_RETENTION_HOURS = 24;
/** Values older than this are dropped from the published snapshot. */
export const DEFAULT_STALE_MAX_AGE_MINUTES = 60;
/**
 * Bucket width asked of the history provider, in seconds.
 *
 * One minute is finer than any publish cadence, and it is the spacing of the
 * published log: `resolutionSeconds x entries` is how far back the graphs go.
 */
export const DEFAULT_HISTORY_RESOLUTION_SECONDS = 60;
/** A history query is a database call; past this it is a skipped cycle. */
export const DEFAULT_HISTORY_TIMEOUT_MS = 20_000;

/** Read once: the list is the same for every field that shows it. */
const TIMEZONES = availableTimezones();

/**
 * What to tick when making the token.
 *
 * Only what the token will not work without. "Contents: read and write" is the
 * permission people miss — a token with only Metadata reads fine and fails the
 * first commit with a 403 — and an organisation-owned repository needs an
 * owner to approve the token, which is invisible until a publish 404s on a
 * repository that plainly exists.
 */
export const PAT_GUIDANCE =
  'GitHub > Settings > Developer settings > Personal access tokens > Fine-grained ' +
  'tokens. Repository access: Only select repositories, this one. Repository ' +
  'permissions: Contents "Read and write". An organisation-owned repository also ' +
  'needs an organisation owner to approve the token.';

/**
 * The polar field's help text when the plugin has not yet looked.
 *
 * `buildConfigSchema` replaces it with what the last cycle actually found.
 */
export const POLARS_FIELD_DESCRIPTION =
  'The active polar from the Polar Management plugin. Tick Override polar to ' +
  'publish the table below instead: first line the true wind speeds in knots, ' +
  'then one line per true wind angle in degrees followed by the target boat ' +
  'speeds. Semicolons, commas, tabs or spaces all work, and # starts a comment.';

/** What the last cycle found, for the note under the polar field. */
export interface PolarStatus {
  source: 'resource' | 'config' | 'none';
  /** Human summary, e.g. `"mermug-orc" from Polar Management, 18 angle(s)...`. */
  summary: string;
  problems: string[];
}

/** What the plugin knows that the form does not, at the moment it is opened. */
export interface SchemaContext {
  /** `<owner>.github.io`, derived from the saved owner. */
  repoName?: string;
  /** What the last cycle resolved for the polar table. */
  polar?: PolarStatus | null;
  /** The active polar rendered as CSV, to show in the read-only box. */
  polarCsv?: string;
  /** The USCG documentation number read off the Signal K registrations. */
  uscgNumber?: string;
  /** Likewise the hull identification number. */
  hullNumber?: string;
}

/**
 * The config schema, with the derived fields prefilled from what the plugin
 * can see right now.
 *
 * Signal K calls `plugin.schema()` when the page is opened, so this runs then,
 * not at install: open the page after changing the active polar and the box
 * shows it.
 *
 * The prefilled values are JSON Schema `default`s, which the admin UI shows
 * only in a field the user has not filled in. They are cosmetic — `resolveConfig`
 * derives the same values itself and ignores the field whenever its override is
 * unticked — so a stale default can never become a published value.
 */
export function buildConfigSchema(context: SchemaContext = {}): typeof configSchema {
  const { repoName, polar, polarCsv, uscgNumber, hullNumber } = context;
  const schema = JSON.parse(JSON.stringify(configSchema)) as typeof configSchema;

  if (repoName) schema.properties.github.properties.name.default = repoName;

  if (polar) {
    const note =
      polar.source === 'resource'
        ? `Publishing ${polar.summary}.`
        : polar.source === 'config'
          ? `Publishing ${polar.summary}.`
          : `Publishing no polar: ${polar.summary}.`;
    const problems = polar.problems.length ? ` ${polar.problems.join(' ')}` : '';
    schema.properties.polars.properties.table.description =
      `${note}${problems}\n\n${POLARS_FIELD_DESCRIPTION}`;
  }
  if (polarCsv) schema.properties.polars.properties.table.default = polarCsv;
  if (uscgNumber) schema.properties.site.properties.uscgNumber.default = uscgNumber;
  if (hullNumber) schema.properties.site.properties.hullNumber.default = hullNumber;

  return schema;
}

/**
 * A derived field's "Override" checkbox, as a JSON Schema dependency.
 *
 * Unticked, the field goes read-only so the page shows what the plugin will
 * publish without inviting an edit that would be ignored. It is a `dependencies`
 * block rather than `if`/`then` because every version of react-json-schema-form
 * the Signal K admin UI has shipped understands one, and a renderer that
 * understands neither falls back to the plain editable field in `properties` —
 * a cosmetic loss, not a lost setting.
 */
function readOnlyUnless(flag: string, field: string) {
  return {
    [flag]: {
      oneOf: [
        {
          properties: {
            [flag]: { enum: [false] },
            [field]: { readOnly: true },
          },
        },
        { properties: { [flag]: { enum: [true] } } },
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
      required: ['owner', 'token'],
      dependencies: readOnlyUnless('overrideName', 'name'),
      properties: {
        owner: {
          type: 'string',
          title: 'Repository owner',
          description: 'Your GitHub username, or the organisation that owns the repository.',
        },
        overrideName: {
          type: 'boolean',
          title: 'Override repository name',
          description: 'Publish to a repository other than <owner>.github.io.',
          default: false,
        },
        name: {
          type: 'string',
          title: 'Repository name',
          description:
            'Defaults to <owner>.github.io, the user site. A project site — e.g. ' +
            '"tracker", served at /tracker/ — needs the override.',
          default: '',
        },
        branch: {
          type: 'string',
          title: 'Branch',
          description: 'Branch GitHub Pages publishes from.',
          default: 'main',
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
        'Positions inside any of these circles are published as the zone centre ' +
        'and left out of the GPX track. Empty means nothing is hidden.',
      items: {
        type: 'object',
        required: ['lat', 'lon', 'radius_m'],
        properties: {
          name: { type: 'string', title: 'Name' },
          lat: { type: 'number', title: 'Latitude' },
          lon: { type: 'number', title: 'Longitude' },
          radius_m: { type: 'number', title: 'Radius (metres)' },
        },
      },
      default: [],
    },
    timezone: {
      type: 'object',
      title: 'Track timezone',
      description: `Calendar day GPX tracks are grouped by. This server is set to ${serverTimezone()}.`,
      dependencies: readOnlyUnless('override', 'zone'),
      properties: {
        override: {
          type: 'boolean',
          title: 'Override timezone',
          description: "Group tracks by a zone other than the server's.",
          default: false,
        },
        zone: {
          type: 'string',
          enum: ['UTC', ...TIMEZONES],
          enumNames: ['UTC', ...TIMEZONES],
          title: 'Timezone',
          default: serverTimezone(),
        },
      },
    },
    instrumentLog: {
      type: 'object',
      title: 'Instrument log (sparklines)',
      properties: {
        paths: {
          type: 'string',
          title: 'Captured paths',
          description:
            'One Signal K path per line, asked of the history provider. "*" matches ' +
            'one path segment. Lines starting with # are comments. Every path here is ' +
            'uploaded for every entry on every publish. navigation.position is never ' +
            'asked for: the track comes from the boat, through the privacy zones.',
          default: DEFAULT_INSTRUMENT_LOG_PATHS.join('\n'),
        },
        entries: {
          type: 'number',
          title: 'Entries retained',
          description:
            'Rolling length of instrument_log.json, and the query window: the log ' +
            'covers entries x resolution, which is also what the site’s history ' +
            'dropdown can offer. 60 entries at 60 s is one hour; 24 hours needs 1440 ' +
            'and uploads about half a megabyte on every publish.',
          default: DEFAULT_INSTRUMENT_LOG_ENTRIES,
        },
      },
    },
    history: {
      type: 'object',
      title: 'History provider (sparklines)',
      description:
        'Where the instrument log comes from. With a history provider installed ' +
        '(signalk-to-influxdb2, for example) the sparklines are read back from it ' +
        'every cycle; with none the site shows current values and omits the graphs. ' +
        "The map track does not come from here — it is always the plugin's own.",
      properties: {
        enabled: {
          type: 'boolean',
          title: 'Read the instrument log from a history provider',
          default: true,
        },
        providerId: {
          type: 'string',
          title: 'Provider plugin id',
          description:
            "Blank uses the server's default provider. Set a plugin id (e.g. " +
            '"signalk-to-influxdb2") when more than one is registered.',
          default: '',
        },
        resolutionSeconds: {
          type: 'number',
          title: 'Resolution (seconds)',
          description:
            'Bucket width asked of the provider, and the spacing of the published log.',
          default: DEFAULT_HISTORY_RESOLUTION_SECONDS,
        },
        timeoutMs: {
          type: 'number',
          title: 'Query timeout (ms)',
          description:
            'Past this the cycle publishes no instrument log and leaves the copy ' +
            'already on the site in place.',
          default: DEFAULT_HISTORY_TIMEOUT_MS,
        },
      },
    },
    positionRetentionHours: {
      type: 'number',
      title: 'Position retention (hours)',
      description:
        'How long raw positions stay in positions_index.json — the map track. Past ' +
        'days survive as GPX regardless.',
      default: DEFAULT_POSITION_RETENTION_HOURS,
    },
    staleMaxAgeMinutes: {
      type: 'number',
      title: 'Stale value cutoff (minutes)',
      description:
        'Values older than this are dropped from the published snapshot, so the site ' +
        'shows them as unavailable rather than as current.',
      default: DEFAULT_STALE_MAX_AGE_MINUTES,
    },
    polars: {
      type: 'object',
      title: 'Polar table',
      dependencies: readOnlyUnless('override', 'table'),
      properties: {
        override: {
          type: 'boolean',
          title: 'Override polar',
          description: 'Publish the table below instead of the active polar.',
          default: false,
        },
        table: {
          type: 'string',
          title: 'Polar table',
          description: POLARS_FIELD_DESCRIPTION,
          default: '',
        },
      },
    },
    buildDocsIndex: {
      type: 'boolean',
      title: 'Maintain docs/index.json',
      description:
        "Rebuild the ship's-docs manifest when the docs tree changes. Turn off if you " +
        'run the docs-index GitHub Action instead.',
      default: true,
    },
    publishNotifications: {
      type: 'boolean',
      title: 'Publish notifications',
      description:
        'Publish active Signal K notifications and how often each one has fired over ' +
        'the last 24 hours. Notification messages are free text from whichever plugin ' +
        'raised them and are published verbatim — turn this off if yours say anything ' +
        'you would not put on a public page.',
      default: true,
    },
    site: {
      type: 'object',
      title: 'Site details',
      description:
        'Name, MMSI, callsign, registrations and dimensions are read from the Signal K ' +
        'tree every cycle and written into data/vessel/info.yaml.',
      dependencies: {
        ...readOnlyUnless('overrideUscgNumber', 'uscgNumber'),
        ...readOnlyUnless('overrideHullNumber', 'hullNumber'),
      },
      properties: {
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
        overrideUscgNumber: {
          type: 'boolean',
          title: 'Override USCG documentation number',
          default: false,
        },
        uscgNumber: {
          type: 'string',
          title: 'USCG documentation number',
          description: 'Read from the Signal K registrations.',
          default: '',
        },
        overrideHullNumber: {
          type: 'boolean',
          title: 'Override hull number',
          default: false,
        },
        hullNumber: {
          type: 'string',
          title: 'Hull number (HIN)',
          description: 'Read from the Signal K registrations.',
          default: '',
        },
        defaultLocation: {
          type: 'object',
          title: 'Default position',
          description:
            'Where the site looks before the boat has reported a position: the tide ' +
            'station it picks and the map it opens on. Blank coordinates mean the tide ' +
            'and forecast panels wait for a fix.',
          properties: {
            useCurrentPosition: {
              type: 'boolean',
              title: 'Set to the current position',
              description:
                'Fills the coordinates below from navigation.position and unticks ' +
                'itself. Takes effect when the plugin restarts on save.',
              default: false,
            },
            lat: { type: 'number', title: 'Latitude' },
            lon: { type: 'number', title: 'Longitude' },
            label: { type: 'string', title: 'Label', default: '' },
          },
        },
      },
    },
  },
};

/** Admin-UI hints: which boxes are passwords, and which are textareas. */
export const configUiSchema = {
  github: { token: { 'ui:widget': 'password' } },
  polars: { table: { 'ui:widget': 'textarea', 'ui:options': { rows: 12 } } },
  instrumentLog: { paths: { 'ui:widget': 'textarea', 'ui:options': { rows: 12 } } },
};

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
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

/** GitHub's own rule for a user or organisation name. */
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
    problems.push('GitHub repository owner is not set (your username, or the organisation).');
  } else if (!OWNER_PATTERN.test(owner)) {
    problems.push(`GitHub repository owner "${owner}" is not a GitHub username or organisation.`);
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
 * `info.yaml` and the frontend assigns the URL straight to `href`, so a
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
 * The default-position coordinates, or null.
 *
 * Both halves or neither: a latitude with no longitude is not a place, and
 * sending half a fix to the tide-station lookup would land the panel somewhere
 * in the ocean rather than falling back to the frontend's default.
 */
export function resolveDefaultLocation(
  value: unknown,
): { lat: number; lon: number; label: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { lat, lon, label } = value as Record<string, unknown>;
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { lat: latitude, lon: longitude, label: str(label) };
}

/** The track timezone: the server's, unless the override is ticked. */
export function resolveTimezone(value: unknown): string {
  if (value && typeof value === 'object') {
    const { override, zone } = value as Record<string, unknown>;
    if (override === true) return str(zone) || serverTimezone();
  }
  return serverTimezone();
}

/** The polar table override: whether it is on, and what is in the box. */
export function resolvePolars(value: unknown): { override: boolean; table: string } {
  if (value && typeof value === 'object') {
    const { override, table } = value as Record<string, unknown>;
    return {
      override: bool(override),
      table: typeof table === 'string' ? table : '',
    };
  }
  return { override: false, table: '' };
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
  const history = input.history ?? {};
  const site = input.site ?? {};
  const problems: string[] = [];

  const warnings: string[] = [];

  const { owner, name, problems: repoProblems } = resolveOwnerAndName(
    github.owner,
    github.name,
    bool(github.overrideName),
  );
  problems.push(...repoProblems);

  const token = typeof github.token === 'string' ? github.token.trim() : '';
  if (!token) problems.push('GitHub personal access token is not set.');
  else {
    const warning = tokenWarning(token);
    if (warning) warnings.push(warning);
  }

  const customLinkResult = resolveCustomLinks(site.customLinks);
  const customLinks = customLinkResult.links;
  warnings.push(...customLinkResult.warnings);

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
        'longitude and a radius in metres) and would hide nothing.',
    );
  }

  if (problems.length) return { ok: false, problems, warnings };

  const paths = parsePathList(instrumentLog.paths);

  const underway = intervalSeconds(interval.underwayMinutes, DEFAULT_INTERVAL_UNDERWAY);
  const resolutionSeconds =
    num(history.resolutionSeconds) ?? DEFAULT_HISTORY_RESOLUTION_SECONDS;
  const entries = Math.max(
    1,
    Math.floor(num(instrumentLog.entries) ?? DEFAULT_INSTRUMENT_LOG_ENTRIES),
  );
  if (history.enabled !== false && resolutionSeconds * entries < underway) {
    // The log would not even span one publish interval, so every cycle would
    // publish a graph with no overlap with the last one. Neither field looks
    // wrong on its own, which is why this is worth saying.
    warnings.push(
      `The instrument log covers ${Math.round((resolutionSeconds * entries) / 60)} min ` +
        `(${Math.round(resolutionSeconds)}s x ${entries} entries), less than the ` +
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
        branch: str(github.branch) || 'main',
        token,
      },
      interval: {
        underway,
        stationary: intervalSeconds(interval.stationaryMinutes, DEFAULT_INTERVAL_STATIONARY),
      },
      privacyZones: zones,
      timezone: resolveTimezone(input.timezone),
      instrumentLog: {
        paths: paths.length ? paths : DEFAULT_INSTRUMENT_LOG_PATHS,
        entries,
      },
      polars: resolvePolars(input.polars),
      positionRetentionHours:
        num(input.positionRetentionHours) ?? DEFAULT_POSITION_RETENTION_HOURS,
      staleMaxAgeMinutes: num(input.staleMaxAgeMinutes) ?? DEFAULT_STALE_MAX_AGE_MINUTES,
      history: {
        enabled: history.enabled !== false,
        providerId: str(history.providerId),
        resolutionSeconds: Math.max(1, Math.round(resolutionSeconds)),
        timeoutMs: Math.max(
          1000,
          Math.round(num(history.timeoutMs) ?? DEFAULT_HISTORY_TIMEOUT_MS),
        ),
      },
      buildDocsIndex: input.buildDocsIndex !== false,
      publishNotifications: input.publishNotifications !== false,
      site: {
        customLinks,
        overrideUscgNumber: bool(site.overrideUscgNumber),
        uscgNumber: str(site.uscgNumber),
        overrideHullNumber: bool(site.overrideHullNumber),
        hullNumber: str(site.hullNumber),
        defaultLocation: resolveDefaultLocation(site.defaultLocation),
      },
    },
  };
}
