import { describe, expect, it } from 'vitest';
import createPlugin from '../src/index';

/**
 * The config page's derived notes, through the plugin rather than through
 * `buildConfigSchema` directly: what the page shows depends on reading the
 * saved options back in the shape the server stores them.
 */
const pluginFor = (options: unknown) =>
  createPlugin({ readPluginOptions: () => options } as any);

const note = (schema: any, flag: string) =>
  schema.properties.overrides.properties[flag].description as string;

describe('the schema the config page is rendered from', () => {
  it('reads the owner out of the stored file, which nests the configuration', () => {
    // `savePluginOptions(configuration)` and `readPluginOptions()` are not
    // mirror images: what comes back is the whole file, `{ enabled,
    // configuration }`. Read as though it were the configuration, no owner is
    // ever found and every derived note is blank.
    const schema = pluginFor({
      enabled: true,
      configuration: { github: { owner: 'zackphillips' } },
    }).schema() as any;

    expect(note(schema, 'overrideRepository')).toContain('zackphillips.github.io');
    expect(note(schema, 'overrideSiteUrl')).toContain('https://zackphillips.github.io/');
  });

  it('follows the saved repository name into the address it derives', () => {
    for (const configuration of [
      {
        github: { owner: 'zackphillips' },
        overrides: { overrideRepository: true, repository: 'tracker' },
      },
      // Saved before the Overrides section existed.
      { github: { owner: 'zackphillips', overrideName: true, name: 'tracker' } },
    ]) {
      const schema = pluginFor({ configuration }).schema() as any;
      expect(note(schema, 'overrideSiteUrl')).toContain(
        'https://zackphillips.github.io/tracker/',
      );
    }
  });

  it('says nothing derived on a fresh install, rather than guessing', () => {
    for (const options of [{}, { configuration: {} }, undefined]) {
      const schema = pluginFor(options).schema() as any;
      expect(note(schema, 'overrideRepository')).toContain('Not derived');
      expect(note(schema, 'overrideSiteUrl')).not.toContain('served at');
      expect(note(schema, 'overrideBranch')).toContain('Not checked yet');
    }
  });
});
