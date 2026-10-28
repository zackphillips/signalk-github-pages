/**
 * The vessel logo and the vessel icon, each taken through the config page
 * rather than committed by hand.
 *
 * The site shows the logo in two places — the status hero and the footer —
 * and the icon in three: the browser tab, the phone home screen, and the
 * image a shared link unfurls to in a chat app. They used to be the same
 * upload: one "Vessel logo" field fed all five places, so a boat with a
 * detailed logo that reads fine at 200px got a muddy, illegible favicon, and
 * a boat that wanted a clean square icon had to make its status-hero image
 * match. They are two fields now, decoded and published independently, on
 * the same arrangement as the polar table: written when the bytes change,
 * never deleted, so clearing one field stops republishing that image without
 * touching the other or removing artwork someone committed by hand.
 *
 * Neither image lives in the plugin config. They used to: the config page had
 * a file picker for each, which stored the upload as a base64 data URL inside
 * the plugin's options. The Signal K admin UI loads every plugin's options in
 * one response, so a 5 MB logo became a 7 MB string that every plugin's config
 * page downloaded and parsed before it could render. The images are uploaded
 * from the plugin's own console now and kept as plain files in the plugin data
 * directory (`images/logo.png`, `images/icon.svg`), which nothing else reads.
 *
 * The console hands each upload over as a data URL
 * (`data:image/png;name=burgee.png;base64,...`), the same shape the config
 * page's file picker produced. This module turns that string into bytes and a
 * path, stores and loads the result, and `publisher.ts` puts it in a commit;
 * `manifest.ts` claims the path only while there is one to publish.
 *
 * There is no size limit here. Each image is fingerprinted by `publisher.ts`
 * and uploaded only when its own bytes change, so a large file costs one
 * upload rather than one per cycle. The ceiling that does exist is the Signal
 * K server's JSON body limit, `FILEUPLOADSIZELIMIT`, 10 MB by default, and
 * base64 inflates a file by about a third on the way in. Every visitor to the
 * site downloads the logo, though, so the console says so past
 * `LARGE_IMAGE_BYTES`.
 */
import { Buffer } from 'node:buffer';
import type { StateStore } from './state';

/** Where an image is published, by the media type it came in as. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export interface VesselImage {
  /** Repository path this is published at. */
  path: string;
  content: Buffer;
  mediaType: string;
}

/** The logo shown in the status hero and the footer. */
export type VesselLogo = VesselImage;
/** The tab, home-screen and link-preview icon. */
export type VesselIcon = VesselImage;

export interface VesselImageResult<T> {
  image: T | null;
  /** Reasons the field was not usable, for the config page's problem list. */
  problems: string[];
}

export type LogoResult = { logo: VesselLogo | null; problems: string[] };
export type IconResult = { icon: VesselIcon | null; problems: string[] };

/**
 * Decode one of the two image config fields.
 *
 * Empty is not a problem — it is the default, and the caller decides what it
 * falls back to. Anything else that will not decode is reported, because an
 * image silently dropped looks exactly like one that did not upload.
 */
function parseVesselImage(
  value: unknown,
  field: string,
  pathPrefix: string,
): VesselImageResult<VesselImage> {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { image: null, problems: [] };

  const match = /^data:([^;,]+)((?:;[^;,]*)*),(.*)$/s.exec(raw);
  if (!match) {
    return {
      image: null,
      problems: [
        `The ${field} is not an uploaded image.`,
      ],
    };
  }

  const mediaType = (match[1] ?? '').toLowerCase();
  const parameters = match[2] ?? '';
  const payload = match[3] ?? '';
  const extension = EXTENSIONS[mediaType];
  if (!extension) {
    return {
      image: null,
      problems: [
        `The ${field} is a ${mediaType || 'file of unknown type'}; it needs to be a ` +
          'PNG, JPEG, WebP or SVG image.',
      ],
    };
  }
  if (!/;base64/i.test(parameters)) {
    return {
      image: null,
      problems: [`The ${field} is not base64-encoded; upload it again.`],
    };
  }

  const content = Buffer.from(payload, 'base64');
  if (!content.length) {
    return { image: null, problems: [`The ${field} decoded to an empty file.`] };
  }

  return {
    image: { path: `${pathPrefix}.${extension}`, content, mediaType },
    problems: [],
  };
}

export function parseLogo(value: unknown): LogoResult {
  const { image, problems } = parseVesselImage(value, 'vessel logo', 'data/vessel/logo');
  return { logo: image, problems };
}

