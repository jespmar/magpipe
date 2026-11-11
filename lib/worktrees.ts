/**
 * A git worktree per goal (D41): goals build side by side, each in its own checkout of the bound
 * repository on its own branch, under the data folder. This is Magpipe's work, not an agent's:
 * agents still reach the checkout only through the typed operations in `lib/repo.ts` (D27), now
 * pointed at the worktree, and the write lock is keyed by the worktree, so goals in different
 * worktrees never wait on each other (D28).
 *
 * A new worktree has no installed dependencies, so `node_modules` is linked from the bound
 * folder when it has one, and kept out of git by the repository's shared exclude file.
 */
import 'server-only';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './db';
import { inspectRepository } from './repo';

type GitResult = { code: number; out: string };

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}`.trim() });
      },
    );
  });
}

export class WorktreeError extends Error {
  readonly code = 'worktree';
}

/** Where a repository's worktrees live: one folder per repository, named and hashed by its root. */
export function worktreesRoot(repoRoot: string, base = dataDir()): string {
  const name = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return path.join(base, 'worktrees', `${name}-${hash}`);
}

/**
 * The branch new goal branches start from: the remote's default when it names one, else `main`
 * or `master` when they exist, else whatever the bound folder has checked out.
 */
export async function baseBranch(repoRoot: string): Promise<string> {
  const remote = await git(repoRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (remote.code === 0 && remote.out) return remote.out.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (
      (await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0
    ) {
      return name;
    }
  }
  const head = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.code === 0 && head.out) return head.out;
  throw new WorktreeError(`${repoRoot} has no branch to start goals from.`);
}

async function exists(p: string): Promise<boolean> {
  return fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);
}

/** Keeps the linked `node_modules` out of git in every worktree of the repository. */
async function excludeNodeModules(repoRoot: string): Promise<void> {
  const common = await git(repoRoot, ['rev-parse', '--git-common-dir']);
  if (common.code !== 0) return;
  const file = path.join(path.resolve(repoRoot, common.out), 'info', 'exclude');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  if (
    current.split('\n').some((l) => l.trim() === 'node_modules' || l.trim() === '/node_modules')
  ) {
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${current}${current && !current.endsWith('\n') ? '\n' : ''}# Linked into goal worktrees by Magpipe\n/node_modules\n`,
  );
}

export type Worktree = { path: string; branch: string; base: string; created: boolean };

/**
 * The worktree for a goal's branch, made if missing: on the branch when it exists (a rebuild),
 * else on a new branch from the base. `node_modules` is linked from the bound folder.
 */
