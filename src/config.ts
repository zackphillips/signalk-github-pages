/**
 * Plugin configuration: the JSON Schema the Signal K admin UI renders, the
 * TypeScript shape it produces, and the resolver that turns a filled-in form
 * into values the rest of the plugin can rely on.
 *
 * The config page is the only place any of this is set. There is no YAML to
 * hand-edit and no wizard to run: `data/vessel/info.yaml` in the published
 * repo is an *output* of this file, written for the frontend to read.
 *
 * Nothing numeric has a default. An interval, a retention window, a stale
 * cutoff and the instrument-path list all describe one boat's cellular plan
 * and one boat's instruments; a default here is a guess that publishes at
 * someone else's cadence and bandwidth until they notice. The plugin refuses
 * to publish until each one is set, and says exactly which are missing.
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

/**
 * A starting point for `instrumentLog.paths`, documented rather than applied.
 *
 * These are the paths the bundled frontend's sparklines draw. They are in the
 * README to paste into the config page, not in the schema as a default: which
 * instruments a boat has, and which of them are worth a megabyte a day over a
 * hotspot, is not something this plugin can guess.
 */
export const SUGGESTED_INSTRUMENT_LOG_PATHS = [
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
      title: 'Publish cadence (required)',
      properties: {
        underway: {
          type: 'number',
          title: 'Underway interval (seconds)',
          description:
            'Used when navigation.state is sailing or motoring. 120 is one ' +
            'publish every two minutes; each publish costs the size of the ' +
            'changed files, uploaded in full.',
        },
        stationary: {
          type: 'number',
          title: 'Stationary interval (seconds)',
          description: 'Used when moored, anchored, or the state is unknown. 3600 is hourly.',
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
      title: 'Instrument log (sparklines, required)',
      properties: {
        paths: {
          type: 'string',
          title: 'Captured paths',
          description:
            'One Signal K path per line. "*" matches one path segment, so ' +
            'electrical.batteries.*.voltage covers every bank. Lines starting ' +
            'with # are comments. This list is the entire bandwidth cost of a ' +
            'cycle: every path here is uploaded, for every entry, on every ' +
            'publish. The README has the set the bundled sparklines draw.',
        },
        entries: {
          type: 'number',
          title: 'Entries retained',
          description:
            'Rolling length of instrument_log.json — 120 entries is about five ' +
            'hours at a two-minute cadence. The frontend is told this number, ' +
            'so the sparklines and the publisher cannot drift apart.',
        },
      },
    },
    positionRetentionHours: {
      type: 'number',
      title: 'Position retention (hours, required)',
      description:
        'How long raw positions stay in positions_index.json — the map track. ' +
        'Past days survive as GPX regardless.',
    },
    staleMaxAgeMinutes: {
      type: 'number',
      title: 'Stale value cutoff (minutes, required)',
      description:
        'Values older than this are dropped from the published snapshot so the ' +
        'site shows them as unavailable rather than as current.',
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
 * everything that is missing.
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

  const underway = num(interval.underway);
  if (underway === null) problems.push('Underway interval (seconds) is not set.');
  const stationary = num(interval.stationary);
  if (stationary === null) problems.push('Stationary interval (seconds) is not set.');

  const paths = parsePathList(instrumentLog.paths);
  if (!paths.length)
    problems.push(
      'Instrument log paths are not set — nothing would be recorded for the ' +
        'sparklines. The README lists the set the bundled frontend draws.',
    );
  const entries = num(instrumentLog.entries);
  if (entries === null) problems.push('Instrument log entries retained is not set.');

  const retention = num(input.positionRetentionHours);
  if (retention === null) problems.push('Position retention (hours) is not set.');

  const stale = num(input.staleMaxAgeMinutes);
  if (stale === null) problems.push('Stale value cutoff (minutes) is not set.');

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
    // Not fatal, but a half-entered zone hides nothing and the operator has
    // every reason to think it does.
    problems.push(
      `${droppedZones} privacy zone(s) are incomplete (each needs a latitude, ` +
        'longitude and a radius in metres) and would hide nothing.',
    );
  }

  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    config: {
      github: { repo, branch: str(github.branch) || 'main', token },
      interval: { underway: underway!, stationary: stationary! },
      privacyZones: zones,
      timezone: str(input.timezone),
      instrumentLog: { paths, entries: Math.max(1, Math.floor(entries!)) },
      positionRetentionHours: retention!,
      staleMaxAgeMinutes: stale!,
      buildDocsIndex: input.buildDocsIndex !== false,
      publishFrontend: input.publishFrontend !== false,
      site: {
        theme: str(site.theme) || 'mermug',
        marinetrafficShipId: str(site.marinetrafficShipId),
        postgsailLogsUrl: str(site.postgsailLogsUrl),
        uscgNumber: str(site.uscgNumber),
        hullNumber: str(site.hullNumber),
        extraYaml: typeof site.extraYaml === 'string' ? site.extraYaml : '',
      },
    },
  };
}
