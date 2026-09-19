import { describe, expect, it } from 'vitest';
import {
  buildDocsIndex,
  buildEntry,
  deriveDescription,
  docsIndexChanged,
  extractHeadings,
  isPublishedDoc,
  splitFrontMatter,
  stripInlineMarkdown,
} from '../src/docsIndex';

const GENERATED = '2026-03-01T12:00:00.000Z';
const doc = (path: string, text: string) => ({ path, text });

describe('splitFrontMatter', () => {
  it('parses and strips front matter', () => {
    const { meta, body } = splitFrontMatter('---\ntitle: MOB\norder: 10\n---\n# Heading\n');
    expect(meta).toEqual({ title: 'MOB', order: 10 });
    expect(body).toBe('# Heading\n');
  });

  it('leaves a document without front matter untouched', () => {
    const text = '# Heading\n\nProse.\n';
    expect(splitFrontMatter(text)).toEqual({ meta: {}, body: text });
  });

  it('ignores malformed front matter rather than throwing', () => {
    // A typo in one procedure must not take the whole documents page offline.
    const text = '---\ntitle: [unclosed\n---\n# Heading\n';
    expect(splitFrontMatter(text).meta).toEqual({});
  });

  it('does not mistake a leading horizontal rule for front matter', () => {
    const text = '---\n\n# Heading\n';
    expect(splitFrontMatter(text).body).toBe(text);
  });
});

describe('title and category inference', () => {
  it('falls back to the first H1', () => {
    expect(buildEntry(doc('docs/systems.md', '# Systems Overview\n')).title).toBe(
      'Systems Overview',
    );
  });

  it('falls back to the filename when there is no H1', () => {
    expect(buildEntry(doc('docs/mob-procedure.md', 'Prose only.\n')).title).toBe(
      'Mob Procedure',
    );
  });

  it('lets front matter override everything inferred', () => {
    const entry = buildEntry(
      doc(
        'docs/mob-procedure.md',
        '---\ntitle: Man Overboard\ncategory: Emergency\norder: 10\ndescription: What to do.\n---\n# Ignored\n\nAlso ignored.\n',
      ),
    );
    expect(entry).toMatchObject({
      title: 'Man Overboard',
      category: 'Emergency',
      order: 10,
      description: 'What to do.',
    });
  });

  it('falls back to the default order when it is not a number', () => {
    expect(buildEntry(doc('docs/a.md', '---\norder: soon\n---\n# A\n')).order).toBe(100);
  });

  it('takes the category from a subdirectory', () => {
    expect(buildEntry(doc('docs/voyage-logs/2026-baja.md', '# Baja\n')).category).toBe(
      'Voyage Logs',
    );
    expect(buildEntry(doc('docs/systems.md', '# Systems\n')).category).toBe('General');
  });
});

describe('descriptions and headings', () => {
  it('uses the first prose paragraph', () => {
    const entry = buildEntry(
      doc('docs/a.md', '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n'),
    );
    expect(entry.description).toBe('First paragraph.');
  });

  it('strips links and emphasis', () => {
    expect(stripInlineMarkdown('See **[the manual](docs/x.md)** now')).toBe(
      'See the manual now',
    );
  });

  it('is empty for a document with no prose', () => {
    expect(deriveDescription('# Title\n\n- a list item\n')).toBe('');
  });

  it('truncates a long paragraph on a word boundary', () => {
    const description = deriveDescription(`${'word '.repeat(80)}\n`);
    expect(description.length).toBeLessThanOrEqual(181);
    expect(description.endsWith('…')).toBe(true);
  });

  it('excludes H1 and anything inside a code fence', () => {
    const body = '# Title\n\n## Real\n\n```\n# Not a heading\n```\n\n### Also real\n';
    expect(extractHeadings(body).map((h) => h.text)).toEqual(['Title', 'Real', 'Also real']);
    expect(buildEntry(doc('docs/a.md', body)).headings.map((h) => h.text)).toEqual([
      'Real',
      'Also real',
    ]);
  });
});

describe('buildDocsIndex', () => {
  it('sorts by category, then order, then title', () => {
    const index = buildDocsIndex(
      [
        doc('docs/b.md', '---\ncategory: Systems\norder: 20\n---\n# B\n'),
        doc('docs/a.md', '---\ncategory: Operations\norder: 30\n---\n# A\n'),
        doc('docs/c.md', '---\ncategory: Systems\norder: 10\n---\n# C\n'),
      ],
      GENERATED,
    );
    expect(index.docs.map((entry) => entry.title)).toEqual(['A', 'C', 'B']);
  });

  it('excludes underscore-prefixed drafts', () => {
    expect(isPublishedDoc('docs/_template.md')).toBe(false);
    expect(isPublishedDoc('docs/index.json')).toBe(false);
    expect(isPublishedDoc('docs/mob-procedure.md')).toBe(true);
    const index = buildDocsIndex([doc('docs/_template.md', '# Draft\n')], GENERATED);
    expect(index.docs).toEqual([]);
  });

  it('carries the updated date through when it is known', () => {
    const index = buildDocsIndex(
      [{ path: 'docs/a.md', text: '# A\n', updated: '2026-02-01T00:00:00Z' }],
      GENERATED,
    );
    expect(index.docs[0]!.updated).toBe('2026-02-01T00:00:00Z');
  });
});

describe('docsIndexChanged', () => {
  const index = buildDocsIndex([doc('docs/a.md', '# A\n')], GENERATED);

  it('ignores the generated timestamp', () => {
    // Rewriting the file to bump a timestamp would put an empty commit in the
    // repository on every single cycle.
    const previous = JSON.stringify({ generated: '2020-01-01T00:00:00Z', docs: index.docs });
    expect(docsIndexChanged(previous, index)).toBe(false);
  });

  it('reports a real change, a missing file and a corrupt one', () => {
    const other = buildDocsIndex([doc('docs/a.md', '# Renamed\n')], GENERATED);
    expect(docsIndexChanged(JSON.stringify(index), other)).toBe(true);
    expect(docsIndexChanged(null, index)).toBe(true);
    expect(docsIndexChanged('{broken', index)).toBe(true);
  });
});
