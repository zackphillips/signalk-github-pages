<h1 align="center">GitHub Pages Vessel Tracker</h1>

<p align="center">
  <em>Your boat publishes its own website.</em><br>
  <code>signalk-github-pages</code>: a Signal K plugin that turns live vessel data into a static GitHub Pages site —
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

**For people ashore**

| | |
|---|---|
| **Where the boat is** | Live position on a map, redacted inside your [privacy zones](#privacy) |
| **Where it has been** | A track per local calendar day, as GPX, listed on a Voyages tab. Each voyage has its own link to share |
| **Where it is going** | A passage banner from the waypoint or route active on the plotter, gone on arrival |
| **How it is doing** | Instruments colored by the zones set on the server, sparklines from your history provider, active notifications and how often each has fired |
| **Conditions** | Tides from the nearest NOAA station and a 48-hour wind, swell and temperature forecast |
| **The ship's docs** | Markdown in `docs/`, edited from the GitHub web UI on a phone |

**How it behaves**

- **Adaptive cadence.** Fast underway, slow at anchor, straight off
  `navigation.state`, with a publish the moment it changes.
- **Nothing hand-edited.** A value the boat knows is read from Signal K: name,
  registrations, units, alarm zones, the active polar, the passage. A value
  you choose is a field on the config page.
- **Shares the repository.** The plugin writes only the paths it declares in
  `.tracker-manifest.json`. Everything else in the repository is yours.
- **Measures its own cost.** Every cycle logs bytes on the wire, API calls and
  rate limit left, and warns when the instrument log gets expensive.
- **On-boat console.** A Signal K webapp that previews the site from live
  data, publishes on request and prunes old voyages.

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

**3. Install it.** In the Signal K admin UI, **Appstore → Available**, search
for *GitHub Pages*, install, and restart the server when it asks. From a
shell, the same thing is:

```bash
cd ~/.signalk
npm install signalk-github-pages
sudo systemctl restart signalk        # or however you run the server
```

To run unreleased code from `main`, install
`github:zackphillips/signalk-github-pages` instead; npm clones it and runs the
TypeScript build through the package's `prepare` script.

Then open **Server → Plugin Config → GitHub Pages Vessel Tracker**, fill in
the repository owner and the token, enable. Everything else has a working
default or is derived.

The first cycle writes the whole site — HTML, CSS, JS, icons — then telemetry
only. Give Pages a minute, then open the URL.

> [!TIP]
> Install [signalk-autostate](https://www.npmjs.com/package/@meri-imperiumi/signalk-autostate)
> if you have not. It sets `navigation.state`, which is what makes the cadence
> adaptive. Without it every cycle uses the stationary interval.


## Configuration

Two fields are required: `github.owner` and `github.token`. The ones you
are most likely to change:

| Field | Default | What it does |
|---|---|---|
| `interval.underwayMinutes` | `2` | Cadence when sailing or motoring |
| `interval.stationaryMinutes` | `60` | Cadence moored, anchored, or state unknown |
| `privacyZones[]` | *empty* | `{name, lat, lon, radius_m}`; see [Privacy](#privacy) |
| `paths.hide` | one server notice | Paths never published, notifications included |
| `paths.notGraphed` | design, course, GNSS… | Paths shown as current values but never graphed |
| `instrumentLog.hours` | `1` | How far back the sparklines reach; 0 publishes none |
| `site.logo`, `site.icon` | *empty* | The boat's logo, and the tab and home-screen icon |

The repository name, branch, site URL, timezone and tide station are
derived, and each has an override. The polar comes from
[Polar Management](https://www.npmjs.com/package/signalk-polar-management). The full field list is in
[Configuration](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/configuration.md).

> [!WARNING]
> Signal K stores plugin configuration as plain JSON under
> `~/.signalk/plugin-config-data/`. Your token is readable by anyone with a
> shell on the server. Scope it to the one repository, and rotate it if the Pi
> ever leaves your hands.

## Privacy

GitHub Pages sites are public. Anything the plugin publishes can be read by
anyone who has the URL.

- **Privacy zones.** A position inside a zone is published as the zone's
  center and left out of the track entirely. Every position in the snapshot
  is checked, `navigation.anchor.position` included. Correcting a zone
  also trims tracks that are already published.
- **Positions go through one path.** The instrument log never asks for a
  position, and the passage banner publishes names, never coordinates.
- **Zones start empty.** Nothing is hidden until you say what to hide. Put the
  center off your slip and make the radius reach past it with room to spare.
- **Notifications are free text** written by whichever plugin raised them,
  and they are published verbatim. `notifications.publish` turns them off,
  and `paths.hide` drops any path or subtree.

Details are in [Privacy](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/privacy.md).

## Documentation

| | |
|---|---|
| [Configuration](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/configuration.md) | Every field, and the five overrides |
| [Track and instruments](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/instruments.md) | Track thinning, the history provider, sparkline windows, instrument paths and bandwidth |
| [Privacy](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/privacy.md) | Privacy zones in full |
| [The site](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/site.md) | Units and alarm zones, notifications, branding, what is read from Signal K, the passage banner, tides, polars |
| [The repository and the console](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/repository.md) | What the plugin writes, the on-boat console, the ship's docs |
| [Troubleshooting](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/troubleshooting.md) | The cycle log, "Data unavailable", a plugin missing from the list |
| [Upgrading](https://github.com/zackphillips/signalk-github-pages/blob/main/docs/upgrading.md) | Settings that moved or went away |

## Trade-offs worth knowing

**The plugin runs inside the server process.** A bug here can affect the
navigation data hub. Every cycle is wrapped: an exception skips one update,
is reported in the admin UI, and never reaches the server's event loop. That
is the cost of reading the tree in-process, and it buys away an HTTP poll
that could freeze the site on stale data.

**It needs a data link.** The site updates when the boat has one. Offshore it
shows the last publish and how long ago that was.

**The token sits in plain text**, as above.

**One commit per cycle.** The repository grows at the rate you publish.
Exclude the instrument paths you do not look at.

**Nothing is served from the boat.** That is KIP's job. This site is for
people ashore, and it stays up when the boat's link does not.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm run dev       # site/ + sample/ on http://localhost:8000
```

`npm run dev` serves the real frontend against fixture telemetry, so no boat
is required. `Publisher.runCycle()` takes a self tree and returns what it
did without calling back into the server, so a full publish cycle is tested
without Signal K and without a network. The source layout and the rules that
are not obvious are in [AGENTS.md](https://github.com/zackphillips/signalk-github-pages/blob/main/AGENTS.md).

## License

BSD 3-Clause. See [LICENSE](LICENSE).
