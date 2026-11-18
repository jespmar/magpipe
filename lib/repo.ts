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
import { envVar, homeDir, runtimePath } from './runtime-path';
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
 * combined output, or its head (`keep: 'head'`, a diff read from the top). On posix it gets its
 * own process group, so a timeout or a cancelled step stops everything it started.
 */
function exec(
  file: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    keep?: 'head' | 'tail';
    cap?: number;
  },
): Promise<ExecResult> {
  const cap = opts.cap ?? REPO_OUTPUT_CAP;
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
      if (opts.keep === 'head' && truncated) return;
      output += chunk.toString();
      if (output.length > cap) {
        output = opts.keep === 'head' ? output.slice(0, cap) : output.slice(-cap);
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
      // A process that left the group (a daemon from a shell's startup files) may still hold the
      // pipes: they are closed from this end, so the wait ends at the timeout all the same.
      child.stdout.destroy();
      child.stderr.destroy();
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

/** A PATH tests pin for repository commands; `undefined` lets Magpipe work it out again. */
let pinnedPath: string | null = null;

export function pinCommandPath(value: string | undefined): void {
  pinnedPath = value ?? null;
  loginPath = null;
}

/** Works the PATH out again on the next command: a tool may have been installed since (D53). */
function forgetCommandPath(): void {
  loginPath = null;
}

/** Folders of Node version managers, which name the operator's chosen Node (D53). */
const VERSION_MANAGER = /[/\\](\.nvm|\.volta|\.asdf|fnm|mise)[/\\]/;

/**
 * The PATH from what the shell said, the app's own and the known Node folders (D53). A version
 * manager the shell did not put on its PATH (one loaded lazily, say) goes ahead of Homebrew's and
 * the system's node, which would otherwise be found first.
 */
export function composePath(found: string | null, own: string, known: string[]): string {
  const split = (p: string | null) => (p ?? '').split(path.delimiter).filter(Boolean);
  const managers = known.filter((d) => VERSION_MANAGER.test(d));
  const shellHas = split(found).some((d) => VERSION_MANAGER.test(d));
  const dirs = [...(found && !shellHas ? managers : []), ...split(found), ...split(own), ...known];
  return [...new Set(dirs)].join(path.delimiter);
}

/** Marks where the PATH starts in a shell's output, past anything its startup files print. */
const PATH_MARK = '__MAGPIPE_PATH__';

/** The PATH a shell printed after the mark, or null when it printed none. */
export function pathFromShellOutput(output: string): string | null {
  const at = output.lastIndexOf(PATH_MARK);
  if (at < 0) return null;
  const found = output
    .slice(at + PATH_MARK.length)
    .split('\n')[0]!
    .trim();
  return found || null;
}

/** Version folders newest first: v22.1.0 before v20.11.1 before v9.0.0. */
function newestFirst(names: string[]): string[] {
  const parts = (n: string) =>
    n
      .replace(/^v/, '')
      .split('.')
      .map((p) => Number.parseInt(p, 10) || 0);
  return [...names].sort((a, b) => {
    const x = parts(a);
    const y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    }
    return 0;
  });
}

/**
 * Where Node version managers and package managers put `node` and `npm` (D53), for an app whose
 * shells do not say: nvm's default (or newest) version, fnm's and Volta's, asdf's and mise's
 * shims, Homebrew's and the system's. Only folders that are there are returned.
 */
export async function nodeDirs(home: string, nvmDir?: string): Promise<string[]> {
  const out: string[] = [];
  const add = async (dir: string) => {
    if (
      await fs.stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
      )
    )
      out.push(dir);
  };
  // Built at run time only, out of the build's file tracer's reach (D54).
  const nvm = nvmDir || runtimePath(home, '.nvm');
  const versions = runtimePath(nvm, 'versions', 'node');
  const installed = newestFirst(await fs.readdir(versions).catch(() => [] as string[]));
  // nvm's default alias, followed as nvm does: "20" is the newest 20.x, "lts/iron" and "lts/*"
  // name another alias, "node" and "stable" the newest of all.
  let alias = 'default';
  for (let hops = 0; hops < 4; hops++) {
    const next = (
      await fs.readFile(runtimePath(nvm, 'alias', alias), 'utf8').catch(() => '')
    ).trim();
    if (!next) break;
    alias = next;
  }
  const chosen =
    alias === 'default'
      ? undefined
      : alias === 'node' || alias === 'stable'
        ? installed[0]
        : installed.find(
            (v) => v === alias || v === `v${alias}` || v.startsWith(`v${alias.replace(/^v/, '')}.`),
          );
  for (const v of [chosen, ...installed].filter((v): v is string => Boolean(v))) {
    await add(runtimePath(versions, v, 'bin'));
  }
  for (const dir of [
    runtimePath(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    runtimePath(home, '.fnm', 'aliases', 'default', 'bin'),
    runtimePath(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    runtimePath(home, '.volta', 'bin'),
    runtimePath(home, '.asdf', 'shims'),
    runtimePath(home, '.local', 'share', 'mise', 'shims'),
    runtimePath(home, '.bun', 'bin'),
    runtimePath(home, '.local', 'bin'),
    runtimePath('/opt/homebrew/bin'),
    runtimePath('/usr/local/bin'),
  ]) {
    await add(dir);
  }
  return [...new Set(out)];
}

/**
 * The PATH repository commands run with (D53). An app opened from Finder or a launcher has
 * almost none, so it is asked of the operator's shell: an interactive login shell first, which
 * reads the files Node version managers set up in (`~/.zshrc`, `~/.bashrc`), then a login shell.
 * The folders where Node and package managers are usually installed are added after, so `npm`
 * is found even when no shell says where it is.
 */
function shellPath(): Promise<string> {
  if (pinnedPath !== null) return Promise.resolve(pinnedPath);
  loginPath ??= (async () => {
    const own = process.env.PATH ?? '';
    if (process.platform === 'win32') return own;
    const shell = process.env.SHELL || '/bin/sh';
    let found: string | null = null;
    for (const flags of ['-ilc', '-lc']) {
      try {
        // The operator's own startup files run here: without Magpipe's secrets, as every
        // repository command does (repositoryEnv).
        const res = await exec(shell, [flags, `printf '\\n${PATH_MARK}%s\\n' "$PATH"`], {
          cwd: homeDir(),
          env: repositoryEnv(process.env),
          timeoutMs: 10_000,
        });
        // Read whatever the shell printed: some exit non-zero after a startup file complains.
        found = pathFromShellOutput(res.output);
      } catch {
        found = null;
      }
      if (found) break;
    }
    return composePath(found, own, await nodeDirs(homeDir(), envVar('NVM_DIR')));
  })();
  return loginPath;
}

/**
 * What Magpipe's own process carries that is not the operator's (D55): the desktop server runs with
 * NODE_ENV=production and its port and host (electron/server.ts), and Next, Turbopack and Electron
 * add their own switches. Passed on, an install leaves out devDependencies and a project's tests
 * run as a production build. The operator's own NPM_TOKEN, NPM_CONFIG_*, ELECTRON_MIRROR or
 * NEXT_TELEMETRY_DISABLED are theirs, and stay.
 */
const OWN_ENV = /^(NODE_ENV|PORT|HOSTNAME)$/i;
const OWN_SWITCHES =
  /^(NEXT_RUNTIME|__NEXT_.*|TURBOPACK|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE)$/;

/**
 * The environment of a repository command: the operator's, without Magpipe's own settings. A
 * Magpipe started by an npm script (in development) carries npm's lower-case npm_* for that
 * script, which are left out too; otherwise an npm_config_* there is the operator's.
 */
export function repositoryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const fromNpm = Boolean(env.npm_lifecycle_event);
  return Object.fromEntries(
    Object.entries(childEnv(env)).filter(
      ([k]) => !OWN_ENV.test(k) && !OWN_SWITCHES.test(k) && !(fromNpm && k.startsWith('npm_')),
    ),
  ) as NodeJS.ProcessEnv;
}

/** The environment a repository command sees: the operator's, minus Magpipe's own secrets. */
async function commandEnv(): Promise<NodeJS.ProcessEnv> {
  return {
    ...repositoryEnv(process.env),
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
  opts: { timeoutMs?: number; signal?: AbortSignal; keep?: 'head' | 'tail'; cap?: number } = {},
): Promise<ExecResult> {
  try {
    return await exec('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      env: await commandEnv(),
      timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      signal: opts.signal,
      keep: opts.keep,
      cap: opts.cap,
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

// ─── conventions ───────────────────────────────────────────────────────────

/** The files a repository keeps for agents that work in it, in the order they are looked for. */
export const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
/** How much of one conventions file reaches a step's prompt, in characters. */
export const CONVENTIONS_CAP = 8_000;

export type RepoConventions = {
  /** The file's real path, so two bindings of one work tree find the same file. */
  file: string;
  name: (typeof CONVENTION_FILES)[number];
  /** At most `CONVENTIONS_CAP` characters, cut at a line end where one is near. */
  text: string;
  /** Whether the file goes on past `text`. */
  cut: boolean;
};

/** The first bytes of a file: enough for `CONVENTIONS_CAP` characters in any encoding of UTF-8. */
async function readHead(file: string): Promise<{ buf: Buffer; size: number } | null> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const want = Math.min(stat.size, CONVENTIONS_CAP * 4);
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(want), 0, want, 0);
    return { buf: buffer.subarray(0, bytesRead), size: stat.size };
  } finally {
    await handle.close();
  }
}

/**
 * The repository's own instructions for agents (D34): CLAUDE.md in the folder, then at the work
 * tree's root, then AGENTS.md the same way. The same path rules as `read` apply, so a symlink
 * that leads out of the folder is not followed. A missing, empty, binary or unreadable file is
 * skipped; null when there is none.
 */
export async function readConventions(dir: string, root: string): Promise<RepoConventions | null> {
  const bases = path.resolve(dir) === path.resolve(root) ? [dir] : [dir, root];
  for (const name of CONVENTION_FILES) {
    for (const base of bases) {
      try {
        const file = await fs.realpath(await resolveRepoPath(base, name));
        const head = await readHead(file);
        if (!head || head.buf.includes(0)) continue;
        let text = head.buf.toString('utf8').replace(/^﻿/, '');
        let cut = head.size > head.buf.length;
        if (text.length > CONVENTIONS_CAP) {
          cut = true;
          const lineEnd = text.lastIndexOf('\n', CONVENTIONS_CAP);
          let end = lineEnd > CONVENTIONS_CAP / 2 ? lineEnd : CONVENTIONS_CAP;
          // Never leave half of a surrogate pair at the end.
          if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1;
          text = text.slice(0, end);
        }
        text = text.trimEnd();
        if (text.trim()) return { file, name, text, cut };
      } catch {
        // Not there or not readable: look in the next place.
      }
    }
  }
  return null;
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
  | {
      kind: 'check';
      script: string;
      exit: number | null;
      seconds: number;
      timedOut: boolean;
      /**
       * Why it did not run: not in package.json, its dependencies did not install (D51), or the
       * package manager could not be found (D53).
       */
      skipped?: 'missing' | 'install' | 'tool';
    };

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

type PackageJson = {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

/** A folder's package.json: there and parsed, not there, or there and not JSON. */
async function readPackageJson(
  dir: string,
): Promise<
  { state: 'ok'; pkg: PackageJson } | { state: 'missing' } | { state: 'invalid'; error: string }
> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    throw err;
  }
  try {
    const pkg = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      return { state: 'invalid', error: 'not an object' };
    }
    return { state: 'ok', pkg: pkg as PackageJson };
  } catch (err) {
    return { state: 'invalid', error: (err as Error).message };
  }
}

/** The install each package manager does from package.json, the packages' own scripts not run. */
function installArgs(pm: PackageManager): string[] {
  // The checks need devDependencies, whatever NODE_ENV or the npm config says (D55).
  if (pm === 'npm') {
    return ['install', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'];
  }
  // CI=1 (commandEnv) would freeze pnpm's lockfile; the lockfile is put back after anyway.
  if (pm === 'pnpm') {
    return ['install', '--ignore-scripts', '--no-frozen-lockfile', '--production=false'];
  }
  if (pm === 'yarn') {
    // --check-files: yarn classic otherwise trusts its integrity file, and a package removed
    // from node_modules since is not put back (D55).
    return [
      'install',
      '--ignore-scripts',
      '--non-interactive',
      '--production=false',
      '--check-files',
    ];
  }
  return ['install', '--ignore-scripts'];
}

/** Lockfiles an install may write: each is put back as it was, so the work tree stays as it was. */
export const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
];

/** Long enough for a cold first install; its own budget, apart from the script's. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** What `installDependencies` did: nothing, or an install that finished or did not. */
type Install =
  | { ran: false }
  | {
      ran: true;
      ok: boolean;
      /** The package manager itself could not be found: a person's to fix (D53). */
      noTool: boolean;
      /** Lockfiles the install wrote or changed, kept for the change to commit (D53). */
      lockfiles: string[];
      /** Packages package.json names that a finished install still left out (D55). */
      missing: string[];
      command: string;
      output: string;
      seconds: number;
      timedOut: boolean;
    };

/** The dependencies package.json names, as a stable string to compare installs by. */
function dependencyKey(pkg: PackageJson): string {
  const named = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(named)
      .sort()
      .map((k) => [k, named[k]]),
  );
}

