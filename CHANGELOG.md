# Changelog

## 1.2.0 - 2026-11-18

- Sign in with GitHub from the plugin's console instead of making and pasting a personal access token. Install the GitHub App on the site's repository, press **Sign in with GitHub**, and enter the code it shows at github.com/login/device on any device. The token reaches only the repositories the App is installed on, with Contents read and write, and is kept in the plugin's data directory rather than the plugin config. The plugin restarts on it by itself. A personal access token still works, and a token set in the environment or a token file still wins over the sign-in.
- The repository owner can be left empty once signed in; it is then the signed-in account.
- Releases are published to npm from a version tag by GitHub Actions, with a provenance attestation.

## 1.1.0 - 2026-10-27

- The vessel logo and icon are uploaded from the plugin's console instead of the config page, and kept as files in the plugin's data directory. As data URLs in the plugin config they were sent with every plugin's settings, so a large logo slowed down the config page for every plugin on the server. On the first start after upgrading, a saved logo and icon are moved out of the config automatically.

## 1.0.3 - 2026-10-03

- Published pages carry `<meta name="generator" content="signalk-github-pages">`, so sites can be found with GitHub code search. Each boat picks it up on the first cycle after upgrading.
- App store screenshots replaced with current captures of the map, voyages, environment, data and polars pages.
- Development dependency `vitest` moved from 2.x to 3.2, which clears the high and critical `npm audit` findings in the test toolchain. Nothing the plugin ships at runtime changed.

## 1.0.2 - 2026-10-01

Published from the repository as of 2026-09-30: the Signal K app store icon and screenshots, and the README rendered as plain Markdown for the store. Version 1.0.1 was never published.

## 1.0.0 - 2026-09-23

First release.
