/**
 * The GitHub CLI's own sign-in (D47): when the operator chooses it, Magpipe asks `gh` for a
 * token each time it needs one (`gh auth token`), and stores nothing. Signing out of `gh` signs
 * Magpipe out too. An app started from the Dock or a launcher has no shell PATH, so `gh` is
 * looked for in a login shell and where its installers put it.
 */
import 'server-only';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../env';

const execFileAsync = promisify(execFile);

/** Why the GitHub CLI could not give a token, in the operator's words. */
export class GhCliError extends Error {
  constructor(
    message: string,
    readonly code: 'missing' | 'signed_out' | 'failed',
  ) {
    super(message);
  }
}

const MISSING =
  'The GitHub CLI was not found on this computer. Install it from cli.github.com and run gh auth login, or set MAGPIPE_GH_PATH in magpipe.env to the gh command.';
const SIGNED_OUT =
  'The GitHub CLI is not signed in to github.com. Run gh auth login in a terminal, then try again.';

async function executable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `command -v gh` in a login shell, or `where gh` on Windows. */
async function fromLoginShell(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('where', ['gh'], { timeout: 5000 });
      return (
        stdout
          .split(/\r?\n/)
          .find((l) => l.trim())
          ?.trim() ?? null
      );
    }
    const shell =
      process.env.SHELL && (await executable(process.env.SHELL)) ? process.env.SHELL : '/bin/sh';
    const { stdout } = await execFileAsync(shell, ['-lc', 'command -v gh'], { timeout: 5000 });
    const found = stdout.trim().split('\n').pop()?.trim();
    return found && (await executable(found)) ? found : null;
  } catch {
    return null;
  }
}

/** MAGPIPE_GH_PATH, read when used, so a changed magpipe.env (or a test) counts at once. */
function ghPathSetting(): string | undefined {
  return process.env.MAGPIPE_GH_PATH || env.MAGPIPE_GH_PATH;
}

/** Where the GitHub CLI's installers put it. */
function usualPlaces(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(programFiles, 'GitHub CLI', 'gh.exe'),
      path.join(local, 'Programs', 'GitHub CLI', 'gh.exe'),
    ];
  }
  return [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    '/home/linuxbrew/.linuxbrew/bin/gh',
    path.join(home, '.local', 'bin', 'gh'),
  ];
}

type Found = { path: string | null; at: number };
type Token = { token: string; at: number };
const g = globalThis as unknown as { __magpipeGhPath?: Found; __magpipeGhToken?: Token };

/** Where `gh` is found again after this long, so installing it later needs no restart. */
const LOOKUP_MS = 60_000;
/** A token from `gh` is used for this long before `gh` is asked again. */
const TOKEN_MS = 5 * 60_000;

/** The `gh` command on this computer, or null. */
export async function findGh(fresh = false): Promise<string | null> {
  const cached = g.__magpipeGhPath;
  if (!fresh && cached && Date.now() - cached.at < LOOKUP_MS) return cached.path;
  let found: string | null = null;
  for (const file of [
    ...(ghPathSetting() ? [ghPathSetting()!] : []),
    ...[await fromLoginShell()].filter((x): x is string => Boolean(x)),
    ...usualPlaces(),
  ]) {
    if (await executable(file)) {
      found = file;
      break;
    }
  }
  g.__magpipeGhPath = { path: found, at: Date.now() };
  return found;
}

/**
 * A token from the GitHub CLI's sign-in for github.com. `fresh` asks `gh` again rather than use
 * the last one, as when the operator first chooses it or a token was refused.
 */
export async function ghToken(fresh = false): Promise<string> {
  const cached = g.__magpipeGhToken;
  if (!fresh && cached && Date.now() - cached.at < TOKEN_MS) return cached.token;
  const gh = await findGh(fresh);
  if (!gh) throw new GhCliError(MISSING, 'missing');
  try {
    const { stdout } = await execFileAsync(gh, ['auth', 'token', '--hostname', 'github.com'], {
      timeout: 10_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    const token = stdout.trim();
    if (!token) throw new GhCliError(SIGNED_OUT, 'signed_out');
    g.__magpipeGhToken = { token, at: Date.now() };
    return token;
  } catch (err) {
    if (err instanceof GhCliError) throw err;
    const text = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? '');
    if (/not logged|no oauth token|gh auth login/i.test(text)) {
      throw new GhCliError(SIGNED_OUT, 'signed_out');
    }
    throw new GhCliError(
      `The GitHub CLI could not give a token: ${text.trim() || 'it exited with an error'}.`,
      'failed',
    );
  }
}

/** Forgets the cached token and path (signing out, or tests). */
export function forgetGh(): void {
  g.__magpipeGhToken = undefined;
  g.__magpipeGhPath = undefined;
}
