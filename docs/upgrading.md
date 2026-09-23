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

## Files the plugin used to write

`data/vessel/info.yaml`, which carried the site configuration and the
`passage:` block, is deleted once on upgrade. Its contents now come from the
config page and the Course API.

## Devices stuck on an old site

A device that loaded a site published by a release before 0.2.0 can stay on
that release's service worker. See
[Troubleshooting](troubleshooting.md#the-site-says-data-unavailable).
