# Track and instruments

How the track is recorded, where the sparklines come from, which paths get published, and what it all costs on a cellular link.

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
grows 6-fold rather than 24-fold.

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
history off a hotspot budget. Each path costs roughly 35 bytes a bucket, so
24 hours of 30 paths is about 380 kB a cycle, where 1440 one-minute buckets
would be 1.5 MB.
What it costs instead is detail inside the shorter views — at a 24-hour window
the 1-hour view is fifteen points. An hour is the default because it is what
every install can carry; six hours is the longest window that keeps full
60 s resolution.

## Instrument paths

The dashboard is built from the tree, not from a list of one boat's paths.
Every battery bank, solar array, charger, inverter and alternator under
`electrical`, every tank under `tanks`, every engine under `propulsion`, and
every reading under `environment.inside` and `environment.outside` gets a
card, named from the instance's `name` or `meta.displayName` when it has one
and from its path when it does not (`electrical.batteries.1.voltage` reads
"Battery 1 voltage"). The Internet and System Health panels appear only when
something writes `internet.*` or `environment.rpi.*`. A panel the boat has
nothing for is not shown.

The config page's **Paths** section is how to take things off it. Both
boxes take one path per line; `*` matches one segment, a parent covers its
whole subtree, lines starting with `#` are comments, and empty is a real
answer.

**Never published** (`paths.hide`) removes the path from the published
snapshot, so there is no card, and from the instrument log, so there is no
sparkline. Notifications go in the same box as full paths:
`notifications.server` drops every server notification, and `notifications`
alone drops them all. Hiding `navigation.position` stops the track too.

Every path gets a sparkline unless you exclude it. A path is logged when the
history provider has stored it **and** the boat is reporting a number for it
right now. The first condition is what makes a sparkline possible. The second
keeps out everything the database remembers but the boat no longer has: the
sensor you unplugged in March, the bank you renamed.

**Published, never graphed** (`paths.notGraphed`) is the list to leave out of
the log while still showing the current value. Empty logs everything the
boat reports. The default leaves out what is not worth a graph:

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
add paths to *Published, never graphed* — `environment.rpi`, per-cell battery voltages,
whatever you never look at — or shorten the window.

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
