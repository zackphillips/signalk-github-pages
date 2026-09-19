/**
 * Per-day GPX tracks and the index the frontend lists them from.
 *
 * Tracks are built straight from the position index in the same cycle. The
 * daemon used to write one snapshot file per cycle and rebuild tracks from
 * those; ~32k of them accumulated behind an off-by-one prune and grew the
 * repository past a gigabyte. Nothing else should ever be written per cycle.
 */
import type { PrivacyZone } from './config';
import { haversineMetres, isPositionPrivate } from './privacy';
import type { PositionEntry, PositionValue } from './positions';
import { formatGpxTime, localDay, parseTimestamp } from './time';

const NS_GPX = 'http://www.topografix.com/GPX/1/1';
const NS_GPXTPX = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';

export interface TrackPoint {
  timestamp: string;
  latitude: number;
  longitude: number;
  speed_ms: number | null;
  course_rad: number | null;
}

export interface TrackMeta {
  date: string;
  file: string;
  start: string;
  end: string;
  duration_hours: number;
  points: number;
  max_speed_kts: number;
  distance_nm: number;
}

export const TRACKS_INDEX_SCHEMA_VERSION = 1;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Pull lat/lon/speed/course out of one position-index entry's values list. */
export function extractPosFromValues(values: PositionValue[] | undefined): {
  lat: number | null;
  lon: number | null;
  speed: number | null;
  course: number | null;
} {
  let lat: number | null = null;
  let lon: number | null = null;
  let speed: number | null = null;
  let course: number | null = null;
  for (const entry of values ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const { path, value } = entry;
    if (path === 'navigation.position' && value && typeof value === 'object') {
      lat = typeof value.latitude === 'number' ? value.latitude : null;
      lon = typeof value.longitude === 'number' ? value.longitude : null;
    } else if (path === 'navigation.speedOverGround' && typeof value === 'number') {
      speed = value;
    } else if (path === 'navigation.courseOverGroundTrue' && typeof value === 'number') {
      course = value;
    }
  }
  return { lat, lon, speed, course };
}

/** Serialise one day's points as a GPX 1.1 document (without the XML header). */
export function buildDayGpx(
  points: TrackPoint[],
  dateStr: string,
  vesselName: string,
): string {
  const name = escapeXml(`${vesselName} — ${dateStr}`);
  const lines: string[] = [];
  lines.push(
    `<gpx xmlns="${NS_GPX}" xmlns:gpxtpx="${NS_GPXTPX}" version="1.1" creator="${escapeXml(vesselName)}">`,
  );
  lines.push('  <metadata>');
  lines.push(`    <name>${name}</name>`);
  lines.push(`    <time>${formatGpxTime(points[0]!.timestamp)}</time>`);
  lines.push('  </metadata>');
  lines.push('  <trk>');
  lines.push(`    <name>${name}</name>`);
  lines.push('    <trkseg>');
  for (const point of points) {
    const lat = point.latitude.toFixed(6);
    const lon = point.longitude.toFixed(6);
    const hasExtension = point.speed_ms !== null || point.course_rad !== null;
    lines.push(`      <trkpt lat="${lat}" lon="${lon}">`);
    lines.push(`        <time>${formatGpxTime(point.timestamp)}</time>`);
    if (hasExtension) {
      lines.push('        <extensions>');
      lines.push('          <gpxtpx:TrackPointExtension>');
      if (point.speed_ms !== null) {
        lines.push(`            <gpxtpx:speed>${point.speed_ms.toFixed(3)}</gpxtpx:speed>`);
      }
      if (point.course_rad !== null) {
        const degrees = (((point.course_rad * 180) / Math.PI) % 360 + 360) % 360;
        lines.push(`            <gpxtpx:course>${degrees.toFixed(1)}</gpxtpx:course>`);
      }
      lines.push('          </gpxtpx:TrackPointExtension>');
      lines.push('        </extensions>');
    }
    lines.push('      </trkpt>');
  }
  lines.push('    </trkseg>');
  lines.push('  </trk>');
  lines.push('</gpx>');
  return lines.join('\n');
}

