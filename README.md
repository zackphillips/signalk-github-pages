<h1 align="center">signalk-github-pages</h1>

<p align="center">
  <em>Your boat publishes its own website.</em><br>
  A Signal K plugin that turns live vessel data into a static GitHub Pages site —
  position, tracks, instruments and the ship's docs — with no server ashore
  and no git checkout on board.
</p>

<p align="center">
  <img alt="Signal K plugin" src="https://img.shields.io/badge/Signal%20K-server%20plugin-0a7ea4">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-5fa04e">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="License BSD-3-Clause" src="https://img.shields.io/badge/license-BSD--3--Clause-blue">
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
| **Live position** | With privacy zones: inside one, the site shows the zone center and the track simply stops |
| **Per-day GPX tracks** | Recorded from position deltas and thinned by shape, so a tack is a tack and a straight leg is cheap. Grouped by *your* local calendar day, not by UTC — a voyage does not get cut in half mid-afternoon |
| **Instrument sparklines** | Every number the boat reports that your history provider has stored, less the paths you exclude. A path no panel knows about still gets drawn, labeled from the server's own metadata |
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
| Resource owner | You, or the organization that owns the repository |
| Repository access | **Only select repositories** → the Pages repository |
| Repository permissions → **Contents** | **Read and write** |
| Repository permissions → Metadata | Read-only — added for you, cannot be removed |
| Expiration | Your call; publishing stops with a 401 the day it lapses |

