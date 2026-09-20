/**
 * `data/vessel/site.json` — the handful of things the site needs that the
 * published snapshot does not already carry.
 *
 * This file used to be `info.yaml`, and it used to carry the boat as well:
 * name, MMSI, callsign, UUID, IMO, flag, home port, registrations and
 * dimensions, all read off the self tree, serialised to YAML, and published
 * one directory away from `data/telemetry/signalk_latest.json`, which is the
 * whole self tree and already contains every one of them. The frontend even
 * preferred the snapshot and treated this as the fallback. So the duplicate
 * is gone: the boat comes from the snapshot, and what is left here is only
 * what has no other source.
 *
 * What has no other source is site configuration — the privacy zones, the
 * custom links, the default position, the track timezone, the address the
 * site links back to — plus two numbers derived from the tree that the
 * frontend should not have to re-derive (the USCG documentation number and
 * the hull number, picked out of `registrations` by `readVesselDetails`),
 * plus the passage banner, which now comes from the Course API rather than
 * from anyone editing a file.
 *
 * JSON rather than YAML because nothing edits it by hand any more. That
 * takes a 30 KB js-yaml script off the page's critical path — fetched from a
 * CDN, on a phone tethered to a marina hotspot — along with the runtime
 * parse and the `typeof jsyaml === 'undefined'` guard around it. The plugin
 * still depends on js-yaml, for the Markdown front matter in `docsIndex.ts`;
 * the browser no longer does.
 */
import type { PluginConfig } from './config';
import type { Passage } from './course';
import type { Tree } from './snapshot';

/** Hull dimensions, in the SI units Signal K publishes them in. */
export interface VesselDesign {
  length_overall_m?: number;
  length_hull_m?: number;
  length_waterline_m?: number;
  beam_m?: number;
  draft_max_m?: number;
  draft_min_m?: number;
  air_height_m?: number;
  displacement_kg?: number;
  keel_type?: string;
  ais_ship_type?: string;
}

export interface VesselIdentity {
  name: string;
  mmsi: string;
  signalk?: { host?: string; port?: string | number; protocol?: string };
  uuid?: string;
  callsign?: string;
  imo?: string;
  flag?: string;
  homePort?: string;
  /** Registration numbers, keyed by the label Signal K files them under. */
  registrations?: Record<string, string>;
  /** Pulled out of `registrations` when one looks like the documentation. */
  uscgNumber?: string;
  /** Likewise for a hull identification number. */
  hullNumber?: string;
  design?: VesselDesign;
}

/** Unwrap `{ value, timestamp }`, or take the node as it stands. */
function leaf(node: unknown): unknown {
  if (node && typeof node === 'object' && 'value' in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>).value;
  }
  return node;
}

