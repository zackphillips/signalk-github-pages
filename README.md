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

No `git` binary. No working copy to corrupt. No systemd unit. Nothing to
hand-edit: every setting is either on the plugin's config page or read from
the server. The plugin reads the self tree in-process, keeps its rolling
state in `app.getDataDirPath()`, and each cycle is one commit built on the
live `HEAD`.

## What you get

| | |
|---|---|
| **Live position** | With privacy zones: inside one, the site shows the zone centre and the track simply stops |
| **Per-day GPX tracks** | Recorded from position deltas and thinned by shape, so a tack is a tack and a straight leg is cheap. Grouped by *your* local calendar day, not by UTC — a voyage does not get cut in half mid-afternoon |
| **Instrument sparklines** | A rolling log of exactly the paths you name, and nothing else |
| **Thresholds from the boat** | Good, warn and alert come from `meta.zones` on the Signal K path — the same zones the server's own alarms use. Nothing is hard-coded |
| **Notifications** | Active Signal K notifications raised on the page, and how many times each has fired in the last 1, 3, 12 and 24 hours |
| **Ship's docs** | Markdown in `docs/`, edited from the GitHub web UI on a phone, rendered client-side |
| **Adaptive cadence** | Fast underway, slow at anchor, straight off `navigation.state` — and a publish the moment that changes, so a departure is not invisible for an hour |
| **Sparklines from your database** | With a Signal K history provider installed, the instrument log is read back from it — full resolution, no gap across a restart, nothing accumulated on the Pi |
| **Ownership manifest** | The plugin writes only the paths it declares; the rest of the repo is yours |
| **On-boat console** | A Signal K webapp that renders the site from live data and prunes old voyages |
| **Honest accounting** | Every cycle logs what it cost: bytes on the wire, API calls, rate limit left |

## Quick start

**1. A repository with Pages on.** The plugin publishes to `<you>.github.io`
unless you override the name; anything else is served at `/<repo>/`.
Settings → Pages → Deploy from a branch → `main` / `(root)`.

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

