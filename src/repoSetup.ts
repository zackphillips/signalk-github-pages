/**
 * The repository the site is published to: whether it is there, and making
 * it so when it is not.
 *
 * Four things can stand between a new install and a working site, and each
 * has a different fix. The repository may not exist. It may exist but be
 * empty, which the Git Data API refuses to build on (409), and which is what
 * GitHub's "Create repository" gives you unless you tick "Add a README". It
 * may exist and be invisible to the sign-in, because the GitHub App was
 * never installed on it — the token's 404 looks exactly like the first case,
 * so the question is asked again without credentials. And Pages may be off.
 *
 * `checkRepository` tells them apart and costs a few GETs. `setUpRepository`
 * fixes the ones a button can: it creates a missing repository, gives an
 * empty one its first commit, starts the configured branch if the repository
 * came with a different default, and turns Pages on. The console calls it;
 * a cycle never does. Creating a public repository on someone's account is
 * something a person asks for, not something a timer decides.
 *
 * Creating a repository and turning Pages on need the app's Administration
 * permission. An app registered without it still gets everything else, and
 * the refusal comes back with a link that does the same thing by hand: a
 * prefilled github.com/new, or the repository's Pages settings.
 */
import { GitHubError, tokenHint, type AuthMode, type GitHubClient } from './github';

export type RepositoryState =
  | 'ok'
  | 'missing'
  | 'empty'
  /** The repository is there; the configured branch is not. */
  | 'no-branch'
  | 'not-installed'
  | 'error';
export type PagesState = 'on' | 'off' | 'unknown';

export interface RepoCheck {
  ok: boolean;
  repository: RepositoryState;
  pages: PagesState;
  /** One sentence for the console, saying what is wrong and what fixes it. */
  detail: string;
  /** Whether the console's "Set up" button has something to do. */
  canSetUp: boolean;
  /** Links for doing by hand what the button could not. */
  links: {
    install?: string;
    create?: string;
    pagesSettings?: string;
  };
  checkedAt: string;
}

export interface RepoTarget {
  owner: string;
  name: string;
  repo: string;
  branch: string;
  auth: AuthMode;
  installUrl: string;
  /** The signed-in account, when there is one: a personal repository can only be created for it. */
  login?: string | null;
}

const DESCRIPTION = 'Vessel tracker, published from the boat by signalk-github-pages.';

/** github.com/new with the name and visibility filled in: one tap to create it by hand. */
export function createByHandUrl(target: RepoTarget): string {
  const params = new URLSearchParams({
    name: target.name,
    owner: target.owner,
    visibility: 'public',
    description: DESCRIPTION,
  });
  return `https://github.com/new?${params.toString()}`;
}

function pagesSettingsUrl(target: RepoTarget): string {
  return `https://github.com/${target.repo}/settings/pages`;
}

const statusOf = (error: unknown) => (error instanceof GitHubError ? error.status : undefined);

/** Look, and say what is wrong. A few GETs; changes nothing. */
export async function checkRepository(
  client: GitHubClient,
  target: RepoTarget,
  now: () => Date = () => new Date(),
): Promise<RepoCheck> {
  const checkedAt = now().toISOString();
  const result = (
    repository: RepositoryState,
    pages: PagesState,
    detail: string,
    canSetUp: boolean,
    links: RepoCheck['links'] = {},
  ): RepoCheck => ({
    ok: repository === 'ok' && pages !== 'off',
    repository,
    pages,
    detail,
    canSetUp,
    links,
    checkedAt,
  });

  try {
    await client.getRef();
  } catch (error) {
    const status = statusOf(error);
    if (status === 409) {
      return result(
        'empty',
        'unknown',
        `${target.repo} exists but has no commits yet. Set it up to give it a first commit.`,
        true,
      );
    }
    if (status === 404) {
      // The branch, not the repository, is the likelier miss when the
      // repository came with a different default branch.
      const branchMissing = await client
        .defaultBranch()
        .then((branch) => (branch && branch !== target.branch ? branch : null))
        .catch(() => null);
      if (branchMissing) {
        return result(
          'no-branch',
          'unknown',
          `${target.repo} has no ${target.branch} branch (its default is ${branchMissing}). ` +
            `Set it up to start ${target.branch} from ${branchMissing}.`,
          true,
        );
      }
      const exists = await client.existsPublicly();
      if (exists === true) {
        return result(
          'not-installed',
          'unknown',
          target.auth === 'app'
            ? `${target.repo} exists, but the GitHub App is not installed on it.`
            : tokenHint(404, target.repo, 'token').trim(),
          false,
          target.auth === 'app' ? { install: target.installUrl } : {},
        );
      }
      return result(
        'missing',
        'unknown',
        exists === false
          ? `${target.repo} does not exist yet. Set it up to create it, public, with Pages on.`
          : `${target.repo} is not visible: either it does not exist, or the GitHub App is not ` +
              'installed on it.',
        true,
        // The install link only when GitHub would not say which it is: for a
        // repository that is not there, it is a link to nothing useful.
        exists === false
          ? { create: createByHandUrl(target) }
          : { install: target.installUrl, create: createByHandUrl(target) },
      );
    }
    const hint = tokenHint(status, target.repo, target.auth).trim();
    return result(
      'error',
      'unknown',
      hint ? `${hint}${status ? ` (HTTP ${status})` : ''}` : String((error as Error)?.message ?? error),
      false,
      status === 404 && target.auth === 'app' ? { install: target.installUrl } : {},
    );
  }

  try {
    const pages = await client.getPages();
    if (pages) {
      return result('ok', 'on', `${target.repo} is ready${pages.url ? `, served at ${pages.url}` : ''}.`, false);
    }
    return result(
      'ok',
      'off',
      `${target.repo} is there, but GitHub Pages is off, so nothing is served. Set it up to turn Pages on.`,
      true,
      { pagesSettings: pagesSettingsUrl(target) },
    );
  } catch {
    // Pages: read is a permission a token may lack. The repository is fine,
    // which is what publishing needs; Pages is simply not known.
    return result('ok', 'unknown', `${target.repo} is ready.`, false);
  }
}