function leafString(node: unknown): string {
  const value = leaf(node);
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/**
 * A dimension, rounded to the millimetre.
 *
 * Not cosmetic: `site.json` is rewritten whenever the rendered content changes,
 * so a draft reported as 2.1300000000000003 one cycle and 2.13 the next would
 * be a commit every two minutes for a number that did not move.
 */
function metres(node: unknown): number | undefined {
  const value = leaf(node);
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(value * 1000) / 1000;
}

/** Keys and descriptions that mean a US Coast Guard documentation number. */
const USCG_HINT = /uscg|coast\s*guard|documentation|official\s*number/i;
/** ...and a hull identification number. */
const HIN_HINT = /\bhin\b|hull/i;

/**
 * Flatten `registrations.{national,local,other}` into label -> number.
 *
 * Signal K nests each registration under a key the source chose, with a free
 * text description beside the number. Both are searched for the two numbers
 * the site shows, so a server that files its documentation number under
 * `national.usa` and one that uses `other.uscg` both work.
 */
function readRegistrations(node: unknown): {
  all: Record<string, string>;
  uscg?: string;
  hin?: string;
} {
  const all: Record<string, string> = {};
  let uscg: string | undefined;
  let hin: string | undefined;
  if (!node || typeof node !== 'object') return { all };

  const imo = leafString((node as Record<string, unknown>).imo);
  if (imo) all.imo = imo;

  for (const group of ['national', 'local', 'other'] as const) {
    const entries = (node as Record<string, any>)[group];
    if (!entries || typeof entries !== 'object') continue;
    for (const [key, entry] of Object.entries(entries as Record<string, any>)) {
      const number =
        leafString(entry?.registrationNumber) ||
        leafString(entry?.registrationNumber?.value) ||
        (typeof entry === 'string' ? entry.trim() : '');
      if (!number) continue;
      const description = leafString(entry?.description);
      const country = leafString(entry?.country);
      const label = [group, key].join('.');
      all[label] = number;
      const haystack = `${key} ${description}`;
      if (!uscg && (USCG_HINT.test(haystack) || (group === 'national' && /^(us|usa)$/i.test(country)))) {
        uscg = number;
      }
      if (!hin && HIN_HINT.test(haystack)) hin = number;
    }
  }
  return { all, uscg, hin };
}

/**
 * Everything about the boat that the Signal K tree will tell us.
 *
 * Read from the tree rather than from the server object so it happens every
 * cycle: on a cold start the plugin is running before the first NMEA 2000
 * product-information frame arrives, and identity read once at start would
 * publish "Vessel" until the next restart.
 */
export function readVesselDetails(tree: Tree): Partial<VesselIdentity> {
  if (!tree || typeof tree !== 'object') return {};
  const design = (tree as any).design ?? {};
  const length = leaf(design.length) as Record<string, unknown> | undefined;
  const draft = leaf(design.draft) as Record<string, unknown> | undefined;
  const keel = leaf(design.keel) as Record<string, unknown> | undefined;
  const shipType = leaf(design.aisShipType) as Record<string, unknown> | undefined;
  const registrations = readRegistrations((tree as any).registrations);

  const dimensions: VesselDesign = {
    length_overall_m: metres(length?.overall),
    length_hull_m: metres(length?.hull),
    length_waterline_m: metres(length?.waterline),
    beam_m: metres(design.beam),
    draft_max_m: metres(draft?.maximum),
    draft_min_m: metres(draft?.minimum),
    air_height_m: metres(design.airHeight),
    displacement_kg: metres(design.displacement),
    keel_type: typeof keel?.type === 'string' ? keel.type : undefined,
    ais_ship_type: typeof shipType?.name === 'string' ? shipType.name : undefined,
  };
  for (const key of Object.keys(dimensions) as Array<keyof VesselDesign>) {
    if (dimensions[key] === undefined) delete dimensions[key];
  }

  const mmsi = leafString((tree as any).mmsi);
  const details: Partial<VesselIdentity> = {
    name: leafString((tree as any).name),
    mmsi: /^\d{9}$/.test(mmsi) ? mmsi : '',
    uuid: leafString((tree as any).uuid),
    callsign:
      leafString((tree as any).communication?.callsignVhf) ||
      leafString((tree as any).communication?.callsignHf),
    imo: registrations.all.imo,
    flag: leafString((tree as any).flag),
    homePort: leafString((tree as any).port),
    registrations: Object.keys(registrations.all).length ? registrations.all : undefined,
    uscgNumber: registrations.uscg,
    hullNumber: registrations.hin,
    design: Object.keys(dimensions).length ? dimensions : undefined,
  };
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === '') {
      delete (details as unknown as Record<string, unknown>)[key];
    }
  }
  return details;
}

/**
 * Lay what the tree reported over what the server object gave us at start.
 *
 * The tree wins wherever it has something: it is the live model, and the base
 * exists for what only the process knows (the LAN address and port the site
 * links back to) plus the `urn:mrn:imo:mmsi:` fallback for an MMSI the tree
 * does not repeat.
 */
