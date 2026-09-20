/**
 * Plugin configuration: the JSON Schema the Signal K admin UI renders, the
 * TypeScript shape it produces, and the resolver that turns a filled-in form
 * into values the rest of the plugin can rely on.
 *
 * The config page is the only place any of this is set. There is no YAML to
 * hand-edit and no wizard to run: `data/vessel/info.yaml` in the published
 * repo is an *output* of this file, written for the frontend to read.
 *
 * Defaults are the values the tracker has run on since it was a Python daemon
 * on a Raspberry Pi: a two-minute cadence underway, hourly at the dock and a
 * 24-hour position window, plus an hour of instrument history at one-minute
 * buckets, which is exactly what the sparklines draw. They are a working
 * configuration for any boat, so a fresh install publishes without a setup
 * session.
 *
 * What is *not* defaulted is anything that belongs to one particular boat:
 * privacy zones start empty, the timezone starts at UTC, and the repo and the
 * token have no stand-in. Guessing at a privacy zone would be worse than
 * having none, and a guessed timezone splits tracks on the wrong midnight —
 * so the timezone field names the zone the server is set to and lets you pick
 * it, rather than picking it for you.
 *
 * The vessel's own details — name, MMSI, callsign, registrations, dimensions —
 * are not on this page at all: they are read from the Signal K tree, which is
 * where the server already keeps them. The fields here are fallbacks for what
 * a server does not carry. The polar table is not here either: it belongs to
 * the Polar Management plugin, and this one publishes whichever polar that
 * plugin has made active.
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
  interval: {
    underway: number;
    stationary: number;
  };
  privacyZones: PrivacyZone[];
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
   * The fallback polar table, exactly as it was typed on the config page.
   * Used only when the server has no polar to give; see `polars.ts`.
   */
  polars: string;
  buildDocsIndex: boolean;
  publishFrontend: boolean;
  site: {
    theme: string;
    marinetrafficShipId: string;
    /** Extra buttons in the site's link row, in the order they appear. */
    customLinks: CustomLink[];
    uscgNumber: string;
    hullNumber: string;
    /**
     * Where the site looks before it has a fix: the tide station it picks and
     * the map it opens on. Null means it waits for one — the tide and forecast
     * panels say so rather than showing some other coast's numbers.
     */
    defaultLocation: { lat: number; lon: number; label: string } | null;
  };
}

/** Theme names understood by the frontend's `constants.js`. */
// Only these four exist in the bundled styles.css. An earlier, longer list
// came from a stale comment in one boat's info.yaml; picking one of those
// names left the page unstyled.
export const SITE_THEMES = ['marine', 'mermug', 'bright', 'dark'];
export const DEFAULT_THEME = 'marine';

/**
 * Default `instrumentLog.paths`: what the bundled sparklines draw.
 *
 * A path no instrument produces costs nothing — it simply never appears in the
 * log — so this list is safe to ship. What it is not is a list to leave alone
 * forever: every path here is recorded for every entry and re-uploaded on
 * every publish, so trimming it to what you actually look at is the single
 * biggest thing you can do for a cellular data plan.
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

/** Cadence while `navigation.state` says the boat is moving, in seconds. */
export const DEFAULT_INTERVAL_UNDERWAY = 120;
/** Cadence while moored, anchored, or state unknown, in seconds. */
export const DEFAULT_INTERVAL_STATIONARY = 3600;
/**
 * Rolling length of the instrument log, in buckets.
 *
 * 60 is what the frontend's `SPARKLINE_POINTS` draws: it takes the last 60
 * entries and ignores the rest, so a longer log is bytes uploaded on every
 * publish that nothing has ever plotted. At the default 60 s resolution this
 * is the last hour.
 */
export const DEFAULT_INSTRUMENT_LOG_ENTRIES = 60;
/** How long raw positions stay in `positions_index.json`. */
export const DEFAULT_POSITION_RETENTION_HOURS = 24;
/** Values older than this are dropped from the published snapshot. */
export const DEFAULT_STALE_MAX_AGE_MINUTES = 60;
/**
 * Bucket width asked of the history provider, in seconds.
 *
 * One minute is finer than any publish cadence, so the sparklines gain detail
 * rather than just surviving restarts, and it is the spacing of the published
 * log: `resolutionSeconds x entries` is how far back the graphs go.
 */
export const DEFAULT_HISTORY_RESOLUTION_SECONDS = 60;
/** A history query is a database call; past this it is a skipped cycle. */
export const DEFAULT_HISTORY_TIMEOUT_MS = 20_000;

