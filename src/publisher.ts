/**
 * One publish cycle, start to finish.
 *
 * Snapshot the self tree, drop stale values, redact the position, roll the
 * local state forward, and put whatever changed into a single commit. Nothing
 * here talks to the Signal K server: it takes a tree — and, when the server
 * has a history provider, the history `index.ts` already fetched — and returns
 * what it did, which is what makes the whole cycle testable without a server
 * or a network.
 */
import {
  appendInstrumentEntry,
  type InstrumentLog,
  type InstrumentLogEntry,
} from './instrumentLog';
import { bucketKey, mergeByBucket, type HistorySnapshot } from './history';
import {
  buildDocsIndex,
  DOCS_INDEX_PATH,
  docsIndexChanged,
  isPublishedDoc,
  renderDocsIndex,
  type DocSource,
} from './docsIndex';
import { loadFrontend } from './frontend';
import { GitHubClient, publishFiles, type PublishFile, type RequestStats } from './github';
import {
  MANIFEST_PATH,
  partitionOwned,
  renderManifest,
  type ManifestOptions,
} from './manifest';
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
  type PositionFix,
  type Tree,
} from './snapshot';
import type { PluginConfig } from './config';
import { StateStore } from './state';
import { parseTracksIndex, renderTracksIndex, updateTracks, type TrackMeta } from './gpx';
import { POLARS_PATH } from './polars';
import {
  mergeVesselIdentity,
  readVesselDetails,
  renderVesselInfo,
  type VesselIdentity,
} from './vesselInfo';

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
  /** Bytes of file content in this commit, before base64 expansion. */
  bytes: number;
  /** Per-file content size, largest first — what to look at when a cycle is fat. */
  fileSizes: Array<{ path: string; bytes: number }>;
  /** What the cycle actually cost against the network and the rate limit. */
  requests: RequestStats;
  durationMs: number;
}

/**
 * Size at which the instrument log is worth a warning.
 *
 * Every publish uploads this file in full, base64-encoded (~4/3 the size on
 * the wire), so half a megabyte every two minutes is ~20 MB an hour underway.
 * The fix is always the same: shorten the path list.
 */
export const INSTRUMENT_LOG_WARN_BYTES = 512 * 1024;

