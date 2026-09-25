# Configuration

Everything is on **Server → Plugin Config → GitHub Pages Vessel Tracker**.
Only the owner and the token are required; the rest has a working default or
is read from the server.

## Fields

| Field | Default | Notes |
|---|---|---|
| `github.owner` | **required** | The user or organization, e.g. `yourname` |
| `github.token` | **required** | Fine-grained PAT, Contents: read/write, this repo only |
| `interval.underwayMinutes` | `2` | When `navigation.state` is sailing or motoring |
| `interval.stationaryMinutes` | `60` | Moored, anchored, or state unknown |
| `privacyZones[]` | *empty* | `{name, lat, lon, radius_m}` — see [Privacy zones](privacy.md) |
| `paths.hide` | `notifications.server.history.defaultProvider` | Paths never published: no card, no sparkline, and for `notifications.` lines no notification — [details](instruments.md#instrument-paths) |
| `paths.notGraphed` | design, course, GNSS housekeeping… | Paths shown as current values but never logged, one per line — [details](instruments.md#instrument-paths) |
| `instrumentLog.hours` | `1` | How far back the sparklines plot; 0 publishes no log — [details](instruments.md#history-provider) |
| `instrumentLog.providerId` | *server default* | A dropdown of the history providers registered on the server |
| `staleMaxAgeMinutes` | `60` | Older values are dropped from the snapshot |
| `track.detailMeters` | `15` | Keep a fix when dropping it would move the drawn track by more than this — [details](instruments.md#the-track) |
| `notifications.publish` | on | Publish active notifications and the 24-hour firing log — [details](site.md#zones-and-notifications) |
| `notifications.warnAfterMinutes` | `30` | Raise a Signal K notification after this long without a successful publish; 0 turns it off |
| `site.logo` | *empty* | The vessel's logo, uploaded here — see [Branding](site.md#branding) |
| `site.icon` | *empty* | The tab, home-screen and link-preview icon, uploaded separately from the logo — see [Branding](site.md#branding) |
| `site.customLinks[]` | *empty* | `{label, url}` buttons added to the site's link row |

## Overrides

Five settings are worked out by the plugin rather than typed, and all five live
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
| `overrides.overrideTideStation` | the NOAA station nearest the boat | `overrides.tideStation` — see [Tide station override](site.md#tide-station-override) |

The defaults are the numbers this tracker has run on for years on a
Raspberry Pi. What has no default at all is what belongs to one particular
boat: privacy zones start empty, and [the vessel's own
details](site.md#what-comes-from-signal-k) come from Signal K rather than from this
page.

> [!WARNING]
> Signal K stores plugin configuration as plain JSON under
> `~/.signalk/plugin-config-data/`. Your token is readable by anyone with a
> shell on the server. Scope it to the one repository, and rotate it if the Pi
> ever leaves your hands.
