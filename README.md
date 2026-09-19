<h1 align="center">signalk-github-pages</h1>

<p align="center">
  <em>Your boat publishes its own website.</em><br>
  A Signal K plugin that turns live vessel data into a static GitHub Pages site —
  position, tracks, instruments and the ship's docs — with no server ashore
  and no git checkout on board.
</p>

<p align="center">
  <img alt="Signal K plugin" src="https://img.shields.io/badge/Signal%20K-server%20plugin-0a7ea4">
  <img alt="Node 18+" src="https://img.shields.io/badge/node-%E2%89%A518-5fa04e">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

---

Underway, the boat publishes every two minutes. At the dock, hourly. Ashore,
anyone with the link sees where you are, where you have been, what the wind is
doing and how the batteries are holding up — served by GitHub Pages, which
does not go down when the hotspot does, and costs nothing.

```
   Signal K server                          GitHub                    Ashore
┌────────────────────┐              ┌──────────────────┐        ┌──────────────┐
│  navigation.*      │  in-process  │  Git Data API    │  Pages │              │
│  environment.*     ├─────────────▶│  blobs → tree    ├───────▶│  your-site   │
│  electrical.*      │    plugin    │  → commit → ref  │        │  .github.io  │
└─────────┬──────────┘              └──────────────────┘        └──────────────┘
          │                                   ▲
          │ navigation.state                  │ docs/*.md edited
          │ sets the cadence                  │ from a phone, any time
          ▼                                   │
   plugin data dir ───────────────────────────┘
   (rolling state)
```

No `git` binary. No working copy to corrupt. No systemd unit. No YAML to
hand-edit over SSH. The plugin reads the self tree in-process, keeps its
rolling state in `app.getDataDirPath()`, and each cycle is one commit built on
the live `HEAD`.

## What you get

| | |
|---|---|
| **Live position** | With privacy zones: inside one, the site shows the zone centre and the track simply stops |
| **Per-day GPX tracks** | Grouped by *your* local calendar day, not by UTC — a voyage does not get cut in half mid-afternoon |
| **Instrument sparklines** | A rolling log of exactly the paths you name, and nothing else |
| **Ship's docs** | Markdown in `docs/`, edited from the GitHub web UI on a phone, rendered client-side |
| **Adaptive cadence** | Fast underway, slow at anchor, straight off `navigation.state` |
| **Ownership manifest** | The plugin writes only the paths it declares; the rest of the repo is yours |
| **Honest accounting** | Every cycle logs what it cost: bytes on the wire, API calls, rate limit left |

## Quick start

**1. A repository with Pages on.** Any repo works — `<you>.github.io` serves
at the apex, anything else at `/<repo>/`. Settings → Pages → Deploy from a
branch → `main` / `(root)`.