export function mergeVesselIdentity(
  base: VesselIdentity,
  fromTree: Partial<VesselIdentity>,
): VesselIdentity {
  const merged: VesselIdentity = { ...base };
  for (const [key, value] of Object.entries(fromTree)) {
    if (value === undefined || value === '') continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.name = fromTree.name || base.name || 'Vessel';
  merged.mmsi = fromTree.mmsi || base.mmsi || '';
  return merged;
}

/**
 * What Signal K reported, unless the config page overrides it.
 *
 * An override that disagrees with the tree is logged: a server reporting one
 * documentation number while the page says another is a thing to notice, not
 * to resolve silently.
 */
function pick(
  label: string,
  override: boolean,
  configured: string,
  fromSignalK: string | undefined,
  onProblem: (message: string) => void,
): string {
  if (!override) return fromSignalK || '';
  if (configured && fromSignalK && configured !== fromSignalK) {
    onProblem(
      `The ${label} on the config page ("${configured}") differs from the one Signal K ` +
        `reports ("${fromSignalK}"); publishing the configured one.`,
    );
  }
  return configured || fromSignalK || '';
}

/** What the plugin publishes to `data/vessel/site.json`. */
export interface SiteConfigDocument {
  schema_version: number;
  /** Where the site links back to the boat's own Signal K, when on the LAN. */
  signalk?: { host: string; port: string; protocol: string };
  uscg_number?: string;
  hull_number?: string;
  /** Where the configured vessel logo was published, when one is set. */
  logo?: string;
  custom_links?: Array<{ label: string; url: string }>;
  default_location?: { lat: number; lon: number; label?: string };
  timezone?: string;
  /** From the Course API; absent whenever nothing is being navigated to. */
  passage?: Passage;
  privacy_zones: Array<{ name: string; lat: number; lon: number; radius_m: number }>;
}

export const SITE_CONFIG_SCHEMA_VERSION = 1;

/**
 * Render the site's own configuration.
 *
 * Deliberately narrow. Everything about the *boat* — name, MMSI, callsign,
 * registrations, dimensions — is left out, because it is already in the
 * published snapshot and a second copy can only disagree with the first. The
 * two numbers that do appear are here because picking a documentation number
 * out of a Signal K `registrations` tree is a judgement the plugin already
 * makes, and the frontend should not make it a second time.
 */
export function renderSiteConfig(
  config: PluginConfig,
  identity: VesselIdentity,
  passage: Passage | null,
  onProblem: (message: string) => void = () => {},
): string {
  const document: SiteConfigDocument = {
    schema_version: SITE_CONFIG_SCHEMA_VERSION,
    privacy_zones: config.privacyZones.map((zone) => ({
      name: zone.name || 'Privacy zone',
      lat: zone.lat,
      lon: zone.lon,
      radius_m: zone.radius_m,
    })),
  };

  if (identity.signalk?.host) {
    document.signalk = {
      host: identity.signalk.host,
      port: String(identity.signalk.port ?? 3000),
      protocol: identity.signalk.protocol ?? 'http',
    };  }

  const uscgNumber = pick(
    'USCG documentation number',
    config.site.overrideUscgNumber,
    config.site.uscgNumber,
    identity.uscgNumber,
    onProblem,
  );
  if (uscgNumber) document.uscg_number = uscgNumber;
  const hullNumber = pick(
    'hull number',
    config.site.overrideHullNumber,
    config.site.hullNumber,
    identity.hullNumber,
    onProblem,
  );
  if (hullNumber) document.hull_number = hullNumber;

  // Where the logo was published, for the <img> tags the page fills in after
  // it loads. The site's address is deliberately not here: the published HTML
  // carries it already, substituted in at publish time because a link preview
  // is rendered by a crawler that never runs the page, and a second copy
  // nothing reads is a second copy to keep right.
  if (config.site.logo) document.logo = config.site.logo.path;

  if (config.site.customLinks.length) {
    document.custom_links = config.site.customLinks.map((link) => ({
      label: link.label,
      url: link.url,
    }));
  }
  if (config.site.defaultLocation) {
    const { lat, lon, label } = config.site.defaultLocation;
    document.default_location = label ? { lat, lon, label } : { lat, lon };
  }
  if (config.timezone) document.timezone = config.timezone;
  if (passage) document.passage = passage;

  return `${JSON.stringify(document, null, 2)}\n`;
}
