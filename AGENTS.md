# AGENTS.md — working on signalk-github-pages

A Signal K server plugin that publishes vessel telemetry to a GitHub Pages
repository. Read `README.md` first for what it does; this file is what to know
before changing it.

## Layout

```
src/
  index.ts          Plugin entry: schema, start/stop, tick scheduling, router
  config.ts         Config schema, defaults, normalisation, validation
  publisher.ts      One cycle end to end — the only module that orchestrates
  webapp.ts         The console's routes: status, preview, prune, docs
  preview.ts        The site's data files rendered live, never published
  prune.ts          Which voyages a prune takes, decided without doing it
  snapshot.ts       Reading the self tree, stale filter, position redaction
  privacy.ts        Haversine, privacy zones
  positions.ts      positions_index.json
  instrumentLog.ts  instrument_log.json: its shape and the path matcher
  notifications.ts  notifications.json: the notification tree flattened, and
                    the firing log that turns states into edges
  notificationRecorder.ts
                    Notification deltas, so a firing between publishes counts
  history.ts        The Signal K History API: the instrument log, read back
                    from a provider instead of accumulated here
  gpx.ts            Per-day GPX files and tracks_index.json
  docsIndex.ts      docs/index.json (port of the old Python builder)
  docsSeed.ts       The starter documents and the maintenance log: the only
                    writes that reach a path the plugin does not own
  siteConfig.ts     data/vessel/site.json, and the boat read off the self tree
  course.ts         The passage banner, from the Course API
  polars.ts         data/vessel/polars.csv from the active `polars` resource
  timezones.ts      The IANA list the timezone dropdown offers
  logo.ts           The config page's logo field, decoded into bytes and a path
  frontend.ts       Reading site/ and templating what belongs to the adopter
  github.ts         Git Data API client and the publish-with-retry
  manifest.ts       Ownership allowlist — what the plugin may write
  state.ts          Rolling state in the plugin data dir, atomic writes
  track.ts          navigation.position deltas, decimated by shape
  alarm.ts          The one notification this plugin raises, and when
  signalk.ts        The server's own types, and the two this plugin narrows
site/               The published site, shipped in the npm package
public/             The console webapp; Signal K mounts it at /signalk-github-pages/
seed/               Starter documents copied into docs/ once, on request
sample/             Fixture telemetry for `npm run dev`
test/               vitest, including an in-memory GitHub fake
```

