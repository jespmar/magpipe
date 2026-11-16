/**
 * A scripted forge for tests and the end-to-end server (`MAGPIPE_FORGE_STUB=scripted`, never in
 * production): pull requests and repositories kept in memory. Any token works except one that
 * starts with `ghp_bad`. `mergeOnGitHub` merges a pull request the way a person would on the
 * website. A repository is cloned from a bare one on this computer, made on first use (D49).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ForgeError, type Forge, type ForgeOwner, type ForgeRepo, type PullRequest } from './types';

export const SCRIPTED_LOGIN = 'scripted-operator';

export const SCRIPTED_OWNERS: ForgeOwner[] = [
  { login: SCRIPTED_LOGIN, kind: 'user' },
  { login: 'magpipe-e2e', kind: 'org' },
];

/** The repositories the scripted token can push to; each has a package.json with these scripts. */
export const SCRIPTED_REPOS: ForgeRepo[] = [
  ['magpipe-e2e', 'app', 'The web app the factory end-to-end test builds in.'],
  ['magpipe-e2e', 'api', 'The API service.'],
  ['magpipe-e2e', 'website', null],
  [SCRIPTED_LOGIN, 'dotfiles', 'Shell and editor settings.'],
  [SCRIPTED_LOGIN, 'notes', null],
].map(([owner, name, description], i) => ({
  fullName: `${owner}/${name}`,
  owner: owner!,
  name: name!,
  private: i % 2 === 0,
  description: description ?? null,
  pushedAt: new Date(Date.UTC(2026, 9, 20 - i)).toISOString(),
}));

export const SCRIPTED_SCRIPTS = ['test', 'lint'];

type Store = {
  pulls: (PullRequest & { repo: string; title: string; body: string })[];
  checks: PullRequest['checks'];
  /** Repositories made through the forge, besides the scripted ones: no package.json yet. */
  made: ForgeRepo[];
  /** Where the bare repositories are cloned from. */
  bareRoot: string;
};

const g = globalThis as unknown as { __magpipeScriptedForge?: Store };

export function scriptedForgeStore(fresh = false): Store {
  if (fresh || !g.__magpipeScriptedForge)
    g.__magpipeScriptedForge = {
      pulls: [],
      checks: 'success',
      made: [],
      bareRoot: path.join(os.tmpdir(), `magpipe-scripted-forge-${process.pid}`),
    };
  return g.__magpipeScriptedForge;
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'user.name=Scripted', '-c', 'user.email=scripted@magpipe.invalid', ...args],
      { cwd, timeout: 30_000 },
      (err, _out, stderr) => (err ? reject(new Error(`git ${args[0]}: ${stderr}`)) : resolve()),
    );
  });
}

/** A bare repository with one commit on main: a README, and a package.json when it has scripts. */
async function bareRepository(root: string, repo: ForgeRepo, scripts: string[] | null) {
  const bare = path.join(root, repo.owner, `${repo.name}.git`);
  if (await fs.stat(path.join(bare, 'HEAD')).catch(() => null)) return bare;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'magpipe-scripted-seed-'));
  try {
    await git(work, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(work, 'README.md'), `# ${repo.name}\n`);
    if (scripts) {
      const pkg = {
        name: repo.name,
        private: true,
        scripts: Object.fromEntries(scripts.map((s) => [s, 'node -e 0'])),
      };
      await fs.writeFile(path.join(work, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    }
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'Initial commit']);
    await fs.mkdir(path.dirname(bare), { recursive: true });
    await git(path.dirname(bare), ['clone', '-q', '--bare', work, bare]);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
  return bare;
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
    async repositories() {
      authed();
      return [...store.made, ...SCRIPTED_REPOS].map((r) => ({ ...r }));
    },
    async owners() {
      authed();
      return SCRIPTED_OWNERS.map((o) => ({ ...o }));
    },
    async createRepository(input) {
      authed();
      if (!SCRIPTED_OWNERS.some((o) => o.login === input.owner)) {
        throw new ForgeError(`GitHub found nothing at /orgs/${input.owner}/repos.`, 'not_found');
      }
      const fullName = `${input.owner}/${input.name}`;
      const all = [...store.made, ...SCRIPTED_REPOS];
      if (all.some((r) => r.fullName.toLowerCase() === fullName.toLowerCase())) {
        throw new ForgeError(
          'GitHub answered: Repository creation failed. name already exists on this account.',
          'invalid',
        );
      }
      const made: ForgeRepo = {
        fullName,
        owner: input.owner,
        name: input.name,
        private: input.private,
        description: input.description || null,
        pushedAt: new Date().toISOString(),
      };
      store.made.unshift(made);
      return { ...made };
    },
    async packageScripts(repo) {
      authed();
      const found = SCRIPTED_REPOS.find((r) => r.fullName === repo);
      if (found) return [...SCRIPTED_SCRIPTS];
      if (store.made.some((r) => r.fullName === repo)) return null;
      throw new ForgeError(`GitHub found nothing at /repos/${repo}.`, 'not_found');
    },
    async cloneSource(repo) {
      authed();
      const seeded = SCRIPTED_REPOS.find((r) => r.fullName === repo);
      const made = store.made.find((r) => r.fullName === repo);
      if (!seeded && !made) {
        throw new ForgeError(`GitHub found nothing at /repos/${repo}.`, 'not_found');
      }
      const url = await bareRepository(
        store.bareRoot,
        (seeded ?? made)!,
        seeded ? SCRIPTED_SCRIPTS : null,
      );
      return { url, auth: false };
    },
    mergeOnGitHub(number) {
      const pr = store.pulls.find((p) => p.number === number);
      if (!pr) throw new Error(`No pull request ${number}`);
      pr.state = 'merged';
    },
  };
}
