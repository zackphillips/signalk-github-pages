/**
 * The boat's polar table: `data/vessel/polars.csv`.
 *
 * The frontend draws target speed against true wind angle from this file. The
 * table itself is not ours: it belongs to the Polar Management plugin
 * (`signalk-polar-management`), which stores polars as a Signal K `polars`
 * resource, imports them from ORC or a VPP export, and publishes a pointer to
 * the selected one at `polars.activePolar` in the self tree. This module reads
 * that resource and renders it in the one format `app.js` parses.
 *
 * That is one copy of the polar on the boat rather than two that drift apart.
 * The table on this plugin's config page is an override: it is used when
 * "Override polar" is ticked, and ignored otherwise, so the config page shows
 * the active polar read-only rather than inviting an edit that would do
 * nothing. `readActivePolar` reports which of the two was used.
 *
 * The resource is canonical polar-format: SI units (true wind speed and boat
 * speed in m/s, true wind angle in radians), the matrix indexed
 * `[twsRow][twaColumn]`, and only the 0..π half stored because the format
 * assumes port/starboard symmetry. The chart wants knots and degrees, so
 * everything is converted on the way out.
 */
import type { Tree } from './snapshot';

/** Repository path the frontend fetches. */
export const POLARS_PATH = 'data/vessel/polars.csv';

/** Signal K resource type the Polar Management plugin provides. */
export const POLAR_RESOURCE_TYPE = 'polars';

/** Self-tree path carrying `{ href }` to the selected polar. */
export const ACTIVE_POLAR_PATH = 'polars.activePolar';

/** First column of the header row, as ORC and most VPP exports write it. */
const HEADER_LABEL = 'twa/tws';

/** Major schema version of the resource format this module understands. */
const SUPPORTED_SCHEMA_MAJOR = 1;

const MS_PER_KNOT = 0.514444;
const DEG_PER_RAD = 180 / Math.PI;

export interface PolarTable {
  /** True wind speeds, knots, in column order. */
  windSpeeds: number[];
  /** One row per true wind angle, in degrees, ascending. */
  rows: Array<{ twa: number; speeds: number[] }>;
}

/**
 * Round to two decimals, the precision ORC and every VPP export publishes.
 *
 * Done at conversion rather than at render: 6 knots stored as 3.086664 m/s
 * comes back as 5.999999999999999, and `polars.csv` is republished whenever
 * its content changes. Rounding here means a polar that did not move produces
 * a byte-identical file.
 */
const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface ParsedPolars {
  /** Null when the resource is missing, unreadable or has nothing usable. */
  table: PolarTable | null;
  /** Everything wrong with it, in the order it was found. */
  problems: string[];
}

/** Minimal shape of the server's Resources API — what this module needs of it. */
export interface PolarResourceSource {
  resourcesApi?: {
    getResource: (type: string, id: string) => Promise<unknown>;
  };
}

/** Unwrap `{ value, timestamp }`, or take the node as it stands. */
function leaf(node: unknown): unknown {
  if (node && typeof node === 'object' && 'value' in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>).value;
  }
  return node;
}

/**
 * The id of the polar the Polar Management plugin has selected, or null.
 *
 * It publishes `{ href: '/resources/polars/<id>' }`, which is the Signal K
 * convention for pointing at a resource. A bare string is accepted too, so a
 * different provider writing the id directly still works.
 */
export function activePolarId(tree: Tree): string | null {
  const value = leaf((tree as any)?.polars?.activePolar);
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const href = (value as Record<string, unknown>).href;
  if (typeof href !== 'string') return null;
  const match = /\/resources\/[^/]+\/(.+)$/.exec(href.trim());
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Trim trailing zeros: 6.5 stays 6.5, 6.00 becomes 6. */
const fmt = (value: number): string => String(round2(value));

/** Conversion to the chart's units, by the unit the document declares. */
const SPEED_TO_KNOTS: Record<string, number> = {
  'm/s': 1 / MS_PER_KNOT,
  kn: 1,
  kt: 1,
  kts: 1,
  knot: 1,
  knots: 1,
};
const ANGLE_TO_DEGREES: Record<string, number> = {
  rad: DEG_PER_RAD,
  deg: 1,
  degree: 1,
  degrees: 1,
};

function numbers(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out.push(item);
  }
  return out;
}

/**
 * Convert a stored polar resource into the table the chart draws.
 *
 * Everything here is a report-and-skip: a polar table is a chart, not a
 * position, so a resource this cannot read leaves the published file alone
 * rather than stopping a publish.
 */
