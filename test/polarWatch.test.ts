import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import createPlugin from '../src/index';
import { FakeGitHub } from './helpers/fakeGitHub';

const KN = 0.514444;
const RAD = Math.PI / 180;

/** A polar as Polar Management serves it, with one boat speed to vary. */
const polar = (upwind: number) => ({
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'Test polar',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  axes: { tws: [6 * KN, 10 * KN], twa: [52 * RAD, 90 * RAD] },
  values: {
    boatSpeedMatrix: [
      [upwind * KN, 4.8 * KN],
      [5.8 * KN, 6.5 * KN],
    ],
  },
});

const TREE = {
  name: 'Test Boat',
  navigation: {
    position: { value: { latitude: 37.9, longitude: -122.5 }, timestamp: new Date().toISOString() },
  },
  polars: { activePolar: { value: { href: '/resources/polars/test' } } },
};

/**
 * Polar Management's webapp saves an edited table straight to its own store,
 * so an edit sends no delta. The only way the plugin hears about it before the
 * next tick is by looking.
 */
describe('an edited polar', () => {
  let dataDir: string;
  let fake: FakeGitHub;
  let plugin: ReturnType<typeof createPlugin>;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skgp-polar-'));
    fake = new FakeGitHub({ repo: 'owner/owner.github.io', branch: 'main' });
    vi.stubGlobal('fetch', fake.fetch);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    plugin?.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('is published within one check, not at the next tick', async () => {
    let stored = polar(4.1);
    const statuses: string[] = [];
    plugin = createPlugin({
      selfId: 'urn:mrn:imo:mmsi:338000000',
      getSelfPath: (p: string) => (p === '' ? TREE : undefined),
      getDataDirPath: () => dataDir,
      resourcesApi: { getResource: async () => stored },
      handleMessage: () => {},
      debug: () => {},
      error: () => {},
      setPluginStatus: (status: string) => statuses.push(status),
      setPluginError: () => {},
    } as any);
    plugin.start({ github: { owner: 'owner', token: 'ghp_test' } } as any);

    // Wait for the first cycle to finish, not just for its commit to land: a
    // check skips while a cycle is running, and each step below fires exactly
    // one, so a cycle still writing its local state would swallow it.
    await vi.waitFor(() => expect(statuses.some((s) => s.startsWith('Published'))).toBe(true), {
      timeout: 5000,
    });
    expect(fake.files.get('data/vessel/polars.csv')).toContain('4.1');
    const commits = fake.commits.length;

    // Nothing changed: the check reads the polar and publishes nothing.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.commits.length).toBe(commits);

    // Edited in the Polar Management webapp: no delta, but the next check
    // sees a different table and publishes it. The stationary tick is an
    // hour away and is not what does it.
    stored = polar(4.6);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(fake.files.get('data/vessel/polars.csv')).toContain('4.6'), {
      timeout: 5000,
    });
  }, 15_000);
});
