/**
 * Cloning a project's repository into a folder the operator picked (D49). The clone goes into a
 * new folder inside the chosen one, never over files that are there; a folder that already holds
 * the same repository is used as it is, so a wizard that stopped half-way can run again. With a
 * GitHub token, git is handed it through its environment for this one command: it is never
 * written into the repository's config or seen on the command line.
 */
import 'server-only';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repoFromRemote } from './forge';
import type { CloneSource } from './forge/types';
import { originUrl } from './worktrees';

export class CloneError extends Error {
  readonly code = 'validation';
}

/** A folder name a clone may take: no separators, nothing hidden, nothing relative. */
const FOLDER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** Long enough for a large repository over a slow line. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

export type CloneTarget = { path: string; state: 'new' | 'empty' | 'same' };

/** Whether a folder holds the repository `repo` (by its origin) or the clone `source` came from. */
async function holds(dir: string, repo: string, source?: CloneSource): Promise<boolean> {
  const origin = await originUrl(dir);
  if (!origin) return false;
  const fromOrigin = repoFromRemote(origin);
  if (fromOrigin) return fromOrigin.toLowerCase() === repo.toLowerCase();
  return source ? path.resolve(origin) === path.resolve(source.url) : false;
}

/**
 * Where a clone of `repo` would go, checked before anything is made: the parent must be an
 * absolute path to a folder, and the new folder must not be there yet, be empty, or already hold
 * this repository.
 */
export async function checkCloneTarget(input: {
  parent: string;
  folder: string;
  repo: string;
  source?: CloneSource;
}): Promise<CloneTarget> {
  const parent = input.parent.trim();
  const folder = input.folder.trim();
  if (!parent) throw new CloneError('Pick the folder to clone into.');
  if (!path.isAbsolute(parent)) throw new CloneError('Give the folder as an absolute path.');
  const stat = await fs.stat(parent).catch(() => null);
  if (!stat) throw new CloneError(`There is no folder at ${path.resolve(parent)}.`);
  if (!stat.isDirectory()) throw new CloneError(`${path.resolve(parent)} is a file, not a folder.`);
  if (!FOLDER.test(folder)) {
    throw new CloneError(
      'Name the new folder with letters, digits, dots, dashes or underscores, not starting with a dot.',
    );
  }
  const target = path.join(path.resolve(parent), folder);
  const there = await fs.lstat(target).catch(() => null);
  if (!there) return { path: target, state: 'new' };
  if (!there.isDirectory()) throw new CloneError(`${target} is already there, and not a folder.`);
  if ((await fs.readdir(target)).length === 0) return { path: target, state: 'empty' };
  if (await holds(target, input.repo, input.source)) return { path: target, state: 'same' };
  throw new CloneError(
    `${target} already has files in it. Pick another folder, or another name for the new one.`,
  );
}

/** The environment git clones with: never asks on a terminal, and carries the token if any. */
function cloneEnv(source: CloneSource, token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (source.auth && token) {
    // Config given through the environment (git 2.31+) applies to this command only.
    const n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = String(n + 1);
    env[`GIT_CONFIG_KEY_${n}`] = 'http.https://github.com/.extraheader';
    env[`GIT_CONFIG_VALUE_${n}`] = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

/** What git said, without anything that looks like the token. */
function scrub(text: string, token: string | null): string {
  let out = text.trim();
  if (token) out = out.split(token).join('…');
  return out.replace(/basic [A-Za-z0-9+/=]{16,}/gi, 'basic …').slice(0, 600);
}

/**
 * Clones `repo` into `parent/folder`, or uses that folder as it is when it already holds the
 * repository. A clone that fails leaves nothing behind it made.
 */
export async function cloneRepository(input: {
  repo: string;
  source: CloneSource;
  token: string | null;
  parent: string;
  folder: string;
}): Promise<{ path: string; reused: boolean }> {
  const target = await checkCloneTarget(input);
  if (target.state === 'same') return { path: target.path, reused: true };
  const result = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      'git',
      ['clone', '--quiet', '--', input.source.url, target.path],
      {
        cwd: path.dirname(target.path),
        env: cloneEnv(input.source, input.token),
        timeout: CLONE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          out: `${stdout}${stderr}`,
        }),
    );
  });
  if (result.code !== 0) {
    // A new folder git made goes again; an empty one the operator made stays, emptied.
    if (target.state === 'new') await fs.rm(target.path, { recursive: true, force: true });
    else await emptyFolder(target.path);
    throw new CloneError(
      `git could not clone ${input.repo}: ${scrub(result.out, input.token) || `exit code ${result.code}`}`,
    );
  }
  return { path: target.path, reused: false };
}

async function emptyFolder(dir: string): Promise<void> {
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
}
