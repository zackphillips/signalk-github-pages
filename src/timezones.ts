/**
 * The IANA timezone list behind the config page's dropdown.
 *
 * Track grouping is by local calendar day, so the zone has to be right: UTC
 * midnight is mid-afternoon on the US west coast and cuts a day's sailing in
 * half. Typing the name by hand got that wrong in two ways — a typo fell back
 * to UTC silently, and "PST" is not an IANA zone at all — so the field is a
 * list of what this runtime actually accepts.
 *
 * The list comes from the runtime rather than from a table in this file: it is
 * the same data `Intl.DateTimeFormat` validates against, so every name offered
 * is one `localDay()` can use.
 */

/**
 * Enough of the list to keep the dropdown usable on a runtime built without
 * `Intl.supportedValuesOf` (Node 18 has it; a small-ICU build might not).
 * Not a curated "best" list — a fallback, with the server's own zone added by
 * the caller.
 */
const FALLBACK_TIMEZONES = [
  'Africa/Cape_Town',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Chicago',
  'America/Denver',
  'America/Halifax',
  'America/Los_Angeles',
  'America/New_York',
  'America/Panama',
  'America/Sao_Paulo',
  'America/St_Thomas',
  'America/Vancouver',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Atlantic/Azores',
  'Atlantic/Canary',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Oslo',
  'Europe/Paris',
  'Pacific/Auckland',
  'Pacific/Honolulu',
  'Pacific/Marquesas',
  'Pacific/Tahiti',
];

/** The zone the server itself is set to, or `'UTC'` if it will not say. */
export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Every IANA zone this runtime knows, sorted, with the server's own zone
 * guaranteed to be in it — otherwise an installation in an unusual zone could
 * not pick its own.
 */
export function availableTimezones(): string[] {
  const supported = (Intl as any).supportedValuesOf;
  let zones: string[] = [];
  try {
    if (typeof supported === 'function') zones = supported.call(Intl, 'timeZone');
  } catch {
    // Fall through to the short list.
  }
  if (!Array.isArray(zones) || zones.length === 0) zones = [...FALLBACK_TIMEZONES];
  const unique = new Set(zones);
  unique.add(serverTimezone());
  unique.delete('UTC');
  return [...unique].sort();
}
