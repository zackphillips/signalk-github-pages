# AGENTS.md — working on signalk-github-pages

A Signal K server plugin that publishes vessel telemetry to a GitHub Pages
repository. Read `README.md` first for what it does; this file is what to know
before changing it.

## Layout

```
src/
  index.ts          Plugin entry: schema, start/stop, tick scheduling
  config.ts         Config schema, defaults, normalisation, validation
  publisher.ts      One cycle end to end — the only module that orchestrates
  snapshot.ts       Reading the self tree, stale filter, position redaction
  privacy.ts        Haversine, privacy zones
  positions.ts      positions_index.json
  instrumentLog.ts  instrument_log.json + the path allowlist
  gpx.ts            Per-day GPX files and tracks_index.json
  docsIndex.ts      docs/index.json (port of the old Python builder)
  vesselInfo.ts     data/vessel/info.yaml, the boat read off the self tree,
                    and the user's passage block preserved
  polars.ts         data/vessel/polars.csv from the table pasted into config
  timezones.ts      The IANA list the timezone dropdown offers
  frontend.ts       Reading public/ and templating constants.js
  github.ts         Git Data API client and the publish-with-retry
  manifest.ts       Ownership allowlist — what the plugin may write
  state.ts          Rolling state in the plugin data dir, atomic writes
public/             The site itself, shipped in the npm package
sample/             Fixture telemetry for `npm run dev`
test/               vitest, including an in-memory GitHub fake
```

## Commands

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm run dev       # public/ + sample/ on http://localhost:8000
```

Run `npm test` and `npm run typecheck` before committing.

## Rules that are not obvious

- **`publisher.ts` takes a tree and returns a result.** It never calls the
  Signal K server. Keep it that way: it is what makes a full cycle testable
  without a server or a network.
- **Every cycle is wrapped in `index.ts`.** An exception skips one update.
  It must never reach the server's event loop — this plugin runs in the
  navigation data hub's process.
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
  deltas; this file is the entire bandwidth cost of a cycle. Every cycle logs
  its size and warns past `INSTRUMENT_LOG_WARN_BYTES`.
- **The boat's own details come from the tree, every cycle.** Name, MMSI,
  callsign, registrations and dimensions are read in `runCycle`, not once in
  `start`: a cold boot publishes its first cycle before the first
  product-information frame arrives, and identity read at start would say
  "Vessel" until the next restart. Round anything numeric that goes into
  `info.yaml` — the file is rewritten whenever its content changes, and a
  draft that wobbles in the last decimal place would commit every two minutes.
- **The polar table is only ours while the config field has one in it.**
  `publishPolars` gates `data/vessel/polars.csv` in the manifest. Clearing the
  field stops publishing it and stops claiming it; it never deletes the file,
  because a polar table someone committed by hand is years of measurement.
- **Default the operational numbers, never the boat.** Intervals, retention,
  stale cutoff, log length and the path list all have defaults — the values
  this tracker has run on for years — so a fresh install works. Privacy zones,
  timezone, repo, token and the vessel identifiers have none: a guessed
  privacy zone hides the wrong water, and a guessed timezone splits tracks on
  the wrong midnight. An incomplete privacy zone is a hard config error, not a
  warning.
- **Fatal or a warning, deliberately.** `resolveConfig` returns `problems`
  that stop the plugin and `warnings` that do not. A privacy zone that hides
  nothing is fatal; a polar table that will not parse, or a token that is not
  shaped like one, is a warning. The test is whether publishing anyway would
  mislead someone about where the boat is.
- **The timezone field is a list, not a text box.** `timezones.ts` builds it
  from `Intl.supportedValuesOf('timeZone')`, so every name offered is one
  `localDay()` can group by. "PST" used to be accepted, silently fall back to
  UTC, and split every track at 4pm.
- **`SITE_THEMES` must match the themes in `public/assets/styles.css`.** It
  once carried names from a stale comment in one boat's `info.yaml`; picking
  one of those left the page unstyled. Today: `marine`, `mermug`, `bright`,
  `dark`.
- **Publish state stays out of the Signal K tree.** Cost, commit SHA and
  failures go to `app.debug` / `app.error` and the plugin status line. Do not
  add `setPluginStatus`-style state as data paths.
- **`public/assets/constants.js` must use `var`.** `const` at the top level of
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
`public/assets/app.js` before altering any of them.
