/**
 * Seeding `docs/`, and adding to the maintenance log.
 *
 * Everything else this plugin writes is its own: telemetry it generated, a
 * frontend it shipped, an index it derived. The documents are the opposite —
 * `docs/**.md` belongs to the boat's owner, the manifest says so, and
 * `partitionOwned` drops any cycle that tries to touch one. That rule stays.
 *
 * What this module adds is a second, much narrower way in: a write that only
 * a person at the console can ask for, that only ever reaches Markdown under
 * `docs/`, and that never destroys prose. There are exactly two of them.
 *
 *   Initialize — write the starter set (this directory's `AGENTS.md` and a
 *   start-here page) into a repository that has no documents at all. Create
 *   only: a path that already exists is skipped, and a repository with one
 *   document in it is already initialized and is left alone.
 *
 *   Maintenance entry — insert one dated section at the top of
 *   `docs/maintenance/log.md`, creating the file the first time. An insert,
 *   not a rewrite: existing entries are carried across byte for byte.
 *
 * Both are console-only. Nothing here is reachable from `runCycle`, because a
 * publish that could rewrite a document is a publish that can lose one.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DOCS_DIR } from './docsIndex';

/** The maintenance log: one file, newest entry first. */
export const MAINTENANCE_LOG_PATH = `${DOCS_DIR}/maintenance/log.md`;

export interface SeedFile {
  /** Repo-relative destination path, always under `docs/`. */
  path: string;
  content: string;
}

/** The adopter's values, substituted into the seed documents. */
export interface SeedContext {
  vesselName: string;
  repo: string;
  branch: string;
  /** Where the console answers on the boat's network. */
  consoleUrl: string;
}

/**
 * Refuse anything that is not a Markdown file under `docs/`.
 *
 * The console's writes bypass the ownership manifest by design — the whole
 * point is to write paths the plugin does not own — so this is what stands in
 * its place. It is a positive check, not a blacklist: a bug that starts
 * composing a path from user input cannot reach `index.html`, `data/`, or a
 * directory above the repository.
 */
export function assertDocsPath(repoPath: string): void {
  const ok =
    /^docs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/.test(repoPath) &&
    !repoPath.split('/').includes('..');
  if (!ok) {
    throw new Error(
      `Refusing to write "${repoPath}": the console only writes Markdown files under docs/.`,
    );
  }
}

/** Substitute the adopter's values into a seed document. */
export function renderSeed(text: string, context: SeedContext): string {
  const values: Record<string, string> = {
    VESSEL_NAME: context.vesselName || 'this vessel',
    REPO: context.repo,
    BRANCH: context.branch,
    CONSOLE_URL: context.consoleUrl,
  };
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
    key in values ? values[key]! : match,
  );
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full, base)));
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

/**
 * Read the starter set shipped in the package.
 *
 * `seed/` is a third top-level directory beside `site/` and `public/`, and it
 * means a third thing: not published every upgrade like `site/`, not served to
 * the boat like `public/`, but copied into the repository once and then left
 * alone forever. Keeping the prose in real Markdown files rather than in
 * string literals is what makes it reviewable as prose.
 */
export async function loadDocsSeed(seedDir: string, context: SeedContext): Promise<SeedFile[]> {
  const relatives = (await walk(seedDir)).sort();
  const files: SeedFile[] = [];
  for (const relative of relatives) {
    if (!relative.toLowerCase().endsWith('.md')) continue;
    const repoPath = relative.split(path.sep).join('/');
    assertDocsPath(repoPath);
    files.push({
      path: repoPath,
      content: renderSeed(await fs.readFile(path.join(seedDir, relative), 'utf-8'), context),
    });
  }
  return files;
}

export interface MaintenanceEntry {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  title: string;
  system?: string;
  /** Engine hours at the time of the work. */
  engineHours?: number;
  by?: string;
  /** Free Markdown, rendered under the entry's facts. */
  notes?: string;
}

/**
 * A form field the console sent that the plugin cannot use.
 *
 * Its own class so the router can answer 400 rather than 500: a missing
 * title is the person's typo, not the plugin's fault, and the two deserve
 * different words on the page.
 */
export class MaintenanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceInputError';
  }
}

const TITLE_MAX = 120;
const FIELD_MAX = 80;
const NOTES_MAX = 20_000;

const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';

/** A real calendar day, not just four digits and two dashes. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validate what the console's form sent.
 *
 * The date defaults to the boat's local day rather than to UTC: an entry made
 * at 1900 in California is that day's work, not tomorrow's. Everything else
 * is optional, because a log entry with nothing but a date and "replaced the
 * impeller" is a useful log entry and a form that refuses it will not be used
 * at sea.
 */
