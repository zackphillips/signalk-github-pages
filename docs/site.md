# The site

Where each part of the published site gets its data: the server's metadata, the self tree, the Course API, Polar Management and the config page.

## Units, names and thresholds come from the server

Signal K carries `meta` on every path — `units`, `displayName`, `description`
and the `zones` that say what counts as normal, warn and alarm — and the site
reads all of it off the published snapshot rather than hardcoding a second
copy.

That is what lets a path this release has never heard of be rendered
properly: `propulsion.port.coolantTemperature` shows as "Port Coolant" in
your preferred temperature unit, colored by the zones you set on the
server's Data Fiddler page, with the server's description as its tooltip.
The tooltip also names the value's source (`$source`, plus the PGN or 0183
sentence when there is one) and any other source reporting the same path,
which is how two GPSs fighting over a position show up. Set
the zone in Signal K and the site follows; there is nowhere here to set a
threshold, on purpose, because the server is where the alarm that sounds the
buzzer is already configured.

## Zones and notifications

The dashboard has no thresholds of its own. Whether 46% state of charge is
fine or alarming is a property of a battery bank, not of a web page: 46% is
comfortable on 600Ah of LiFePO4 and nearly flat on a tired 200Ah of AGM.

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

Not every notification belongs on a public page. They are hidden in the
same **Never published** box as everything else, as full paths: `*` matches
one segment, and naming a parent drops its whole subtree, so
`notifications.server` silences every server notification at once.

`notifications.server.history.defaultProvider` is hidden by default. It is the server
telling its own admin UI that no default history provider is configured:
true, useful on the Pi, and meaningless in a banner above a map, where it
would sit indefinitely saying nothing about the boat.

Adding a path takes it off the site on the next cycle, including the firing
counts it had already collected. An empty list publishes everything.

**Firings are counted from deltas, not from snapshots.** The plugin
subscribes to the notification stream, so one that comes on and clears
between two publishes is still counted: a bilge pump that runs for three
seconds every ten minutes shows up even at the dock, where a cycle is an hour
apart. The panel says which way its numbers were collected: a real count
while the plugin has been running, or a floor on a server that offers no
delta stream.

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

On a server with no delta stream the plugin falls back to comparing one
publish with the next, and anything that fires **and clears** between two
publishes is never seen. At the dock that gap is the stationary interval, an
hour by default, so those counts are a floor, not a total. The panel also
marks any window longer than the log has been running, so a plugin
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
the phone home screen and a shared link's preview use. They are separate
because a detailed logo that reads fine at 200px comes out as a muddy
favicon.

Neither field has a size limit of the plugin's own. Each image is
fingerprinted, so a large file costs one upload rather than one per cycle.
The ceiling that does exist is the Signal K server's: it accepts a config save
up to `FILEUPLOADSIZELIMIT`, 10 MB by default, and base64 adds about a third
on the way in.

With no logo set, the pages ask for a hand-committed `data/vessel/logo.png`
and hide the image if it is not there. With no icon set, the tab, home-screen
and link-preview icon fall back to a generic `assets/icon.svg` that ships
with the plugin. Do not edit files under `assets/` by hand: the plugin owns
them and overwrites them on upgrade.

`assets/custom.css` is yours, loaded last by both pages and never written by
the plugin, for anything the config page does not reach.

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

A station ID rather than a position on purpose: a NOAA station ID names a
public reference point, not anywhere the boat has been, so there is nothing
here for a privacy zone to need to redact. A default position typed or
captured here would reach the repository without passing through the zones.

Nothing stands in for it beyond that. There is no built-in default location,
vessel identity or sample telemetry: a site whose data will not load says so
rather than showing someone else's boat.

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

There is no polar table to type on this plugin's config page: one copy of
the polar, in the plugin whose job it is, rather than two that drift apart. The
console names the polar being published.

No active polar means the plugin publishes none and does not claim
the path: a `polars.csv` you committed by hand stays yours, and clearing the
active polar later leaves the last published file in place rather than
deleting the boat's performance data because a dropdown was emptied.
