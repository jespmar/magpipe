/**
 * A bound repository (D27): a folder inside a git work tree that agents reach through nine named
 * operations, never a shell. Paths stay inside the folder, `.git` and env files are refused,
 * `run` takes only a package script the operator allowed, and git never pushes and never commits
 * to the default branch. The engine exposes these as the repository tool's tools
 * (lib/engine/tools.ts); the Tools screen binds a folder by probing it here (lib/tools.ts).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { childEnv } from './mcp';
import type { RepositoryConfig } from './schemas';

/** The operations a repository tool offers, in the order the editor lists them. */
export const REPO_TOOLS = [
  'read',
  'search',
  'write',
  'run',
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'git_commit',
] as const;
export type RepoToolName = (typeof REPO_TOOLS)[number];

export const REPO_OUTPUT_CAP = 20_000;
const READ_CAP = 60_000;
const READ_MAX_BYTES = 2_000_000;
const WRITE_MAX_BYTES = 1_000_000;
const GIT_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 120_000;

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type RepositoryInspection =
  | {
      ok: true;
      /** The folder as configured, resolved. */
      path: string;
      /** The git work tree it belongs to. */
      root: string;
      branch: string | null;
      packageManager: PackageManager;
      /** Script names in the folder's package.json. */
      scripts: string[];
    }
  | { ok: false; error: string };

// ─── processes ─────────────────────────────────────────────────────────────

type ExecResult = { code: number | null; output: string; truncated: boolean; timedOut: boolean };

/**
 * Runs a program without a shell (except for Windows' `.cmd` shims) and keeps the tail of its
 * combined output. On posix it gets its own process group, so a timeout or a cancelled step
 * stops everything it started.
 */
function exec(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelled'));
    const posix = process.platform !== 'win32';
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: posix,
      shell: !posix && /\.cmd$/i.test(file),
      windowsHide: true,
    });
    let output = '';
    let truncated = false;
    let timedOut = false;
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > REPO_OUTPUT_CAP) {
        output = output.slice(-REPO_OUTPUT_CAP);
        truncated = true;
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const stop = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const onAbort = () => stop();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error('Cancelled'));
      resolve({ code, output, truncated, timedOut });
    });
  });
}

let loginPath: Promise<string> | null = null;

/**
 * The login shell's PATH. An app opened from Finder or a launcher has almost none, so `npm`,
 * `pnpm` or the tools a script calls would not be found without it.
 */
function shellPath(): Promise<string> {
  loginPath ??= (async () => {
    const own = process.env.PATH ?? '';
    if (process.platform === 'win32') return own;
    const shell = process.env.SHELL || '/bin/sh';
    try {
      const res = await exec(shell, ['-lc', 'printf %s "$PATH"'], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
      });
      const found = res.code === 0 ? res.output.trim().split('\n').pop()?.trim() : '';
      return [found, own].filter(Boolean).join(path.delimiter);
    } catch {
      return own;
    }
  })();
  return loginPath;
}

/** The environment a repository command sees: the operator's, minus Magpipe's own secrets. */
async function commandEnv(): Promise<NodeJS.ProcessEnv> {
  return {
    ...childEnv(process.env),
    PATH: await shellPath(),
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
  };
}

async function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  try {
    return await exec('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      env: await commandEnv(),
      timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'git was not found on this machine. Install git, then test the repository again.',
      );
    }
    throw err;
  }
}

const gitText = (res: ExecResult) =>
  `${res.truncated ? '… (earlier output cut)\n' : ''}${res.output.trimEnd()}`;

async function gitOrThrow(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const res = await git(cwd, args, { signal });
  if (res.code !== 0) throw new Error(gitText(res) || `git ${args[0]} failed`);
  return res.output.trim();
}

// ─── binding ───────────────────────────────────────────────────────────────

const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;

