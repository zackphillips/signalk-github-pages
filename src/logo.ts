/**
 * The vessel logo, taken through the config page rather than committed by hand.
 *
 * The site shows a logo in four places — the status hero, the footer, the
 * browser tab and the phone home screen — and every one of them used to point
 * at `data/vessel/logo.png`, a path the plugin does not own. Setting it meant
 * committing a binary to GitHub, which is the one thing the config page cannot
 * ask someone to do from a boat.
 *
 * So the field is an image, and the admin UI hands an image over as a data URL
 * (`data:image/png;name=burgee.png;base64,...`). This module turns that string
 * into bytes and a path; `publisher.ts` puts it in a commit and `manifest.ts`
 * claims the path only while there is one to publish, the same arrangement the
 * polar table has. Nothing here deletes: clearing the field stops republishing
 * the logo and stops claiming it, leaving what is already on the site alone.
 */
import { Buffer } from 'node:buffer';

/** Where a logo is published, by the media type it came in as. */
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
 * frontend keeps asking for it and hides the image when it 404s. A logo set on
 * the config page overrides it.
 */
export const LEGACY_LOGO_PATH = 'data/vessel/logo.png';

/**
 * Cap on the decoded image.
 *
 * The data URL is stored in the plugin's config and the bytes are uploaded on
 * every frontend publish. A logo is a few tens of kilobytes; a megabyte of it
 * is a photograph someone dropped in by mistake.
 */
export const LOGO_MAX_BYTES = 512 * 1024;

export interface VesselLogo {
  /** Repository path this is published at. */
  path: string;
  content: Buffer;
  mediaType: string;
}

export interface LogoResult {
  logo: VesselLogo | null;
  /** Reasons the field was not usable, for the config page's problem list. */
  problems: string[];
}

/**
 * Decode the config field.
 *
 * Empty is not a problem — it is the default, and it means the pages fall back
 * to `LEGACY_LOGO_PATH`. Anything else that will not decode is, because a logo
 * silently dropped looks exactly like a logo that did not upload.
 */
export function parseLogo(value: unknown): LogoResult {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { logo: null, problems: [] };

  const match = /^data:([^;,]+)((?:;[^;,]*)*),(.*)$/s.exec(raw);
  if (!match) {
    return {
      logo: null,
      problems: [
        'The vessel logo is not an uploaded image. Use the file picker on this ' +
          'field, or clear it to fall back to data/vessel/logo.png.',
      ],
    };
  }

  const mediaType = (match[1] ?? '').toLowerCase();
  const parameters = match[2] ?? '';
  const payload = match[3] ?? '';
  const extension = EXTENSIONS[mediaType];
  if (!extension) {
    return {
      logo: null,
      problems: [
        `The vessel logo is a ${mediaType || 'file of unknown type'}; it needs to ` +
          'be a PNG, JPEG, WebP or SVG image.',
      ],
    };
  }
  if (!/;base64/i.test(parameters)) {
    return {
      logo: null,
      problems: ['The vessel logo is not base64-encoded; re-upload it on the config page.'],
    };
  }

  const content = Buffer.from(payload, 'base64');
  if (!content.length) {
    return { logo: null, problems: ['The vessel logo decoded to an empty file.'] };
  }
  if (content.length > LOGO_MAX_BYTES) {
    return {
      logo: null,
      problems: [
        `The vessel logo is ${Math.round(content.length / 1024)} kB; the limit is ` +
          `${Math.round(LOGO_MAX_BYTES / 1024)} kB. It is uploaded whole on every ` +
          'frontend publish, so a logo wants to be an icon rather than a photograph.',
      ],
    };
  }

  return {
    logo: { path: `data/vessel/logo.${extension}`, content, mediaType },
    problems: [],
  };
}
