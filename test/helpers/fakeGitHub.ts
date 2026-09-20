/**
 * An in-memory stand-in for the parts of the GitHub Git Data API this plugin
 * uses, wired in as a `fetchImpl`. It gives the tests a real request/response
 * path — blobs, trees, commits, the ref update and the ETag on the tree
 * listing — without a network or a token.
 */
import { createHash } from 'node:crypto';

export interface FakeOptions {
  repo: string;
  branch: string;
  /** Initial repository contents, path -> UTF-8 text. */
  files?: Record<string, string>;
  /** Fail the first N ref updates with 422, as a lost race does. */
  failRefUpdates?: number;
}

interface Commit {
  sha: string;
  tree: string;
  message: string;
  parents: string[];
  date: string;
}

const sha = (input: string): string =>
  createHash('sha1').update(input).digest('hex');

export class FakeGitHub {
  files: Map<string, string>;
  commits: Commit[] = [];
  requests: Array<{ method: string; path: string }> = [];
  private trees = new Map<string, Map<string, string>>();
  private blobs = new Map<string, string>();
  private head: string;
  private refFailuresLeft: number;
  private treeEtag = 'W/"tree-0"';
  private etagCounter = 0;

  constructor(private readonly options: FakeOptions) {
    this.files = new Map(Object.entries(options.files ?? {}));
    this.refFailuresLeft = options.failRefUpdates ?? 0;
    const rootTree = sha('root');
    this.trees.set(rootTree, new Map(this.files));
    this.head = sha('initial-commit');
    this.commits.push({
      sha: this.head,
      tree: rootTree,
      message: 'Initial commit',
      parents: [],
      date: '2026-01-01T00:00:00Z',
    });
    this.bumpEtag();
  }

  private bumpEtag(): void {
    this.etagCounter += 1;
    this.treeEtag = `W/"tree-${this.etagCounter}"`;
  }

  /** Write a file the way a human editing on GitHub would. */
  commitFile(path: string, contents: string): void {
    this.files.set(path, contents);
    const treeSha = sha(`tree-${this.commits.length}-${path}`);
    this.trees.set(treeSha, new Map(this.files));
    this.head = sha(`commit-${this.commits.length}-${path}`);
    this.commits.push({
      sha: this.head,
      tree: treeSha,
      message: `Edit ${path}`,
      parents: [this.commits[this.commits.length - 1]!.sha],
      date: new Date().toISOString(),
    });
    this.bumpEtag();
  }

  get fetch(): typeof fetch {
    return (async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      const method = (init.method ?? 'GET').toUpperCase();
      const path = url.pathname;
      this.requests.push({ method, path: path + url.search });
      const body = init.body ? JSON.parse(init.body) : undefined;
      const prefix = `/repos/${this.options.repo}`;

      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json', ...headers },
        });

      if (method === 'GET' && path === `${prefix}/git/ref/heads/${this.options.branch}`) {
        return json(200, { object: { sha: this.head } });
      }

      if (method === 'GET' && path.startsWith(`${prefix}/git/commits/`)) {
        const commit = this.commits.find((c) => c.sha === path.split('/').pop());
        if (!commit) return json(404, { message: 'Not Found' });
        return json(200, { tree: { sha: commit.tree } });
      }

      if (method === 'POST' && path === `${prefix}/git/blobs`) {
        const blobSha = sha(body.content);
        this.blobs.set(blobSha, body.content);
        return json(201, { sha: blobSha });
      }

      if (method === 'POST' && path === `${prefix}/git/trees`) {
        const base = this.trees.get(body.base_tree);
        if (!base) return json(422, { message: 'base_tree not found' });
        const next = new Map(base);
        for (const entry of body.tree) {
          // A null sha is a deletion, which is how voyages are pruned.
          if (entry.sha === null) next.delete(entry.path);
          else if (entry.sha) next.set(entry.path, `base64:${this.blobs.get(entry.sha) ?? ''}`);
          else next.set(entry.path, entry.content);
        }
        const treeSha = sha(JSON.stringify([...next.entries()]));
        this.trees.set(treeSha, next);
        return json(201, { sha: treeSha });
      }

      if (method === 'POST' && path === `${prefix}/git/commits`) {
        const commitSha = sha(`${body.tree}-${body.message}-${this.commits.length}`);
        this.commits.push({
          sha: commitSha,
          tree: body.tree,
          message: body.message,
          parents: body.parents,
          date: new Date().toISOString(),
        });
        return json(201, { sha: commitSha });
      }

      if (method === 'PATCH' && path === `${prefix}/git/refs/heads/${this.options.branch}`) {
        if (this.refFailuresLeft > 0) {
          this.refFailuresLeft -= 1;
          return json(422, { message: 'Update is not a fast forward' });
        }
        const commit = this.commits.find((c) => c.sha === body.sha)!;
        if (commit.parents[0] !== this.head) {
          return json(422, { message: 'Update is not a fast forward' });
        }
        this.head = commit.sha;
        this.files = new Map(this.trees.get(commit.tree)!);
        this.bumpEtag();
        return json(200, { object: { sha: this.head } });
      }

      if (method === 'GET' && path.startsWith(`${prefix}/contents/`)) {
        const filePath = decodeURIComponent(path.slice(`${prefix}/contents/`.length));
        const contents = this.files.get(filePath);
        if (contents === undefined) return json(404, { message: 'Not Found' });
        return json(200, {
          content: Buffer.from(contents, 'utf-8').toString('base64'),
          encoding: 'base64',
        });
      }

      if (method === 'GET' && path === `${prefix}/git/trees/${this.options.branch}`) {
        if (init.headers?.['If-None-Match'] === this.treeEtag) {
          return new Response(null, { status: 304, headers: { ETag: this.treeEtag } });
        }
        return json(
          200,
          {
            tree: [...this.files.entries()].map(([filePath, contents]) => ({
              path: filePath,
              sha: sha(contents),
              type: 'blob',
            })),
          },
          { ETag: this.treeEtag },
        );
      }

      if (method === 'GET' && path.startsWith(`${prefix}/git/blobs/`)) {
        const wanted = path.split('/').pop();
        for (const contents of this.files.values()) {
          if (sha(contents) === wanted) {
            return json(200, {
              content: Buffer.from(contents, 'utf-8').toString('base64'),
              encoding: 'base64',
            });
          }
        }
        return json(404, { message: 'Not Found' });
      }

      if (method === 'GET' && path === `${prefix}/commits`) {
        return json(200, [{ commit: { committer: { date: '2026-02-01T00:00:00Z' } } }]);
      }

      return json(404, { message: `Unhandled ${method} ${path}` });
    }) as unknown as typeof fetch;
  }
}