/**
 * Whether every package package.json names has an entry in node_modules (D55): a folder, or a
 * link, even one to a folder without a package.json, as a `file:` or `link:` dependency may be.
 * An install recorded as done can still lack some: one made without devDependencies, or packages
 * removed by hand since. An optional dependency may be left out on this platform, so it is not
 * looked for.
 */
async function modulesMissing(modules: string, pkg: PackageJson): Promise<string[]> {
  const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
    (n) => !optional.has(n),
  );
  const found = await Promise.all(
    names.map((n) =>
      fs.lstat(path.join(modules, n)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return names.filter((_, i) => !found[i]).sort();
}

async function modulesComplete(modules: string, pkg: PackageJson): Promise<boolean> {
  return (await modulesMissing(modules, pkg)).length === 0;
}

async function readJson(file: string): Promise<PackageJson | null> {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, '')) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Installs a package.json's dependencies before a script runs, when Magpipe can tell they are
 * not there (D51): a folder at the top of its work tree with no node_modules (a new repository's
 * first build), one Magpipe installed before whose dependencies have changed since, or a goal's
 * worktree whose linked node_modules (the bound folder's, D41) was installed for other ones. A
 * node_modules the operator installed is used as it is, and so is Yarn's Plug'n'Play. What the
 * install did is kept in the work tree's git folder: an install cut off (a timeout, a cancel, a
 * crash) is undone and done again. Lockfiles are put back as they were, and node_modules is kept
 * out of git, so the work tree is as it was.
 */
async function installDependencies(
  dir: string,
  pkg: PackageJson,
  pm: PackageManager,
  opts: { keepLocks: boolean; goalWorktree: boolean; signal?: AbortSignal },
): Promise<Install> {
  const { keepLocks, signal } = opts;
  const key = dependencyKey(pkg);
  if (key === '[]') return { ran: false };
  // A package inside a workspace is installed from its root, which is the operator's to do.
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  const real = (p: string) => fs.realpath(p).catch(() => path.resolve(p));
  if (top.code !== 0 || (await real(top.output.trim())) !== (await real(dir))) {
    return { ran: false };
  }
  if ((await exists(path.join(dir, '.pnp.cjs'))) || (await exists(path.join(dir, '.yarnrc.yml')))) {
    return { ran: false };
  }
  const gitDirOut = await git(dir, ['rev-parse', '--absolute-git-dir']);
  const commonOut = await git(dir, ['rev-parse', '--git-common-dir']);
  if (gitDirOut.code !== 0 || commonOut.code !== 0) return { ran: false };
  const gitDir = gitDirOut.output.trim();
  // A goal's worktree (D41): the engine says so, and it has a git folder of its own beside the
  // repository's common one. A worktree the operator made and bound is their own checkout.
  const goalWorktree =
    opts.goalWorktree &&
    (await real(gitDir)) !== (await real(path.resolve(dir, commonOut.output.trim())));
  const stateFile = path.join(gitDir, 'magpipe-install.json');
  const saved = path.join(gitDir, 'magpipe-install-locks');
  // `complete` (D55): whether the install left every package package.json names in place.
  const state = (await readJson(stateFile)) as {
    state?: string;
    key?: string;
    complete?: boolean;
  } | null;
  const modules = path.join(dir, 'node_modules');

  // An install cut off before (a crash, a quit): its lockfiles are put back from what was saved
  // before it began, and what it left in node_modules cannot be trusted.
  if (state && state.state !== 'done') {
    await restoreLocks(dir, saved);
    await fs.rm(modules, { recursive: true, force: true });
  }
  const there = await fs.lstat(modules).catch(() => null);
  let created = !there || (state !== null && state.state !== 'done');
  if (there?.isSymbolicLink()) {
    // Only a goal's worktree link to the bound folder's node_modules is Magpipe's to replace; a
    // link the operator made in their own checkout is theirs.
    if (!goalWorktree) return { ran: false };
    const target = path.resolve(dir, await fs.readlink(modules));
    const alive = await fs.stat(target).catch(() => null);
    const linked = alive ? await readJson(path.join(path.dirname(target), 'package.json')) : null;
    if (linked && dependencyKey(linked) === key && (await modulesComplete(modules, pkg))) {
      return { ran: false };
    }
    // Gone, installed for other dependencies, or missing some: this worktree gets its own.
    await fs.unlink(modules);
    created = true;
  } else if (there && !created) {
    if (!state) {
      // The operator's own, unless it is a goal's worktree and missing packages.
      if (!goalWorktree || (await modulesComplete(modules, pkg))) return { ran: false };
    } else if (state.key === key && typeof state.complete === 'boolean') {
      // Installed for these dependencies. One the install itself left incomplete (a bun or
      // workspace config that leaves devDependencies out) is as complete as installing makes it;
      // one missing packages since is installed again.
      if (!state.complete || (await modulesComplete(modules, pkg))) return { ran: false };
    }
    // Otherwise: other dependencies, or installed before D55, possibly without devDependencies.
  }
  await excludeNodeModules(dir);
  await saveLocks(dir, saved);
  await fs.writeFile(stateFile, JSON.stringify({ state: 'installing', key }));
  const settle = async (ok: boolean): Promise<{ wrote: string[]; missing: string[] }> => {
    // A finished install's lockfile is part of the change (D53): kept, and named, so the agent
    // commits it with package.json. One cut off or failed is put back as it was.
    const wrote = ok && keepLocks ? await changedLocks(dir, saved) : [];
    if (ok && keepLocks) await fs.rm(saved, { recursive: true, force: true });
    else await restoreLocks(dir, saved);
    let missing: string[] = [];
    if (ok) {
      // Left incomplete by the package manager's own config, it is not installed again for the
      // same dependencies; the run says what is missing, so it is not taken for an install.
      missing = await modulesMissing(modules, pkg);
      await fs.writeFile(
        stateFile,
        JSON.stringify({ state: 'done', key, complete: missing.length === 0 }),
      );
    } else if (created) {
      // Made by this install: nothing half-made is left for the next run to trust.
      await fs.rm(modules, { recursive: true, force: true });
      await fs.rm(stateFile, { force: true });
    } else {
      // An update over a working node_modules failed: it stays as it was, and so does the record
      // of what it was installed for, so the next run tries the update again.
      await fs.writeFile(
        stateFile,
        JSON.stringify({ state: 'done', key: state?.key ?? '', complete: state?.complete }),
      );
    }
    return { wrote, missing };
  };
  const args = installArgs(pm);
  const file = process.platform === 'win32' ? `${pm}.cmd` : pm;
  const started = Date.now();
  let res: ExecResult;
  let noTool = false;
  try {
    res = await exec(file, args, {
      cwd: dir,
      env: await commandEnv(),
      timeoutMs: INSTALL_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      await settle(false);
      throw err;
    }
    noTool = true;
    res = { code: null, output: notFound(pm), truncated: false, timedOut: false };
  }
  const ok = res.code === 0 && !res.timedOut;
  const { wrote: lockfiles, missing } = await settle(ok);
  return {
    ran: true,
    ok,
    noTool,
    lockfiles,
    missing,
    command: `${pm} ${args.join(' ')}`,
    output: `${res.truncated ? '… (earlier output cut)\n' : ''}${res.output.trimEnd()}`,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    timedOut: res.timedOut,
  };
}

/**
 * The lockfiles as they are before an install, kept in the work tree's git folder so a crash
 * mid-install can still put them back: each file there is a copy, `absent.json` names the ones
 * that were not there.
 */
async function saveLocks(dir: string, saved: string): Promise<void> {
  await fs.rm(saved, { recursive: true, force: true });
  await fs.mkdir(saved, { recursive: true });
  const absent: string[] = [];
  for (const name of LOCKFILES) {
    const bytes = await fs.readFile(path.join(dir, name)).catch(() => null);
    if (bytes === null) absent.push(name);
    else await fs.writeFile(path.join(saved, name), bytes);
  }
  await fs.writeFile(path.join(saved, 'absent.json'), JSON.stringify(absent));
}

/** The lockfiles that differ from what was saved before the install: written or changed by it. */
async function changedLocks(dir: string, saved: string): Promise<string[]> {
  const absent = (await readJson(path.join(saved, 'absent.json'))) as unknown;
  if (!Array.isArray(absent)) return [];
  const out: string[] = [];
  for (const name of LOCKFILES) {
    const now = await fs.readFile(path.join(dir, name)).catch(() => null);
    if (now === null) continue;
    const before = absent.includes(name)
      ? null
      : await fs.readFile(path.join(saved, name)).catch(() => null);
    if (before !== null && before.equals(now)) continue;
    // One the repository ignores is not the change's to commit.
    if ((await git(dir, ['check-ignore', '-q', '--', name])).code === 0) continue;
    out.push(name);
  }
  return out;
}

/** What a missing package manager is answered with (D53): plainly a person's to fix. */
function notFound(pm: PackageManager): string {
  return `Magpipe could not find ${pm} on this computer. Install Node (with ${pm}), or start Magpipe from a terminal so it has your PATH.`;
}

/** Puts the saved lockfiles back, takes away those that were not there, and forgets the copy. */
async function restoreLocks(dir: string, saved: string): Promise<void> {
  const absent = (await readJson(path.join(saved, 'absent.json'))) as unknown;
  if (!Array.isArray(absent)) return;
  for (const name of LOCKFILES) {
    const file = path.join(dir, name);
    if (absent.includes(name)) {
      await fs.rm(file, { force: true });
    } else {
      const bytes = await fs.readFile(path.join(saved, name)).catch(() => null);
      if (bytes !== null) await fs.writeFile(file, bytes);
    }
  }
  await fs.rm(saved, { recursive: true, force: true });
}

/** Keeps node_modules out of git for every worktree of the repository at `dir` (D41, D51). */
export async function excludeNodeModules(dir: string): Promise<void> {
  const common = await git(dir, ['rev-parse', '--git-common-dir']);
  if (common.code !== 0) return;
  const file = path.join(path.resolve(dir, common.output.trim()), 'info', 'exclude');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  if (
    current.split('\n').some((l) => l.trim() === 'node_modules' || l.trim() === '/node_modules')
  ) {
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${current}${current && !current.endsWith('\n') ? '\n' : ''}# Kept out of git by Magpipe\n/node_modules\n`,
  );
}

/** `run`: one of the package scripts the operator allowed, with the folder as working directory. */
export async function repoRun(
  config: RepositoryConfig,
  script: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; lookedAgain?: boolean } = {},
): Promise<RepoOutcome> {
  if (!config.scripts.includes(script)) {
    return {
      text: `"${script}" is not a script this repository allows. Allowed: ${config.scripts.join(', ') || 'none'}.`,
      isError: true,
    };
  }
  // Allowed by name before package.json had it (D51): said plainly rather than left to npm, and
  // kept in the step's record as a check that did not run.
  const read = await readPackageJson(config.path);
  if (read.state === 'invalid') {
    return {
      text: `package.json is not valid JSON (${read.error}), so nothing ran. Fix it, then run the script again.`,
      isError: true,
    };
  }
  if (read.state === 'missing' || typeof read.pkg.scripts?.[script] !== 'string') {
    return {
      text: `"${script}" did not run: ${read.state === 'missing' ? 'there is no package.json' : `package.json has no script named "${script}"`}. The operator allows it; until the change adds it, it has not passed.`,
      isError: true,
      work: { kind: 'check', script, exit: null, seconds: 0, timedOut: false, skipped: 'missing' },
    };
  }
  const pm = await packageManagerOf(config.path, config.path);
  const file = process.platform === 'win32' ? `${pm}.cmd` : pm;
  const timeoutMs = opts.timeoutMs ?? config.timeoutSec * 1000;
  // The dependencies first, when Magpipe can tell they are not there (D51).
  const installed = await installDependencies(config.path, read.pkg, pm, {
    keepLocks: Boolean(config.keepLockfiles),
    goalWorktree: Boolean(config.goalWorktree),
    signal: opts.signal,
  });
  const wrote =
    installed.ran && installed.lockfiles.length
      ? `\nThe install wrote ${installed.lockfiles.join(', ')}: commit ${installed.lockfiles.length === 1 ? 'it' : 'them'} with package.json, so a clean install gets the same versions.`
      : '';
  const left =
    installed.ran && installed.ok && installed.missing.length
      ? `\nnode_modules still lacks ${installed.missing.join(', ')}: the package manager's own config leaves ${installed.missing.length === 1 ? 'it' : 'them'} out, and Magpipe will not install again for the same dependencies.`
      : '';
  const installLine = installed.ran
    ? `$ ${installed.command}\n${installed.output}\n${installed.ok ? `Installed the dependencies in ${installed.seconds.toFixed(1)} s.${left}${wrote}` : installed.timedOut ? `The install stopped after ${Math.round(INSTALL_TIMEOUT_MS / 1000)} s without finishing.` : 'The install failed.'}\n`
    : '';
  // A package manager installed since the PATH was worked out: looked for again, once (D53).
  if (installed.ran && installed.noTool && !opts.lookedAgain) {
    forgetCommandPath();
    return repoRun(config, script, { ...opts, lookedAgain: true });
  }
  if (installed.ran && !installed.ok) {
    return {
      text: installed.noTool
        ? `"${script}" did not run. ${notFound(pm)}`
        : `${installLine}Its dependencies did not install, so "${script}" did not run.`,
      isError: true,
      work: {
        kind: 'check',
        script,
        exit: null,
        seconds: 0,
        timedOut: false,
        skipped: installed.noTool ? 'tool' : 'install',
      },
    };
  }
  const started = Date.now();
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
      if (!opts.lookedAgain) {
        forgetCommandPath();
        return repoRun(config, script, { ...opts, lookedAgain: true });
      }
      return {
        text: `"${script}" did not run. ${notFound(pm)}`,
        isError: true,
        work: { kind: 'check', script, exit: null, seconds: 0, timedOut: false, skipped: 'tool' },
      };
    }
    throw err;
  }
  const elapsed = (Date.now() - started) / 1000;
  const seconds = elapsed.toFixed(1);
  const head = `${installLine}$ ${pm} run ${script}`;
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