**2. A token.** [Fine-grained PAT](https://github.com/settings/personal-access-tokens),
**only** this repository, **Contents: read and write**. Nothing else.

**3. Install and point it at both.**

```bash
cd ~/.signalk/node_modules && npm install signalk-github-pages
```

Restart Signal K, open **Server → Plugin Config → GitHub Pages vessel
tracker**, fill in the repository and the token, enable. Everything else has a
working default.

The first cycle writes the whole site — HTML, CSS, JS, icons — then telemetry
only. Give Pages a minute, then open the URL.

> [!TIP]
> Install [signalk-autostate](https://www.npmjs.com/package/signalk-autostate)
> if you have not. It sets `navigation.state`, which is what makes the cadence
> adaptive. Without it every cycle uses the stationary interval.

## Configuration

| Field | Default | Notes |
|---|---|---|
| `github.repo` | **required** | `owner/name` of the Pages repository |
| `github.token` | **required** | Fine-grained PAT, Contents: read/write, this repo only |
| `github.branch` | `main` | Branch Pages serves |
| `interval.underway` | `120` s | When `navigation.state` is sailing or motoring |
| `interval.stationary` | `3600` s | Moored, anchored, or state unknown |
| `instrumentLog.paths` | the sparkline set | One path per line — [see below](#instrument-paths) |
| `instrumentLog.entries` | `120` | ~5 hours at a two-minute cadence |
| `positionRetentionHours` | `24` | How long raw positions stay in the map track |
| `staleMaxAgeMinutes` | `60` | Older values are dropped from the snapshot |
| `privacyZones[]` | *empty* | `{name, lat, lon, radius_m}` |
| `timezone` | *server* | IANA name, for grouping tracks by local day |
| `site.theme` | `marine` | `marine`, `mermug`, `bright`, `dark` |
| `site.extraYaml` | *empty* | Free-form YAML merged into `info.yaml` |
| `buildDocsIndex` | on | Maintain `docs/index.json` |
| `publishFrontend` | on | Write the bundled site on install and upgrade |

The defaults are the numbers this tracker has run on since it was a Python
daemon on a Raspberry Pi. What has no default is anything belonging to one
particular boat: privacy zones start empty, the timezone follows the server,
and the vessel's name and MMSI come from Signal K rather than from this page.

> [!WARNING]
> Signal K stores plugin configuration as plain JSON under
> `~/.signalk/plugin-config-data/`. Your token is readable by anyone with a
> shell on the server. Scope it to the one repository, and rotate it if the Pi
> ever leaves your hands.

## Instrument paths

One Signal K path per line. `*` matches one segment, so
`electrical.batteries.*.voltage` covers every bank. Lines starting with `#`
are comments. A path no instrument produces costs nothing — it never appears.

This list is the entire bandwidth cost of a cycle. Trim it to what you look at.

<details>
<summary><strong>The default list</strong> — what the bundled sparklines draw</summary>

```
navigation.speedOverGround
navigation.speedThroughWater
navigation.courseOverGroundTrue
navigation.headingTrue
navigation.attitude.roll
navigation.attitude.pitch
environment.wind.speedApparent
environment.wind.angleApparent
environment.wind.speedTrue
environment.wind.directionTrue
environment.depth.belowTransducer
environment.water.temperature
environment.outside.temperature
environment.outside.pressure
environment.inside.temperature
environment.inside.humidity
electrical.batteries.*.voltage
electrical.batteries.*.current
electrical.batteries.*.stateOfCharge
electrical.batteries.*.capacity.timeRemaining
electrical.solar.*.panelPower
tanks.*.*.currentLevel
propulsion.*.revolutions
propulsion.*.temperature
propulsion.*.runTime
```

</details>

### Why this matters more than it looks like it should

`git push` sends a delta. The Git Data API does not: every changed file goes
up whole, base64-encoded, in a JSON body it will not accept compressed. The
instrument log is a rolling window, so *every* entry shifts position each
cycle — there is no "only the tail changed" for a delta to find even if one
were possible.

Logging every numeric leaf in the self tree is roughly 167 paths per entry and
a ~1 MB file. At a two-minute cadence that is about **40 MB per hour** over
the hotspot, for data the sparklines never draw. The default list is about a
dozen paths: ~100 kB, ~4 MB per hour.

The plugin measures this rather than assuming it. Past half a megabyte the log
line becomes a warning with the hourly cost at your configured cadence.

## Privacy zones

A position inside a zone is published as the zone's **centre**, and that point
is left out of the GPX track **entirely** rather than snapped to the middle —
a night at the dock would otherwise be a pile of identical points saying
exactly where you sleep. Speed and course are withheld too, so the site cannot
show you manoeuvring in the harbour.

Every check walks the whole list. Zones start empty: nothing is hidden until
you say what to hide.

> [!NOTE]
> A zone missing its radius is a hard configuration error, not a warning. A
> half-entered zone hides nothing while looking like it does, and the failure
> mode is a published position someone believed was redacted.

## What the plugin writes

The repository is shared with you. The plugin writes `.tracker-manifest.json`
listing every path it manages, and refuses to put anything outside that list
into a commit.

| Path | Owner |
|---|---|
| `data/telemetry/**` | Plugin, every cycle |
| `data/vessel/info.yaml` | Plugin, when the config changes — your `passage:` block is preserved |
| `docs/index.json` | Plugin, when the docs tree changes |
| `index.html`, `docs.html`, `sw.js`, `manifest.json`, `.nojekyll`, `assets/**`, `data/tide_stations.json` | Plugin, on install and after an upgrade |
| `docs/*.md` | **You** |
| `data/vessel/logo.png`, `data/vessel/polars.csv` | **You** |
| `assets/custom.css` | **You** — loaded last by both pages, never written here |
| Everything else | **You** |

Each publish builds a tree against the live `HEAD` with only those paths
layered on top, so a docs edit from your phone and a telemetry commit from the
boat interleave cleanly in either order. The only race is the ref update
landing behind someone else's push: re-read, rebuild, retry once. The ref is
never force-updated, so a concurrent edit is never lost.

### Extra site fields

`site.extraYaml` is free-form YAML merged into `data/vessel/info.yaml`, for
anything the frontend reads that the config page does not cover:

```yaml
default_location:
  lat: 37.806
  lon: -122.465
  label: San Francisco Bay
```

A key here overrides what the plugin would have written, and every override is
named in the log. `passage:` is refused — it lives in the published file,
edited from the web UI, and is preserved on every rewrite. Invalid YAML is
logged and skipped; it never stops a publish.

## Ship's docs

Markdown in `docs/` is published as-is and rendered client-side. Adding a
document is committing a `.md` file: no build step, no checkout, which is the
point — it has to work from the GitHub web UI on a phone, one-handed, at
anchor.

The plugin maintains only `docs/index.json`, the manifest the reader needs
because a static site cannot list a directory. It polls the tree with an ETag,
so an unchanged docs tree costs nothing against the rate limit.

Front matter is optional and overrides what is inferred from the H1, the
subdirectory and the first paragraph:

```markdown
---
title: Man Overboard
category: Emergency
order: 10
---
```

Files starting with `_` are drafts and stay out of the index.

> [!CAUTION]
> Do not delete `.nojekyll`. Without it Pages runs the tree through Jekyll,
> which turns `docs/foo.md` into `docs/foo.html` and stops serving the raw
> Markdown the reader fetches. Every document 404s while the repository looks
> perfectly fine.

## What a cycle looks like in the log

```
Instrument log: 120 entries, 14 paths this cycle, 96.4 kB.
Publishing 5 file(s), 142.8 kB: data/telemetry/instrument_log.json 96.4 kB,
  data/telemetry/positions_index.json 31.2 kB, …
Published a1b2c3d: 5 file(s), 142.8 kB of content in 191.2 kB of request
  bodies, 5 API call(s), 1840 ms. Rate limit: 4993 left until 2026-03-01T21:00Z
```

Publish state deliberately stays out of the Signal K data tree: it is log
output and the plugin status line, not paths in the model.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm run dev       # public/ + sample/ on http://localhost:8000
```

`npm run dev` serves the real frontend against fixture telemetry: a day's
track, sixty instrument-log entries, a sailing snapshot. No boat required.

`Publisher.runCycle()` takes a self tree and returns what it did — it never
calls back into the server — so a full publish cycle is tested without Signal
K and without a network. `test/helpers/fakeGitHub.ts` is an in-memory Git Data
API, including the ETag on the tree listing and a ref update that can lose a
race.

<details>
<summary><strong>Layout</strong></summary>

```
src/
  index.ts          Plugin entry: schema, start/stop, tick scheduling
  config.ts         Config schema, parsing, validation
  publisher.ts      One cycle end to end
  snapshot.ts       Self-tree read, stale filter, position redaction
  privacy.ts        Haversine, privacy zones
  positions.ts      positions_index.json
  instrumentLog.ts  instrument_log.json + the path allowlist
  gpx.ts            Per-day GPX and tracks_index.json
  docsIndex.ts      docs/index.json
  vesselInfo.ts     data/vessel/info.yaml
  frontend.ts       Reading public/, templating constants.js
  github.ts         Git Data API client, publish-with-retry
  manifest.ts       Ownership allowlist
  state.ts          Rolling state, atomic writes
public/             The site, shipped in the package
sample/             Fixture telemetry for the dev server
```

</details>

> [!IMPORTANT]
> `public/assets/constants.js` must keep declaring `var VESSEL_CONSTANTS`.
> `const` at the top level of a classic script does not create
> `window.VESSEL_CONSTANTS`, `app.js` throws on the missing global, and the
> entire page goes blank.

## Migrating an existing tracker

[MIGRATION.md](MIGRATION.md) is the cutover for a repository running the
Python daemon: measure the instrument log first, run both publishers against a
scratch repo for a sailing day and diff them, move the config across, then
delete the backend.

## Trade-offs worth knowing

**The plugin runs inside the server process.** A bug here can affect the
navigation data hub, which a separate daemon could not. Every cycle is
wrapped: an exception skips one update, is reported in the admin UI, and never
reaches the server's event loop. That is the main cost of reading the tree
in-process, and it buys away the HTTP poll that could freeze the site on stale
data.

**The token sits in plain text**, as above.

**One commit per cycle.** The repository grows at the rate you publish. Keep
the path list tight.

**Nothing is served from the boat.** That is KIP's job. This site is for
people ashore, and it stays up when the boat's link does not.

## License

MIT.