export function polarTableFromResource(resource: unknown): ParsedPolars {
  const problems: string[] = [];
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    problems.push('The polar resource is not a JSON object.');
    return { table: null, problems };
  }
  const document = resource as Record<string, any>;

  if (document.kind !== undefined && document.kind !== 'polarTable') {
    problems.push(`The polar resource is a "${document.kind}", not a polarTable.`);
    return { table: null, problems };
  }
  // Tolerate an unknown minor version of a major version we know, reject a
  // major we do not: the format says the matrix layout can only change there.
  const major = Number(String(document.schemaVersion ?? '').split('.')[0]);
  if (Number.isFinite(major) && major !== SUPPORTED_SCHEMA_MAJOR) {
    problems.push(
      `The polar resource is schema version ${document.schemaVersion}; this plugin ` +
        `reads version ${SUPPORTED_SCHEMA_MAJOR}.x. Upgrade the plugin.`,
    );
    return { table: null, problems };
  }

  const units = (document.units ?? {}) as Record<string, unknown>;
  const twsUnit = typeof units.tws === 'string' ? units.tws : 'm/s';
  const twaUnit = typeof units.twa === 'string' ? units.twa : 'rad';
  const speedUnit = typeof units.boatSpeed === 'string' ? units.boatSpeed : 'm/s';
  const twsToKnots = SPEED_TO_KNOTS[twsUnit];
  const twaToDegrees = ANGLE_TO_DEGREES[twaUnit];
  const speedToKnots = SPEED_TO_KNOTS[speedUnit];
  if (!twsToKnots || !twaToDegrees || !speedToKnots) {
    problems.push(
      `The polar resource uses units this plugin does not know ` +
        `(tws "${twsUnit}", twa "${twaUnit}", boat speed "${speedUnit}").`,
    );
    return { table: null, problems };
  }

  const tws = numbers(document.axes?.tws);
  const twa = numbers(document.axes?.twa);
  if (!tws || !twa) {
    problems.push('The polar resource has no usable axes.tws / axes.twa.');
    return { table: null, problems };
  }
  const matrix = document.values?.boatSpeedMatrix;
  if (!Array.isArray(matrix) || matrix.length !== tws.length) {
    problems.push(
      `values.boatSpeedMatrix has ${Array.isArray(matrix) ? matrix.length : 0} row(s) for ` +
        `${tws.length} wind speed(s).`,
    );
    return { table: null, problems };
  }

  const speeds: number[][] = [];
  for (const [index, row] of matrix.entries()) {
    const values = numbers(row);
    if (!values || values.length !== twa.length) {
      problems.push(
        `values.boatSpeedMatrix row ${index + 1} does not hold ${twa.length} boat speed(s).`,
      );
      return { table: null, problems };
    }
    speeds.push(values);
  }

  // The matrix is indexed [tws][twa]; the CSV is one line per angle, so it is
  // transposed here rather than in the renderer.
  const rows = twa.map((angle, twaIndex) => ({
    twa: round2(angle * twaToDegrees),
    speeds: tws.map((_, twsIndex) =>
      round2(Math.max(0, speeds[twsIndex]![twaIndex]! * speedToKnots)),
    ),
  }));
  rows.sort((a, b) => a.twa - b.twa);

  return {
    table: { windSpeeds: tws.map((speed) => round2(speed * twsToKnots)), rows },
    problems,
  };
}

/**
 * The override: a polar table typed into the config page.
 *
 * It exists because a boat with a polar on a sailmaker's PDF and no internet
 * at anchor should still get a chart, and the alternative was telling that
 * person to install a second plugin first.
 *
 * The parser is deliberately unfussy about what it is handed: semicolons,
 * commas, tabs or runs of spaces, a European decimal comma, `#` comments. A
 * table that is close but not quite right is the failure this avoids — the
 * chart silently draws nothing, and nothing in the log says why.
 */
/**
 * Split one line into cells.
 *
 * Decided per line rather than once for the file: a table pasted out of a
 * spreadsheet can arrive with a semicolon header and tab-separated rows.
 */
function splitCells(line: string): string[] {
  const delimiter = line.includes(';')
    ? ';'
    : line.includes('\t')
      ? '\t'
      : line.includes(',')
        ? ','
        : /\s/;
  return line.split(delimiter).map((cell) => cell.trim());
}

