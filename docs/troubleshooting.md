# Troubleshooting

Reading the log, and the two failures people hit most.

## What a cycle looks like in the log

```
Instrument log: 120 entries, 14 paths this cycle, 96.4 kB.
Publishing 5 file(s), 142.8 kB: data/telemetry/instrument_log.json 96.4 kB,
  data/telemetry/positions_index.json 31.2 kB, …
Published a1b2c3d: 5 file(s), 142.8 kB of content in 191.2 kB of request
  bodies, 5 API call(s), 1840 ms. Rate limit: 4993 left until 2026-03-01T21:00Z
```

Publish state deliberately stays out of the Signal K data tree: cost, commit
SHAs and rate limits are log output and the plugin status line, not paths in
the model.

One thing is not. If publishing fails continuously for
`notifications.warnAfterMinutes` — half an hour by default, which at the underway
cadence is fifteen consecutive attempts — the plugin raises
`notifications.tracker.publishFailed` and clears it on the next success. An
expired token otherwise reaches nobody: the admin UI is a browser tab nobody
has open at sea, and the first anyone ashore knows is that the boat appears
to have stopped. The notification is `visual` only, so it shows up in KIP and
on the chartplotter without sounding the boat's alarm at three in the
morning.

## The site says "Data unavailable"

If the panels read *Data unavailable* while the Raw Data tab shows a current
snapshot, the page and the data have come from different places: the data is
fetched network-first, the page was served by the service worker out of the
device's cache.

The cache is named after the plugin version, shell assets are
stale-while-revalidate, and `data/` is never pre-cached, so a publish reaches
a returning device on the next load or two. A device that loaded a site
published by a release before 0.2.0 can stay stuck on that release's worker.

To clear it: open the site in a private tab to confirm that is what it is,
then on iOS use Settings → Safari →
Advanced → Website Data → your site → Delete, or on a desktop browser hard-
reload it.

A single panel reading *Data unavailable* now means only that panel failed;
the message carries the error and the rest of the dashboard keeps rendering.

## It is not in the plugin list

The server discovers plugins by scanning `~/.signalk/node_modules` for
packages whose `package.json` carries the `signalk-node-server-plugin`
keyword, then `require`-ing each one. A plugin that fails to load is reported
as a provider error rather than shown in the menu, so the server log is the
first place to look.

```bash
ls ~/.signalk/node_modules/signalk-github-pages/dist/index.js   # 1
grep -i signalk-github-pages ~/.signalk/signalk-server.log      # 2
node -e "console.log(require(process.env.HOME + \
  '/.signalk/node_modules/signalk-github-pages'))"              # 3
```

1. **No such file** — the build did not run. This is the usual one after a
   `git clone` straight into `node_modules`, which skips npm entirely and so
   skips `prepare`. The npm package ships `dist/` prebuilt. Fix it in place:
   ```bash
   cd ~/.signalk/node_modules/signalk-github-pages && npm install && npm run build
   ```
2. **`Failed to start`, or a stack trace** — the module threw on load. The
   trace names the reason; a missing `js-yaml` means the dependencies were
   never installed.
3. **Prints a function** — the package is fine and the problem is elsewhere:
   confirm the server was restarted, that it is reading the `~/.signalk` you
   are looking at (`SIGNALK_NODE_CONFIG_DIR` overrides it), and that Node is
   20 or newer (`node -v`), which is what `package.json` asks for.
