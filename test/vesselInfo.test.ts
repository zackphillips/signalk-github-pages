import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { normaliseConfig } from '../src/config';
import { extractPassage, renderVesselInfo } from '../src/vesselInfo';

const CONFIG = normaliseConfig({
  github: { repo: 'owner/site', branch: 'main', token: 't' },
  timezone: 'America/Los_Angeles',
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
} as any);

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
    const bare = normaliseConfig({ github: { repo: 'o/r', token: 't' } } as any);
    const parsed = yaml.load(renderVesselInfo(bare, { name: 'Boat', mmsi: '' })) as any;
    expect(parsed.mmsi).toBeUndefined();
    expect(parsed.uscg_number).toBeUndefined();
    expect(parsed.privacy_zones).toEqual([]);
  });
});
