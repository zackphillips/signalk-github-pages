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
  SPARKLINE_POINTS:           60,   // number of history points per sparkline
  DEFAULT_RECENT_TRACK_COUNT:  3,   // coloured track days shown by default

  // Nothing here stands in for the boat's own position or the water it sits
  // in. Both used to: a fallback privacy zone at one particular dock and a
  // fallback tide location in San Francisco Bay, which any site that had not
  // published its info.yaml yet showed as its own. Unknown renders as
  // unknown — privacy_zones and default_location come from info.yaml or they
  // do not come at all.

  // ── Theming ──────────────────────────────────────────────────────────────
  // Cycle order for the floating theme button. Shared by index.html and
  // docs.html so the two pages never drift apart.
  THEMES:      ['marine', 'amber', 'bright'],
  DARK_THEMES: ['marine', 'amber'],

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
  DOCS_CHECKLIST_PREFIX: 'tracker.checklist.',

  // ── GitHub (edit-in-place links) ────────────────────────────────────────
  // "Edit on GitHub" links (docs.js, the Voyages tab's "Log this voyage"
  // button) point here. Anyone can open the editor, but only collaborators
  // with push access can commit straight to GITHUB_DEFAULT_BRANCH — GitHub
  // routes everyone else through "fork + pull request" automatically, so
  // this alone is what keeps edits gated to contributors.
  // Placeholders: src/frontend.ts substitutes the configured repository on the
  // way into the repository, and throws if it cannot find these lines. They
  // used to ship as one particular repository, which meant a substitution that
  // silently stopped matching sent every adopter's "edit on GitHub" links to
  // somebody else's repo.
  GITHUB_REPO: 'OWNER/REPO',
  GITHUB_DEFAULT_BRANCH: 'main',
  // The Voyages tab's "Log this voyage" button edits this file on GitHub. The
  // button is only rendered when docs/index.json actually lists it, so a site
  // without a captain's log does not offer to open one.
  CAPTAINS_LOG_PATH: 'docs/captains-log.md',

  // ── Data URLs ────────────────────────────────────────────────────────────
  TRACKS_INDEX_URL:     'data/telemetry/tracks_index.json',
  POSITIONS_INDEX_URL:  'data/telemetry/positions_index.json',
  INSTRUMENT_LOG_URL:   'data/telemetry/instrument_log.json',
  INSTRUMENT_LOG_ENTRIES: 120,  // must match backend INSTRUMENT_LOG_ENTRIES
});
