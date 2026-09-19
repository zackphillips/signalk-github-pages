/**
 * Plugin configuration: the JSON Schema the Signal K admin UI renders, the
 * TypeScript shape it produces, and the normaliser that turns a partially
 * filled form into values the rest of the plugin can rely on.
 *
 * The config page is the only place any of this is set. There is no YAML to
 * hand-edit and no wizard to run: `data/vessel/info.yaml` in the published
 * repo is an *output* of this file, written for the frontend to read.
 */

export interface PrivacyZone {
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
}

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
  };
}

/** Cadence while `navigation.state` says the boat is moving, in seconds. */
export const DEFAULT_INTERVAL_UNDERWAY = 120;
/** Cadence while moored, anchored, or state unknown, in seconds. */
export const DEFAULT_INTERVAL_STATIONARY = 3600;
/** Rolling length of `instrument_log.json`; the frontend reads the same number. */
export const DEFAULT_INSTRUMENT_LOG_ENTRIES = 120;
/** How long raw positions stay in `positions_index.json`. */
export const DEFAULT_POSITION_RETENTION_HOURS = 24;
/** Values older than this are dropped from the published snapshot. */
export const DEFAULT_STALE_MAX_AGE_MINUTES = 60;

/**
 * Default instrument-log allowlist: the paths the sparklines actually draw.
 *
 * The Python daemon logged every numeric leaf in the self tree — ~167 paths
 * per entry, a ~1 MB file republished every two minutes. `git push` sent a
 * delta; the Git Data API uploads the whole blob, so the unfiltered file is a
 * real regression over a cellular hotspot. Capturing only what the frontend
 * draws takes an order of magnitude off it. Add paths here (or in the config
 * page) if you add a sparkline.
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

/** Theme names understood by the frontend's `constants.js`. */
export const SITE_THEMES = [
  'mermug',
  'light',
  'dark',
  'deep-sea',
  'starboard',
  'port-light',
  'midnight-watch',
  'chart-room',
  'fog-bank',
  'overcast',
  'coral',
  'kelp',
  'dusk',
];

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
          default: '',
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
          default: '',
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
          description: 'Used when navigation.state is sailing or motoring.',
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
        'is left out of the GPX track entirely. Empty by default.',
      items: {
        type: 'object',
        required: ['lat', 'lon', 'radius_m'],
        properties: {
          name: { type: 'string', title: 'Name', default: '' },
          lat: { type: 'number', title: 'Latitude' },
          lon: { type: 'number', title: 'Longitude' },
          radius_m: { type: 'number', title: 'Radius (metres)', default: 200 },
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
        'coast. Leave blank to use the server timezone.',
      default: '',
    },
    instrumentLog: {
      type: 'object',
      title: 'Instrument log (sparklines)',
      properties: {
        paths: {
          type: 'array',
          title: 'Captured paths',
          description:
            'Allowlist of Signal K paths recorded each cycle. "*" matches one ' +
            'path segment, so electrical.batteries.*.voltage covers every bank. ' +
            'Keep this tight: every path costs bandwidth on every publish.',
          items: { type: 'string' },
          default: DEFAULT_INSTRUMENT_LOG_PATHS,
        },
        entries: {
          type: 'number',
          title: 'Entries retained',
          description:
            'Rolling length of instrument_log.json. Must match ' +
            'INSTRUMENT_LOG_ENTRIES in the frontend constants.',
          default: DEFAULT_INSTRUMENT_LOG_ENTRIES,
        },
      },
    },
    positionRetentionHours: {
      type: 'number',
      title: 'Position retention (hours)',
      description: 'How long raw positions stay in positions_index.json.',
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
          default: 'mermug',
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
      },
    },
  },
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** Coerce whatever the admin UI stored into a complete, usable config. */
export function normaliseConfig(raw: Partial<PluginConfig> | undefined): PluginConfig {
  const input = (raw ?? {}) as Record<string, any>;
  const github = input.github ?? {};
  const interval = input.interval ?? {};
  const instrumentLog = input.instrumentLog ?? {};
  const site = input.site ?? {};

  const zones: PrivacyZone[] = Array.isArray(input.privacyZones)
    ? input.privacyZones
        .filter((z: any) => z && typeof z === 'object')
        .map((z: any) => ({
          name: str(z.name),
          lat: Number(z.lat),
          lon: Number(z.lon),
          radius_m: Number(z.radius_m),
        }))
        .filter(
          (z: PrivacyZone) =>
            Number.isFinite(z.lat) &&
            Number.isFinite(z.lon) &&
            Number.isFinite(z.radius_m) &&
            z.radius_m > 0,
        )
    : [];

  const paths = Array.isArray(instrumentLog.paths)
    ? instrumentLog.paths.filter((p: unknown): p is string => typeof p === 'string' && !!p.trim())
    : DEFAULT_INSTRUMENT_LOG_PATHS;

  return {
    github: {
      repo: str(github.repo),
      branch: str(github.branch) || 'main',
      token: typeof github.token === 'string' ? github.token.trim() : '',
    },
    interval: {
      underway: positiveNumber(interval.underway, DEFAULT_INTERVAL_UNDERWAY),
      stationary: positiveNumber(interval.stationary, DEFAULT_INTERVAL_STATIONARY),
    },
    privacyZones: zones,
    timezone: str(input.timezone),
    instrumentLog: {
      paths: paths.length ? paths : DEFAULT_INSTRUMENT_LOG_PATHS,
      entries: Math.max(
        1,
        Math.floor(positiveNumber(instrumentLog.entries, DEFAULT_INSTRUMENT_LOG_ENTRIES)),
      ),
    },
    positionRetentionHours: positiveNumber(
      input.positionRetentionHours,
      DEFAULT_POSITION_RETENTION_HOURS,
    ),
    staleMaxAgeMinutes: positiveNumber(
      input.staleMaxAgeMinutes,
      DEFAULT_STALE_MAX_AGE_MINUTES,
    ),
    buildDocsIndex: input.buildDocsIndex !== false,
    publishFrontend: input.publishFrontend !== false,
    site: {
      theme: str(site.theme) || 'mermug',
      marinetrafficShipId: str(site.marinetrafficShipId),
      postgsailLogsUrl: str(site.postgsailLogsUrl),
      uscgNumber: str(site.uscgNumber),
      hullNumber: str(site.hullNumber),
    },
  };
}

/** Human-readable reason the plugin cannot publish, or null when it can. */
export function configError(config: PluginConfig): string | null {
  if (!config.github.repo) return 'Set the GitHub repository (owner/name) in the plugin config.';
  if (!/^[^/\s]+\/[^/\s]+$/.test(config.github.repo))
    return `GitHub repository must be "owner/name", got "${config.github.repo}".`;
  if (!config.github.token) return 'Set a GitHub personal access token in the plugin config.';
  return null;
}
