// Shared constants for the vessel tracker frontend.
// Magic numbers extracted here so thresholds are easy to find and tune.
// Must be loaded before app.js. Uses var (not const) so it is accessible
// as window.VESSEL_CONSTANTS from other scripts in the same page.

var VESSEL_CONSTANTS = Object.freeze({
  // ── Classification thresholds ────────────────────────────────────────────
  BATTERY_OK_PCT:       75,    // % state-of-charge → ok
  BATTERY_WARN_PCT:     45,    // % → warn (below is alert)
  BATTERY_TIME_OK_H:    6,     // hours remaining → ok
  BATTERY_TIME_WARN_H:  2,     // hours → warn (below is alert)

  ANCHOR_WARN_RATIO:    0.85,  // current/max ratio → ok below, warn above
  ANCHOR_EDGE_RATIO:    1.05,  // → warn below, alert above

  PACKET_LOSS_OK_PCT:   1,     // % packet loss → ok
  PACKET_LOSS_WARN_PCT: 3,     // % → warn (above is alert)

  TANK_OK_RATIO:        0.35,  // fill ratio → ok (above)
  TANK_WARN_RATIO:      0.20,  // → warn (below is alert)
  WASTE_WARN_RATIO:     0.40,  // fill ratio → ok (below)
  WASTE_ALERT_RATIO:    0.70,  // → warn (above is alert)

  // ── Cache TTLs (milliseconds) ────────────────────────────────────────────
  FORECAST_CACHE_TTL_MS: 60 * 60 * 1000,      // 1 hour
  TIDE_CACHE_TTL_MS:     3 * 60 * 60 * 1000,  // 3 hours

  // ── Data display ─────────────────────────────────────────────────────────
  // Upper bound on points drawn in one sparkline, not a window. The window is
  // chosen from HISTORY_WINDOWS; this only stops a very long, very fine log
  // from queueing tens of thousands of lineTo calls per card for sub-pixel
  // detail nobody can see. A card is at most ~400 CSS px wide.
  SPARKLINE_MAX_POINTS:     2000,
  DEFAULT_RECENT_TRACK_COUNT:  3,   // coloured track days shown by default

  // How far back the sparklines plot, offered in the panel header once
  // history is shown. What is actually selectable depends on the published
  // log: instrument_log.json covers `entries x resolution` (both set on the
  // plugin config page), and a window longer than that would draw the same
  // chart as the longest one that fits, so the frontend disables it rather
  // than pretending. Defaults to the shortest, which every log covers.
  HISTORY_WINDOWS: [
    { label: '1 hour',   hours: 1  },
    { label: '3 hours',  hours: 3  },
    { label: '12 hours', hours: 12 },
    { label: '24 hours', hours: 24 },
  ],
  HISTORY_WINDOW_DEFAULT_HOURS: 1,
  // Per-device UI state, like the unit and theme preferences.
  HISTORY_WINDOW_KEY: 'historyWindowHours',

  // Nothing here stands in for the boat's own position or the water it sits
  // in. Both used to: a fallback privacy zone at one particular dock and a
  // fallback tide location in San Francisco Bay, which any site that had not
  // published its info.yaml yet showed as its own. Unknown renders as
  // unknown — privacy_zones and default_location come from info.yaml or they
  // do not come at all.

  // ── Theming ──────────────────────────────────────────────────────────────
  // Cycle order for the floating theme button. Shared by index.html and
  // docs.html so the two pages never drift apart.
  THEMES:      ['marine', 'mermug', 'bright'],
  DARK_THEMES: ['marine', 'mermug'],

  // ── Ship's docs (docs.html) ──────────────────────────────────────────────
  DOCS_INDEX_URL: 'docs/index.json',
  // Sidebar section order. docs/index.json itself sorts categories
  // alphabetically (see scripts/build_docs_index.py) so the index stays
  // predictable to diff; this list is what actually controls the order
  // the sections render in. Categories not listed here sort alphabetically
  // after the ones that are.
  DOCS_CATEGORY_ORDER: ['Operations', 'Systems', 'Maintenance', 'Voyages'],
  // Checklist ticks are per-device UI state, not vessel data — they live in
  // localStorage under this prefix and are never committed anywhere.
  DOCS_CHECKLIST_PREFIX: 'mermug.checklist.',

  // ── GitHub (edit-in-place links) ────────────────────────────────────────
  // "Edit on GitHub" links (docs.js, the Voyages tab's "Log this voyage"
  // button) point here. Anyone can open the editor, but only collaborators
  // with push access can commit straight to GITHUB_DEFAULT_BRANCH — GitHub
  // routes everyone else through "fork + pull request" automatically, so
  // this alone is what keeps edits gated to contributors.
  GITHUB_REPO: 'zackphillips/zackphillips.github.io',
  GITHUB_DEFAULT_BRANCH: 'main',
  // Slug of docs/captains-log.md, used to build its edit link from the
  // Voyages tab without waiting on docs/index.json to load.
  CAPTAINS_LOG_PATH: 'docs/captains-log.md',

  // ── Data URLs ────────────────────────────────────────────────────────────
  TRACKS_INDEX_URL:     'data/telemetry/tracks_index.json',
  POSITIONS_INDEX_URL:  'data/telemetry/positions_index.json',
  INSTRUMENT_LOG_URL:   'data/telemetry/instrument_log.json',
  INSTRUMENT_LOG_ENTRIES: 120,  // must match backend INSTRUMENT_LOG_ENTRIES
});
