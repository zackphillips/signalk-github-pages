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
 * privacy zones start empty, the timezone starts at UTC, and the repo and the
 * token have no stand-in. Guessing at a privacy zone would be worse than
 * having none, and a guessed timezone splits tracks on the wrong midnight —
 * so the timezone field names the zone the server is set to and lets you pick
 * it, rather than picking it for you.
 *
 * The vessel's own details — name, MMSI, callsign, registrations, dimensions —
 * are not on this page at all: they are read from the Signal K tree, which is
 * where the server already keeps them. The fields here are fallbacks for what
 * a server does not carry.
 */

import { renderPolars } from './polars';
import { availableTimezones, serverTimezone } from './timezones';

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
   * The polar table as `data/vessel/polars.csv` is published, already in the
   * frontend's semicolon format. Empty means the plugin publishes no polars
   * and leaves a hand-committed file alone.
   */
  polars: string;
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
        repo: {
          type: 'string',
          title: 'Repository (owner/name) — replaced by the two fields above',
          description:
            'Left over from an earlier version. It is still honoured when the ' +
            'owner and name above are blank; fill those in and this can be ' +
            'cleared.',
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
    polars: {
      type: 'string',
      title: 'Polar table (CSV)',
      description:
        'The boat\'s polars, for the target-speed chart. Paste the table as it ' +
        'comes out of ORC, a VPP or a sailmaker: first line the true wind ' +
        'speeds in knots, then one line per true wind angle in degrees ' +
        'followed by the target boat speeds in knots. Semicolons, commas, tabs ' +
        'or spaces all work, and lines starting with # are comments. Leave ' +
        'blank to keep managing data/vessel/polars.csv by hand — blank never ' +
        'deletes or overwrites a file already in the repository.',
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
        postgsailLogsUrl: {
          type: 'string',
          title: 'PostgSail logs URL',
          default: '',
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

/**
 * Admin-UI hints. The legacy `github.repo` field stays in the schema so an
 * upgraded installation keeps publishing before anyone opens this page, but it
 * is hidden: a form showing three repository boxes invites filling in the
 * wrong one. A server that ignores uiSchema shows it, labelled for what it is.
 */
export const configUiSchema = {
  github: {
    repo: { 'ui:widget': 'hidden' },
    token: { 'ui:widget': 'password' },
  },
  polars: { 'ui:widget': 'textarea', 'ui:options': { rows: 12 } },
  instrumentLog: { paths: { 'ui:widget': 'textarea', 'ui:options': { rows: 12 } } },
  site: { extraYaml: { 'ui:widget': 'textarea', 'ui:options': { rows: 6 } } },
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
 * Resolve the two repository fields, and the one they replaced.
 *
 * Splitting the old `owner/name` box into two is mostly a usability change,
 * but it also removes the most common setup mistake: a value with no slash, or
 * with a whole GitHub URL in it, that failed only on the first publish. Here a
 * pasted URL or an `owner/name` in the owner box is split rather than
 * rejected, and the legacy single field still resolves an installation that
 * has not been through this page since the upgrade.
 */
export function resolveOwnerAndName(
  rawOwner: unknown,
  rawName: unknown,
  legacyRepo: unknown,
): OwnerAndName {
  const problems: string[] = [];
  let owner = stripRepoUrl(str(rawOwner));
  let name = stripRepoUrl(str(rawName));

  if (!owner && !name) {
    const legacy = stripRepoUrl(str(legacyRepo));
    if (legacy) [owner = '', name = ''] = legacy.split('/');
  }
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
export function resolveConfig(raw: unknown): ResolvedConfig | UnresolvedConfig {
  const input = (raw ?? {}) as Record<string, any>;
  const github = input.github ?? {};
  const interval = input.interval ?? {};
  const instrumentLog = input.instrumentLog ?? {};
  const site = input.site ?? {};
  const problems: string[] = [];

  const warnings: string[] = [];

  const { owner, name, problems: repoProblems } = resolveOwnerAndName(
    github.owner,
    github.name,
    github.repo,
  );
  problems.push(...repoProblems);

  const token = typeof github.token === 'string' ? github.token.trim() : '';
  if (!token) problems.push('GitHub personal access token is not set.');
  else {
    const warning = tokenWarning(token);
    if (warning) warnings.push(warning);
  }

  const polars = renderPolars(input.polars);
  // A polar table is decoration on a chart, not a position: a typo in it is
  // reported and the file is skipped, never a reason to stop publishing.
  warnings.push(...polars.problems.map((problem) => `Polar table: ${problem}`));

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
      polars: polars.csv,
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
