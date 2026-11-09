/**
 * The per-run workspace for the `workspace-fs` built-in: a folder under the data dir, wiped
 * when the run ends (spec §7.4). `shell.run` is the v1 stub of decision D6 — an allow-list of
 * read-only commands, run without a shell, in that folder, with a short timeout.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../db';
import { splitCommand } from '../mcp';

export const SHELL_ALLOW_LIST = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'echo',
  'pwd',
  'sort',
  'uniq',
  'diff',
  'stat',
] as const;

export const SANDBOX_OUTPUT_CAP = 20_000;

/** Flags that turn a read-only command into a writer or an executor; refused for every command. */
export const DENIED_ARGS = [
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
  '-o',
  '--output',
] as const;

export function sandboxDir(runId: string): string {
  return path.join(dataDir(), 'runs', runId, 'sandbox');
}

export async function ensureSandbox(runId: string): Promise<string> {
  const dir = sandboxDir(runId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function wipeSandbox(runId: string): Promise<void> {
  await fs.rm(path.join(dataDir(), 'runs', runId), { recursive: true, force: true });
}

/** Resolves a model-supplied path inside the sandbox, or throws: `..` and absolute paths stay out. */
export function resolveInside(dir: string, relative: string): string {
  const target = path.resolve(dir, relative);
  const rel = path.relative(dir, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace: ${relative}`);
  }
  return target;
}

export async function fsRead(dir: string, relative: string): Promise<string> {
  const target = resolveInside(dir, relative);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const names = await fs.readdir(target);
    return names.join('\n');
  }
  const text = await fs.readFile(target, 'utf8');
  return text.length > SANDBOX_OUTPUT_CAP
    ? `${text.slice(0, SANDBOX_OUTPUT_CAP)}\n… (truncated)`
    : text;
}

export async function fsWrite(dir: string, relative: string, contents: string): Promise<string> {
  const target = resolveInside(dir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
  return `Wrote ${Buffer.byteLength(contents)} bytes to ${relative}`;
}

/** `ls -la src` → ['ls', '-la', 'src']; quotes are honoured, nothing is interpreted. */
export const splitArgs = splitCommand;

export async function shellRun(
  dir: string,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const [file, ...args] = splitArgs(command);
  if (!file) throw new Error('Empty command');
  if (!(SHELL_ALLOW_LIST as readonly string[]).includes(file)) {
    throw new Error(`"${file}" is not on the sandbox allow-list (${SHELL_ALLOW_LIST.join(', ')})`);
  }
  if (args.some((a) => a.includes('..') || path.isAbsolute(a))) {
    throw new Error('Arguments may only name paths inside the workspace');
  }
  const denied = args.find((a) => (DENIED_ARGS as readonly string[]).includes(a.split('=')[0]!));
  if (denied) throw new Error(`"${denied}" is not allowed in the sandbox: commands here only read`);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: dir,
      shell: false,
      // A bare environment: the sandbox never sees the app's keys.
      env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', NODE_ENV: process.env.NODE_ENV },
      stdio: 'pipe',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on(
      'data',
      (c: Buffer) => (stdout = (stdout + c.toString()).slice(0, SANDBOX_OUTPUT_CAP)),
    );
    child.stderr.on(
      'data',
      (c: Buffer) => (stderr = (stderr + c.toString()).slice(0, SANDBOX_OUTPUT_CAP)),
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 10_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
