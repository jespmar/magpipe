/**
 * The forge seam (D42): what the factory needs from a git host, and nothing more. GitHub
 * implements it over its REST API (`github.ts`); tests and the end-to-end server use the scripted
 * forge (`scripted.ts`), so no test needs a GitHub account.
 */

export type PullRequest = {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  head: string;
  base: string;
  /** The checks on the head commit: success, failure, pending, or none when there are none. */
  checks: 'success' | 'failure' | 'pending' | 'none';
};

/** A repository the token can push to, as the New project wizard lists it (D49). */
export type ForgeRepo = {
  /** `owner/name`. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  pushedAt: string | null;
};

/** An account a repository can be made under: the token's own, or an organization it is in. */
export type ForgeOwner = { login: string; kind: 'user' | 'org' };

/** Where a repository is cloned from, and whether the clone needs the token (D49). */
export type CloneSource = { url: string; auth: boolean };

export interface Forge {
  readonly name: 'github' | 'scripted';
  /** Who the token belongs to: proves the token works. */
  viewer(signal?: AbortSignal): Promise<{ login: string }>;
  /** The repository, with its default branch: proves the token can reach it. `canPush` says
   * whether the token may push to it. */
  repository(
    repo: string,
    signal?: AbortSignal,
  ): Promise<{ defaultBranch: string; canPush: boolean }>;
  /** Opens a pull request from `head` to `base`, or returns the open one that already exists. */
  openPullRequest(
    repo: string,
    input: { head: string; base: string; title: string; body: string },
    signal?: AbortSignal,
  ): Promise<PullRequest>;
  pullRequest(repo: string, number: number, signal?: AbortSignal): Promise<PullRequest>;
  merge(
    repo: string,
    number: number,
    method: 'squash' | 'merge' | 'rebase',
    signal?: AbortSignal,
  ): Promise<{ sha: string }>;
  /** Every repository the token can push to: its own, its collaborations, its organizations'. */
  repositories(signal?: AbortSignal): Promise<ForgeRepo[]>;
  /** The token's own account and the organizations it is in. */
  owners(signal?: AbortSignal): Promise<ForgeOwner[]>;
  /** Makes a repository with a first commit, so it has a default branch to build on. */
  createRepository(
    input: { owner: string; name: string; private: boolean; description?: string },
    signal?: AbortSignal,
  ): Promise<ForgeRepo>;
  /** The scripts in the repository's package.json on its default branch; null when it has none. */
  packageScripts(repo: string, signal?: AbortSignal): Promise<string[] | null>;
  cloneSource(repo: string): Promise<CloneSource>;
}

/** The forge refused or could not be reached. `auth` means the token is wrong or revoked. */
export class ForgeError extends Error {
  constructor(
    message: string,
    readonly code:
      'auth' | 'not_found' | 'network' | 'invalid' | 'conflict' | 'unknown' = 'unknown',
  ) {
    super(message);
  }
}