export async function ensureWorktree(
  repoPath: string,
  branch: string,
  base = dataDir(),
): Promise<Worktree> {
  const found = await inspectRepository(repoPath);
  if (!found.ok) throw new WorktreeError(found.error);
  const root = await fs.realpath(found.root);
  const dir = path.join(worktreesRoot(root, base), branch.replace(/[^A-Za-z0-9._-]/g, '-'));
  const from = await baseBranch(root);
  if (await exists(dir)) {
    const ok = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    if (ok.code === 0) {
      await linkNodeModules(root, dir);
      return { path: dir, branch, base: from, created: false };
    }
    // A folder left behind by a removed worktree: git forgets it, then it is made again.
    await git(root, ['worktree', 'prune']);
    await fs.rm(dir, { recursive: true, force: true });
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const hasBranch =
    (await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  const res = hasBranch
    ? await git(root, ['worktree', 'add', dir, branch])
    : await git(root, ['worktree', 'add', '-b', branch, dir, from]);
  if (res.code !== 0) {
    throw new WorktreeError(`The worktree for ${branch} could not be made: ${res.out}`);
  }
  await linkNodeModules(root, dir);
  return { path: dir, branch, base: from, created: true };
}

async function linkNodeModules(root: string, dir: string): Promise<void> {
  const source = path.join(root, 'node_modules');
  const target = path.join(dir, 'node_modules');
  if (!(await exists(source)) || (await exists(target))) return;
  await excludeNodeModules(root);
  await fs.symlink(source, target, 'dir');
}

/**
 * Removes a goal's worktree once its work is merged or abandoned. A worktree with uncommitted
 * changes is kept, so nothing an agent wrote is lost; the branch itself is never deleted.
 */
export async function removeWorktree(dir: string): Promise<'removed' | 'kept' | 'missing'> {
  if (!(await exists(dir))) return 'missing';
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return 'missing';
  const dirty = await git(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.out) return 'kept';
  // The link is git-excluded, so it does not count as a change; remove it first so git does not
  // follow it.
  await fs.unlink(path.join(dir, 'node_modules')).catch(() => undefined);
  const common = await git(dir, ['rev-parse', '--git-common-dir']);
  const root = path.dirname(path.resolve(dir, common.out));
  const res = await git(root, ['worktree', 'remove', dir]);
  return res.code === 0 ? 'removed' : 'kept';
}

// ─── landing a goal (D42) ──────────────────────────────────────────────────

/** A merge commit needs an identity: the repository's own, else Magpipe's. */
async function identity(dir: string): Promise<string[]> {
  const email = await git(dir, ['config', 'user.email']);
  return email.code === 0 && email.out
    ? []
    : ['-c', 'user.name=Magpipe', '-c', 'user.email=magpipe@localhost'];
}

async function currentBranch(dir: string): Promise<string | null> {
  const head = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return head.code === 0 ? head.out : null;
}

async function hasOrigin(dir: string): Promise<boolean> {
  return (await git(dir, ['remote', 'get-url', 'origin'])).code === 0;
}

/**
 * Pushes a goal's branch to `origin` (D42): Magpipe's own push, with the guards the design set.
 * Only a `magpipe/…` branch, only the one the worktree has checked out, never the base branch,
 * never forced: a push that is not a fast-forward is refused by git and reported.
 */
export async function pushBranch(dir: string, branch: string): Promise<void> {
  if (!/^magpipe\/[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new WorktreeError(`Magpipe pushes only its own magpipe/ branches, not ${branch}.`);
  }
  if ((await currentBranch(dir)) !== branch) {
    throw new WorktreeError(`The worktree is not on ${branch}, so nothing was pushed.`);
  }
  const common = await git(dir, ['rev-parse', '--git-common-dir']);
  const root = path.dirname(path.resolve(dir, common.out));
  if (branch === (await baseBranch(root))) {
    throw new WorktreeError(`${branch} is the default branch; Magpipe never pushes to it.`);
  }
  if (!(await hasOrigin(dir))) throw new WorktreeError('The repository has no origin to push to.');
  const res = await git(dir, ['push', '--set-upstream', 'origin', `${branch}:${branch}`]);
  if (res.code !== 0) throw new WorktreeError(`git push refused ${branch}: ${res.out}`);
}

export type BranchUpdate =
  { ok: true; changed: boolean; base: string } | { ok: false; conflicts: string[]; base: string };

/**
 * Brings a goal's branch up to date with its base before it merges (D42): fetches the base from
 * `origin` and merges it into the branch. A merge, not a rebase, so the push that follows is a
 * fast-forward and nothing is ever forced. A conflict is aborted and the files are named; the
 * branch is left as it was.
 */
export async function updateBranch(dir: string, base: string): Promise<BranchUpdate> {
  const dirty = await git(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.out) {
    throw new WorktreeError('The worktree has uncommitted changes, so the branch was not updated.');
  }
  let ref = base;
  if (await hasOrigin(dir)) {
    const fetched = await git(dir, ['fetch', 'origin', base]);
    if (fetched.code !== 0) throw new WorktreeError(`git fetch failed: ${fetched.out}`);
    ref = `origin/${base}`;
  }
  const before = await git(dir, ['rev-parse', 'HEAD']);
  const merged = await git(dir, [...(await identity(dir)), 'merge', '--no-edit', ref]);
  if (merged.code !== 0) {
    const conflicts = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).out
      .split('\n')
      .filter(Boolean);
    await git(dir, ['merge', '--abort']);
    return { ok: false, conflicts, base };
  }
  const after = await git(dir, ['rev-parse', 'HEAD']);
  return { ok: true, changed: before.out !== after.out, base };
}

/** The `origin` remote's URL of a folder's repository, or null. */
export async function originUrl(dir: string): Promise<string | null> {
  const res = await git(dir, ['remote', 'get-url', 'origin']);
  return res.code === 0 && res.out ? res.out : null;
}