export function renderGpxDocument(
  points: TrackPoint[],
  dateStr: string,
  vesselName: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${buildDayGpx(points, dateStr, vesselName)}\n`;
}

const round = (value: number, digits: number): number =>
  Number.parseFloat(value.toFixed(digits));

/** Summary row for one day: distance, duration, peak speed, point count. */
export function makeTrackMeta(dateStr: string, points: TrackPoint[]): TrackMeta {
  let totalNm = 0;
  let maxSpeedKts = 0;
  points.forEach((point, index) => {
    if (point.speed_ms !== null) {
      maxSpeedKts = Math.max(maxSpeedKts, point.speed_ms * 1.94384);
    }
    if (index > 0) {
      const previous = points[index - 1]!;
      totalNm +=
        haversineMetres(
          previous.latitude,
          previous.longitude,
          point.latitude,
          point.longitude,
        ) / 1852;
    }
  });
  const startTs = points[0]!.timestamp;
  const endTs = points[points.length - 1]!.timestamp;
  const start = parseTimestamp(startTs);
  const end = parseTimestamp(endTs);
  const durationHours =
    start && end ? (end.getTime() - start.getTime()) / 3_600_000 : 0;
  return {
    date: dateStr,
    file: `tracks/${dateStr}.gpx`,
    start: formatGpxTime(startTs),
    end: formatGpxTime(endTs),
    duration_hours: round(durationHours, 2),
    points: points.length,
    max_speed_kts: round(maxSpeedKts, 1),
    distance_nm: round(totalNm, 2),
  };
}

/**
 * Group position-index entries into local calendar days, dropping any point
 * that falls inside a privacy zone.
 *
 * Private points are dropped rather than snapped to the zone centre: a track
 * that sat at the dock overnight would otherwise be a pile of identical
 * points, and "the boat was here" is exactly what the zone exists to hide.
 */
export function groupPointsByDay(
  entries: PositionEntry[],
  options: { zones: PrivacyZone[]; timezone: string },
): Map<string, TrackPoint[]> {
  const byDay = new Map<string, TrackPoint[]>();
  for (const entry of entries) {
    const timestamp = entry?.timestamp;
    const { lat, lon, speed, course } = extractPosFromValues(entry?.values);
    if (lat === null || lon === null || !timestamp) continue;
    if (isPositionPrivate(options.zones, lat, lon)) continue;
    const parsed = parseTimestamp(timestamp);
    if (!parsed) continue;
    const day = localDay(parsed, options.timezone);
    const points = byDay.get(day) ?? [];
    points.push({
      timestamp,
      latitude: lat,
      longitude: lon,
      speed_ms: speed,
      course_rad: course,
    });
    byDay.set(day, points);
  }
  return byDay;
}

export interface TrackUpdate {
  /** Repo-relative path -> GPX document, for days that changed this cycle. */
  files: Record<string, string>;
  index: TrackMeta[];
}

/**
 * Work out which GPX files this cycle should write and what the index becomes.
 *
 * Today's file is rewritten every cycle so it grows through the sailing day.
 * A past day that already has a published file is left alone: the position
 * index only holds the last 24 hours, so rebuilding it from what is left
 * would truncate a day that was already complete.
 */
export function updateTracks(
  entries: PositionEntry[],
  options: {
    zones: PrivacyZone[];
    timezone: string;
    vesselName: string;
    now: Date;
    existingIndex: TrackMeta[];
    publishedDays: ReadonlySet<string>;
  },
): TrackUpdate {
  const byDay = groupPointsByDay(entries, options);
  const files: Record<string, string> = {};
  const index = new Map<string, TrackMeta>(
    options.existingIndex.filter((track) => track && track.date).map((track) => [track.date, track]),
  );
  if (byDay.size === 0) {
    return { files, index: [...index.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  }

  const today = localDay(options.now, options.timezone);
  for (const [day, points] of byDay) {
    points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (day !== today && options.publishedDays.has(day)) {
      if (!index.has(day)) index.set(day, makeTrackMeta(day, points));
      continue;
    }
    files[`data/telemetry/tracks/${day}.gpx`] = renderGpxDocument(
      points,
      day,
      options.vesselName,
    );
    index.set(day, makeTrackMeta(day, points));
  }

  return {
    files,
    index: [...index.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function parseTracksIndex(raw: string | null | undefined): TrackMeta[] {
  if (!raw) return [];
  try {
    const payload = JSON.parse(raw);
    const list = Array.isArray(payload) ? payload : payload?.tracks;
    return Array.isArray(list) ? list.filter((t: any) => t && typeof t.date === 'string') : [];
  } catch {
    return [];
  }
}

export function renderTracksIndex(tracks: TrackMeta[]): string {
  return `${JSON.stringify({ schema_version: TRACKS_INDEX_SCHEMA_VERSION, tracks }, null, 2)}\n`;
}
