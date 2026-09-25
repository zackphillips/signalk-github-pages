# Upgrading

Nothing resets on upgrade. A config written against an older release is read
as it was written, and the config page opens showing its own values, ticked
boxes included, rather than the new defaults. This page lists the settings
that moved or went away.

## Settings that left the config page but are still read

- An instrument log length and a bucket width. There is now one window,
  `instrumentLog.hours`, and the bucket width follows from it.
- A history query timeout.
- A switch for `docs/index.json`.
- The overrides that used to sit in the section of the setting they
  overrode. They now live together in the **Overrides** section.
- `instrumentLog.exclude`, now `paths.notGraphed`.
- `notifications.exclude`, now lines in `paths.hide`, prefixed with
  `notifications.`.

## Settings no longer read

- `track.positionRetentionHours`. The map's track is always the last 24
  hours, and past days survive as GPX regardless.
- `instrumentLog.paths`, the old allowlist. Carried over as an exclusion list
  it would have excluded exactly the paths it named, so it is dropped instead.
  Every path the boat reports is now logged unless excluded.

## The polar override is gone

`overrides.overridePolar` and `overrides.polar`, and the older
`polars.override` and `polars.table`, are no longer read. The polar comes only
from [Polar Management](https://www.npmjs.com/package/signalk-polar-management).
A boat that had the override ticked publishes the active polar from there
instead. With no active polar, the plugin stops writing `polars.csv` and leaves
the last published copy in place, so the chart keeps the table you typed until
you set a polar in Polar Management.

## The ship's docs are gone

The plugin no longer renders `docs/*.md`. It used to publish a reader
(`docs.html`), rebuild `docs/index.json` every time the docs changed, and offer
two console buttons: *Initialize ship's docs* and *Maintenance entry*. All of
that is removed. Keep your docs in a repository of their own, or anywhere
else, and link to them with a `site.customLinks` button.

On the first cycle after the upgrade the plugin deletes `docs.html`,
`assets/docs.js` and `docs/index.json` from the site repository, once. Your
Markdown under `docs/` stays exactly where it is; nothing renders it any more.
The removed code is on the `archive/ships-docs` branch of this repository.

## Files the plugin used to write

`data/vessel/info.yaml` carried the site configuration and the `passage:`
block. It is deleted once on upgrade; its contents now come from the config
page and the Course API.

## Devices stuck on an old site

A device that loaded a site published by a release before 0.2.0 can stay on
that release's service worker. See
[Troubleshooting](troubleshooting.md#the-site-says-data-unavailable).