/** A number, accepting a comma decimal separator from a European export. */
function cell(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read a pasted polar table.
 *
 * The first line with two or more cells and a non-numeric first cell is the
 * header; a table whose header is bare numbers (no `twa/tws` label) is read as
 * a header too, because a row of wind speeds is what it is. Everything after
 * is a data row: angle first, then one boat speed per wind speed.
 */
export function parsePolarTable(input: unknown): ParsedPolars {
  const text = typeof input === 'string' ? input : '';
  const problems: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (lines.length === 0) return { table: null, problems };

  if (lines.length < 2) {
    problems.push(
      'The polar table needs a header row of wind speeds and at least one row of boat speeds.',
    );
    return { table: null, problems };
  }

  const header = splitCells(lines[0]!);
  const windSpeeds: number[] = [];
  for (const [index, value] of header.entries()) {
    if (index === 0) continue; // The corner label, whatever it says.
    const speed = cell(value);
    if (speed === null || speed < 0) {
      problems.push(`Header column ${index + 1} ("${value}") is not a wind speed; ignoring it.`);
      continue;
    }
    windSpeeds.push(speed);
  }
  if (windSpeeds.length === 0) {
    problems.push(
      'The first line must be the true wind speeds in knots, e.g. "twa/tws;6;8;10;12;16;20".',
    );
    return { table: null, problems };
  }

  const rows: PolarTable['rows'] = [];
  const seen = new Set<number>();
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = splitCells(line);
    const twa = cell(cells[0] ?? '');
    if (twa === null) {
      problems.push(`Row ${index + 2} does not start with a wind angle; ignoring it.`);
      continue;
    }
    if (twa < 0 || twa > 360) {
      problems.push(`Row ${index + 2} has a wind angle of ${twa}°, which is not 0-360; ignoring it.`);
      continue;
    }
    if (seen.has(twa)) {
      problems.push(`Wind angle ${twa}° appears more than once; keeping the first row.`);
      continue;
    }
    // A short row is padded with zeros and a long one is cut: the frontend
    // indexes speeds by column, so a ragged table would shift a whole row's
    // targets onto the wrong wind speed.
    const speeds = windSpeeds.map((_, column) => {
      const value = cell(cells[column + 1] ?? '');
      return value === null || value < 0 ? 0 : value;
    });
    if (cells.length - 1 !== windSpeeds.length) {
      problems.push(
        `Row ${index + 2} has ${cells.length - 1} speed(s) for ${windSpeeds.length} wind ` +
          'speed(s); the missing ones are read as zero.',
      );
    }
    seen.add(twa);
    rows.push({ twa, speeds });
  }

  if (rows.length === 0) {
    problems.push('The polar table has a header but no usable rows.');
    return { table: null, problems };
  }

  rows.sort((a, b) => a.twa - b.twa);
  return { table: { windSpeeds, rows }, problems };
}


/** Render the canonical semicolon CSV the frontend parses. */
export function renderPolarCsv(table: PolarTable): string {
  const lines = [[HEADER_LABEL, ...table.windSpeeds.map(fmt)].join(';')];
  for (const row of table.rows) {
    lines.push([fmt(row.twa), ...row.speeds.map(fmt)].join(';'));
  }
  return `${lines.join('\n')}\n`;
}

/** Where the published `polars.csv` came from this cycle. */
export type PolarSource = 'resource' | 'config' | 'none';

export interface ActivePolar {
  /** The resource id, or null when nothing is selected on the server. */
  id: string | null;
  /** The CSV to publish; empty means publish nothing and claim nothing. */
  csv: string;
  source: PolarSource;
  problems: string[];
  /** One line for the config page and the log, e.g. "12 angles x 7 wind speeds". */
  summary: string;
}

const describe = (table: PolarTable): string =>
  `${table.rows.length} angle(s) x ${table.windSpeeds.length} wind speed(s)`;

/** The config page's half of the decision. */
export interface PolarOverride {
  override: boolean;
  table: string;
}

/**
 * Work out which polar to publish this cycle.
 *
 * The polar selected in Polar Management is the boat's polar, maintained in
 * one place by the plugin whose job that is. The table on our config page
 * takes over only when "Override polar" is ticked, and is read first when it
 * is; an override that will not parse falls through to the server rather than
 * publishing nothing.
 *
 * Called once per cycle from `index.ts` — the resource lives behind an async
 * server API, and `publisher.ts` stays a pure function of the tree. Publishing
 * nothing is a normal outcome, not a failure: it leaves whatever `polars.csv`
 * is already in the repository alone.
 */
export async function readActivePolar(
  app: PolarResourceSource,
  tree: Tree,
  polars: PolarOverride = { override: false, table: '' },
): Promise<ActivePolar> {
  const problems: string[] = [];
  const id = activePolarId(tree);

  if (polars.override) {
    const pasted = parsePolarTable(polars.table);
    problems.push(...pasted.problems);
    if (pasted.table) {
      return {
        id,
        csv: renderPolarCsv(pasted.table),
        source: 'config',
        problems,
        summary: `the table on the config page, ${describe(pasted.table)}`,
      };
    }
    problems.push('Override polar is ticked but the table on the config page is not usable.');
  }

  if (id) {
    const getResource = app.resourcesApi?.getResource;
    if (typeof getResource !== 'function') {
      problems.push(
        'This Signal K server has no Resources API, so the active polar cannot be read.',
      );
    } else {
      try {
        const resource = await getResource.call(app.resourcesApi, POLAR_RESOURCE_TYPE, id);
        const parsed = polarTableFromResource(resource);
        problems.push(...parsed.problems);
        if (parsed.table) {
          return {
            id,
            csv: renderPolarCsv(parsed.table),
            source: 'resource',
            problems,
            summary: `"${id}" from Polar Management, ${describe(parsed.table)}`,
          };
        }
      } catch (error: any) {
        problems.push(`Could not read polar "${id}": ${error?.message ?? error}`);
      }
    }
  }

  return {
    id,
    csv: '',
    source: 'none',
    problems,
    summary: id
      ? `"${id}" is active but could not be read`
      : 'no active polar on the server, and Override polar is not ticked',
  };
}