Then open **Server → Plugin Config → GitHub Pages Vessel Tracker**, fill in
the repository owner and the token, enable. Everything else has a working
default or is derived.

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
| `github.overrideName` | off | Publish somewhere other than `<owner>.github.io` |
| `github.name` | derived | `<owner>.github.io` unless the override is ticked |
| `github.token` | **required** | Fine-grained PAT, Contents: read/write, this repo only |
| `github.branch` | `main` | Branch Pages serves |
| `interval.underwayMinutes` | `2` | When `navigation.state` is sailing or motoring |
| `interval.stationaryMinutes` | `60` | Moored, anchored, or state unknown |
| `instrumentLog.paths` | the sparkline set | One path per line — [see below](#instrument-paths) |
| `instrumentLog.entries` | `60` | Log length in buckets: 60 x 60 s is the last hour, and the longest window the site's history dropdown will offer |
| `positionRetentionHours` | `24` | How long raw positions stay in the map track |
| `track.detailMetres` | `15` | Keep a fix when dropping it would move the drawn track by more than this — [see below](#the-track) |
| `history.enabled` | on | Read the instrument log from a history provider — [see below](#history-provider) |
| `history.providerId` | *empty* | Blank uses the server's default provider |
| `history.resolutionSeconds` | `60` | Bucket width asked of the provider, and the log's spacing |
| `history.timeoutMs` | `20000` | Past this the cycle publishes no log and leaves the last one up |
| `staleMaxAgeMinutes` | `60` | Older values are dropped from the snapshot |
| `privacyZones[]` | *empty* | `{name, lat, lon, radius_m}` |
| `timezone.override` | off | Group tracks by a zone other than the server's |
| `timezone.zone` | the server's zone | IANA zone, for grouping tracks by local day |
| `polars.override` | off | Publish the table below instead of the active polar |
| `polars.table` | the active polar | Read-only until the override is ticked, [see below](#polars) |
| `site.customLinks[]` | *empty* | `{label, url}` buttons added to the site's link row |
| `site.overrideUscgNumber` | off | Type a documentation number instead of reading it from Signal K |
| `site.overrideHullNumber` | off | Likewise for the hull number |
| `site.defaultLocation` | *empty* | Default position `{lat, lon, label}` — tides and the map before the boat has a fix |
| `buildDocsIndex` | on | Maintain `docs/index.json` |
| `publishNotifications` | on | Publish active notifications and the 24-hour firing log — [see below](#zones-and-notifications) |

The defaults are the numbers this tracker has run on for years on a
Raspberry Pi. Four settings are derived rather than typed — the
repository name from the owner, the timezone from the server, the polar table
from Polar Management, and the USCG and hull numbers from the Signal K
registrations — and each has an override checkbox beside it. What has no
default at all is what belongs to one particular boat: privacy zones start
empty, and [the vessel's own details](#what-comes-from-signal-k) come from
Signal K rather than from this page.

> [!WARNING]
> Signal K stores plugin configuration as plain JSON under
> `~/.signalk/plugin-config-data/`. Your token is readable by anyone with a
> shell on the server. Scope it to the one repository, and rotate it if the Pi
> ever leaves your hands.

## The track

The track is recorded from `navigation.position` deltas, which arrive several
a second, and thinned by *shape*: a fix is kept when dropping it would move
the drawn line by more than `track.detailMetres`, and at least once per
publish cycle whatever the shape says.

That is not the same as sampling more often. The Git Data API uploads whole
files and the day's GPX is rewritten every cycle, so a point on a straight
line is paid for again every two minutes until midnight. Thinning by shape
spends points where the track bends and nothing where it does not:

| An hour of… | Delta + shape | One fix per cycle |
|---|---|---|
| 60-second tacks | 60 points, track exactly right | 30 points, up to 128 m wrong |
| A mark rounding | 9 points, 9 m | 5 points, 174 m |
| Straight motoring | same as before | same |

Lower `detailMetres` follows a tack more closely and uploads more; higher is
cheaper on a hotspot. On a server that does not offer position deltas the
plugin falls back to one fix per cycle, as before, and says so in the log.

## History provider

The two histories the site draws come from different places, on purpose.

**The track is the plugin's own.** Every cycle it takes the fix off the Signal
K tree, redacts it against the privacy zones, appends it to
`positions_index.json` and rolls the day's GPX. That works on any server, with
no database and no extra plugin, and it keeps one code path — one redaction —
between a position and a public repository.

**The instrument log comes from a history provider.** If the server has one
registered ([signalk-to-influxdb2] and friends implement the Signal K History
API) it already stores every value at full rate, so the plugin asks it for the
sparkline window on every cycle instead of accumulating readings itself:

- The graphs are spaced at `history.resolutionSeconds` (60 s by default)
  rather than at the publish interval, so they are finer than a two-minute
  cadence can produce.
- The log covers `entries x resolution`: 60 entries at 60 s is the last hour.
  That span is also what the site's history dropdown can offer — see
  [how far back the sparklines go](#how-far-back-the-sparklines-go).
- A restart, a reinstall, a moved data directory or a plugin that was off for
  a day no longer leaves a hole. Nothing is accumulated, so there is nothing
  to lose.
- `navigation.position` is never asked for, by name or through a wildcard. The
  database holds raw positions; the track does not come from there.

**With no provider, the site simply has no sparklines.** The panels show
current values and omit the graphs — `instrument_log.json` is published empty,
once, so an upgraded install does not leave a frozen graph on the page
forever. That is the normal case on a server without a history provider, not a
failure.

**A provider that stops answering is different from one that is not there.**
A database still starting, a query past `history.timeoutMs`, a provider that
threw: the cycle publishes no log at all and leaves the copy already on the
site in place. A sparkline a few minutes stale beats a blank panel every time
InfluxDB restarts. The plugin logs the reason, once per change of state.

Wildcard paths (`electrical.batteries.*.voltage`) are expanded against the
paths the provider reports, re-listed every 15 minutes. A literal path the
provider has never stored is still requested — a sensor that came online five
minutes ago is not in the listing yet.

Set `history.providerId` only if more than one provider is registered and you
want a specific one; blank means the server's default.

The whole log goes up on every publish, so its size is `entries` x paths: see
[why that matters](#why-this-matters-more-than-it-looks-like-it-should).

[signalk-to-influxdb2]: https://www.npmjs.com/package/signalk-to-influxdb2

### How far back the sparklines go

Open a panel's **Show History** and a window dropdown appears beside it: 1, 3,
12 or 24 hours. It is one setting for the whole page, not one per panel —
battery voltage is read against solar power and boat speed, and they only line
up on a shared axis.

What the dropdown can offer is decided by the published file, not by the site.
`instrument_log.json` reaches back `entries x resolution`, so the defaults (60
entries at 60 s) cover an hour, and the site marks the three longer windows
*(not logged)* and disables them rather than drawing three copies of the same
chart under different labels.

To make them selectable, raise `instrumentLog.entries`:

| Window | `entries` at 60 s | `entries` at 300 s |
| --- | --- | --- |
| 1 hour | 60 | 12 |
| 3 hours | 180 | 36 |
| 12 hours | 720 | 144 |
| 24 hours | 1440 | 288 |

Every one of those entries is uploaded in full on every publish, so this is a
real decision and not a knob to turn up by reflex. At the default path list, 24
hours at 60 s is roughly half a megabyte a cycle — fine on a dock, expensive on
a hotspot at a two-minute cadence. Coarsening `history.resolutionSeconds` buys
the same window for a fifth of the bytes and costs detail inside the shorter
ones: at 300 s the 1-hour view is twelve points. Pick the pair you want, or
leave it at an hour.

## Instrument paths

One Signal K path per line — this is what the plugin asks the history provider
for. `*` matches one segment, so `electrical.batteries.*.voltage` covers every
bank the provider has stored. Lines starting with `#` are comments. A path no
instrument produces costs nothing — it comes back as a column of nulls and
never appears in the file.

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

Asking for every path a database has stored is roughly 167 per entry, which at
200 entries is a ~1 MB file. At a two-minute cadence that is about **40 MB per
hour** over the hotspot, for data the sparklines never draw. The defaults are
about two dozen patterns over 60 entries: tens of kilobytes, a megabyte or two
an hour. Both halves are levers — the path list and `instrumentLog.entries` —
and the second one is what the history dropdown spends: see [how far back the
sparklines go](#how-far-back-the-sparklines-go).

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

## Zones and notifications

The dashboard has no thresholds of its own. Whether 46% state of charge is
fine or alarming is a property of a battery bank, not of a web page: 46% is
comfortable on 600Ah of LiFePO4 and nearly flat on a tired 200Ah of AGM.
The frontend used to carry twelve constants that answered for every boat —
battery, tank, anchor and packet-loss levels — and they are gone.

What paints a value now is `meta.zones` on the Signal K path, which is where
the server keeps it anyway:

```json
"electrical.batteries.house.capacity.stateOfCharge": {
  "meta": {
    "zones": [
      { "upper": 0.2, "state": "alarm", "message": "House bank critical" },
      { "lower": 0.2, "upper": 0.5, "state": "warn", "message": "House bank low" },
      { "lower": 0.5, "state": "normal" }
    ]
  }
}
```

Set them on the server's **Data Fiddler** page (Server → Data Fiddler → the
path → Meta), or let the plugin that owns the sensor publish them. `normal`
and `nominal` render green, `warn` and `caution` amber, `alert`, `alarm` and
`emergency` red, and a zone's `message` becomes the label. Bounds are
half-open — `lower <= value < upper` — so adjacent zones do not overlap.

**A path with no zones renders with no colour.** That is deliberate, and it is
the same rule the rest of the site follows: an unknown position renders as
unknown rather than as San Francisco Bay. If a value should be flagged, the
place to say so is the server, where the alarm that sounds the buzzer is
configured — not a second set of numbers here that can disagree with it
silently.

### Notifications

`data/telemetry/notifications.json` carries two things. **Active** is the
current set straight off `notifications.*`, raised in a banner above the tabs
whichever tab is open. **Events** is the firing log, and the Notifications
panel counts it over 1, 3, 12 and 24 hours.

A firing is an **edge**, not a sample: an alarm that comes on and stays on for
six hours counts once. Counting samples would make the number a function of
the publish cadence, which changes with `navigation.state` — the same alarm
would score thirty times higher underway than at anchor. An escalation
(`warn` → `alarm`) counts as a new firing; a producer that re-stamps an
unchanged notification does not.

The honest limit, and the panel says so: anything that fires **and clears**
between two publishes is never seen. At the dock that gap is the stationary
interval, an hour by default. The counts are a floor, not a total. The panel
also marks any window longer than the log has been running, so a plugin
restarted at 06:00 does not report a quiet night it never watched.

The log lives in the plugin's data directory, is pruned to 24 hours, and is
capped at 500 events so a float switch flapping either side of its zone cannot
grow the file without bound.

> [!NOTE]
> A notification's `message` is free text written by whichever plugin raised
> it, and it is published verbatim to a public website. Everything else the
> plugin publishes is a number off a known path, which is why this one has an
> off switch: `publishNotifications`.

## What comes from Signal K

The boat's own details are not typed on the config page and not published a
second time: `data/telemetry/signalk_latest.json` is the whole self tree, so
the name, MMSI, callsign, registrations and dimensions are already there and
the site reads them from there.

`data/vessel/site.json` carries only what the snapshot cannot supply — the
privacy zones, the custom links, the default position, the timezone, the
address the site links back to — plus two numbers the plugin derives from the
tree so the frontend does not have to:

| Derived | Read from |
|---|---|
| `uscg_number` | The registration whose key or description says USCG, coast guard, documentation or official number — or a national one flagged `US` |
| `hull_number` | The registration whose key or description says HIN or hull |
| `signalk.host`, `.port`, `.protocol` | The server's own settings and the Pi's LAN address |

It is read on every cycle, not once at start: a cold boot runs the first cycle
before the first product-information frame arrives, and an identity read once
would leave the GPX saying "Vessel" until the next restart.

### The passage banner

Activate a waypoint or a route on the plotter and the banner appears: where
you are bound, where you departed from if the course names it, and when. It
comes from the **Course API** — `startTime` is the departure, with no state
for the plugin to keep — so clearing the destination on arrival takes the
banner down by itself.

This used to be a `passage:` block hand-edited into the published config from
the GitHub web UI before departure and deleted on arrival, which meant it was
wrong whenever anyone forgot. Nothing on the site is hand-edited now.

No coordinates are published, only names: `previousPoint` is usually the
vessel's own position at the moment you activated the waypoint, and falling
back to its latitude and longitude would put the slip you just left on a
public page through a path the privacy zones do not guard. The ETA is left
out too — `targetArrivalTime` is recomputed continuously, and `site.json` is
only rewritten when its content changes.

The config page shows both numbers read-only. Tick `site.overrideUscgNumber`
or `site.overrideHullNumber` to type one instead; if Signal K reports something
different, the log says so rather than quietly picking one.

The polar table comes from the server the same way — see below.

### Default position

The tide and forecast panels use the boat's position. Before there is a fix
they use `site.defaultLocation`, and if that is not set either they say so and
wait. Tick **Set to the current position** on the config page and save: the
plugin copies `navigation.position` into the coordinates and unticks the box.

Nothing stands in for it. The frontend used to carry a hardcoded San Francisco
Bay, so a boat in the Chesapeake with a cold GPS was shown Golden Gate tides
under a heading that read like its own — a wrong number presented as a right
one. The same went for a fallback privacy zone at one particular dock, and for
a whole fallback vessel identity (name, MMSI, documentation number) used when
the site configuration failed to load, which made every such site introduce
itself as somebody else's boat. So was a fabricated telemetry snapshot shown
when `signalk_latest.json` would not load, which told anyone following the
boat it was sailing in ten knots off Ocean Beach when in fact publishing had
broken. All of them are gone: unknown renders as unknown.

## Polars

The polar table is not configured here. Install
[Polar Management](https://www.npmjs.com/package/signalk-polar-management),
import the boat's polar there — it will pull an ORC certificate by boat name
or sail number — and mark one active. Every cycle this plugin reads
`polars.activePolar` off the self tree, fetches that `polars` resource through
the server's Resources API, and writes `data/vessel/polars.csv`, which is what
the target-speed chart draws:

```
twa/tws;6;8;10;12;14;16;20
52;5.0;5.9;6.5;6.9;7.1;7.2;7.3
90;5.6;6.5;7.2;7.6;7.9;8.2;8.7
150;4.0;5.0;6.0;6.7;7.2;7.6;8.5
```

The resource is stored in SI units — true wind speed and boat speed in m/s,
true wind angle in radians, the matrix indexed `[tws][twa]` — so it is
converted to knots and degrees and transposed on the way out, rounded to two
decimals so a polar that has not moved produces a byte-identical file and no
commit. Anything unreadable is named in the log: a polar table is a chart, not
a position, so it never stops a publish.

The read is in-process, so there is no HTTP call and no token. Re-import a
polar or switch which one is active and the change reaches the site on the
next cycle, with nothing to restart.

### Overriding it

The config page shows the active polar in a read-only box. Tick **Override
polar** to publish a table typed there instead — for a boat whose polar is on
a sailmaker's PDF and which is not about to install a second plugin to type it
in. Paste it in any shape it arrives — semicolons, commas, tabs or spaces, `#`
comments, a European decimal comma — and the plugin re-renders it into the
form the chart parses. An override that will not parse falls back to the
server rather than blanking the chart. The config page says which of the two
is in use every time you open it:

> In use: `"mermug-orc"` from Polar Management, 18 angle(s) x 7 wind speed(s).
> This box is ignored while that holds.

No polar from either source means the plugin publishes none and does not claim
the path: a `polars.csv` you committed by hand stays yours, and clearing the
active polar later leaves the last published file in place rather than
deleting the boat's performance data because a dropdown was emptied.

## What the plugin writes

The repository is shared with you. The plugin writes `.tracker-manifest.json`
listing every path it manages, and refuses to put anything outside that list
into a commit.

| Path | Owner |
|---|---|
| `data/telemetry/**` | Plugin, every cycle |
| `data/vessel/site.json` | Plugin, when the configuration or the passage changes |
| `docs/index.json` | Plugin, when the docs tree changes |
| `index.html`, `docs.html`, `sw.js`, `manifest.json`, `.nojekyll`, `assets/**`, `data/tide_stations.json` | Plugin, on install and after an upgrade |
| `data/vessel/polars.csv` | Plugin, but only while it has a polar to publish |
| `docs/*.md` | **You** |
| `data/vessel/logo.png` | **You** |
| `assets/custom.css` | **You** — loaded last by both pages, never written here |
| Everything else | **You** |

Each publish builds a tree against the live `HEAD` with only those paths
layered on top, so a docs edit from your phone and a telemetry commit from the
boat interleave cleanly in either order. The only race is the ref update
landing behind someone else's push: re-read, rebuild, retry once. The ref is
never force-updated, so a concurrent edit is never lost.

## The console

Signal K serves a page for the plugin at **`http://<your-pi>:3000/signalk-github-pages/`**,
linked from the server's Webapps list. It does two things the config page
cannot.

**The preview** renders the published site from the plugin's own data, on the
boat, with no round trip to GitHub — the same HTML, CSS and JavaScript that
Pages serves, reading live telemetry instead of committed JSON. It works at
anchor with the hotspot off, and it is the fastest way to see what a privacy
zone or a custom button actually does before it is committed. It shows what the Pi
holds: past days whose GPX lives only in the repository are not in it.

**Publishing on request.** *Publish now* runs a cycle immediately rather than
waiting for the next one, which at the stationary cadence can be an hour
away — useful on departure, and after anything you want ashore to see at
once. *Rewrite the whole site* republishes every HTML, CSS, JavaScript and
icon file on top of that. A plugin upgrade already does that by itself, so
the button is for what a version number cannot see: a file deleted by hand on
GitHub, a commit that landed half-way, a repository rolled back.

The same thing is a PUT to `tracker.publishNow` on `vessels.self`, so a KIP
button, a Node-RED flow or a switch wired through another plugin can ask for
a publish without opening this page.

**Pruning** removes old voyages. A year of two-minute cycles is a lot of GPX,
and nothing else this plugin does ever takes anything away.

| | |
|---|---|
| *Remove voyages older than N days* | Keeps the last N local days |
| *Remove all* | Keeps today only |

Both name the days before they do anything: the page asks the plugin what
would go, shows you the count and the range in a confirmation panel, and
removes nothing until you press *Yes, remove them*. The confirmation is part
of the page rather than a browser dialog, because Signal K serves webapps
inside a sandboxed iframe where `window.confirm` is ignored. What is removed is the per-day GPX file and its row in
`tracks_index.json`, in one commit — the data is still in the repository's git
history; what goes is the copy the site serves. Today is never removed: the
position index still holds its points and the next cycle would write the file
straight back.

Nothing prunes on a schedule. There is no retention setting for tracks, on
purpose — a passage nobody meant to lose should not disappear because a number
in a form was too small.

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
npm run dev       # site/ + sample/ on http://localhost:8000
```

`npm run dev` serves the real frontend against fixture telemetry: a day's
track, sixty instrument-log entries, a sailing snapshot with `meta.zones` set
on the battery and tank paths, a day of notification firings and a polar
table. No boat required.

`Publisher.runCycle()` takes a self tree and returns what it did — it never
calls back into the server — so a full publish cycle is tested without Signal
K and without a network. `test/helpers/fakeGitHub.ts` is an in-memory Git Data
API, including the ETag on the tree listing and a ref update that can lose a
race.

<details>
<summary><strong>Layout</strong></summary>

```
src/
  index.ts          Plugin entry: schema, start/stop, tick scheduling, router
  config.ts         Config schema, parsing, validation
  publisher.ts      One cycle end to end, and the voyage prune
  webapp.ts         The console's routes: status, preview, prune
  preview.ts        The site's data files, rendered live and never published
  prune.ts          Which voyages a prune would take
  snapshot.ts       Self-tree read, stale filter, position redaction
  privacy.ts        Haversine, privacy zones
  positions.ts      positions_index.json
  instrumentLog.ts  instrument_log.json + the path allowlist
  gpx.ts            Per-day GPX and tracks_index.json
  docsIndex.ts      docs/index.json
  siteConfig.ts     data/vessel/site.json, and reading the boat off the tree
  course.ts         The passage banner, from the Course API
  polars.ts         data/vessel/polars.csv, from the server or the config
  timezones.ts      The IANA list behind the timezone dropdown
  frontend.ts       Reading site/, templating constants.js
  github.ts         Git Data API client, publish-with-retry
  manifest.ts       Ownership allowlist
  state.ts          Rolling state, atomic writes
site/               The published site, shipped in the package
public/             The console webapp Signal K mounts
sample/             Fixture telemetry for the dev server
```

</details>

> [!IMPORTANT]
> `site/assets/constants.js` must keep declaring `var VESSEL_CONSTANTS`.
> `const` at the top level of a classic script does not create
> `window.VESSEL_CONSTANTS`, `app.js` throws on the missing global, and the
> entire page goes blank.

## Trade-offs worth knowing

**The plugin runs inside the server process.** A bug here can affect the
navigation data hub. Every cycle is wrapped: an exception skips one update,
is reported in the admin UI, and never reaches the server's event loop. That
is the cost of reading the tree in-process, and it buys away an HTTP poll
that could freeze the site on stale data.

**The token sits in plain text**, as above.

**One commit per cycle.** The repository grows at the rate you publish. Keep
the path list tight.

**Nothing is served from the boat.** That is KIP's job. This site is for
people ashore, and it stays up when the boat's link does not.

## License

MIT.
