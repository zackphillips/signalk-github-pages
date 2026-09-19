/**
 * The boat's polar table: `data/vessel/polars.csv`.
 *
 * The frontend draws target speed against true wind angle from this file, and
 * before this it was one more thing to commit by hand — the only piece of the
 * site that could not be set from the admin UI. Now it is a config field: the
 * table is pasted in as it comes out of ORC, a VPP or a sailmaker's sheet, and
 * the plugin publishes it in the one format `app.js` parses.
 *
 * That parser is unforgiving: semicolons, a header row of wind speeds in
 * knots, a true wind angle in degrees first on every row. Rather than make the
 * user match it, anything table-shaped is accepted here — semicolons, commas,
 * tabs or runs of spaces — and re-rendered into the canonical form. A file
 * that is close but not quite right is the failure this avoids: the chart
 * silently draws nothing, and nothing in the log says why.
 */

/** Repository path the frontend fetches. */
export const POLARS_PATH = 'data/vessel/polars.csv';

/** First column of the header row, as ORC and most VPP exports write it. */
const HEADER_LABEL = 'twa/tws';

export interface PolarTable {
  /** True wind speeds, knots, in column order. */
  windSpeeds: number[];
  /** One row per true wind angle, in degrees, ascending. */
  rows: Array<{ twa: number; speeds: number[] }>;
}

export interface ParsedPolars {
  /** Null when the block is empty or has nothing usable in it. */
  table: PolarTable | null;
  /** Everything wrong with the input, in the order it was found. */
  problems: string[];
}

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

/** Trim trailing zeros: 6.5 stays 6.5, 6.00 becomes 6. */
const fmt = (value: number): string => String(Math.round(value * 100) / 100);

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

/**
 * Parse and render in one step: the empty string means "publish no polars",
 * which leaves any hand-committed `polars.csv` in the repository alone.
 */
export function renderPolars(input: unknown): { csv: string; problems: string[] } {
  const { table, problems } = parsePolarTable(input);
  return { csv: table ? renderPolarCsv(table) : '', problems };
}
