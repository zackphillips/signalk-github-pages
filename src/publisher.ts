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
import type { Passage } from './course';
import { renderInstrumentLog, type InstrumentLogEntry } from './instrumentLog';
import {
  parseNotificationLog,
  readNotifications,
  renderNotificationLog,
  renderNotifications,
  updateNotificationLog,
} from './notifications';
import type { HistoryResult } from './history';
import {
  buildDocsIndex,
  DOCS_INDEX_PATH,
  docsIndexChanged,
  isPublishedDoc,
  renderDocsIndex,
  type DocSource,
} from './docsIndex';
import {
  assertDocsPath,
  engineHours,
  insertMaintenanceEntry,
  loadDocsSeed,
  MAINTENANCE_LOG_PATH,
  renderMaintenanceLog,
  type MaintenanceEntry,
  type SeedContext,
} from './docsSeed';
import { loadFrontend } from './frontend';
import { GitHubClient, publishFiles, type PublishFile, type RequestStats } from './github';
import { describePrune, planPrune, type PrunePlan, type PruneRequest } from './prune';
import {
  MANIFEST_PATH,
  RETIRED_PATHS,
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
  renderSiteConfig,
  type VesselIdentity,
} from './siteConfig';

const TELEMETRY_DIR = 'data/telemetry';
const LATEST_PATH = `${TELEMETRY_DIR}/signalk_latest.json`;
const POSITIONS_PATH = `${TELEMETRY_DIR}/positions_index.json`;
const INSTRUMENT_LOG_PATH = `${TELEMETRY_DIR}/instrument_log.json`;
const NOTIFICATIONS_PATH = `${TELEMETRY_DIR}/notifications.json`;
const TRACKS_INDEX_PATH = `${TELEMETRY_DIR}/tracks_index.json`;
const SITE_CONFIG_PATH = 'data/vessel/site.json';

export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * What a cycle needs that is not in the tree.
 *
 * The polar table and the instrument history: both come in as arguments
 * rather than being read here, because reading either means an async call
 * into the server (the Resources API, the History API), and this module stays
 * a pure function of what it is handed.
 */
export interface CycleInput {
  /** The rendered polar CSV, or empty to publish none and claim none. */
  polars?: string;
  /**
   * What the history provider returned for this cycle. Fetched in `index.ts`
   * for the same reason the polars are, so this module never calls the
   * server. Left out, a cycle publishes no instrument log at all, which is
   * what `unavailable` does too.
   */
  history?: HistoryResult;
  /**
   * The passage banner, read from the Course API in `index.ts` — async, like
   * the other two, so this module stays a pure function of what it is given.
   * Absent means no banner, which is the normal state of a boat that is not
   * navigating to anything.
   */
  passage?: Passage | null;
  /**
   * Fixes recorded from `navigation.position` deltas since the last cycle,
   * already decimated (see `track.ts`). The current tree fix is appended to
   * these, so a cycle records at least as much as the one-fix-per-cycle
   * sampling this replaced, and more wherever the track actually bends.
   */
  fixes?: PositionFix[];
}

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
  /** Directory holding the bundled frontend (`site/`). */
  siteDir: string;
  /** Directory holding the starter documents (`seed/`). */
  seedDir: string;
  /** Plugin version, used to decide when the frontend needs republishing. */
  version: string;
  log: (message: string) => void;
  now?: () => Date;
}

/** What `docs/` holds, as the console asks before it offers to write anything. */
export interface DocsStatus {
  /** True once the repository has at least one published document. */
  initialized: boolean;
  documents: number;
  documentPaths: string[];
  /**
   * Documents that are not part of the starter set.
   *
   * This is the count that decides whether initializing is still on offer. A
   * maintenance log written from the console is a document, but it is not
   * evidence that the boat has docs of its own — and counting it as such
   * would lock the starter set out of any repository where somebody logged an
   * oil change before pressing the button.
   */
  ownDocuments: number;
  /** Starter files not in the repository. */
  missing: string[];
  /** There is something to write, and nothing of the owner's in the way. */
  canInitialize: boolean;
  maintenanceLog: { path: string; exists: boolean };
  /** The listing hit GitHub's 100k cap, so absence proves nothing. */
  truncated: boolean;
}

export interface DocsInitResult {
  created: string[];
  /** Starter files that were already there and were left alone. */
  skipped: string[];
  commitSha?: string;
  status: DocsStatus;
}

