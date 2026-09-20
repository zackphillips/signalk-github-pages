import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_LOG_SCHEMA_VERSION,
  pathMatches,
  renderInstrumentLog,
} from '../src/instrumentLog';

describe('pathMatches', () => {
  it('matches a literal path', () => {
    expect(pathMatches('navigation.speedOverGround', 'navigation.speedOverGround')).toBe(true);
    expect(pathMatches('navigation.speedOverGround', 'navigation.speedThroughWater')).toBe(false);
  });

  it('treats * as exactly one segment', () => {
    expect(pathMatches('electrical.batteries.*.voltage', 'electrical.batteries.house.voltage')).toBe(true);
    expect(pathMatches('electrical.batteries.*.voltage', 'electrical.batteries.house.a.voltage')).toBe(false);
  });
});

describe('renderInstrumentLog', () => {
  it('carries the schema version the frontend checks', () => {
    const log = JSON.parse(renderInstrumentLog([]));
    expect(log).toEqual({ schema_version: INSTRUMENT_LOG_SCHEMA_VERSION, entries: [] });
  });

  it('writes the entries unindented, oldest first, one line', () => {
    const rendered = renderInstrumentLog([
      { timestamp: '2026-03-01T19:58:00.000Z', values: { 'navigation.speedOverGround': 4.2 } },
      { timestamp: '2026-03-01T19:59:00.000Z', values: { 'navigation.speedOverGround': 4.4 } },
    ]);
    expect(rendered.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(rendered).entries.map((entry: any) => entry.timestamp)).toEqual([
      '2026-03-01T19:58:00.000Z',
      '2026-03-01T19:59:00.000Z',
    ]);
  });
});