## Commands

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm run dev       # site/ + sample/ on http://localhost:8000
```

Run `npm test` and `npm run typecheck` before committing.

## Rules that are not obvious

- **`publisher.ts` takes a tree and returns a result.** It never calls the
  Signal K server. Keep it that way: it is what makes a full cycle testable
  without a server or a network. Anything that needs an async server call —
  the active polar and the instrument history — is read in `index.ts` and
  passed in as `CycleInput`.
- **No free-form config.** `site.extraYaml` was YAML merged over everything
  the plugin wrote: an override with no schema, no validation and no way to
  tell from the config page what the published file would end up saying. A
  new key is a typed field and a line in `renderSiteConfig`, not a blob.
  `grep vesselData\. site/assets/app.js` lists every key the frontend reads;
  each one needs a source before a field is removed.
- **Nothing on the site is hand-edited, and nothing should become so.** The
  last two things that were are gone: `info.yaml`, which carried the site
  configuration, and the `passage:` block inside it, which someone had to
  type before departure and delete on arrival — and therefore forgot, so a
  boat home for a fortnight still said it was bound for Santa Cruz. A value
  the boat already knows is read from the server; a value the adopter chooses
  is a typed field on the config page. If a new feature needs a person to
  edit a file in the published repository, that is a design smell — the one
  deliberate exception is `docs/*.md`, which is prose with no other source,
  and `assets/custom.css`.
- **`site.json` is site configuration, not the boat.** Everything about the
  vessel — name, MMSI, callsign, UUID, IMO, flag, home port, registrations,
  dimensions — is in `data/telemetry/signalk_latest.json`, which is the whole
  self tree. It used to be in both, and the frontend preferred the snapshot
  and treated the other as a fallback, so the duplicate only ever had one
  possible effect: disagreeing. What stays in `site.json` is what has no
  other source (privacy zones, custom links, the default position, the
  timezone, the address the site links back to), plus the USCG and hull
  numbers, which are here because picking them out of a `registrations` tree
  is a judgement the plugin already makes and the frontend should not make
  twice.
- **The passage comes from the Course API and carries no coordinates.**
  `nextPoint.position` and `previousPoint.position` are raw positions, and
  the privacy zones guard `navigation.position` on its way into the snapshot
  and the track — not a course. A point with no name contributes nothing
  rather than falling back to its position, which is why activating a
  waypoint usually yields a destination and no "from": `previousPoint` is the
  vessel's own position at activation, and publishing it would put the slip
  the boat just left on a public page. The ETA is left out for a different
  reason: `targetArrivalTime` is recomputed on every update, and `site.json`
  is only rewritten when its content changes.
- **A retired path is removable but not owned.** `ownedPatterns` is what the
  published manifest lists and what `isOwnedPath` allows writing.
  `RETIRED_PATTERNS` is a path this plugin used to write and now only deletes
  — `data/vessel/info.yaml` so far — so it is absent from the manifest, which
  would otherwise tell the repository's owner it is still maintained, while
  `isRemovablePath` still lets the one-time deletion through the same
  ownership check every other deletion passes. The deletion is recorded in
  `state.retired` only after the commit carrying it landed.
- **Unknown renders as unknown.** The frontend carried seven invented
  fallbacks, each of which turned a missing value into a confident wrong one
  on somebody else's boat: a San Francisco Bay tide location; a privacy zone
  at one particular dock; a whole vessel identity (name, MMSI, documentation
  number) used when the vessel config failed to load; a one-station tide list
  — San Francisco again — used when `tide_stations.json` failed to load, so
  that every boat's "nearest station" was the Golden Gate; a box drawn around
  37.7-37.9 / -122.5 to -122.3 inside which the station picker returned 9414290
  whatever the position said, which was one boat's home waters written into
  everybody's picker; a retry of any failed NOAA fetch against San Francisco
  "because it is known to work", which drew real tides for water 3000 miles
  away under this boat's heading; and a fabricated snapshot (a position in the
  Bay, 10 knots of true wind, a house bank at 12.5 V and 80%) shown whenever
  `signalk_latest.json` would not load, so a boat whose publishing had failed
  showed someone ashore a plausible afternoon's sailing. All of them are gone.
  `resolveTidePosition` returns null and the panels say what is missing;
  `getPrivacyZones` returns an empty list, which is safe because the plugin
  already redacts before it publishes; `stationsByDistance` sorts by distance
  and nothing else; a failed station list is empty; a failed NOAA fetch
  throws; a failed snapshot is `{}` and the banner reads "Telemetry
  unavailable". They were found in four separate passes, so assume there is
  another. If a value is not known, the page says so.
- **The map draws the zones it is redacting against.** `drawPrivacyZones`
  renders `privacy_zones` from `site.json`, and no zones means no rings. The
  ring used to be a literal at one dock in San Francisco, drawn on every
  adopter's map while their own zones were never drawn — a redaction claim
  false in both directions, which is worse than the fallbacks above: a ring on
  the map is a promise about the data beside it.- **A published URL is an `href` on someone else's browser.** `customLinks`
  entries are checked for an http/https scheme in `resolveConfig` *and* again
  in `renderCustomLinks`, because `info.yaml` is a file in a public repository
  that anyone with write access can edit. One check is a config validation;
  two is a policy.
- **The server's types come from the server.** `@signalk/server-api` is a
  devDependency and `src/signalk.ts` is the only file that imports it. Every
  module that touches the app object takes its slice from `SignalKApp`
  (`Pick`/`Partial<Pick<...>>`) rather than describing the method again
  locally: a structural interface of one's own compiles against a server that
  no longer has the method, and fails on the boat instead. Two members are
  narrowed to optional there — `notifications` and `getCourse` — because the
  server declares them present and this plugin runs on releases where they
  are not; that list is the honest inventory of what it assumes about the
  server's age. `app.config.settings` is the one thing used that the
  published contract does not describe, so it is declared beside them and
  read defensively. Provider *responses* stay loosely typed on purpose: a
  history provider is another package's output, and parsing it tolerantly is
  the difference between a missing sparkline and a failed cycle.
- **A `navigation.state` transition publishes immediately.** Leaving the dock
  was otherwise invisible for up to an hour: the stationary timer was set
  while the boat was still moored and nothing shortened it. Only the
  transition fires, never the repeats — `navigation.state` arrives as a
  delta on every update from signalk-autostate, and publishing on each would
  ignore the cadence entirely — and the pending timer is rescheduled, since
  it was set for the cadence that applied before the boat moved.
- **Every cycle is wrapped in `index.ts`.** An exception skips one update.
  It must never reach the server's event loop — this plugin runs in the
  navigation data hub's process.
- **The track is recorded from deltas and thinned by shape.** A fix is kept
  when dropping it would move the drawn track by more than
  `track.detailMetres`, and at least once per publish cycle. Measured on a
  synthetic hour of 60-second tacks: 60 points and the track exactly right,
  against 30 points and 128 m of error for one-fix-per-cycle sampling; a mark
  rounding is 9 points and 9 m against 5 points and 174 m. A straight leg
  costs the same as before, because the time floor is what fires. Two things
  that are easy to get wrong here: the time floor follows the *publish
  cadence* rather than being a constant, so a night at anchor is one fix an
  hour as it always was and not 720 points of a boat sitting still; and the
  window cap commits the newest fix and clears, because committing the oldest
  and dropping one leaves the window at the cap so every later fix commits
  too — that bug turned a night at anchor into 42601 points of 43200.
- **The tree fix is the fallback, not an addition.** With a recorder running,
  `runCycle` uses its fixes; without one — an older server, or streams it
  could not subscribe to — it uses the one on the tree, which is exactly what
  this plugin did before. Appending both would put a near-duplicate a metre
  away beside every recorded point.
- **`track.ts` never redacts, and must not start.** Its output is a list of
  candidates. `buildPositionEntry` is the single place a position becomes a
  published value and the single place the privacy zones are applied;
  recording more fixes must not become a second route to the repository.
- **The track is ours, the instrument log is the provider's.** Positions are
  accumulated here, straight from the tree or its deltas: that is what
  the GPX archive is built from, it works on a server with no history provider
  at all, and it keeps exactly one path — and one redaction — between a
  position and a public repository. The instrument log is the opposite: a
  projection of the database, rebuilt every cycle, never accumulated. Do not
  move either one to the other side without a reason bigger than symmetry.
- **Never ask a provider for a position.** `isPositionPath` drops
  `navigation.position` and its members from the query and from the response,
  so a wildcard in the captured-path list cannot put a raw position into a
  published file that nothing redacts. The privacy zones guard the track's
  path, not this one.
- **Units, names and descriptions come from `meta`, like the zones do.**
  The published snapshot is the whole self tree, so every path's `units`,
  `displayName` and `description` are already there; the page used to read
  only `meta.zones` and hardcode the rest. `unitGroupForPath` consults the
  explicit `PATH_TO_UNIT_GROUP` table first and falls back to `meta.units`,
  because the table encodes intent the units cannot — `navigation.log` and
  `navigation.anchor.currentRadius` are both metres and want nautical miles
  and feet respectively — and metadata covers everything the table has never
  heard of. `withUpdated` prefers `meta.description` over the string written
  here. Tooltips naming one boat's hardware ("from BNO055 IMU", "BME280
  sensor") are gone: this plugin runs on other people's boats, and the server
  knows what the sensor is.
- **A logged path that no panel draws still gets drawn.**
  `instrumentLog.paths` is configurable, so a boat can capture something this
  release has never seen; those paths were fetched from the provider,
  uploaded in full on every publish, and then rendered by nothing.
  `paintOtherInstruments` renders them into `#other-grid` from metadata
  alone, and `initInlineSparklines` picks them up like any other
  `.info-item[data-path]`. It runs from two places — the dashboard paint and
  the moment the instrument log finishes loading, which is what says which
  paths exist — and returns early until `navigation-grid` has painted,
  because the dashboard is what decides which paths are already covered.
  When this panel lists something you expected to see elsewhere, the bug is
  the missing `data-path` or the wrong default, not this panel: that is how
  both of the ones below were found.
- **`electrical.batteries.*.capacity.stateOfCharge` is the spec path.** The
  default captured list asked only for `electrical.batteries.*.stateOfCharge`
  while the battery panel reads the `capacity.` form, so on a
  spec-compliant boat the state-of-charge sparkline never drew. Both are
  asked for now; a path nothing produces costs nothing.
- **The frontend has no thresholds, and must not grow one back.** Twelve
  constants in `constants.js` used to decide what a low battery, a low tank, a
  dragging anchor and a lossy link were for every boat that publishes this
  site. They are gone: `classifyByZones` reads `meta.zones` off the published
  snapshot and is the only classifier there is. A path with no zones renders
  uncoloured — the same rule as the invented tide location and the invented
  vessel identity, one layer down. The server is where a threshold belongs,
  because it is where the alarm that sounds the buzzer is already configured,
  and a second copy here can only disagree with it silently. If a panel needs
  a level, set the zone in Signal K.
- **Firings are recorded from deltas; the tree sample is the fallback.**
  Sampling the tree once a cycle answers "what is wrong now" perfectly and
  "how often has this been going off" badly: at the stationary cadence the
  gap is an hour, so a bilge pump that runs three seconds every ten minutes
  was not undercounted, it was absent. `NotificationRecorder` subscribes to
  the self bus and applies the same edge rule between deltas.
  Exactly one of the two counts, ever. With a recorder running the publisher
  passes `countEdges: false`, so the cycle-to-cycle comparison only refreshes
  `seen` and `active`; counting in both places would double every firing that
  straddled a publish. Without a recorder — an older server, or one whose bus
  this plugin could not subscribe to — nothing changes and the comparison
  counts as it always did. The published `continuous` flag says which
  happened, and the panel's own copy changes with it rather than always
  claiming the worse one.
  The pending list is capped (`MAX_PENDING_EDGES`) because the drain
  interval is the publish interval and a wedged float switch can fire on
  every delta; the published log's cap cannot help there, because nothing
  has published yet.
- **A notification firing is an edge, not a sample.** The publish cadence
  swings 30x with `navigation.state`, so counting cycles in which an alarm was
  up would score the same six-hour alarm at 180 underway and 6 at anchor.
  `updateNotificationLog` counts a transition *into* an active state, plus an
  escalation within one. It deliberately does not count a re-stamped
  timestamp — some producers re-send an unchanged notification on every delta
  — and it does not count a path that drops out of the tree and returns, which
  is what a restarting producer looks like. The cost of that rule is that
  anything firing and clearing between two publishes is invisible, so the
  counts are a floor; the panel says so, and `sampled_since` bounds them to
  what the log has actually watched.
- **A notification the adopter excludes leaves no trace.**
  `notificationExclude` filters at three points: `readNotifications` never
  observes it, `NotificationRecorder` never records it, and
  `updateNotificationLog` drops it from both `seen` and the retained
  `events`. Adding a pattern has to take the path off the site on the next
  cycle *including the counts it had already collected* — leaving a day of
  firings attributed to a path the page no longer lists is worse than
  either publishing it or not. Unlike the captured instrument paths, an
  empty list is a real answer and must not fall back to the default:
  a blacklist that cannot be emptied is a bug.
- **Notifications are not stale-filtered, on purpose.** `STALE_FILTER_KEYS`
  covers `environment`, `navigation` and `entertainment`, where an old value
  presented as current is a lie. A notification is a *state*: it stays up
  until something clears it, and ageing one out would silently clear a real
  alarm on the site while the boat still has it. The banner shows how long it
  has been up instead.
- **The preview folds the firing log forward and throws it away.**
  `renderPreviewData` calls the same `updateNotificationLog` the publisher
  does and does not write the result. A phone left on the preview page would
  otherwise consume the edge the next real cycle needed to see, and the
  firing would never be counted.
- **The theme is never named `dark`.** The cycle is marine / amber / bright,
  and the first two are the dark ones. Nor after a boat: `amber` was `mermug`,
  named and coloured for one vessel's logo and offered to everybody. A `[data-theme="dark"]` selector
  matches nothing — three `.value-*` rules sat dead in `styles.css` for that
  reason, which left every warn and alert painted in the light-theme colour on
  a dark background. Three more (`.alert-chip--*`, `.floating-dark-mode-btn`)
  are still keyed that way.
- **The three history outcomes are three different publishes.** `ok` writes
  the log. `unavailable` — a provider is configured but did not answer —
  writes nothing and leaves the copy on the site, because a sparkline a few
  minutes stale beats a blank panel every time InfluxDB restarts. `none` — no
  provider, or the setting is off — publishes an empty log once, so the panels
  omit the sparklines instead of drawing whatever an older version last
  accumulated. Collapsing any two of those into a nullable snapshot loses a
  behaviour someone will notice.
- **`instrumentLog.entries` is the query window, and it is also the history
  dropdown.** `entries x resolutionSeconds` is how far back the log reaches,
  and the sparklines' window dropdown offers 1/3/12/24 hours against exactly
  that: a span the published file does not cover is disabled in the menu
  rather than drawn as a duplicate of a shorter one. The frontend plots every
  entry it is given, so raising `entries` is what makes the longer windows
  selectable — and every one of those entries is uploaded in full on every
  publish. At the default 60 s resolution, 24 hours is 1440 entries and about
  half a megabyte a cycle, which is a real decision on a hotspot, not a knob
  to turn up by default. `SPARKLINE_MAX_POINTS` is a draw cap, not a trim;
  it does not shorten the window.
- **Every network call needs a timeout.** `GitHubClient` sets an
  `AbortSignal.timeout` on every request. A call without one blocks forever on
  a half-open connection, which is the normal marina-hotspot failure.
- **Nothing is written outside the manifest.** New output paths go in
  `manifest.ts` first; `partitionOwned` drops anything else on the way into a
  commit.
- **The ref is never force-updated.** On a lost race, re-read HEAD and rebuild
  the tree, so a concurrent docs edit survives.
- **Check every privacy zone, not just the first.** An early version had this
  bug: the map track was redacted while positions from every other zone went
  straight into the published GPX.
- **Redact every position in the tree, not just `navigation.position`.** The
  same bug one level up, and it survived longer: the rule was "if the vessel
  is inside a zone, rewrite `navigation.position`", which guarded one path
  out of a tree that has several. Anchor inside a privacy zone and the site
  showed the zone centre for the boat while publishing the true anchor drop
  coordinates a few keys away in the same file — and the frontend reads
  `navigation.anchor.position` to draw the marker. `redactPositions` walks
  the tree and moves *any* position that falls inside a zone to that zone's
  centre, so a path the spec or a plugin grows later is covered without
  anyone remembering to add it to a list.
  The rule is per-position, not per-vessel, and that matters twice: an
  anchor position left over from the slip the boat left this morning is
  still redacted while it is out sailing, and a destination in
  `navigation.course.nextPoint` is *not* redacted merely because the boat is
  home — where it is going is not where it is, and snapping that to the home
  dock would corrupt the data while protecting nothing.
  What this does not cover, deliberately: the snapshot still publishes
  speed, course and anchor radius inside a zone. Those reveal that the boat
  is moving, not where it is. The track is stricter — `buildPositionEntry`
  drops a point inside a zone rather than snapping it, and withholds speed
  and course — because a night at the dock would otherwise be a pile of
  identical points saying exactly where you sleep.
- **Group tracks by local calendar day**, not by the UTC date in the
  timestamp. UTC midnight is mid-afternoon on the US west coast and splits a
  voyage in half.
- **Past GPX days are frozen.** The position index holds 24 hours; rebuilding
  yesterday from what is left of it truncates a day that is already complete.
- **Keep the instrument-log path list tight.** The API uploads whole files, not
  deltas; this file is the entire bandwidth cost of a cycle. The list is now a
  query rather than a filter, so a path that is not on it is never fetched
  either. Every cycle logs the file's size and warns past
  `INSTRUMENT_LOG_WARN_BYTES`.
- **The boat's own details come from the tree, every cycle.** Name, MMSI,
  callsign, registrations and dimensions are read in `runCycle`, not once in
  `start`: a cold boot publishes its first cycle before the first
  product-information frame arrives, and identity read at start would say
  "Vessel" until the next restart. Round anything numeric that goes into
  `info.yaml` — the file is rewritten whenever its content changes, and a
  draft that wobbles in the last decimal place would commit every two minutes.
- **Seeded is not owned, and the difference is the whole feature.** The
  manifest allowlist stays exactly as it was: no cycle writes a document, and
  `partitionOwned` drops one that tries. The console's two docs actions go
  round it on purpose, and `assertDocsPath` is what stands in its place — a
  positive check that the path is Markdown under `docs/`, so a composed path
  can never reach `index.html` or `data/`. Seeded paths are listed in the
  manifest under `seeded` with a note saying they are written once and then
  belong to the owner. Do not move them into `owned` to simplify the code: the
  manifest is a promise to the person whose repository this is, and `owned`
  means "overwritten without warning".
- **Initializing is refused, not merged.** Two different questions, two
  different guards. *A published document that is not part of the starter set*
  means the boat has its own docs, and initializing is declined outright —
  that is the whole of "only if the docs do not yet exist". The starter files
  and `docs/maintenance/log.md` are excluded from that count on purpose: they
  are the plugin's own doing, and counting the log would lock the starter set
  out of any repository where somebody logged an oil change first. *This exact
  path* existing means that one file is skipped, so a half-written starter set
  can be completed without the other half being touched. A truncated tree
  listing refuses everything: past GitHub's 100k cap, absence proves nothing,
  and "there are no documents" would be a guess.
- **A maintenance entry is an insert.** `insertMaintenanceEntry` splices one
  block in above the first `##` and returns the rest of the file unchanged; it
  never parses, reformats or reorders what is already there. The published copy
  is read back on every entry for the same reason `info.yaml` is — the file is
  edited from a phone between publishes and the boat's idea of it is never
  authoritative. There is deliberately no local cache of the log.
- **`AGENTS.md` and `CLAUDE.md` are not ship's documents.** `isPublishedDoc`
  excludes them by name. They are instructions for whoever edits the docs, and
  a sidebar entry called "Agents" is noise on a page that is meant to be read
  at sea.
- **The pages carry the boat's identity, and it is substituted, not scripted.**
  `document.title` and the name in the status hero are patched from the
  published snapshot after the page loads, but the OpenGraph and Twitter tags,
  the web app manifest and the tab icon cannot be: a link pasted into a chat
  is unfurled by a crawler that never runs the JavaScript. Those are `{{TOKEN}}`
  placeholders in `index.html`, `docs.html` and `manifest.json`, filled in by
  `frontend.ts` at publish time from the config and the tree. Every value goes
  through an escaper chosen by the file's type — a vessel named `Nancy "Nan"
  Blackett` is a broken attribute in one and an unparseable document in the
  other — and a `{{TOKEN}}` reaching the repository is a page naming nobody's
  boat, which `loadFrontend`'s test asserts against. Anything substituted is in
  the frontend fingerprint, so a rename republishes the pages that carry it.
- **Nothing in `site/` names one boat.** Not the pages, not the icons, not a
  localStorage key, not a theme, not a `window.` global. What used to be there:
  six favicon and home-screen PNGs of one boat's burgee under `assets/`, which
  the plugin owns and overwrites on upgrade, so the only way to have your own
  was to fork the plugin; a theme named after that boat; `mermug.checklist.`
  and `mermug-active-tab` in localStorage; `window.mermugMap`. The logo is
  `site.logo` on the config page now, published to `data/vessel/logo.<ext>`,
  with `assets/icon.svg` as the generic fallback.
- **The shipped constants are placeholders, and a missed substitution throws.**
  `GITHUB_REPO: 'OWNER/REPO'` in `constants.js` is not a value, it is a slot.
  It used to ship as one real repository, so `renderConstants` failing to match
  — after a reformat, say — published a site whose "edit on GitHub" links all
  pointed at somebody else's repo, silently. `replaceOrThrow` fails the publish
  instead.
- **The preview renders through the same `template` the publisher uses.** It is
  the only place the substitutions can be checked before a commit goes out, so
  a preview showing raw `{{TOKEN}}`s — or, worse, showing the right thing while
  the published copy is wrong — defeats the point of having one. `npm run dev`
  has its own stand-in values for the same reason.- **`site/` is published; `public/` is not.** Two directories with different
  jobs, and the split is load-bearing: Signal K mounts a package's `public/`
  as its webapp, so anything put there is served to the boat, and everything
  in `site/` is walked by `loadFrontend` and committed to the repository. A
  file in the wrong one either fails to appear in the admin UI or turns up on
  a public website.
- **The console writes documents; a cycle never does.** The two docs actions
  live on the publisher because they need the client and the config, but
  nothing in `runCycle` reaches them. A publish that could rewrite a document
  is a publish that can lose one, and the cadence is every two minutes.
- **The console's GET routes never write plugin state; its POST routes are
  what buttons are for.** `preview.ts` assembles the data files from the
  store and the tree and returns them; it does not call `runCycle`. Someone
  holding the preview open on a phone must not be able to roll the
  publisher's state forward or make the boat fetch anything — a page can be
  left open for a day, and a refresh is not an instruction. A button someone
  pressed is an instruction, which is why `/publish`, `/publish/site` and
  `/prune` are POSTs, and why they are the only things on the page that spend
  the boat's bandwidth on request. Keep that split: a new route that costs
  anything is a POST.
- **The console confirms in the page, never with `window.confirm`.** Signal K
  serves a plugin's webapp inside a sandboxed iframe, and the browser ignores
  `confirm()` there and returns false — so the prune button asked for
  confirmation nobody could see and then did nothing at all, which reads
  exactly like a broken button. The confirmation is markup in
  `public/index.html`; `alert` and `prompt` are out for the same reason.
- **`/preview/*` is registered before `/preview`, and that order is load
  bearing.** Express does not run in strict-routing mode, so `/preview` also
  matches `/preview/` — the exact path its redirect sends the browser to.
  Registered the other way round, `/preview/` answered with `Location:
  preview/`, the browser resolved it against `/preview/` to get
  `/preview/preview/`, and the console's iframe showed "Not found" instead of
  the site. `test/webapp.test.ts` pins the order and both responses.
- **Pruning is the only thing that deletes.** It runs when a person asks for
  it in the console, never on a timer — there is deliberately no retention
  setting for tracks. Deletions go through `partitionOwned` like every write,
  today is always kept, and pruned days come out of `publishedDays` so they
  can return.
- **The polar table belongs to the Polar Management plugin.** It stores polars
  as Signal K `polars` resources and publishes `{ href }` to the selected one
  at `polars.activePolar`. This plugin reads that href off the self tree,
  fetches the resource through `app.resourcesApi.getResource` and renders the
  CSV; it never has a copy of its own. The resource is canonical polar-format
  — m/s, radians, matrix `[tws][twa]` — so converting and transposing it is
  the whole of `polars.ts`. Round to two decimals on the way out: the file is
  rewritten whenever its content changes, and 6 knots stored as 3.086664 m/s
  comes back as 5.999999999999999.
- **The config polar table is an override, not a fallback.** Untick "Override
  polar" and the field is read-only and ignored, whatever is in it; tick it
  and it beats the server's active polar. An override that will not parse
  falls back to the server rather than blanking the chart. `plugin.schema` is
  a function so the field's description can say which of the two is live —
  that note is the only way a user can tell which plugin the chart is coming
  from.
- **The polar table is only ours while we have one.** `publishPolars` gates
  `data/vessel/polars.csv` in the manifest. Losing both sources stops
  publishing it and stops claiming it; it never deletes the file, because a
  polar table someone committed by hand is years of measurement.
- **The logo is the user's until they set one.** `publishLogo` gates
  `data/vessel/logo.*` in the manifest exactly the way `publishPolars` gates
  the polar table, and for the same reason: the first adopters committed a
  logo by hand, and clearing the config field must stop republishing and stop
  claiming the path rather than deleting their artwork. The pages fall back to
  `data/vessel/logo.png` and hide the image when it 404s, which is what keeps
  a hand-committed one working.
- **Default the operational numbers, never the boat.** Intervals, retention,
  stale cutoff, log length and the path list all have defaults — the values
  this tracker has run on for years — so a fresh install works. Privacy zones,
  the repo owner and the token have none: a guessed privacy zone hides the
  wrong water. An incomplete privacy zone is a hard config error, not a
  warning.
- **Five settings are derived, each behind an override checkbox.** The
  repository name from the owner (`<owner>.github.io`), the site address from
  the repository (`pagesUrl`, which a custom domain overrides), the timezone
  from the server, the polar from Polar Management, the USCG and hull numbers
  from the Signal K registrations. `resolveConfig` derives them itself and ignores the
  field whenever its override is unticked, so the `default` that
  `buildConfigSchema` puts in the box is cosmetic and a stale one can never
  become a published value. Graying the box out is a JSON Schema
  `dependencies` block, not `if`/`then`: every react-json-schema-form the
  Signal K admin UI has shipped understands one, and a renderer that
  understands neither still shows the plain editable field from `properties`.
- **Fatal or a warning, deliberately.** `resolveConfig` returns `problems`
  that stop the plugin and `warnings` that do not. A privacy zone that hides
  nothing is fatal; a token that is not shaped like one is a warning. The test
  is whether publishing anyway would mislead someone about where the boat is.
  A polar that will not convert is neither: it is reported from `index.ts` on
  the cycle that read it, and only when the report changes.
- **The timezone field is a list, not a text box.** `timezones.ts` builds it
  from `Intl.supportedValuesOf('timeZone')`, so every name offered is one
  `localDay()` can group by. "PST" used to be accepted, silently fall back to
  UTC, and split every track at 4pm.
- **The config page asks for minutes; everything else is seconds.**
  `interval.underwayMinutes` and `interval.stationaryMinutes` are converted in
  `resolveConfig`. `PluginConfig.interval` and the scheduler stay in seconds,
  and the legacy seconds fields are still read.
- **The theme is the site's, not the plugin's.** There is no theme setting and
  no `theme:` key in `info.yaml`; the floating button on the page cycles the
  themes in `site/assets/styles.css` and remembers the choice in
  `localStorage`. A config field for it once carried names from a stale
  comment in one boat's `info.yaml`, and picking one left the page unstyled.
- **The link row has no built-in external links.** A MarineTraffic button
  used to be hardcoded into `index.html` and fed by a `marinetraffic_ship_id`
  config field, which meant every site carried one vendor's link whether or
  not the boat was on it. Buttons are `site.customLinks` now, all of them.
- **Publish state stays out of the Signal K tree, with exactly one
  exception.** Cost, commit SHA, rate limits and per-cycle results go to
  `app.debug` / `app.error` and the plugin status line: they are telemetry
  about a plugin, and nobody needs an alarm for them. Do not add
  `setPluginStatus`-style state as data paths.
  The exception is `notifications.tracker.publishFailed`, raised once
  publishing has failed continuously for `notifyAfterFailureMinutes` and
  cleared on the next success. An expired token otherwise reaches nobody: the
  admin UI is a browser tab nobody has open at sea, and the first anyone
  ashore knows is that the boat appears to have stopped. A notification is
  the mechanism the whole boat already has for getting someone's attention,
  and it reaches KIP and the chartplotter without this plugin knowing they
  exist. It waits, because a single failed cycle is a dropped hotspot and not
  news; `method` is `['visual']`, because this plugin failing to reach GitHub
  is not a reason to sound the boat's alarm at 0300. One condition, and the
  test for adding another is whether a person would want to be told about it
  while it is happening.
- **A cycle that published nothing still counts as working.** It reached
  GitHub and read HEAD; "nothing changed" is a successful cycle, so it clears
  the failure alarm. Treating it as a non-event would leave an alarm up on a
  boat sitting quietly at anchor with everything already published.
- **The service worker's cache name must carry the version.** `sw.js` declares
  `SITE_VERSION` and `frontend.ts` substitutes the plugin's version into it, the
  same way it templates `constants.js`. The shell cache was once a constant
  (`mermug-shell-v4`) served cache-first with no revalidation: a device that had
  loaded the site once kept that release's HTML and JavaScript forever while the
  telemetry beside it went on updating. Old code against new data is a dashboard
  reading "Data unavailable" over a snapshot it downloaded successfully. Nothing
  under `data/` goes in the shell list either — it is published output, so it is
  network-first.
- **One panel failing is not nine panels failing.** The dashboard grids go
  through `paintPanel`, which isolates a missing element or a throwing section
  to that panel. They used to be nine bare `getElementById(...).innerHTML`
  writes in one `try`, where anything missing wiped the whole page.
- **`site/assets/constants.js` must use `var`.** `const` at the top level of
  a classic script does not create `window.VESSEL_CONSTANTS`, and the page goes
  blank.
- **Never write `assets/custom.css`.** It is the user's override hook, loaded
  last by both pages.
- **Record work as done only after the commit lands.** `frontendVersion`
  used to be written the moment the frontend files were assembled, so a
  publish that failed — a 502, a wedged hotspot — left the plugin believing
  it had shipped this release's HTML and JavaScript, and the site kept
  serving the previous one until the next version bump. It and
  `state.retired` are both merged in `runCycle` after `publishFiles` returns
  a commit. Anything else that records "this has been published" belongs
  there too.
- **An upgrade republishes the frontend by itself.** The fingerprint gating
  `frontendFiles` is `version:repo:branch:entries`, so a new plugin version
  rewrites every site file on the first cycle after the restart. The
  console's "rewrite the whole site" button exists for what a version number
  cannot see — a file deleted by hand on GitHub, a commit that landed
  half-way, a repository rolled back — and does it by clearing the
  fingerprint, not by a second code path.
- **Never add a per-cycle file.** An earlier design wrote one snapshot per
  cycle; an off-by-one in the prune let ~32k of them accumulate and grew the
  repository past a gigabyte.

## Installing on a server

`dist/` is not committed. The `prepare` script builds it on `npm install`,
which covers installing from a git URL or from a local checkout — the only
routes there are until this is published to npm. A `git clone` directly into
`~/.signalk/node_modules` bypasses npm and therefore `prepare`, leaving no
`dist/index.js`; the server then reports a provider error instead of listing
the plugin. Do not "fix" that by committing `dist/`.

## Published file formats

`data/telemetry/*.json` carry a `schema_version` so a plugin and a frontend of
different versions can detect a mismatch. The frontend reads these shapes
directly, so check `site/assets/app.js` before altering any of them.

- **A canvas has two sizes and they have to agree.** `.sparkline-inline` is
  `width: 100%` in the stylesheet, so the bitmap must be sized from the box the
  canvas actually occupies, times `devicePixelRatio`, with the drawing
  transform scaled to match. It used to be sized from the card's `clientWidth`
  — which includes the card's padding — at 1x, so every sparkline was squeezed
  horizontally and then upscaled by the phone, and 10px axis labels came out as
  smears. `sizeSparkline` is the only place that touches `canvas.width`.
- **Measure a label before reserving room for it.** The sparkline's left gutter
  was a fixed 34px while the y labels carry their unit; "0.01nm" is 38px at
  that font, so it ran off the left edge of the canvas. The gutter is
  `measureText` plus a margin now, and the x-axis tick count is whatever fits
  the remaining width rather than always four — four "HH:MM" labels do not fit
  the ~100px of plot a phone-width card leaves.