export function parseIcon(value: unknown): IconResult {
  const { image, problems } = parseVesselImage(value, 'vessel icon', 'data/vessel/icon');
  return { icon: image, problems };
}

export type VesselImageKind = 'logo' | 'icon';

export const VESSEL_IMAGE_KINDS: readonly VesselImageKind[] = ['logo', 'icon'];

/** Past this, the console warns that every visitor downloads the file. */
export const LARGE_IMAGE_BYTES = 1024 * 1024;

/** Decode an upload for either field. */
export function parseVesselImageFor(
  kind: VesselImageKind,
  value: unknown,
): VesselImageResult<VesselImage> {
  return kind === 'logo'
    ? parseVesselImage(value, 'vessel logo', 'data/vessel/logo')
    : parseVesselImage(value, 'vessel icon', 'data/vessel/icon');
}

/** Where images are kept in the plugin data directory. */
const IMAGE_DIR = 'images';

function mediaTypeFor(extension: string): string | undefined {
  return Object.entries(EXTENSIONS).find(([, ext]) => ext === extension)?.[0];
}

/**
 * The stored image of one kind, or null.
 *
 * The file name carries the extension, and the extension is the media type:
 * nothing else is recorded, so there is no second file to disagree with it.
 */
export async function loadVesselImage(
  store: StateStore,
  kind: VesselImageKind,
): Promise<VesselImage | null> {
  for (const name of await store.list(IMAGE_DIR)) {
    const match = /^(logo|icon)\.([a-z]+)$/.exec(name);
    if (!match || match[1] !== kind) continue;
    const mediaType = mediaTypeFor(match[2]!);
    if (!mediaType) continue;
    const content = await store.readBytes(`${IMAGE_DIR}/${name}`);
    if (!content?.length) continue;
    return { path: `data/vessel/${kind}.${match[2]}`, content, mediaType };
  }
  return null;
}

/**
 * Replace the stored image of one kind, or remove it with null.
 *
 * Any other extension of the same kind is removed first, so a PNG replaced by
 * an SVG does not leave the PNG to be found by the next load.
 */
export async function saveVesselImage(
  store: StateStore,
  kind: VesselImageKind,
  image: VesselImage | null,
): Promise<void> {
  const keep = image ? `${kind}.${image.path.split('.').pop()}` : null;
  if (image && keep) await store.writeBytes(`${IMAGE_DIR}/${keep}`, image.content);
  for (const name of await store.list(IMAGE_DIR)) {
    if (name.startsWith(`${kind}.`) && name !== keep) {
      await store.remove(`${IMAGE_DIR}/${name}`);
    }
  }
}

/**
 * Load the logo and icon into the running config, at start.
 *
 * A data URL still in the saved options is from before the images left the
 * config page, or from a config page left open across the upgrade and then
 * saved. It wins: `resolveConfig` has already decoded it into `site`, so it is
 * written to the data directory, and the keys are then taken out of the saved
 * options so the admin UI stops shipping them to every plugin's config page.
 * The bytes are stored before the options are rewritten, so a failure
 * part-way loses nothing; a key that would not decode was already reported by
 * `resolveConfig` and is removed all the same. Otherwise the stored image, if
 * any, is loaded.
 */
export async function adoptVesselImages(deps: {
  options: unknown;
  site: Record<VesselImageKind, VesselImage | null>;
  store: StateStore;
  saveOptions: (options: Record<string, unknown>) => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  const { site, store, log } = deps;
  const saved =
    deps.options && typeof deps.options === 'object'
      ? (deps.options as Record<string, unknown>)
      : {};
  const savedSite =
    saved.site && typeof saved.site === 'object' ? (saved.site as Record<string, unknown>) : {};
  const legacy = VESSEL_IMAGE_KINDS.filter((kind) => kind in savedSite);

  for (const kind of VESSEL_IMAGE_KINDS) {
    const fromOptions = site[kind];
    if (fromOptions) {
      await saveVesselImage(store, kind, fromOptions);
      log(`Moved the vessel ${kind} out of the plugin config into the data directory.`);
    } else {
      site[kind] = await loadVesselImage(store, kind);
    }
  }

  if (legacy.length === 0) return;
  const strippedSite = { ...savedSite };
  for (const kind of legacy) delete strippedSite[kind];
  await deps.saveOptions({ ...saved, site: strippedSite });
}
