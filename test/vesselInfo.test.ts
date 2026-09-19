import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { extractPassage, parseExtraFields, renderVesselInfo } from '../src/vesselInfo';
import { makeConfig } from './helpers/config';

const CONFIG = makeConfig({
  privacyZones: [
    { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 },
  ],
  site: {
    theme: 'mermug',
    marinetrafficShipId: '9698083',
    postgsailLogsUrl: 'https://example.invalid/logs',
    uscgNumber: '1024168',
    hullNumber: 'BEY57004E494',
  },
});

const IDENTITY = {
  name: 'S.V.Mermug',
  mmsi: '338543654',
  signalk: { host: '192.168.8.50', port: 3000, protocol: 'http' },
};

describe('renderVesselInfo', () => {
  it('writes what the frontend reads', () => {
    const parsed = yaml.load(renderVesselInfo(CONFIG, IDENTITY)) as any;
    expect(parsed.name).toBe('S.V.Mermug');
    expect(parsed.mmsi).toBe('338543654');
    expect(parsed.theme).toBe('mermug');
    expect(parsed.marinetraffic_ship_id).toBe('9698083');
    expect(parsed.signalk).toEqual({ host: '192.168.8.50', port: '3000', protocol: 'http' });
    expect(parsed.privacy_zones).toEqual([
      { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 },
    ]);
  });

  it('carries the passage block across a rewrite', () => {
    // The passage banner is edited from the GitHub web UI by whoever is
    // ashore; a config change on the boat must not wipe it.
    const published = yaml.dump({
      passage: { from: 'San Francisco, CA', to: 'Santa Cruz, CA', departed: '2026-02-20' },
      name: 'Old name',
    });
    const parsed = yaml.load(renderVesselInfo(CONFIG, IDENTITY, published)) as any;
    expect(parsed.passage).toEqual({
      from: 'San Francisco, CA',
      to: 'Santa Cruz, CA',
      departed: '2026-02-20',
    });
    expect(parsed.name).toBe('S.V.Mermug');
  });

  it('omits passage when there is none, and survives an unparseable file', () => {
    expect((yaml.load(renderVesselInfo(CONFIG, IDENTITY)) as any).passage).toBeUndefined();
    expect(extractPassage('{: not yaml\n  - at all')).toBeUndefined();
    expect(extractPassage(null)).toBeUndefined();
  });

  it('leaves out empty optional fields rather than writing blanks', () => {
    const bare = makeConfig();
    const parsed = yaml.load(renderVesselInfo(bare, { name: 'Boat', mmsi: '' })) as any;
    expect(parsed.mmsi).toBeUndefined();
    expect(parsed.uscg_number).toBeUndefined();
    expect(parsed.privacy_zones).toEqual([]);
  });
});

describe('extra site fields', () => {
  const render = (extraYaml: string, problems: string[] = []) =>
    yaml.load(
      renderVesselInfo(makeConfig({ site: { extraYaml } }), IDENTITY, null, (p) =>
        problems.push(p),
      ),
    ) as any;

  it('merges free-form YAML into the published file', () => {
    const parsed = render('default_location:\n  lat: 37.806\n  lon: -122.465\n  label: The Bay\n');
    expect(parsed.default_location).toEqual({ lat: 37.806, lon: -122.465, label: 'The Bay' });
    expect(parsed.name).toBe('S.V.Mermug');
  });

  it('lets an extra field override what the config page would have written, and says so', () => {
    const problems: string[] = [];
    const parsed = render('theme: kelp\n', problems);
    expect(parsed.theme).toBe('kelp');
    expect(problems.join(' ')).toContain('overrides the value from the plugin config');
  });

  it('refuses to set passage, which lives in the repository', () => {
    const problems: string[] = [];
    const parsed = render('passage:\n  from: SF\n', problems);
    expect(parsed.passage).toBeUndefined();
    expect(problems.join(' ')).toContain('must not set "passage:"');
  });

  it('skips invalid YAML rather than stopping the publish', () => {
    const problems: string[] = [];
    const parsed = render('key: [unclosed\n', problems);
    expect(parsed.name).toBe('S.V.Mermug');
    expect(problems.join(' ')).toContain('not valid YAML');
  });

  it('skips a scalar or a list, which cannot merge into a mapping', () => {
    const problems: string[] = [];
    expect(parseExtraFields('- one\n- two\n', (p) => problems.push(p))).toEqual({});
    expect(problems.join(' ')).toContain('must be a YAML mapping');
  });

  it('treats a blank block as no extras', () => {
    expect(parseExtraFields('   \n')).toEqual({});
  });
});