/**
 * The base a diff is taken against: a branch named as it is, unless its copy on origin is where
 * HEAD forked from more recently. A goal starts from `origin/<base>` (D51) while the local base
 * is never moved, so "against main" means against what the goal started from, not every goal
 * merged on GitHub since the operator last pulled.
 */
async function nearerBase(dir: string, against: string, signal?: AbortSignal): Promise<string> {
  // Only a plain local branch name: `main~1`, `HEAD`, a sha mean what they say.
  if (!/^[A-Za-z0-9._/-]+$/.test(against) || against.includes('..') || /HEAD$/.test(against)) {
    return against;
  }
  const branch = await git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${against}`], {
    signal,
  });
  if (branch.code !== 0) return against;
  const remote = `origin/${against}`;
  const known = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`], {
    signal,
  });
  if (known.code !== 0) return against;
  const local = await git(dir, ['merge-base', against, 'HEAD'], { signal });
  const fromRemote = await git(dir, ['merge-base', remote, 'HEAD'], { signal });
  if (local.code !== 0) return fromRemote.code === 0 ? remote : against;
  if (fromRemote.code !== 0) return against;
  const a = local.output.trim();
  const b = fromRemote.output.trim();
  if (a === b) return against;
  // The remote's fork point is the later one when the local one is its ancestor.
  const older = await git(dir, ['merge-base', '--is-ancestor', a, b], { signal });
  return older.code === 0 ? remote : against;
}

