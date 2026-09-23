/**
 * The self tree: reading it out of the running server, dropping stale values,
 * and redacting the position before anything is written anywhere.
 *
 * Reading the tree is a function call inside the server process, not an HTTP
 * poll of `/signalk/v1/api/vessels/self`, so a wedged connection cannot
 * freeze the site on stale data.
 */
import type { PrivacyZone } from './config';
import { isExcludedPath } from './instrumentLog';
import { privacyZoneCenter, type ZoneCenter } from './privacy';
import type { SignalKApp } from './signalk';

export type Tree = Record<string, any>;

/** Sections whose values go stale in a way the UI must not present as live. */
export const STALE_FILTER_KEYS = ['environment', 'navigation', 'entertainment'] as const;

/**
 * What reading a snapshot needs of the server.
 *
 * `getSelfPath` and `getPath` are the server's published accessors, taken
 * from its own type so a rename shows up here at build time. The other two
 * are not in that contract: `signalk.retrieve()` is the internal full-model
 * accessor older servers exposed, kept as a last resort and typed as the
 * reach-past-the-contract that it is.
 */
export type SelfTreeSource = Partial<Pick<SignalKApp, 'getSelfPath' | 'getPath'>> & {
  signalk?: { retrieve?: () => unknown };
  selfId?: string;
  selfContext?: string;
};

/**
 * Best-effort read of the whole self tree.
 *
 * The server exposes it under several names depending on version, so try the
 * documented one first and fall back rather than pinning a server release.
 */
export function readSelfTree(app: SelfTreeSource): Tree {
  const candidates: Array<() => any> = [
    () => app.getSelfPath?.(''),
    () => app.getPath?.('vessels.self'),
    () => {
      const full = app.signalk?.retrieve?.() as
        | { vessels?: Record<string, unknown> }
        | undefined;
      const id = app.selfId ?? (app.selfContext ?? '').replace(/^vessels\./, '');
      return id ? full?.vessels?.[id] : undefined;
    },
  ];
  for (const read of candidates) {
    try {
      const tree = read();
      if (tree && typeof tree === 'object' && !Array.isArray(tree)) {
        return JSON.parse(JSON.stringify(tree)) as Tree;
      }
    } catch {
      // Try the next accessor.
    }
  }
  return {};
}

/**
 * Drop values whose timestamp is older than `maxAgeMinutes` from the named
 * sections, so the frontend renders them as unavailable instead of showing a
 * two-day-old wind reading as the current one.
 *
 * A node that goes stale loses `value` and `timestamp` but keeps its children
 * and metadata; a node left with nothing at all is removed.
 */
export function filterStaleData(
  blob: Tree,
  options: {
    maxAgeMinutes: number;
    targetKeys?: readonly string[];
    referenceTime?: Date;
  },
): Tree {
  const { maxAgeMinutes, targetKeys = STALE_FILTER_KEYS, referenceTime } = options;
  if (!blob || typeof blob !== 'object' || maxAgeMinutes <= 0) return blob;

  const cutoff = (referenceTime ?? new Date()).getTime() - maxAgeMinutes * 60_000;

  const prune = (node: any): any => {
    if (Array.isArray(node)) {
      const cleaned = node.map(prune).filter((item) => item !== null && item !== undefined);
      return cleaned.length ? cleaned : null;
    }
    if (node && typeof node === 'object') {
      let entries = Object.entries(node);
      const timestamp = (node as any).timestamp;
      if (typeof timestamp === 'string') {
        const parsed = Date.parse(timestamp);
        if (!Number.isNaN(parsed) && parsed < cutoff) {
          entries = entries.filter(([key]) => key !== 'value' && key !== 'timestamp');
        }
      }
      const cleaned: Record<string, any> = {};
      for (const [key, value] of entries) {
        const pruned = prune(value);
        if (pruned !== null && pruned !== undefined) cleaned[key] = pruned;
      }
      return Object.keys(cleaned).length ? cleaned : null;
    }
    return node;
  };

  for (const key of targetKeys) {
    if (!(key in blob)) continue;
    const pruned = prune(blob[key]);
    if (pruned === null) delete blob[key];
    else blob[key] = pruned;
  }
  return blob;
}

/**
 * Remove every path the adopter has hidden, subtree and all.
 *
 * The dashboard draws whatever the snapshot carries, so this is what takes a
 * card off the site — and, since the snapshot is a public file, what keeps
 * the value out of the repository rather than merely out of view. Metadata
 * rides along with its node: a hidden path leaves no `meta` behind either.
 *
 * Mutates the blob. Returns the paths removed, for the log.
 */
