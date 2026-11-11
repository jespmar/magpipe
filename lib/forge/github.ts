/**
 * The GitHub forge (D42): GitHub's REST API with a token (a fine-grained token with read and
 * write access to pull requests and contents on the one repository is enough).
 */
import { ForgeError, type Forge, type PullRequest } from './types';

export const GITHUB_API = 'https://api.github.com';

type RawPull = {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  merged?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
};

export function githubForge(
  token: string,
  fetchImpl: typeof fetch = fetch,
  api = GITHUB_API,
): Forge {
  async function call<T>(
    method: string,
    route: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${api}${route}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ForgeError(`GitHub could not be reached: ${(err as Error).message}`, 'network');
    }
    const json = (await res.json().catch(() => ({}))) as { message?: string } & T;
    if (res.ok) return json;
    const said = json.message ? `: ${json.message}` : '';
    if (res.status === 401) {
      throw new ForgeError(
        'GitHub did not accept the token. Check it is not expired or revoked.',
        'auth',
      );
    }
    if (res.status === 403) {
      throw new ForgeError(
        `GitHub refused${said}. The token may lack access to this repository.`,
        'auth',
      );
    }
    if (res.status === 404)
      throw new ForgeError(`GitHub found nothing at ${route}${said}.`, 'not_found');
    if (res.status === 405 || res.status === 409)
      throw new ForgeError(`GitHub would not merge${said}.`, 'conflict');
    if (res.status === 422) throw new ForgeError(`GitHub answered${said}.`, 'invalid');
    throw new ForgeError(
      `GitHub answered ${res.status}${said}.`,
      res.status >= 500 ? 'network' : 'unknown',
    );
  }

  async function checksOf(
    repo: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<PullRequest['checks']> {
    const runs = await call<{ check_runs: { status: string; conclusion: string | null }[] }>(
      'GET',
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      undefined,
      signal,
    );
    if (runs.check_runs.length === 0) return 'none';
    if (runs.check_runs.some((r) => r.status !== 'completed')) return 'pending';
    const bad = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
    return runs.check_runs.some((r) => bad.includes(r.conclusion ?? '')) ? 'failure' : 'success';
  }

  async function shape(repo: string, raw: RawPull, signal?: AbortSignal): Promise<PullRequest> {
    const merged = Boolean(raw.merged_at || raw.merged);
    return {
      number: raw.number,
      url: raw.html_url,
      state: merged ? 'merged' : raw.state,
      head: raw.head.ref,
      base: raw.base.ref,
      checks:
        merged || raw.state === 'closed' ? 'none' : await checksOf(repo, raw.head.sha, signal),
    };
  }

  return {
    name: 'github',
    async viewer(signal) {
      const me = await call<{ login: string }>('GET', '/user', undefined, signal);
      return { login: me.login };
    },
    async repository(repo, signal) {
      const r = await call<{ default_branch: string }>('GET', `/repos/${repo}`, undefined, signal);
      return { defaultBranch: r.default_branch };
    },
    async openPullRequest(repo, input, signal) {
      const owner = repo.split('/')[0]!;
      const open = await call<RawPull[]>(
        'GET',
        `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}`,
        undefined,
        signal,
      );
      if (open[0]) return shape(repo, open[0], signal);
      const made = await call<RawPull>('POST', `/repos/${repo}/pulls`, input, signal);
      return shape(repo, made, signal);
    },
    async pullRequest(repo, number, signal) {
      return shape(
        repo,
        await call<RawPull>('GET', `/repos/${repo}/pulls/${number}`, undefined, signal),
        signal,
      );
    },
    async merge(repo, number, method, signal) {
      const res = await call<{ sha: string; merged: boolean }>(
        'PUT',
        `/repos/${repo}/pulls/${number}/merge`,
        { merge_method: method },
        signal,
      );
      if (!res.merged) throw new ForgeError('GitHub did not merge the pull request.', 'conflict');
      return { sha: res.sha };
    },
  };
}
