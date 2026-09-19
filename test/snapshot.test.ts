import { describe, expect, it } from 'vitest';
import {
  extractPositionFix,
  filterStaleData,
  isUnderway,
  navigationState,
  readSelfTree,
  redactPosition,
} from '../src/snapshot';

const NOW = new Date('2026-03-01T12:00:00Z');

describe('filterStaleData', () => {
  it('strips value and timestamp from readings older than the cutoff', () => {
    const blob = {
      environment: {
        wind: {
          speedApparent: {
            value: 5,
            timestamp: '2026-03-01T09:00:00Z',
            meta: { units: 'm/s' },
          },
        },
      },
    };
    const filtered = filterStaleData(blob, { maxAgeMinutes: 60, referenceTime: NOW });
    const node = (filtered as any).environment.wind.speedApparent;
    expect(node.value).toBeUndefined();
    expect(node.timestamp).toBeUndefined();
    expect(node.meta).toEqual({ units: 'm/s' });
  });

  it('keeps readings inside the window', () => {
    const blob = {
      navigation: {
        speedOverGround: { value: 3.2, timestamp: '2026-03-01T11:45:00Z' },
      },
    };
    const filtered = filterStaleData(blob, { maxAgeMinutes: 60, referenceTime: NOW });
    expect((filtered as any).navigation.speedOverGround.value).toBe(3.2);
  });

  it('removes a section left with nothing at all', () => {
    const blob = {
      entertainment: { device: { track: { value: 'x', timestamp: '2026-02-01T00:00:00Z' } } },
    };
    expect(filterStaleData(blob, { maxAgeMinutes: 60, referenceTime: NOW })).toEqual({});
  });

  it('leaves untargeted sections alone', () => {
    const blob = {
      electrical: { batteries: { house: { voltage: { value: 12.6, timestamp: '2020-01-01T00:00:00Z' } } } },
    };
    const filtered = filterStaleData(blob, { maxAgeMinutes: 60, referenceTime: NOW });
    expect((filtered as any).electrical.batteries.house.voltage.value).toBe(12.6);
  });
});

describe('extractPositionFix', () => {
  it('reads position, speed and heading', () => {
    const fix = extractPositionFix({
      navigation: {
        position: { value: { latitude: 37.8, longitude: -122.4 }, timestamp: '2026-03-01T11:59:00Z' },
        speedOverGround: { value: 4.1 },
        headingTrue: { value: 1.57 },
      },
    });
    expect(fix).toEqual({
      latitude: 37.8,
      longitude: -122.4,
      timestamp: '2026-03-01T11:59:00Z',
      speedOverGround: 4.1,
      courseOverGroundTrue: 1.57,
    });
  });

  it('returns null without a position', () => {
    expect(extractPositionFix({ navigation: {} })).toBeNull();
    expect(extractPositionFix({})).toBeNull();
  });
});

describe('redactPosition', () => {
  const zones = [{ name: 'Home', lat: 37.7802069, lon: -122.385804, radius_m: 200 }];

  it('replaces the position with the zone centre', () => {
    const blob = {
      navigation: { position: { value: { latitude: 37.78025, longitude: -122.38585 } } },
    };
    const zone = redactPosition(blob, zones);
    expect(zone?.name).toBe('Home');
    expect(blob.navigation.position.value).toEqual({
      latitude: 37.7802069,
      longitude: -122.385804,
    });
  });

  it('leaves a position outside every zone untouched', () => {
    const blob = {
      navigation: { position: { value: { latitude: 36.9, longitude: -122.0 } } },
    };
    expect(redactPosition(blob, zones)).toBeNull();
    expect(blob.navigation.position.value.latitude).toBe(36.9);
  });
});

describe('navigation state', () => {
  it('reads and lowercases the state', () => {
    expect(navigationState({ navigation: { state: { value: 'Sailing' } } })).toBe('sailing');
    expect(navigationState({})).toBeNull();
  });

  it('treats sailing and motoring as underway, moored and anchored as not', () => {
    expect(isUnderway('sailing')).toBe(true);
    expect(isUnderway('motoring')).toBe(true);
    expect(isUnderway('moored')).toBe(false);
    expect(isUnderway('anchored')).toBe(false);
    expect(isUnderway(null)).toBe(false);
  });
});

describe('readSelfTree', () => {
  it('falls back through the accessors the server versions offer', () => {
    const tree = { navigation: { position: { value: { latitude: 1, longitude: 2 } } } };
    expect(readSelfTree({ getSelfPath: () => tree })).toEqual(tree);
    expect(readSelfTree({ getPath: (p) => (p === 'vessels.self' ? tree : undefined) })).toEqual(tree);
    expect(
      readSelfTree({
        selfId: 'urn:mrn:signalk:uuid:abc',
        signalk: { retrieve: () => ({ vessels: { 'urn:mrn:signalk:uuid:abc': tree } }) },
      }),
    ).toEqual(tree);
    expect(readSelfTree({})).toEqual({});
  });

  it("returns a copy, so a cycle cannot mutate the server's own tree", () => {
    const tree = { navigation: { position: { value: { latitude: 1, longitude: 2 } } } };
    const copy = readSelfTree({ getSelfPath: () => tree });
    (copy as any).navigation.position.value.latitude = 99;
    expect(tree.navigation.position.value.latitude).toBe(1);
  });
});
