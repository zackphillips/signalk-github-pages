/**
 * One publish cycle, start to finish.
 *
 * Snapshot the self tree, drop stale values, redact the position, roll the
 * local state forward, and put whatever changed into a single commit. Nothing
 * here talks to the Signal K server: it takes a tree and returns what it did,
 * which is what makes the whole cycle testable without a server or a network.
 */
import {
  appendInstrumentEntry,
  type InstrumentLogEntry,
} from './instrumentLog';
import {
  buildDocsIndex,
  DOCS_INDEX_PATH,
  docsIndexChanged,
  isPublishedDoc,
  renderDocsIndex,
  type DocSource,
} from './docsIndex';
import { loadFrontend } from './frontend';
import { GitHubClient, publishFiles, type PublishFile } from './github';
import { MANIFEST_PATH, partitionOwned, renderManifest } from './manifest';
import {
  buildPositionEntry,
  parsePositionIndex,
  pruneAndSort,
  renderPositionIndex,
  type PositionEntry,
} from './positions';
import {
  extractPositionFix,
  filterStaleData,
  isUnderway,
  navigationState,
  redactPosition,
  type Tree,
} from './snapshot';
import type { PluginConfig } from './config';
import { StateStore } from './state';
import { parseTracksIndex, renderTracksIndex, updateTracks, type TrackMeta } from './gpx';
import { renderVesselInfo, type VesselIdentity } from './vesselInfo';

const TELEMETRY_DIR = 'data/telemetry';
const LATEST_PATH = `${TELEMETRY_DIR}/signalk_latest.json`;
const POSITIONS_PATH = `${TELEMETRY_DIR}/positions_index.json`;
const INSTRUMENT_LOG_PATH = `${TELEMETRY_DIR}/instrument_log.json`;
const TRACKS_INDEX_PATH = `${TELEMETRY_DIR}/tracks_index.json`;
const INFO_PATH = 'data/vessel/info.yaml';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface CycleResult {
  published: boolean;
  files: string[];
  commitSha?: string;
  retried?: boolean;
  underway: boolean;
  state: string | null;
  privacyZone: string | null;
  rejected: string[];
}

export interface PublisherDeps {
  client: GitHubClient;
  store: StateStore;
  config: PluginConfig;
  identity: VesselIdentity;
  /** Directory holding the bundled frontend (`public/`). */
  publicDir: string;
  /** Plugin version, used to decide when the frontend needs republishing. */
  version: string;
  log: (message: string) => void;
  now?: () => Date;
}

export class Publisher {
  private readonly now: () => Date;

