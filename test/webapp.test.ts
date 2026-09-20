import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pagesUrl, parsePruneRequest, resolveSitePath } from '../src/webapp';

const SITE = path.join(__dirname, '..', 'site');

describe('parsePruneRequest', () => {
  it('reads a day count and the explicit "all"', () => {
    expect(parsePruneRequest('30')).toEqual({ olderThanDays: 30 });
    expect(parsePruneRequest('1')).toEqual({ olderThanDays: 1 });
    expect(parsePruneRequest('all')).toEqual({ olderThanDays: null });
  });

  it('refuses anything else rather than defaulting', () => {
    // Defaulting a typo to "all" would make a mistyped URL the most
    // destructive thing this plugin can do.
    for (const bad of ['', undefined, 'ALL', 'everything', '0', '-5', 'NaN', '7; drop']) {
      expect(() => parsePruneRequest(bad), String(bad)).toThrow(/number of days/);
    }
  });

  it('takes the whole days of a fractional request', () => {
    expect(parsePruneRequest('7.9')).toEqual({ olderThanDays: 7 });
  });
});

describe('resolveSitePath', () => {
  it('serves the index for the directory itself', () => {
    expect(resolveSitePath(SITE, '')).toBe(path.join(SITE, 'index.html'));
    expect(resolveSitePath(SITE, '/')).toBe(path.join(SITE, 'index.html'));
  });

  it('resolves a file inside the site', () => {
    expect(resolveSitePath(SITE, 'assets/app.js')).toBe(path.join(SITE, 'assets', 'app.js'));
  });

  it('refuses to climb out, however it is spelled', () => {
    // This runs inside the navigation server's process: a traversal here
    // reads anything that process can read, ~/.signalk/settings.json included.
    for (const attempt of [
      '../package.json',
      'assets/../../package.json',
      '..%2Fpackage.json',
      '/../../etc/passwd',
      'assets/%2e%2e/%2e%2e/package.json',
    ]) {
      expect(resolveSitePath(SITE, attempt), attempt).toBeNull();
    }
  });

  it('drops the query string before resolving', () => {
    expect(resolveSitePath(SITE, 'assets/app.js?t=123')).toBe(
      path.join(SITE, 'assets', 'app.js'),
    );
  });
});

describe('pagesUrl', () => {
  it('knows a user site from a project site', () => {
    expect(pagesUrl('zackphillips', 'zackphillips.github.io')).toBe(
      'https://zackphillips.github.io/',
    );
    expect(pagesUrl('zackphillips', 'tracker')).toBe('https://zackphillips.github.io/tracker/');
  });

  it('lowercases the host, which GitHub Pages serves in lower case', () => {
    expect(pagesUrl('ZackPhillips', 'Tracker')).toBe('https://zackphillips.github.io/Tracker/');
  });
});
