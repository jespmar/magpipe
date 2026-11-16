/**
 * The GitHub forge (D42): GitHub's REST API with a token (a fine-grained token with read and
 * write access to pull requests and contents on the one repository is enough).
 */
import { isScriptName } from '../repo';
import { ForgeError, type Forge, type ForgeRepo, type PullRequest } from './types';

export const GITHUB_API = 'https://api.github.com';

type RawRepo = {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  permissions?: { push?: boolean; admin?: boolean };
};

const repoOf = (r: RawRepo): ForgeRepo => ({
  fullName: r.full_name,
  owner: r.owner.login,
  name: r.name,
  private: r.private,
  description: r.description || null,
  pushedAt: r.pushed_at,
});

/** More than anyone picks from: 1000 repositories, most recently pushed first. */
const MAX_REPO_PAGES = 10;

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
    const json = (await res.json().catch(() => ({}))) as {
      message?: string;
      errors?: ({ message?: string; code?: string } | string)[];
    } & T;
    if (res.ok) return json;
    // A 422 says why in its errors: "name already exists on this account", say.
    const why = (json.errors ?? [])
      .map((e) => (typeof e === 'string' ? e : (e.message ?? e.code)))
      .filter(Boolean);
    const said = json.message ? `: ${json.message}${why.length ? ` (${why.join('; ')})` : ''}` : '';
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
    // Check runs (GitHub Actions and apps) and commit statuses (CircleCI, Jenkins and the like):
    // a repository may report through either, so both are read (D52).
    const [runs, status] = await Promise.all([
      call<{ check_runs: { status: string; conclusion: string | null }[] }>(
        'GET',
        `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
        undefined,
        signal,
      ),
      call<{ state?: string; total_count?: number }>(
        'GET',
        `/repos/${repo}/commits/${sha}/status`,
        undefined,
        signal,
      ),
    ]);
    const statuses = status.total_count ?? 0;
    if (runs.check_runs.length === 0 && statuses === 0) return 'none';
    const bad = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
    if (
      runs.check_runs.some((r) => r.status === 'completed' && bad.includes(r.conclusion ?? '')) ||
      (statuses > 0 && (status.state === 'failure' || status.state === 'error'))
    ) {
      return 'failure';
    }
    if (
      runs.check_runs.some((r) => r.status !== 'completed') ||
      (statuses > 0 && status.state === 'pending')
    ) {
      return 'pending';
    }
    return 'success';
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
      const r = await call<{ default_branch: string; permissions?: { push?: boolean } }>(
        'GET',
        `/repos/${repo}`,
        undefined,
        signal,
      );
      return { defaultBranch: r.default_branch, canPush: r.permissions?.push !== false };
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
    async repositories(signal) {
      const out: ForgeRepo[] = [];
      for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const batch = await call<RawRepo[]>(
          'GET',
          `/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=${page}`,
          undefined,
          signal,
        );
        out.push(...batch.filter((r) => r.permissions?.push !== false).map(repoOf));
        if (batch.length < 100) break;
      }
      return out;
    },
    async owners(signal) {
      const [me, orgs] = await Promise.all([
        call<{ login: string }>('GET', '/user', undefined, signal),
        call<{ login: string }[]>('GET', '/user/orgs?per_page=100', undefined, signal).catch(
          // A fine-grained token may not read organizations: its own account is still there.
          (err: unknown) => {
            if (err instanceof ForgeError && (err.code === 'auth' || err.code === 'not_found'))
              return [];
            throw err;
          },
        ),
      ]);
      return [
        { login: me.login, kind: 'user' as const },
        ...orgs.map((o) => ({ login: o.login, kind: 'org' as const })),
      ];
    },
    async createRepository(input, signal) {
      const me = await call<{ login: string }>('GET', '/user', undefined, signal);
      const route =
        me.login.toLowerCase() === input.owner.toLowerCase()
          ? '/user/repos'
          : `/orgs/${encodeURIComponent(input.owner)}/repos`;
      const made = await call<RawRepo>(
        'POST',
        route,
        {
          name: input.name,
          private: input.private,
          description: input.description || undefined,
          // A first commit, so the repository has a default branch goals can branch from.
          auto_init: true,
        },
        signal,
      );
      return repoOf(made);
    },
    async packageScripts(repo, signal) {
      let file: { content?: string; encoding?: string };
      try {
        file = await call('GET', `/repos/${repo}/contents/package.json`, undefined, signal);
      } catch (err) {
        if (err instanceof ForgeError && err.code === 'not_found') return null;
        throw err;
      }
      if (file.encoding !== 'base64' || !file.content) return null;
      try {
        const pkg = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as {
          scripts?: Record<string, unknown>;
        };
        return Object.keys(pkg.scripts ?? {}).filter(isScriptName);
      } catch {
        return null;
      }
    },
    async cloneSource(repo) {
      return { url: `https://github.com/${repo}.git`, auth: true };
    },
  };
}