/** Read once: the list is the same for every field that shows it. */
const TIMEZONES = availableTimezones();

/**
 * What to tick when making the token, in the description under the field.
 *
 * Two of these are worth the words they cost: "Contents: read and write" is
 * the permission people miss (a token with only Metadata reads fine and fails
 * the first commit with a 403), and the organisation approval step is
 * invisible until a publish 404s on a repository that plainly exists.
 */
export const PAT_GUIDANCE =
  'Fine-grained token (Settings > Developer settings > Personal access tokens > ' +
  'Fine-grained tokens): set Repository access to "Only select repositories" and ' +
  'pick this one, then under Repository permissions set Contents to "Read and ' +
  'write". Metadata: Read-only is added automatically; nothing else is needed. ' +
  'A repository owned by an organisation also needs an organisation owner to ' +
  'approve the token before it works. Classic token alternative: the "repo" ' +
  'scope, or "public_repo" if the repository is public. The token stops working ' +
  'on its expiry date: publishing then fails with HTTP 401 until you issue a ' +
  'new one. Signal K stores plugin configuration as plain JSON on disk, so this ' +
  'token is readable by anyone with a shell on the server: scope it to the one ' +
  'repository and nothing else.';

/**
 * The polar field's help text when the plugin has not yet looked.
 *
 * `buildConfigSchema` replaces it with what the last cycle actually found, so
 * the page tells you whether this box is in use rather than leaving you to
 * guess which of two plugins the chart is coming from.
 */
export const POLARS_FIELD_DESCRIPTION =
  'Used only when the server has no polar of its own. Manage polars in the ' +
  'Polar Management plugin where you can: it imports from ORC by boat name or ' +
  'sail number, and this plugin publishes whichever one you make active. ' +
  'Paste a table here for a boat whose polar is on paper: first line the true ' +
  'wind speeds in knots, then one line per true wind angle in degrees ' +
  'followed by the target boat speeds. Semicolons, commas, tabs or spaces all ' +
  'work, and # starts a comment.';

/** What the last cycle found, for the note under the polar field. */
export interface PolarStatus {
  source: 'resource' | 'config' | 'none';
  /** Human summary, e.g. `"mermug-orc" from Polar Management, 18 angle(s)...`. */
  summary: string;
  problems: string[];
}

/**
 * The config schema, with the polar field's description rewritten to say what
 * the plugin is actually publishing.
 *
 * Signal K calls `plugin.schema()` when the page is opened, so this runs then,
 * not at install: open the page after changing the active polar and the note
 * is current.
 */
