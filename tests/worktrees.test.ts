/**
 * Worktrees per goal (D41) on a real git repository in a temp folder: made on a new branch from
 * the base, reused on a rebuild, with `node_modules` linked and kept out of git, and removed only
 * when nothing uncommitted would be lost.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitDiff, gitLog, repoRun } from '@/lib/repo';
import {
  baseBranch,
  ensureWorktree,
  removeWorktree,
  updateBranch,
  worktreesRoot,
} from '@/lib/worktrees';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

describe('worktrees', () => {
  let dir: string;
  let repo: string;
  let data: string;

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-wt-')));
    repo = path.join(dir, 'app');
    data = path.join(dir, 'data');
    fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e 0' } }),
    );
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    // The operator is on a branch of their own: goals still start from main.
    git(repo, 'switch', '-q', '-c', 'operator-work');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('starts goal branches from main, not from what the folder has checked out', async () => {
    expect(await baseBranch(repo)).toBe('main');
  });

  it('makes a worktree on a new branch under the data folder, with node_modules linked', async () => {
    const wt = await ensureWorktree(repo, 'magpipe/header', data);
    expect(wt).toMatchObject({ branch: 'magpipe/header', base: 'main', created: true });
    expect(wt.path.startsWith(worktreesRoot(repo, data))).toBe(true);
    expect(git(wt.path, 'symbolic-ref', '--short', 'HEAD')).toBe('magpipe/header');
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
    expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(wt.path, 'node_modules', 'left-pad'))).toBe(true);
    // The link is not a change git would show or commit.
    expect(git(wt.path, 'status', '--porcelain')).toBe('');
    // The bound folder is untouched.
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('operator-work');
  });

  it('reuses the worktree on a rebuild, and makes one for an existing branch', async () => {
    const again = await ensureWorktree(repo, 'magpipe/header', data);
    expect(again.created).toBe(false);
    git(repo, 'branch', 'magpipe/filters', 'main');
    const existing = await ensureWorktree(repo, 'magpipe/filters', data);
    expect(existing.created).toBe(true);
    expect(git(existing.path, 'symbolic-ref', '--short', 'HEAD')).toBe('magpipe/filters');
  });

  it('keeps a worktree with uncommitted changes, and removes a clean one', async () => {
    const wt = await ensureWorktree(repo, 'magpipe/header', data);
    fs.writeFileSync(path.join(wt.path, 'package.json'), '{}');
    expect(await removeWorktree(wt.path)).toBe('kept');
    git(wt.path, 'checkout', '--', 'package.json');
    expect(await removeWorktree(wt.path)).toBe('removed');
    expect(fs.existsSync(wt.path)).toBe(false);
    // The branch and its commits stay.
    expect(git(repo, 'show-ref', '--verify', 'refs/heads/magpipe/header')).toContain(
      'magpipe/header',
    );
    expect(await removeWorktree(wt.path)).toBe('missing');
  });

  it('starts a new goal from the base as it is on origin, where goals merge (D51)', async () => {
    // A bare origin that has moved on: a goal merged there, the local main never pulled.
    const origin = path.join(dir, 'origin.git');
    git(dir, 'clone', '-q', '--bare', repo, origin);
    git(repo, 'remote', 'add', 'origin', origin);
    const elsewhere = path.join(dir, 'elsewhere');
    git(dir, 'clone', '-q', '-b', 'main', origin, elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'scaffold.txt'), 'merged on GitHub\n');
    git(elsewhere, 'add', '-A');
    git(elsewhere, 'commit', '-q', '-m', 'scaffold');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const wt = await ensureWorktree(repo, 'magpipe/after-scaffold', data);
    expect(fs.readFileSync(path.join(wt.path, 'scaffold.txt'), 'utf8')).toBe('merged on GitHub\n');
    // Its branch tracks nothing: Magpipe sets the upstream when it pushes the goal.
    expect(() =>
      git(wt.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'),
    ).toThrow();
    // Reviewed "against main", the goal's diff is its own, not the scaffold merged before it.
    fs.writeFileSync(path.join(wt.path, 'goal.txt'), 'the goal\n');
    git(wt.path, 'add', 'goal.txt');
    git(wt.path, 'commit', '-q', '-m', 'goal');
    const diff = await gitDiff(wt.path, 'main');
    expect(diff.text).toContain('goal.txt');
    expect(diff.text).not.toContain('scaffold.txt');
    // The commit list agrees with the diff.
    const log = await gitLog(wt.path, { since: 'main' });
    expect(log.text).toContain('goal');
    expect(log.text).not.toContain('scaffold');
    // A revision expression means what it says: main~0 is the local main, stale as it is.
    expect((await gitDiff(wt.path, 'main~0')).text).toContain('scaffold.txt');
  });

  it('installs into a goal whose link to the bound folder’s node_modules is broken', async () => {
    const wt = await ensureWorktree(repo, 'magpipe/dangling', data);
    fs.mkdirSync(path.join(wt.path, 'dep'));
    fs.writeFileSync(
      path.join(wt.path, 'dep', 'package.json'),
      JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(wt.path, 'dep', 'index.js'), "module.exports = 'dep ok';");
    fs.writeFileSync(
      path.join(wt.path, 'package.json'),
      JSON.stringify({
        scripts: { test: 'node -e "console.log(require(\'dep\'))"' },
        dependencies: { dep: 'file:./dep' },
      }),
    );
    // The operator removed the bound folder's node_modules: the link points at nothing.
    fs.renameSync(path.join(repo, 'node_modules'), path.join(dir, 'nm-aside'));
    try {
      const ran = await repoRun(
        { path: wt.path, scripts: ['test'], timeoutSec: 120, goalWorktree: true },
        'test',
      );
      expect(ran.isError).toBe(false);
      expect(ran.text).toContain('dep ok');
      expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(false);
    } finally {
      fs.renameSync(path.join(dir, 'nm-aside'), path.join(repo, 'node_modules'));
    }
  }, 120_000);

  it('installs a goal of its own when it changes the dependencies of a linked node_modules', async () => {
    const wt = await ensureWorktree(repo, 'magpipe/new-dep', data);
    expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
    fs.mkdirSync(path.join(wt.path, 'dep'));
    fs.writeFileSync(
      path.join(wt.path, 'dep', 'package.json'),
      JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(wt.path, 'dep', 'index.js'), "module.exports = 'dep ok';");
    fs.writeFileSync(
      path.join(wt.path, 'package.json'),
      JSON.stringify({
        scripts: { test: 'node -e "console.log(require(\'dep\'))"' },
        dependencies: { dep: 'file:./dep' },
      }),
    );
    const ran = await repoRun(
      { path: wt.path, scripts: ['test'], timeoutSec: 120, goalWorktree: true },
      'test',
    );
    expect(ran.isError).toBe(false);
    expect(ran.text).toContain('dep ok');
    expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(false);
    // The bound folder's own node_modules is untouched.
    expect(fs.existsSync(path.join(repo, 'node_modules', 'left-pad'))).toBe(true);
  }, 120_000);

  it('runs the project’s git hooks with the operator’s settings, not Magpipe’s (D55)', async () => {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    const seen = path.join(dir, 'hook-env');
    fs.writeFileSync(
      hook,
      `#!/bin/sh\necho "\${NODE_ENV:-no NODE_ENV} \${MAGPIPE_SECRET:-no secret}" > "${seen}"\n`,
      { mode: 0o755 },
    );
    const env = process.env as Record<string, string | undefined>;
    const before = env.MAGPIPE_SECRET;
    env.MAGPIPE_SECRET = 'shh';
    try {
      await ensureWorktree(repo, 'magpipe/hooked', data);
      expect(fs.readFileSync(seen, 'utf8').trim()).toBe('no NODE_ENV no secret');
    } finally {
      fs.rmSync(hook, { force: true });
      if (before === undefined) delete env.MAGPIPE_SECRET;
      else env.MAGPIPE_SECRET = before;
    }
  });

  it('installs over a linked node_modules missing a package, only in a goal’s worktree (D55)', async () => {
    const wt = await ensureWorktree(repo, 'magpipe/incomplete', data);
    expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
    fs.mkdirSync(path.join(wt.path, 'dep'));
    fs.writeFileSync(
      path.join(wt.path, 'dep', 'package.json'),
      JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(wt.path, 'dep', 'index.js'), "module.exports = 'dep here';");
    const pkg = JSON.stringify({
      scripts: { test: 'node -e "console.log(require(\'dep\'))"' },
      dependencies: { dep: 'file:./dep' },
    });
    fs.writeFileSync(path.join(wt.path, 'package.json'), pkg);
    // The bound folder names the same dependencies, and its node_modules does not hold them.
    fs.writeFileSync(path.join(repo, 'package.json'), pkg);
    try {
      const config = { path: wt.path, scripts: ['test'], timeoutSec: 120 };
      // A worktree the operator made and bound is their own: left as it is.
      const theirs = await repoRun(config, 'test');
      expect(theirs.text).toMatch(/^\$ npm run test/);
      expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
      // A goal's: it gets an install of its own.
      const ran = await repoRun({ ...config, goalWorktree: true }, 'test');
      expect(ran.isError).toBe(false);
      expect(ran.text).toContain('Installed the dependencies');
      expect(ran.text).toContain('dep here');
      expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(repo, 'node_modules', 'dep'))).toBe(false);
    } finally {
      git(repo, 'checkout', '--', 'package.json');
    }
  }, 120_000);

  it('an untracked lockfile gives way to the base’s, and does not keep a worktree from going (D53)', async () => {
    const wt = await ensureWorktree(repo, 'magpipe/lock', data);
    fs.writeFileSync(path.join(wt.path, 'package-lock.json'), '{"mine": true}');
    // The base now tracks a lockfile, as another goal merged it.
    const elsewhere = path.join(dir, 'elsewhere');
    git(elsewhere, 'pull', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(elsewhere, 'package-lock.json'), '{"base": true}');
    git(elsewhere, 'add', 'package-lock.json');
    git(elsewhere, 'commit', '-q', '-m', 'lockfile');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const updated = await updateBranch(wt.path, 'main');
    expect(updated).toMatchObject({ ok: true, changed: true });
    expect(fs.readFileSync(path.join(wt.path, 'package-lock.json'), 'utf8')).toContain('base');
    // Another untracked lockfile and a real node_modules: still removed.
    fs.writeFileSync(path.join(wt.path, 'pnpm-lock.yaml'), 'x');
    fs.rmSync(path.join(wt.path, 'node_modules'), { force: true });
    fs.mkdirSync(path.join(wt.path, 'node_modules', 'pkg'), { recursive: true });
    expect(await removeWorktree(wt.path)).toBe('removed');
  });

  it('refuses a folder that is not a repository', async () => {
    await expect(ensureWorktree(path.join(dir, 'nowhere'), 'magpipe/x', data)).rejects.toThrow();
  });
});
