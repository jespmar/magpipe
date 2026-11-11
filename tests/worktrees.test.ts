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
import { baseBranch, ensureWorktree, removeWorktree, worktreesRoot } from '@/lib/worktrees';

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

  it('refuses a folder that is not a repository', async () => {
    await expect(ensureWorktree(path.join(dir, 'nowhere'), 'magpipe/x', data)).rejects.toThrow();
  });
});
