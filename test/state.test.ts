import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/state';

describe('StateStore', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skgp-state-'));
    store = new StateStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null for a file that is not there yet', async () => {
    expect(await store.readText('positions_index.json')).toBeNull();
  });

  it('round-trips text through the atomic write', async () => {
    await store.writeText('positions_index.json', '{"positions":[]}');
    expect(await store.readText('positions_index.json')).toBe('{"positions":[]}');
    // The temp file must not survive the rename.
    expect(await fs.readdir(dir)).toEqual(['positions_index.json']);
  });

  it('creates nested directories for the docs cache', async () => {
    await store.writeText('docs-cache/docs__mob.md', '# MOB');
    expect(await store.readText('docs-cache/docs__mob.md')).toBe('# MOB');
  });

  it('falls back rather than throwing on corrupt JSON', async () => {
    await store.writeText('state.json', '{broken');
    expect(await store.readState()).toEqual({});
  });

  it('merges state without losing untouched keys', async () => {
    await store.mergeState({ seeded: true, publishedDays: ['2026-03-01'] });
    await store.mergeState({ lastCommit: 'abc123' });
    expect(await store.readState()).toEqual({
      seeded: true,
      publishedDays: ['2026-03-01'],
      lastCommit: 'abc123',
    });
  });
});
