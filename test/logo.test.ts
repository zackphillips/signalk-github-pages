import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptVesselImages,
  loadVesselImage,
  parseVesselImageFor,
  saveVesselImage,
  type VesselImage,
} from '../src/logo';
import { StateStore } from '../src/state';

const PNG =
  'data:image/png;name=burgee.png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = 'data:image/svg+xml;base64,PHN2Zy8+';

const decode = (kind: 'logo' | 'icon', value: string): VesselImage =>
  parseVesselImageFor(kind, value).image!;

describe('the stored vessel images', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skgp-logo-'));
    store = new StateStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips through the data directory as a plain file', async () => {
    const logo = decode('logo', PNG);
    await saveVesselImage(store, 'logo', logo);

    expect(await fs.readdir(path.join(dir, 'images'))).toEqual(['logo.png']);
    const loaded = await loadVesselImage(store, 'logo');
    expect(loaded?.path).toBe('data/vessel/logo.png');
    expect(loaded?.mediaType).toBe('image/png');
    expect(loaded?.content.equals(logo.content)).toBe(true);
    expect(await loadVesselImage(store, 'icon')).toBeNull();
  });

  it('replaces an image of another type rather than keeping both', async () => {
    await saveVesselImage(store, 'logo', decode('logo', PNG));
    await saveVesselImage(store, 'logo', decode('logo', SVG));
    expect(await fs.readdir(path.join(dir, 'images'))).toEqual(['logo.svg']);
    expect((await loadVesselImage(store, 'logo'))?.mediaType).toBe('image/svg+xml');
  });

  it('clears one kind without touching the other', async () => {
    await saveVesselImage(store, 'logo', decode('logo', PNG));
    await saveVesselImage(store, 'icon', decode('icon', SVG));
    await saveVesselImage(store, 'logo', null);
    expect(await loadVesselImage(store, 'logo')).toBeNull();
    expect((await loadVesselImage(store, 'icon'))?.path).toBe('data/vessel/icon.svg');
  });

  describe('at start', () => {
    const run = async (options: unknown, site: Record<string, VesselImage | null>) => {
      const saves: Array<Record<string, any>> = [];
      await adoptVesselImages({
        options,
        site: site as any,
        store,
        saveOptions: async (stripped) => void saves.push(stripped),
        log: () => {},
      });
      return saves;
    };

    it('moves a data URL out of the saved options and into the data directory', async () => {
      const logo = decode('logo', PNG);
      const site = { logo, icon: null };
      const options = {
        github: { owner: 'owner' },
        site: { logo: PNG, icon: '', customLinks: [{ label: 'a', url: 'https://a' }] },
      };
      const saves = await run(options, site);

      expect((await loadVesselImage(store, 'logo'))?.content.equals(logo.content)).toBe(true);
      // Both keys go, the empty one included: it is what the old schema
      // default left in every saved config. Everything else is kept.
      expect(saves).toEqual([
        {
          github: { owner: 'owner' },
          site: { customLinks: [{ label: 'a', url: 'https://a' }] },
        },
      ]);
      expect(site.logo).toBe(logo);
    });

    it('loads what is stored and leaves the options alone when they carry no image', async () => {
      await saveVesselImage(store, 'icon', decode('icon', SVG));
      const site: Record<string, VesselImage | null> = { logo: null, icon: null };
      const saves = await run({ site: { customLinks: [] } }, site);

      expect(saves).toEqual([]);
      expect(site.icon?.path).toBe('data/vessel/icon.svg');
      expect(site.logo).toBeNull();
    });

    it('does not rewrite the options when storing the image fails', async () => {
      const site = { logo: decode('logo', PNG), icon: null };
      const broken = new StateStore(path.join(dir, 'missing'));
      broken.writeBytes = async () => {
        throw new Error('disk full');
      };
      const saves: unknown[] = [];
      await expect(
        adoptVesselImages({
          options: { site: { logo: PNG } },
          site: site as any,
          store: broken,
          saveOptions: async (stripped) => void saves.push(stripped),
          log: () => {},
        }),
      ).rejects.toThrow('disk full');
      expect(saves).toEqual([]);
    });
  });
});
