import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, publishFiles, tokenHint } from '../src/github';
import { FakeGitHub } from './helpers/fakeGitHub';

const makeClient = (fake: FakeGitHub) =>
  new GitHubClient({
    repo: 'owner/site',
    branch: 'main',
    token: 'token',
    fetchImpl: fake.fetch,
  });

describe('publishFiles', () => {
  it('writes every file in one commit on top of the current HEAD', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main', files: { 'README.md': '# Site\n' } });
    const result = await publishFiles(
      makeClient(fake),
      [
        { path: 'data/telemetry/signalk_latest.json', content: '{}\n' },
        { path: 'index.html', content: '<html></html>' },
      ],
      'Telemetry 2026-03-01 12:00:00Z',
    );
    expect(result?.files).toBe(2);
    expect(fake.files.get('index.html')).toBe('<html></html>');
    // The commit is layered on the live HEAD, so nothing else is disturbed.
    expect(fake.files.get('README.md')).toBe('# Site\n');
  });

  it('does nothing when there is nothing to publish', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main' });
    expect(await publishFiles(makeClient(fake), [], 'empty')).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it('deletes paths in the same commit as the writes', async () => {
    const fake = new FakeGitHub({
      repo: 'owner/site',
      branch: 'main',
      files: {
        'data/telemetry/tracks/2026-01-02.gpx': '<gpx/>',
        'data/telemetry/tracks/2026-03-01.gpx': '<gpx/>',
        'docs/notes.md': '# Notes',
      },
    });
    const before = fake.commits.length;
    const result = await publishFiles(
      makeClient(fake),
      [{ path: 'data/telemetry/tracks_index.json', content: '{}\n' }],
      'Remove 1 voyage (2026-01-02)',
      { deletions: ['data/telemetry/tracks/2026-01-02.gpx'] },
    );
    expect(result?.files).toBe(2);
    expect(fake.commits.length).toBe(before + 1);
    expect(fake.files.has('data/telemetry/tracks/2026-01-02.gpx')).toBe(false);
    expect(fake.files.get('data/telemetry/tracks/2026-03-01.gpx')).toBe('<gpx/>');
    expect(fake.files.get('docs/notes.md')).toBe('# Notes');
  });

  it('sends a deletion as a complete entry with a null sha', async () => {
    // The API wants mode and type on every entry; the null sha is the only
    // thing that makes it a deletion rather than a write.
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main', files: { 'a.gpx': 'x' } });
    let tree: any;
    const client = new GitHubClient({
      repo: 'owner/site',
      branch: 'main',
      token: 'token',
      fetchImpl: (async (input: any, init: any) => {
        if (String(input).endsWith('/git/trees') && init?.method === 'POST') {
          tree = JSON.parse(init.body).tree;
        }
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    await publishFiles(client, [], 'Remove', { deletions: ['a.gpx'] });
    expect(tree).toEqual([{ path: 'a.gpx', mode: '100644', type: 'blob', sha: null }]);
  });

  it('commits a deletion even with no file to write', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main', files: { 'a.gpx': 'x' } });
    const result = await publishFiles(makeClient(fake), [], 'Remove', { deletions: ['a.gpx'] });
    expect(result?.files).toBe(1);
    expect(fake.files.has('a.gpx')).toBe(false);
  });

  it('re-reads HEAD and retries once when the ref update loses a race', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main', failRefUpdates: 1 });
    const result = await publishFiles(
      makeClient(fake),
      [{ path: 'data/telemetry/signalk_latest.json', content: '{}\n' }],
      'Telemetry',
    );
    expect(result?.retried).toBe(true);
    expect(fake.files.has('data/telemetry/signalk_latest.json')).toBe(true);
  });

  it('gives up after the second failure rather than forcing the ref', async () => {
    // Forcing would discard whatever landed in between — a docs edit made
    // from a phone, most likely.
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main', failRefUpdates: 2 });
    await expect(
      publishFiles(makeClient(fake), [{ path: 'index.html', content: 'x' }], 'Telemetry'),
    ).rejects.toBeInstanceOf(GitHubError);
  });

  it('preserves a concurrent edit to a file the plugin does not write', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main', files: { 'docs/mob.md': 'v1' } });
    const client = makeClient(fake);
    fake.commitFile('docs/mob.md', 'v2 edited on a phone');
    await publishFiles(client, [{ path: 'data/telemetry/signalk_latest.json', content: '{}' }], 'Telemetry');
    expect(fake.files.get('docs/mob.md')).toBe('v2 edited on a phone');
  });
});

describe('GitHubClient', () => {
  it('returns null for a file that does not exist', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main' });
    expect(await makeClient(fake).getFile('data/vessel/info.yaml')).toBeNull();
  });

  it('reads a published file back as text', async () => {
    const fake = new FakeGitHub({
      repo: 'owner/site',
      branch: 'main',
      files: { 'data/vessel/info.yaml': 'name: Mermug\n' },
    });
    expect(await makeClient(fake).getFile('data/vessel/info.yaml')).toBe('name: Mermug\n');
  });

  it('spends nothing on an unchanged tree listing', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main', files: { 'docs/a.md': '# A' } });
    const client = makeClient(fake);
    const first = await client.listTree();
    expect(first.changed).toBe(true);
    const second = await client.listTree(first.etag);
    expect(second.changed).toBe(false);
  });

  it('reports a listing as changed once a document is edited', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main', files: { 'docs/a.md': '# A' } });
    const client = makeClient(fake);
    const first = await client.listTree();
    fake.commitFile('docs/a.md', '# A renamed');
    expect((await client.listTree(first.etag)).changed).toBe(true);
  });
});

