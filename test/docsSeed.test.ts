import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDocsPath,
  engineHours,
  insertMaintenanceEntry,
  isCalendarDay,
  loadDocsSeed,
  MAINTENANCE_LOG_PATH,
  MaintenanceInputError,
  parseMaintenanceEntry,
  renderMaintenanceEntry,
  renderMaintenanceLog,
  renderSeed,
} from '../src/docsSeed';
import { isPublishedDoc } from '../src/docsIndex';

const SEED_DIR = path.join(__dirname, '..', 'seed');

const CONTEXT = {
  vesselName: 'S.V.Mermug',
  repo: 'owner/site',
  branch: 'main',
  consoleUrl: 'http://10.0.0.5:3000/signalk-github-pages/',
};

describe('assertDocsPath', () => {
  it('accepts Markdown under docs/, at any depth', () => {
    for (const ok of ['docs/mob.md', 'docs/maintenance/log.md', 'docs/a/b/c.md']) {
      expect(() => assertDocsPath(ok), ok).not.toThrow();
    }
  });

  it('refuses anything that is not a document', () => {
    // This is what stands in for the ownership manifest on the console's
    // writes: they deliberately reach paths the plugin does not own, so the
    // guard has to be the thing that keeps them inside docs/.
    for (const bad of [
      'index.html',
      'data/telemetry/signalk_latest.json',
      '.tracker-manifest.json',
      'docs/../index.html',
      '../docs/mob.md',
      'docs/mob.html',
      'docs/',
      'docs/sub dir/mob.md',
      '/docs/mob.md',
    ]) {
      expect(() => assertDocsPath(bad), bad).toThrow(/only writes Markdown/);
    }
  });
});

describe('the shipped starter set', () => {
  it('is two documents under docs/, one of them AGENTS.md', async () => {
    const files = await loadDocsSeed(SEED_DIR, CONTEXT);
    expect(files.map((file) => file.path)).toEqual(['docs/AGENTS.md', 'docs/ships-docs.md']);
  });

  it('substitutes the boat, the repository and the console address', async () => {
    const files = await loadDocsSeed(SEED_DIR, CONTEXT);
    const text = files.map((file) => file.content).join('\n');
    expect(text).toContain('S.V.Mermug');
    expect(text).toContain('owner/site');
    expect(text).toContain('http://10.0.0.5:3000/signalk-github-pages/');
    // A placeholder that survived into a committed document is a bug the
    // reader sees, not one the log mentions.
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('keeps AGENTS.md out of the sidebar and the start-here page in it', async () => {
    expect(isPublishedDoc('docs/AGENTS.md')).toBe(false);
    expect(isPublishedDoc('docs/CLAUDE.md')).toBe(false);
    expect(isPublishedDoc('docs/ships-docs.md')).toBe(true);
    expect(isPublishedDoc(MAINTENANCE_LOG_PATH)).toBe(true);
  });

  it('leaves an unknown placeholder alone rather than blanking it', () => {
    expect(renderSeed('{{VESSEL_NAME}} and {{SOMETHING_ELSE}}', CONTEXT)).toBe(
      'S.V.Mermug and {{SOMETHING_ELSE}}',
    );
  });

  it('names the vessel generically when the server has not said what it is', () => {
    expect(renderSeed('{{VESSEL_NAME}}', { ...CONTEXT, vesselName: '' })).toBe('this vessel');
  });
});

describe('parseMaintenanceEntry', () => {
  const today = '2026-09-20';

  it('takes a title and fills in the rest', () => {
    expect(parseMaintenanceEntry({ title: 'Replaced the impeller' }, { today })).toEqual({
      date: today,
      title: 'Replaced the impeller',
    });
  });

  it('reads every field the form offers', () => {
    expect(
      parseMaintenanceEntry(
        {
          date: '2026-08-01',
          title: 'Oil change',
          system: 'Engine',
          engineHours: '1204.47',
          by: 'Zack',
          notes: 'Shell Rotella 15W-40.\n\n- Filter: Yanmar 119305-35151',
        },
        { today },
      ),
    ).toEqual({
      date: '2026-08-01',
      title: 'Oil change',
      system: 'Engine',
      engineHours: 1204.5,
      by: 'Zack',
      notes: 'Shell Rotella 15W-40.\n\n- Filter: Yanmar 119305-35151',
    });
  });

  it('refuses an entry with nothing to say', () => {
    for (const bad of [{}, { title: '   ' }, { title: '' }, [], 'nonsense', null]) {
      expect(() => parseMaintenanceEntry(bad, { today }), JSON.stringify(bad)).toThrow(
        MaintenanceInputError,
      );
    }
  });

  it('refuses a date that is not a date', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '20 September', '2026-9-1']) {
      expect(() => parseMaintenanceEntry({ title: 'x', date: bad }, { today }), bad).toThrow(
        /YYYY-MM-DD/,
      );
    }
  });

  it('refuses engine hours that are not a number, and allows none at all', () => {
    expect(() =>
      parseMaintenanceEntry({ title: 'x', engineHours: 'lots' }, { today }),
    ).toThrow(/engine hours/);
    expect(() => parseMaintenanceEntry({ title: 'x', engineHours: -1 }, { today })).toThrow(
      /engine hours/,
    );
    // An empty box is the normal case on a boat with no hour meter.
    expect(parseMaintenanceEntry({ title: 'x', engineHours: '' }, { today })).toEqual({
      date: today,
      title: 'x',
    });
  });

  it('flattens a title onto one line but keeps the notes as Markdown', () => {
    const entry = parseMaintenanceEntry(
      { title: 'New\nimpeller', notes: '1. Close seacock\r\n2. Pull the pump' },
      { today },
    );
    expect(entry.title).toBe('New impeller');
    expect(entry.notes).toBe('1. Close seacock\n2. Pull the pump');
  });

  it('reads a body the server handed over as text', () => {
    expect(parseMaintenanceEntry('{"title":"Impeller"}', { today }).title).toBe('Impeller');
  });
});

