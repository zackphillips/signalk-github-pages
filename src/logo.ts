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
 * The admin UI hands each field over as a data URL
 * (`data:image/png;name=burgee.png;base64,...`). This module turns that
 * string into bytes and a path; `publisher.ts` puts it in a commit and
 * `manifest.ts` claims the path only while there is one to publish.
 */
import { Buffer } from 'node:buffer';

/** Where an image is published, by the media type it came in as. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * The path the pages fall back to when no logo is configured.
 *
 * It is where this plugin's first users committed theirs by hand, so the
 * frontend keeps asking for it and hides the image when it 404s. A logo set
 * on the config page overrides it.
 */
export const LEGACY_LOGO_PATH = 'data/vessel/logo.png';

/**
 * Cap on the decoded image.
 *
 * The data URL is stored in the plugin's config and the bytes are uploaded on
 * every frontend publish. A logo or icon is a few tens of kilobytes; a
 * megabyte of it is a photograph someone dropped in by mistake.
 */
export const LOGO_MAX_BYTES = 512 * 1024;

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
 * falls back to. Anything else that will not decode is a problem, because an
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
        `The ${field} is not an uploaded image. Use the file picker on this field, ` +
          'or clear it to fall back to the default.',
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
      problems: [`The ${field} is not base64-encoded; re-upload it on the config page.`],
    };
  }

  const content = Buffer.from(payload, 'base64');
  if (!content.length) {
    return { image: null, problems: [`The ${field} decoded to an empty file.`] };
  }
  if (content.length > LOGO_MAX_BYTES) {
    return {
      image: null,
      problems: [
        `The ${field} is ${Math.round(content.length / 1024)} kB; the limit is ` +
          `${Math.round(LOGO_MAX_BYTES / 1024)} kB. It is uploaded whole on every ` +
          'frontend publish, so it wants to be an icon rather than a photograph.',
      ],
    };
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
