---
title: Ship's Docs — Start Here
category: Operations
order: 0
---

# Ship's Docs — Start Here

This is the documentation section of **{{VESSEL_NAME}}**'s site. Everything in
it is Markdown in the `docs/` directory of
[`{{REPO}}`](https://github.com/{{REPO}}), fetched and rendered by your browser.
There is no build step: a document exists the moment its `.md` file is
committed, and the plugin picks it up on its next publish cycle.

This page came with the plugin. Once the docs are yours, delete it —
`docs/ships-docs.md`.

## What belongs here

The things you would otherwise look for in a binder that is ashore, or in a
manual that is wet: emergency procedures, system diagrams and valve positions,
the engine's service intervals, the parts and spares list, passage notes.

Four categories sort first in the sidebar, in this order:

| Category | What goes in it |
|---|---|
| `Operations` | Procedures: man overboard, reefing, anchoring, engine start |
| `Systems` | How the boat is built: electrical, plumbing, rig, electronics |
| `Maintenance` | Service intervals, the maintenance log, parts and spares |
| `Voyages` | Passage notes and the captain's log |

Anything else sorts alphabetically after those four.

## Adding a document from a phone

1. Open the repository on GitHub, go to `docs/`, and choose **Add file →
   Create new file**.
2. Name it for its subject: `reefing.md`, `maintenance/winterizing.md`.
3. Write it. Front matter is optional — without it the title comes from the
   `#` heading and the category from the folder.
4. Commit. The document appears here within a couple of minutes, once the
   plugin has rebuilt the index.

That is the whole workflow, and it is the reason this site has no admin panel:
a repository, a text file, and a phone that only needs enough signal to push
one commit.

## Adding a document with an agent

`docs/AGENTS.md` in this repository is written for coding agents — Claude Code,
Codex, Cursor, whatever you use. Point one at the repository and it will read
the conventions, the ownership boundary and the house rules before it writes
anything. Useful prompts look like:

> Read `docs/AGENTS.md`. Then draft `docs/systems/raw-water.md` from the photos
> in this thread: the seacock, strainer and impeller path on a Yanmar 4JH. Mark
> anything you are unsure of as unverified rather than guessing a part number.

> Read `docs/AGENTS.md`, then turn my notes below into a numbered MOB procedure
> in `docs/mob.md`. Keep it to one screen on a phone.

> Read `docs/AGENTS.md` and `docs/maintenance/log.md`. Summarize every engine
> entry from the past two seasons into a service-interval table in
> `docs/maintenance/engine-intervals.md`. Link back to the log entries.

Two rules worth repeating to any agent that has not read `AGENTS.md` yet:
everything under `data/`, `assets/` and the two HTML files belongs to the
plugin and is overwritten on the next publish, and nothing that looks like a
credential belongs in a public repository.

## The maintenance log

`docs/maintenance/log.md` is a single file, newest entry first. Add to it from
the boat without a browser tab: the plugin's console —
**{{CONSOLE_URL}}** on the boat's network — has a form
that writes an entry and commits it, prefilled with today's date and the engine
hours Signal K is reporting.

## What the plugin writes, and what is yours

`.tracker-manifest.json` at the repository root lists every path the plugin
manages; it overwrites those and nothing else. Your documents, your logo at
`data/vessel/logo.png` and your stylesheet overrides at `assets/custom.css` are
never touched.

One file is load-bearing and easy to delete by accident: `.nojekyll`. Without
it, GitHub Pages runs the repository through Jekyll, which stops serving the
raw Markdown this page is made of. Every document 404s while the repository
looks completely normal.
