/**
 * The site as it would look right now, rendered locally and never published.
 *
 * The webapp serves `site/` over the plugin's own router and fills in the
 * `data/` tree from here, so the boat can look at its own dashboard on the LAN
 * — before the first publish, between cycles, or at anchor with no internet at
 * all. It is the same HTML, CSS and JavaScript that goes to GitHub Pages; only
 * where the JSON comes from is different.
 *
 * Nothing here writes: no state files, no commits, no counters. A preview is a
 * read, and someone refreshing it every few seconds while they tune a theme
 * must not be able to move the publisher's rolling state under it. That is why
 * this assembles the files rather than calling `runCycle`.
 *
 * What it cannot show is a past day's GPX. Those live in the repository, not
 * on the Pi; the position index holds 24 hours, so days are rebuilt from it
 * where they can be and simply missing where they cannot. The frontend already
 * isolates a panel that fails to load, which is what makes that acceptable.
 */
import type { Passage } from './course';
import type { PluginConfig } from './config';
import { groupPointsByDay, renderGpxDocument, TRACKS_INDEX_SCHEMA_VERSION } from './gpx';
import {
  parseNotificationLog,
  readNotifications,
  renderNotifications,
  updateNotificationLog,
} from './notifications';
import { parsePositionIndex } from './positions';
import { TRACKS_DIR } from './prune';
import { filterStaleData, redactPositions, type Tree } from './snapshot';
import type { StateStore } from './state';
import { localDay } from './time';
import { mergeVesselIdentity, readVesselDetails, renderSiteConfig, type VesselIdentity } from './siteConfig';

const TELEMETRY_DIR = 'data/telemetry';

export interface PreviewDeps {
  config: PluginConfig;
  store: StateStore;
  /** Identity from the server process, the same one the publisher is given. */
  identity: VesselIdentity;
  now?: () => Date;
}

export interface PreviewInput {
  tree: Tree;
  /** The polar CSV the last cycle resolved, or empty. */
  polars: string;
  /**
   * The passage the last cycle read, or null. Handed in rather than read
   * here: the console must not be able to make the boat call the Course API.
   */
  passage?: Passage | null;
}

/**
 * Build the `data/**` files the frontend fetches, keyed by repository path.
 *
 * Returns text only: everything the site reads under `data/` is JSON, CSV or
 * GPX.
 */
export async function renderPreviewData(
  deps: PreviewDeps,
  input: PreviewInput,
): Promise<Map<string, string>> {
  const { config, store, identity } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const files = new Map<string, string>();

  // The same three steps the publisher takes, in the same order: drop stale
  // values, then redact the position. A preview that showed the true position
  // inside a privacy zone would be a quiet way to learn the zone was not
  // working only after it had been published.
  const tree = filterStaleData(JSON.parse(JSON.stringify(input.tree)) as Tree, {
    maxAgeMinutes: config.staleMaxAgeMinutes,
    referenceTime: now,
  });
  const merged = mergeVesselIdentity(identity, readVesselDetails(tree));
  redactPositions(tree, config.privacyZones);

  files.set(
    `${TELEMETRY_DIR}/signalk_latest.json`,
    `${JSON.stringify({ schema_version: 1, ...tree }, null, 2)}\n`,
  );

  for (const [name, path] of [
    ['positions_index.json', `${TELEMETRY_DIR}/positions_index.json`],
    ['instrument_log.json', `${TELEMETRY_DIR}/instrument_log.json`],
    ['tracks_index.json', `${TELEMETRY_DIR}/tracks_index.json`],
  ] as const) {
    const contents = await store.readText(name);
    if (contents !== null) files.set(path, contents);
  }
  if (!files.has(`${TELEMETRY_DIR}/tracks_index.json`)) {
    files.set(
      `${TELEMETRY_DIR}/tracks_index.json`,
      `${JSON.stringify({ schema_version: TRACKS_INDEX_SCHEMA_VERSION, tracks: [] }, null, 2)}\n`,
    );
  }

  // Days rebuilt from the retention window. A published day older than that is
  // not on this machine to serve.
  const entries = parsePositionIndex(await store.readText('positions_index.json'));
  const byDay = groupPointsByDay(entries, {
    zones: config.privacyZones,
    timezone: config.timezone,
  });
  for (const [day, points] of byDay) {
    points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    files.set(
      `${TRACKS_DIR}/${day}.gpx`,
      renderGpxDocument(points, day, merged.name || 'Vessel'),
    );
  }

  // The firing log is folded forward in memory and thrown away: the preview
  // shows what the next publish would say, without being the thing that says
  // it. Writing here would let a phone left on the preview page roll the
  // counts forward and then lose the edge the real cycle needed to see.
  if (config.publishNotifications) {
    const observed = readNotifications(tree);
    const stored = parseNotificationLog(await store.readText('notifications_log.json'), now);
    const { log } = updateNotificationLog(stored, observed, now);
    files.set(`${TELEMETRY_DIR}/notifications.json`, renderNotifications(log, observed, now));
  }

  // The preview has no passage: reading the Course API is an async server
  // call, and the console must not be able to make the boat do work.
  files.set('data/vessel/site.json', renderSiteConfig(config, merged, input.passage ?? null));
  if (input.polars) files.set('data/vessel/polars.csv', input.polars);

  return files;
}

/** Local calendar day, for the webapp's "today is never pruned" note. */
export const previewToday = (config: PluginConfig, now = new Date()): string =>
  localDay(now, config.timezone);