Nothing else is needed: no Actions, no Pages, no account permissions. The
commonly missed one is **Contents**, because a token without it reads the
repository perfectly and fails on the first commit with a 403.

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
| `github.owner` | **required** | The user or organization, e.g. `yourname` |
| `github.token` | **required** | Fine-grained PAT, Contents: read/write, this repo only |
| `interval.underwayMinutes` | `2` | When `navigation.state` is sailing or motoring |
| `interval.stationaryMinutes` | `60` | Moored, anchored, or state unknown |
| `privacyZones[]` | *empty* | `{name, lat, lon, radius_m}` — see [Privacy zones](#privacy-zones) |
| `instrumentLog.exclude` | design, course, GNSS housekeeping… | Paths never logged, one per line; everything else the boat reports gets a sparkline — [see below](#instrument-paths) |
| `instrumentLog.hours` | `1` | How far back the sparklines plot; 0 publishes no log — [see below](#history-provider) |
| `instrumentLog.providerId` | *server default* | A dropdown of the history providers registered on the server |
| `staleMaxAgeMinutes` | `60` | Older values are dropped from the snapshot |
| `track.detailMeters` | `15` | Keep a fix when dropping it would move the drawn track by more than this — [see below](#the-track) |
| `notifications.publish` | on | Publish active notifications and the 24-hour firing log — [see below](#zones-and-notifications) |
| `notifications.exclude` | `server.history.defaultProvider` | Notification paths never published, one per line — [see below](#notifications) |
| `notifications.warnAfterMinutes` | `30` | Raise a Signal K notification after this long without a successful publish; 0 turns it off |
| `site.logo` | *empty* | The vessel's logo, uploaded here — see [Branding](#branding) |
| `site.icon` | *empty* | The tab, home-screen and link-preview icon, uploaded separately from the logo — see [Branding](#branding) |
| `site.customLinks[]` | *empty* | `{label, url}` buttons added to the site's link row |

### Overrides

Six settings are worked out by the plugin rather than typed, and all six live
in their own **Overrides** section at the bottom of the page. Each has a
checkbox, and the checkbox opens with a mark saying whether the plugin found
a value — ✅ found, ⚠️ not found, ⏳ not checked yet because no cycle has run —
and what it was, read afresh every time the page is opened. Tick one and the
box to type your own appears directly beneath it; untick it and the box goes
away and is ignored.

| Override | Derived from | Typed value |
|---|---|---|
| `overrides.overrideRepository` | `<owner>.github.io` | `overrides.repository` — a project site such as `tracker` |
| `overrides.overrideBranch` | `main`; the mark says whether the last cycle published to it | `overrides.branch` |
| `overrides.overrideSiteUrl` | the Pages URL for the repository | `overrides.siteUrl` — a custom domain |
| `overrides.overrideTimezone` | the server's timezone | `overrides.timezone` — an IANA zone, from a list |
| `overrides.overridePolar` | the active polar in Polar Management | `overrides.polar` — [see below](#polars) |
| `overrides.overrideTideStation` | the NOAA station nearest the boat | `overrides.tideStation` — see [Tide station override](#tide-station-override) |

The defaults are the numbers this tracker has run on for years on a
Raspberry Pi. What has no default at all is what belongs to one particular
boat: privacy zones start empty, and [the vessel's own
details](#what-comes-from-signal-k) come from Signal K rather than from this
page.

Settings that used to be on this page and are not any more — an instrument
log length and a bucket width where there is now one window, a history query
timeout, a switch for `docs/index.json`, and the overrides that used to sit
in the section of the setting they overrode — are still read from a config
written against them, and a config that carries them opens showing its own
values (ticked boxes included) rather than the new defaults. Nothing resets
on upgrade. The one exception is `track.positionRetentionHours`, which left
the page and is no longer read: the map's track is always the last 24 hours,
and past days survive as GPX regardless.

> [!WARNING]
> Signal K stores plugin configuration as plain JSON under
> `~/.signalk/plugin-config-data/`. Your token is readable by anyone with a
> shell on the server. Scope it to the one repository, and rotate it if the Pi
> ever leaves your hands.

## The track

The track is recorded from `navigation.position` deltas, which arrive several
a second, and thinned by *shape*: a fix is kept when dropping it would move
the drawn line by more than `track.detailMeters`, and at least once per
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

Lower `detailMeters` follows a tack more closely and uploads more; higher is
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

- The graphs are spaced at 60 s rather than at the publish interval, so they
  are finer than a two-minute cadence can produce.
- The log covers `instrumentLog.hours` — an hour by default. That span is also
  what the site's history dropdown can offer, see [how far back the sparklines
  go](#how-far-back-the-sparklines-go).
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
A database still starting, a query past the twenty-second timeout, a provider
that threw: the cycle publishes no log at all and leaves the copy already on
the site in place. A sparkline a few minutes stale beats a blank panel every time
InfluxDB restarts. The plugin logs the reason, once per change of state.

Wildcard paths (`electrical.batteries.*.voltage`) are expanded against the
paths the provider reports, re-listed every 15 minutes. A literal path the
provider has never stored is still requested — a sensor that came online five
minutes ago is not in the listing yet.

The **History provider** dropdown lists the providers registered on the
server, found by asking each enabled plugin; change it only if more than one
is registered and you want a specific one. *Server default* follows the
server's own setting. Setting `instrumentLog.hours` to zero turns the whole
thing off.

**Why the site says "(not logged)" past an hour.** The sparkline menu offers
1, 3, 12 and 24 hours, and marks any window longer than the published log as
not logged rather than drawing a copy of a shorter one. The log is as long as
`instrumentLog.hours`, which defaults to 1. Set it to 24 for all four; the
bucket width grows with the window (4 minutes at 24 hours), so the file
stays around 130 kB rather than growing 24-fold.

The whole log goes up on every publish, so its size is the bucket count times
the paths: see
[why that matters](#why-this-matters-more-than-it-looks-like-it-should).

[signalk-to-influxdb2]: https://www.npmjs.com/package/signalk-to-influxdb2

### How far back the sparklines go

Open a panel's **Show History** and a window dropdown appears beside it: 1, 3,
12 or 24 hours. It is one setting for the whole page, not one per panel —
battery voltage is read against solar power and boat speed, and they only line
up on a shared axis.

What the dropdown can offer is decided by the published file, not by the site.
`instrument_log.json` reaches back `instrumentLog.hours`, an hour by default,
and the site marks the three longer windows *(not logged)* and disables them
rather than drawing three copies of the same chart under different labels.

Raise the window and they become selectable. The bucket width follows from it
rather than being a second setting, capped at 360 buckets so the file does not
grow with the window:

| `instrumentLog.hours` | Bucket width | Buckets published |
| --- | --- | --- |
| 1 | 60 s | 60 |
| 3 | 60 s | 180 |
| 6 | 60 s | 360 |
| 12 | 120 s | 360 |
| 24 | 240 s | 360 |

The whole file is uploaded on every publish, so the cap is what keeps a day of
history off a hotspot budget: 24 hours costs about 130 kB a cycle at the
size of the default two dozen paths rather than the half megabyte 1440 one-minute buckets would.
What it costs instead is detail inside the shorter views — at a 24-hour window
the 1-hour view is fifteen points. An hour is the default because it is what
every install can carry; six hours is the longest window that keeps full
60 s resolution.

## Instrument paths

Every path gets a sparkline unless you exclude it. A path is logged when the
history provider has stored it **and** the boat is reporting a number for it
right now. The first condition is what makes a sparkline possible. The second
keeps out everything the database remembers but the boat no longer has: the
sensor you unplugged in March, the bank you renamed.

**Never logged** (`instrumentLog.exclude`) is the list to leave out. One path
per line; `*` matches one segment, a parent excludes its whole subtree
(`design` drops every `design.*` path), and lines starting with `#` are
comments. Empty logs everything the boat reports. The default leaves out
what is not worth a graph:

```
design
navigation.course
navigation.courseRhumbline
navigation.courseGreatCircle
navigation.gnss
navigation.datetime
communication
sensors
notifications
```

**Positions are never logged, whatever this list says.** Any path with a
`position` segment is dropped from the query and from the answer, and so is
any value carrying a latitude or longitude. That covers
`navigation.anchor.position` (the drop point, often inside your privacy
zone) and `navigation.course.previousPoint.position` (the slip you just
left). The track is the only way a position reaches the site, and it goes
through the privacy zones.

A path no panel draws is not lost: it appears under **Other Instruments** on
the Data tab, named, converted and colored from the metadata the server
publishes for it.

The log is the entire bandwidth cost of a cycle, and its size now follows the
boat rather than the config page. The plugin logs the file's size every
cycle and warns past 512 kB. If it is more than you want on a cellular plan,
add paths to *Never logged* — `environment.rpi`, per-cell battery voltages,
whatever you never look at — or shorten the window.

The old allowlist, `instrumentLog.paths`, is not read any more. Carried over
as an exclusion list it would have excluded exactly the paths it named.

### Why this matters more than it looks like it should

`git push` sends a delta. The Git Data API does not: every changed file goes
up whole, base64-encoded, in a JSON body it will not accept compressed. The
instrument log is a rolling window, so *every* entry shifts position each
cycle — there is no "only the tail changed" for a delta to find even if one
were possible.

Asking for every path a database has stored was once roughly 167 per bucket,
which at 200 buckets is a ~1 MB file. At a two-minute cadence that is about
**40 MB per hour** over the hotspot. That is why only paths the boat is
reporting now are asked for, and why the exclusion list exists. Size scales
with paths × buckets: 60 live paths over the default 60 buckets is on the
order of 150 kB a file, about 5 MB an hour underway. The exclusion list is the
lever that matters, because the bucket count is capped: see [how far back the
sparklines go](#how-far-back-the-sparklines-go).

The plugin measures this rather than assuming it. Past half a megabyte the log
line becomes a warning with the hourly cost at your configured cadence.

## Units, names and thresholds come from the server

Signal K carries `meta` on every path — `units`, `displayName`, `description`
and the `zones` that say what counts as normal, warn and alarm — and the site
reads all of it off the published snapshot rather than hardcoding a second
copy.

That is what lets a path this release has never heard of be rendered
properly: `propulsion.port.coolantTemperature` shows as "Port Coolant" in
your preferred temperature unit, colored by the zones you set on the
server's Data Fiddler page, with the server's description as its tooltip. Set
the zone in Signal K and the site follows; there is nowhere here to set a
threshold, on purpose, because the server is where the alarm that sounds the
buzzer is already configured.

## Privacy zones

A position inside a zone is published as the zone's **center**, and that point
is left out of the GPX track **entirely** rather than snapped to the middle —
a night at the dock would otherwise be a pile of identical points saying
exactly where you sleep. Speed and course are withheld from the track too, so
it cannot show you maneuvering in the harbor.

**Every** position in the published snapshot is checked, not just
`navigation.position`. That matters most for `navigation.anchor.position`:
anchoring inside a zone used to show the zone center for the boat while
publishing the true anchor drop coordinates a few keys away in the same file.
Anything position-shaped anywhere in the tree is covered, including paths a
plugin added that this one has never heard of.

The check is per position rather than per boat. An anchor position left over
from the slip you left this morning is still redacted while you are out
sailing. A destination in `navigation.course.nextPoint` is *not* redacted
because you happen to be at home — where you are going is not where you are.

Every check walks the whole zone list. Zones start empty: nothing is hidden
until you say what to hide.

**A corrected zone applies to what is already published.** The zones are
applied as a track is recorded, which on its own protects only the future: a
zone drawn in the wrong place, or too small to reach the slip, leaves every
day recorded under it on the site, and a past day's GPX file is never
rebuilt. So whenever the zones change — and on the first cycle after an
upgrade — the plugin reads every GPX file in the repository and takes out
each point inside a zone. A day that was nothing but the dock is deleted, and
the track index is rewritten to match; the log line says how many points,
files and days it took. The rolling 24-hour position index is re-checked on
every cycle, so this morning's fixes are covered by this afternoon's zone.
Trimming changes what the site serves. The old points are still in the
repository's git history; removing them from there means rewriting that
history, which the plugin never does.

The zone center is published as the boat's position while it is inside, so
put the center somewhere that is not your slip — the middle of the fairway,
or the harbor entrance — and make the radius reach past the slip with room to
spare. GPS wanders a few meters at the dock; a zone whose edge is 20 m from
the slip will let a night's worth of wander through.

The map draws the zones it is redacting against, as red dashed rings, on the
main map and on each voyage's map. It used to draw one fixed ring at the
Python daemon's old dock in San Francisco, on every site, while the
configured zones were never drawn at all — a redaction claim that was wrong
in both directions.

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

**A path with no zones renders with no color.** That is deliberate, and it is
the same rule the rest of the site follows: an unknown position renders as
unknown rather than as San Francisco Bay. If a value should be flagged, the
place to say so is the server, where the alarm that sounds the buzzer is
configured — not a second set of numbers here that can disagree with it
silently.

### Notifications

Not every notification belongs on a public page. `notifications.exclude` is a
list of paths — without the `notifications.` prefix — that are never
published: `*` matches one segment, and naming a parent drops its whole
subtree, so `server` silences every server notification at once.

`server.history.defaultProvider` is excluded by default. It is the server
telling its own admin UI that no default history provider is configured:
true, useful on the Pi, and meaningless in a banner above a map, where it
would sit indefinitely saying nothing about the boat.

Adding a path takes it off the site on the next cycle, including the firing
counts it had already collected. An empty list publishes everything.

**Firings are counted from deltas, not from snapshots.** The plugin
subscribes to the notification stream, so one that comes on and clears
between two publishes is still counted — a bilge pump that runs for three
seconds every ten minutes used to be invisible, because the tree was only
read once a cycle and at the dock that is once an hour. The panel says which
way its numbers were collected: a real count while the plugin has been
running, or a floor on a server that offers no delta stream.


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
> off switch: `notifications.publish`.

## Branding

The site carries the boat's name and logo in places the page cannot fill in
after it loads. `document.title` and the name in the status hero are patched
from the published snapshot at runtime, but a link pasted into a group chat is
unfurled by
a crawler that never runs the JavaScript, and the browser tab has its icon
before the first fetch. So the plugin substitutes them on the way into the
repository: the OpenGraph and Twitter tags, the web app manifest's name, scope
and icon, and the `<link rel="icon">` on both pages.

Everything it needs comes off the config page or the Signal K tree. The name is
`vessels.self`. The address is derived from the repository (`<owner>.github.io`,
or `<owner>.github.io/<name>/` for a project site) unless `overrides.overrideSiteUrl` is
ticked for a custom domain.

The logo and the icon are two separate file pickers, `site.logo` and
`site.icon`. Choose a PNG, JPEG, WebP or SVG in each and the plugin publishes
them to `data/vessel/logo.<ext>` and `data/vessel/icon.<ext>`, uploaded
independently and only when their own bytes change. The logo is shown beside
the name in the status hero and the footer; the icon is what the browser tab,
the phone home screen and a shared link's preview use. They used to be the
same upload, which meant a detailed logo that read fine at 200px came out as a
muddy favicon, and a boat that wanted a clean square icon had to make its
status-hero image match it.

Neither field has a size limit of the plugin's own. Each image is
fingerprinted, so a large file costs one upload rather than one per cycle.
The ceiling that does exist is the Signal K server's: it accepts a config save
up to `FILEUPLOADSIZELIMIT`, 10 MB by default, and base64 adds about a third
on the way in.

With no logo set, the pages ask for `data/vessel/logo.png` — where the first
adopters of this tracker committed theirs by hand — and hide the image if it is
not there. With no icon set, the tab, home-screen and link-preview icon fall
back to a generic `assets/icon.svg` that ships with the plugin — there is no
hand-committed fallback path for the icon, since it is a new field with no
history to keep working.

None of this used to be configurable. The pages named one boat in their
preview tags and their manifest, and the six favicon and home-screen icons in
`assets/` were that boat's logo, published into every adopter's repository
under paths the plugin owns and overwrites on upgrade. Editing them by hand
lasted until the next release.

`assets/custom.css` is still yours, loaded last by both pages and never written
by the plugin, for anything the config page does not reach.
## What comes from Signal K

The boat's own details are not typed on the config page and not published a
second time: `data/telemetry/signalk_latest.json` is the whole self tree, so
the name, MMSI, callsign, registrations and dimensions are already there and
the site reads them from there.

`data/vessel/site.json` carries only what the snapshot cannot supply — the
privacy zones, the custom links, the tide station override, the timezone, the
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

Neither number is on the config page, and neither has an override: a boat
whose registrations match nothing simply publishes neither key, rather than
carrying a typed box that would have to be kept in step with Signal K by
hand. The polar table comes from the server the same way — see below.

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

### Tide station override

The tide and 48-hour conditions panels use the NOAA station nearest the
boat's position. Tick **Override tide station** and type a station ID, e.g.
`9414290`, and the tide curves use that station instead, fix or no fix — the
nearest station by straight-line distance is sometimes across a headland from
the water the boat is in. Wind, swell and temperature still come from the
boat's own position when there is one. With neither a fix nor an override the
panels say so and wait. The checkbox's note names the station the site would
pick right now, and how far away it is.

NOAA's timestamps are UTC with a space and no zone (`2026-09-22 20:00`). The
tide chart used to hand that string straight to `new Date()`, which Safari
reads as Invalid Date — every point dropped, a heading over an empty chart on
an iPhone — and Chrome reads as local time, shifting the curve by the UTC
offset. Both panels now parse it as UTC explicitly.

A station ID rather than a position on purpose: this setting replaced a
"default position" lat/lon, captured from `navigation.position` by a checkbox
that read the self tree directly, ahead of the privacy-zone redaction that
guards every other position on its way to the repository — a boat whose
default position happened to sit inside its own privacy zone published its
exact home coordinates unredacted. A NOAA station ID names a public reference
point, not anywhere the boat has been, so there is nothing here for a privacy
zone to need to redact.

Nothing stands in for it beyond that. The frontend used to carry a hardcoded
San Francisco Bay, so a boat in the Chesapeake with a cold GPS was shown
Golden Gate tides under a heading that read like its own — a wrong number
presented as a right one. The same went for a fallback privacy zone at one
particular dock, and for a whole fallback vessel identity (name, MMSI,
documentation number) used when the site configuration failed to load, which
made every such site introduce itself as somebody else's boat. So was a
fabricated telemetry snapshot shown when `signalk_latest.json` would not
load, which told anyone following the boat it was sailing in ten knots off
Ocean Beach when in fact publishing had broken. All of them are gone: unknown
renders as unknown.

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

The config page names the active polar beside the **Override polar**
checkbox. Tick it and a box appears, holding that polar's CSV as a starting
point, and what you leave in it is published instead — for a boat whose polar
is on a sailmaker's PDF and which is not about to install a second plugin to
type it in. Paste it in any shape it arrives — semicolons, commas, tabs or
spaces, `#` comments, a European decimal comma — and the plugin re-renders it
into the form the chart parses. An override that will not parse falls back to the
server rather than blanking the chart. The checkbox says which of the two is
in use every time you open the page:

> Publishing `"mermug-orc"` from Polar Management, 18 angle(s) x 7 wind
> speed(s). Publish a table typed here instead of the active polar.

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
| `data/vessel/logo.*` | Plugin, but only while a logo is set on the config page |
| `docs/*.md` | **You** — the console can create `docs/AGENTS.md`, `docs/ships-docs.md` and `docs/maintenance/log.md` if they do not exist, and never rewrites one |
| `assets/custom.css` | **You** — loaded last by both pages, never written here |
| Everything else | **You** |

Each publish builds a tree against the live `HEAD` with only those paths
layered on top, so a docs edit from your phone and a telemetry commit from the
boat interleave cleanly in either order. The only race is the ref update
landing behind someone else's push: re-read, rebuild, retry once. The ref is
never force-updated, so a concurrent edit is never lost.

## The console

Signal K serves a page for the plugin at **`http://<your-pi>:3000/signalk-github-pages/`**,
linked from the server's Webapps list. It does four things the config page
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
| *Remove* on a voyage's row | That one day, which then stays removed |

All three name the days before they do anything: the page asks the plugin what
would go, shows you the count and the range in a confirmation panel, and
removes nothing until you press *Yes, remove them*. The confirmation is part
of the page rather than a browser dialog, because Signal K serves webapps
inside a sandboxed iframe where `window.confirm` is ignored. What is removed is the per-day GPX file and its row in
`tracks_index.json`, in one commit — the data is still in the repository's git
history; what goes is the copy the site serves. Today is never removed: the
position index still holds its points and the next cycle would write the file
straight back. A day removed from its own row is remembered and never
rebuilt, even while the 24-hour position index still holds some of it; a day
removed in bulk can come back if its points are still in that window.

Nothing prunes on a schedule. There is no retention setting for tracks, on
purpose — a passage nobody meant to lose should not disappear because a number
in a form was too small.

**Writing to the ship's docs** is the fourth job, and the only place this
plugin writes a file it does not own. Two buttons, both conservative:

*Initialize ship's docs* commits a starter set — `docs/ships-docs.md`, a
start-here page, and `docs/AGENTS.md`, conventions for a coding agent working
in the repository. It skips any starter file already present and refuses
outright once `docs/` holds a document of your own, so pressing it twice is
safe: the second press writes nothing. The starter files and the maintenance
log do not count as documents of yours — logging an oil change before you press
the button does not lock the starter set out.

*Maintenance entry* is a form — date, system, who, and free Markdown
notes — that inserts one dated section at the top of
`docs/maintenance/log.md`, creating the file on the first entry. It is an
insert, not a rewrite: what is already in the file is carried across byte for
byte, and the published copy is read back on every entry, so a note added from
a phone between entries survives. The date defaults to the boat's local day.

## Ship's docs

Markdown in `docs/` is published as-is and rendered client-side. Adding a
document is committing a `.md` file: no build step, no checkout, which is the
point — it has to work from the GitHub web UI on a phone, one-handed, at
anchor.

A repository with no documents shows a placeholder on the Docs page saying how
to start them, rather than an empty sidebar. The console's *Initialize ship's
docs* button is the short way: it writes `docs/ships-docs.md` and
`docs/AGENTS.md`, and it refuses to run once you have a document of your own,
so it cannot overwrite docs you already have.

`docs/AGENTS.md` is the file worth knowing about if you edit the docs with a
coding agent. It states the conventions, the category order, the house rules
for a procedure somebody reads one-handed in the dark, and the paths the plugin
overwrites on every publish — which is what keeps an agent out of
`data/telemetry/` and `assets/`. Point an agent at the repository and tell it
to read that file first. It is yours once written: the plugin never rewrites
it, and an upgrade does not bring a new copy.

`AGENTS.md` and `CLAUDE.md` are instructions rather than ship's documents, so
they are left out of `docs/index.json` and never appear in the sidebar.

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

Publish state deliberately stays out of the Signal K data tree: cost, commit
SHAs and rate limits are log output and the plugin status line, not paths in
the model.

One thing is not. If publishing fails continuously for
`notifications.warnAfterMinutes` — half an hour by default, which at the underway
cadence is fifteen consecutive attempts — the plugin raises
`notifications.tracker.publishFailed` and clears it on the next success. An
expired token otherwise reaches nobody: the admin UI is a browser tab nobody
has open at sea, and the first anyone ashore knows is that the boat appears
to have stopped. The notification is `visual` only, so it shows up in KIP and
on the chartplotter without sounding the boat's alarm at three in the
morning.

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
   20 or newer (`node -v`), which is what `package.json` asks for.

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
  tideStations.ts   The station the site would pick, for the config page's note
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

**One commit per cycle.** The repository grows at the rate you publish.
Exclude the instrument paths you do not look at.

**Nothing is served from the boat.** That is KIP's job. This site is for
people ashore, and it stays up when the boat's link does not.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
