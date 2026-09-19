# Migrating an existing tracker to the plugin

This is the cutover for a repository that currently runs the Python daemon
(`scripts/update_signalk_data.py`) on a Pi and carries the frontend in its own
tree — the layout `zackphillips/zackphillips.github.io` uses today. Nothing
here has been applied to that repository yet; it is the checklist for doing it.

The plugin publishes the same file formats, so the site keeps working through
the cutover. What changes is who writes them.

## 1. Measure the instrument log first

The daemon logs every numeric leaf in the self tree. Over `git push` that is a
delta; through the Git Data API it is a full upload every cycle. Before
switching transports, check what the file actually costs:

```bash
ls -l data/telemetry/instrument_log.json
```

If it is anywhere near a megabyte, the allowlist is doing real work. The
plugin's default `instrumentLog.paths` covers the sparklines and lands around
a tenth of that. Compare the first few files the plugin publishes against the
old ones and confirm the drop before turning the daemon off.

## 2. Run both publishers side by side

Point the plugin at a scratch repository first — an empty repo with Pages
enabled is enough — and let it run for a full sailing day alongside the
daemon. Then diff the two outputs:

```bash
diff <(jq -S . old/data/telemetry/positions_index.json) \
     <(jq -S . new/data/telemetry/positions_index.json)
diff old/data/telemetry/tracks/2026-03-01.gpx new/data/telemetry/tracks/2026-03-01.gpx
```

Expect the differences to be: a `schema_version` field on each JSON file, a
smaller `values` object in the instrument log, and GPX whitespace. Anything
else is worth understanding before the cutover.

Watch for the two things the daemon got wrong at different points and the
plugin's tests now pin: every privacy zone is checked, not just the first, and
days are grouped by the vessel's local calendar day rather than by the UTC
date in the timestamp.

## 3. Configure the plugin against the real repository

Copy the values out of `data/vessel/info.yaml` into the plugin config page:

| `info.yaml` | Plugin config |
|---|---|
| `privacy_zones` | `privacyZones[]` |
| `timezone` | `timezone` — pick the same zone from the dropdown |
| `theme` | `site.theme` |
| `marinetraffic_ship_id` | `site.marinetrafficShipId` |
| `postgsail_logs_url` | `site.postgsailLogsUrl` |
| `uscg_number`, `hull_number` | nothing, if the server carries them as registrations; `site.uscgNumber` / `site.hullNumber` if it does not |
| `name`, `mmsi`, `callsign` | nothing — read from the server |
| `passage` | nothing — stays in the file, preserved on rewrite |
| `signalk.host`, `signalk.port` | nothing — read from the server |

The repository field is two boxes, `github.owner` and `github.name`. A config
written against the old single `owner/name` field keeps working until the next
save, and the two boxes are filled from it — but fill them in yourself while
you are on the page.

`data/vessel/polars.csv` can move onto the config page too: paste the table
into the `polars` field and the plugin publishes it. Leave the field empty to
go on managing the file by hand, which is what happens if you do nothing.

The daemon's constants are the plugin's defaults, so there is nothing to copy
unless you want to change them:

| `update_signalk_data.py` | Plugin config | Both |
|---|---|---|
| `UPDATE_INTERVAL_AWAY_SECONDS` | `interval.underway` | 120 |
| `UPDATE_INTERVAL_HOME_SECONDS` | `interval.stationary` | 3600 |
| `POSITION_RETENTION_HOURS` | `positionRetentionHours` | 24 |
| `STALE_MAX_AGE_MINUTES` | `staleMaxAgeMinutes` | 60 |
| `INSTRUMENT_LOG_ENTRIES` | `instrumentLog.entries` | 120 |
| (none — logged every numeric path) | `instrumentLog.paths` | the sparkline set |

The one real difference is the path list, which is the point of step 1. Note
also that `theme: "mermug"` in `info.yaml` is not the plugin's default
(`marine`), so set it explicitly if you want the same look.

Anything the frontend reads that the config page does not cover goes in
`site.extraYaml` — `default_location`, for instance. The plugin rewrites
`info.yaml` from the config page on the first cycle after anything changes,
carrying `passage:` across untouched.

## 4. Cut over

1. Install the plugin on the Pi and enable it against the real repository.
   Until it is published to npm the App Store cannot see it, so install from
   git: `cd ~/.signalk && npm install github:zackphillips/signalk-github-pages`,
   then restart the server.
2. Stop and disable the daemon:
   ```bash
   sudo systemctl disable --now vesselwebsite.service
   ```
3. Remove the unit from `signalk-services-to-signalk` — plugin health now
   shows up as the plugin's own status in the admin UI.
4. Confirm a publish lands: the plugin status line shows the time of the last
   commit, and the repository gets one commit per cycle.

## 5. Delete what the plugin replaces

Once a few cycles have landed cleanly, these leave the site repository —
their replacements live in the plugin:

```
scripts/            services/           Makefile
tests/              pyproject.toml      uv.lock
.pre-commit-config.yaml                 .python-version
.github/workflows/docs-index.yml
```

Keep `.github/workflows/` itself if anything else lives there. Keep
`docs/index.json` — the plugin maintains it now (or set `buildDocsIndex: false`
and keep the Action instead; do one or the other, not both).

The frontend files (`index.html`, `docs.html`, `assets/`, `sw.js`,
`manifest.json`, `.nojekyll`, `data/tide_stations.json`) stay in the
repository but stop being source: the plugin overwrites them from its own
package on install and after every upgrade. Frontend changes belong in the
plugin repository from that point on. Anything you want to keep local goes in
`assets/custom.css`, which the plugin never writes and both pages load last.

`docs/*.md` and `data/vessel/logo.png` are yours and are never written.
`data/vessel/polars.csv` is too, unless you paste a polar table into the
config page — then the plugin owns it and says so in the manifest.

## 6. Update the repository's own docs

`AGENTS.md` and `CLAUDE.md` in the site repository describe a Python backend
and a hand-edited frontend. After the cutover the accurate statement is
shorter: the repository holds docs, vessel assets and generated output, and
the code lives in the plugin.
