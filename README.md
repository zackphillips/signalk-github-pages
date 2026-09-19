# signalk-github-pages

Publish a vessel's Signal K data to a static GitHub Pages site: live position,
a map track, per-day GPX files, instrument sparklines and the ship's docs, with
no server ashore and no git checkout on the boat.

```
Signal K server ──(in-process)──▶ plugin ──(GitHub Git Data API)──▶ repo ──▶ Pages
       ▲                            │
  navigation.state              plugin data dir
                                (rolling state, docs cache)
```

The plugin reads the self tree in-process, keeps its rolling state in the
plugin's data directory, and publishes each cycle as a single commit through
the GitHub Git Data API. There is no `git` binary, no working copy, and
nothing on disk to rebase.

## What you need

- A Signal K server (Node 18 or newer).
- A GitHub repository with Pages enabled — `<you>.github.io`, or any repo with
  Pages serving the branch root.
- A fine-grained personal access token with **Contents: read and write** on
  that one repository and nothing else.

## Install

From the Signal K **App Store**, or:

```bash
cd ~/.signalk/node_modules && npm install signalk-github-pages
```

Restart the server, then open **Server → Plugin Config → GitHub Pages vessel
tracker**.

## Configure

| Field | Required | Notes |
|---|---|---|
| `github.repo` | yes | `owner/name` of the Pages repository |
| `github.branch` | no (`main`) | Branch Pages serves |
| `github.token` | yes | Fine-grained PAT, Contents: read/write, this repo only |
| `interval.underway` | **yes** | Seconds between publishes when `navigation.state` is sailing or motoring |
| `interval.stationary` | **yes** | Seconds between publishes when moored, anchored, or state unknown |
| `instrumentLog.paths` | **yes** | One Signal K path per line — see [Instrument paths](#instrument-paths) |
| `instrumentLog.entries` | **yes** | Rolling length of the sparkline log |
| `positionRetentionHours` | **yes** | How long raw positions stay in the map track |
| `staleMaxAgeMinutes` | **yes** | Values older than this are dropped from the snapshot |
| `privacyZones[]` | no (empty) | `{name, lat, lon, radius_m}` |
| `timezone` | no (UTC) | IANA name; groups GPX tracks by local calendar day |
| `buildDocsIndex` | no (on) | Maintain `docs/index.json` for the docs reader |
| `publishFrontend` | no (on) | Write the bundled site into the repo on install and upgrade |
| `site.theme` | no (`mermug`) | Theme name the frontend understands |
| `site.*` | no | Display-only identifiers the site shows |
| `site.extraYaml` | no | Free-form YAML merged into `info.yaml` — see [Extra site fields](#extra-site-fields) |

**Nothing numeric has a default.** A cadence, a retention window, a stale
cutoff and the path list describe one boat's cellular plan and one boat's
instruments; a default is a guess that publishes at someone else's cadence and
bandwidth until they notice. The plugin refuses to start until each is set and
names every missing field at once, so it takes one pass rather than one
restart per field.

Vessel name and MMSI come from the server (`navigation` self data), not from
this page.

**Token storage.** Signal K keeps plugin configuration as plain JSON under
`~/.signalk/plugin-config-data/`. Anyone with a shell on the server can read
the token, so scope it to the single repository and rotate it if the Pi leaves
your hands.

**Cadence.** Pacing comes from `navigation.state`, which
[signalk-autostate](https://www.npmjs.com/package/signalk-autostate) sets from
speed and anchor state. Without it every cycle uses the stationary interval.

## Instrument paths

`instrumentLog.paths` is a text box, one Signal K path per line. `*` matches
one path segment, so `electrical.batteries.*.voltage` covers every bank. Lines
starting with `#` are comments.

This list is the entire bandwidth cost of a cycle: every path here is recorded
for every entry and the whole file is re-uploaded on every publish. Start with
what the bundled sparklines draw, then cut anything you do not look at:

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

A path that no instrument produces costs nothing — it simply never appears.

## Extra site fields

`site.extraYaml` is a free-form YAML mapping merged into
`data/vessel/info.yaml`, for anything the frontend reads that the config page
does not cover:

```yaml
default_location:
  lat: 37.806
  lon: -122.465
  label: San Francisco Bay
```

A key here overrides what the plugin would have written, and every override is
named in the log so a field that stopped tracking the config page is visible
rather than mysterious. `passage:` is refused: it lives in the published file,
edited from the GitHub web UI, and is preserved on every rewrite. Invalid YAML
is logged and skipped — it never stops a publish.

## Privacy zones

A position inside a zone is published as the zone's centre, and that point is
left out of the GPX track entirely rather than snapped to the middle. Speed
and course are withheld too, so a day at the dock does not leak that the boat
was manoeuvring in the harbour. Zones default to empty: nothing is hidden
until you say what to hide.

## What the plugin writes

The repository is shared with you. The plugin writes an ownership manifest,
`.tracker-manifest.json`, listing every path it manages, and refuses to put
anything outside that list into a commit.

| Path | Owner |
|---|---|
| `data/telemetry/**` | Plugin, every cycle |
| `data/vessel/info.yaml` | Plugin, when the config changes (your `passage:` block is preserved) |
| `docs/index.json` | Plugin, when the docs tree changes |
| `index.html`, `docs.html`, `sw.js`, `manifest.json`, `.nojekyll`, `assets/**`, `data/tide_stations.json` | Plugin, on install and after an upgrade |
| `docs/*.md` | **You** |
| `data/vessel/logo.png`, `data/vessel/polars.csv` | **You** |
| `assets/custom.css` | **You** — loaded last by both pages, never written here |
| Everything else | **You** |

Each publish builds a tree against the live `HEAD` with only those paths
layered on top, so a docs edit made from a phone and a telemetry commit from
the boat interleave cleanly in either order. The only race is the ref update
landing behind someone else's push, which is re-read and retried once. The ref
is never force-updated.

## Ship's docs

Markdown in `docs/` is published as-is and rendered client-side by
`docs.html`. Adding a document is committing a `.md` file — no build step, no
checkout, which is the point: it has to work from the GitHub web UI on a
phone. The plugin maintains only `docs/index.json`, the manifest the reader
needs because a static site cannot list a directory. It polls the tree with an
ETag, so an unchanged docs tree costs nothing against the rate limit.

Front matter (`title`, `category`, `order`, `description`) is optional and
overrides what is otherwise inferred from the H1, the subdirectory and the
first paragraph. Files starting with `_` are drafts and stay out of the index.

**Do not delete `.nojekyll`.** Without it Pages runs the tree through Jekyll,
which turns `docs/foo.md` into `docs/foo.html` and stops serving the raw
Markdown the reader fetches. Every document 404s while the repository looks
perfectly fine.

## Bandwidth

`git push` sends a delta. The Git Data API uploads each changed file in full,
base64-encoded, and does not accept a compressed request body. The instrument
log is therefore the whole cost of a cycle: logging every numeric leaf in the
self tree produces ~167 paths per entry and a file around 1 MB, republished
every two minutes — roughly 1.3 MB per cycle over a cellular hotspot, before
the rest of the publish.

The plugin measures this rather than assuming it. Every cycle logs the files
it published, largest first, the content size, the size of the request bodies
that actually crossed the link, the API call count and the rate limit left:

```
Instrument log: 120 entries, 14 paths this cycle, 96.4 kB.
Publishing 5 file(s), 142.8 kB: data/telemetry/instrument_log.json 96.4 kB, …
Published a1b2c3d: 5 file(s), 142.8 kB of content in 191.2 kB of request
bodies, 5 API call(s), 1840 ms. Rate limit: 4993 left until …
```

Past half a megabyte the log line turns into a warning with the hourly cost at
your configured cadence. The fix is always the same: shorten the path list, or
keep fewer entries.

## Development

```bash
npm install
npm test          # vitest
npm run build     # tsc → dist/
npm run dev       # serve public/ against sample/ at http://localhost:8000
```

The publisher is deliberately free of server calls: `Publisher.runCycle()`
takes a self tree and returns what it did, so the whole cycle is tested
without a Signal K server or a network. `test/helpers/fakeGitHub.ts` is an
in-memory stand-in for the Git Data API, including the ETag on the tree
listing and a ref update that can lose a race.

### Frontend

The site lives in `public/` and ships inside the npm package. Two values in
`assets/constants.js` are substituted per installation — the repository the
"edit on GitHub" links point at, and the instrument-log length, which must
match the publisher.

`constants.js` must keep declaring `var VESSEL_CONSTANTS`. `const` at the top
level of a classic script does not create `window.VESSEL_CONSTANTS`, `app.js`
throws on the missing global, and the whole page goes blank.

## Migrating an existing tracker

See [MIGRATION.md](MIGRATION.md) for moving a repository that currently runs
the Python daemon and carries the frontend in its own tree.

## Known trade-offs

- **The plugin runs in the server process.** A bug here can affect the
  navigation data hub, which a separate Python daemon could not. Every cycle
  is wrapped: an exception skips one update, is reported in the admin UI, and
  never reaches the server's event loop.
- **The token is stored in plain text** by Signal K, as above.
- **Publishing is one commit per cycle.** The repository grows at the rate you
  publish. Keep the path list tight, and rewrite history if it ever gets away
  from you.
- **Publish state is not exposed as Signal K paths.** The last commit, the
  cycle cost and the failures are in the server log and the plugin status line,
  not in the data tree, so nothing here shows up in KIP.

## License

MIT.