export interface MaintenanceResult {
  path: string;
  created: boolean;
  commitSha?: string;
  entry: MaintenanceEntry;
}

/**
 * The repository already has documents.
 *
 * Its own class because it is the answer to a question, not a failure: the
 * console turns it into "already initialized" rather than into an error the
 * user is meant to do something about.
 */
export class DocsExistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocsExistError';
  }
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
      // The instrument log is not here: it is rebuilt from the provider every
      // cycle, so a copy of the published one would never be read.
      [POSITIONS_PATH, 'positions_index.json'],
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

  async runCycle(rawTree: Tree, input: CycleInput = {}): Promise<CycleResult> {
    const { config, store, log, client, version, siteDir } = this.deps;
    const polars = input.polars ?? '';
    const history: HistoryResult = input.history ?? { status: 'unavailable', reason: 'not read' };
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

    // The track is the one series the plugin still keeps itself: it is what
    // the GPX archive is built from, it works on a server with no history
    // provider at all, and it is the only path a position takes to the
    // repository, which is the path the privacy zones guard.
    // Every fix — recorded or current — goes through `buildPositionEntry`,
    // which is the single place a position becomes a published value and the
    // single place the privacy zones are applied. Recording more of them must
    // not become a second route to the repository.
    //
    // The tree fix is the fallback, not an addition: the recorder already
    // keeps one fix per publish interval, so appending the tree's as well
    // would put a near-duplicate a metre away beside every recorded point.
    // With no recorder — an older server, or one whose streams this plugin
    // could not subscribe to — the tree fix is the whole track, exactly as
    // it was before deltas.
    const recorded = input.fixes ?? [];
    const newFixes = recorded.length ? recorded : fix ? [fix] : [];
    const positions = pruneAndSort(
      [
        ...parsePositionIndex(await store.readText('positions_index.json')),
        ...newFixes.map((entry) => buildPositionEntry(entry, config.privacyZones, now)),
      ],
      now,
      config.positionRetentionHours,
    );
    if (recorded.length > 1) {
      log(`Track: ${recorded.length} fixes recorded from deltas since the last cycle.`);
    }
    if (positions.length) {
      const rendered = renderPositionIndex(positions);
      await store.writeText('positions_index.json', rendered);
      files.push({ path: POSITIONS_PATH, content: rendered });
      files.push(
        ...(await this.updateTrackFiles(positions, now, state.publishedDays ?? [], identity)),
      );
    }

    files.push(...(await this.instrumentLogFile(history)));
    files.push(...(await this.notificationsFile(tree, now)));

    files.push(...(await this.siteConfigFile(identity, input.passage ?? null)));
    files.push(...(await this.polarsFile(polars)));
    files.push(...(await this.manifestFile(polars)));
    const frontend = await this.frontendFiles(siteDir, version, state.frontendVersion);
    files.push(...frontend.files);
    files.push(...(await this.docsIndexFiles()));

    const { owned, rejected } = partitionOwned(files, this.manifestOptions(polars));
    for (const file of rejected) {
      // Should be unreachable: a path here means a generator started writing
      // outside the manifest, which is exactly what the manifest is for.
      log(`Refusing to publish unowned path: ${file.path}`);
    }

    const deletions = await this.retirementDeletions(state.retired ?? []);

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
    const result = await publishFiles(client, owned, message, { deletions });
    const requests = client.takeStats();
    const durationMs = Date.now() - startedAt;

    await store.mergeState({
      lastCommit: result?.commitSha,
      lastPublishedAt: result ? now.toISOString() : state.lastPublishedAt,
      // Only once the commit carrying them actually landed: a failed publish
      // must leave the work to be retried, not recorded as done.
      ...(result && deletions.length ? { retired: [...(state.retired ?? []), ...deletions] } : {}),
      ...(result && frontend.fingerprint ? { frontendVersion: frontend.fingerprint } : {}),
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
   * `instrument_log.json`, from whatever the history provider gave this cycle.
   *
   * Three outcomes, and the difference between them is what the site shows
   * when a database is down versus never installed:
   *
   * - answered: publish the entries, and keep a copy in the data directory
   *   for the console's preview.
   * - did not answer: publish nothing. The copy already in the repository is
   *   the last good one, and a sparkline a few minutes stale beats a blank
   *   panel every time InfluxDB restarts.
   * - no provider at all: publish an empty log, once. The panels then omit
   *   the sparklines instead of drawing whatever was last accumulated, which
   *   on an upgraded install would otherwise be frozen for good. The
   *   fingerprint is what stops that empty file being re-uploaded every
   *   cycle.
   */
  private async instrumentLogFile(history: HistoryResult): Promise<PublishFile[]> {
    const { store, config, log } = this.deps;

    if (history.status === 'unavailable') return [];

    const entries: InstrumentLogEntry[] =
      history.status === 'ok' ? history.entries : [];
    const contents = renderInstrumentLog(entries);
    const bytes = Buffer.byteLength(contents, 'utf-8');

    if (history.status === 'none') {
      if ((await store.readText('instrument_log.json')) === contents) return [];
      await store.writeText('instrument_log.json', contents);
      log(
        'No history provider: publishing an empty instrument log, so the site ' +
          'omits the sparklines rather than drawing a frozen one.',
      );
      return [{ path: INSTRUMENT_LOG_PATH, content: contents }];
    }

    await store.writeText('instrument_log.json', contents);
    log(
      `Instrument log: ${entries.length} entries from history provider ` +
        `${history.providerId}, ${history.requestedPaths.length} path(s) asked for, ` +
        `${kb(bytes)}.`,
    );
    if (bytes > INSTRUMENT_LOG_WARN_BYTES) {
      log(
        `Instrument log is ${kb(bytes)} and is uploaded in full on ` +
          `every publish. At the underway cadence of ${config.interval.underway}s ` +
          `that is about ${kb((bytes * 4) / 3 * (3600 / config.interval.underway))} ` +
          'per hour. Shorten the captured-path list or the entries retained.',
      );
    }
    return [{ path: INSTRUMENT_LOG_PATH, content: contents }];
  }

  /**
   * Active notifications, and how many times each one has fired.
   *
   * This is the one telemetry file built from state rather than read from it:
   * a notification's history is a series of edges, and an edge can only be
   * seen by comparing this cycle with the last. The rolling log lives in the
   * data directory beside the position index for exactly that reason.
   *
   * The write happens here and not in the console preview, which calls the
   * same pure functions and throws the result away — a person refreshing the
   * preview must not be able to advance the firing counts.
   */
  private async notificationsFile(tree: Tree, now: Date): Promise<PublishFile[]> {
    const { store, config, log } = this.deps;
    if (!config.publishNotifications) return [];

    const observed = readNotifications(tree);
    const previous = parseNotificationLog(
      await store.readText('notifications_log.json'),
      now,
    );
    const { log: updated, fired } = updateNotificationLog(previous, observed, now);
    await store.writeText('notifications_log.json', renderNotificationLog(updated));

    const active = observed.filter((item) => item.level !== 'ok');
    if (fired.length) {
      log(
        `Notifications: ${fired.length} fired this cycle ` +
          `(${fired.map((event) => `${event.path} ${event.state}`).join(', ')}).`,
      );
    }
    if (active.length) {
      log(
        `Notifications: ${active.length} active — ` +
          `${active.map((item) => `${item.path} ${item.state}`).join(', ')}.`,
      );
    }
    return [
      { path: NOTIFICATIONS_PATH, content: renderNotifications(updated, observed, now) },
    ];
  }

  /** Every published voyage, newest first, for the webapp's list. */
  async listTracks(): Promise<TrackMeta[]> {
    const tracks = parseTracksIndex(await this.deps.store.readText('tracks_index.json'));
    return [...tracks].sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * What a prune would remove, read straight from the published index.
   *
   * The webapp asks for this before it asks for the prune, so the confirmation
   * names the days rather than a number.
   */
  async planTrackPrune(request: PruneRequest): Promise<PrunePlan> {
    const { store, config } = this.deps;
    return planPrune(parseTracksIndex(await store.readText('tracks_index.json')), {
      request,
      now: this.now(),
      timezone: config.timezone,
    });
  }

  /**
   * Remove old voyages from the published site, in one commit.
   *
   * The GPX files go and the index is rewritten to match. `publishedDays` is
   * cleared of the removed days too: it exists to stop a past day being
   * rebuilt from a position index that no longer covers it, and leaving a
   * pruned day in it would be a day that can never come back even if its
   * points are still in the window.
   */
  async pruneTracks(request: PruneRequest): Promise<{ plan: PrunePlan; commitSha?: string }> {
    const { store, client, log } = this.deps;
    const plan = await this.planTrackPrune(request);
    if (!plan.remove.length) return { plan };

    const index = renderTracksIndex(plan.keep);
    const files: PublishFile[] = [{ path: TRACKS_INDEX_PATH, content: index }];
    // Deletions go through the same ownership check as writes: the manifest is
    // what stops a bug here reaching a path that belongs to the user, and a
    // deletion is the one that could not be undone by the next cycle.
    const { owned, rejected } = partitionOwned(
      plan.paths.map((path) => ({ path })),
      this.manifestOptions(''),
    );
    for (const file of rejected) log(`Refusing to delete unowned path: ${file.path}`);

    // Only delete what is actually there. The Git Data API rejects the whole
    // tree with a 422 if one entry names a path the base tree does not have,
    // and a day whose GPX was removed by hand on GitHub — or never published,
    // because the index is seeded from a repository that may have moved on —
    // would take the rest of the prune down with it. A file already gone is
    // the outcome we wanted anyway.
    let deletions = owned.map((file) => file.path);
    const listing = await client.listTree().catch(() => null);
    if (listing && !listing.truncated) {
      const present = new Set(listing.paths.map((entry) => entry.path));
      const missing = deletions.filter((path) => !present.has(path));
      if (missing.length) {
        log(`${missing.length} voyage file(s) were already gone from the repository.`);
        deletions = deletions.filter((path) => present.has(path));
      }
    }

    const description = describePrune(plan);
    const result = await publishFiles(client, files, `Remove ${description}`, { deletions });
    await store.writeText('tracks_index.json', index);
    const removed = new Set(plan.remove.map((track) => track.date));
    const state = await store.readState();
    await store.mergeState({
      publishedDays: (state.publishedDays ?? []).filter((day) => !removed.has(day)),
    });
    log(`Pruned ${description}; ${plan.keep.length} left on the site.`);
    return { plan, commitSha: result?.commitSha };
  }

  /**
   * What the repository's `docs/` looks like right now.
   *
   * Read straight from the branch tree with no ETag: this answers a person
   * pressing a button, and the one thing it must never do is say "no
   * documents" from a cached listing and let the next click write over a
   * repository that has forty.
   */
  async docsStatus(): Promise<DocsStatus> {
    const { client, seedDir } = this.deps;
    const listing = await client.listTree();
    const blobs = listing.paths.filter((node) => node.type === 'blob');
    const present = new Set(blobs.map((node) => node.path));
    const documents = blobs.filter((node) => isPublishedDoc(node.path)).map((node) => node.path);
    const seeds = await loadDocsSeed(seedDir, this.seedContext());
    const seeded = new Set([...seeds.map((file) => file.path), MAINTENANCE_LOG_PATH]);
    const missing = seeds.map((file) => file.path).filter((path) => !present.has(path));
    const ownDocuments = documents.filter((path) => !seeded.has(path)).length;
    return {
      initialized: documents.length > 0,
      documents: documents.length,
      documentPaths: documents.sort(),
      ownDocuments,
      missing,
      canInitialize: missing.length > 0 && ownDocuments === 0 && !listing.truncated,
      maintenanceLog: {
        path: MAINTENANCE_LOG_PATH,
        exists: present.has(MAINTENANCE_LOG_PATH),
      },
      truncated: listing.truncated,
    };
  }

  /**
   * Write the starter documents, once, into a repository that has none.
   *
   * Two guards, and they answer two different questions. "Does the repository
   * have a document of its own" decides whether initializing is the right
   * thing to do — a boat with its own docs does not want this plugin's
   * opinion about how to write them. "Does this exact path exist" decides
   * what goes in the commit, so a half-finished starter set can be completed
   * without the other half being rewritten.
   *
   * The starter files and the maintenance log are not documents "of its own":
   * an entry logged from the console before anyone pressed this button would
   * otherwise count as the boat's docs and lock the starter set out for
   * good.
   *
   * A truncated tree listing refuses the whole thing. GitHub caps a listing
   * at 100k entries, and past that cap absence proves nothing — which is the
   * one condition under which "there are no documents" could be a lie.
   */
  async initializeDocs(): Promise<DocsInitResult> {
    const { client, seedDir, log } = this.deps;
    const status = await this.docsStatus();
    if (status.truncated) {
      throw new Error(
        'The repository tree is too large to list in full, so the plugin cannot ' +
          'tell whether documents already exist. Add the starter files by hand.',
      );
    }
    if (status.ownDocuments > 0) {
      throw new DocsExistError(
        `${status.ownDocuments} document(s) are already in docs/; nothing was written.`,
      );
    }

    const seeds = await loadDocsSeed(seedDir, this.seedContext());
    const missing = new Set(status.missing);
    const create = seeds.filter((file) => missing.has(file.path));
    const skipped = seeds.filter((file) => !missing.has(file.path)).map((file) => file.path);
    for (const file of create) assertDocsPath(file.path);

    if (!create.length) {
      log('Ship\'s docs: every starter file is already in the repository.');
      return { created: [], skipped, status };
    }

    const result = await publishFiles(
      client,
      create,
      'Add the ship\'s docs starter set',
    );
    log(
      `Ship's docs initialized: ${create.map((file) => file.path).join(', ')}` +
        (skipped.length ? ` (${skipped.length} already present)` : '') +
        (result ? ` in ${result.commitSha.slice(0, 7)}.` : '.'),
    );
    return {
      created: create.map((file) => file.path),
      skipped,
      commitSha: result?.commitSha,
      status: await this.docsStatus(),
    };
  }

  /**
   * Add one entry to the top of the maintenance log.
   *
   * The published copy is read back first and the entry spliced into it: the
   * file is edited from a phone between publishes, and the boat's copy of it
   * is never authoritative. The log is not cached in the data directory at all —
   * there is no local copy to go stale.
   *
   * A lost ref race retries inside `publishFiles` with the same content. That
   * is correct for a telemetry file and slightly wrong here: an entry someone
   * committed by hand in the same second would be re-read on the retry and
   * this entry composed against the older text. The window is one HTTP
   * round trip on a file two people almost never write at once, and the
   * failure mode is a duplicate heading rather than lost prose.
   */
  async addMaintenanceEntry(entry: MaintenanceEntry): Promise<MaintenanceResult> {
    const { client, log } = this.deps;
    assertDocsPath(MAINTENANCE_LOG_PATH);
    const existing = await client.getFile(MAINTENANCE_LOG_PATH);
    const contents =
      existing === null
        ? renderMaintenanceLog(entry, this.seedContext())
        : insertMaintenanceEntry(existing, entry);

    const result = await publishFiles(
      client,
      [{ path: MAINTENANCE_LOG_PATH, content: contents }],
      `Maintenance ${entry.date}: ${entry.title}`,
    );
    log(
      `Maintenance log: ${existing === null ? 'created' : 'added to'} ` +
        `${MAINTENANCE_LOG_PATH} — ${entry.date}: ${entry.title}` +
        (result ? ` (${result.commitSha.slice(0, 7)}).` : '.'),
    );
    return {
      path: MAINTENANCE_LOG_PATH,
      created: existing === null,
      commitSha: result?.commitSha,
      entry,
    };
  }

  /** Engine hours the console's form offers as a starting value. */
  engineHours(tree: Tree): Array<{ engine: string; hours: number }> {
    return engineHours(tree);
  }

  /** The adopter's values, substituted into the starter documents. */
  private seedContext(): SeedContext {
    const { config, identity } = this.deps;
    const signalk = identity.signalk ?? {};
    const host = signalk.host ?? 'your-signalk-server';
    const port = signalk.port ?? 3000;
    const protocol = signalk.protocol ?? 'http';
    return {
      vesselName: identity.name || '',
      repo: config.github.repo,
      branch: config.github.branch,
      consoleUrl: `${protocol}://${host}:${port}/signalk-github-pages/`,
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
   * Paths this plugin used to write, removed once and then left alone.
   *
   * `data/vessel/info.yaml` is the only one so far: `site.json` replaced it,
   * and an install upgrading across that change would otherwise keep a file
   * in the repository that looks like live configuration, is not read by
   * anything, and will never be updated again.
   *
   * Checked against what is actually in the repository, because the Git Data
   * API rejects the whole tree with a 422 if an entry names a path the base
   * tree does not have — the same reason the voyage prune checks. A path that
   * is already gone is recorded as retired without a commit, so a fresh
   * install pays one `getFile` on its first cycle and nothing afterwards.
   */
  private async retirementDeletions(alreadyRetired: string[]): Promise<string[]> {
    const { client, log } = this.deps;
    const pending = RETIRED_PATHS.filter((path) => !alreadyRetired.includes(path));
    if (!pending.length) return [];

    const present: string[] = [];
    for (const path of pending) {
      const existing = await client.getFile(path).catch(() => null);
      if (existing !== null) present.push(path);
    }
    const { owned, rejected } = partitionOwned(
      present.map((path) => ({ path })),
      this.manifestOptions(''),
      { allowRetired: true },
    );
    for (const file of rejected) log(`Refusing to delete unowned path: ${file.path}`);
    if (owned.length) {
      log(`Removing ${owned.map((file) => file.path).join(', ')}: replaced by site.json.`);
    }
    return owned.map((file) => file.path);
  }

  /**
   * Rewrite `site.json` only when the rendered content actually changes.
   *
   * The fingerprint covers everything that goes into the file, the passage
   * included: a leg activated on the plotter should reach the site on the
   * next cycle, and nothing else should rewrite it. This is also why the
   * passage carries no ETA — see `course.ts`.
   */
  private async siteConfigFile(
    identity: VesselIdentity,
    passage: Passage | null,
  ): Promise<PublishFile[]> {
    const { store, config, log } = this.deps;
    const contents = renderSiteConfig(config, identity, passage, (problem) => log(problem));
    const previous = await store.readText('site.json');
    if (previous === contents) return [];

    await store.writeText('site.json', contents);
    log(
      previous === null
        ? `Writing ${SITE_CONFIG_PATH} for the first time.`
        : `Site configuration changed; rewriting ${SITE_CONFIG_PATH}.`,
    );
    return [{ path: SITE_CONFIG_PATH, content: contents }];
  }

  /**
   * `data/vessel/polars.csv`, when the server has an active polar.
   *
   * Nothing active writes nothing and claims nothing: the file is the user's
   * until Polar Management has a polar selected, and deselecting one later
   * leaves the last published file in the repository rather than deleting a
   * boat's performance data because a dropdown was cleared.
   */
  private async polarsFile(polars: string): Promise<PublishFile[]> {
    const { store, log } = this.deps;
    if (!polars) return [];
    const previous = await store.readText('polars.csv');
    if (previous === polars) return [];
    await store.writeText('polars.csv', polars);
    log(
      `${previous === null ? 'Publishing' : 'Republishing'} ${POLARS_PATH} ` +
        `(${polars.trim().split('\n').length - 1} wind angles).`,
    );
    return [{ path: POLARS_PATH, content: polars }];
  }

  /** What the plugin claims to own this cycle. */
  private manifestOptions(polars: string): ManifestOptions {
    const { config } = this.deps;
    return {
      buildDocsIndex: config.buildDocsIndex,
      publishPolars: polars !== '',
    };
  }

  private async manifestFile(polars: string): Promise<PublishFile[]> {
    const { store, version } = this.deps;
    const options = this.manifestOptions(polars);
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
    siteDir: string,
    version: string,
    publishedVersion: string | undefined,
  ): Promise<{ files: PublishFile[]; fingerprint: string | null }> {
    const { config, log } = this.deps;
    const fingerprint = `${version}:${config.github.repo}:${config.github.branch}:${config.instrumentLog.entries}`;
    if (publishedVersion === fingerprint) return { files: [], fingerprint: null };

    const files = await loadFrontend(siteDir, {
      repo: config.github.repo,
      branch: config.github.branch,
      instrumentLogEntries: config.instrumentLog.entries,
      version,
    });
    // The fingerprint is returned rather than stored here: recording it
    // before the commit lands means a publish that fails — a 502, a wedged
    // hotspot — leaves the plugin believing it has already shipped this
    // frontend, and the site keeps serving the previous release's JavaScript
    // until the next version bump. `runCycle` stores it once the commit is in.
    log(`Publishing frontend (${files.length} files, version ${version}).`);
    return { files, fingerprint };
  }

  /**
   * Make the next cycle republish every frontend file.
   *
   * The console's "rewrite the whole site" button. An upgrade already does
   * this by itself — the fingerprint carries the plugin version — so this is
   * for the cases version alone cannot see: a file deleted by hand on GitHub,
   * a half-finished commit, a repository restored from an older state.
   */
  async forceFrontendRepublish(): Promise<void> {
    await this.deps.store.mergeState({ frontendVersion: undefined });
    this.deps.log('Frontend marked for republishing: the next cycle rewrites every site file.');
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