export function isScriptName(name: string): boolean {
  return SCRIPT_NAME.test(name);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function packageManagerOf(dir: string, root: string): Promise<PackageManager> {
  for (const base of dir === root ? [dir] : [dir, root]) {
    if (await exists(path.join(base, 'pnpm-lock.yaml'))) return 'pnpm';
    if (await exists(path.join(base, 'yarn.lock'))) return 'yarn';
    if ((await exists(path.join(base, 'bun.lockb'))) || (await exists(path.join(base, 'bun.lock'))))
      return 'bun';
    if (await exists(path.join(base, 'package-lock.json'))) return 'npm';
  }
  return 'npm';
}

/** Whether `dir` can be bound: an absolute folder inside a git work tree. Reads its scripts. */
export async function inspectRepository(dir: string): Promise<RepositoryInspection> {
  if (!path.isAbsolute(dir)) return { ok: false, error: 'Give the folder as an absolute path' };
  const resolved = path.resolve(dir);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) return { ok: false, error: `No folder at ${resolved}` };
  if (!stat.isDirectory()) return { ok: false, error: `${resolved} is a file, not a folder` };
  let top: ExecResult;
  try {
    top = await git(resolved, ['rev-parse', '--show-toplevel']);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (top.code !== 0) return { ok: false, error: `${resolved} is not inside a git repository` };
  const root = top.output.trim();
  const head = await git(resolved, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  let scripts: string[] = [];
  const pkg = await fs.readFile(path.join(resolved, 'package.json'), 'utf8').catch(() => null);
  if (pkg !== null) {
    try {
      const parsed = JSON.parse(pkg) as { scripts?: Record<string, unknown> };
      scripts = Object.keys(parsed.scripts ?? {}).filter(isScriptName);
    } catch {
      return { ok: false, error: `${path.join(resolved, 'package.json')} is not valid JSON` };
    }
  }
  return {
    ok: true,
    path: resolved,
    root,
    branch: head.code === 0 ? head.output.trim() : null,
    packageManager: await packageManagerOf(resolved, root),
    scripts,
  };
}

/** The tools a binding offers: `run` only when the operator allowed at least one script. */
export function repoToolNames(config: Pick<RepositoryConfig, 'scripts'>): RepoToolName[] {
  return REPO_TOOLS.filter((name) => name !== 'run' || config.scripts.length > 0);
}

// ─── paths ─────────────────────────────────────────────────────────────────

const ENV_FILE = /^\.env(\..+)?$/;
const ENV_EXAMPLE = /^\.env\.(example|sample|template)$/;

/** A name that holds secrets by convention: `.env`, `.env.local`, not `.env.example`. */
export function isEnvFile(name: string): boolean {
  return ENV_FILE.test(name) && !ENV_EXAMPLE.test(name);
}

/**
 * Resolves a model-supplied path inside the repository folder, or throws. Absolute paths, `..`,
 * symlinks that lead out, anything under `.git` and env files are refused. Writing refuses every
 * `.env*` name, examples included, because commits never stage them.
 */
export async function resolveRepoPath(
  base: string,
  relative: string,
  mode: 'read' | 'write' = 'read',
): Promise<string> {
  const rel = relative.trim() || '.';
  if (path.isAbsolute(rel)) throw new Error(`Give a path relative to the repository: ${relative}`);
  const target = path.resolve(base, rel);
  const inside = path.relative(base, target);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`Path leaves the repository: ${relative}`);
  }
  const parts = inside.split(path.sep).filter(Boolean);
  if (parts.includes('.git')) throw new Error('The .git folder is off limits');
  const envLike = mode === 'write' ? (p: string) => ENV_FILE.test(p) : isEnvFile;
  if (parts.some(envLike)) throw new Error(`Env files are off limits: ${relative}`);
  // Follow symlinks as far as the path exists, and check that the real place is still inside.
  const realBase = await fs.realpath(base);
  let probe = target;
  while (!(await exists(probe)) && probe !== base) probe = path.dirname(probe);
  const real = await fs.realpath(probe);
  const realInside = path.relative(realBase, real);
  if (
    realInside === '..' ||
    realInside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realInside)
  ) {
    throw new Error(`Path leads out of the repository: ${relative}`);
  }
  return target;
}

