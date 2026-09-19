/**
 * `positions_index.json` — the rolling position history behind the map track.
 *
 * The file format is unchanged from the Python daemon so the frontend does not
 * have to know which publisher wrote it: a list of
 * `{timestamp, values: [{path, value}]}` entries, oldest first.
 */
import type { PrivacyZone } from './config';
import { privacyZoneCentre } from './privacy';
import type { PositionFix } from './snapshot';
import { parseTimestamp } from './time';

export interface PositionValue {
  path: string;
  value: any;
}

export interface PositionEntry {
  timestamp: string;
  values: PositionValue[];
}

export interface PositionIndex {
  schema_version: number;
  positions: PositionEntry[];
}

export const POSITION_INDEX_SCHEMA_VERSION = 1;

/** Read an index written by this plugin, by the old daemon, or by nothing. */
export function parsePositionIndex(raw: string | null | undefined): PositionEntry[] {
  if (!raw) return [];
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.positions)
      ? payload.positions
      : [];
  return list.filter((item: any) => item && typeof item === 'object');
}

export function renderPositionIndex(entries: PositionEntry[]): string {
  const payload: PositionIndex = {
    schema_version: POSITION_INDEX_SCHEMA_VERSION,
    positions: entries,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Build the index entry for one fix.
 *
 * Inside a privacy zone the entry carries the zone centre and nothing else:
 * speed and course would leak that the boat is manoeuvring in the harbour.
 */
export function buildPositionEntry(
  fix: PositionFix,
  zones: PrivacyZone[],
  now: Date,
): PositionEntry {
  const centre = privacyZoneCentre(zones, fix.latitude, fix.longitude);
  const timestamp = parseTimestamp(fix.timestamp) ?? now;
  const values: PositionValue[] = [
    {
      path: 'navigation.position',
      value: centre
        ? { latitude: centre.lat, longitude: centre.lon }
        : { latitude: fix.latitude, longitude: fix.longitude },
    },
  ];
  if (!centre) {
    if (fix.speedOverGround !== null) {
      values.push({ path: 'navigation.speedOverGround', value: fix.speedOverGround });
    }
    if (fix.courseOverGroundTrue !== null) {
      values.push({
        path: 'navigation.courseOverGroundTrue',
        value: fix.courseOverGroundTrue,
      });
    }
  }
  return { timestamp: timestamp.toISOString(), values };
}

/** Drop entries older than the retention window and keep the list ordered. */
export function pruneAndSort(
  entries: PositionEntry[],
  now: Date,
  retentionHours: number,
): PositionEntry[] {
  const cutoff = now.getTime() - retentionHours * 3_600_000;
  return entries
    .filter((entry) => {
      const ts = parseTimestamp(entry.timestamp);
      return ts !== null && ts.getTime() >= cutoff;
    })
    .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
}
