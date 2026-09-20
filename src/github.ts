/**
 * GitHub Git Data API client — the transport that replaced `git push`.
 *
 * There is no checkout on the boat and no `git` binary in the path. A publish
 * is four calls: build a tree on top of the current HEAD, create a commit,
 * move the ref, done. Because every tree is built against the live HEAD with
 * only this plugin's paths layered on top, a docs edit made from a phone and
 * a telemetry publish from the boat interleave without a merge; the only race
 * is the ref update losing to someone else's push, which is a re-read and a
 * retry.
 *
 * Every request carries an AbortSignal timeout. A call without one blocks
 * forever on a half-open connection, which over a marina hotspot is the
 * normal failure, not the exotic one.
 */

export interface GitHubOptions {
  repo: string;
  branch: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export interface TreeEntry {
  path: string;
  /** UTF-8 file contents. Mutually exclusive with `sha`. */
  content?: string;
  /** Blob SHA, for binary files uploaded with `createBlob`. */
  sha?: string | null;
  mode?: '100644' | '100755' | '040000' | '160000' | '120000';
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/**
 * What a failing status usually means for the token.
 *
 * All three of these look identical in a stack trace and have completely
 * different fixes, and the one people hit is 403: a token made without
 * "Contents: read and write" reads the repository perfectly and fails on the
 * first commit.
 */
export function tokenHint(status: number | undefined, repo: string): string {
  if (status === 401) {
    return ' The token was rejected: it is wrong, revoked, or past its expiry date.';
  }
  if (status === 403) {
    return (
      ` The token can reach GitHub but may not write ${repo}. A fine-grained token needs` +
      ' Contents: Read and write on this repository, and an organisation-owned repository' +
      " needs an owner to approve the token; a classic token needs the 'repo' scope."
    );
  }
  if (status === 404) {
    return (
      ` ${repo} is not visible to this token. Check the owner and the repository name, and` +
      " that the token's repository access includes this one."
    );
  }
  return '';
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * What one cycle cost, for the log line.
 *
 * `bytesUploaded` is the real number to watch: the Git Data API takes each
 * changed file as a base64 blob in the request body and does not accept a
 * compressed one, so this is what actually crosses the hotspot — not the size
 * of a git delta.
 */
export interface RequestStats {
  requests: number;
  bytesUploaded: number;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

const emptyStats = (): RequestStats => ({
  requests: 0,
  bytesUploaded: 0,
  rateLimitRemaining: null,
  rateLimitResetAt: null,
});

export class GitHubClient {
  private readonly repo: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private stats: RequestStats = emptyStats();

  constructor(options: GitHubOptions) {
    this.repo = options.repo;
    this.branch = options.branch;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? 'signalk-github-pages';
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const url = `https://api.github.com${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    this.stats.requests += 1;
    if (payload) this.stats.bytesUploaded += Buffer.byteLength(payload, 'utf-8');
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.userAgent,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      body: payload,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null) this.stats.rateLimitRemaining = Number(remaining);
    const reset = response.headers.get('x-ratelimit-reset');
    if (reset !== null) {
      this.stats.rateLimitResetAt = new Date(Number(reset) * 1000).toISOString();
    }

    if (response.status === 304) {
      return { status: 304, data: undefined as T, headers: response.headers };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitHubError(
        `${method} ${path} failed: ${response.status} ${response.statusText}`,
        response.status,
        text.slice(0, 500),
      );
    }
    const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    return { status: response.status, data, headers: response.headers };
  }

  /** Read the counters for the cycle that just ran and start the next one. */
  takeStats(): RequestStats {
    const stats = this.stats;
    this.stats = emptyStats();
    return stats;
  }

  /** HEAD commit SHA of the configured branch. */
  async getRef(): Promise<string> {
    const { data } = await this.request<{ object: { sha: string } }>(
      'GET',
      `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`,
    );
    return data.object.sha;
  }

  async getCommitTree(commitSha: string): Promise<string> {
    const { data } = await this.request<{ tree: { sha: string } }>(
      'GET',
      `/repos/${this.repo}/git/commits/${commitSha}`,
    );
    return data.tree.sha;
  }

  /** Upload a binary file and return its blob SHA. */
  async createBlob(content: Buffer): Promise<string> {
    const { data } = await this.request<{ sha: string }>(
      'POST',
      `/repos/${this.repo}/git/blobs`,
      { content: content.toString('base64'), encoding: 'base64' },
    );
    return data.sha;
  }

  async createTree(baseTree: string, entries: TreeEntry[]): Promise<string> {
    const { data } = await this.request<{ sha: string }>(
      'POST',
      `/repos/${this.repo}/git/trees`,
      {
        base_tree: baseTree,
        // A null sha deletes the path. `mode` and `type` go with it: the API
        // wants a complete entry either way, and the null is the only thing
        // that distinguishes a deletion from a write.
        tree: entries.map((entry) => ({
          path: entry.path,
          mode: entry.mode ?? '100644',
          type: 'blob',
          ...(entry.sha !== undefined ? { sha: entry.sha } : { content: entry.content }),
        })),
      },
    );
    return data.sha;
  }

  async createCommit(message: string, treeSha: string, parentSha: string): Promise<string> {
    const { data } = await this.request<{ sha: string }>(
      'POST',
      `/repos/${this.repo}/git/commits`,
      { message, tree: treeSha, parents: [parentSha] },
    );
    return data.sha;
  }

  async updateRef(commitSha: string, force = false): Promise<void> {
    await this.request(
      'PATCH',
      `/repos/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`,
      { sha: commitSha, force },
    );
  }

  /** File contents as text, or null when the path does not exist. */
  async getFile(path: string): Promise<string | null> {
    try {
      const { data } = await this.request<{ content?: string; encoding?: string }>(
        'GET',
        `/repos/${this.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`,
      );
      if (!data?.content) return null;
      return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? 'base64').toString(
        'utf-8',
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Recursive listing of the branch tree, with ETag support.
   *
   * Passing back the previous ETag makes the poll free against the rate limit
   * when nothing changed, which is what lets the docs index refresh on a tight
   * interval without spending quota.
   */
  async listTree(
    etag?: string,
  ): Promise<{
    changed: boolean;
    etag?: string;
    paths: Array<{ path: string; sha: string; type: string }>;
    /** GitHub caps a listing at 100k entries; past that, absence proves nothing. */
    truncated: boolean;
  }> {
    const { status, data, headers } = await this.request<{
      tree?: Array<{ path: string; sha: string; type: string }>;
      truncated?: boolean;
    }>(
      'GET',
      `/repos/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`,
      undefined,
      etag ? { 'If-None-Match': etag } : {},
    );
    if (status === 304) return { changed: false, etag, paths: [], truncated: false };
    return {
      changed: true,
      etag: headers.get('etag') ?? undefined,
      paths: data?.tree ?? [],
      truncated: data?.truncated === true,
    };
  }

  /** Committer date of the newest commit touching a path, or null. */
  async getLastCommitDate(path: string): Promise<string | null> {
    try {
      const { data } = await this.request<Array<{ commit: { committer?: { date?: string } } }>>(
        'GET',
        `/repos/${this.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(this.branch)}&per_page=1`,
      );
      return data?.[0]?.commit?.committer?.date ?? null;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /** Raw file contents by blob SHA (used to read docs without a checkout). */
  async getBlobText(sha: string): Promise<string> {
    const { data } = await this.request<{ content: string; encoding: string }>(
      'GET',
      `/repos/${this.repo}/git/blobs/${sha}`,
    );
    return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? 'base64').toString(
      'utf-8',
    );
  }
}

export interface PublishFile {
  path: string;
  content: string | Buffer;
}

export interface PublishResult {
  commitSha: string;
  files: number;
  retried: boolean;
}

export interface PublishOptions {
  /** Paths to remove in the same commit. */
  deletions?: string[];
}

/**
 * Publish a set of files as one commit, retrying once on a lost ref race.
 *
 * `force` is never set: if HEAD moved under us the tree is rebuilt against the
 * new HEAD, so a concurrent docs edit is preserved rather than overwritten.
 */
export async function publishFiles(
  client: GitHubClient,
  files: PublishFile[],
  message: string,
  options: PublishOptions = {},
): Promise<PublishResult | null> {
  const deletions = options.deletions ?? [];
  if (!files.length && !deletions.length) return null;

  const attempt = async (): Promise<PublishResult> => {
    const headSha = await client.getRef();
    const baseTree = await client.getCommitTree(headSha);
    const entries: TreeEntry[] = [];
    for (const file of files) {
      if (Buffer.isBuffer(file.content)) {
        entries.push({ path: file.path, sha: await client.createBlob(file.content) });
      } else {
        entries.push({ path: file.path, content: file.content });
      }
    }
    for (const path of deletions) entries.push({ path, sha: null });
    const treeSha = await client.createTree(baseTree, entries);
    const commitSha = await client.createCommit(message, treeSha, headSha);
    await client.updateRef(commitSha);
    return { commitSha, files: files.length + deletions.length, retried: false };
  };

  try {
    return await attempt();
  } catch (error) {
    // 422 is what a non-fast-forward ref update comes back as; 409 covers a
    // repository that was busy. Both mean "re-read HEAD and try once more".
    if (
      error instanceof GitHubError &&
      (error.status === 422 || error.status === 409)
    ) {
      const result = await attempt();
      return { ...result, retried: true };
    }
    throw error;
  }
}