/** `git_diff`: the branch against a base (`main...HEAD`), or uncommitted work against HEAD. */
export async function gitDiff(
  base: string,
  against?: string,
  signal?: AbortSignal,
): Promise<RepoOutcome> {
  if (against !== undefined && against !== '' && !REF.test(against)) {
    return { text: `Not a branch or commit: ${against}`, isError: true };
  }
  const range = against ? [`${await nearerBase(base, against, signal)}...HEAD`] : ['HEAD'];
  const stat = await gitOrThrow(base, ['diff', '--stat', ...range, '--', '.'], signal);
  // A lockfile's diff is thousands of generated lines (D56): listed in the stat and named, but
  // left out of the diff, so the cap below holds the code.
  const locks = LOCKFILES.map((f) => `:(glob)**/${f}`);
  const diff = await git(
    base,
    ['diff', ...range, '--', '.', ...locks.map((l) => l.replace(':(glob)', ':(exclude,glob)'))],
    // Read from the top, so what is cut is the end, and said (D56).
    { signal, keep: 'head', cap: 2 * REPO_OUTPUT_CAP },
  );
  if (diff.code !== 0) return { text: gitText(diff) || 'git diff failed', isError: true };
  // Named from the bound folder, as the read tool takes them; a removed one is said so.
  const lockNames = await git(
    base,
    ['diff', '--name-status', '--no-renames', '--relative', ...range, '--', ...locks],
    { signal },
  );
  const lockDiffs =
    lockNames.code === 0
      ? lockNames.output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [status, ...name] = line.split('\t');
            return status === 'D' ? `${name.join('\t')} (removed)` : name.join('\t');
          })
      : [];
  let text = diff.output.trimEnd();
  if (diff.truncated) text = `${text}\n… (diff cut; read the files for the rest)`;
  const untracked = against
    ? ''
    : await gitOrThrow(base, ['ls-files', '--others', '--exclude-standard', '--', '.'], signal);
  const parts = [
    stat || 'No changes',
    lockDiffs.length
      ? `Lockfiles changed, contents not shown: ${lockDiffs.join(', ')}. Read one with the read tool if it matters.`
      : '',
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
  // The same base a diff takes (D51), so the commit list and the diff agree.
  if (opts.since) args.push(`${await nearerBase(base, opts.since, signal)}..HEAD`);
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
