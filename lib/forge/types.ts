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

export interface Forge {
  readonly name: 'github' | 'scripted';
  /** Who the token belongs to: proves the token works. */
  viewer(signal?: AbortSignal): Promise<{ login: string }>;
  /** The repository, with its default branch: proves the token can reach it. */
  repository(repo: string, signal?: AbortSignal): Promise<{ defaultBranch: string }>;
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
