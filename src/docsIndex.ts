/**
 * `docs/index.json` — the catalogue behind `docs.html`.
 *
 * A static site cannot list a directory, so the reader needs a manifest of the
 * Markdown in `docs/`. The documents themselves are never the plugin's: the
 * owner writes them from the GitHub web UI on a phone, and adding one must
 * stay "commit a .md file and nothing else". This is a port of the Python
 * `build_docs_index.py`, reading the tree through the API instead of a
 * checkout so the last script can leave the published repo.
 */
import yaml from 'js-yaml';

export const DOCS_DIR = 'docs';
export const DOCS_INDEX_PATH = 'docs/index.json';
const DEFAULT_CATEGORY = 'General';
const DEFAULT_ORDER = 100;
/** Descriptions are teaser text on the document cards — keep them one line. */
const DESCRIPTION_MAX_CHARS = 180;

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const EMPHASIS_RE = /[*_`]+/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

export interface DocSource {
  /** Repo-relative path, e.g. `docs/mob-procedure.md`. */
  path: string;
  text: string;
  /** ISO-8601 date of the last change, when it is known. */
  updated?: string;
}

export interface DocHeading {
  level: number;
  text: string;
}

export interface DocEntry {
  slug: string;
  path: string;
  title: string;
  category: string;
  order: number;
  description: string;
  headings: DocHeading[];
  words: number;
  updated?: string;
}

export interface DocsIndex {
  generated: string;
  docs: DocEntry[];
}

/**
 * Split optional YAML front matter off the head of a document.
 *
 * Malformed or non-mapping front matter is ignored rather than thrown: a typo
 * in one procedure must not take the whole documents page offline.
 */
export function splitFrontMatter(text: string): { meta: Record<string, any>; body: string } {
  const match = FRONT_MATTER_RE.exec(text);
  if (!match) return { meta: {}, body: text };
  let meta: unknown;
  try {
    meta = yaml.load(match[1]!);
  } catch {
    return { meta: {}, body: text };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { meta: {}, body: text };
  }
  return { meta: meta as Record<string, any>, body: text.slice(match[0].length) };
}

/** Reduce a line of Markdown to readable plain text. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(HTML_COMMENT_RE, '')
    .replace(LINK_RE, '$1')
    .replace(EMPHASIS_RE, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** Yield `[line, inCodeFence]` — headings inside fences are examples, not structure. */
function* contentLines(body: string): Generator<[string, boolean]> {
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      yield [line, true];
      continue;
    }
    yield [line, inFence];
  }
}

export function extractHeadings(body: string): DocHeading[] {
  const headings: DocHeading[] = [];
  for (const [line, inFence] of contentLines(body)) {
    if (inFence) continue;
    const match = ATX_HEADING_RE.exec(line);
    if (!match) continue;
    const text = stripInlineMarkdown(match[2]!);
    if (text) headings.push({ level: match[1]!.length, text });
  }
  return headings;
}

/** First paragraph of prose, skipping headings, quotes, lists and tables. */
export function deriveDescription(body: string): string {
  const parts: string[] = [];
  for (const [line, inFence] of contentLines(body)) {
    if (inFence) continue;
    const stripped = line.trim();
    if (!stripped) {
      if (parts.length) break;
      continue;
    }
    const skip =
      /^[#>|\-*+<]/.test(stripped) || stripped === '---' || /^\d+\.\s/.test(stripped);
    if (skip) {
      if (parts.length) break;
      continue;
    }
    parts.push(stripped);
  }
  const text = stripInlineMarkdown(parts.join(' '));
  if (text.length > DESCRIPTION_MAX_CHARS) {
    const truncated = text.slice(0, DESCRIPTION_MAX_CHARS);
    const cut = truncated.lastIndexOf(' ');
    return `${cut > 0 ? truncated.slice(0, cut) : truncated}…`;
  }
  return text;
}

function titleCase(text: string): string {
  return text
    .split(' ')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ');
}

export function titleFromFilename(path: string): string {
  const stem = path.split('/').pop()!.replace(/\.md$/i, '');
  return titleCase(stem.replace(/[-_]/g, ' ').trim());
}

export function buildEntry(doc: DocSource): DocEntry {
  const { meta, body } = splitFrontMatter(doc.text);
  const headings = extractHeadings(body);
  const h1 = headings.find((heading) => heading.level === 1)?.text;
  const relative = doc.path.replace(new RegExp(`^${DOCS_DIR}/`), '');
  const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';

  const order = Number.parseInt(String(meta.order ?? DEFAULT_ORDER), 10);

  const entry: DocEntry = {
    slug: relative.replace(/\.md$/i, ''),
    path: doc.path,
    title: String(meta.title || h1 || titleFromFilename(doc.path)),
    category: String(
      meta.category || (parent ? titleCase(parent.replace(/[-_]/g, ' ')) : DEFAULT_CATEGORY),
    ),
    order: Number.isFinite(order) ? order : DEFAULT_ORDER,
    description: String(meta.description || deriveDescription(body)),
    // Level 1 duplicates the title, and the reader builds its table of
    // contents from the rendered DOM; this list exists so search can find
    // text that is not on screen yet.
    headings: headings.filter((heading) => heading.level > 1),
    words: body.split(/\s+/).filter(Boolean).length,
  };
  if (doc.updated) entry.updated = doc.updated;
  return entry;
}

/**
 * Instruction files for whoever — or whatever — edits the docs, not ship's
 * documents. `docs/AGENTS.md` is seeded into the repository so an agent
 * pointed at it reads the conventions and the ownership boundary first; it
 * has no business in the sidebar as a document called "Agents".
 */
const NOT_DOCUMENTS = new Set(['agents.md', 'claude.md']);

/** Is this path a published document? `_`-prefixed files are drafts. */
export function isPublishedDoc(path: string): boolean {
  if (!path.startsWith(`${DOCS_DIR}/`) || !path.toLowerCase().endsWith('.md')) return false;
  const name = path.split('/').pop()!;
  return !name.startsWith('_') && !NOT_DOCUMENTS.has(name.toLowerCase());
}

export function buildDocsIndex(docs: DocSource[], generated: string): DocsIndex {
  const entries = docs
    .filter((doc) => isPublishedDoc(doc.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(buildEntry);
  entries.sort(
    (a, b) =>
      a.category.toLowerCase().localeCompare(b.category.toLowerCase()) ||
      a.order - b.order ||
      a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
  );
  return { generated, docs: entries };
}

export function renderDocsIndex(index: DocsIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * True when the catalogue actually changed.
 *
 * `generated` is deliberately excluded: rewriting the file just to bump a
 * timestamp would put an empty commit in the repository on every cycle.
 */
export function docsIndexChanged(previousJson: string | null, next: DocsIndex): boolean {
  if (!previousJson) return true;
  try {
    const previous = JSON.parse(previousJson);
    return JSON.stringify(previous?.docs) !== JSON.stringify(next.docs);
  } catch {
    return true;
  }
}
