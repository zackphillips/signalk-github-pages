/**
 * Rolling state in the plugin's data directory.
 *
 * GitHub is publish-only: nothing is ever read back from it during a cycle
 * except on first run, when the store seeds itself from the repository so a
 * reinstall does not lose the day's track. Nothing here is a git checkout:
 * there is no working copy to corrupt and nothing to rebase.
 *
 * Every write goes through a temp file + fsync + rename, because a power cut
 * mid-write on a boat is a normal event, and a truncated index silently wipes
 * a day of history.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface PersistedState {
  /** Frontend version last written to the repository. */
  frontendVersion?: string;
  /** ETag of the last docs tree listing, for conditional requests. */
  docsEtag?: string;
  /** Blob SHA and last-changed date per document, so `updated` stays stable. */
  docs?: Record<string, { sha: string; updated: string }>;
  /** Local days whose GPX file is already published. */
  publishedDays?: string[];
  lastCommit?: string;
  lastPublishedAt?: string;
  /** True once the store has been seeded from the repository. */
  seeded?: boolean;
  /**
   * Paths this plugin used to publish and has now removed from the
   * repository. Recorded only after the commit carrying the deletion landed,
   * so a failed publish retries the removal rather than skipping it.
   */
  retired?: string[];
  /**
   * The privacy zones every published track was last checked against, as
   * `privacyZoneFingerprint` renders them. A cycle whose zones differ checks
   * every GPX file in the repository again. Recorded only after the commit
   * carrying the trims landed.
   */
  privacyAudit?: string;
  /**
   * Days removed one at a time from the console. Never rebuilt from the
   * position index, even while it still holds some of their points: the
   * person asked for that day to go, not for it to come back truncated.
   */
  removedDays?: string[];
}

export class StateStore {
  constructor(private readonly dataDir: string) {}

  private resolve(name: string): string {
    return path.join(this.dataDir, name);
  }

  async readText(name: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(name), 'utf-8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Temp file + fsync + rename: a crash leaves the previous file intact.
   *
   * `mode` is for a file holding a credential. It is set on the temp file
   * before anything is written to it, so the secret is never readable by
   * anyone else even for the moment before the rename.
   */
  async writeText(name: string, contents: string, mode?: number): Promise<void> {
    const target = this.resolve(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    // A temp file left by a crash keeps its old mode through `open`, so it
    // goes first rather than being reused.
    if (mode !== undefined) await fs.rm(temp, { force: true });
    const handle = await fs.open(temp, 'w', mode);
    try {
      await handle.writeFile(contents, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
  }

  /** Delete a file; one that is already gone is not an error. */
  async remove(name: string): Promise<void> {
    await fs.rm(this.resolve(name), { force: true });
  }

  async readJson<T>(name: string, fallback: T): Promise<T> {
    const raw = await this.readText(name);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  async readState(): Promise<PersistedState> {
    return this.readJson<PersistedState>('state.json', {});
  }

  async writeState(state: PersistedState): Promise<void> {
    await this.writeText('state.json', `${JSON.stringify(state, null, 2)}\n`);
  }

  async mergeState(patch: Partial<PersistedState>): Promise<PersistedState> {
    const merged = { ...(await this.readState()), ...patch };
    await this.writeState(merged);
    return merged;
  }
}
