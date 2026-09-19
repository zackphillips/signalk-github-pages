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
 * on a Raspberry Pi: a two-minute cadence underway, hourly at the dock, a
 * 24-hour position window and a five-hour instrument log. They are a working
 * configuration for any boat, so a fresh install publishes without a setup
 * session.
 *
 * What is *not* defaulted is anything that belongs to one particular boat:
 * privacy zones start empty, the timezone follows the server, and the repo,
 * the token and the vessel's identifiers have no stand-in. Guessing at a
 * privacy zone would be worse than having none.
 */

export interface PrivacyZone {
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
}

/** A fully resolved configuration: every required value present. */
export interface PluginConfig {
  github: {
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
  buildDocsIndex: boolean;
  publishFrontend: boolean;
  site: {
    theme: string;
    marinetrafficShipId: string;
    postgsailLogsUrl: string;
    uscgNumber: string;
    hullNumber: string;
    extraYaml: string;
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
/** Rolling length of the instrument log — about five hours at 120 s. */
export const DEFAULT_INSTRUMENT_LOG_ENTRIES = 120;
/** How long raw positions stay in `positions_index.json`. */
export const DEFAULT_POSITION_RETENTION_HOURS = 24;
/** Values older than this are dropped from the published snapshot. */
export const DEFAULT_STALE_MAX_AGE_MINUTES = 60;

export const configSchema = {
  type: 'object',
  required: ['github'],
  properties: {
    github: {
      type: 'object',
      title: 'GitHub repository',
      required: ['repo', 'token'],
      properties: {
        repo: {
          type: 'string',
          title: 'Repository (owner/name)',
          description:
            'The repository GitHub Pages serves, e.g. "yourname/yourname.github.io".',
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
          description:
            'Fine-grained PAT with Contents: read/write on this repository only. ' +
            'Signal K stores plugin configuration as plain JSON on disk, so this ' +
            'token is readable by anyone with a shell on the server — scope it to ' +
            'the one repository and nothing else.',
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
      title: 'Track timezone (IANA)',
      description:
        'Calendar day used to group GPX tracks. Stored timestamps are UTC; ' +
        'grouping by UTC date splits a voyage mid-afternoon on the US west ' +
        'coast. Leave blank to group by UTC.',
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
            'One Signal K path per line. "*" matches one path segment, so ' +
            'electrical.batteries.*.voltage covers every bank. Lines starting ' +
            'with # are comments. This list is the entire bandwidth cost of a ' +
            'cycle: every path here is uploaded, for every entry, on every ' +
            'publish. Trim it to what you actually look at.',
          default: DEFAULT_INSTRUMENT_LOG_PATHS.join('\n'),
        },
        entries: {
          type: 'number',
          title: 'Entries retained',
          description:
            'Rolling length of instrument_log.json — 120 entries is about five ' +
            'hours at a two-minute cadence. The frontend is told this number, ' +
            'so the sparklines and the publisher cannot drift apart.',
          default: DEFAULT_INSTRUMENT_LOG_ENTRIES,
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
        postgsailLogsUrl: {
          type: 'string',
          title: 'PostgSail logs URL',
          default: '',
        },
        uscgNumber: { type: 'string', title: 'USCG documentation number', default: '' },
        hullNumber: { type: 'string', title: 'Hull number (HIN)', default: '' },
        extraYaml: {
          type: 'string',
          title: 'Extra site fields (YAML)',
          description:
            'Free-form YAML merged into data/vessel/info.yaml, for anything the ' +
            'frontend reads that this page does not cover. A key here overrides ' +
            'the value the plugin would have written, which is logged when it ' +
            'happens. Your passage: block is never touched — it stays in the ' +
            'published file and is preserved on every rewrite. Invalid YAML is ' +
            'logged and skipped; it never stops a publish.',
          default: '',
        },
      },
    },
  },
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

export interface ResolvedConfig {
  ok: true;
  config: PluginConfig;
}

export interface UnresolvedConfig {
  ok: false;
  /** One line per missing or invalid setting, in the order of the form. */
  problems: string[];
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
  const site = input.site ?? {};
  const problems: string[] = [];

  const repo = str(github.repo);
  if (!repo) problems.push('GitHub repository (owner/name) is not set.');
  else if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
    problems.push(`GitHub repository must be "owner/name", got "${repo}".`);

  const token = typeof github.token === 'string' ? github.token.trim() : '';
  if (!token) problems.push('GitHub personal access token is not set.');

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

  if (problems.length) return { ok: false, problems };

  const paths = parsePathList(instrumentLog.paths);

  return {
    ok: true,
    config: {
      github: { repo, branch: str(github.branch) || 'main', token },
      interval: {
        underway: num(interval.underway) ?? DEFAULT_INTERVAL_UNDERWAY,
        stationary: num(interval.stationary) ?? DEFAULT_INTERVAL_STATIONARY,
      },
      privacyZones: zones,
      timezone: str(input.timezone),
      instrumentLog: {
        paths: paths.length ? paths : DEFAULT_INSTRUMENT_LOG_PATHS,
        entries: Math.max(
          1,
          Math.floor(num(instrumentLog.entries) ?? DEFAULT_INSTRUMENT_LOG_ENTRIES),
        ),
      },
      positionRetentionHours:
        num(input.positionRetentionHours) ?? DEFAULT_POSITION_RETENTION_HOURS,
      staleMaxAgeMinutes: num(input.staleMaxAgeMinutes) ?? DEFAULT_STALE_MAX_AGE_MINUTES,
      buildDocsIndex: input.buildDocsIndex !== false,
      publishFrontend: input.publishFrontend !== false,
      site: {
        theme: SITE_THEMES.includes(str(site.theme)) ? str(site.theme) : DEFAULT_THEME,
        marinetrafficShipId: str(site.marinetrafficShipId),
        postgsailLogsUrl: str(site.postgsailLogsUrl),
        uscgNumber: str(site.uscgNumber),
        hullNumber: str(site.hullNumber),
        extraYaml: typeof site.extraYaml === 'string' ? site.extraYaml : '',
      },
    },
  };
}
