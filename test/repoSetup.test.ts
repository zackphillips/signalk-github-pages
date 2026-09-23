import { describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/github';
import { checkRepository, createByHandUrl, setUpRepository, type RepoTarget } from '../src/repoSetup';

/**
 * GitHub as a handful of facts that the requests change: whether the
 * repository exists, whether the app can see it, its branches, Pages. Enough
 * to walk every path through the setup without a network.
 */
class FakeRepoGitHub {
  exists = false;
  /** Whether the signed-in token can see it: false is "app not installed". */
  visible = true;
  isPrivate = false;
  branches = new Map<string, string>();
  defaultBranch = 'main';
  pages = false;
  accountType = 'User';
  /** Status to answer a create with, instead of creating. */
  refuseCreate: number | null = null;
  refusePages: number | null = null;
  requests: string[] = [];

  constructor(readonly repo = 'zack/zack.github.io') {}

  fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const anonymous = !init.headers?.Authorization;
    this.requests.push(`${method} ${path}${anonymous ? ' (anonymous)' : ''}`);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (status: number, payload: unknown = {}) =>
      new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    const prefix = `/repos/${this.repo}`;
    const seen = this.exists && (anonymous ? !this.isPrivate : this.visible);

    if (method === 'POST' && (path === '/user/repos' || path.startsWith('/orgs/'))) {
      if (this.refuseCreate) return json(this.refuseCreate, { message: 'nope' });
      if (this.exists) return json(422, { message: 'name already exists on this account' });
      this.exists = true;
      this.visible = true;
      if (body.auto_init) this.branches.set(this.defaultBranch, 'c1');
      return json(201, { default_branch: this.defaultBranch });
    }
    if (method === 'GET' && path.startsWith('/users/')) return json(200, { type: this.accountType });
    if (!path.startsWith(prefix)) return json(404, { message: 'Not Found' });
    if (!seen) return json(404, { message: 'Not Found' });

    const rest = path.slice(prefix.length);
    if (method === 'GET' && rest === '') return json(200, { default_branch: this.defaultBranch });
    if (method === 'GET' && rest.startsWith('/git/ref/heads/')) {
      if (this.branches.size === 0) return json(409, { message: 'Git Repository is empty.' });
      const sha = this.branches.get(decodeURIComponent(rest.slice('/git/ref/heads/'.length)));
      return sha ? json(200, { object: { sha } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && rest === '/git/refs') {
      this.branches.set(body.ref.replace('refs/heads/', ''), body.sha);
      return json(201, {});
    }
    if (method === 'PUT' && rest.startsWith('/contents/')) {
      this.branches.set(this.defaultBranch, 'c-init');
      return json(201, {});
    }
    if (method === 'GET' && rest === '/pages') {
      return this.pages ? json(200, { html_url: 'https://zack.github.io/' }) : json(404, {});
    }
    if (method === 'POST' && rest === '/pages') {
      if (this.refusePages) return json(this.refusePages, { message: 'nope' });
      this.pages = true;
      return json(201, {});
    }
    return json(404, { message: 'Not Found' });
  }) as unknown as typeof fetch;
}

const target = (over: Partial<RepoTarget> = {}): RepoTarget => ({
  owner: 'zack',
  name: 'zack.github.io',
  repo: 'zack/zack.github.io',
  branch: 'main',
  auth: 'app',
  installUrl: 'https://github.com/apps/signalk-github-pages/installations/new',
  login: 'zack',
  ...over,
});

const clientFor = (fake: FakeRepoGitHub, branch = 'main') =>
  new GitHubClient({ repo: fake.repo, branch, token: 'ghu_x', fetchImpl: fake.fetch });

describe('checkRepository', () => {
  it('calls a repository nobody can see missing, and offers to create it', async () => {
    const fake = new FakeRepoGitHub();
    const check = await checkRepository(clientFor(fake), target());
    expect(check).toMatchObject({ ok: false, repository: 'missing', canSetUp: true });
    expect(check.detail).toContain('does not exist yet');
    // The by-hand route is there too, for an app without Administration.
    expect(check.links.create).toBe(createByHandUrl(target()));
  });

  it('tells "not installed" from "missing" by asking without credentials', async () => {
    const fake = new FakeRepoGitHub();
    fake.exists = true;
    fake.visible = false;
    fake.branches.set('main', 'c1');
    const check = await checkRepository(clientFor(fake), target());
    expect(check).toMatchObject({ repository: 'not-installed', canSetUp: false });
    expect(check.links.install).toContain('/installations/new');
    expect(fake.requests).toContain('GET /repos/zack/zack.github.io (anonymous)');
  });

  it('knows an empty repository from a missing one', async () => {
    const fake = new FakeRepoGitHub();
    fake.exists = true;
    const check = await checkRepository(clientFor(fake), target());
    expect(check).toMatchObject({ repository: 'empty', canSetUp: true });
  });

  it('finds a branch missing from a repository whose default is another', async () => {
    const fake = new FakeRepoGitHub();
    fake.exists = true;
    fake.defaultBranch = 'master';
    fake.branches.set('master', 'c1');
    const check = await checkRepository(clientFor(fake), target());
    expect(check).toMatchObject({ repository: 'no-branch', canSetUp: true });
    expect(check.detail).toContain('its default is master');
  });

  it('is ready when the branch is there and Pages is on, and says Pages is off when it is not', async () => {
    const fake = new FakeRepoGitHub();
    fake.exists = true;
    fake.branches.set('main', 'c1');
    expect(await checkRepository(clientFor(fake), target())).toMatchObject({
      ok: false,
      repository: 'ok',
      pages: 'off',
      canSetUp: true,
    });
    fake.pages = true;
    expect(await checkRepository(clientFor(fake), target())).toMatchObject({
      ok: true,
      pages: 'on',
      canSetUp: false,
    });
  });
});

describe('setUpRepository', () => {
  it('creates a missing repository, public with a README, and turns Pages on', async () => {
    const fake = new FakeRepoGitHub();
    const logs: string[] = [];
    const check = await setUpRepository(clientFor(fake), target(), (m) => logs.push(m));
    expect(check).toMatchObject({ ok: true, repository: 'ok', pages: 'on' });
    expect(fake.requests).toContain('POST /user/repos');
    expect(logs).toEqual(['Created zack/zack.github.io.', 'Turned GitHub Pages on for zack/zack.github.io.']);
  });

  it('creates in the organization when the owner is one', async () => {
    const fake = new FakeRepoGitHub('crew/tracker');
    fake.accountType = 'Organization';
    await setUpRepository(
      clientFor(fake),
      target({ owner: 'crew', name: 'tracker', repo: 'crew/tracker' }),
    );
    expect(fake.requests).toContain('POST /orgs/crew/repos');
  });

  it('will not try to create a repository in somebody else\'s account', async () => {
    const fake = new FakeRepoGitHub('someone/someone.github.io');
    await expect(
      setUpRepository(
        clientFor(fake),
        target({ owner: 'someone', name: 'someone.github.io', repo: 'someone/someone.github.io' }),
      ),
    ).rejects.toThrow(/another person's account/);
    expect(fake.requests.some((r) => r.startsWith('POST'))).toBe(false);
  });

  it('starts the configured branch when the account defaults to another', async () => {
    const fake = new FakeRepoGitHub();
    fake.defaultBranch = 'master';
    const check = await setUpRepository(clientFor(fake), target());
    expect(check.repository).toBe('ok');
    expect(fake.branches.get('main')).toBe('c1');
  });

  it('gives an empty repository its first commit, and touches nothing that has one', async () => {
    const fake = new FakeRepoGitHub();
    fake.exists = true;
    await setUpRepository(clientFor(fake), target());
    expect(fake.requests).toContain('PUT /repos/zack/zack.github.io/contents/README.md');

    const full = new FakeRepoGitHub();
    full.exists = true;
    full.branches.set('main', 'c1');
    full.pages = true;
    await setUpRepository(clientFor(full), target());
    expect(full.requests.some((r) => !r.startsWith('GET'))).toBe(false);
  });

  it('hands back the by-hand link when the app may not create repositories', async () => {
    const fake = new FakeRepoGitHub();
    fake.refuseCreate = 403;
    await expect(setUpRepository(clientFor(fake), target())).rejects.toMatchObject({
      message: expect.stringContaining('Create it by hand'),
      links: { create: createByHandUrl(target()) },
    });
  });

  it('hands back the Pages settings when the app may not turn Pages on', async () => {
    const fake = new FakeRepoGitHub();
    fake.exists = true;
    fake.branches.set('main', 'c1');
    fake.refusePages = 403;
    await expect(setUpRepository(clientFor(fake), target())).rejects.toMatchObject({
      message: expect.stringContaining('Turn it on by hand'),
      links: { pagesSettings: 'https://github.com/zack/zack.github.io/settings/pages' },
    });
  });

  it('says to install the app on a repository it cannot see, rather than creating a second', async () => {
    const fake = new FakeRepoGitHub();
    fake.exists = true;
    fake.visible = false;
    fake.branches.set('main', 'c1');
    await expect(setUpRepository(clientFor(fake), target())).rejects.toMatchObject({
      links: { install: target().installUrl },
    });
    expect(fake.requests.some((r) => r.startsWith('POST'))).toBe(false);
  });

  it('says so when a repository it could not see turns out to exist', async () => {
    // Private, so the anonymous look cannot see it either.
    const fake = new FakeRepoGitHub();
    fake.exists = true;
    fake.isPrivate = true;
    fake.visible = false;
    fake.branches.set('main', 'c1');
    await expect(setUpRepository(clientFor(fake), target())).rejects.toThrow(/already exists/);
  });
});