  constructor(private readonly deps: PublisherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Seed local state from the repository on first run.
   *
   * Without this a reinstall (or a moved data directory) would start the day's
   * track from scratch and the first commit would truncate what is already
   * published.
   */
  async seed(): Promise<void> {
    const { client, store, log } = this.deps;
    const state = await store.readState();
    if (state.seeded) return;

    for (const [repoPath, local] of [
      [POSITIONS_PATH, 'positions_index.json'],
      [INSTRUMENT_LOG_PATH, 'instrument_log.json'],
      [TRACKS_INDEX_PATH, 'tracks_index.json'],
    ] as const) {
      if ((await store.readText(local)) !== null) continue;
      const remote = await client.getFile(repoPath).catch(() => null);
      if (remote !== null) {
        await store.writeText(local, remote);
        log(`Seeded ${local} from the repository.`);
      }
    }

    const tracks = parseTracksIndex(await store.readText('tracks_index.json'));
    await store.mergeState({
      seeded: true,
      publishedDays: tracks.map((track) => track.date),
    });
  }

  /** Cadence for the next tick, from `navigation.state`. */
  intervalSeconds(tree: Tree): number {
    const { config } = this.deps;
    return isUnderway(navigationState(tree))
      ? config.interval.underway
      : config.interval.stationary;
  }

  async runCycle(rawTree: Tree): Promise<CycleResult> {
    const { config, store, log, client, identity, version, publicDir } = this.deps;
    const now = this.now();
    const state = await store.readState();
    const files: PublishFile[] = [];

    const tree = filterStaleData(rawTree, {
      maxAgeMinutes: config.staleMaxAgeMinutes,
      referenceTime: now,
    });
    const navState = navigationState(tree);
    const fix = extractPositionFix(tree);
    const zone = redactPosition(tree, config.privacyZones);
    if (zone) {
      log(
        `Privacy: position replaced with the centre of ${zone.name || 'a privacy zone'}.`,
      );
    }

    files.push({
      path: LATEST_PATH,
      content: `${JSON.stringify({ schema_version: SNAPSHOT_SCHEMA_VERSION, ...tree }, null, 2)}\n`,
    });

    if (fix) {
      const entries = pruneAndSort(
        [
          ...parsePositionIndex(await store.readText('positions_index.json')),
          buildPositionEntry(fix, config.privacyZones, now),
        ],
        now,
        config.positionRetentionHours,
      );
      await store.writeText('positions_index.json', renderPositionIndex(entries));
      files.push({ path: POSITIONS_PATH, content: renderPositionIndex(entries) });
      files.push(...(await this.updateTrackFiles(entries, now, state.publishedDays ?? [])));
    }

    const existingLog = await store.readJson<{ entries?: InstrumentLogEntry[] }>(
      'instrument_log.json',
      {},
    );
    const instrumentLog = appendInstrumentEntry(
      Array.isArray(existingLog.entries) ? existingLog.entries : [],
      now,
      tree,
      config.instrumentLog,
    );
    // Written without indentation: this is the largest file in the publish and
    // nobody reads it by hand.
    const instrumentLogJson = `${JSON.stringify(instrumentLog)}\n`;
    await store.writeText('instrument_log.json', instrumentLogJson);
    files.push({ path: INSTRUMENT_LOG_PATH, content: instrumentLogJson });

    files.push(...(await this.vesselInfoFile()));
    files.push(...(await this.manifestFile()));
    files.push(...(await this.frontendFiles(publicDir, version, state.frontendVersion)));
    files.push(...(await this.docsIndexFiles()));

    const { owned, rejected } = partitionOwned(files, {
      buildDocsIndex: config.buildDocsIndex,
      publishFrontend: config.publishFrontend,
    });
    for (const file of rejected) {
      // Should be unreachable: a path here means a generator started writing
      // outside the manifest, which is exactly what the manifest is for.
      log(`Refusing to publish unowned path: ${file.path}`);
    }

    const message = this.commitMessage(navState, now);
    const result = await publishFiles(client, owned, message);

    await store.mergeState({
      lastCommit: result?.commitSha,
      lastPublishedAt: result ? now.toISOString() : state.lastPublishedAt,
    });

    if (result) {
      log(`Published ${result.files} file(s) as ${result.commitSha.slice(0, 7)}.`);
    }
    return {
      published: Boolean(result),
      files: owned.map((file) => file.path),
      commitSha: result?.commitSha,
      retried: result?.retried,
      underway: isUnderway(navState),
      state: navState,
      privacyZone: zone?.name ?? null,
      rejected: rejected.map((file) => file.path),
    };
  }

  private commitMessage(navState: string | null, now: Date): string {
    const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
    return `Telemetry ${stamp}Z${navState ? ` (${navState})` : ''}`;
  }

  private async updateTrackFiles(
    entries: PositionEntry[],
    now: Date,
    publishedDays: string[],
  ): Promise<PublishFile[]> {
    const { store, config, identity } = this.deps;
    const existingIndex: TrackMeta[] = parseTracksIndex(
      await store.readText('tracks_index.json'),
    );
    const update = updateTracks(entries, {
      zones: config.privacyZones,
      timezone: config.timezone,
      vesselName: identity.name || 'Vessel',
      now,
      existingIndex,
      publishedDays: new Set(publishedDays),
    });

    const files: PublishFile[] = [];
    for (const [repoPath, contents] of Object.entries(update.files)) {
      files.push({ path: repoPath, content: contents });
    }
    if (files.length || JSON.stringify(update.index) !== JSON.stringify(existingIndex)) {
      const rendered = renderTracksIndex(update.index);
      await store.writeText('tracks_index.json', rendered);
      files.push({ path: TRACKS_INDEX_PATH, content: rendered });
    }

    // A day is "published" once its GPX has gone up. Today is rewritten every
    // cycle anyway (updateTracks only consults this set for past days), so the
    // set exists to freeze a day after it rolls over: the position index holds
    // only the last 24 hours, and rebuilding an older day from what is left of
    // it would truncate a day that is already complete in the repository.
    const days = new Set([...publishedDays, ...update.index.map((track) => track.date)]);
    await store.mergeState({ publishedDays: [...days].sort() });
    return files;
  }

  /**
   * Rewrite `info.yaml` only when the rendered content actually changes.
   *
   * The passage banner lives in this file and is edited on GitHub, so the
   * published copy is read back before every rewrite and its `passage:` block
   * carried across.
   */
  private async vesselInfoFile(): Promise<PublishFile[]> {
    const { store, config, identity, client } = this.deps;
    const fingerprint = JSON.stringify({
      site: config.site,
      zones: config.privacyZones,
      timezone: config.timezone,
      identity: { name: identity.name, mmsi: identity.mmsi, signalk: identity.signalk },
    });
    const previous = await store.readText('info-fingerprint.txt');
    if (previous === fingerprint) return [];

    const published = await client.getFile(INFO_PATH).catch(() => null);
    const contents = renderVesselInfo(config, identity, published);
    await store.writeText('info-fingerprint.txt', fingerprint);
    return [{ path: INFO_PATH, content: contents }];
  }

  private async manifestFile(): Promise<PublishFile[]> {
    const { store, config, version } = this.deps;
    const options = {
      buildDocsIndex: config.buildDocsIndex,
      publishFrontend: config.publishFrontend,
    };
    const fingerprint = JSON.stringify({ ...options, version });
    if ((await store.readText('manifest-fingerprint.txt')) === fingerprint) return [];
    await store.writeText('manifest-fingerprint.txt', fingerprint);
    return [
      {
        path: MANIFEST_PATH,
        content: renderManifest({
          ...options,
          version,
          generated: this.now().toISOString(),
        }),
      },
    ];
  }

  /** The frontend goes up on first run and after an upgrade, never per cycle. */
  private async frontendFiles(
    publicDir: string,
    version: string,
    publishedVersion: string | undefined,
  ): Promise<PublishFile[]> {
    const { config, store, log } = this.deps;
    if (!config.publishFrontend) return [];
    const fingerprint = `${version}:${config.github.repo}:${config.github.branch}:${config.instrumentLog.entries}`;
    if (publishedVersion === fingerprint) return [];

    const files = await loadFrontend(publicDir, {
      repo: config.github.repo,
      branch: config.github.branch,
      instrumentLogEntries: config.instrumentLog.entries,
    });
    await store.mergeState({ frontendVersion: fingerprint });
    log(`Publishing frontend (${files.length} files, version ${version}).`);
    return files;
  }

  /**
   * Rebuild `docs/index.json` when the docs tree changes.
   *
   * The listing is a conditional request: with the stored ETag, an unchanged
   * tree costs nothing against the rate limit, so this can run every cycle.
   */
  private async docsIndexFiles(): Promise<PublishFile[]> {
    const { config, client, store, log } = this.deps;
    if (!config.buildDocsIndex) return [];

    const state = await store.readState();
    const listing = await client.listTree(state.docsEtag);
    if (!listing.changed) return [];

    const cache = state.docs ?? {};
    const nextCache: Record<string, { sha: string; updated: string }> = {};
    const sources: DocSource[] = [];

    for (const node of listing.paths) {
      if (node.type !== 'blob' || !isPublishedDoc(node.path)) continue;
      const cached = cache[node.path];
      let text: string | null = null;
      if (cached?.sha === node.sha) {
        text = await store.readText(`docs-cache/${node.path.replace(/\//g, '__')}`);
      }
      if (text === null) {
        text = await client.getBlobText(node.sha);
        await store.writeText(`docs-cache/${node.path.replace(/\//g, '__')}`, text);
      }
      const updated =
        cached?.sha === node.sha && cached.updated
          ? cached.updated
          : ((await client.getLastCommitDate(node.path).catch(() => null)) ??
            this.now().toISOString());
      nextCache[node.path] = { sha: node.sha, updated };
      sources.push({ path: node.path, text, updated });
    }

    const index = buildDocsIndex(sources, this.now().toISOString());
    const previous = await store.readText('docs-index.json');
    await store.mergeState({ docsEtag: listing.etag, docs: nextCache });
    if (!docsIndexChanged(previous, index)) return [];

    const rendered = renderDocsIndex(index);
    await store.writeText('docs-index.json', rendered);
    log(`Rebuilt ${DOCS_INDEX_PATH} (${index.docs.length} documents).`);
    return [{ path: DOCS_INDEX_PATH, content: rendered }];
  }
}