export function parseMaintenanceEntry(
  body: unknown,
  options: { today: string },
): MaintenanceEntry {
  const input = (typeof body === 'string' ? safeJson(body) : body) as Record<string, any> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MaintenanceInputError('The maintenance entry must be a JSON object.');
  }

  const title = text(input.title, TITLE_MAX);
  if (!title) throw new MaintenanceInputError('A maintenance entry needs a title.');

  const date = text(input.date, 10) || options.today;
  if (!isCalendarDay(date)) {
    throw new MaintenanceInputError(`"${date}" is not a date of the form YYYY-MM-DD.`);
  }

  const entry: MaintenanceEntry = { date, title };

  const system = text(input.system, FIELD_MAX);
  if (system) entry.system = system;

  const by = text(input.by, FIELD_MAX);
  if (by) entry.by = by;

  if (input.engineHours !== undefined && input.engineHours !== null && input.engineHours !== '') {
    const hours = Number(input.engineHours);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new MaintenanceInputError(
        `"${input.engineHours}" is not a number of engine hours.`,
      );
    }
    entry.engineHours = Math.round(hours * 10) / 10;
  }

  if (typeof input.notes === 'string' && input.notes.trim()) {
    // Notes keep their line breaks — they are Markdown, and a numbered list
    // flattened into one paragraph is not what anybody typed.
    entry.notes = input.notes.replace(/\r\n/g, '\n').trim().slice(0, NOTES_MAX);
  }

  return entry;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The heading a log entry is filed under, and the anchor the reader gives it. */
export function entryHeading(entry: MaintenanceEntry): string {
  return `## ${entry.date}: ${entry.title}`;
}

export function renderMaintenanceEntry(entry: MaintenanceEntry): string {
  const lines = [entryHeading(entry), ''];
  const facts: string[] = [];
  if (entry.system) facts.push(`- System: ${entry.system}`);
  if (entry.engineHours !== undefined) {
    facts.push(`- Engine hours: ${entry.engineHours.toFixed(1)}`);
  }
  if (entry.by) facts.push(`- Logged by: ${entry.by}`);
  if (facts.length) lines.push(...facts, '');
  if (entry.notes) lines.push(entry.notes, '');
  return lines.join('\n');
}

/** The log file as it is created by the first entry. */
export function renderMaintenanceLog(entry: MaintenanceEntry, context: SeedContext): string {
  const header = [
    '---',
    'title: Maintenance Log',
    'category: Maintenance',
    'order: 0',
    '---',
    '',
    '# Maintenance Log',
    '',
    `Work done on ${context.vesselName || 'this vessel'}, newest first. Entries are added` +
      " from the Signal K console on the boat, or by editing this file. Keep the newest" +
      ' at the top.',
    '',
  ].join('\n');
  return `${header}${renderMaintenanceEntry(entry)}`;
}

/**
 * Put one entry at the top of an existing log.
 *
 * "The top" is immediately before the first level-2 heading, so the title and
 * the file's own preamble stay where they are and the newest work is the first
 * thing on screen. A file with no `##` in it yet — someone rewrote the
 * preamble, or the log was hand-started — takes the entry at the end rather
 * than having a position guessed for it.
 *
 * Nothing already in the file is parsed, reformatted or reordered. The result
 * is the old bytes with one block spliced in, which is the only way a form on
 * a phone gets to write to a document somebody wrote by hand.
 */
export function insertMaintenanceEntry(existing: string, entry: MaintenanceEntry): string {
  const block = renderMaintenanceEntry(entry);
  const lines = existing.replace(/\r\n/g, '\n').split('\n');

  let inFence = false;
  let insertAt = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^##\s/.test(line)) {
      insertAt = index;
      break;
    }
  }

  if (insertAt === -1) {
    const body = existing.replace(/\s*$/, '');
    return `${body}\n\n${block}`;
  }

  const before = lines.slice(0, insertAt).join('\n').replace(/\s*$/, '');
  const after = lines.slice(insertAt).join('\n');
  return `${before}\n\n${block}\n${after.replace(/^\n+/, '')}`;
}

/**
 * Engine hours off the self tree, for the form's prefill.
 *
 * Signal K carries `propulsion.<id>.runTime` in seconds. The form is a text
 * box either way: this is a starting value to correct, not a reading to
 * trust, and an engine whose hour meter was replaced will disagree with it.
 */
export function engineHours(tree: unknown): Array<{ engine: string; hours: number }> {
  const propulsion = (tree as any)?.propulsion;
  if (!propulsion || typeof propulsion !== 'object') return [];
  const found: Array<{ engine: string; hours: number }> = [];
  for (const [engine, values] of Object.entries(propulsion as Record<string, any>)) {
    const seconds = values?.runTime?.value ?? values?.runTime;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) continue;
    found.push({ engine, hours: Math.round((seconds / 3600) * 10) / 10 });
  }
  return found.sort((a, b) => a.engine.localeCompare(b.engine));
}
