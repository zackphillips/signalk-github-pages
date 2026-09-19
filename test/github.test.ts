import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, publishFiles } from '../src/github';
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
