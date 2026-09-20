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
  webapp.ts         The console's routes: status, preview, prune
  preview.ts        The site's data files rendered live, never published
  prune.ts          Which voyages a prune takes, decided without doing it
  snapshot.ts       Reading the self tree, stale filter, position redaction
  privacy.ts        Haversine, privacy zones
  positions.ts      positions_index.json
  instrumentLog.ts  instrument_log.json: its shape and the path matcher
  history.ts        The Signal K History API: the instrument log, read back
                    from a provider instead of accumulated here
  gpx.ts            Per-day GPX files and tracks_index.json
  docsIndex.ts      docs/index.json (port of the old Python builder)
  vesselInfo.ts     data/vessel/info.yaml, the boat read off the self tree,
                    and the user's passage block preserved
  polars.ts         data/vessel/polars.csv from the active `polars` resource
  timezones.ts      The IANA list the timezone dropdown offers
  logo.ts           The config page's logo field, decoded into bytes and a path
  frontend.ts       Reading site/ and templating what belongs to the adopter
  github.ts         Git Data API client and the publish-with-retry
  manifest.ts       Ownership allowlist — what the plugin may write
  state.ts          Rolling state in the plugin data dir, atomic writes
site/               The published site, shipped in the npm package
public/             The console webapp; Signal K mounts it at /signalk-github-pages/
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
  tell from the config page what `info.yaml` would end up saying. A new key is
  a typed field and a line in `renderVesselInfo`, not a blob. `grep
  vesselData\. site/assets/app.js` lists every key the frontend reads; each
  one needs a source before a field is removed.
- **Unknown renders as unknown.** The frontend carried invented fallbacks: a
  San Francisco Bay tide location, a privacy zone at one particular dock, a
  whole vessel identity — name, MMSI, documentation number — used when
  `info.yaml` failed to load, a NOAA station picker that forced 9414290 inside
  a box around the Golden Gate, a retry against that same station wherever the
  boat was, a one-entry station table, and a demo snapshot positioned off Point
  Bonita. Each one turned a missing value into a confident wrong one on
  somebody else's boat, and they were found in four separate passes, so assume
  there is another. `resolveTidePosition` returns null and the panels say what
  is missing; `getPrivacyZones` returns an empty list, which is safe because
  the plugin already redacts before it publishes; `stationsByDistance` sorts by
  distance and nothing else; `vesselData` is `{}`. Do not add another.
- **The map draws the zones it is redacting against.** `drawPrivacyZones`
  renders `privacy_zones` from `info.yaml`, and no zones means no rings. The
  ring used to be a literal at one dock in San Francisco, drawn on every
  adopter's map while their own zones were never drawn — a redaction claim
  false in both directions. A ring on the map is a promise about the data
  beside it.
- **A published URL is an `href` on someone else's browser.** `customLinks`
  entries are checked for an http/https scheme in `resolveConfig` *and* again
  in `renderCustomLinks`, because `info.yaml` is a file in a public repository
  that anyone with write access can edit. One check is a config validation;
  two is a policy.
- **Every cycle is wrapped in `index.ts`.** An exception skips one update.
  It must never reach the server's event loop — this plugin runs in the
  navigation data hub's process.
- **The track is ours, the instrument log is the provider's.** Positions are
  accumulated here, one fix per cycle, straight from the tree: that is what
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
- **The three history outcomes are three different publishes.** `ok` writes
  the log. `unavailable` — a provider is configured but did not answer —
  writes nothing and leaves the copy on the site, because a sparkline a few
  minutes stale beats a blank panel every time InfluxDB restarts. `none` — no
  provider, or the setting is off — publishes an empty log once, so the panels
  omit the sparklines instead of drawing whatever an older version last
  accumulated. Collapsing any two of those into a nullable snapshot loses a
  behaviour someone will notice.
- **`instrumentLog.entries` is the query window, and 60 is not arbitrary.**
  The frontend's `SPARKLINE_POINTS` is 60: it plots the last 60 entries and
  ignores the rest, so a longer log is bytes uploaded on every publish that
  nothing has ever drawn.
- **Every network call needs a timeout.** `GitHubClient` sets an
  `AbortSignal.timeout` on every request. A call without one blocks forever on
  a half-open connection, which is the normal marina-hotspot failure.
- **Nothing is written outside the manifest.** New output paths go in
  `manifest.ts` first; `partitionOwned` drops anything else on the way into a
  commit.
- **The ref is never force-updated.** On a lost race, re-read HEAD and rebuild
  the tree, so a concurrent docs edit survives.
- **Check every privacy zone, not just the first.** The Python daemon had this
  bug: the map track was redacted while positions from every other zone went
  straight into the published GPX.
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
- **The pages carry the boat's identity, and it is substituted, not scripted.**
  `document.title` and the name in the status hero are patched from
  `info.yaml` after the page loads, but the OpenGraph and Twitter tags, the web
  app manifest and the tab icon cannot be: a link pasted into a chat is
  unfurled by a crawler that never runs the JavaScript. Those are `{{TOKEN}}`
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
  has its own stand-in values for the same reason.
- **`site/` is published; `public/` is not.** Two directories with different
  jobs, and the split is load-bearing: Signal K mounts a package's `public/`
  as its webapp, so anything put there is served to the boat, and everything
  in `site/` is walked by `loadFrontend` and committed to the repository. A
  file in the wrong one either fails to appear in the admin UI or turns up on
  a public website.
- **The console never writes plugin state.** `preview.ts` assembles the data
  files from the store and the tree and returns them; it does not call
  `runCycle`. Someone holding the preview open on a phone must not be able to
  roll the publisher's state forward, or to make the boat fetch anything.
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
- **Publish state stays out of the Signal K tree.** Cost, commit SHA and
  failures go to `app.debug` / `app.error` and the plugin status line. Do not
  add `setPluginStatus`-style state as data paths.
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
- **Never add a per-cycle file.** The daemon once wrote one snapshot per cycle;
  an off-by-one in the prune let ~32k of them accumulate and grew the
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
different versions can detect a mismatch. The shapes otherwise match what the
Python daemon wrote, because the frontend reads them unchanged — check
`site/assets/app.js` before altering any of them.

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