const kb = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} kB`;

const contentBytes = (content: string | Buffer): number =>
  Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf-8');

export interface PublisherDeps {
  client: GitHubClient;
  store: StateStore;
  config: PluginConfig;
  /**
   * What the plugin knows about the boat before reading a tree: the LAN
   * address the site links back to, and the MMSI from the server's own ID.
   * Everything the tree carries is laid over this on every cycle.
   */
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
      // Not state, but the same reasoning: a reinstall should not re-upload a
      // polar table that is already published and unchanged.
      [POLARS_PATH, 'polars.csv'],
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

  /**
   * @param history What the history provider returned for this cycle, or null
   * when there is none: see `mergePositions` / `mergeInstrumentLog` for how
   * the two sources combine. The fetch itself happens in `index.ts` — this
   * class never talks to the server.
   */
  async runCycle(rawTree: Tree, history: HistorySnapshot | null = null): Promise<CycleResult> {
    const { config, store, log, client, version, publicDir } = this.deps;
    const startedAt = Date.now();
    const now = this.now();
    const state = await store.readState();
    const files: PublishFile[] = [];

    const tree = filterStaleData(rawTree, {
      maxAgeMinutes: config.staleMaxAgeMinutes,
      referenceTime: now,
    });
    const navState = navigationState(tree);
    // Read every cycle, not once at start: on a cold boot the plugin is
    // running before the first product-information frame arrives, and an
    // identity read once would publish "Vessel" until the next restart.
    const identity = mergeVesselIdentity(this.deps.identity, readVesselDetails(tree));
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

    const positions = await this.mergePositions(fix, history, now);
    if (positions.length) {
      const rendered = renderPositionIndex(positions);
      // Still written locally even when it came from the provider: the store
      // is what the next cycle falls back to if the database goes away
      // mid-passage, so it stays warm rather than starting the track again.
      await store.writeText('positions_index.json', rendered);
      files.push({ path: POSITIONS_PATH, content: rendered });
      files.push(
        ...(await this.updateTrackFiles(positions, now, state.publishedDays ?? [], identity)),
      );
    }

    const instrumentLog = await this.mergeInstrumentLog(tree, history, now);
    // Written without indentation: this is the largest file in the publish and
    // nobody reads it by hand.
    const instrumentLogJson = `${JSON.stringify(instrumentLog)}\n`;
    await store.writeText('instrument_log.json', instrumentLogJson);
    files.push({ path: INSTRUMENT_LOG_PATH, content: instrumentLogJson });
    const instrumentLogBytes = Buffer.byteLength(instrumentLogJson, 'utf-8');
    log(
      `Instrument log: ${instrumentLog.entries.length} entries, ` +
        `${Object.keys(instrumentLog.entries[instrumentLog.entries.length - 1]?.values ?? {}).length} ` +
        `paths this cycle, ${kb(instrumentLogBytes)}` +
        (history ? `, from history provider ${history.providerId}.` : '.'),
    );
    if (instrumentLogBytes > INSTRUMENT_LOG_WARN_BYTES) {
      log(
        `Instrument log is ${kb(instrumentLogBytes)} and is uploaded in full on ` +
          `every publish. At the underway cadence of ${config.interval.underway}s ` +
          `that is about ${kb((instrumentLogBytes * 4) / 3 * (3600 / config.interval.underway))} ` +
          'per hour. Shorten the captured-path list or the entries retained.',
      );
    }

    files.push(...(await this.vesselInfoFile(identity)));
    files.push(...(await this.polarsFile()));
    files.push(...(await this.manifestFile()));
    files.push(...(await this.frontendFiles(publicDir, version, state.frontendVersion)));
    files.push(...(await this.docsIndexFiles()));

    const { owned, rejected } = partitionOwned(files, this.manifestOptions());
    for (const file of rejected) {
      // Should be unreachable: a path here means a generator started writing
      // outside the manifest, which is exactly what the manifest is for.
      log(`Refusing to publish unowned path: ${file.path}`);
    }

    const fileSizes = owned
      .map((file) => ({ path: file.path, bytes: contentBytes(file.content) }))
      .sort((a, b) => b.bytes - a.bytes);
    const bytes = fileSizes.reduce((total, file) => total + file.bytes, 0);
    log(
      `Publishing ${owned.length} file(s), ${kb(bytes)}: ` +
        fileSizes
          .slice(0, 6)
          .map((file) => `${file.path} ${kb(file.bytes)}`)
          .join(', ') +
        (fileSizes.length > 6 ? `, +${fileSizes.length - 6} more` : ''),
    );

    const message = this.commitMessage(navState, now);
    const result = await publishFiles(client, owned, message);
    const requests = client.takeStats();
    const durationMs = Date.now() - startedAt;

    await store.mergeState({
      lastCommit: result?.commitSha,
      lastPublishedAt: result ? now.toISOString() : state.lastPublishedAt,
    });

    if (result) {
      log(
        `Published ${result.commitSha.slice(0, 7)}: ${result.files} file(s), ` +
          `${kb(bytes)} of content in ${kb(requests.bytesUploaded)} of request bodies, ` +
          `${requests.requests} API call(s), ${durationMs} ms` +
          (result.retried ? ', after one retry on a lost ref race' : '') +
          (requests.rateLimitRemaining !== null
            ? `. Rate limit: ${requests.rateLimitRemaining} left until ${requests.rateLimitResetAt}`
            : ''),
      );
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
      bytes,
      fileSizes,
      requests,
      durationMs,
    };
  }

  /**
   * The position index this cycle publishes.
   *
   * Three sources, least authoritative first: what the plugin accumulated
   * locally, what the history provider holds, and the fix the tree carries
   * right now. Without a provider this collapses to the original behaviour —
   * the stored index plus one new point.
   */
  private async mergePositions(
    fix: PositionFix | null,
    history: HistorySnapshot | null,
    now: Date,
  ): Promise<PositionEntry[]> {
    const { config, store } = this.deps;
    const stored = parsePositionIndex(await store.readText('positions_index.json'));
    const live = fix ? [buildPositionEntry(fix, config.privacyZones, now)] : [];

    if (!history) {
      return pruneAndSort([...stored, ...live], now, config.positionRetentionHours);
    }
    const merged = mergeByBucket(
      [stored, history.positions, live],
      config.history.resolutionSeconds,
    );
    return pruneAndSort(merged, now, config.positionRetentionHours);
  }

  /**
   * The instrument log this cycle publishes, on the same three sources.
   *
   * The live reading is taken from the tree rather than the provider even
   * when a provider answered: the newest bucket in a database is up to one
   * resolution behind, and the sparkline should end at what the boat is doing
   * now.
   */
  private async mergeInstrumentLog(
    tree: Tree,
    history: HistorySnapshot | null,
    now: Date,
  ): Promise<InstrumentLog> {
    const { config, store } = this.deps;
    const existing = await store.readJson<{ entries?: InstrumentLogEntry[] }>(
      'instrument_log.json',
      {},
    );
    const stored = Array.isArray(existing.entries) ? existing.entries : [];
    if (!history) return appendInstrumentEntry(stored, now, tree, config.instrumentLog);

    // Bucket-merge the two histories, then let `appendInstrumentEntry` add the
    // live reading and trim, so both paths produce the same file shape.
    const merged = mergeByBucket(
      [stored, history.instrument],
      config.history.resolutionSeconds,
    ).filter(
      (entry) =>
        bucketKey(entry.timestamp, config.history.resolutionSeconds) !==
        bucketKey(now.toISOString(), config.history.resolutionSeconds),
    );
    return appendInstrumentEntry(merged, now, tree, config.instrumentLog);
  }

  private commitMessage(navState: string | null, now: Date): string {
    const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
    return `Telemetry ${stamp}Z${navState ? ` (${navState})` : ''}`;
  }

  private async updateTrackFiles(
    entries: PositionEntry[],
    now: Date,
    publishedDays: string[],
    identity: VesselIdentity,
  ): Promise<PublishFile[]> {
    const { store, config } = this.deps;
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
  private async vesselInfoFile(identity: VesselIdentity): Promise<PublishFile[]> {
    const { store, config, client } = this.deps;
    const fingerprint = JSON.stringify({
      site: config.site,
      zones: config.privacyZones,
      timezone: config.timezone,
      identity,
    });
    const previous = await store.readText('info-fingerprint.txt');
    if (previous === fingerprint) return [];

    const published = await client.getFile(INFO_PATH).catch(() => null);
    const contents = renderVesselInfo(config, identity, published, (problem) =>
      this.deps.log(problem),
    );
    await store.writeText('info-fingerprint.txt', fingerprint);
    this.deps.log(
      previous === null
        ? `Writing ${INFO_PATH} for the first time.`
        : `Config changed; rewriting ${INFO_PATH}` +
            (published?.includes('passage:') ? ' (preserving the passage block).' : '.'),
    );
    return [{ path: INFO_PATH, content: contents }];
  }

  /**
   * `data/vessel/polars.csv`, when the config page supplies a polar table.
   *
   * An empty setting writes nothing and claims nothing: the file is the
   * user's until they paste a table here, and a table removed later leaves the
   * last published file in the repository rather than deleting a boat's
   * performance data because a text box was cleared.
   */
  private async polarsFile(): Promise<PublishFile[]> {
    const { config, store, log } = this.deps;
    if (!config.polars) return [];
    const previous = await store.readText('polars.csv');
    if (previous === config.polars) return [];
    await store.writeText('polars.csv', config.polars);
    log(
      `${previous === null ? 'Publishing' : 'Republishing'} ${POLARS_PATH} ` +
        `(${config.polars.trim().split('\n').length - 1} wind angles).`,
    );
    return [{ path: POLARS_PATH, content: config.polars }];
  }

  /** What the plugin claims to own this cycle. */
  private manifestOptions(): ManifestOptions {
    const { config } = this.deps;
    return {
      buildDocsIndex: config.buildDocsIndex,
      publishFrontend: config.publishFrontend,
      publishPolars: config.polars !== '',
    };
  }

  private async manifestFile(): Promise<PublishFile[]> {
    const { store, version } = this.deps;
    const options = this.manifestOptions();
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
      version,
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
