/**
 * A scripted forge for tests and the end-to-end server (`MAGPIPE_FORGE_STUB=scripted`, never in
 * production): pull requests kept in memory. Any token works except one that starts with
 * `ghp_bad`. `mergeOnGitHub` merges a pull request the way a person would on the website.
 */
import { ForgeError, type Forge, type PullRequest } from './types';

type Store = {
  pulls: (PullRequest & { repo: string; title: string; body: string })[];
  checks: PullRequest['checks'];
};

const g = globalThis as unknown as { __magpipeScriptedForge?: Store };

export function scriptedForgeStore(fresh = false): Store {
  if (fresh || !g.__magpipeScriptedForge)
    g.__magpipeScriptedForge = { pulls: [], checks: 'success' };
  return g.__magpipeScriptedForge;
}

export function scriptedForge(
  token: string,
  store: Store = scriptedForgeStore(),
): Forge & { store: Store; mergeOnGitHub(number: number): void } {
  const authed = () => {
    if (token.startsWith('ghp_bad')) {
      throw new ForgeError(
        'GitHub did not accept the token. Check it is not expired or revoked.',
        'auth',
      );
    }
  };
  const find = (repo: string, number: number) => {
    const pr = store.pulls.find((p) => p.repo === repo && p.number === number);
    if (!pr)
      throw new ForgeError(`GitHub found nothing at /repos/${repo}/pulls/${number}.`, 'not_found');
    return pr;
  };
  const view = ({ repo: _r, title: _t, body: _b, ...pr }: Store['pulls'][number]): PullRequest => ({
    ...pr,
    checks: pr.state === 'open' ? store.checks : 'none',
  });
  return {
    name: 'scripted',
    store,
    async viewer() {
      authed();
      return { login: 'scripted-operator' };
    },
    async repository(repo) {
      authed();
      if (repo.startsWith('nobody/'))
        throw new ForgeError(`GitHub found nothing at /repos/${repo}.`, 'not_found');
      return { defaultBranch: 'main' };
    },
    async openPullRequest(repo, input) {
      authed();
      const open = store.pulls.find(
        (p) => p.repo === repo && p.head === input.head && p.state === 'open',
      );
      if (open) return view(open);
      const number = store.pulls.length + 1;
      const pr = {
        repo,
        number,
        url: `https://github.com/${repo}/pull/${number}`,
        state: 'open' as const,
        head: input.head,
        base: input.base,
        checks: 'none' as const,
        title: input.title,
        body: input.body,
      };
      store.pulls.push(pr);
      return view(pr);
    },
    async pullRequest(repo, number) {
      authed();
      return view(find(repo, number));
    },
    async merge(repo, number) {
      authed();
      const pr = find(repo, number);
      if (pr.state !== 'open')
        throw new ForgeError('GitHub would not merge: the pull request is not open.', 'conflict');
      pr.state = 'merged';
      return { sha: `sha${number}` };
    },
    mergeOnGitHub(number) {
      const pr = store.pulls.find((p) => p.number === number);
      if (!pr) throw new Error(`No pull request ${number}`);
      pr.state = 'merged';
    },
  };
}
