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
| **History from your database** | With a Signal K history provider installed, the track and the sparklines are read back from it — full resolution, no gap across a restart |
| **Ownership manifest** | The plugin writes only the paths it declares; the rest of the repo is yours |
| **Honest accounting** | Every cycle logs what it cost: bytes on the wire, API calls, rate limit left |

## Quick start

**1. A repository with Pages on.** Any repo works — `<you>.github.io` serves
at the apex, anything else at `/<repo>/`. Settings → Pages → Deploy from a
branch → `main` / `(root)`.

**2. A token.** [Make a fine-grained
PAT](https://github.com/settings/personal-access-tokens/new) and tick exactly
this much:

| In the token form | Set it to |
|---|---|
| Resource owner | You, or the organisation that owns the repository |
| Repository access | **Only select repositories** → the Pages repository |
| Repository permissions → **Contents** | **Read and write** |
| Repository permissions → Metadata | Read-only — added for you, cannot be removed |
| Expiration | Your call; publishing stops with a 401 the day it lapses |

Nothing else is needed: no Actions, no Pages, no account permissions. The
commonly missed one is **Contents**, because a token without it reads the
repository perfectly and fails on the first commit with a 403.

An **organisation-owned** repository needs one more step: an organisation
owner has to approve the token (Organisation settings → Personal access
tokens → Pending requests) before it can see the repository at all. Until
they do, publishing fails with a 404 for a repository that plainly exists.

A **classic** token works too if you prefer one: the `repo` scope, or
`public_repo` if the repository is public. It is a blunter instrument — it
reaches every repository you can push to — so use a fine-grained one unless
you have a reason not to.

The plugin reads the failure status back to you: 401 says the token is wrong
or expired, 403 says it lacks Contents: read and write, 404 says it cannot see
the repository.

**3. Install it.** Not on npm yet, so not in the App Store either — install
straight from git into the Signal K home directory:

```bash
cd ~/.signalk
npm install github:zackphillips/signalk-github-pages
sudo systemctl restart signalk        # or however you run the server
```

npm clones it, installs the dependencies and runs the TypeScript build via the
package's `prepare` script, leaving a loadable plugin in
`~/.signalk/node_modules/signalk-github-pages`.

Then open **Server → Plugin Config → GitHub Pages vessel tracker**, fill in
the repository owner, the repository name and the token, enable. Everything
else has a working default.

The first cycle writes the whole site — HTML, CSS, JS, icons — then telemetry
only. Give Pages a minute, then open the URL.

> [!TIP]
> Install [signalk-autostate](https://www.npmjs.com/package/signalk-autostate)
> if you have not. It sets `navigation.state`, which is what makes the cadence
> adaptive. Without it every cycle uses the stationary interval.

## Configuration

| Field | Default | Notes |
|---|---|---|
| `github.owner` | **required** | The user or organisation, e.g. `yourname` |
| `github.name` | **required** | The repository alone, e.g. `yourname.github.io` |
| `github.token` | **required** | Fine-grained PAT, Contents: read/write, this repo only |
| `github.branch` | `main` | Branch Pages serves |
| `interval.underway` | `120` s | When `navigation.state` is sailing or motoring |
| `interval.stationary` | `3600` s | Moored, anchored, or state unknown |
| `instrumentLog.paths` | the sparkline set | One path per line — [see below](#instrument-paths) |
| `instrumentLog.entries` | `120` | ~5 hours at a two-minute cadence |
| `positionRetentionHours` | `24` | How long raw positions stay in the map track |
| `history.enabled` | on | Read history from a Signal K history provider — [see below](#history-provider) |
| `history.providerId` | *empty* | Blank uses the server's default provider |
| `history.resolutionSeconds` | `60` | Bucket width asked of the provider |
| `history.timeoutMs` | `20000` | Past this the cycle falls back to local history |
| `staleMaxAgeMinutes` | `60` | Older values are dropped from the snapshot |
| `privacyZones[]` | *empty* | `{name, lat, lon, radius_m}` |
| `timezone` | UTC | Chosen from a list of IANA zones, for grouping tracks by local day |
| `polars` | *empty* | Polar table pasted in — [see below](#polars) |
| `site.theme` | `marine` | `marine`, `mermug`, `bright`, `dark` |
| `site.extraYaml` | *empty* | Free-form YAML merged into `info.yaml` |
| `buildDocsIndex` | on | Maintain `docs/index.json` |
| `publishFrontend` | on | Write the bundled site on install and upgrade |

The defaults are the numbers this tracker has run on since it was a Python
daemon on a Raspberry Pi. What has no default is anything belonging to one
particular boat: privacy zones start empty, the timezone starts at UTC (the
field names the zone your server is set to, so you know which one to pick),
and [the vessel's own details](#what-comes-from-signal-k) come from Signal K
rather than from this page.

Upgrading from a version with a single `owner/name` box: it still works until
you next save the config page, and the two new fields are filled from it the
first time the plugin reads it. Fill them in and the old field can go.

> [!WARNING]
> Signal K stores plugin configuration as plain JSON under
> `~/.signalk/plugin-config-data/`. Your token is readable by anyone with a
> shell on the server. Scope it to the one repository, and rotate it if the Pi
> ever leaves your hands.

## History provider

By default the plugin is its own historian: one position and one instrument
reading are appended per publish cycle, so the map track is sampled at the
publish cadence — a point every two minutes underway, an hour-wide gap at the
dock, and nothing at all from before the plugin was installed or while it was
stopped.

If the server has a **history provider** registered — [signalk-to-influxdb2]
and friends implement the Signal K History API — it already holds all of that
at full rate. The plugin then asks it for the window it publishes, on every
cycle, instead of relying on what it accumulated itself:

- The track is drawn at `history.resolutionSeconds` (60 s by default), not at
  the publish interval. One publish every two minutes still produces a
  two-minute-resolution *update*, but each one carries the whole window at a
  minute's detail.
- A restart, a reinstall, a moved data directory or a plugin that was off for
  a day no longer leaves a hole: the history is re-read, not accumulated.
- The instrument log covers `resolutionSeconds x entries` — 60 s x 120 is two
  hours — and is rebuilt from the database each cycle.
- Privacy zones are applied to every point on the way out, so a zone added
  after a passage redacts that passage on the next publish. The provider's own
  copy is untouched; it is a database on your boat.

Nothing about the published files changes: the frontend reads the same
`positions_index.json` and `instrument_log.json` either way.

The fallback is not a failure mode, it is the normal case on a server without
a provider. No provider registered, none configured, the database still
starting, a query past `history.timeoutMs` — each of those logs a line and
publishes the locally accumulated history instead. Local history is still
written on every cycle even when the provider answers, so a database that goes
away mid-passage leaves the track continuing rather than starting again.

Where the two overlap, the provider's value wins the bucket, but a bucket only
the local file has is kept — a database installed this week holds nothing from
last week's passage, and switching to it should not shorten a track that is
already published. The live reading from the tree wins over both: the newest
bucket in a database is up to one resolution behind.

Wildcard paths (`electrical.batteries.*.voltage`) are expanded against the
paths the provider reports, re-listed every 15 minutes. A literal path the
provider has never stored is still requested — a sensor that came online five
minutes ago is not in the listing yet.

Set `history.providerId` only if more than one provider is registered and you
want a specific one; blank means the server's default.

**Watch the bandwidth.** The whole window goes up on every publish, so
resolution costs data: 24 hours at 60 s is ~1,400 points, a
`positions_index.json` of roughly 250 kB, ~330 kB base64 on the wire, ~10 MB
an hour at a two-minute cadence. That is the same arithmetic as [the
instrument log](#why-this-matters-more-than-it-looks-like-it-should), and the
same levers fix it: a coarser `history.resolutionSeconds`, a shorter
`positionRetentionHours`, or a longer `interval.underway`. Every cycle logs
the size of each file it published, so the number is in front of you rather
than on your data bill at the end of the month.

[signalk-to-influxdb2]: https://www.npmjs.com/package/signalk-to-influxdb2

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

## What comes from Signal K

The boat's own details are not typed on the config page. Every cycle the
plugin reads the self tree and writes what it found into
`data/vessel/info.yaml`:

| `info.yaml` | Read from |
|---|---|
| `name`, `mmsi`, `uuid`, `flag`, `home_port` | `vessels.self` |
| `callsign` | `communication.callsignVhf`, then `callsignHf` |
| `imo`, `registrations` | `registrations.imo` / `.national` / `.local` / `.other` |
| `uscg_number` | The registration whose key or description says USCG, coast guard, documentation or official number — or a national one flagged `US` |
| `hull_number` | The registration whose key or description says HIN or hull |
| `design` | `design.length`, `.beam`, `.draft`, `.airHeight`, `.displacement`, `.keel`, `.aisShipType`, in metres and kilograms |
| `signalk.host`, `.port`, `.protocol` | The server's own settings and the Pi's LAN address |

It is read on every cycle, not once at start: a cold boot runs the first cycle
before the first product-information frame arrives, and an identity read once
would leave the site saying "Vessel" until the next restart. Dimensions are
rounded to the millimetre, so a float that wobbles in the last decimal place
does not commit `info.yaml` every two minutes.

`site.uscgNumber` and `site.hullNumber` on the config page are fallbacks for a
server that carries neither. Fill one in and it wins; if Signal K reports
something different, the log says so rather than quietly picking one.

## Polars

Paste the boat's polar table into the `polars` field and the plugin publishes
`data/vessel/polars.csv`, which is what the target-speed chart draws. The
format is the one every VPP and ORC export already produces — first line the
true wind speeds in knots, then a line per true wind angle in degrees:

```
twa/tws;6;8;10;12;14;16;20
52;5.0;5.9;6.5;6.9;7.1;7.2;7.3
90;5.6;6.5;7.2;7.6;7.9;8.2;8.7
150;4.0;5.0;6.0;6.7;7.2;7.6;8.5
```

Semicolons, commas, tabs or spaces all work, `#` starts a comment, and a
comma decimal separator is understood; the plugin re-renders whatever it reads
into the semicolon form the frontend parses. A short row is padded with zeros
rather than shifted onto the wrong wind speed, and anything it could not read
is named in the log — a polar table is a chart, not a position, so a typo in
one never stops a publish.

Leaving the field empty means the plugin publishes no polars and does not
claim the path: a `polars.csv` you committed by hand stays yours, and clearing
the field later leaves the last published file in place rather than deleting
the boat's performance data because a text box was emptied.

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
| `data/vessel/polars.csv` | Plugin, but only while the `polars` config field has a table in it |
| `docs/*.md` | **You** |
| `data/vessel/logo.png` | **You** |
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

## The site says "Data unavailable"

If the panels read *Data unavailable* while the Raw Data tab shows a current
snapshot, the page and the data have come from different places: the data is
fetched network-first, the page was served by the service worker out of the
device's cache.

That used to be permanent. The shell cache was named by a constant, served
cache-first and never revalidated, so a device that had loaded the site once
kept that release's HTML and JavaScript for good — including across a plugin
upgrade that published a new frontend. From 0.2.0 the cache is named after the
plugin version, shell assets are stale-while-revalidate, and `data/` is never
pre-cached, so a publish reaches a returning device on the next load or two.

To clear a device that is still stuck on the old worker: open the site in a
private tab to confirm that is what it is, then on iOS use Settings → Safari →
Advanced → Website Data → your site → Delete, or on a desktop browser hard-
reload it.

A single panel reading *Data unavailable* now means only that panel failed;
the message carries the error and the rest of the dashboard keeps rendering.

## It is not in the plugin list

The server discovers plugins by scanning `~/.signalk/node_modules` for
packages whose `package.json` carries the `signalk-node-server-plugin`
keyword, then `require`-ing each one. A plugin that fails to load is reported
as a provider error rather than shown in the menu, so the server log is the
first place to look.

```bash
ls ~/.signalk/node_modules/signalk-github-pages/dist/index.js   # 1
grep -i signalk-github-pages ~/.signalk/signalk-server.log      # 2
node -e "console.log(require(process.env.HOME + \
  '/.signalk/node_modules/signalk-github-pages'))"              # 3
```

1. **No such file** — the build did not run. This is the usual one after a
   `git clone` straight into `node_modules`, which skips npm entirely and so
   skips `prepare`. Fix it in place:
   ```bash
   cd ~/.signalk/node_modules/signalk-github-pages && npm install && npm run build
   ```
2. **`Failed to start`, or a stack trace** — the module threw on load. The
   trace names the reason; a missing `js-yaml` means the dependencies were
   never installed.
3. **Prints a function** — the package is fine and the problem is elsewhere:
   confirm the server was restarted, that it is reading the `~/.signalk` you
   are looking at (`SIGNALK_NODE_CONFIG_DIR` overrides it), and that Node is
   18 or newer (`node -v`).

`npm install signalk-github-pages` by name fails with a 404 until this is
published. Use the git form above.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm run dev       # public/ + sample/ on http://localhost:8000
```

`npm run dev` serves the real frontend against fixture telemetry: a day's
track, sixty instrument-log entries, a sailing snapshot and a polar table. No
boat required.

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
  vesselInfo.ts     data/vessel/info.yaml, and reading the boat off the tree
  polars.ts         data/vessel/polars.csv from the pasted table
  timezones.ts      The IANA list behind the timezone dropdown
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
