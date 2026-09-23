# The repository and the console

What the plugin writes, what stays yours, and the on-boat console that publishes, prunes and edits the ship's docs.

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
| `data/vessel/icon.*` | Plugin, but only while an icon is set on the config page |
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
