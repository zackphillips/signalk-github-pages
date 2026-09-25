import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LogbookReader,
  logbookDay,
  logbookDir,
  publishedEntry,
  renderLogbookDays,
  type RawLogEntry,
} from '../src/logbook';

const LA = { timezone: 'America/Los_Angeles', crewNames: true };

/** An hourly entry as signalk-logbook writes one, position and all. */
const HOURLY: RawLogEntry = {
  datetime: '2026-03-01T20:00:00.000Z',
  position: { longitude: -122.52, latitude: 37.92, source: 'GPS' },
  waypoint: { longitude: -122.4, latitude: 37.8 },
  heading: 202,
  course: 198,
  speed: { stw: 5.1, sog: 5.4 },
  log: 9.6,
  barometer: 1016.2,
  wind: { speed: 13.7, direction: 283 },
  observations: { seaState: 3 },
  engine: { hours: 405 },
  crewNames: ['Zack', 'Ronan'],
  skipperName: 'Zack',
  category: 'navigation',
  text: 'Automatic hourly log entry',
};

describe('publishedEntry', () => {
  it('never publishes a position, whatever the entry carries', () => {
    const entry = publishedEntry(
      { ...HOURLY, somethingNew: { latitude: 1, longitude: 2 } },
      LA,
    ) as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('position');
    expect(entry).not.toHaveProperty('waypoint');
    expect(entry).not.toHaveProperty('somethingNew');
    expect(JSON.stringify(entry)).not.toMatch(/latitude|longitude/);
  });

  it('keeps the conditions, the text and the crew', () => {
    expect(publishedEntry(HOURLY, LA)).toEqual({
      datetime: '2026-03-01T20:00:00.000Z',
      category: 'navigation',
      origin: 'auto',
      text: 'Automatic hourly log entry',
      log: 9.6,
      heading: 202,
      course: 198,
      speed: { sog: 5.4, stw: 5.1 },
      barometer: 1016.2,
      wind: { speed: 13.7, direction: 283 },
      observations: { seaState: 3 },
      engine: { hours: 405 },
      crewNames: ['Zack', 'Ronan'],
      skipperName: 'Zack',
    });
  });

  it('reads an entry with an author as written by a person, as the logbook does', () => {
    expect(publishedEntry({ datetime: '2026-03-01T21:00:00Z', text: 'Reefed', author: 'zack' }, LA))
      .toMatchObject({ origin: 'manual', author: 'zack', category: 'navigation' });
  });

  it('drops every name with the crew switched off, including the crew-change entries', () => {
    const off = { ...LA, crewNames: false };
    const entry = publishedEntry({ ...HOURLY, author: 'zack' }, off) as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('crewNames');
    expect(entry).not.toHaveProperty('skipperName');
    expect(entry).not.toHaveProperty('author');
    for (const text of [
      'Crew changed to Zack, Ronan',
      'Ronan joined the crew',
      'Ronan left the crew',
      'Zack took over as skipper',
    ]) {
      expect(publishedEntry({ datetime: HOURLY.datetime, text, origin: 'auto' }, off), text).toBeNull();
    }
    // A person writing the same words is a note, not a crew-change record.
    expect(
      publishedEntry({ datetime: HOURLY.datetime, text: 'Ronan joined the crew', author: 'zack' }, off),
    ).not.toBeNull();
  });

  it('skips an entry with no usable time', () => {
    expect(publishedEntry({ text: 'no time' }, LA)).toBeNull();
    expect(publishedEntry({ datetime: 'yesterday', text: 'bad' }, LA)).toBeNull();
  });
});

describe('renderLogbookDays', () => {
  it('groups by local day, so an evening sail is one day and not two', () => {
    const days = renderLogbookDays(
      [
        { datetime: '2026-03-02T03:30:00Z', text: 'Anchored' },
        { datetime: '2026-03-01T22:00:00Z', text: 'Departed' },
      ],
      LA,
    );
    expect([...days.keys()]).toEqual(['2026-03-01']);
    const day = JSON.parse(days.get('2026-03-01')!);
    expect(day).toMatchObject({ schema_version: 1, date: '2026-03-01' });
    expect(day.entries.map((entry: any) => entry.text)).toEqual(['Departed', 'Anchored']);
  });

  it('renders the same entries to the same bytes', () => {
    const entries = [HOURLY, { datetime: '2026-03-01T21:00:00Z', text: 'Reefed', author: 'zack' }];
    expect(renderLogbookDays(entries, LA)).toEqual(renderLogbookDays([...entries].reverse(), LA));
  });
});

describe('logbookDir and logbookDay', () => {
  it('finds the logbook beside this plugin in plugin-config-data', () => {
    expect(logbookDir('/home/pi/.signalk/plugin-config-data/signalk-github-pages')).toBe(
      '/home/pi/.signalk/plugin-config-data/signalk-logbook',
    );
  });

  it('reads the day back out of a published path', () => {
    expect(logbookDay('data/telemetry/logbook/2026-03-01.json')).toBe('2026-03-01');
    expect(logbookDay('data/telemetry/tracks/2026-03-01.gpx')).toBeNull();
  });
});

describe('LogbookReader', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'logbook-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('answers null when the logbook has never written anything', async () => {
    expect(await new LogbookReader().read(path.join(dir, 'missing'))).toBeNull();
  });

  it('reads the day files signalk-logbook writes, and nothing else', async () => {
    await fs.writeFile(
      path.join(dir, '2026-03-01.yml'),
      '- datetime: 2026-03-01T20:00:00.000Z\n  text: Departed\n  author: zack\n',
    );
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not a log');
    const read = await new LogbookReader().read(dir);
    expect(read?.problems).toEqual([]);
    expect(read?.entries).toEqual([
      { datetime: '2026-03-01T20:00:00.000Z', text: 'Departed', author: 'zack' },
    ]);
  });

  it('picks up an edited day, and forgets a deleted one', async () => {
    const reader = new LogbookReader();
    const file = path.join(dir, '2026-03-01.yml');
    await fs.writeFile(file, '- datetime: 2026-03-01T20:00:00Z\n  text: One\n');
    expect((await reader.read(dir))?.entries).toHaveLength(1);

    await fs.writeFile(file, '- datetime: 2026-03-01T20:00:00Z\n  text: One\n- datetime: 2026-03-01T21:00:00Z\n  text: Two\n');
    expect((await reader.read(dir))?.entries).toHaveLength(2);

    await fs.rm(file);
    expect((await reader.read(dir))?.entries).toEqual([]);
  });

  it('names a file that will not parse, and reads the rest', async () => {
    await fs.writeFile(path.join(dir, '2026-03-01.yml'), '- datetime: [unclosed\n');
    await fs.writeFile(path.join(dir, '2026-03-02.yml'), '- datetime: 2026-03-02T20:00:00Z\n  text: Fine\n');
    const read = await new LogbookReader().read(dir);
    expect(read?.entries).toHaveLength(1);
    expect(read?.problems.join(' ')).toContain('2026-03-01.yml');
  });
});
