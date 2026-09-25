# The repository and the console

What the plugin writes, what stays yours, and the on-boat console that previews, publishes and prunes.

## What the plugin writes

The repository is shared with you. The plugin writes `.tracker-manifest.json`
listing every path it manages, and refuses to put anything outside that list
into a commit.

| Path | Owner |
|---|---|
| `data/telemetry/**` | Plugin, every cycle |
| `data/vessel/site.json` | Plugin, when the configuration or the passage changes |
| `index.html`, `sw.js`, `manifest.json`, `.nojekyll`, `assets/**`, `data/tide_stations.json` | Plugin, on install and after an upgrade |
| `data/vessel/polars.csv` | Plugin, but only while it has a polar to publish |
| `data/vessel/logo.*` | Plugin, but only while a logo is set on the config page |
| `data/vessel/icon.*` | Plugin, but only while an icon is set on the config page |
| `assets/custom.css` | **You** — loaded last by the page, never written here |
| Everything else | **You** |

Paths the plugin used to write and no longer does (`data/vessel/info.yaml`,
and the ship's docs reader: `docs.html`, `assets/docs.js`, `docs/index.json`)
are deleted once, in an ordinary commit, and never claimed again. Nothing else
under `docs/` is touched.

Each publish builds a tree against the live `HEAD` with only those paths
layered on top, so an edit from your phone and a telemetry commit from the
boat interleave cleanly in either order. The only race is the ref update
landing behind someone else's push: re-read, rebuild, retry once. The ref is
never force-updated, so a concurrent edit is never lost.

## The console

Signal K serves a page for the plugin at **`http://<your-pi>:3000/signalk-github-pages/`**,
linked from the server's Webapps list. It does three things the config page
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
