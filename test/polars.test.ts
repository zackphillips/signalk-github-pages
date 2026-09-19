import { describe, expect, it } from 'vitest';
import { parsePolarTable, renderPolarCsv, renderPolars } from '../src/polars';

const ORC = `twa/tws;6;8;10;12
52;4.10;5.10;5.80;6.10
60;4.40;5.40;6.00;6.30
90;4.80;5.90;6.50;6.80
`;

describe('parsePolarTable', () => {
  it('reads the semicolon table the frontend already expects', () => {
    const { table, problems } = parsePolarTable(ORC);
    expect(problems).toEqual([]);
    expect(table?.windSpeeds).toEqual([6, 8, 10, 12]);
    expect(table?.rows).toHaveLength(3);
    expect(table?.rows[0]).toEqual({ twa: 52, speeds: [4.1, 5.1, 5.8, 6.1] });
  });

  it('takes commas, tabs and spaces, because that is what gets pasted', () => {
    const expected = parsePolarTable(ORC).table;
    for (const separator of [',', '\t', ' ']) {
      const { table } = parsePolarTable(ORC.replace(/;/g, separator));
      expect(table, separator).toEqual(expected);
    }
  });

  it('reads a European export where the decimal separator is a comma', () => {
    const { table } = parsePolarTable('twa/tws;6;8\n52;4,10;5,10\n');
    expect(table?.rows[0]?.speeds).toEqual([4.1, 5.1]);
  });

  it('ignores blank lines and # comments', () => {
    const { table, problems } = parsePolarTable(`# Mermug, measured 2025-06\n\n${ORC}\n`);
    expect(problems).toEqual([]);
    expect(table?.rows).toHaveLength(3);
  });

  it('sorts rows by wind angle, so the chart closes in order', () => {
    const { table } = parsePolarTable('twa;6\n90;5.0\n52;4.1\n150;4.6\n');
    expect(table?.rows.map((row) => row.twa)).toEqual([52, 90, 150]);
  });

  it('pads a short row with zeros rather than shifting it onto the wrong wind speed', () => {
    // The frontend indexes speeds by column: a ragged row would silently read
    // a 12-knot target as the 8-knot one.
    const { table, problems } = parsePolarTable('twa;6;8;10\n52;4.1;5.1\n');
    expect(table?.rows[0]?.speeds).toEqual([4.1, 5.1, 0]);
    expect(problems.join(' ')).toContain('read as zero');
  });

  it('drops a row that does not start with an angle, and says which', () => {
    const { table, problems } = parsePolarTable('twa;6\n52;4.1\nupwind;4.4\n');
    expect(table?.rows).toHaveLength(1);
    expect(problems.join(' ')).toContain('Row 3');
  });

  it('keeps the first of a duplicated angle', () => {
    const { table, problems } = parsePolarTable('twa;6\n52;4.1\n52;9.9\n');
    expect(table?.rows).toEqual([{ twa: 52, speeds: [4.1] }]);
    expect(problems.join(' ')).toContain('more than once');
  });

  it('refuses a header with no wind speeds in it', () => {
    const { table, problems } = parsePolarTable('angle;speed\n52;4.1\n');
    expect(table).toBeNull();
    expect(problems.join(' ')).toContain('true wind speeds in knots');
  });

  it('refuses a header with no rows under it', () => {
    const { table, problems } = parsePolarTable('twa;6;8;10\n');
    expect(table).toBeNull();
    expect(problems.join(' ')).toContain('at least one row');
  });

  it('treats an empty block as no polars at all, not as an error', () => {
    for (const input of ['', '   \n\n', '# nothing but a comment\n', undefined]) {
      const { table, problems } = parsePolarTable(input);
      expect(table).toBeNull();
      expect(problems).toEqual([]);
    }
  });
});

describe('renderPolarCsv', () => {
  it('writes the semicolon format app.js parses, with a trailing newline', () => {
    const { table } = parsePolarTable('twa/tws,6,10\n52,4.10,5.80\n');
    expect(renderPolarCsv(table!)).toBe('twa/tws;6;10\n52;4.1;5.8\n');
  });

  it('round-trips a table it has already rendered', () => {
    const once = renderPolars(ORC).csv;
    expect(renderPolars(once).csv).toBe(once);
  });

  it('gives an empty string when there is nothing to publish', () => {
    expect(renderPolars('').csv).toBe('');
    expect(renderPolars('rubbish').csv).toBe('');
  });
});