describe('isCalendarDay', () => {
  it('knows a real day from a plausible-looking one', () => {
    expect(isCalendarDay('2026-02-28')).toBe(true);
    expect(isCalendarDay('2024-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
  });
});

describe('the maintenance log', () => {
  const entry = {
    date: '2026-09-20',
    title: 'Replaced the raw-water impeller',
    system: 'Engine',
    engineHours: 1204.5,
    by: 'Zack',
    notes: 'Two vanes torn.',
  };

  it('renders an entry as a dated section with its facts', () => {
    expect(renderMaintenanceEntry(entry)).toBe(
      '## 2026-09-20: Replaced the raw-water impeller\n\n' +
        '- System: Engine\n' +
        '- Engine hours: 1204.5\n' +
        '- Logged by: Zack\n\n' +
        'Two vanes torn.\n',
    );
  });

  it('renders a bare entry without empty facts', () => {
    expect(renderMaintenanceEntry({ date: '2026-09-20', title: 'Pumped the bilge' })).toBe(
      '## 2026-09-20: Pumped the bilge\n',
    );
  });

  it('creates the file with front matter that files it under Maintenance', () => {
    const created = renderMaintenanceLog(entry, CONTEXT);
    expect(created).toMatch(/^---\ntitle: Maintenance Log\ncategory: Maintenance\norder: 0\n---\n/);
    expect(created).toContain('# Maintenance Log');
    expect(created).toContain('S.V.Mermug');
    expect(created).toContain('## 2026-09-20: Replaced the raw-water impeller');
  });

  it('inserts a new entry above the newest one, leaving the preamble alone', () => {
    const existing = renderMaintenanceLog(
      { date: '2026-08-01', title: 'Oil change' },
      CONTEXT,
    );
    const updated = insertMaintenanceEntry(existing, entry);

    const headings = [...updated.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      '2026-09-20: Replaced the raw-water impeller',
      '2026-08-01: Oil change',
    ]);
    expect(updated).toContain('# Maintenance Log');
    // The old entry survives byte for byte: this is a splice, not a rewrite.
    expect(updated).toContain('## 2026-08-01: Oil change');
  });

  it('appends when the file has no entries yet', () => {
    const updated = insertMaintenanceEntry('# Maintenance Log\n\nNothing has broken yet.\n', entry);
    expect(updated).toBe(
      '# Maintenance Log\n\nNothing has broken yet.\n\n' +
        '## 2026-09-20: Replaced the raw-water impeller\n\n' +
        '- System: Engine\n- Engine hours: 1204.5\n- Logged by: Zack\n\nTwo vanes torn.\n',
    );
  });

  it('ignores a level-2 heading inside a fenced code block', () => {
    // Otherwise an entry quoting the log's own format would split the file
    // at an example rather than at the newest entry.
    const existing = [
      '# Maintenance Log',
      '',
      'The format is:',
      '',
      '```markdown',
      '## 2026-01-01: Example',
      '```',
      '',
      '## 2026-08-01: Oil change',
      '',
    ].join('\n');
    const updated = insertMaintenanceEntry(existing, entry);
    expect(updated.indexOf('## 2026-09-20')).toBeGreaterThan(updated.indexOf('```markdown'));
    expect(updated.indexOf('## 2026-09-20')).toBeLessThan(updated.indexOf('## 2026-08-01'));
  });

  it('keeps CRLF files readable rather than doubling the line endings', () => {
    const updated = insertMaintenanceEntry('# Log\r\n\r\n## 2026-08-01: Oil\r\n', entry);
    expect(updated).not.toContain('\r');
  });
});

describe('engineHours', () => {
  it('reads runTime off every engine, in hours', () => {
    expect(
      engineHours({
        propulsion: {
          port: { runTime: { value: 4_336_200 } },
          main: { runTime: { value: 3600 } },
        },
      }),
    ).toEqual([
      { engine: 'main', hours: 1 },
      { engine: 'port', hours: 1204.5 },
    ]);
  });

  it('says nothing when the server has no hour meter', () => {
    expect(engineHours({})).toEqual([]);
    expect(engineHours({ propulsion: { main: { revolutions: { value: 20 } } } })).toEqual([]);
    expect(engineHours(null)).toEqual([]);
  });
});