export class RepoSetupError extends Error {
  constructor(
    message: string,
    readonly links: RepoCheck['links'] = {},
  ) {
    super(message);
    this.name = 'RepoSetupError';
  }
}

/**
 * Make the repository publishable: create it, give it a first commit, start
 * the branch, turn Pages on — whichever of those it needs, and nothing else.
 * Returns the check afterwards, which is what the console shows.
 *
 * Never touches a repository that already has content beyond starting a
 * missing branch from its default: the ownership manifest's promise covers
 * this path too.
 */
export async function setUpRepository(
  client: GitHubClient,
  target: RepoTarget,
  log: (message: string) => void = () => {},
): Promise<RepoCheck> {
  let check = await checkRepository(client, target);

  if (check.repository === 'no-branch') {
    await startBranchFromDefault(client, target, log);
  } else if (check.repository === 'missing') {
    await createRepository(client, target, log);
  } else if (check.repository === 'empty') {
    await client.putFile(
      'README.md',
      `# ${target.name}\n\n${DESCRIPTION}\n`,
      'Initial commit',
    );
    log(`Gave ${target.repo} its first commit.`);
    await startBranchFromDefault(client, target, log);
  } else if (check.repository !== 'ok') {
    throw new RepoSetupError(check.detail, check.links);
  }

  check = await checkRepository(client, target);
  if (check.repository !== 'ok') throw new RepoSetupError(check.detail, check.links);

  if (check.pages === 'off') {
    try {
      await client.enablePages();
      log(`Turned GitHub Pages on for ${target.repo}.`);
    } catch (error) {
      const status = statusOf(error);
      throw new RepoSetupError(
        status === 403 || status === 404
          ? `GitHub would not let the app turn Pages on for ${target.repo} (HTTP ${status}). ` +
              `Turn it on by hand: Deploy from a branch, ${target.branch}, / (root).`
          : `Could not turn Pages on: ${(error as Error)?.message ?? error}`,
        { pagesSettings: pagesSettingsUrl(target) },
      );
    }
    check = await checkRepository(client, target);
  }
  return check;
}

async function createRepository(
  client: GitHubClient,
  target: RepoTarget,
  log: (message: string) => void,
): Promise<void> {
  const byHand = { create: createByHandUrl(target), install: target.installUrl };
  const type = await client.accountType(target.owner).catch(() => null);
  const organization = type === 'Organization';
  if (!organization && target.login && target.login.toLowerCase() !== target.owner.toLowerCase()) {
    throw new RepoSetupError(
      `${target.owner} is another person's account, and a repository can only be created in ` +
        `your own (${target.login}) or in an organization you belong to.`,
      byHand,
    );
  }
  try {
    const { defaultBranch } = await client.createRepository(organization, DESCRIPTION);
    log(`Created ${target.repo}.`);
    if (defaultBranch !== target.branch) await startBranchFromDefault(client, target, log);
  } catch (error) {
    const status = statusOf(error);
    if (status === 422) {
      // It exists after all: private, or the app is not installed on it.
      throw new RepoSetupError(
        `${target.repo} already exists, but the sign-in cannot see it. Install the GitHub App on it.`,
        { install: target.installUrl },
      );
    }
    if (status === 403 || status === 404) {
      throw new RepoSetupError(
        `GitHub would not let the app create ${target.repo} (HTTP ${status}). Create it by ` +
          'hand, then install the app on it.',
        byHand,
      );
    }
    throw error;
  }
}

async function startBranchFromDefault(
  client: GitHubClient,
  target: RepoTarget,
  log: (message: string) => void,
): Promise<void> {
  try {
    await client.getRef();
    return;
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }
  const from = await client.defaultBranch();
  if (!from || from === target.branch) return;
  await client.createBranch(await client.getBranchHead(from));
  log(`Started ${target.branch} from ${from} in ${target.repo}.`);
}
