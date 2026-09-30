# Configuration

Everything is on **Server → Plugin Config → GitHub Pages Vessel Tracker**.
Only the owner and a token are required; the rest has a working default or
is read from the server.

## Fields

| Field | Default | Notes |
|---|---|---|
| `github.owner` | **required** | The user or organization, e.g. `yourname` |
| `github.token` | **required**, here or [from a file](#token-from-a-file) | Fine-grained PAT, Contents: read/write, a repository that holds only the tracker, 90-day expiry |
| `interval.underwayMinutes` | `2` | When `navigation.state` is sailing or motoring |
| `interval.stationaryMinutes` | `60` | Moored, anchored, or state unknown |
| `privacyZones[]` | *empty* | `{name, lat, lon, radius_m}` — see [Privacy zones](privacy.md) |
| `paths.hide` | `notifications.server.history.defaultProvider` | Paths never published: no card, no sparkline, and for `notifications.` lines no notification — [details](instruments.md#instrument-paths) |
| `instrumentLog.hours` | `1` | How far back the sparklines plot; 0 publishes no log — [details](instruments.md#history-provider) |
| `notifications.publish` | on | Publish active notifications and the 24-hour firing log — [details](site.md#zones-and-notifications) |
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

## Token from a file

> [!WARNING]
> A token typed into the config page is stored as plain JSON under
> `~/.signalk/plugin-config-data/`, and Signal K's admin API returns plugin
> configuration to any admin session. It is readable by anyone with a shell on
> the server, anyone logged in as a Signal K admin, and anything that backs up
> that directory.

To keep it off the page, put it in a file only the Signal K user can read and
tell the plugin where the file is:

```bash
install -m 600 /dev/null ~/.signalk/github-pages-token
nano ~/.signalk/github-pages-token          # paste the token, save
sudo systemctl edit signalk                 # or however you run the server
```

```ini
[Service]
Environment=SIGNALK_GITHUB_PAGES_TOKEN_FILE=/home/pi/.signalk/github-pages-token
```

Restart the server, then clear the token field on the config page. The plugin
looks in this order and takes the first it finds:

1. `SIGNALK_GITHUB_PAGES_TOKEN_FILE`, the path of a file holding the token.
2. `SIGNALK_GITHUB_PAGES_TOKEN`, the token itself. Simpler, but the value shows
   in `systemctl show` and the process environment, so prefer the file.
3. The config page.

A file that is named but missing or empty stops the plugin with an error; it
does not fall back to a token saved on the page, because that one may be the
credential you meant to replace. A file readable by other users, or a token
still saved on the page beside a file, is a warning in the log.

This is not encryption. The token is still plain text on the Pi's disk. What the
file buys is that it stays out of the admin API and out of backups of
`plugin-config-data`.

Whichever way it is stored:

- **Scope it to one repository**, and make that repository one that holds only
  the tracker. The token can rewrite every file in it, and the site is served
  from your `github.io` origin.
- **Set a 90-day expiry** and put the rotation date in a calendar. Publishing
  stops with a 401 the day it lapses; after half an hour of failures the plugin
  raises `notifications.tracker.publishFailed`, but a reminder beats finding out
  from a stale map.
- **Rotate it** if the Pi ever leaves your hands.