// ─── operations ────────────────────────────────────────────────────────────

/**
 * What an operation did to the work tree, for the step's record (D29). Paths are relative to the
 * repository folder; the engine adds the tool's name and makes them relative to the work tree.
 */
export type RepoWork =
  | { kind: 'file'; path: string; change: 'created' | 'updated' }
  | { kind: 'branch'; name: string; created: boolean }
  | { kind: 'commit'; branch: string; sha: string; message: string }
  | { kind: 'check'; script: string; exit: number | null; seconds: number; timedOut: boolean };

export type RepoOutcome = { text: string; isError?: boolean; work?: RepoWork };

/** `read`: a text file with line numbers, or a folder's entries. */
export async function repoRead(
  base: string,
  relative: string,
  opts: { startLine?: number; maxLines?: number } = {},
): Promise<RepoOutcome> {
  const target = await resolveRepoPath(base, relative);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return { text: `Nothing at ${relative}`, isError: true };
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const names = entries
      .filter((e) => e.name !== '.git')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    const shown = names.slice(0, 500);
    return {
      text:
        shown.join('\n') +
          (names.length > shown.length ? `\n… and ${names.length - shown.length} more` : '') ||
        '(empty folder)',
    };
  }
  if (stat.size > READ_MAX_BYTES) {
    return { text: `${relative} is ${stat.size} bytes, too large to read`, isError: true };
  }
  const buf = await fs.readFile(target);
  if (buf.subarray(0, 8000).includes(0))
    return { text: `${relative} is a binary file (${stat.size} bytes)` };
  const lines = buf.toString('utf8').split('\n');
  const start = Math.max(1, Math.floor(opts.startLine ?? 1));
  const count = Math.min(Math.max(1, Math.floor(opts.maxLines ?? 400)), 2000);
  const slice = lines.slice(start - 1, start - 1 + count);
  const width = String(start + slice.length - 1).length;
  let text = slice.map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join('\n');
  if (text.length > READ_CAP)
    text = `${text.slice(0, READ_CAP)}\n… (cut at ${READ_CAP} characters)`;
  const end = start + slice.length - 1;
  const note =
    start > 1 || end < lines.length ? `\n(lines ${start}–${end} of ${lines.length})` : '';
  return { text: text + note };
}

/** `search`: lines containing the text, in tracked and new files, env files left out. */
export async function repoSearch(
  base: string,
  query: string,
  relative = '.',
  signal?: AbortSignal,
): Promise<RepoOutcome> {
  if (!query) return { text: 'Give the text to search for', isError: true };
  const target = await resolveRepoPath(base, relative);
  const scope = path.relative(base, target) || '.';
  const res = await git(
    base,
    [
      'grep',
      '-n',
      '-I',
      '--untracked',
      '--no-color',
      '-F',
      '-e',
      query,
      '--',
      scope,
      ':(exclude,glob)**/.env',
      ':(exclude,glob)**/.env.*',
    ],
    { signal },
  );
  if (res.code === 1) return { text: `No matches for "${query}"` };
  if (res.code !== 0) return { text: gitText(res) || 'Search failed', isError: true };
  const lines = res.output.trimEnd().split('\n');
  const shown = lines.slice(0, 200);
  return {
    text:
      shown.join('\n') +
      (lines.length > shown.length ? `\n… and ${lines.length - shown.length} more matches` : ''),
  };
}

