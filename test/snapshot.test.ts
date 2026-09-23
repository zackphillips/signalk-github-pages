import { describe, expect, it } from 'vitest';
import {
  extractPositionFix,
  filterStaleData,
  hidePaths,
  isUnderway,
  navigationState,
  readSelfTree,
  redactPositions,
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

describe('redactPositions', () => {
  const zones = [{ name: 'Home', lat: 37.7802069, lon: -122.385804, radius_m: 200 }];
  const center = { latitude: 37.7802069, longitude: -122.385804 };

  it('replaces the vessel position with the zone center', () => {
    const blob = {
      navigation: { position: { value: { latitude: 37.78025, longitude: -122.38585 } } },
    };
    const { vesselZone } = redactPositions(blob, zones);
    expect(vesselZone?.name).toBe('Home');
    expect(blob.navigation.position.value).toEqual(center);
  });

  it('replaces the anchor position too, which used to be published in full', () => {
    // The bug: the site showed the zone center for the boat while publishing
    // the true anchor drop coordinates a few keys away in the same file, and
    // the frontend reads navigation.anchor.position to draw the marker.
    const blob = {
      navigation: {
        position: { value: { latitude: 37.78025, longitude: -122.38585 } },
        anchor: {
          position: { value: { latitude: 37.780123, longitude: -122.385999 } },
          maxRadius: { value: 40 },
        },
      },
    };
    const { redacted } = redactPositions(blob, zones);
    expect(blob.navigation.anchor.position.value).toEqual(center);
    expect(redacted).toContain('navigation.anchor.position.value');
  });

  it('redacts a position wherever it sits, including one a plugin invented', () => {
    // An allowlist of known paths needs extending every time the spec or a
    // plugin grows another one. This walks the tree instead.
    const blob = {
      navigation: { position: { value: { latitude: 37.78025, longitude: -122.38585 } } },
      somePlugin: { lastSeen: { value: { latitude: 37.78021, longitude: -122.38581 } } },
      notifications: {
        mob: { value: { state: 'emergency', position: { latitude: 37.7802, longitude: -122.3858 } } },
      },
    };
    redactPositions(blob, zones);
    expect(blob.somePlugin.lastSeen.value).toEqual(center);
    expect(blob.notifications.mob.value.position).toEqual(center);
  });

  it('leaves a position outside every zone untouched', () => {
    const blob = {
      navigation: { position: { value: { latitude: 36.9, longitude: -122.0 } } },
    };
    const { vesselZone, redacted } = redactPositions(blob, zones);
    expect(vesselZone).toBeNull();
    expect(redacted).toEqual([]);
    expect(blob.navigation.position.value.latitude).toBe(36.9);
  });

  it('does not touch a destination just because the boat is home', () => {
    // Where the boat is going is not where the boat is. Snapping the
    // destination to the home dock would corrupt the data and protect
    // nothing.
    const blob = {
      navigation: {
        position: { value: { latitude: 37.78025, longitude: -122.38585 } },
        course: { nextPoint: { position: { value: { latitude: 36.96, longitude: -122.02 } } } },
      },
    };
    redactPositions(blob, zones);
    expect(blob.navigation.course.nextPoint.position.value).toEqual({
      latitude: 36.96,
      longitude: -122.02,
    });
  });

  it('redacts an anchor position left over from a zone the boat has since left', () => {
    // The rule is per-position, not per-vessel: the boat is out sailing but
    // navigation.anchor.position still names the slip it left this morning.
    const blob = {
      navigation: {
        position: { value: { latitude: 36.9, longitude: -122.0 } },
        anchor: { position: { value: { latitude: 37.78021, longitude: -122.38581 } } },
      },
    };
    const { vesselZone } = redactPositions(blob, zones);
    expect(vesselZone).toBeNull();
    expect(blob.navigation.anchor.position.value).toEqual(center);
  });

  it('does nothing at all when no zones are configured', () => {
    const blob = {
      navigation: { position: { value: { latitude: 37.78025, longitude: -122.38585 } } },
    };
    expect(redactPositions(blob, [])).toEqual({ vesselZone: null, redacted: [] });
    expect(blob.navigation.position.value.latitude).toBe(37.78025);
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

describe('hidePaths', () => {
  const blob = () => ({
    name: 'Boat',
    electrical: {
      batteries: {
        house: { voltage: { value: 12.7, meta: { units: 'V' } } },
        start: { voltage: { value: 12.9 } },
      },
    },
    environment: { rpi: { cpu: { temperature: { value: 320 } } }, wind: { speedTrue: { value: 5 } } },
  });

  it('removes a subtree, a wildcard match and an exact path', () => {
    const tree: any = blob();
    const removed = hidePaths(tree, ['environment.rpi', 'electrical.batteries.*.voltage']);
    expect(removed.sort()).toEqual([
      'electrical.batteries.house.voltage',
      'electrical.batteries.start.voltage',
      'environment.rpi',
    ]);
    expect(tree.environment.rpi).toBeUndefined();
    expect(tree.environment.wind.speedTrue.value).toBe(5);
    expect(tree.electrical.batteries.house).toEqual({});
    expect(tree.name).toBe('Boat');
  });

  it('leaves the tree alone with nothing hidden', () => {
    const tree = blob();
    expect(hidePaths(tree, [])).toEqual([]);
    expect(tree).toEqual(blob());
  });
});
