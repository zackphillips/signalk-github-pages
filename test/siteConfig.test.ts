import { describe, expect, it } from 'vitest';
import {
  mergeVesselIdentity,
  readVesselDetails,
  renderSiteConfig,
} from '../src/siteConfig';
import { makeConfig } from './helpers/config';

/** Parse what the plugin publishes, the way the frontend does. */
const render = (...args: Parameters<typeof renderSiteConfig>): any =>
  JSON.parse(renderSiteConfig(...args));

const CONFIG = makeConfig({
  privacyZones: [
    { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 },
  ],
  site: {
    postgsailLogsUrl: 'https://example.invalid/logs',
  },
});

const IDENTITY = {
  name: 'S.V.Mermug',
  mmsi: '338543654',
  signalk: { host: '192.168.8.50', port: 3000, protocol: 'http' },
  uscgNumber: '1024168',
  hullNumber: 'BEY57004E494',
};

describe('renderSiteConfig', () => {
  it('writes the site configuration the snapshot cannot supply', () => {
    const parsed = render(CONFIG, IDENTITY, null);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.signalk).toEqual({ host: '192.168.8.50', port: '3000', protocol: 'http' });
    expect(parsed.privacy_zones).toEqual([
      { name: 'South Beach Harbor', lat: 37.7802069, lon: -122.385804, radius_m: 200 },
    ]);
    expect(parsed.uscg_number).toBe('1024168');
    expect(parsed.hull_number).toBe('BEY57004E494');
  });

  it('leaves the boat to the snapshot, which already carries all of it', () => {
    // name, mmsi, callsign, uuid, imo, flag, home port, registrations and
    // design are every one of them in signalk_latest.json. A second copy here
    // was a second thing to keep right, and the frontend preferred the
    // snapshot anyway.
    const parsed = render(CONFIG, IDENTITY, null);
    for (const key of [
      'name',
      'mmsi',
      'callsign',
      'uuid',
      'imo',
      'flag',
      'home_port',
      'registrations',
      'design',
    ]) {
      expect(parsed[key]).toBeUndefined();
    }
  });

  it('writes the passage it is given, and nothing when there is none', () => {
    const withPassage = render(CONFIG, IDENTITY, {
      from: 'San Francisco, CA',
      to: 'Santa Cruz, CA',
      departed: '2026-02-20T16:00:00Z',
    });
    expect(withPassage.passage).toEqual({
      from: 'San Francisco, CA',
      to: 'Santa Cruz, CA',
      departed: '2026-02-20T16:00:00Z',
    });
    expect(render(CONFIG, IDENTITY, null).passage).toBeUndefined();
  });

  it('leaves out empty optional fields rather than writing blanks', () => {
    const parsed = render(makeConfig(), { name: 'Boat', mmsi: '' }, null);
    expect(parsed.uscg_number).toBeUndefined();
    expect(parsed.signalk).toBeUndefined();
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
    const parsed = render(config, IDENTITY, null);
    expect(parsed.custom_links).toEqual([
      { label: "Ship's Log", url: 'https://example.com/log' },
      { label: 'Starlink', url: 'http://192.168.100.1/' },
    ]);
    // The key it replaced is gone: the frontend reads custom_links now.
    expect(parsed.postgsail_logs_url).toBeUndefined();
  });

  it('leaves the key out entirely when there are none', () => {
    expect(render(makeConfig(), IDENTITY, null).custom_links).toBeUndefined();
  });
});

describe('the vessel logo', () => {
  it('names it only when one is configured', () => {
    expect(render(makeConfig(), IDENTITY, null).logo).toBeUndefined();
    const config = makeConfig({ site: { logo: 'data:image/svg+xml;base64,PHN2Zy8+' } });
    expect(render(config, IDENTITY, null).logo).toBe('data/vessel/logo.svg');
  });

  it('does not repeat the site address, which the published HTML carries', () => {
    // A second copy nothing reads is a second copy to keep right: the pages
    // get the address substituted in at publish time, for the crawlers that
    // never run them.
    expect(render(makeConfig(), IDENTITY, null).site_url).toBeUndefined();
  });
});

describe('the tide station override', () => {
  it('writes tide_station_override, which is what the site queries before a fix', () => {
    const config = makeConfig({ site: { tideStationOverride: '9414290' } });
    const parsed = render(config, IDENTITY, null);
    expect(parsed.tide_station_override).toBe('9414290');
  });

  it('leaves it out when it is not set, so the frontend waits for a fix', () => {
    const parsed = render(makeConfig(), IDENTITY, null);
    expect(parsed.tide_station_override).toBeUndefined();
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

  it('publishes the two numbers derived from the tree, and no more of it', () => {
    // The USCG and hull numbers are here because picking them out of a
    // `registrations` tree is a judgement, and the frontend should not make
    // it a second time. Everything else the tree carries — the callsign, the
    // dimensions, the registrations themselves — is in the snapshot already.
    const parsed = render(makeConfig(), FROM_SIGNALK, null);
    expect(parsed.uscg_number).toBe('1024168');
    expect(parsed.hull_number).toBe('BEY57004E494');
    expect(parsed.callsign).toBeUndefined();
    expect(parsed.design).toBeUndefined();
    expect(parsed.registrations).toBeUndefined();
  });

  it('publishes neither key when Signal K has no matching registration', () => {
    // There is no config-page override to fall back to any more: a boat with
    // no USCG documentation number or hull identification number in its
    // registrations simply does not publish one, rather than offering a
    // typed box that would have to be kept in sync by hand.
    const parsed = render(makeConfig(), { name: 'Boat', mmsi: '' }, null);
    expect(parsed.uscg_number).toBeUndefined();
    expect(parsed.hull_number).toBeUndefined();
  });
});