/** `write`: creates or replaces a text file. */
export async function repoWrite(
  base: string,
  relative: string,
  contents: string,
): Promise<RepoOutcome> {
  const target = await resolveRepoPath(base, relative, 'write');
  const size = Buffer.byteLength(contents);
  if (size > WRITE_MAX_BYTES)
    return { text: `${size} bytes is more than one write may hold`, isError: true };
  const existed = await exists(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
  return {
    text: `${existed ? 'Updated' : 'Created'} ${relative} (${size} bytes)`,
    work: {
      kind: 'file',
      path: path.relative(base, target).split(path.sep).join('/'),
      change: existed ? 'updated' : 'created',
    },
  };
}

/** `run`: one of the package scripts the operator allowed, with the folder as working directory. */
export async function repoRun(
  config: RepositoryConfig,
  script: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RepoOutcome> {
  if (!config.scripts.includes(script)) {
    return {
      text: `"${script}" is not a script this repository allows. Allowed: ${config.scripts.join(', ') || 'none'}.`,
      isError: true,
    };
  }
  const pm = await packageManagerOf(config.path, config.path);
  const file = process.platform === 'win32' ? `${pm}.cmd` : pm;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? config.timeoutSec * 1000;
  let res: ExecResult;
  try {
    res = await exec(file, ['run', script], {
      cwd: config.path,
      env: await commandEnv(),
      timeoutMs,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { text: `${pm} was not found on this machine`, isError: true };
    }
    throw err;
  }
  const elapsed = (Date.now() - started) / 1000;
  const seconds = elapsed.toFixed(1);
  const head = `$ ${pm} run ${script}`;
  const body = `${res.truncated ? '… (earlier output cut)\n' : ''}${res.output.trimEnd()}`;
  const work: RepoWork = {
    kind: 'check',
    script,
    exit: res.timedOut ? null : res.code,
    seconds: Math.round(elapsed * 10) / 10,
    timedOut: res.timedOut,
  };
  if (res.timedOut) {
    return {
      text: `${head}\n${body}\nStopped after ${Math.round(timeoutMs / 1000)} s without finishing.`,
      isError: true,
      work,
    };
  }
  return {
    text: `${head}\n${body}\nexit ${res.code ?? '?'} · ${seconds} s`,
    isError: res.code !== 0,
    work,
  };
}

export async function gitStatus(base: string, signal?: AbortSignal): Promise<RepoOutcome> {
  return { text: (await gitOrThrow(base, ['status', '--short', '--branch'], signal)) || 'Clean' };
}

const REF = /^[A-Za-z0-9_][\w./~^@{}-]{0,199}$/;

/** `git_diff`: the branch against a base (`main...HEAD`), or uncommitted work against HEAD. */
export async function gitDiff(
  base: string,
  against?: string,
  signal?: AbortSignal,
): Promise<RepoOutcome> {
  if (against !== undefined && against !== '' && !REF.test(against)) {
    return { text: `Not a branch or commit: ${against}`, isError: true };
  }
  const range = against ? [`${against}...HEAD`] : ['HEAD'];
  const stat = await gitOrThrow(base, ['diff', '--stat', ...range, '--', '.'], signal);
  const diff = await git(base, ['diff', ...range, '--', '.'], { signal });
  if (diff.code !== 0) return { text: gitText(diff) || 'git diff failed', isError: true };
  let text = diff.output.trimEnd();
  if (text.length > 2 * REPO_OUTPUT_CAP) {
    text = `${text.slice(0, 2 * REPO_OUTPUT_CAP)}\n… (diff cut; read the files for the rest)`;
  }
  const untracked = against
    ? ''
    : await gitOrThrow(base, ['ls-files', '--others', '--exclude-standard', '--', '.'], signal);
  const parts = [
    stat || 'No changes',
    text,
    untracked ? `New files not yet added:\n${untracked}` : '',
  ].filter(Boolean);
  return { text: parts.join('\n\n') };
}

/** `git_log`: recent commits, or the commits since a base. */
export async function gitLog(
  base: string,
  opts: { since?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<RepoOutcome> {
  if (opts.since && !REF.test(opts.since))
    return { text: `Not a branch or commit: ${opts.since}`, isError: true };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20)), 100);
  const args = ['log', '--oneline', '--no-decorate', `-n${limit}`];
  if (opts.since) args.push(`${opts.since}..HEAD`);
  return { text: (await gitOrThrow(base, [...args, '--'], signal)) || 'No commits' };
}

/** Branches an agent may never commit to: the remote's default, plus main and master. */
async function protectedBranches(base: string, signal?: AbortSignal): Promise<Set<string>> {
  const out = new Set(['main', 'master']);
  const origin = await git(
    base,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { signal },
  );
  if (origin.code === 0) out.add(origin.output.trim().replace(/^origin\//, ''));
  return out;
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** `git_branch`: switch to a branch, or create it from where HEAD is. Refuses over uncommitted work. */
export async function gitBranch(
  base: string,
  name: string,
  create: boolean,
  signal?: AbortSignal,
): Promise<RepoOutcome> {
  if (!BRANCH.test(name) || name.includes('..') || name.endsWith('.lock') || name.endsWith('/')) {
    return { text: `Not a usable branch name: ${name}`, isError: true };
  }
  const current = await git(base, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal });
  if (current.code === 0 && current.output.trim() === name) return { text: `Already on ${name}` };
  // Untracked files survive a switch (git refuses if one would be overwritten); edits to tracked
  // files would ride along to the other branch, so those stop it.
  const dirty = await gitOrThrow(base, ['status', '--porcelain', '--untracked-files=no'], signal);
  if (dirty) {
    return {
      text: 'The working tree has uncommitted changes, so the branch stays as it is. Commit them first (or ask the operator).',
      isError: true,
    };
  }
  const res = await git(base, create ? ['switch', '-c', name] : ['switch', name], { signal });
  if (res.code !== 0) return { text: gitText(res) || 'git switch failed', isError: true };
  return {
    text: create ? `Created and switched to ${name}` : `Switched to ${name}`,
    work: { kind: 'branch', name, created: create },
  };
}

/**
 * `git_commit`: commits exactly the files named, new, changed or deleted, on the current branch.
 * Naming them keeps the operator's own untracked or staged work out of an agent's commit; each
 * path passes the same rules as `write`, so `.git` and env files can never be committed.
 */
export async function gitCommit(
  base: string,
  message: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<RepoOutcome> {
  const text = message.trim();
  if (!text) return { text: 'Give a commit message', isError: true };
  if (text.length > 2000)
    return { text: 'Keep the commit message under 2000 characters', isError: true };
  if (paths.length === 0) return { text: 'Name the files to commit', isError: true };
  if (paths.length > 200) return { text: 'Commit at most 200 files at a time', isError: true };
  const rel: string[] = [];
  for (const p of paths)
    rel.push(path.relative(base, await resolveRepoPath(base, p, 'write')) || '.');
  if (rel.includes('.')) return { text: 'Name files, not the whole folder', isError: true };
  const head = await git(base, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal });
  if (head.code !== 0) return { text: 'HEAD is detached; switch to a branch first', isError: true };
  const branch = head.output.trim();
  if ((await protectedBranches(base, signal)).has(branch)) {
    return {
      text: `${branch} is the default branch, and agents never commit to it. Create a branch with git_branch first.`,
      isError: true,
    };
  }
  const add = await git(base, ['add', '-A', '--', ...rel], { signal });
  if (add.code !== 0) return { text: gitText(add) || 'git add failed', isError: true };
  const staged = await git(base, ['diff', '--cached', '--quiet', '--', ...rel], { signal });
  if (staged.code === 0) return { text: 'Nothing to commit in those files' };
  // `--only` commits these paths alone, whatever else the operator had staged.
  const res = await git(base, ['commit', '-m', text, '--only', '--', ...rel], {
    signal,
    timeoutMs: COMMIT_TIMEOUT_MS,
  });
  if (res.code !== 0) return { text: gitText(res) || 'git commit failed', isError: true };
  const [sha = '', subject = ''] = (
    await gitOrThrow(base, ['log', '-1', '--format=%h%x09%s', '--no-decorate'], signal)
  ).split('\t');
  return {
    text: `Committed on ${branch}: ${sha} ${subject}`,
    work: { kind: 'commit', branch, sha, message: subject },
  };
}
