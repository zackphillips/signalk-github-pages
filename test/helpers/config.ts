/**
 * A complete plugin config for tests.
 *
 * Nothing numeric has a default in the real schema, so every test that needs
 * a config has to say what it wants. This helper states one boat's worth of
 * settings once; tests override the parts they are actually about.
 */
import { resolveConfig, type PluginConfig } from '../../src/config';

export const COMPLETE_FORM = {
  github: { owner: 'owner', name: 'site', branch: 'main', token: 'ghp_token' },
  interval: { underway: 120, stationary: 3600 },
  instrumentLog: {
    paths: 'navigation.speedOverGround\nelectrical.batteries.*.voltage\n',
    entries: 120,
  },
  positionRetentionHours: 24,
  staleMaxAgeMinutes: 60,
  timezone: 'America/Los_Angeles',
  privacyZones: [],
};

export function makeConfig(overrides: Record<string, any> = {}): PluginConfig {
  const resolved = resolveConfig({ ...COMPLETE_FORM, ...overrides });
  if (!resolved.ok) throw new Error(`Test config is incomplete: ${resolved.problems.join(' ')}`);
  return resolved.config;
}
