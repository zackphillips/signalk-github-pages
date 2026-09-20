import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  extractPassage,
  mergeVesselIdentity,
  readVesselDetails,
  renderVesselInfo,
} from '../src/vesselInfo';
import { makeConfig } from './helpers/config';

const CONFIG = makeConfig({
  privacyZones: [
    { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 },
  ],
  site: {
    postgsailLogsUrl: 'https://example.invalid/logs',
    overrideUscgNumber: true,
    uscgNumber: '1024168',
    overrideHullNumber: true,
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

describe('custom buttons', () => {
  it('writes them in order, as label and url pairs', () => {
    const config = makeConfig({
      site: {
        customLinks: [
          { label: "Ship's Log", url: 'https://example.com/log' },
          { label: 'Starlink', url: 'http://192.168.100.1/' },
        ],
      },
    });
    const parsed = yaml.load(renderVesselInfo(config, IDENTITY)) as any;
    expect(parsed.custom_links).toEqual([
      { label: "Ship's Log", url: 'https://example.com/log' },
      { label: 'Starlink', url: 'http://192.168.100.1/' },
    ]);
    // The key it replaced is gone: the frontend reads custom_links now.
    expect(parsed.postgsail_logs_url).toBeUndefined();
  });

  it('leaves the key out entirely when there are none', () => {
    expect((yaml.load(renderVesselInfo(makeConfig(), IDENTITY)) as any).custom_links).toBeUndefined();
  });
});

describe('the vessel logo', () => {
  it('names it only when one is configured', () => {
    expect((yaml.load(renderVesselInfo(makeConfig(), IDENTITY)) as any).logo).toBeUndefined();
    const config = makeConfig({ site: { logo: 'data:image/svg+xml;base64,PHN2Zy8+' } });
    expect((yaml.load(renderVesselInfo(config, IDENTITY)) as any).logo).toBe(
      'data/vessel/logo.svg',
    );
  });

  it('does not repeat the site address, which the published HTML carries', () => {
    // A second copy nothing reads is a second copy to keep right.
    expect((yaml.load(renderVesselInfo(makeConfig(), IDENTITY)) as any).site_url)
      .toBeUndefined();
  });
});

describe('the default position', () => {
  it('writes default_location, which is where the site looks before a fix', () => {
    const config = makeConfig({
      site: { defaultLocation: { lat: 37.806, lon: -122.465, label: 'San Francisco Bay' } },
    });
    const parsed = yaml.load(renderVesselInfo(config, IDENTITY)) as any;
    expect(parsed.default_location).toEqual({
      lat: 37.806,
      lon: -122.465,
      label: 'San Francisco Bay',
    });
  });

  it('leaves it out when it is not set, so the frontend uses its own default', () => {
    const parsed = yaml.load(renderVesselInfo(makeConfig(), IDENTITY)) as any;
    expect(parsed.default_location).toBeUndefined();
  });
});

describe('readVesselDetails', () => {
  const TREE = {
    name: 'S.V.Mermug',
    mmsi: '338543654',
    uuid: 'urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d',
    flag: 'US',
    port: 'San Francisco',
    communication: { callsignVhf: 'WDL1234' },
    registrations: {
      imo: 'IMO 9074729',
      national: {
        usa: { country: 'US', registrationNumber: '1024168', description: 'USCG documentation' },
      },
      other: {
        hin: { registrationNumber: 'BEY57004E494', description: 'Hull identification number' },
      },
    },
    design: {
      length: { value: { overall: 12.8, hull: 12.5, waterline: 11.2 } },
      beam: { value: 3.99 },
      draft: { value: { maximum: 2.13, minimum: 1.9 } },
      airHeight: { value: 19.5 },
      displacement: { value: 8200 },
      keel: { value: { type: 'fin' } },
      aisShipType: { value: { id: 36, name: 'Sailing' } },
    },
  };

  it('reads the identity the server already holds, so nobody types it twice', () => {
    const details = readVesselDetails(TREE);
    expect(details.name).toBe('S.V.Mermug');
    expect(details.mmsi).toBe('338543654');
    expect(details.callsign).toBe('WDL1234');
    expect(details.flag).toBe('US');
    expect(details.homePort).toBe('San Francisco');
    expect(details.imo).toBe('IMO 9074729');
    expect(details.uuid).toContain('urn:mrn:signalk:uuid:');
  });

  it('finds the documentation and hull numbers among the registrations', () => {
    const details = readVesselDetails(TREE);
    expect(details.uscgNumber).toBe('1024168');
    expect(details.hullNumber).toBe('BEY57004E494');
    expect(details.registrations).toMatchObject({
      'national.usa': '1024168',
      'other.hin': 'BEY57004E494',
    });
  });

  it('reads the dimensions, rounded so a float does not commit every cycle', () => {
    const details = readVesselDetails({
      design: { draft: { value: { maximum: 2.1300000000000003 } }, beam: { value: 3.99 } },
    });
    expect(details.design).toEqual({ draft_max_m: 2.13, beam_m: 3.99 });
  });

  it('takes a plain value as readily as a { value } node', () => {
    const details = readVesselDetails({ name: 'Boat', communication: { callsignVhf: { value: 'WDL1' } } });
    expect(details.name).toBe('Boat');
    expect(details.callsign).toBe('WDL1');
  });

  it('ignores an MMSI that is not nine digits', () => {
    expect(readVesselDetails({ mmsi: '12345' }).mmsi).toBeUndefined();
  });

  it('returns nothing at all for a tree with nothing in it', () => {
    expect(readVesselDetails({})).toEqual({});
    expect(readVesselDetails(null as any)).toEqual({});
  });
});

describe('mergeVesselIdentity', () => {
  const BASE = { name: 'Vessel', mmsi: '338543654', signalk: { host: '192.168.8.50' } };

  it('lets the live tree win over what the server object said at start', () => {
    const merged = mergeVesselIdentity(BASE, { name: 'S.V.Mermug', callsign: 'WDL1234' });
    expect(merged.name).toBe('S.V.Mermug');
    expect(merged.callsign).toBe('WDL1234');
    expect(merged.signalk).toEqual({ host: '192.168.8.50' });
  });

  it('keeps the MMSI from the server ID when the tree does not repeat it', () => {
    expect(mergeVesselIdentity(BASE, { name: 'S.V.Mermug' }).mmsi).toBe('338543654');
  });

  it('falls back to "Vessel" rather than publishing a site with no name', () => {
    expect(mergeVesselIdentity({ name: '', mmsi: '' }, {}).name).toBe('Vessel');
  });
});

describe('what is read from Signal K versus typed on the config page', () => {
  const FROM_SIGNALK = {
    name: 'S.V.Mermug',
    mmsi: '338543654',
    callsign: 'WDL1234',
    uscgNumber: '1024168',
    hullNumber: 'BEY57004E494',
    design: { draft_max_m: 2.13 },
    registrations: { 'national.usa': '1024168' },
  };

  it('publishes everything the tree carried', () => {
    const parsed = yaml.load(renderVesselInfo(makeConfig(), FROM_SIGNALK)) as any;
    expect(parsed.callsign).toBe('WDL1234');
    expect(parsed.uscg_number).toBe('1024168');
    expect(parsed.hull_number).toBe('BEY57004E494');
    expect(parsed.design).toEqual({ draft_max_m: 2.13 });
    expect(parsed.registrations).toEqual({ 'national.usa': '1024168' });
  });

  it('takes the config page only when the override is ticked, and says so', () => {
    const problems: string[] = [];
    const config = makeConfig({ site: { overrideUscgNumber: true, uscgNumber: '9999999' } });
    const parsed = yaml.load(
      renderVesselInfo(config, FROM_SIGNALK, null, (problem) => problems.push(problem)),
    ) as any;
    expect(parsed.uscg_number).toBe('9999999');
    expect(problems.join(' ')).toContain('differs from the one Signal K reports');
  });

  it('ignores a number left in the box with the override unticked', () => {
    const problems: string[] = [];
    const config = makeConfig({ site: { uscgNumber: '9999999' } });
    const parsed = yaml.load(
      renderVesselInfo(config, FROM_SIGNALK, null, (problem) => problems.push(problem)),
    ) as any;
    expect(parsed.uscg_number).toBe('1024168');
    expect(problems).toEqual([]);
  });

  it('says nothing when the config page agrees with Signal K', () => {
    const problems: string[] = [];
    const config = makeConfig({ site: { overrideUscgNumber: true, uscgNumber: '1024168' } });
    renderVesselInfo(config, FROM_SIGNALK, null, (problem) => problems.push(problem));
    expect(problems).toEqual([]);
  });
});