export function buildConfigSchema(polar?: PolarStatus | null): typeof configSchema {
  if (!polar) return configSchema;
  const note =
    polar.source === 'resource'
      ? `In use: ${polar.summary}. This box is ignored while that holds — clear ` +
        'the active polar in Polar Management to fall back to it.'
      : polar.source === 'config'
        ? `In use: ${polar.summary}. No polar is active on the server, so this ` +
          'box is what the chart draws.'
        : `Nothing is being published: ${polar.summary}.`;
  const problems = polar.problems.length ? ` Last cycle reported: ${polar.problems.join(' ')}` : '';
  return {
    ...configSchema,
    properties: {
      ...configSchema.properties,
      polars: {
        ...configSchema.properties.polars,
        description: `${note}${problems}\n\n${POLARS_FIELD_DESCRIPTION}`,
      },
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
      required: ['owner', 'name', 'token'],
      properties: {
        owner: {
          type: 'string',
          title: 'Repository owner',
          description:
            'The GitHub user or organisation that owns the repository — your ' +
            'username for a personal site, e.g. "yourname".',
        },
        name: {
          type: 'string',
          title: 'Repository name',
          description:
            'The repository GitHub Pages serves, without the owner: ' +
            '"yourname.github.io" for a user site, or e.g. "tracker" for a ' +
            'project site served at /tracker/.',
        },
        branch: {
          type: 'string',
          title: 'Branch',
          description: 'Branch Pages publishes from.',
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
        underway: {
          type: 'number',
          title: 'Underway interval (seconds)',
          description:
            'Used when navigation.state is sailing or motoring. Each publish ' +
            'costs the size of the changed files, uploaded in full.',
          default: DEFAULT_INTERVAL_UNDERWAY,
        },
        stationary: {
          type: 'number',
          title: 'Stationary interval (seconds)',
          description: 'Used when moored, anchored, or the state is unknown.',
          default: DEFAULT_INTERVAL_STATIONARY,
        },
      },
    },
    privacyZones: {
      type: 'array',
      title: 'Privacy zones',
      description:
        'Positions inside any of these circles are redacted before they are ' +
        'stored or published: the zone centre is shown instead, and the point ' +
        'is left out of the GPX track entirely. Empty means nothing is hidden.',
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
      type: 'string',
      title: 'Track timezone',
      description:
        'Calendar day used to group GPX tracks. Stored timestamps are UTC; ' +
        'grouping by UTC date splits a voyage mid-afternoon on the US west ' +
        `coast. This server is set to ${serverTimezone()}. Leave on UTC to ` +
        'group by the UTC day.',
      enum: ['', ...TIMEZONES],
      enumNames: ['UTC (no local grouping)', ...TIMEZONES],
      default: '',
    },
    instrumentLog: {
      type: 'object',
      title: 'Instrument log (sparklines)',
      properties: {
        paths: {
          type: 'string',
          title: 'Captured paths',
          description:
            'One Signal K path per line — what is asked of the history ' +
            'provider. "*" matches one path segment, so ' +
            'electrical.batteries.*.voltage covers every bank the provider has ' +
            'stored. Lines starting with # are comments. This list is the ' +
            'entire bandwidth cost of a cycle: every path here is uploaded, ' +
            'for every entry, on every publish. Trim it to what you actually ' +
            'look at. navigation.position is never asked for — the track comes ' +
            'from the boat, through the privacy zones.',
          default: DEFAULT_INSTRUMENT_LOG_PATHS.join('\n'),
        },
        entries: {
          type: 'number',
          title: 'Entries retained',
          description:
            'Rolling length of instrument_log.json, and the query window: the ' +
            'log covers entries x resolution, so 60 entries at 60 s is the ' +
            'last hour. The bundled sparklines draw the last 60 points, so ' +
            'more than that is uploaded on every publish and never plotted.',
          default: DEFAULT_INSTRUMENT_LOG_ENTRIES,
        },
      },
    },
    history: {
      type: 'object',
      title: 'History provider (sparklines)',
      description:
        'Where the instrument log comes from. A server with a history ' +
        'provider installed (signalk-to-influxdb2, for example) already ' +
        'stores every value at full rate, so the sparklines are read back ' +
        'from it on every cycle and survive a restart, a reinstall or a ' +
        'stopped plugin. With no provider registered the site has no ' +
        'sparklines: the panels show current values and omit the graphs. The ' +
        'map track does not come from here — it is always the plugin\'s own.',
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
            "Leave blank to use the server's default history provider. Set it " +
            'to a plugin id (e.g. "signalk-to-influxdb2") only when more than ' +
            'one is registered and you want this one.',
          default: '',
        },
        resolutionSeconds: {
          type: 'number',
          title: 'Resolution (seconds)',
          description:
            'Bucket width asked of the provider, and the spacing of the ' +
            'published log: it covers resolution x entries, so 60 s x 60 ' +
            'entries is the last hour. Finer buckets mean a bigger file ' +
            'uploaded on every publish.',
          default: DEFAULT_HISTORY_RESOLUTION_SECONDS,
        },
        timeoutMs: {
          type: 'number',
          title: 'Query timeout (ms)',
          description:
            'A history query reaches a database. Past this the cycle gives up ' +
            'on it and publishes no instrument log at all, leaving the copy ' +
            'already on the site in place until the provider answers again.',
          default: DEFAULT_HISTORY_TIMEOUT_MS,
        },
      },
    },
    positionRetentionHours: {
      type: 'number',
      title: 'Position retention (hours)',
      description:
        'How long raw positions stay in positions_index.json — the map track. ' +
        'Past days survive as GPX regardless.',
      default: DEFAULT_POSITION_RETENTION_HOURS,
    },
    staleMaxAgeMinutes: {
      type: 'number',
      title: 'Stale value cutoff (minutes)',
      description:
        'Values older than this are dropped from the published snapshot so the ' +
        'site shows them as unavailable rather than as current.',
      default: DEFAULT_STALE_MAX_AGE_MINUTES,
    },
    polars: {
      type: 'string',
      title: 'Polar table (fallback)',
      description: POLARS_FIELD_DESCRIPTION,
      default: '',
    },
    buildDocsIndex: {
      type: 'boolean',
      title: "Maintain docs/index.json",
      description:
        "Rebuild the ship's-docs manifest when the docs tree changes. Turn this " +
        'off if you run the docs-index GitHub Action instead.',
      default: true,
    },
    publishFrontend: {
      type: 'boolean',
      title: 'Publish the site frontend',
      description:
        'Write the bundled HTML/CSS/JS into the repository on start and after a ' +
        'plugin upgrade. Turn off only if you maintain your own frontend.',
      default: true,
    },
    site: {
      type: 'object',
      title: 'Site details',
      description:
        "The vessel's own details are not here: name, MMSI, callsign, " +
        'registrations and dimensions are read from the Signal K tree every ' +
        'cycle and written into data/vessel/info.yaml. These are the fields ' +
        'that belong to the site, plus fallbacks for what a server does not ' +
        'carry.',
      properties: {
        theme: {
          type: 'string',
          title: 'Theme',
          enum: SITE_THEMES,
          default: DEFAULT_THEME,
        },
        marinetrafficShipId: {
          type: 'string',
          title: 'MarineTraffic ship ID',
          default: '',
        },
        customLinks: {
          type: 'array',
          title: 'Custom buttons',
          description:
            'Buttons added to the link row at the top of the site, in this ' +
            'order — a PostgSail log, a Starlink status page, a crew ' +
            'handbook, anything with a URL. Only http:// and https:// links ' +
            'are published.',
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
        uscgNumber: {
          type: 'string',
          title: 'USCG documentation number',
          description:
            'Only needed if your server does not carry it. The plugin reads ' +
            'registrations.national / .other out of the Signal K tree first; a ' +
            'value here overrides what it found, and the difference is logged.',
          default: '',
        },
        hullNumber: {
          type: 'string',
          title: 'Hull number (HIN)',
          description:
            'As above: read from the Signal K registrations when one looks like ' +
            'a hull identification number, and only typed here when it is not.',
          default: '',
        },
        defaultLocation: {
          type: 'object',
          title: 'Home waters',
          description:
            'Where the site looks before the boat has reported a position: the ' +
            'tide station it picks and the map it opens on. Leave the ' +
            'coordinates blank and the tide and forecast panels wait for a GPS ' +
            'fix instead — they will not stand in some other coast for yours.',
          properties: {
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
  polars: { 'ui:widget': 'textarea', 'ui:options': { rows: 12 } },
  instrumentLog: { paths: { 'ui:widget': 'textarea', 'ui:options': { rows: 12 } } },
};

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
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
 * Resolve the two repository fields.
 *
 * Two boxes rather than one `owner/name` box is mostly a usability change, but
 * it also removes the most common setup mistake: a value with no slash, or
 * with a whole GitHub URL in it, that failed only on the first publish. A
 * pasted URL or an `owner/name` in the owner box is split here rather than
 * rejected.
 */
export function resolveOwnerAndName(rawOwner: unknown, rawName: unknown): OwnerAndName {
  const problems: string[] = [];
  let owner = stripRepoUrl(str(rawOwner));
  let name = stripRepoUrl(str(rawName));

  // "owner/name" pasted into either box.
  if (owner.includes('/')) {
    const [first, ...rest] = owner.split('/');
    owner = first ?? '';
    if (!name) name = rest.join('/');
  }
  if (name.includes('/')) {
    const parts = name.split('/');
    name = parts[parts.length - 1] ?? '';
    if (!owner) owner = parts[0] ?? '';
  }

  if (!owner) {
    problems.push('GitHub repository owner is not set (your username, or the organisation).');
  } else if (!OWNER_PATTERN.test(owner)) {
    problems.push(`GitHub repository owner "${owner}" is not a GitHub username or organisation.`);
  }
  if (!name) {
    problems.push('GitHub repository name is not set (the repository, without the owner).');
  } else if (!NAME_PATTERN.test(name)) {
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
 * The home-waters coordinates, or null.
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

  const underway = num(interval.underway) ?? DEFAULT_INTERVAL_UNDERWAY;
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
        stationary: num(interval.stationary) ?? DEFAULT_INTERVAL_STATIONARY,
      },
      privacyZones: zones,
      timezone: str(input.timezone),
      instrumentLog: {
        paths: paths.length ? paths : DEFAULT_INSTRUMENT_LOG_PATHS,
        entries,
      },
      polars: typeof input.polars === 'string' ? input.polars : '',
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
      publishFrontend: input.publishFrontend !== false,
      site: {
        theme: SITE_THEMES.includes(str(site.theme)) ? str(site.theme) : DEFAULT_THEME,
        marinetrafficShipId: str(site.marinetrafficShipId),
        customLinks,
        uscgNumber: str(site.uscgNumber),
        hullNumber: str(site.hullNumber),
        defaultLocation: resolveDefaultLocation(site.defaultLocation),
      },
    },
  };
}
