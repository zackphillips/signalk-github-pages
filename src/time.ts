/** Timestamp helpers shared by the position index, the GPX writer and the log. */

/** Parse an ISO-8601 timestamp, tolerating "Z" and a missing zone (= UTC). */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const parsed = new Date(hasZone ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** ISO-8601 in UTC with whole seconds — the format GPX wants. */
export function formatGpxTime(timestamp: string): string {
  const parsed = parseTimestamp(timestamp);
  if (!parsed) return timestamp;
  return `${parsed.toISOString().slice(0, 19)}Z`;
}

/**
 * Calendar day (YYYY-MM-DD) of an instant in the vessel's local timezone.
 *
 * Tracks are grouped by local day, not by the UTC date in the timestamp:
 * UTC midnight is mid-afternoon on the US west coast, so a UTC grouping cuts
 * a day's sailing in half. An unknown timezone name falls back to UTC rather
 * than throwing — a typo in the config must not stop the publish.
 */
export function localDay(date: Date, timezone: string): string {
  if (!timezone) return date.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** True when the IANA zone name is one this runtime knows. */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
