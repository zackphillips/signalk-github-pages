/**
 * The self tree: reading it out of the running server, dropping stale values,
 * and redacting the position before anything is written anywhere.
 *
 * The Python daemon polled `/signalk/v1/api/vessels/self` over HTTP. Inside
 * the server process the same tree is a function call, so a wedged HTTP
 * connection can no longer freeze the site on stale data.
 */
import type { PrivacyZone } from './config';
import { privacyZoneCentre, type ZoneCentre } from './privacy';
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
    // The daemon recorded headingTrue here; keep that so existing GPX and the
    // frontend's course arrow stay consistent across the cutover.
    courseOverGroundTrue: numeric(navigation.headingTrue),
  };
}

/**
 * Replace the position in the snapshot with the zone centre when the boat is
 * inside a privacy zone. Mutates and returns the blob, and reports which zone
 * matched so the caller can log it and pace itself.
 */
export function redactPosition(blob: Tree, zones: PrivacyZone[]): ZoneCentre | null {
  const fix = extractPositionFix(blob);
  if (!fix) return null;
  const centre = privacyZoneCentre(zones, fix.latitude, fix.longitude);
  if (!centre) return null;
  const value = blob.navigation.position.value;
  value.latitude = centre.lat;
  value.longitude = centre.lon;
  return centre;
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
