import { describe, expect, it } from 'vitest';
import { passageFromCourse, readPassage } from '../src/course';
import type { CourseInfo } from '../src/signalk';

/** A course as the API reports it, with the fields under test overridden. */
const course = (over: Partial<CourseInfo> = {}): CourseInfo => ({
  startTime: '2026-03-01T16:00:00Z',
  targetArrivalTime: '2026-03-01T22:30:00Z',
  arrivalCircle: 100,
  activeRoute: null,
  nextPoint: null,
  previousPoint: null,
  ...over,
});

const point = (name?: string) =>
  ({
    type: 'Location' as never,
    position: { latitude: 36.96, longitude: -122.02 },
    ...(name ? { name } : {}),
  }) as CourseInfo['nextPoint'];

describe('passageFromCourse', () => {
  it('is nothing at all when the boat is not navigating to anything', () => {
    expect(passageFromCourse(course())).toBeNull();
    expect(passageFromCourse(null)).toBeNull();
    expect(passageFromCourse(undefined)).toBeNull();
  });

  it('takes the destination and the departure time from an active waypoint', () => {
    const passage = passageFromCourse(
      course({ nextPoint: point('Santa Cruz'), previousPoint: point('San Francisco') }),
    );
    expect(passage).toEqual({
      to: 'Santa Cruz',
      from: 'San Francisco',
      departed: '2026-03-01T16:00:00Z',
    });
  });

  it('falls back to the route name, and reports the route alongside it', () => {
    const passage = passageFromCourse(
      course({
        activeRoute: {
          href: '/resources/routes/abc',
          name: 'Farallones',
          pointIndex: 2,
          pointTotal: 7,
          reverse: false,
        },
      }),
    );
    expect(passage).toEqual({
      to: 'Farallones',
      route: 'Farallones',
      departed: '2026-03-01T16:00:00Z',
    });
  });

  it('never publishes a position, even when that leaves the passage empty', () => {
    // previousPoint is the vessel's own position at activation, with no name.
    // Falling back to its coordinates would put the slip the boat left on a
    // public website, through a path the privacy zones do not guard.
    const passage = passageFromCourse(
      course({ nextPoint: point('Drakes Bay'), previousPoint: point() }),
    );
    expect(passage).toEqual({ to: 'Drakes Bay', departed: '2026-03-01T16:00:00Z' });
    expect(JSON.stringify(passage)).not.toContain('122.02');
  });

  it('never publishes the ETA, which would rewrite the file every cycle', () => {
    const passage = passageFromCourse(course({ nextPoint: point('Half Moon Bay') }));
    expect(JSON.stringify(passage)).not.toContain('22:30');
  });

  it('does not report a departure time on its own', () => {
    // "departed 09:14" with no from and no to is not a banner worth drawing.
    expect(passageFromCourse(course({ startTime: '2026-03-01T09:14:00Z' }))).toBeNull();
  });

  it('ignores blank names rather than publishing empty fields', () => {
    expect(passageFromCourse(course({ nextPoint: point('   ') }))).toBeNull();
  });

  it('keeps the destination when there is no start time', () => {
    const passage = passageFromCourse(
      course({ startTime: null, nextPoint: point('Bodega Bay') }),
    );
    expect(passage).toEqual({ to: 'Bodega Bay' });
  });
});

describe('readPassage', () => {
  it('is null on a server with no Course API, without complaining', () => {
    const problems: string[] = [];
    return readPassage({}, (problem) => problems.push(problem)).then((passage) => {
      expect(passage).toBeNull();
      expect(problems).toEqual([]);
    });
  });

  it('reports a rejection and publishes no banner, rather than failing a cycle', async () => {
    const problems: string[] = [];
    const passage = await readPassage(
      { getCourse: () => Promise.reject(new Error('course api is off')) },
      (problem) => problems.push(problem),
    );
    expect(passage).toBeNull();
    expect(problems.join(' ')).toContain('course api is off');
  });

  it('maps what the server returns', async () => {
    const passage = await readPassage({
      getCourse: () => Promise.resolve(course({ nextPoint: point('Monterey') })),
    });
    expect(passage?.to).toBe('Monterey');
  });
});
