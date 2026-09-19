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
  vesselInfo.ts     data/vessel/info.yaml, preserving the user's passage block
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
- **Nothing numeric gets a default.** Intervals, retention, stale cutoff, log
  length and the path list are all required; `resolveConfig` reports every
  missing one at once and the plugin refuses to start. Adding a default to the
  schema would quietly undo that.
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

## Published file formats

`data/telemetry/*.json` carry a `schema_version` so a plugin and a frontend of
different versions can detect a mismatch. The shapes otherwise match what the
Python daemon wrote, because the frontend reads them unchanged — check
`public/assets/app.js` before altering any of them.
