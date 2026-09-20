# AGENTS.md — the ship's docs in this repository

This repository is a GitHub Pages site published by the Signal K plugin
[`signalk-github-pages`](https://github.com/zackphillips/signalk-github-pages)
running on **{{VESSEL_NAME}}**. Most of it is machine-written. This directory,
`docs/`, is not: it is the ship's documentation, and it is yours to edit.

Read this file before changing anything under `docs/`.

## What you may edit

| Path | Who owns it |
|---|---|
| `docs/**.md` | **You** — procedures, systems notes, the maintenance log |
| `data/vessel/logo.png` | **You** |
| `assets/custom.css` | **You** — loaded last by both pages, never overwritten |
| `docs/index.json` | The plugin (rebuilt from `docs/**.md`; do not hand-edit) |
| `data/telemetry/**` | The plugin, every publish cycle |
| `data/vessel/site.json` | The plugin, whenever the plugin config changes |
| `index.html`, `docs.html`, `sw.js`, `manifest.json`, `assets/**`, `.nojekyll` | The plugin, on install and upgrade |

`.tracker-manifest.json` at the repository root is the authoritative list.
Anything the plugin owns is overwritten without warning on the next publish,
so a change there lasts about two minutes. If something in the site itself
needs fixing, the fix belongs in the plugin, not here.

> **Never delete `.nojekyll`.** Without it, Pages runs the tree through Jekyll,
> which turns `docs/foo.md` into `docs/foo.html` and stops serving the raw
> Markdown the reader fetches. Every document 404s while the repository looks
> perfectly fine.

## How a document becomes a page

There is no build step and no checkout. `docs.html` fetches `docs/index.json`,
then fetches each `.md` file and renders it client-side. Adding a document is
committing a `.md` file — from a laptop, from an agent, or from the GitHub web
UI on a phone at anchor. The plugin rebuilds `docs/index.json` on its next
cycle, within a couple of minutes of the commit.

Front matter is optional. Without it, the title comes from the H1, the
category from the subdirectory, and the card description from the first
paragraph:

```markdown
---
title: Man Overboard
category: Operations
order: 10
---

# Man Overboard

Stop the boat. Throw flotation. Assign a spotter.
```

- **`category`** groups the sidebar. `Operations`, `Systems`, `Maintenance`
  and `Voyages` sort first, in that order; anything else sorts alphabetically
  after them.
- **`order`** sorts within a category, low first. The default is 100.
- A file whose name starts with `_` is a draft and stays out of the index.
- `AGENTS.md` and `CLAUDE.md` are instructions, not ship's documents, and are
  never indexed.

## House rules

- **One subject per file, named for the subject**: `docs/raw-water-system.md`,
  not `docs/notes-2.md`. The filename is the URL and the fallback title.
- **Write for the person holding the phone**, in the dark, wet, one-handed,
  with no signal. Steps in order, numbered. The consequence first when there
  is one: "Stop the engine" before the paragraph explaining why.
- **Checklists render as checkboxes.** A `- [ ]` item becomes a tickable box;
  ticks are stored per device in `localStorage` and are never committed.
- **Cross-reference with a plain relative link**: `[Man Overboard](mob.md)`
  becomes an in-reader link. That rewrite only handles files at the top level
  of `docs/`; for one in a subdirectory link to `?doc=maintenance/log`.
- **Images live at the repository root path they are written with.** The
  reader renders into `docs.html`, so relative paths resolve against the site
  root, not against `docs/`: write `![Panel](docs/images/panel.jpg)`.
- **Never put a credential in this repository.** The GitHub token lives on the
  boat, in the Signal K plugin config. Anything committed here is public.
- **Do not invent equipment.** If the model number, the torque spec or the
  capacity is not in the source you were given, say what is unknown. A
  confident wrong number in a procedure is worse than a gap.

## The maintenance log

`docs/maintenance/log.md` is one file, newest entry first, each entry a level-2
heading:

```markdown
## 2026-09-20: Replaced the raw-water impeller

- System: Engine
- Engine hours: 1204.5
- Logged by: Zack

Old impeller had two vanes torn. Spare Jabsco 17370-0001 used; one left aboard.
```

Entries are also added from the boat: the plugin's console webapp has a form
that inserts one at the top of this file and commits it. Keep the shape above
so both routes produce the same document — insert new entries at the top,
never rewrite or reorder the ones already there.

## Working on this repository

- There is nothing to install, build or test. Do not add a package manifest,
  a linter or a CI workflow to make this directory feel like a project.
- Commit messages are plain: `Add winterizing procedure`, `Log impeller
  change`.
- Keep commits small. A phone on a marina hotspot is the normal way this
  repository is read, and a pull request of forty files is unreviewable from
  one.