describe('tokenHint', () => {
  it('names the permission people actually miss on a 403', () => {
    // A token with only Metadata reads the repository fine and fails on the
    // first commit, which looks nothing like a permissions problem in a log.
    expect(tokenHint(403, 'owner/site')).toContain('Contents: Read and write');
  });

  it('separates a rejected token from a repository the token cannot see', () => {
    expect(tokenHint(401, 'owner/site')).toContain('expiry');
    expect(tokenHint(404, 'owner/site')).toContain('owner/site is not visible');
  });

  it('points a sign-in that cannot see the repository at installing the app', () => {
    const url = 'https://github.com/apps/signalk-github-pages/installations/new';
    expect(tokenHint(404, 'owner/site', 'app', url)).toContain(`not installed on it (${url})`);
    expect(tokenHint(404, 'owner/site', 'app', url)).toContain('can create it');
    expect(tokenHint(401, 'owner/site', 'app')).toContain('Sign in again');
    // Nobody made a token, so there is no permission box to go back and tick.
    expect(tokenHint(403, 'owner/site', 'app')).not.toContain('fine-grained');
  });

  it('asks for a fresh token on every request, so a refresh lands mid-cycle', async () => {
    const fake = new FakeGitHub({ repo: 'owner/site', branch: 'main' });
    const seen: string[] = [];
    let n = 0;
    const client = new GitHubClient({
      repo: 'owner/site',
      branch: 'main',
      token: async () => `t${++n}`,
      fetchImpl: (async (input: any, init: any) => {
        seen.push(init.headers.Authorization);
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    await client.getRef();
    await client.getRef();
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('does not retry a 401 for a personal access token', async () => {
    let calls = 0;
    const client = new GitHubClient({
      repo: 'owner/site',
      branch: 'main',
      token: 'ghp_revoked',
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{"message":"Bad credentials"}', { status: 401 });
      }) as unknown as typeof fetch,
    });
    await expect(client.getRef()).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('says nothing about the token for a failure that is not about it', () => {
    expect(tokenHint(502, 'owner/site')).toBe('');
    expect(tokenHint(undefined, 'owner/site')).toBe('');
  });
});