export function hidePaths(blob: Tree, patterns: string[]): string[] {
  const removed: string[] = [];
  if (!patterns.length || !blob || typeof blob !== 'object') return removed;
  const visit = (node: Record<string, any>, prefix: string): void => {
    for (const key of Object.keys(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isExcludedPath(path, patterns)) {
        delete node[key];
        removed.push(path);
        continue;
      }
      const child = node[key];
      // `value`, `meta` and `values` are a leaf's own fields, not children
      // with paths of their own.
      if (key === 'value' || key === 'meta' || key === 'values') continue;
      if (child && typeof child === 'object' && !Array.isArray(child)) visit(child, path);
    }
  };
  visit(blob, '');
  return removed;
}

export interface PositionFix {
  latitude: number;
  longitude: number;
  timestamp: string | null;
  speedOverGround: number | null;
  courseOverGroundTrue: number | null;
}

/** Pull the position fix (and the two values the track needs) out of a tree. */
export function extractPositionFix(blob: Tree): PositionFix | null {
  const navigation = blob?.navigation;
  if (!navigation || typeof navigation !== 'object') return null;
  const value = navigation.position?.value;
  if (!value || typeof value !== 'object') return null;
  const { latitude, longitude } = value;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;

  const numeric = (node: any): number | null =>
    node && typeof node === 'object' && typeof node.value === 'number' ? node.value : null;

  return {
    latitude,
    longitude,
    timestamp:
      typeof navigation.position?.timestamp === 'string'
        ? navigation.position.timestamp
        : null,
    speedOverGround: numeric(navigation.speedOverGround),
    // headingTrue, not courseOverGroundTrue, despite the field name: it is
    // what the published GPX has always carried and what the frontend's
    // course arrow reads.
    courseOverGroundTrue: numeric(navigation.headingTrue),
  };
}

/** A node that looks like a Signal K position: numeric lat and lon. */
function isPositionValue(node: unknown): node is { latitude: number; longitude: number } {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const { latitude, longitude } = node as Record<string, unknown>;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)
  );
}

export interface RedactionResult {
  /** The zone the vessel itself is in, for the log line and the cadence. */
  vesselZone: ZoneCenter | null;
  /** Every path that was moved to a zone center, for the log. */
  redacted: string[];
}

/**
 * Move every position inside a privacy zone to that zone's center.
 *
 * The rule used to be "if the vessel is inside a zone, rewrite
 * `navigation.position`", which guarded exactly one path out of a tree that
 * has several. `navigation.anchor.position` is the one that mattered: anchor
 * inside a privacy zone and the site showed the zone center for the boat
 * while publishing the true anchor drop coordinates a few keys away in the
 * same file — the frontend even reads it, to draw the anchor marker. An
 * allowlist of known paths would need extending every time the spec or a
 * plugin grew another one, so this walks the tree instead.
 *
 * The rule is now per-position rather than per-vessel: *any* published
 * position that falls inside a privacy zone becomes that zone's center,
 * wherever it sits in the tree. That generalises the old behavior rather
 * than special-casing, and it is deliberately not "redact everything while
 * the vessel is home" — a destination in `navigation.course.nextPoint` is
 * where the boat is going, not where it is, and snapping it to the home dock
 * would corrupt the data without protecting anything. A destination that
 * happens to be inside a zone is redacted, which is correct.
 *
 * Mutates the blob. Returns the zone the vessel is in, if any, because that
 * is what the status line and the log mean by "in <zone>".
 */
export function redactPositions(blob: Tree, zones: PrivacyZone[]): RedactionResult {
  const redacted: string[] = [];
  if (!zones.length) return { vesselZone: null, redacted };

  const visit = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (isPositionValue(node)) {
      const center = privacyZoneCenter(zones, node.latitude, node.longitude);
      if (center) {
        node.latitude = center.lat;
        node.longitude = center.lon;
        redacted.push(path);
      }
      // A position has no children worth walking, and `altitude` is not one
      // this plugin publishes.
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      visit(value, path ? `${path}.${key}` : key);
    }
  };
  visit(blob, '');

  // Read after the walk: the vessel's own position has been moved to the
  // center by now, and asking which zone that center is in gives the same
  // answer as asking before.
  const fix = extractPositionFix(blob);
  const vesselZone = fix ? privacyZoneCenter(zones, fix.latitude, fix.longitude) : null;
  return { vesselZone, redacted };
}

/** `navigation.state` as the server reports it, lowercased, or null. */
export function navigationState(blob: Tree): string | null {
  const value = blob?.navigation?.state?.value;
  return typeof value === 'string' && value ? value.toLowerCase() : null;
}

/** States that mean "moving": everything else gets the slow cadence. */
const UNDERWAY_STATES = new Set([
  'sailing',
  'motoring',
  'motorsailing',
  'under way sailing',
  'under way using engine',
  'towing',
  'being towed',
  'fishing',
  'driving',
]);

export function isUnderway(state: string | null): boolean {
  if (!state) return false;
  return UNDERWAY_STATES.has(state);
}
