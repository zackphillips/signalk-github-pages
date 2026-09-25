import { describe, expect, it } from 'vitest';
import {
  activePolarId,
  polarTableFromResource,
  readActivePolar,
  renderPolarCsv,
} from '../src/polars';

const KN = 0.514444;
const RAD = Math.PI / 180;

/** A two-wind-speed, three-angle table in the canonical units Signal K stores. */
const RESOURCE = {
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'Mermug ORC 2025',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: {
    tws: [6 * KN, 10 * KN],
    twa: [52 * RAD, 90 * RAD, 150 * RAD],
  },
  values: {
    boatSpeedMatrix: [
      [4.1 * KN, 4.8 * KN, 4.0 * KN],
      [5.8 * KN, 6.5 * KN, 6.0 * KN],
    ],
  },
};

const tree = (activePolar: unknown) => ({ polars: { activePolar: { value: activePolar } } });

describe('activePolarId', () => {
  it('reads the href the Polar Management plugin publishes', () => {
    expect(activePolarId(tree({ href: '/resources/polars/mermug-orc' }))).toBe('mermug-orc');
  });

  it('takes a bare id too, so another provider can write one', () => {
    expect(activePolarId(tree('mermug-orc'))).toBe('mermug-orc');
  });

  it('decodes an id with a space in it, which the admin UI allows', () => {
    expect(activePolarId(tree({ href: '/resources/polars/Mermug%20ORC' }))).toBe('Mermug ORC');
  });

  it('is null when nothing is selected, or the plugin is not installed', () => {
    expect(activePolarId(tree(null))).toBeNull();
    expect(activePolarId({})).toBeNull();
    expect(activePolarId(tree({ href: 'nonsense' }))).toBeNull();
  });
});

describe('polarTableFromResource', () => {
  it('converts SI canonical units into the knots and degrees the chart draws', () => {
    const { table, problems } = polarTableFromResource(RESOURCE);
    expect(problems).toEqual([]);
    expect(table?.windSpeeds).toEqual([6, 10]);
    expect(table?.rows.map((row) => row.twa)).toEqual([52, 90, 150]);
  });

  it('transposes the matrix: it is [tws][twa], the CSV is one line per angle', () => {
    const { table } = polarTableFromResource(RESOURCE);
    // 52 degrees: 4.1 kn at 6 kn of wind, 5.8 kn at 10.
    expect(table?.rows[0]?.speeds.map((speed) => Math.round(speed * 100) / 100)).toEqual([4.1, 5.8]);
  });

  it('honors a document that declares knots and degrees rather than SI', () => {
    const { table, problems } = polarTableFromResource({
      ...RESOURCE,
      units: { tws: 'kn', twa: 'deg', boatSpeed: 'kn' },
      axes: { tws: [6, 10], twa: [52, 90, 150] },
      values: { boatSpeedMatrix: [[4.1, 4.8, 4.0], [5.8, 6.5, 6.0]] },
    });
    expect(problems).toEqual([]);
    expect(table?.windSpeeds).toEqual([6, 10]);
    expect(table?.rows[0]?.speeds).toEqual([4.1, 5.8]);
  });

  it('refuses a schema major version it does not know rather than guessing', () => {
    const { table, problems } = polarTableFromResource({ ...RESOURCE, schemaVersion: '2.0.0' });
    expect(table).toBeNull();
    expect(problems.join(' ')).toContain('schema version 2.0.0');
  });

  it('reads an unknown minor version of a major it does know', () => {
    const { table } = polarTableFromResource({ ...RESOURCE, schemaVersion: '1.7.0' });
    expect(table?.windSpeeds).toEqual([6, 10]);
  });

  it('refuses a ragged matrix instead of shifting a row onto the wrong wind speed', () => {
    const { table, problems } = polarTableFromResource({
      ...RESOURCE,
      values: { boatSpeedMatrix: [[4.1 * KN, 4.8 * KN], [5.8 * KN, 6.5 * KN, 6.0 * KN]] },
    });
    expect(table).toBeNull();
    expect(problems.join(' ')).toContain('row 1');
  });

  it('refuses units it cannot convert', () => {
    const { table, problems } = polarTableFromResource({
      ...RESOURCE,
      units: { tws: 'furlongs/fortnight', twa: 'rad', boatSpeed: 'm/s' },
    });
    expect(table).toBeNull();
    expect(problems.join(' ')).toContain('units this plugin does not know');
  });

  it('refuses a resource that is not a polar table', () => {
    expect(polarTableFromResource({ kind: 'route' }).table).toBeNull();
    expect(polarTableFromResource('nope').table).toBeNull();
    expect(polarTableFromResource(null).table).toBeNull();
  });
});

describe('renderPolarCsv', () => {
  it('writes the semicolon format app.js parses, with a trailing newline', () => {
    const { table } = polarTableFromResource(RESOURCE);
    expect(renderPolarCsv(table!)).toBe(
      'twa/tws;6;10\n52;4.1;5.8\n90;4.8;6.5\n150;4;6\n',
    );
  });
});

describe('readActivePolar', () => {
  const app = (resource: unknown) => ({
    resourcesApi: {
      getResource: async (type: string, id: string) => {
        expect(type).toBe('polars');
        if (id !== 'mermug-orc') throw new Error(`Polar not found: ${id}`);
        return resource;
      },
    },
  });
  const selected = tree({ href: '/resources/polars/mermug-orc' });

  it('fetches the selected polar and renders it', async () => {
    const result = await readActivePolar(app(RESOURCE), selected);
    expect(result.id).toBe('mermug-orc');
    expect(result.csv).toContain('twa/tws;6;10');
    expect(result.problems).toEqual([]);
  });

  it('publishes nothing when no polar is selected', async () => {
    const result = await readActivePolar(app(RESOURCE), {});
    expect(result.csv).toBe('');
    expect(result.source).toBe('none');
    expect(result.problems).toEqual([]);
  });

  it('publishes nothing when the active polar will not convert', async () => {
    const result = await readActivePolar(
      app({ ...RESOURCE, units: { tws: 'furlongs', twa: 'rad', boatSpeed: 'm/s' } }),
      selected,
    );
    expect(result.source).toBe('none');
    expect(result.csv).toBe('');
    expect(result.problems.join(' ')).toContain('units this plugin does not know');
  });

  it('reports a polar that has gone missing rather than throwing into the cycle', async () => {
    const result = await readActivePolar(app(RESOURCE), tree({ href: '/resources/polars/gone' }));
    expect(result.csv).toBe('');
    expect(result.problems.join(' ')).toContain('Polar not found');
  });

  it('says so on a server with no Resources API', async () => {
    const result = await readActivePolar({}, selected);
    expect(result.csv).toBe('');
    expect(result.problems.join(' ')).toContain('no Resources API');
  });
});
