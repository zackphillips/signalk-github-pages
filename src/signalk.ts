/**
 * The server's own contract, in one place.
 *
 * Every other module in this plugin used to declare the bits of the Signal K
 * app object it touched as a structural interface of its own — a
 * `getSelfPath` here, a `resourcesApi` there. That compiles against anything,
 * which is the problem: a server that renames a method, or a plugin that
 * reaches for one that never existed, both typecheck perfectly and fail at
 * run time on the boat. `@signalk/server-api` is the server's published
 * description of itself, so it is a devDependency and the types come from
 * there.
 *
 * Two members are narrowed rather than taken as they stand. `ServerAPI`
 * declares `notifications` and `getCourse` as always present, because they
 * are present on a current server; this plugin runs on older ones, where they
 * are not. Making them optional here is what forces every use site to
 * feature-detect, and the list below is the honest inventory of what this
 * plugin assumes about the server's age.
 *
 * `getHistoryApi` needs no help: the server's own type already marks it
 * optional, for exactly this reason.
 */
import type { ServerAPI } from '@signalk/server-api';

/** Members this plugin feature-detects rather than assuming. */
type OptionalOnOlderServers = 'notifications' | 'getCourse';

/**
 * The app object as this plugin is willing to rely on it.
 *
 * Nothing outside this file should import `ServerAPI` directly: the point of
 * the alias is that the narrowing above cannot be bypassed by accident.
 */
export type SignalKApp = Omit<ServerAPI, OptionalOnOlderServers> &
  Partial<Pick<ServerAPI, OptionalOnOlderServers>> &
  ServerSettings;

/**
 * The one thing this plugin uses that `ServerAPI` does not describe.
 *
 * The site links back to the boat's own Signal K — Freeboard, the admin UI,
 * the raw API — so it needs the port the server is listening on and whether
 * it is doing so over TLS. That lives on `app.config.settings`, which is real
 * and stable but has never been part of the published plugin contract, so it
 * is declared here, optional, and read defensively.
 */
interface ServerSettings {
  config?: {
    settings?: {
      port?: number;
      ssl?: boolean;
      /** The history provider picked in the server's own settings. */
      historyApi?: { defaultProvider?: string };
    };
  };
  /**
   * The server's plugin list. Real on every release with a History API, but
   * never part of the published contract, so optional and read defensively.
   * The config page probes each enabled plugin to find the history providers:
   * the server keeps that registry to itself.
   */
  getPluginsList?: (enabled?: boolean) => Promise<Array<{ id: string }>>;
}

export type { Plugin, PluginRouter } from '@signalk/server-api';
export type { CourseInfo } from '@signalk/server-api';
