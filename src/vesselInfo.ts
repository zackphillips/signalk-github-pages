/**
 * `data/vessel/info.yaml` — the frontend's copy of the vessel configuration.
 *
 * Two sources feed it. Anything about the *site* comes from the plugin config
 * page; anything about the *boat* comes from the Signal K tree, because the
 * server already holds it and a second copy typed into a form is a second copy
 * to keep right. The name, MMSI, callsign, registrations and dimensions are
 * read straight off `vessels.self` every cycle; the config fields for a USCG
 * or hull number are used only when their override checkbox is ticked, and
 * the difference from what Signal K reports is logged.
 *
 * One key is not ours either way: `passage:`. The passage banner is edited
 * from the GitHub web UI by whoever is ashore following the boat, so it is
 * read back off the published file and carried through untouched. Moving it
 * into plugin config would mean editing over the VPN instead of from a phone,
 * which is a step backwards.
 */
import yaml from 'js-yaml';
import type { PluginConfig } from './config';
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
 * Not cosmetic: `info.yaml` is rewritten whenever the rendered content changes,
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

const HEADER = `# Generated by the signalk-github-pages plugin — edits here are overwritten.
# Change these values on the plugin's configuration page in the Signal K admin UI.
#
# The one exception is the 'passage:' block below, which the plugin preserves.
# Set it from the GitHub web UI before departure to show voyage context on the
# tracker, and delete it on arrival:
#
# passage:
#   from: "San Francisco, CA"
#   to: "Santa Cruz, CA"
#   departed: "2026-02-20"
`;

/** Lift the user-owned `passage:` block out of the published file. */
export function extractPassage(existingYaml: string | null | undefined): unknown {
  if (!existingYaml) return undefined;
  try {
    const parsed = yaml.load(existingYaml);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const passage = (parsed as Record<string, unknown>).passage;
      if (passage && typeof passage === 'object') return passage;
    }
  } catch {
    // A file we cannot parse has no passage worth keeping; the rewrite below
    // replaces it with something valid.
  }
  return undefined;
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

export function renderVesselInfo(
  config: PluginConfig,
  identity: VesselIdentity,
  existingYaml?: string | null,
  onProblem: (message: string) => void = () => {},
): string {
  const passage = extractPassage(existingYaml);
  const document: Record<string, unknown> = {};

  if (passage !== undefined) document.passage = passage;
  if (identity.name) document.name = identity.name;
  if (identity.mmsi) document.mmsi = identity.mmsi;
  if (identity.callsign) document.callsign = identity.callsign;
  if (identity.uuid) document.uuid = identity.uuid;
  if (identity.imo) document.imo = identity.imo;
  if (identity.flag) document.flag = identity.flag;
  if (identity.homePort) document.home_port = identity.homePort;
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
  if (identity.registrations && Object.keys(identity.registrations).length) {
    document.registrations = identity.registrations;
  }
  if (identity.design && Object.keys(identity.design).length) document.design = identity.design;
  if (identity.signalk?.host) {
    document.signalk = {
      host: identity.signalk.host,
      port: String(identity.signalk.port ?? 3000),
      protocol: identity.signalk.protocol ?? 'http',
    };
  }
  if (config.timezone) document.timezone = config.timezone;
  document.privacy_zones = config.privacyZones.map((zone) => ({
    name: zone.name || 'Privacy zone',
    lat: zone.lat,
    lon: zone.lon,
    radius_m: zone.radius_m,
  }));

  return `${HEADER}\n${yaml.dump(document, { lineWidth: 100, noRefs: true })}`;
}
