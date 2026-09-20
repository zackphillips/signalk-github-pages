// Shared constants for the vessel tracker frontend.
// Magic numbers extracted here so thresholds are easy to find and tune.
// Must be loaded before app.js. Uses var (not const) so it is accessible
// as window.VESSEL_CONSTANTS from other scripts in the same page.

var VESSEL_CONSTANTS = Object.freeze({
  // ── Classification thresholds ────────────────────────────────────────────
  // There are none, deliberately. Battery, tank, anchor and packet-loss
  // thresholds used to live here as twelve constants, which meant every boat
  // publishing this site agreed that 45% state of charge is "Low" and a tank
  // under 20% needs refilling. Those numbers belong to a battery bank and a
  // tank, not to a dashboard: 45% is comfortable on 600Ah of LiFePO4 and
  // nearly flat on a tired 200Ah of AGM.
  //
  // The boat already knows. Signal K carries `meta.zones` on every path —
  // `[{lower, upper, state, message}]`, set on the server's Data Fiddler page
  // or by the plugin that owns the sensor — and the server is where an alarm
  // is configured anyway, so a threshold set here would be a second answer
  // that disagrees with the first one silently. app.js reads the zones off
  // the published snapshot and paints from those alone; a path with no zones
  // set renders uncoloured, the same way an unknown position renders as
  // unknown rather than as San Francisco.

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
  // published its site config yet showed as its own. Unknown renders as
  // unknown — privacy_zones and default_location come from site.json or they
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
  // Site configuration: privacy zones, custom links, the default position,
  // the timezone, the link back to the boat, the two derived registration
  // numbers, and the passage banner. Not the boat — that is in the snapshot.
  SITE_CONFIG_URL:      'data/vessel/site.json',
  INSTRUMENT_LOG_ENTRIES: 120,  // must match backend INSTRUMENT_LOG_ENTRIES
  NOTIFICATIONS_URL:    'data/telemetry/notifications.json',

  // ── Notifications ────────────────────────────────────────────────────────
  // Look-back windows for the firing counts, in hours. The largest must not
  // exceed NOTIFICATION_RETENTION_HOURS in src/notifications.ts — the plugin
  // prunes the event log to that window, so a 48-hour column here would read
  // as a quiet day and a half that nobody ever recorded.
  NOTIFICATION_WINDOWS_H: [1, 3, 12, 24],
});
